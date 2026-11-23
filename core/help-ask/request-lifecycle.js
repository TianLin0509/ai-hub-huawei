'use strict';
// 单次问答的退出保障：计时只在请求期间存在，不启动常驻进程。
const { execFile } = require('node:child_process');

function cancelled(message = '已取消，可以继续问下一题') {
  return Object.assign(new Error(message), { cancelled: true });
}

// 先让底层响应取消并收尾；底层连 Promise 都不结束时，也不能永久占住队列。
function withDeadline(run, { signal, timeoutMs, idleMs = 0, cleanupMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let done = false, stopped = null, idleTimer, totalTimer, cleanupTimer;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer); clearTimeout(totalTimer); clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', onAbort);
      if (stopped && error?.answer) Object.assign(stopped, { answer: error.answer, truncated: error.truncated });
      error || stopped ? reject(stopped || error) : resolve(value);
    };
    const stop = error => {
      if (done || stopped) return;
      stopped = error;
      // 先登记兜底，避免同步 abort 监听器收尾后又留下计时器。
      cleanupTimer = setTimeout(() => finish(stopped), cleanupMs);
      controller.abort(error);
    };
    const onAbort = () => stop(signal.reason instanceof Error ? signal.reason : cancelled());
    const activity = () => {
      if (done || stopped || !idleMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop(Object.assign(new Error(`连续 ${Math.round(idleMs / 1000)} 秒无新输出，已停止这次提问`),
        { timedOut: true, timeoutKind: 'idle' })), idleMs);
    };
    if (signal?.aborted) { finish(signal.reason instanceof Error ? signal.reason : cancelled()); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs) totalTimer = setTimeout(() => stop(Object.assign(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒没答完，已停止这次提问`),
      { timedOut: true, timeoutKind: 'total' })), timeoutMs);
    activity();
    try { Promise.resolve(run({ signal: controller.signal, onActivity: activity })).then(value => finish(null, value), error => finish(error)); }
    catch (error) { finish(error); }
  });
}

function killProcessTree(child, platform = process.platform) {
  if (!child?.pid) return Promise.resolve();
  if (platform !== 'win32') {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    return Promise.resolve();
  }
  return new Promise(resolve => {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, error => {
      if (error) { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
      resolve();
    });
  });
}

// Windows 的 close 可能被继承管道的后代拖住。取消时以进程树终止命令完成为准，不再死等 close。
function waitForProcess(child, { signal, onActivity = () => {}, kill = () => killProcessTree(child) } = {}) {
  return new Promise((resolve, reject) => {
    let done = false, stopping = false;
    const finish = (error, code) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      child.stdout?.removeListener('data', onActivity);
      child.stderr?.removeListener('data', onActivity);
      child.removeListener('close', onClose);
      error ? reject(error) : resolve(code);
    };
    const onAbort = () => {
      if (done || stopping) return;
      stopping = true;
      const reason = signal.reason instanceof Error ? signal.reason : cancelled();
      Promise.resolve().then(kill).then(() => finish(reason), error => finish(error));
    };
    const onClose = code => { if (!stopping) finish(null, code); };
    child.on('close', onClose);
    child.on('error', error => { if (!stopping) finish(error); });
    child.stdout?.on('data', onActivity);
    child.stderr?.on('data', onActivity);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

module.exports = { withDeadline, waitForProcess, killProcessTree, cancelled };
