'use strict';
// 群聊「小队模式」引擎（2026-11-19）。
// 用户消息只发负责人 → 负责人回答里的派工块 → 按「依次/同时」叫醒成员 → 成员答完自动交回负责人
// → 负责人再派或直接答复用户。每次用户发话后最多连续派工 maxRounds 轮，到了停下等用户。
// 配置存在 <Hub 数据目录>/squad/<群 id>.json，不改群聊对象；关掉小队模式后群聊照旧。
// 运行状态只在内存：Hub 重启后小队停在原地，用户回话给负责人即可接着做，不自动续派。
const fs = require('fs');
const path = require('path');
const P = require('../../core/squad-protocol');

function createSquadEngine(deps) {
  const {
    getHubDataDir, meetingManager, getDispatcher, getMembers, ensureMemberReady,
    interruptMeetingTurn = () => {}, getOrchestrator = () => null, sendToRenderer = () => {}, logger = console,
  } = deps;
  let frozen = false;
  const runs = new Map();          // meetingId → { token, abort, status, round, maxRounds, steps, note }
  const parseTargets = require('./dispatcher')._parseGroupTargets;

  const file = id => path.join(getHubDataDir(), 'squad', `${String(id).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
  function config(id) {
    try { return P.normalizeConfig(JSON.parse(fs.readFileSync(file(id), 'utf8'))); }
    catch { return P.normalizeConfig(null); }
  }
  function saveConfig(id, value) {
    const next = P.normalizeConfig(value);
    fs.mkdirSync(path.dirname(file(id)), { recursive: true });
    const tmp = `${file(id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file(id));
    return next;
  }
  function members(meeting) {
    // 会话标题常被自动起成「成员 2 · 群聊 · <问题前 20 字>」，界面与提示词只用第一段（真机验收 2026-11-19）。
    return (getMembers(meeting) || []).map(m => ({ ...m, label: String(m.displayName || m.memberId).split(' · ')[0].trim() || m.memberId }));
  }
  function leaderOf(meeting, cfg) {
    const list = members(meeting);
    return list.find(m => m.memberId === cfg.leaderMemberId) || null;
  }
  function publicRun(run) {
    if (!run) return null;
    const { token, abort, ...rest } = run;
    void token; void abort;
    return { ...rest, steps: rest.steps.map(step => ({ ...step })) };
  }
  function view(id) {
    const meeting = meetingManager.getMeeting(id);
    const cfg = config(id);
    const leader = meeting && cfg.enabled ? leaderOf(meeting, cfg) : null;
    const roster = meeting && meeting.groupChat
      ? members(meeting).map(m => ({ memberId: m.memberId, label: m.label, index: m.index, kind: m.kind || '', model: m.model || '' })) : [];
    return { meetingId: id, config: cfg, leaderLabel: leader ? leader.label : '', members: roster, run: publicRun(runs.get(id)) };
  }
  function emit(id) {
    try { sendToRenderer('squad:changed', view(id)); }
    catch (error) { logger.warn?.('[squad] notify renderer failed:', error.message); }
  }
  function note(id, turnNum, text) {
    try {
      const orch = getOrchestrator(id);
      if (orch && turnNum) orch.appendSystemNote(turnNum, text, { kind: 'squad' });
    } catch (error) { logger.warn?.('[squad] note failed:', error.message); }
  }
  // 群聊卡片上的正文（回答文件）优先：成员把详细回答和派工块写进回答文件、聊天里只给摘要时，
  // 也按群里看到的那份来读；卡片还没内容才退回聊天里的最终回复。
  function cardText(id, result, sid) {
    try {
      const n = Number(result?.turnNum);
      const msg = n && (getOrchestrator(id)?.state?.messages || []).find(m => m && m.role === 'assistant'
        && m.sid === sid && Number(m.turnNum) === n && !m.supplementReply && m.status !== 'progress_update');
      return String(msg?.content || '').trim();
    } catch { return ''; }
  }
  function textOf(result, sid, id) {
    const item = (result?.results || []).find(r => r && r.sid === sid);
    if (!item || !['completed', 'manual_extracted'].includes(item.status || 'completed')) return '';
    return (id && cardText(id, result, sid)) || String(item.text || '');
  }
  function failed(result, sid, id) {
    if (!result || result.status !== 'completed') return result?.reason || result?.status || '派发失败';
    if (result.interrupted) return '已停止';
    const item = (result.results || []).find(r => r && r.sid === sid);
    if (!item) return '没有收到回答';
    if (['completed', 'manual_extracted'].includes(item.status || 'completed') && textOf(result, sid, id).trim()) return '';
    if (['completed', 'manual_extracted'].includes(item.status || 'completed')) return '交回的内容是空的';
    return item.reason || item.status || '没有收到回答';
  }

  function configure(id, patch = {}) {
    const meeting = meetingManager.getMeeting(id);
    if (!meeting || !meeting.groupChat) throw new Error('只有群聊能开小队模式');
    const list = members(meeting);
    const current = config(id);
    const next = { ...current, ...patch };
    if (next.enabled) {
      const conflict = P.conflict(meeting);
      if (conflict) throw new Error(conflict);
      if (list.length < 2) throw new Error('小队至少要两位成员：一位负责人，加至少一位干活的成员');
      if (!list.some(m => m.memberId === next.leaderMemberId)) next.leaderMemberId = list[0].memberId;
      if (!current.enabled) next.previousParticipants = Array.isArray(meeting.participants) ? meeting.participants.slice() : null;
    } else {
      stop(id, { quiet: true });
    }
    const saved = saveConfig(id, next);
    emit(id);
    const leader = saved.enabled ? list.find(m => m.memberId === saved.leaderMemberId) : null;
    return { ok: true, ...view(id), leaderIndex: leader ? leader.index : null };
  }

  function stop(id, { quiet = false } = {}) {
    const run = runs.get(id);
    if (!run || ['done', 'stopped', 'limit', 'error'].includes(run.status)) return false;
    run.abort = true;
    run.status = 'stopped';
    run.note = '已停止小队';
    for (const step of run.steps) if (['waiting', 'running'].includes(step.state)) step.state = 'stopped';
    if (!quiet) {
      try { interruptMeetingTurn(id, { reason: 'squad_stop' }); }
      catch (error) { logger.warn?.('[squad] interrupt failed:', error.message); }
      note(id, run.turnNum, '你已停止小队：成员不再接力，负责人等你下一句话。');
    }
    emit(id);
    return true;
  }

  // 用户在群里发话（groupchat:turn）。小队没开、或这句话 @ 了别的成员、或是工作流内部派发：照常走。
  async function userTurn(id, args, base) {
    const meeting = meetingManager.getMeeting(id);
    const cfg = config(id);
    if (frozen || !meeting || !meeting.groupChat || !cfg.enabled || args?.silent || args?.workflowRun || P.conflict(meeting)) return base(id, args);
    const list = members(meeting);
    const leader = leaderOf(meeting, cfg);
    if (!leader) return base(id, args);
    const text = String(args.userInput || '');
    // 只有开头就 @ 某位成员（「@m3 你看下」）才算绕过负责人直接找他；句中的 @ 是在跟负责人
    // 交代分工（真机验收 2026-11-19：「先让 @m2 …再让 @m3 …」被当成直达，负责人被跳过）。
    const opening = /^\s*@[^\s@，,：:]+/.exec(text);
    const direct = opening ? parseTargets(opening[0], list, [], true) : { mentions: [] };
    if (direct.mentions.length && !direct.mentions.every(mid => mid === leader.memberId)) return base(id, args);
    stop(id, { quiet: true });                 // 新的一句话 = 新的一次小队任务
    const run = { token: Symbol('squad'), abort: false, status: 'leader', round: 0, maxRounds: cfg.maxRounds,
      leaderMemberId: leader.memberId, leaderLabel: leader.label, steps: [], note: `${leader.label} 正在理解需求`, startedAt: Date.now() };
    runs.set(id, run);
    emit(id);
    let result;
    try {
      // 负责人可能已休眠：先唤醒（普通群聊的头像路由会把休眠成员当缺席，这条路径不会自动唤醒）。
      try { await ensureMemberReady(meeting, leader.memberId); }
      catch (error) { logger.warn?.('[squad] wake leader failed:', error.message); }
      result = await base(id, {
        ...args,
        recipientSids: undefined,                 // 不走「头像 + 句中 @」路由：提示词里有 @m2 这类示例
        targetMemberIds: [leader.memberId],
        userInput: P.leaderPrompt(text, { members: list, leaderMemberId: leader.memberId, maxRounds: cfg.maxRounds }),
        displayUserInput: typeof args.displayUserInput === 'string' ? args.displayUserInput : text,
      });
    } catch (error) {
      if (runs.get(id) === run) { run.status = 'error'; run.note = error.message; emit(id); }
      throw error;
    }
    if (runs.get(id) === run && !run.abort) {
      run.turnNum = result?.turnNum || null;
      continueFrom(id, run, result).catch(error => {
        logger.warn?.('[squad] run failed:', error.message);
        if (runs.get(id) === run) { run.status = 'error'; run.note = error.message; emit(id); }
      });
    }
    return result;
  }

  const alive = (id, run) => !frozen && runs.get(id) === run && !run.abort;

  // Hub 退出排空时调用：所有小队就地停下，不再派下一棒、不再交回（不发 ESC，退出链自己收尾 PTY）。
  function freeze() {
    frozen = true;
    for (const id of runs.keys()) stop(id, { quiet: true });
  }

  async function continueFrom(id, run, leaderResult) {
    let result = leaderResult;
    for (;;) {
      if (!alive(id, run)) return;
      const meeting = meetingManager.getMeeting(id);
      if (!meeting) return;
      const list = members(meeting);
      const leader = list.find(m => m.memberId === run.leaderMemberId);
      const leaderFailure = leader ? failed(result, leader.sid, id) : '负责人不在群里';
      if (leaderFailure) {
        run.status = 'error';
        run.note = leaderFailure === 'cli_not_ready'
          ? '负责人的 CLI 还没启动好，这句话没送到，小队已停下；等成员头像变绿后再发一次即可。'
          : `负责人没有给出回答（${leaderFailure}），小队已停下；查看负责人会话后回话即可继续。`;
        note(id, result?.turnNum || run.turnNum, run.note);
        emit(id);
        return;
      }
      if (result?.turnNum) run.turnNum = result.turnNum;
      const resolve = token => {
        const r = parseTargets('@' + token, list, [], true) || {};
        // @all/@全部/@所有人 或一次对上多个人：派工块要求一人一行，这里不猜，按跳过提示负责人写具体成员（复审补点）
        if ((r.mentions || []).includes('all') || (r.targets || []).length !== 1) return null;
        const hit = r.targets[0];
        return hit && hit.memberId !== leader.memberId ? { memberId: hit.memberId, label: hit.label || hit.displayName } : null;
      };
      const plan = run.round >= run.maxRounds ? null : P.parseDispatch(textOf(result, leader.sid, id), resolve);
      if (plan && plan.skipped.length) {
        note(id, run.turnNum, `派工里的 @${plan.skipped.join('、@')} 没对上群成员或没写任务，已跳过。`);
      }
      if (!plan || !plan.tasks.length) {
        run.status = run.round >= run.maxRounds ? 'limit' : 'done';
        run.note = run.status === 'limit'
          ? `已连续派工 ${run.maxRounds} 轮，小队先停下等你；回复负责人即可继续。`
          : (run.round ? '负责人已验收并答复' : '负责人直接答复，没有派工');
        if (run.status === 'limit') note(id, run.turnNum, run.note);
        emit(id);
        return;
      }
      run.round += 1;
      run.status = 'members';
      run.steps = plan.tasks.map(task => ({ memberId: task.memberId, label: task.label, task: task.task.split('\n')[0].slice(0, 120), state: 'waiting' }));
      run.note = `第 ${run.round}/${run.maxRounds} 轮：${plan.mode === 'parallel' ? '同时' : '依次'}派给 ${plan.tasks.length} 位成员`;
      // 每一棒的派工卡片第一行就是「负责人派给 @X：任务」，不再另起系统提示，免得同一句出现两次。
      emit(id);
      const outcomes = [];
      const dispatch = async (tasks, inputs, stepBase) => {
        for (const task of tasks) await ensureMemberReady(meeting, task.memberId);
        if (!alive(id, run)) return null;
        return getDispatcher().dispatchGroupChatTurn(id, {
          shouldDispatch: () => alive(id, run),     // 排队期间点了停止 / Hub 退出：不再发出
          userInput: tasks.map(task => P.dispatchNote(task)).join('\n'),
          perMemberInput: inputs,
          targetMemberIds: tasks.map(task => task.memberId),
          appendUserMessage: false,
          dispatchMode: 'squad',
          workflowRun: { kind: 'squad', runId: `squad-${run.startedAt}-${run.round}`, stepIndex: stepBase, attempt: 1 },
        });
      };
      const settle = (tasks, res) => {
        for (const task of tasks) {
          const member = list.find(m => m.memberId === task.memberId);
          const reason = res ? failed(res, member && member.sid, id) : '已停止';
          outcomes.push({ memberId: task.memberId, label: task.label, ok: !reason, reason });
          const step = run.steps.find(s => s.memberId === task.memberId);
          if (step) step.state = reason ? (run.abort ? 'stopped' : 'failed') : 'done';
        }
        emit(id);
      };
      try {
        if (plan.mode === 'parallel') {
          run.steps.forEach(step => { step.state = 'running'; });
          emit(id);
          const others = task => plan.tasks.filter(t => t !== task).map(t => `@${t.label}`);
          const inputs = Object.fromEntries(plan.tasks.map(task => [task.memberId,
            P.memberPrompt(task.task, { leaderLabel: run.leaderLabel, mode: 'parallel', others: others(task) })]));
          settle(plan.tasks, await dispatch(plan.tasks, inputs, 0));
        } else {
          for (let i = 0; i < plan.tasks.length; i += 1) {
            if (!alive(id, run)) return;
            const task = plan.tasks[i];
            run.steps[i].state = 'running';
            emit(id);
            const input = P.memberPrompt(task.task, { leaderLabel: run.leaderLabel, mode: 'sequential', index: i, total: plan.tasks.length });
            const res = await dispatch([task], { [task.memberId]: input }, i);
            settle([task], res);
            if (res?.interrupted) { stop(id, { quiet: true }); return; }
          }
        }
      } catch (error) {
        logger.warn?.('[squad] member dispatch failed:', error.message);
        const done = new Set(outcomes.map(o => o.memberId));
        for (const task of plan.tasks) if (!done.has(task.memberId)) {
          outcomes.push({ memberId: task.memberId, label: task.label, ok: false, reason: error.message });
          const step = run.steps.find(s => s.memberId === task.memberId);
          if (step) step.state = 'failed';
        }
      }
      if (!alive(id, run)) return;
      run.status = 'handback';
      run.note = `成员已交回，${run.leaderLabel} 正在验收`;
      emit(id);
      await ensureMemberReady(meeting, leader.memberId);
      if (!alive(id, run)) return;
      result = await getDispatcher().dispatchGroupChatTurn(id, {
        shouldDispatch: () => alive(id, run),
        userInput: P.handbackPrompt(outcomes, { round: run.round, maxRounds: run.maxRounds }),
        targetMemberIds: [leader.memberId],
        appendUserMessage: false,
        dispatchMode: 'squad',
        workflowRun: { kind: 'squad-notice', runId: `squad-${run.startedAt}-${run.round}-back`, stepIndex: 90 + run.round, attempt: 1 },
      });
      if (result?.interrupted) { stop(id, { quiet: true }); return; }
    }
  }

  return { config, configure, stop, freeze, view, userTurn, _runs: runs };
}

function registerSquadIpc(ipcMain, getEngine) {
  const call = fn => async (_e, args = {}) => {
    const engine = getEngine();
    if (!engine) return { ok: false, reason: '小队模式尚未就绪' };
    try { return await fn(engine, args || {}); }
    catch (error) { return { ok: false, reason: error.message }; }
  };
  ipcMain.handle('squad:view', call((e, a) => ({ ok: true, ...e.view(String(a.meetingId || '')) })));
  ipcMain.handle('squad:configure', call((e, a) => e.configure(String(a.meetingId || ''), {
    enabled: a.enabled === true,
    ...(a.leaderMemberId ? { leaderMemberId: String(a.leaderMemberId) } : {}),
    ...(a.maxRounds !== undefined ? { maxRounds: a.maxRounds } : {}),
  })));
  ipcMain.handle('squad:stop', call((e, a) => ({ ok: true, stopped: e.stop(String(a.meetingId || '')) })));
}

module.exports = { createSquadEngine, registerSquadIpc };
