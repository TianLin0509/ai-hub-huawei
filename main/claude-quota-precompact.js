'use strict';
// 额度预压缩 + 主动换号（2026-10-26 用户拍板）。
//
// 为什么：换到别的账号后，原账号的提示缓存全部作废，整段上下文要在新账号上重新写一遍缓存，
// 60 万上下文的这一轮约等于平时 20 轮。先在旧账号上压缩（读的是现成缓存），新账号只写摘要。
//
// 流程：
//   1. 账号用量一到（每回合状态栏免费带回的读数，或 broker.onUsage 的兜底查询；2026-10-29 起），看该账号上的 Claude 会话：
//      最紧窗口剩余 < 10%，且这个窗口不会在 30 分钟内重置 → 进入判定。
//   2. 开了「额度耗尽自动换号」的会话：看其他账号的最近读数（2026-10-29 起不限出口，换号前实测目标出口；包括没有会话在用的；账号只在 Hub 里用，
//      读数过了重置时间按已重置算，从没读过的账号才现查），
//      挑 5 小时剩余 > 50% 且所有 7 天窗口剩余 > 20% 的，选最宽裕的。
//      挑到 → 计划「压缩后换号」；确认挑不到（或没开自动换号）→ 只提醒一次更新进展卡，不压缩、不换号；
//      有账号没查到（限流等）→ 5 分钟后重判。
//   3. 计划写进信号文件，用户目录的软压缩提醒钩子读到后，在上下文超过窗口 30% 时提醒 AI
//      更新进展卡并在断点留压缩标记；软压缩控制器按这里给的门槛压缩。
//   4. 压缩完成 → 计划仍有效、源账号仍低、目标仍达标 → 走手动换号同一条路（requestAccount）→ 控制器再发「继续」。
//   兜底：AI 没留标记就撞了额度墙，原有的撞墙换号照常工作。
//   每次异步等待后都核对会话身份（原生会话、账号、登录代次）和自动换号开关，对不上就作废（交叉审查 2026-10-26）。
const fs = require('node:fs');
const path = require('node:path');
const { windowsForModel } = require('../core/claude-quota-switch-policy');

const STATE_DIR = process.env.SOFT_COMPACT_STATE_DIR || path.join('D:\\', 'AppData', 'Cache', 'soft-compact');

function contextWindow(model) {
  return /\[1m\]|-1m\b/i.test(String(model || '')) ? 1_000_000 : 200_000;
}

function toRemaining(rows) {
  const out = [];
  for (const { key, value } of rows) {
    if (!value || typeof value.utilization !== 'number' || !Number.isFinite(value.utilization)) return null;
    out.push({ key, remaining: Math.max(0, 100 - value.utilization), resetsAt: Date.parse(value.resets_at) || 0 });
  }
  return out;
}

// 当前账号：按模型取窗口（与撞墙换号同一口径）；读不全返回 null（未知不当作有余量）。
function remainingWindows(usage, model) {
  const rows = windowsForModel(usage, model);
  return rows.length < 2 ? null : toRemaining(rows);
}

// 候选账号：5 小时窗口 + 所有 7 天窗口（含各模型专用的），哪个都不能低于门槛。
function allWindows(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const rows = Object.entries(usage).filter(([key, value]) => (key === 'five_hour' || key.startsWith('seven_day')) && value)
    .map(([key, value]) => ({ key, value }));
  if (!rows.some(r => r.key === 'five_hour') || !rows.some(r => r.key === 'seven_day')) return null;
  return toRemaining(rows);
}

function qualifies(windows, { min5h, min7d }) {
  if (!windows) return false;
  const five = windows.find(w => w.key === 'five_hour');
  return !!five && five.remaining > min5h && windows.filter(w => w.key.startsWith('seven_day')).every(w => w.remaining > min7d);
}

