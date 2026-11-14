'use strict';

// Observe at spawn/connection readiness, before shutdown can recycle the PID.
// node-pty 1.2 connects asynchronously on Windows, so spawn can return pid=0.
const owners = new WeakMap();
const pending = new WeakMap();
function recordPtySpawn(pty, onReady) {
  if (!pty || owners.has(pty) || pending.has(pty)) return pty;
  let dataSubscription, exitSubscription, finished = false;
  const cleanup = () => {
    dataSubscription?.dispose();
    exitSubscription?.dispose();
    pty.removeListener?.('ready_datapipe', observe);
    pending.delete(pty);
  };
  const observe = () => {
    if (finished) return;
    const pid = Number(pty.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    finished = true;
    const owner = Object.freeze({ pty, pid, observedAt: Date.now() });
    owners.set(pty, owner);
    cleanup();
    onReady?.(owner);
  };
  observe();
  if (!finished) {
    pending.set(pty, true);
    // node-pty updates pid before this native connection event, even if the
    // child has not written output. The public data event is a fallback.
    pty.on?.('ready_datapipe', observe);
    if (typeof pty.onData === 'function') dataSubscription = pty.onData(observe);
    if (typeof pty.onExit === 'function') exitSubscription = pty.onExit(() => { finished = true; cleanup(); });
  }
  return pty;
}
function ptyProcessOwner(pty) {
  return owners.get(pty?.isCliProvider ? pty.pty : pty);
}
module.exports = { recordPtySpawn, ptyProcessOwner };
