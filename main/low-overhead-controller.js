'use strict';
// 低开销模式主进程控制器（2026-11-23 P1 v2）：把主干「低开销模式」总开关落到会话与运行期七项节能（L1–L7），并负责 L1 软上限巡检与 L7 EcoQoS 巡检。
// 开关与保活数的唯一真值在 core/optional-features.js（getMode 读它）；本控制器不自己存配置、不注册 IPC，
// main.js 的 low-overhead:set 切完模式后调 sync() 让这里跟上。策略本身都在 core/low-overhead-policy.js。

const policy = require('../core/low-overhead-policy');
const { sessionNeedsUserInput } = require('../core/session-attention-state');
const SEARCH_ECO_KEY = 'search-child';

function createLowOverheadController(options = {}) {
  const {
    getMode,                        // () => { on, keepAlive }：optionalFeatures 的真值
    sessionManager = null,
    getProtectedSessionIds = () => new Set(),
    isExemptSession = () => false,  // 组队负责人/成员等由调用方判定
    onSoftCapSuspend = null,        // ({ requested, keepAlive }) => 提示用户
    stateStore = null,              // L6：setSaveMinInterval
    getSearchService = () => null,  // L4：setIdleExitMs
    getPetController = () => null,  // L3：refreshLowOverhead
    getJobQos = () => require('../core/win32-job-qos').getWin32JobQos(), // L7：Windows 分层 Job + EcoQoS
    listServeHosts = () => require('../core/codeagent-serve-host').listHosts(),
    logger = console,
    now = Date.now,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;
  if (typeof getMode !== 'function') throw new TypeError('getMode is required');

  function read() {
    let raw = null;
    try { raw = getMode(); } catch (error) { logger?.warn?.('[low-overhead] read mode failed:', error?.message || error); }
    return policy.normalizeState(raw);
  }
  // 每次都现读真值：建窗前、start 前后任何时刻问，答案都和持久化状态一致（Codex R2）。
  const get = () => read();

  // ── L1 ─────────────────────────────────────────────────────────────
  function collectItems() {
    if (!sessionManager || typeof sessionManager.previewIdleSuspend !== 'function') return [];
    const t = now();
    const excludeSessionIds = getProtectedSessionIds() || new Set();
    const preview = sessionManager.previewIdleSuspend({
      idleMs: policy.SOFT_CAP_MIN_IDLE_MS, now: t, requireSettledCodeAgent: true,
      excludePinned: true, excludeMeeting: true, excludeFocused: false, excludeSessionIds,
    });
    const focus = typeof sessionManager.getFocusedSessionState === 'function'
      ? sessionManager.getFocusedSessionState()
      : { id: sessionManager.focusedSessionId || null, focusedAt: 0 };
    return (preview?.items || []).map(item => {
      const live = sessionManager.sessions?.get?.(item.sessionId);
      const info = live?.info || {};
      let exempt = false;
      try { exempt = isExemptSession(item.sessionId, info) === true; } catch { exempt = false; }
      // 待审批 / 待用户输入：全库唯一真值源（PTY 停在审批时 status 是 idle，只有 attentionState 标着；Gemini P0-4）。
      let needsInput = false;
      try { needsInput = sessionNeedsUserInput(info) === true; } catch { needsInput = false; }
      const focused = !!focus?.id && focus.id === item.sessionId;
      return {
        ...item,
        status: info.status || '',
        pinned: info.pinned === true,
        pendingApproval: needsInput,
        focused,
        focusedAt: focused ? Number(focus.focusedAt) || 0 : 0,
        exempt: exempt || !!info.meetingId,
      };
    });
  }

  function softCapSweep() {
    const state = read();
    if (!state.on || !sessionManager || typeof sessionManager.suspendSession !== 'function') {
      return { ok: true, skipped: true, requested: [] };
    }
    const items = collectItems();
    const t = now();
    const plan = policy.pickSoftCapVictims(items, { keepAlive: state.keepAlive, now: t });
    const excludeSessionIds = getProtectedSessionIds() || new Set();
    const requested = [];
    for (const item of plan.victims) {
      // 真休眠再走一遍现有资格闸门（运行中、审批、置顶、群聊、后台任务）。
      const result = sessionManager.suspendSession(item.sessionId, {
        now: t, minIdleMs: policy.SOFT_CAP_MIN_IDLE_MS, requireSettledCodeAgent: true,
        excludePinned: true, excludeMeeting: true, excludeFocused: false, excludeSessionIds,
        reason: policy.SOFT_CAP_REASON,
      });
      if (result && result.ok) requested.push({ sessionId: item.sessionId, title: item.title, purpose: item.purpose });
    }
    if (requested.length) {
      logger?.log?.(`[low-overhead] keepAlive=${state.keepAlive}: suspended ${requested.length} session(s): ${requested.map(r => String(r.sessionId).slice(0, 8)).join(',')}`);
      try { onSoftCapSuspend?.({ requested, keepAlive: state.keepAlive }); } catch { /* 提示失败不影响休眠 */ }
    }
    return { ok: true, requested, plan };
  }

  // ── L7 EcoQoS ───────────────────────────────────────────────────────
  // 只在低开销模式开启时工作：和 L1 共用同一个 60 秒巡检；关闭时一次都不调（不起 broker、不改任何优先级）。
  function qos() { try { const q = getJobQos(); return q && q.ecoAvailable?.() ? q : null; } catch { return null; } }
  function hostOf(sessionId) { return sessionManager?.sessions?.get?.(sessionId)?.pty?.host || null; }
  function jobKeyOf(sessionId) { return typeof sessionManager?.ptyJobKey === 'function' ? sessionManager.ptyJobKey(sessionId) : ''; }
  function collectEcoItems(t) {
    if (!sessionManager?.sessions) return [];
    const focus = typeof sessionManager.getFocusedSessionState === 'function'
      ? sessionManager.getFocusedSessionState() : { id: sessionManager.focusedSessionId || null };
    const items = [];
    for (const [sessionId, entry] of sessionManager.sessions) {
      const info = entry?.info || {};
      let exempt = false, needsInput = false;
      try { exempt = isExemptSession(sessionId, info) === true || !!info.meetingId; } catch { exempt = true; }
      try { needsInput = sessionNeedsUserInput(info) === true; } catch { needsInput = true; }
      // 卡片（serve）会话没有终端输出（lastOutputAt 常为 0）：答完时刻、最后一条消息时刻、回合结束时刻都算活动，
      // 否则长回合刚答完 1 秒就会被当成「空闲很久」。
      const lastActivityAt = Math.max(Number(entry?.startedAt) || 0, Number(entry?.lastInputAt) || 0, Number(entry?.lastOutputAt) || 0,
        Number(info.lastCompletedAt) || 0, Number(info.lastMessageTime) || 0, Number(entry?.agentTurnFinishedAt) || 0);
      // 会话自己报告还有后台任务 / 后台活动在跑：不降速。
      const background = !!(info.nativeRuntime?.backgroundTasks?.length || info.nativeRuntime?.backgroundActivities?.length);
      items.push({
        sessionId, jobKey: jobKeyOf(sessionId), host: entry?.pty?.host || null, status: info.status || '',
        settled: entry?.agentTurnActive !== true, pendingApproval: needsInput,
        focused: !!focus?.id && focus.id === sessionId, exempt: exempt || background,
        lastActivityAt, idleMs: lastActivityAt > 0 ? Math.max(0, t - lastActivityAt) : NaN,
      });
    }
    return items;
  }
  function ecoSweep() {
    const state = read();
    const q = qos();
    if (!state.on || !q) return { ok: true, skipped: true, on: [], off: [] };
    const t = now();
    const items = collectEcoItems(t);
    const plan = policy.pickEcoQosTargets(items, { now: t });
    const targetIds = new Set(plan.targets.map(item => item.sessionId));
    const on = [], off = [];
    for (const item of items) {
      if (!item.jobKey) continue;
      // 目标每轮都下发（状态没变时 setJobEco 自己短路、不起 broker；上次没落实的会重试）。
      if (targetIds.has(item.sessionId)) { if (!q.isEco(item.jobKey)) on.push(item.jobKey); void q.setJobEco(item.jobKey, true); }
      else if (q.wake(item.jobKey)) off.push(item.jobKey);
    }
    let hosts = [];
    try { hosts = listServeHosts() || []; } catch { hosts = []; }
    for (const h of hosts) {
      if (!h.jobKey) continue;
      const sessionIds = items.filter(item => item.host && item.host === h.host).map(item => item.sessionId);
      if (policy.ecoQosServeTarget({ ...h, sessionIds }, targetIds, { now: t })) { if (!q.isEco(h.jobKey)) on.push(h.jobKey); void q.setJobEco(h.jobKey, true); }
      else if (q.wake(h.jobKey)) off.push(h.jobKey);
    }
    let info = null;
    // 搜索服务可能晚于开关建好：每轮补挂一次请求钩子（同一个函数，重复挂无副作用）。
    try { const svc = getSearchService(); svc?.setRequestHook?.(wakeSearch); info = svc?.ecoInfo?.() || null; } catch { info = null; }
    if (policy.ecoQosSearchTarget(info, { now: t })) {
      if (!q.pidEcoOn(SEARCH_ECO_KEY)) on.push(SEARCH_ECO_KEY);
      void q.setPidEco(SEARCH_ECO_KEY, info.pid, { expectedStartMs: info.startedAt, maxStartMs: info.startedAt + 2000, enabled: true, priority: false });
    } else if (q.wakePid(SEARCH_ECO_KEY)) off.push(SEARCH_ECO_KEY);
    return { ok: true, on, off, plan };
  }
  // 即时唤醒：切到会话、向它输入（session-manager 同步调用）、它转忙碌或待审批（session-updated）。
  // 先同步把根进程抬回正常优先级，再异步清整盒 EcoQoS；它用的共享 serve 一并唤醒。
  function wakeSession(sessionId) {
    const q = qos();
    if (!q || !sessionId) return false;
    let woke = false;
    const key = jobKeyOf(sessionId);
    if (key && q.wake(key)) woke = true;
    const host = hostOf(sessionId);
    if (host && host.jobKey && q.wake(host.jobKey)) woke = true;
    return woke;
  }
  function wakeServe(configDir) {
    const q = qos();
    if (!q) return false;
    let hosts = [];
    try { hosts = listServeHosts() || []; } catch { hosts = []; }
    const key = require('../core/codeagent-serve-host').hostKey(configDir);
    return hosts.filter(h => h.key === key && h.jobKey).some(h => q.wake(h.jobKey));
  }
  function wakeSearch() { const q = qos(); return !!q && q.wakePid(SEARCH_ECO_KEY); }
  function restoreAllEco() {
    let q = null;
    try { q = getJobQos(); } catch { q = null; }
    return q && typeof q.restoreAllEco === 'function' ? q.restoreAllEco() : 0;
  }
  const BUSY = new Set(['running', 'waiting', 'starting', 'busy']);
  function onSessionUpdated(info) {
    if (!info || !info.id) return;
    const q = qos();
    if (!q) return;
    const key = jobKeyOf(info.id);
    const host = hostOf(info.id);
    if (!(key && q.isEco(key)) && !(host && host.jobKey && q.isEco(host.jobKey))) return;
    let needsInput = false;
    try { needsInput = sessionNeedsUserInput(info) === true; } catch { needsInput = false; }
    if (BUSY.has(String(info.status || '')) || needsInput) wakeSession(info.id);
  }
  // CodeAgent 终端开工时 info.status 常仍是 idle，只有 agent-turn-started：直接唤醒。
  function onTurnStarted(event) { if (event && event.sessionId) wakeSession(event.sessionId); }
  let ecoHooked = false;
  function syncEcoHooks(state) {
    const want = state.on && !!qos();
    if (want && !ecoHooked) {
      ecoHooked = true;
      sessionManager?.setEcoWake?.(wakeSession);
      sessionManager?.on?.('session-updated', onSessionUpdated);
      sessionManager?.on?.('codex-session-updated', onSessionUpdated); // 卡片（serve / ACP）会话转忙碌、待审批走这个事件
      sessionManager?.on?.('agent-turn-started', onTurnStarted);
      try { getSearchService()?.setRequestHook?.(wakeSearch); } catch { /* 搜索服务还没起 */ }
    } else if (!want && ecoHooked) {
      ecoHooked = false;
      sessionManager?.setEcoWake?.(null);
      sessionManager?.removeListener?.('session-updated', onSessionUpdated);
      sessionManager?.removeListener?.('codex-session-updated', onSessionUpdated);
      sessionManager?.removeListener?.('agent-turn-started', onTurnStarted);
      try { getSearchService()?.setRequestHook?.(null); } catch { /* 同上 */ }
    }
    if (!state.on) restoreAllEco();
  }

  let capTimer = null;
  function syncCapTimer(state) {
    if (state.on && !capTimer) {
      capTimer = setIntervalFn(() => {
        try { softCapSweep(); } catch (error) { logger?.warn?.('[low-overhead] soft cap sweep failed:', error?.message || error); }
        try { ecoSweep(); } catch (error) { logger?.warn?.('[low-overhead] eco sweep failed:', error?.message || error); }
      }, policy.SOFT_CAP_CHECK_MS);
      capTimer?.unref?.();
    } else if (!state.on && capTimer) {
      clearIntervalFn(capTimer);
      capTimer = null;
    }
  }

  // ── 把当前状态落到各模块 ──────────────────────────────────────────
  // 关闭且从没开过时（老用户默认路径）不碰任何模块，保证正常模式零变化。
  let appliedOnce = false;
  function apply(state) {
    if (!state.on && !appliedOnce) return false;
    appliedOnce = true;
    try { stateStore?.setSaveMinInterval?.(policy.stateSaveMinIntervalMs(state)); } catch (error) { logger?.warn?.('[low-overhead] L6 state save:', error?.message); }
    try { getSearchService()?.setIdleExitMs?.(policy.searchIdleExitMs(state)); } catch (error) { logger?.warn?.('[low-overhead] L4 search idle:', error?.message); }
    try { getPetController()?.refreshLowOverhead?.(); } catch (error) { logger?.warn?.('[low-overhead] L3 pet:', error?.message); }
    return true;
  }

  // 真值变了（模式切换或保活数改了）之后调：落到各模块、挂/摘巡检；刚开启或调小保活数时立即巡检一次。
  let last = null;
  let started = false;
  function sync({ sweep = true } = {}) {
    const state = read();
    const before = last;
    last = state;
    apply(state);
    syncCapTimer(state);
    if (state.on || ecoHooked) syncEcoHooks(state);
    if (sweep && started && state.on && (!before || !before.on || state.keepAlive < before.keepAlive)) {
      try { softCapSweep(); } catch (error) { logger?.warn?.('[low-overhead] soft cap sweep failed:', error?.message || error); }
    }
    return state;
  }

  // 建窗前调用（main.js）：按持久化状态落到各模块。启动时不立即巡检——会话还在恢复，等第一轮定时巡检。
  function start() {
    const state = sync({ sweep: false });
    started = true;
    return state;
  }

  function stop() {
    if (capTimer) { clearIntervalFn(capTimer); capTimer = null; }
    if (ecoHooked) syncEcoHooks({ on: false });
    started = false;
  }

  return {
    start, stop, get, sync, apply, softCapSweep, collectItems,
    ecoSweep, wakeSession, wakeServe, wakeSearch, restoreAllEco,
    isEnabled: () => read().on === true,
    isCapTimerRunning: () => !!capTimer,
  };
}

module.exports = { createLowOverheadController };