function createClaudeQuotaPrecompact({
  sessionManager, broker, profiles, sameRoute, requestAccount, notify = () => {},
  stateDir = STATE_DIR, now = Date.now, logger = console,
  triggerRemaining = 10, contextShare = 0.3, min5h = 50, min7d = 20, resetGraceMs = 30 * 60 * 1000,
  retries = 5, retryMs = 2000, transientRetryMs = 5 * 60 * 1000, skipWindowMs = 2 * 3600 * 1000,
} = {}) {
  if (!sessionManager || !broker) throw new Error('claude-quota-precompact 缺少 sessionManager 或 broker');
  const plans = new Map();      // hub 会话 id → 计划
  const retryAfter = new Map(); // 候选查询暂时失败：到点前不重判
  const evaluating = new Set();
  // AI 已收到「留标记等压缩」的提醒、计划却被撤销的原生会话：标记来了要补发一次「接着做」，否则长任务停住。
  const orphaned = new Map();   // 原生会话 id → { at, used }
  const short = id => String(id).slice(0, 8);
  const say = (id, message, level = 'info') => { try { notify(id, message, level); } catch {} };
  const managed = s => s && /^claude(?:-resume)?$/.test(String(s.kind || '')) && s.agentRuntime === 'pty' && s.claudeRuntimeHome;
  const signalFile = nativeId => path.join(stateDir, `quota-${nativeId}.json`);
  const account = id => (profiles() || []).find(p => p.id === id);
  const identity = s => ({ nativeId: s.ccSessionId, profile: s.claudeProfile, generation: s.claudeAuthGeneration || 0 });
  const sameIdentity = (s, who) => !!managed(s) && s.ccSessionId === who.nativeId && s.claudeProfile === who.profile
    && (s.claudeAuthGeneration || 0) === who.generation;

  function writeSignal(plan) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = `${signalFile(plan.nativeId)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ mode: plan.mode, minTokens: plan.minTokens, seq: plan.seq,
        remaining: plan.remaining, target: plan.targetLabel || null, reason: plan.reason || null }), 'utf8');
      fs.renameSync(tmp, signalFile(plan.nativeId));
    } catch (error) { logger.warn?.(`[quota-precompact] signal write failed: ${error.message}`); }
  }
  const reminded = (nativeId, seq) => {
    try { return fs.readFileSync(path.join(stateDir, `quota-${nativeId}.done`), 'utf8').trim() === String(seq); }
    catch { return false; }
  };
  // orphan：计划被撤销（不是压缩后正常收尾）时传 true，AI 若已被提醒，就记下来等它的标记。
  function clear(sessionId, orphan = false) {
    const plan = plans.get(sessionId);
    plans.delete(sessionId);
    if (!plan?.nativeId) return;
    if (orphan && plan.mode === 'switch' && reminded(plan.nativeId, plan.seq)) orphaned.set(plan.nativeId, { at: now(), used: false });
    try { fs.unlinkSync(signalFile(plan.nativeId)); } catch {}
  }
  // Hub 重启后内存里的计划没了：上次留下的信号文件删掉；AI 已被提醒的，同样等它的标记补发「接着做」。
  try {
    for (const name of fs.readdirSync(stateDir)) {
      const match = name.match(/^quota-(.+)\.json$/);
      if (!match) continue;
      try {
        const signal = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
        if (signal.mode === 'switch' && reminded(match[1], signal.seq)) orphaned.set(match[1], { at: now(), used: false });
      } catch {}
      try { fs.unlinkSync(path.join(stateDir, name)); } catch {}
    }
  } catch {}
  // 计划仍然有效：还是同一个计划对象、会话身份没变、换号计划仍开着自动换号。
  function stillValid(sessionId, plan) {
    const session = sessionManager.getSession(sessionId);
    return plans.get(sessionId) === plan && sameIdentity(session, plan)
      && (plan.mode !== 'switch' || session.claudeAutoSwitch === true);
  }

  async function findTarget(session) {
    const current = account(session.claudeProfile);
    if (!current) return { reason: '当前账号配置缺失' };
    const rows = [];
    let failed = 0;
    for (const profile of profiles() || []) {
      if (profile.id === current.id || !sameRoute(current, profile)) continue;
      try {
        // 候选账号沿用上次读数（账号只在 Hub 里用，过了重置时间按已重置算），不再逐个查询。
        const windows = allWindows((await broker.usage(profile, { maxAgeMs: Infinity, why: 'precompact-target' }))?.usage);
        if (qualifies(windows, { min5h, min7d })) rows.push({ profile, slack: Math.min(...windows.map(w => w.remaining)) });
      } catch (error) {
        failed++;
        logger.log?.(`[quota-precompact] usage of ${profile.id} unavailable: ${error.code || error.message}`);
      }
    }
    rows.sort((a, b) => b.slack - a.slack || a.profile.id.localeCompare(b.profile.id));
    if (rows[0]) return { target: rows[0] };
    if (failed) return { transient: true }; // 有账号没查到：不能断定「没有候选」，稍后重判
    return { reason: `其他账号都不满足「5 小时剩余 > ${min5h}%、7 天剩余 > ${min7d}%」` };
  }

  async function evaluate(session, snapshot) {
    const id = session.id;
    if (evaluating.has(id)) return;
    const model = session.currentModel?.id || session.model || '';
    const windows = remainingWindows(snapshot?.usage, model);
    if (!windows) return;
    const tightest = windows.reduce((a, b) => (b.remaining < a.remaining ? b : a));
    const existing = plans.get(id);
    if (existing && !stillValid(id, existing)) clear(id, true);
    if (tightest.remaining >= triggerRemaining) {
      // 额度恢复（窗口重置或已换号）就撤掉计划；留 10 个点的回差，避免在门槛上来回抖
      if (plans.has(id) && tightest.remaining >= triggerRemaining + 10) clear(id, true);
      return;
    }
    if (tightest.resetsAt && tightest.resetsAt - now() <= resetGraceMs) {
      if (plans.has(id)) clear(id, true); // 马上就重置：不折腾
      logger.log?.(`[quota-precompact] ${short(id)} ${tightest.key} resets within grace; skip`);
      return;
    }
    if (plans.has(id) || !session.ccSessionId || (retryAfter.get(id) || 0) > now()) return;
    const who = identity(session);
    evaluating.add(id);
    try {
      const minTokens = Math.round(contextWindow(model) * contextShare);
      const remaining = Math.round(tightest.remaining);
      let found = { reason: '这个会话没有开「额度耗尽时自动换号」' };
      if (session.claudeAutoSwitch === true) found = await findTarget(session);
      if (!sameIdentity(sessionManager.getSession(id), who)) return;
      if (found.transient) { retryAfter.set(id, now() + transientRetryMs); return; }
      retryAfter.delete(id);
      const plan = { sessionId: id, ...who, seq: now(), minTokens, remaining, mode: found.target ? 'switch' : 'card',
        target: found.target?.profile.id || null,
        targetLabel: found.target ? (found.target.profile.label || found.target.profile.id) : null, reason: found.reason || null };
      plans.set(id, plan);
      writeSignal(plan);
      logger.log?.(`[quota-precompact] ${short(id)} remaining=${remaining}% mode=${plan.mode} target=${plan.target || '-'}`);
      say(id, plan.mode === 'switch'
        ? `当前账号额度只剩约 ${remaining}%：已找到 ${plan.targetLabel}，AI 到断点更新进展卡后将先压缩上下文再换号（上下文不到窗口 ${Math.round(contextShare * 100)}% 时不压缩）。`
        : `当前账号额度只剩约 ${remaining}%，不会自动换号（${plan.reason}）；已提醒 AI 更新进展卡，方便你换会话接力。`,
      plan.mode === 'switch' ? 'info' : 'warning');
    } finally { evaluating.delete(id); }
  }

  function onUsage(profile, snapshot) {
    for (const session of sessionManager.getAllSessions?.() || []) {
      if (!managed(session) || session.claudeProfile !== profile.id || session.meetingId) continue;
      void evaluate(session, snapshot).catch(error => logger.warn?.(`[quota-precompact] evaluate failed: ${error.message}`));
    }
  }

  // 软压缩控制器在 Stop 时问：这个会话有没有「压缩后换号」的计划，有就按计划的门槛压缩。
  function planFor(sessionId) {
    const plan = plans.get(sessionId);
    if (!plan || plan.mode !== 'switch') return null;
    if (!stillValid(sessionId, plan)) { clear(sessionId, true); return null; }
    return { minTokens: plan.minTokens, target: plan.target, targetLabel: plan.targetLabel };
  }

  // 压缩完成后换号：计划仍有效、源账号仍低、目标仍达标才换；走手动换号同一条路，换完下一条消息就用新账号。
  async function afterCompact(sessionId) {
    const plan = plans.get(sessionId);
    if (!plan || plan.mode !== 'switch') return null;
    const target = account(plan.target), source = account(plan.profile);
    const gone = status => ({ ok: false, status });
    try {
      if (!target || !source || !stillValid(sessionId, plan)) return gone('plan-invalid');
      const session = sessionManager.getSession(sessionId);
      const model = session.currentModel?.id || session.model || '';
      const sourceWindows = remainingWindows((await broker.usage(source, { maxAgeMs: 5 * 60_000, why: 'precompact-source' }))?.usage, model);
      if (!stillValid(sessionId, plan)) return gone('plan-invalid');
      if (sourceWindows && Math.min(...sourceWindows.map(w => w.remaining)) >= triggerRemaining) {
        say(sessionId, '上下文已压缩；当前账号额度已经恢复，不换号。');
        return gone('source-recovered');
      }
      const targetWindows = allWindows((await broker.usage(target, { maxAgeMs: Infinity, why: 'precompact-target' }))?.usage);
      if (!stillValid(sessionId, plan)) return gone('plan-invalid');
      if (!qualifies(targetWindows, { min5h, min7d })) {
        say(sessionId, `上下文已压缩；${plan.targetLabel} 的额度已不再满足换号条件，保持当前账号。`, 'warning');
        return gone('target-not-qualified');
      }
      // 压缩刚结束时会话可能仍被看作在跑，换号会排队；排队期间 Hub 拒绝一切发送（含随后的「继续」），
      // 所以排队就撤回、稍等再试，几次不成就放弃换号，保证「继续」发得出去。
      let result = null;
      for (let attempt = 0; attempt < retries; attempt++) {
        if (!stillValid(sessionId, plan)) return gone('plan-invalid');
        result = await requestAccount(sessionId, plan.target);
        if (!(result?.ok && result.status === 'queued')) break;
        await requestAccount(sessionId, plan.profile); // 选回当前账号 = 取消排队中的换号
        result = { ok: false, status: 'busy', message: '会话一直显示在运行' };
        await new Promise(resolve => setTimeout(resolve, retryMs));
      }
      if (result?.ok && result.status === 'switched') say(sessionId, `上下文已压缩，已换到 ${plan.targetLabel}（新账号只需读压缩后的摘要）。`);
      else say(sessionId, `上下文已压缩，但换号没有完成：${result?.message || '未知原因'}。保持当前账号，撞到额度上限时仍会自动换号。`, 'warning');
      return result;
    } catch (error) {
      say(sessionId, `上下文已压缩，但换号前查询额度失败：${error.message}。保持当前账号。`, 'warning');
      return { ok: false, status: 'error', message: error.message };
    } finally { if (plans.get(sessionId) === plan) clear(sessionId); }
  }

  function forget(sessionId) { clear(sessionId); retryAfter.delete(sessionId); }

  // 软压缩控制器看到「压完继续」标记却不压缩时问：要不要补发一次「接着做」。每个撤销的计划只回一次 true。
  function skippedMarker(sessionId) {
    const nativeId = sessionManager.getSession(sessionId)?.ccSessionId;
    const entry = nativeId && orphaned.get(nativeId);
    if (!entry || entry.used || now() - entry.at > skipWindowMs) return false;
    entry.used = true;
    return true;
  }

  return { onUsage, evaluate, planFor, afterCompact, forget, skippedMarker, plans };
}

module.exports = { createClaudeQuotaPrecompact, contextWindow, remainingWindows, allWindows, qualifies };
