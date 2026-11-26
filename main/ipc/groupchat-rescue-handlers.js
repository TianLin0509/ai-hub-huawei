'use strict';
// 群聊「抢救」动作（2026-11-24）：成员卡死、轮次悬空、某位成员退回宿主壳时，用户不必关群重建。
// 五个动作共用一套前置检查，界面上收在顶栏一个「抢救」下拉里（renderer/groupchat-rescue-ui.js）：
//   groupchat:force-settle        强制结束本轮：先走「停止本轮」同一条中断链路，再无条件把轮次收回待命
//   groupchat:restart-member      重启单个成员：按原会话恢复（复用 restart-session 链路），群与历史都保留
//   groupchat:rollback-last-turn  回退上一轮：只在空闲时可用，撤掉最近一轮，后续上下文不再带它
//   groupchat:skip-stuck          跳过所有还没交的成员：本轮按已交的回答收尾
//   groupchat:export-diagnostics  导出脱敏诊断快照到 <数据目录>/diagnostics/，不含 Key、Cookie 与对话正文

const fs = require('node:fs');
const path = require('node:path');

// 顺序有讲究：先换掉本机用户目录（工号常出现在报错路径里）和其余绝对路径，再抹 JWT、URL 内嵌账号、
//   JSON 里带引号的敏感字段、整段 Cookie 与请求正文，最后才是通用的 key=value。
const SENSITIVE_KEYS = 'api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|x-api-key';
const BODY_KEYS = 'set-cookie|cookie|prompt|messages|body|content|input|request[_ -]?body|payload';
const SCRUB_RULES = [
  [/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>|]+/gi, '<USER_HOME>'],
  [/\/(?:Users|home)\/[^/\s"'<>|]+/g, '<USER_HOME>'],
  // 其余盘符绝对路径（自定义数据盘、项目目录）同样可能带人名或项目名：整段换掉。
  [/(^|[\s"'(=:])[A-Za-z]:[\\/][^\s"'<>|]*/g, '$1<PATH>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[已隐藏]'],
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[已隐藏]@'],
  // Cookie、提示词、请求正文：不论 JSON 带引号还是 k=v 形式，从字段名起到这段文字末尾整段抹掉（后面常跟多段或嵌套内容）。
  [new RegExp(String.raw`["']?\b(?:${BODY_KEYS})\b["']?\s*[:=].*$`, 'gi'), '[已隐藏]'],
  // Bearer 在「Authorization: Bearer xxx」里要先于通用 key 规则整段抹掉，否则只抹掉「Bearer」这个词。
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[已隐藏]'],
  [new RegExp(String.raw`(["']?)\b(${SENSITIVE_KEYS})\b\1\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}&]+)`, 'gi'), '$1$2$1: [已隐藏]'],
  [/\b(?:sk|ak|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[已隐藏]'],
  [/\b[A-Za-z0-9]{32,}\b/g, '[已隐藏]'],
];
// 错误摘要只留短句并抹掉疑似密钥和本机用户名：诊断文件会被转发给别人看。
function scrubText(value, max = 240) {
  let text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  for (const [re, to] of SCRUB_RULES) text = text.replace(re, to);
  return text.length > max ? text.slice(0, max) + '…' : text;
}
// 编排器落盘的失败字段（core/group-chat-orchestrator.js）：failure 是 { code, label, summary, detail }，
// 另有 statusReason / failureReason。诊断只导出受控的部分：原因码（形如 quota_exceeded）和不带 JSON 痕迹的短句（≤24 字，如「额度不足」）；
// failure.summary / detail、error 文本、系统提示正文都可能夹带网关回显的请求正文，一律不导出。
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const isCode = v => typeof v === 'string' && CODE_RE.test(v.trim());
const isLabel = v => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 24 && !/[{}"=]/.test(v);
function failureText(m) {
  if (!m) return '';
  const f = m.failure && typeof m.failure === 'object' ? m.failure : null;
  const parts = [];
  if (f) { if (isLabel(f.label)) parts.push(f.label); if (isCode(f.code)) parts.push(f.code); }
  else if (isCode(m.failure)) parts.push(m.failure);
  for (const v of [m.statusReason, m.failureReason, m.error, m.reason]) if (isCode(v) || isLabel(v)) parts.push(v);
  if (!parts.length && m.systemNote && m.noteKind === 'error') parts.push('系统提示：出错');
  return [...new Set(parts.map(x => x.trim()))].join(' · ');
}
// 只认确实在跑的引擎：循环 / 串行、交付、开发文件流、小队（main.js 注入各引擎实例）。
function workflowBusy(engines = {}, meetingId) {
  const { loopEngine, deliveryEngine, devFileEngine, squadEngine } = engines;
  try { if (loopEngine?.isRunning?.(meetingId)) return 'loop'; } catch {}
  try { if (deliveryEngine?.isBusy?.(meetingId)) return 'delivery'; } catch {}
  try { if (devFileEngine?.status?.(meetingId)?.running) return 'dev-file'; } catch {}
  try {
    const run = squadEngine?.view?.(meetingId)?.run;
    if (run && !['done', 'stopped', 'limit', 'error'].includes(run.status)) return 'squad';
  } catch {}
  return '';
}
// 会话上的模型可能是字符串，也可能是 { id, displayName }（原生 / CodeAgent），诊断里只留名字。
const modelName = v => (typeof v === 'string' ? v : v && typeof v === 'object' ? String(v.id || v.displayName || '') : '') || null;
const safeId = value => String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const hash8 = value => require('node:crypto').createHash('sha256').update(String(value || '')).digest('hex').slice(0, 8);
const stamp = (d = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function createGroupchatRescue(deps) {
  const {
    meetingManager, groupchat, getHubDataDir, getActiveWatchers, interruptMeetingTurn,
    stopLoop = null, restartSession = null, sessionManager, sendToRenderer = () => {},
    isWorkflowRunning = () => false, discardSquadRecovery = null, runtimeState = null, appVersion = '', logger = console,
  } = deps;

  function groupMeeting(meetingId) {
    if (!meetingId) return { error: { ok: false, reason: 'invalid_args', message: '缺少群聊编号' } };
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { error: { ok: false, reason: 'group_chat_not_found', message: '没找到这个群聊' } };
    return { meeting, orch: groupchat.getOrchestrator(getHubDataDir(), meetingId) };
  }
  const members = meeting => (Array.isArray(meeting.subSessions) ? meeting.subSessions : []);
  const liveWatchers = meeting => members(meeting)
    .map(sid => [sid, getActiveWatchers().get(sid)])
    .filter(([, w]) => w && typeof w.isSettled === 'function' && !w.isSettled());
  const notify = (meetingId, action, extra = {}) => {
    try { sendToRenderer('groupchat-rescued', { meetingId, action, ...extra }); }
    catch (e) { logger.warn('[groupchat-rescue] notify failed:', e && e.message); }
  };
  // 结算一个卡住的 watcher：普通 watcher 有 skip（记为缺席）；原生 Claude 的 watcher 没有 skip、interrupt 也是空的
  // （core/claude-native-watcher.js），只能按「被新一轮取代」结算，否则本轮的派发队列一直挂着。
  const settleWatcher = (watcher) => {
    if (typeof watcher.skip === 'function') { watcher.skip(); return 'skipped'; }
    if (typeof watcher.supersede === 'function') { watcher.supersede(); return 'superseded'; }
    throw new Error('watcher 不支持跳过');
  };
  const runtimeOf = session => {
    if (!session) return 'missing';
    try { return (runtimeState || require('../../core/session-runtime-truth').getSessionRuntimeTruth)(session).state || 'unknown'; }
    catch { return 'unknown'; }
  };

  // a) 强制结束本轮。「停止本轮」在有发送卡在半路（pendingDispatch）或 run 编号对不上时不会收回待命，
  //    这里在中断之后无条件收回；卡在半路的发送醒来时会看到中断代际、自己以「已中断」收尾。
  function forceSettle({ meetingId } = {}) {
    const { meeting, orch, error } = groupMeeting(meetingId);
    if (error) return error;
    // 记下动手前是否真的在跑：「停止本轮」那一步常常已经把轮次收回待命，forceIdle 再看就是空闲，不能据此说「本来就空闲」。
    const wasBusy = (orch.state.currentMode && orch.state.currentMode !== 'idle') || liveWatchers(meeting).length > 0;
    let loopStopped = false;
    if (typeof stopLoop === 'function') {
      try { loopStopped = !!stopLoop(meetingId, { interrupt: false }); }
      catch (e) { logger.warn('[groupchat-rescue] stopLoop threw:', e && e.message); }
    }
    let interrupted = { stopped: [], signaled: [] };
    if (typeof interruptMeetingTurn === 'function') {
      try { interrupted = interruptMeetingTurn(meetingId, { reason: 'force_settle' }) || interrupted; }
      catch (e) { logger.warn('[groupchat-rescue] interrupt threw:', e && e.message); }
    }
    // 中断后仍没结算的（watcher 不认中断），按「跳过」结算，保证不再挂着。
    const skipped = [];
    for (const [sid, watcher] of liveWatchers(meeting)) {
      try { settleWatcher(watcher); skipped.push(sid); } catch (e) { logger.warn('[groupchat-rescue] skip threw:', e && e.message); }
    }
    const forced = orch.forceIdle('force_settle');
    notify(meetingId, 'force-settle', { turnNum: forced.turnNum || null });
    return {
      ok: true, turnNum: forced.turnNum || null, wasBusy, forced: forced.changed, attemptsClosed: forced.attemptsClosed || 0,
      stopped: interrupted.stopped || [], signaled: interrupted.signaled || [], skipped, loopStopped, mode: orch.state.currentMode,
    };
  }

  // b) 重启单个成员。正在答的先按跳过结算（本轮其他人照常），再走 restart-session：
  //    能恢复原生历史的按原会话恢复，群聊成员身份与卡片保留。
  async function restartMember({ meetingId, sid } = {}) {
    const { meeting, error } = groupMeeting(meetingId);
    if (error) return error;
    if (!sid || !members(meeting).includes(sid)) return { ok: false, reason: 'participant_not_in_meeting', message: '这位成员不在本群' };
    if (typeof restartSession !== 'function') return { ok: false, reason: 'restart_unavailable', message: '当前 Hub 不支持重启成员' };
    const current = sessionManager.getSession(sid);
    if (!current || current.status === 'dormant') return { ok: false, reason: current ? 'session_dormant' : 'session_not_found', message: '这位成员的会话已休眠或不存在：在群成员栏点它的头像唤醒即可，不需要重启' };
    const watcher = getActiveWatchers().get(sid);
    let skipped = false;
    if (watcher && typeof watcher.isSettled === 'function' && !watcher.isSettled()) {
      try { settleWatcher(watcher); skipped = true; } catch (e) { logger.warn('[groupchat-rescue] skip before restart threw:', e && e.message); }
    }
    let result;
    try { result = await restartSession(sid); }
    catch (e) { result = { ok: false, error: 'restart-failed', message: e && e.message }; }
    if (!result || result.ok === false) {
      return { ok: false, reason: (result && result.error) || 'restart_failed', message: (result && result.message) || '重启失败', skipped };
    }
    const fresh = sessionManager.getSession(sid);
    notify(meetingId, 'restart-member', { sid });
    return { ok: true, sid, skipped, state: runtimeOf(fresh), kind: fresh ? fresh.kind : null };
  }

  // c) 回退上一轮：只在空闲时做，避免和在途的结算抢写状态。
  function rollbackLastTurn({ meetingId } = {}) {
    const { meeting, orch, error } = groupMeeting(meetingId);
    if (error) return error;
    if (meeting.scene === 'dev') return { ok: false, reason: 'dev_workflow', message: '开发任务按阶段推进，不能回退轮次' };
    const busy = isWorkflowRunning(meetingId);
    if (busy) return { ok: false, reason: 'workflow_running', engine: typeof busy === 'string' ? busy : null,
      message: `${{ squad: '小队', delivery: '交付流程', 'dev-file': '开发流程', loop: '工作流' }[busy] || '工作流'}还在跑：先「强制结束本轮」（会一并停下它）再回退` };
    if ((orch.state.currentMode && orch.state.currentMode !== 'idle') || liveWatchers(meeting).length) {
      return { ok: false, reason: 'turn_running', message: '本轮还在进行：先「强制结束本轮」再回退' };
    }
    const turnNum = Number(orch.state.currentTurn) || 0;
    if (!turnNum) return { ok: false, reason: 'no_turn_yet', message: '还没有可回退的轮次' };
    const before = (orch.state.messages || []).length;
    orch.rollbackTurn(turnNum);
    const removed = before - (orch.state.messages || []).length;
    // 小队负责人掉线停下的任务（R46 可恢复错误态）要重发的那一棒属于刚撤的对话，一并作废，免得顶栏还挂着续做按钮。
    let squadDiscarded = false;
    try { squadDiscarded = !!(discardSquadRecovery && discardSquadRecovery(meetingId, turnNum)); }
    catch (e) { logger.warn('[groupchat-rescue] discard squad recovery threw:', e && e.message); }
    notify(meetingId, 'rollback-last-turn', { turnNum });
    return { ok: true, turnNum, removedMessages: removed, currentTurn: orch.state.currentTurn, ...(squadDiscarded ? { squadDiscarded: true } : {}) };
  }

  // d) 跳过所有还没交的成员（单成员跳过仍走 groupchat-skip-participant）。
  function skipStuck({ meetingId } = {}) {
    const { meeting, error } = groupMeeting(meetingId);
    if (error) return error;
    const skipped = [];
    for (const [sid, watcher] of liveWatchers(meeting)) {
      try { settleWatcher(watcher); skipped.push(sid); } catch (e) { logger.warn('[groupchat-rescue] skip threw:', e && e.message); }
    }
    if (skipped.length) notify(meetingId, 'skip-stuck', { skipped });
    return { ok: true, skipped };
  }

  // e) 诊断快照：只放结构与状态，不放对话正文、提示词、Key、Cookie；路径只留文件名。
  function buildDiagnostics(meetingId) {
    const { meeting, orch, error } = groupMeeting(meetingId);
    if (error) return error;
    const st = orch.state || {};
    const turnNum = Number(st.currentTurn) || 0;
    const watchers = getActiveWatchers();
    const attemptsOf = sid => Object.values(st.attempts || {})
      // 有当前 run 时只看这次 run 的尝试：回退过的轮次号会被下一轮复用，旧尝试不能混进来。
      .filter(a => a && a.sid === sid && (st.activeRun && st.activeRun.runId ? a.runId === st.activeRun.runId : (!turnNum || Number(a.turnNum) === turnNum)))
      .map(a => ({ attemptTag: hash8(a.attemptId), status: a.status, deliveryAttempt: a.deliveryAttempt || 0,
        updatedAt: a.updatedAt || null, ...(a.recoveryReason ? { recoveryReason: scrubText(a.recoveryReason, 80) } : {}) }));
    const answerOf = sid => {
      const entry = typeof orch.answerFileFor === 'function' ? orch.answerFileFor(turnNum, sid) : null;
      if (!entry) return null;
      const files = {};
      for (const key of ['ready', 'rework', 'blocked', 'draft']) {
        if (!entry[key]) continue;
        let stat = null;
        try { const s = fs.statSync(entry[key]); stat = { exists: true, bytes: s.size }; } catch (e) { stat = { exists: false, ...(e.code !== 'ENOENT' ? { error: e.code } : {}) }; }
        files[key] = { name: path.basename(entry[key]), ...stat };
      }
      return { state: entry.state || null, outcome: entry.outcome || null, files };
    };
    const memberRows = members(meeting).map((sid, index) => {
      const session = sessionManager.getSession(sid);
      const watcher = watchers.get(sid);
      const spec = Array.isArray(meeting.slotSpecs) ? meeting.slotSpecs[index] : null;
      return {
        index, sidTag: hash8(sid), memberId: (spec && spec.memberId) || `m${index + 1}`,
        kind: session ? session.kind : (spec && spec.kind) || null,
        backend: session ? (session.runtimeBackend || session.agentRuntime || 'pty') : null,
        model: modelName(session ? (session.model || session.currentModel) : spec && spec.model),
        status: session ? session.status || null : 'missing', runtime: runtimeOf(session),
        watcher: watcher ? (watcher.isSettled() ? 'settled' : 'running') : 'none',
        attempts: attemptsOf(sid), answerFile: answerOf(sid),
      };
    });
    const recentErrors = (st.messages || [])
      .filter(m => m && (m.status === 'errored' || m.status === 'failed' || m.failure || m.statusReason || m.failureReason
        || m.error || m.noteKind === 'error'))
      .slice(-10)
      .map(m => ({ turnNum: m.turnNum || null, role: m.role, status: m.status || null, memberId: m.memberId ? safeId(m.memberId) : null,
        reason: scrubText(failureText(m), 240) }));
    return {
      schema: 'hub-groupchat-diagnostics/1', exportedAt: new Date().toISOString(), hubVersion: appVersion || null,
      meeting: {
        idTag: hash8(meeting.id), scene: meeting.scene || null, answerSource: meeting.answerSource || null,
        answerFiles: require('../../core/group-answer-files').enabled(meeting),
        serialWorkflow: !!meeting.serialWorkflow, memberCount: members(meeting).length,
        workflowRunning: isWorkflowRunning(meetingId) || false,
      },
      turn: {
        currentTurn: turnNum, currentMode: st.currentMode || 'idle', revision: st.revision || 0, turns: (st.turns || []).length,
        messages: (st.messages || []).length,
        activeRun: st.activeRun ? { runTag: hash8(st.activeRun.runId), status: st.activeRun.status || null,
          hasFailures: !!st.activeRun.hasFailures, forcedIdle: st.activeRun.forcedIdle || null,
          startedAt: st.activeRun.startedAt || st.activeRun.createdAt || null, updatedAt: st.activeRun.updatedAt || null } : null,
        pendingPromptTurns: Object.keys(st.pendingPrompts || {}).length,
      },
      members: memberRows, recentErrors,
      privacy: '不含 API Key、token、Cookie、提示词与对话正文；会话、群、轮次与尝试编号只留哈希前 8 位',
    };
  }
  function exportDiagnostics({ meetingId } = {}) {
    const snapshot = buildDiagnostics(meetingId);
    if (snapshot.ok === false) return snapshot;
    const dir = path.join(getHubDataDir(), 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${stamp()}-groupchat-${snapshot.meeting.idTag}.json`);
    const text = JSON.stringify(snapshot, null, 2);
    fs.writeFileSync(file, text, 'utf8');
    return { ok: true, path: file, text };
  }

  return { forceSettle, restartMember, rollbackLastTurn, skipStuck, buildDiagnostics, exportDiagnostics };
}

function registerGroupchatRescueIpc(ipcMain, deps) {
  const rescue = createGroupchatRescue(deps);
  const logger = deps.logger || console;
  const wrap = (name, fn) => ipcMain.handle(name, async (_e, args = {}) => {
    try { return await fn(args || {}); }
    catch (err) {
      logger.error(`[${name}] threw:`, err);
      return { ok: false, reason: 'exception', message: (err && err.message) || String(err) };
    }
  });
  wrap('groupchat:force-settle', rescue.forceSettle);
  wrap('groupchat:restart-member', rescue.restartMember);
  wrap('groupchat:rollback-last-turn', rescue.rollbackLastTurn);
  wrap('groupchat:skip-stuck', rescue.skipStuck);
  wrap('groupchat:export-diagnostics', rescue.exportDiagnostics);
  return rescue;
}

module.exports = { createGroupchatRescue, registerGroupchatRescueIpc, scrubText, failureText, workflowBusy };
