'use strict';

// Stop hook 是一轮结束的权威信号。若这一轮最后一条没有正文（工具收尾、只有 thinking），
// transcript-tap 只发 turn-pending，主进程的"回合进行中"标记就不会清。
// Stop 之后同一回合仍停在 pending、期间没有新的回合开始，就按已结束处理。
const SETTLE_DELAY_MS = 30_000;

function createStopPendingSettle({ manager, getTurnSeq, delayMs = SETTLE_DELAY_MS, setTimer = setTimeout,
  clearTimer = clearTimeout, now = () => Date.now() }) {
  const timers = new Map();
  function cancel(sessionId) {
    const timer = timers.get(sessionId);
    if (timer) { clearTimer(timer); timers.delete(sessionId); }
  }
  function onPending(event) {
    if (!event || event.signalSource !== 'stop_hook' || !event.hubSessionId) return false;
    const sessionId = event.hubSessionId;
    if (!manager.isAgentTurnActive(sessionId)) return false;
    cancel(sessionId);
    const seq = getTurnSeq(sessionId);
    const timer = setTimer(() => {
      timers.delete(sessionId);
      if (!manager.isAgentTurnActive(sessionId) || getTurnSeq(sessionId) !== seq) return;
      manager.noteAgentTurnFinished(sessionId, { completedAt: now(), message: 'stop-hook-settled' });
    }, delayMs);
    timer?.unref?.();
    timers.set(sessionId, timer);
    return true;
  }
  return { onPending, cancel, _timers: timers };
}

module.exports = { createStopPendingSettle, SETTLE_DELAY_MS };
