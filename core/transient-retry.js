'use strict';
// 偶发错误先自动重试一次（5.5.24，产品负责人拍板）：网络抖一下、文件被杀软/同步盘占用一瞬间、服务器回 502/503，
// 用户看到的是「莫名报错」，其实隔一秒再试就好了。这里判断「一闪而过」的错误，等 0.8–2 秒再试一次，第二次仍失败才往上抛。
//
// 只能用在读取/查询类调用上（查版本清单、拉组件目录、读反代状态……）：重试会让同一个请求发两次，
// 发消息、提交提问、写文件、下单这类非幂等操作一律不要套这个。每个调用点在注释里写明为什么可以安全重试。
//
// 非偶发错误（404、401/403、参数错、找不到程序、用户取消）立即抛出，不重试、不多等。

// 系统层的偶发错误码：连接超时/被重置/被拒、DNS 临时失败、文件被占用（Windows 上杀软或同步盘短暂锁文件时报 EBUSY/EPERM）。
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'EBUSY', 'EPERM',
  // Node 内置 fetch（undici）的同类错误
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  // WeLink 状态一时认不出（调用方自己标的码）
  'WELINK_STATUS_UNKNOWN',
]);
// Electron net.fetch（Chromium 网络栈）的报错写在 message 里，形如 net::ERR_CONNECTION_RESET。
const TRANSIENT_NET = /\b(?:net::)?ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|CONNECTION_ABORTED|CONNECTION_TIMED_OUT|TIMED_OUT|NETWORK_CHANGED|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR|NETWORK_IO_SUSPENDED)\b/;
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
const STATUS_IN_TEXT = /\bHTTP\s*(\d{3})\b/i;

function statusOf(error) {
  for (const value of [error?.status, error?.statusCode, error?.response?.status]) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 100 && n < 600) return n;
  }
  const m = STATUS_IN_TEXT.exec(String(error?.reason || error?.message || ''));
  return m ? Number(m[1]) : null;
}

// 是不是「一闪而过」的错误。错误链（fetch 的 cause）也看一层。
function isTransient(error) {
  if (!error || typeof error !== 'object') return false;
  // 用户取消、调用方主动中止：不是偶发错误
  if (error.name === 'AbortError' || error.cancelled === true || error.transient === false) return false;
  if (error.transient === true) return true;
  const status = statusOf(error);
  if (status != null) return TRANSIENT_STATUS.has(status);
  if (error.name === 'TimeoutError') return true;
  if (TRANSIENT_CODES.has(error.code) || TRANSIENT_CODES.has(error.errno)) return true;
  if (TRANSIENT_NET.test(String(error.message || ''))) return true;
  const cause = error.cause;
  if (cause && cause !== error && typeof cause === 'object') {
    if (cause.name === 'AbortError') return false;
    return TRANSIENT_CODES.has(cause.code) || TRANSIENT_NET.test(String(cause.message || '')) || cause.name === 'TimeoutError';
  }
  return false;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
  const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('已取消'), { name: 'AbortError' })); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

// 等多久：0.8–2 秒之间随机，几处同时失败时不会挤在同一刻再撞一次。
function pickDelay(min = 800, max = 2000, random = Math.random) {
  return Math.round(min + (max - min) * Math.min(1, Math.max(0, random())));
}

// 跑 fn；遇到偶发错误等一下再跑一次。第二次仍失败就抛第二次的错误（原样，不包装），并标上 retried。
// budgetMs：从第一次开始算的总时长上限；第一次已经用掉太多时间、等完再试会超过上限，就不重试，直接抛。
async function retryOnce(fn, {
  label = '', budgetMs = 30000, minDelayMs = 800, maxDelayMs = 2000, signal = null,
  isTransient: classify = isTransient, now = Date.now, wait = sleep, random = Math.random, onRetry = null,
} = {}) {
  const startedAt = now();
  try {
    return await fn(1);
  } catch (error) {
    if (signal?.aborted || !classify(error)) throw error;
    const delay = pickDelay(minDelayMs, maxDelayMs, random);
    if (now() - startedAt + delay >= budgetMs) throw error;
    try { onRetry?.({ label, error, delay }); } catch { /* 只是日志 */ }
    try { await wait(delay, signal); } catch { throw error; }
    try {
      return await fn(2);
    } catch (second) {
      try { if (second && typeof second === 'object') second.retried = true; } catch { /* 冻结的对象 */ }
      throw second;
    }
  }
}

module.exports = { isTransient, retryOnce, pickDelay, statusOf, TRANSIENT_CODES, TRANSIENT_STATUS };
