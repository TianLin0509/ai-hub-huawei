// 公司上游的短暂失败在反代这一层自动重试（2026-11-24，同事反馈「DSH 走 CodeAgent 模型执行任务容易报错，自己本地代理正常」）。
// 同事本地用的 CodeAgent 适配器挂在 DSH 自带的重试上（限流、5xx、超时、连接断开最多重试 5 次）；Hub 给 DSH、Codex 的
// 公司模型路线把客户端重试关成了 0 次，反代自己又「不重放」，于是公司上游偶发的一次 502、连接重置、空流都直接变成一轮报错。
//
// 只在还没有任何字节交给客户端之前重试，客户端看不到：
//   - 调用公司上游时网络不通、连接被重置、身份校验服务一时没回（固定错误码，见 RETRY_CODES）；
//   - 上游回 500/502/503/504；
//   - 上游回 200，但第一帧数据到来之前流就断了、一帧都没有（空回答），或者长时间一个字节都不来（首帧超时）。
// 不重试：登录过期、没有模型权限、请求格式不被接受（4xx）、限流（号池路由已经在换号）、用户自己取消。
// 第一帧正常数据到了就原样交出，之后的中途失败照旧由 transport.mjs 写一条人话错误帧。
// 重试用完仍是首帧前的失败（断流、空流、首帧超时）：抛带固定错误码的错误，由上层讲成人话，不再交给客户端一个会被当成「中途断开」的流。

export const RETRY_STATUSES = new Set([500, 502, 503, 504]);
export const RETRY_CODES = new Set(['L1_REQUEST_FAILED', 'L1_PROVIDER_FAILED', 'L1_IDENTITY_FAILED', 'COMPANY_GENERATION_REQUEST_FAILED',
  'COMPANY_IDENTITY_TIMEOUT', 'COMPANY_IDENTITY_REQUEST_FAILED', 'COMPANY_IDENTITY_HTTP_FAILED', 'COMPANY_IDENTITY_BODY_INVALID', 'COMPANY_IDENTITY_JSON_INVALID']);
export const DEFAULT_DELAYS_MS = Object.freeze([600, 2000]);
// 单次尝试在首帧之前最多这么久一个字节都没收到，就放弃这次、换下一次（审查 P2-3）。收到任何字节（包括排队保活的注释行）都重新计时，
// 所以排队中的长等待不会被误杀；只掐「连接还在、但什么都不来」的假死。
export const FIRST_FRAME_TIMEOUT_MS = 120000;
// 首帧前最多攒这么多字节（上游排队时可能先发注释行保活）；超过就当作已经开始回答，原样交出。
const MAX_PEEK_BYTES = 256 * 1024;
// 重试用完后首帧前失败的固定错误码（failure-text.mjs 按它讲是哪一步）。
const FINAL_CODES = { STREAM_BROKEN_BEFORE_FIRST_FRAME: 'COMPANY_STREAM_BROKEN_BEFORE_FIRST_FRAME', EMPTY_STREAM: 'COMPANY_EMPTY_STREAM',
  FIRST_FRAME_TIMEOUT: 'COMPANY_FIRST_FRAME_TIMEOUT' };

const coded = code => Object.assign(new Error(code), { code });
const TIMED_OUT = Symbol('first-frame-timeout');

// 首帧计时：arm() 开始或重新计时；到点 fire 一次。
function firstFrameTimer(ms) {
  let timer = null, fire = () => {};
  const fired = new Promise(resolve => { fire = resolve; });
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => fire(TIMED_OUT), ms); timer.unref?.(); };
  const clear = () => clearTimeout(timer);
  return { fired, arm, clear };
}

