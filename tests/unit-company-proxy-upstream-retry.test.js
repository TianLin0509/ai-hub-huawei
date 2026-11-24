'use strict';
// 公司上游短暂失败在反代层自动重试（2026-11-24 同事反馈：DSH 走 CodeAgent 模型执行任务容易报错，本地代理正常）。
// 根因：Hub 给 DSH 的公司模型路线把 DSH 自带重试关成 0 次，反代也不重试，公司上游偶发一次连不上、5xx、首帧前断流就直接变成一轮报错。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'core', 'company-proxy', 'upstream-retry.mjs')).href);
const enc = new TextEncoder();
const okFrames = 'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const sse = (parts, { failAfter = -1 } = {}) => new Response(new ReadableStream({
  start(c) {
    parts.forEach((p, i) => { if (i === failAfter) return; c.enqueue(enc.encode(p)); });
    if (failAfter >= 0) c.error(Object.assign(new Error('terminated'), { cause: { code: 'ECONNRESET' } }));
    else c.close();
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const failure = code => Object.assign(new Error(code), { code });
const noSleep = async () => {};

function scripted(answers) {
  let i = 0;
  const call = async () => { const a = answers[Math.min(i++, answers.length - 1)]; if (a instanceof Error) throw a; return typeof a === 'function' ? a() : a; };
  return { call, count: () => i };
}

test('连不上公司上游（L1_REQUEST_FAILED）后自动重试，第二次成功，客户端拿到完整回答', async () => {
  const { completeWithRetry } = await load();
  const retries = [];
  const s = scripted([failure('L1_REQUEST_FAILED'), () => sse([okFrames])]);
  const res = await completeWithRetry(s.call, { sleep: noSleep, onRetry: r => retries.push(r) });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), okFrames);
  assert.equal(s.count(), 2);
  assert.deepEqual(retries.map(r => r.reason), ['L1_REQUEST_FAILED']);
});

test('上游 502/503 重试；最多重试 2 次，仍失败就把最后一次的 HTTP 错误原样交回（由上层讲成人话）', async () => {
  const { completeWithRetry } = await load();
  const bad = status => new Response('{"error":{"message":"busy"}}', { status });
  const s = scripted([bad(502), bad(503), bad(502), () => sse([okFrames])]);
  const res = await completeWithRetry(s.call, { sleep: noSleep });
  assert.equal(res.status, 502);
  assert.equal(s.count(), 3);
});

test('首帧前断流或空流（200 但没有任何 data 帧）重试；首帧之后的内容原样续上', async () => {
  const { completeWithRetry } = await load();
  const s = scripted([() => sse([': keepalive\n\n'], { failAfter: 1 }), () => sse([]), () => sse(['data: {"choices":[{"index":0,"delta":{"reasoning_content":"a"}}]}\n', '\n' + okFrames])]);
  const reasons = [];
  const res = await completeWithRetry(s.call, { sleep: noSleep, onRetry: r => reasons.push(r.reason) });
  assert.deepEqual(reasons, ['STREAM_BROKEN_BEFORE_FIRST_FRAME', 'EMPTY_STREAM']);
  const text = await res.text();
  assert.ok(text.startsWith('data: {"choices":[{"index":0,"delta":{"reasoning_content":"a"}}]}\n\ndata: {"choices"'));
  assert.ok(text.endsWith('data: [DONE]\n\n'));
});

test('确定性错误不重试：请求格式被拒（422）、登录过期、4xx、用户取消', async () => {
  const { completeWithRetry } = await load();
  for (const code of ['L1_TOOL_CALL_INVALID', 'COMPANY_LOGIN_NEEDED', 'COMPANY_PINNED_RATE_LIMITED', 'L1_ABORTED']) {
    const s = scripted([failure(code), () => sse([okFrames])]);
    await assert.rejects(completeWithRetry(s.call, { sleep: noSleep }), e => e.code === code);
    assert.equal(s.count(), 1, code);
  }
  for (const status of [400, 401, 403, 413, 422, 429]) {
    const s = scripted([new Response('{}', { status }), () => sse([okFrames])]);
    const res = await completeWithRetry(s.call, { sleep: noSleep });
    assert.equal(res.status, status);
    assert.equal(s.count(), 1, String(status));
  }
});

test('首帧就是上游错误帧：原样交给客户端，不重试（多半是确定性的，重试也一样）', async () => {
  const { completeWithRetry } = await load();
  const errorFrame = 'data: {"error":{"message":"context too long"}}\n\n';
  const s = scripted([() => sse([errorFrame]), () => sse([okFrames])]);
  const res = await completeWithRetry(s.call, { sleep: noSleep });
  assert.equal(await res.text(), errorFrame);
  assert.equal(s.count(), 1);
});

