'use strict';
// 额度低频自动读取（2026-11-05 用户定）：每 15 分钟把各号读一遍，串行，读完即关（core/codeagent-serve.js 的临时 serve）。
// 一个临时 serve 约占 0.5 GB，所以可用内存不够时跳过这一轮。上一轮没读完不开下一轮。
const os = require('os');

const QUOTA_AUTO_INTERVAL_MS = 15 * 60 * 1000;
const QUOTA_AUTO_FIRST_DELAY_MS = 90 * 1000;
const QUOTA_AUTO_MIN_FREE_BYTES = 1024 * 1024 * 1024;

function createQuotaAutoRefresh({ run, intervalMs = QUOTA_AUTO_INTERVAL_MS, firstDelayMs = QUOTA_AUTO_FIRST_DELAY_MS,
  minFreeBytes = QUOTA_AUTO_MIN_FREE_BYTES, freeBytes = () => os.freemem(), now = Date.now, log = () => {},
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (typeof run !== 'function') throw new Error('额度自动读取缺少 run');
  let timer = null, stopped = true, running = null;

  async function tick() {
    const free = freeBytes();
    if (free < minFreeBytes) { log({ event: 'quota-auto', skipped: 'low-memory', freeMb: Math.round(free / 1048576) }); return; }
    const started = now();
    try {
      const result = await run();
      log({ event: 'quota-auto', ms: now() - started, ...result });
    } catch (error) {
      log({ event: 'quota-auto', ms: now() - started, error: error?.message || String(error) });
    }
  }
  function schedule(delay) {
    if (stopped) return;
    timer = setTimeoutFn(() => {
      timer = null;
      running = tick().finally(() => { running = null; schedule(intervalMs); });
    }, delay);
    timer?.unref?.();
  }
  return {
    start() { if (!stopped) return; stopped = false; schedule(firstDelayMs); },
    stop() { stopped = true; if (timer) clearTimeoutFn(timer); timer = null; },
    whenIdle: () => running || Promise.resolve(),
  };
}

// 退出清理挂在 will-quit：before-quit 会先被拦下做会话收尾，收尾失败时窗口恢复、Hub 继续跑；
// 如果那时就停了读取，之后手动刷新和读模型都会一直失败到重启。will-quit 只在真的要退出时才来。
function installQuotaQuitCleanup({ app, stopAutoRefresh = () => {}, shutdownServes }) {
  app?.on?.('will-quit', () => { stopAutoRefresh(); shutdownServes(); });
}

module.exports = { createQuotaAutoRefresh, installQuotaQuitCleanup, QUOTA_AUTO_INTERVAL_MS, QUOTA_AUTO_FIRST_DELAY_MS, QUOTA_AUTO_MIN_FREE_BYTES };