// 读到第一帧 data 为止。-> { ok: true, response }（带着已读的字节原样续上）或 { ok: false, reason }（可重试）。
export async function peekFirstFrame(response, { signal, timer = null } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const held = [];
  let text = '', bytes = 0;
  const rest = () => new Response(new ReadableStream({
    start(controller) { for (const chunk of held) controller.enqueue(chunk); },
    async pull(controller) {
      try { const { value, done } = await reader.read(); if (done) controller.close(); else controller.enqueue(value); }
      catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason).catch(() => {}); },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
  for (;;) {
    let step;
    try { step = await (timer ? Promise.race([reader.read(), timer.fired]) : reader.read()); }
    catch (error) {
      if (signal?.aborted) throw error;
      return { ok: false, reason: 'STREAM_BROKEN_BEFORE_FIRST_FRAME' };
    }
    if (step === TIMED_OUT) { reader.cancel().catch(() => {}); return { ok: false, reason: 'FIRST_FRAME_TIMEOUT' }; }
    if (step.done) {
      // 一帧 data 都没有就结束：空回答。
      return /^data:/m.test(text) ? { ok: true, response: rest() } : { ok: false, reason: 'EMPTY_STREAM' };
    }
    timer?.arm();
    held.push(step.value); bytes += step.value.byteLength;
    text += decoder.decode(step.value, { stream: true });
    // 有一行完整的 data 帧就算开始回答（错误帧也原样交出：多半是确定性的，重试也一样）。
    if (/^data:[^\n]*\n/m.test(text) || bytes > MAX_PEEK_BYTES) return { ok: true, response: rest() };
  }
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

// 一次尝试：call(attemptSignal) 拿到回答并读到首帧。-> { response } | { error } | { reason }（首帧前可重试的失败）。
// attemptSignal 跟着用户取消；首帧超时时也会中止，让底层请求立刻放掉连接。首帧到了之后计时停止，attemptSignal 不再变。
async function attemptOnce(call, { signal, firstFrameTimeoutMs }) {
  const attempt = new AbortController();
  const onParentAbort = () => attempt.abort(signal.reason);
  if (signal?.aborted) attempt.abort(signal.reason); else signal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = firstFrameTimeoutMs > 0 ? firstFrameTimer(firstFrameTimeoutMs) : null;
  timer?.arm();
  // 交出去的回答还在读：用户取消要继续传到这次请求，所以那时不摘掉监听。
  let handedOff = false;
  const timeout = () => { attempt.abort(coded(FINAL_CODES.FIRST_FRAME_TIMEOUT)); return { reason: 'FIRST_FRAME_TIMEOUT' }; };
  try {
    let response;
    const pending = Promise.resolve().then(() => call(attempt.signal));
    try {
      response = await (timer ? Promise.race([pending, timer.fired]) : pending);
    } catch (error) { return { error }; }
    if (response === TIMED_OUT) {
      // 迟到的回答放掉，不占连接。
      pending.then(late => late?.body?.cancel?.().catch(() => {}), () => {});
      return timeout();
    }
    // 不是 SSE 的成功回答不在这里判断，原样交给 transport（它会讲「上游没按流式回答」）。
    const sse = String(response.headers?.get?.('content-type') || '').toLowerCase().startsWith('text/event-stream');
    if (!response.ok || !response.body || !sse) { handedOff = true; return { response }; }
    const peeked = await peekFirstFrame(response, { signal, timer });
    if (peeked.ok) { handedOff = true; return { response: peeked.response }; }
    if (peeked.reason === 'FIRST_FRAME_TIMEOUT') return timeout();
    return { reason: peeked.reason };
  } finally {
    timer?.clear();
    if (!handedOff) signal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * call(attemptSignal) -> fetch Response（公司上游的 SSE），失败时抛带 code 的错误。短暂失败按 delaysMs 退避后重试，
 * 最多重试 delaysMs.length 次；onRetry({ attempt, reason, delayMs }) 记日志用。
 * 用完重试仍失败：最后一次的 HTTP 错误回答原样交回，或抛最后一次的错误（首帧前断流 / 空流 / 首帧超时抛固定错误码），
 * 由上层照旧讲成人话。
 */
export async function completeWithRetry(call, { signal, delaysMs = DEFAULT_DELAYS_MS, sleep = wait, onRetry = () => {},
  firstFrameTimeoutMs = FIRST_FRAME_TIMEOUT_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= delaysMs.length;
    const result = await attemptOnce(call, { signal, firstFrameTimeoutMs });
    if (signal?.aborted) {
      await result.response?.body?.cancel().catch(() => {});
      throw signal.reason || coded('ROUTER_ABORTED');
    }
    let reason = result.reason || '';
    if (result.error) {
      const code = typeof result.error?.code === 'string' ? result.error.code : '';
      if (last || !RETRY_CODES.has(code)) throw result.error;
      reason = code;
    } else if (result.response) {
      const { response } = result;
      if (!RETRY_STATUSES.has(response.status) || last) return response;
      reason = `HTTP ${response.status}`;
      await response.body?.cancel().catch(() => {});
    } else if (last) throw coded(FINAL_CODES[reason] || 'COMPANY_STREAM_BROKEN_BEFORE_FIRST_FRAME');
    const delayMs = delaysMs[attempt];
    try { onRetry({ attempt: attempt + 1, reason, delayMs }); } catch { /* log only */ }
    await sleep(delayMs, signal);
  }
}