test('退避等待期间用户取消：立刻停下，不再发新请求', async () => {
  const { completeWithRetry } = await load();
  const controller = new AbortController();
  const s = scripted([failure('COMPANY_GENERATION_REQUEST_FAILED'), () => sse([okFrames])]);
  const pending = completeWithRetry(s.call, { signal: controller.signal, delaysMs: [5000, 5000] });
  setTimeout(() => controller.abort(new Error('Client disconnected')), 20);
  await assert.rejects(pending, /Client disconnected/);
  assert.equal(s.count(), 1);
});

// DSH（pi-ai）的错误分类只认英文关键词（@deepseek-ai/dsh-llm-pi-ai src/stream.ts classifyPiAiError 的同款规则）：
// connection/network/socket → TRANSPORT，timeout → TIMEOUT，都在 DSH 默认可重试的范围里；认不出的是 PI_AI_ERROR，不重试。
const dshClassify = message => /\btime(?:d)?\s*out\b|timeout/i.test(message) ? 'TIMEOUT'
  : /\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|\bterminated\b|premature close/i.test(message) ? 'TRANSPORT' : 'PI_AI_ERROR';

// 完整照抄（状态码规则在前）：@deepseek-ai/dsh-llm-pi-ai 0.2.2-rc.5 src/stream.ts classifyPiAiError。额度那条只认英文，这里省掉。
const dshClassifyFull = message => {
  const statusSource = /^[45]\d\d\b/.exec(message)?.[0] ?? message;
  if (/\b(?:401|403)\b/.test(statusSource)) return 'AUTH';
  if (/\b429\b/.test(statusSource) || /rate.?limit/i.test(message)) return 'RATE_LIMIT';
  if (/\b413\b/.test(statusSource) || /payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST';
  if (/\b400\b/.test(statusSource) || /invalid.?request/i.test(message)) return 'INVALID_REQUEST';
  if (/\b5\d\d\b/.test(statusSource)) return 'SERVER';
  return dshClassify(message);
};

test('中途断流 / 超时的 DSH 错误帧带英文标记，DSH 自带重试能认出来；工具调用不完整这类不带标记', async () => {
  const { midStreamMessage, midStreamRetryTag, errorFrameFor } = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'company-proxy', 'failure-text.mjs')).href);
  const frameMessage = (error, opts) => JSON.parse(errorFrameFor('/v1/chat/completions', midStreamMessage(error, opts), { retryTag: midStreamRetryTag(error, opts) }).slice(5)).error.message;
  const reset = frameMessage(new Error('terminated'));
  assert.match(reset, /^公司模型的回复中途失败：和公司上游的连接中途断开/);
  assert.equal(dshClassify(reset), 'TRANSPORT');
  assert.equal(dshClassify(frameMessage(new Error('Upstream SSE ended before [DONE]'))), 'TRANSPORT');
  assert.equal(dshClassify(frameMessage(null, { timedOut: true })), 'TIMEOUT');
  assert.equal(dshClassify(frameMessage(new Error('Invalid JSON in upstream frame'))), 'PI_AI_ERROR');
  // 以前的错误帧（没有标记）DSH 认不出，直接结束这一轮。
  assert.equal(dshClassify(midStreamMessage(new Error('terminated'))), 'PI_AI_ERROR');
  // Claude Code / Codex 的错误事件不变。
  assert.ok(!errorFrameFor('/v1/messages', 'x', { retryTag: 'connection interrupted' }).includes('['));
  assert.ok(!errorFrameFor('/v1/responses', 'x', { retryTag: 'connection interrupted' }).includes('['));
});

test('DSH 自带重试只在终端模式打开（最多 2 次）；卡片模式和网关路线保持 0 次', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const proxy = require('../core/company-model-proxy');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-dsh-route-'));
  try {
    proxy.ensureEndpoint(dataDir, { preferredPort: 18999 });
    const policy = opts => proxy.dshRoute({ dataDir, sessionId: 's1', model: '', ...opts }).providerConfig.retryPolicy;
    assert.deepEqual(policy({ midStreamRetry: true }), { mode: 'normal', maxRetries: 2 });
    // 卡片模式：ACP 桥按「轮次 + 步骤」给文字编号，重试时编号不变，两次的半截文字会拼在一起。
    assert.deepEqual(policy({}), { mode: 'normal', maxRetries: 0 });
    // 网关：网关自己有长首包等待和重试，不再叠一层。
    assert.deepEqual(policy({ midStreamRetry: true, gateway: true }), { mode: 'normal', maxRetries: 0 });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('Hub 起 DSH 时：终端模式带 midStreamRetry，卡片试点不带', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'core', 'acp-profiles.js'), 'utf8');
  assert.match(src, /midStreamRetry: !!\(opts\.dshCliRuntime && !opts\.dshCardAcp\)/);
});

