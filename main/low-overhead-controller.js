'use strict';
// 低开销模式主进程控制器（2026-11-23 P1 v2）：把主干「低开销模式」总开关落到会话与运行期六项节能（L1–L6），并负责 L1 软上限巡检。
// 开关与保活数的唯一真值在 core/optional-features.js（getMode 读它）；本控制器不自己存配置、不注册 IPC，
// main.js 的 low-overhead:set 切完模式后调 sync() 让这里跟上。策略本身都在 core/low-overhead-policy.js。

const policy = require('../core/low-overhead-policy');
const { sessionNeedsUserInput } = require('../core/session-attention-state');

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

  let capTimer = null;
  function syncCapTimer(state) {
    if (state.on && !capTimer) {
      capTimer = setIntervalFn(() => {
        try { softCapSweep(); } catch (error) { logger?.warn?.('[low-overhead] soft cap sweep failed:', error?.message || error); }
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
    started = false;
  }

  return {
    start, stop, get, sync, apply, softCapSweep, collectItems,
    isEnabled: () => read().on === true,
    isCapTimerRunning: () => !!capTimer,
  };
}

module.exports = { createLowOverheadController };
