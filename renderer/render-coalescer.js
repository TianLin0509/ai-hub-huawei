'use strict';

function createRenderCoalescer(render, options = {}) {
  if (typeof render !== 'function') throw new TypeError('render must be a function');
  const delayMs = Math.max(0, Number(options.delayMs) || 0);
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  // 打字优先（2026-11-25）：deferWhile() 为真（用户正在打字）时先不重绘，等停手再画；
  // 一直在打也最多推迟 maxDeferMs，侧栏不会长时间不动。
  const deferWhile = typeof options.deferWhile === 'function' ? options.deferWhile : null;
  const maxDeferMs = Math.max(0, Number(options.maxDeferMs) || 0);
  const now = options.now || (() => Date.now());
  let timer = null;
  let requests = 0;
  let renders = 0;
  let deferred = 0;
  let firstRequestAt = 0;

  function run() {
    timer = null;
    if (deferWhile && maxDeferMs > 0 && now() - firstRequestAt < maxDeferMs) {
      let busy = false;
      try { busy = !!deferWhile(); } catch {}
      if (busy) { deferred += 1; timer = setTimer(run, delayMs); return; }
    }
    renders += 1;
    render();
  }

  function schedule() {
    requests += 1;
    if (timer !== null) return;
    firstRequestAt = now();
    timer = setTimer(run, delayMs);
  }

  function flush() {
    if (timer === null) return false;
    clearTimer(timer);
    timer = null;
    renders += 1;
    render();
    return true;
  }

  function cancel() {
    if (timer === null) return false;
    clearTimer(timer);
    timer = null;
    return true;
  }

  function stats() {
    return deferWhile ? { requests, renders, pending: timer !== null, delayMs, deferred } : { requests, renders, pending: timer !== null, delayMs };
  }

  return { schedule, flush, cancel, stats };
}

module.exports = { createRenderCoalescer };