test('首帧超时：连着但一直不来字节就放弃这次、自动重试；收到保活字节会重新计时', async () => {
  const { completeWithRetry } = await load();
  const signals = [];
  const hang = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const answers = [signal => { signals.push(signal); return hang(signal); }, () => sse([okFrames])];
  let i = 0;
  const reasons = [];
  const res = await completeWithRetry(signal => answers[i++](signal), { sleep: noSleep, firstFrameTimeoutMs: 40, onRetry: r => reasons.push(r.reason) });
  assert.equal(await res.text(), okFrames);
  assert.deepEqual(reasons, ['FIRST_FRAME_TIMEOUT']);
  // 超时的那次请求被中止，底层连接立刻放掉。
  assert.equal(signals[0].aborted, true);

  // 排队保活：每 20ms 来一行注释，总共 100ms 后才出第一帧；首帧超时 40ms 也不误杀。
  const slow = () => new Response(new ReadableStream({
    async start(c) {
      for (let k = 0; k < 5; k++) { c.enqueue(enc.encode(': queued\n\n')); await new Promise(r => setTimeout(r, 20)); }
      c.enqueue(enc.encode(okFrames)); c.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const kept = [];
  const res2 = await completeWithRetry(slow, { sleep: noSleep, firstFrameTimeoutMs: 40, onRetry: r => kept.push(r.reason) });
  assert.ok((await res2.text()).endsWith('data: [DONE]\n\n'));
  assert.deepEqual(kept, []);
});

test('重试用完仍是首帧前失败（断流、空流、首帧超时）：抛固定错误码，不把坏流交给客户端', async () => {
  const { completeWithRetry } = await load();
  const broken = () => sse([': x\n\n'], { failAfter: 1 });
  await assert.rejects(completeWithRetry(broken, { sleep: noSleep }), e => e.code === 'COMPANY_STREAM_BROKEN_BEFORE_FIRST_FRAME');
  await assert.rejects(completeWithRetry(() => sse([]), { sleep: noSleep }), e => e.code === 'COMPANY_EMPTY_STREAM');
  const hang = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await assert.rejects(completeWithRetry(hang, { sleep: noSleep, firstFrameTimeoutMs: 20 }), e => e.code === 'COMPANY_FIRST_FRAME_TIMEOUT');
  const { preStreamMessage } = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'company-proxy', 'failure-text.mjs')).href);
  assert.match(preStreamMessage({ code: 'COMPANY_FIRST_FRAME_TIMEOUT' }), /等公司模型开始回答/);
  assert.match(preStreamMessage({ code: 'COMPANY_EMPTY_STREAM' }), /接收公司模型的回答/);
});

test('首帧到了之后用户取消：取消照样传到这次请求（交出回答后不摘掉监听）', async () => {
  const { completeWithRetry } = await load();
  const controller = new AbortController();
  let seen;
  const res = await completeWithRetry(signal => { seen = signal; return sse(['data: {"choices":[]}\n\n']); }, { signal: controller.signal, sleep: noSleep });
  assert.equal(seen.aborted, false);
  controller.abort(new Error('Client disconnected'));
  assert.equal(seen.aborted, true);
  await res.body.cancel().catch(() => {});
});

// 起一个 transport（真实 HTTP），provider 按脚本回答；返回 { status, headers, text }。
async function throughTransport(provider, { noClientRetry, pathname = '/v1/chat/completions' } = {}) {
  const { createProxy } = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'company-proxy', 'transport.mjs')).href);
  const key = 'k'.repeat(24);
  const proxy = createProxy({ provider: { listModels: async () => ['m'], complete: provider }, accessKey: key, timeoutMs: 5000, ...(noClientRetry ? { noClientRetry } : {}) });
  const { port } = await proxy.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } finally { await proxy.close(); }
}

test('出字前失败交给 DSH：429 / 5xx 换成 DSH 不再重试的 400，人话不变，原状态码在响应头里；其他请求不变', async () => {
  const own = status => async () => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: '公司模型的号都被暂停了' } }),
    { status, headers: { 'content-type': 'application/json', 'x-company-proxy-own': '1' } });
  const dsh = () => true;
  for (const status of [503, 429]) {
    const r = await throughTransport(own(status), { noClientRetry: dsh });
    assert.equal(r.status, 400, String(status));
    assert.equal(r.headers.get('x-company-proxy-status'), String(status));
    assert.match(JSON.parse(r.text).error.message, /号都被暂停/);
  }
  // 上游 HTTP 502（反代已重试过）、provider 抛错（连不上，已重试过）：同样换成 400。
  const up502 = await throughTransport(async () => new Response('{"error":{"message":"busy"}}', { status: 502 }), { noClientRetry: dsh });
  assert.equal(up502.status, 400);
  assert.match(JSON.parse(up502.text).error.message, /公司模型上游返回 HTTP 502/);
  const thrown = await throughTransport(async () => { throw Object.assign(new Error('x'), { code: 'L1_REQUEST_FAILED' }); }, { noClientRetry: dsh });
  assert.equal(thrown.status, 400);
  assert.equal(thrown.headers.get('x-company-proxy-status'), '502');
  // 401（登录过期）本来就不重试，保持原样，Hub 照旧提示重新登录。
  const login = await throughTransport(own(401), { noClientRetry: dsh });
  assert.equal(login.status, 401);
  // 没打开（网关、Claude Code、Codex）：状态码不变。
  assert.equal((await throughTransport(own(503))).status, 503);
});

test('上游在流里发了错误帧再关流：原样交给客户端，反代不再追加第二条、也不标成可重试', async () => {
  const errorFrame = 'data: {"error":{"message":"context too long"}}\n\n';
  const r = await throughTransport(async () => sse([errorFrame]));
  assert.equal(r.status, 200);
  assert.equal(r.text, errorFrame);
  // 出了几个字后错误帧、随后连接被重置：也只有上游那一条。
  const partial = 'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n';
  // 逐块交出、交完稍等再重置连接（立刻出错会把还没读走的块一起丢掉，不像真实连接）。
  const thenReset = parts => new Response(new ReadableStream({
    async pull(c) {
      if (parts.length) { c.enqueue(enc.encode(parts.shift())); return; }
      await new Promise(r => setTimeout(r, 30));
      c.error(Object.assign(new Error('terminated'), { cause: { code: 'ECONNRESET' } }));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const r2 = await throughTransport(async () => thenReset([partial, errorFrame]));
  assert.equal(r2.text, partial + errorFrame);
  // 对照：真的中途断开（没有上游错误帧）仍然追加带标记的错误帧，DSH 终端模式会重跑这一步。
  const r3 = await throughTransport(async () => thenReset([partial]));
  assert.ok(r3.text.startsWith(partial));
  assert.match(r3.text, /\[connection interrupted\]"/);
});

test('DSH 的错误分类（照 dsh-llm-pi-ai classifyPiAiError）：换成 400 的出字前失败一律不重试，哪怕人话里带 TIMEOUT 或 HTTP 502', async () => {
  const { preStreamMessage, upstreamHttpMessage } = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'company-proxy', 'failure-text.mjs')).href);
  // OpenAI SDK 给 HTTP 错误的消息是「<状态码> <error.message>」。
  const retried = code => ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'].includes(code);
  for (const message of [preStreamMessage({ code: 'COMPANY_IDENTITY_TIMEOUT' }), preStreamMessage({ code: 'COMPANY_FIRST_FRAME_TIMEOUT' }),
    upstreamHttpMessage(502, 'connection reset'), upstreamHttpMessage(429), '公司模型的所有账号都在限流冷却中，请稍后再试']) {
    assert.equal(retried(dshClassifyFull(`400 ${message}`)), false, message);
  }
  // 对照：以前原样回 502 / 429，DSH 会再重试。
  assert.equal(dshClassifyFull(`502 ${upstreamHttpMessage(502)}`), 'SERVER');
  assert.equal(dshClassifyFull(`429 ${upstreamHttpMessage(429)}`), 'RATE_LIMIT');
});

test('DSH 终端模式一轮失败：上报的事件带上真实原因，Hub 不再显示「Codex turn failed」', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { DshCliSession } = require('../core/dsh-cli-session');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-dsh-fail-'));
  try {
    const s = new DshCliSession({ id: 'h1', kind: 'deepseek-acp', home });
    s.seen = new Set();
    const events = [];
    s.on('lifecycle', e => events.push(e));
    s.event({ seq: 1, type: 'turn/start', time: 1, data: { turn: 1 } });
    s.event({ seq: 2, type: 'user/message', time: 2, data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } });
    s.event({ seq: 3, type: 'turn/end', time: 3, data: { turn: 1, reason: { kind: 'error', error: { message: '400: 公司模型上游返回 HTTP 502' } } } });
    const failed = events.find(e => e.type === 'turn-error');
    assert.equal(failed.message, '公司模型上游返回 HTTP 502');  // 去掉协议外壳的状态码，只留人话（core/dsh-turn-outcome.js）
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  // 主进程和界面的兜底文案不再写死 Codex；没有 message 时也读 reason。
  const main = require('node:fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /'Codex turn failed'/);
  assert.match(main, /message: ev\.message \|\| ev\.reason/);
});
