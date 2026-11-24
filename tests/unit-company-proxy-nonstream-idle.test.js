'use strict';
// 非流式 Claude 路径的时限按空闲计（2026-11-21）：以前 server.mjs 里是 15 分钟总时限（setTimeout → abort），
// 上游一直在出数据的长回答也会被掐断。流式路径已在 transport.mjs 改为空闲计时，这里同样处理。
// 用小阈值模拟：持续出数据超过 timeoutMs 不断；停止出数据超过 timeoutMs 要断；超过绝对上限要断。
const test = require('node:test');
const assert = require('node:assert/strict');
const { holdEventLoop } = require('./helpers/hold-event-loop');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const dir = path.join(__dirname, '..', 'core', 'company-proxy');
const load = name => import(pathToFileURL(path.join(dir, name)).href);
const frame = text => `data: ${JSON.stringify({ id: 'c', model: 'GLM-5.2-WX', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
const done = `data: ${JSON.stringify({ id: 'c', model: 'GLM-5.2-WX', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

// 上游（OpenAI chat 流）：每 everyMs 吐一块，共 count 块；stallAfter 块之后不再吐也不结束。
function upstream({ everyMs, count, stallAfter = Infinity }) {
  return async (_body, { signal } = {}) => {
    const enc = new TextEncoder();
    let timer, i = 0;
    const stream = new ReadableStream({
      start(c) {
        const tick = () => {
          if (i >= stallAfter) return;
          if (i >= count) { c.enqueue(enc.encode(done)); c.close(); return; }
          c.enqueue(enc.encode(frame('p' + i + ' '))); i += 1;
          timer = setTimeout(tick, everyMs);
        };
        tick();
        signal?.addEventListener('abort', () => { clearTimeout(timer); try { c.error(new DOMException('aborted', 'AbortError')); } catch {} }, { once: true });
      },
      cancel() { clearTimeout(timer); },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

async function run({ timeoutMs, maxDurationMs }, complete) {
  const { idleDeadline, completeNonStreamingMessage } = await load('server.mjs');
  const { createClaudeAdapter } = await load('adapters.mjs');
  const adapter = createClaudeAdapter({ defaultModel: 'GLM-5.2-WX' });
  const body = { model: 'GLM-5.2-WX', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] };
  const original = { ...body };
  const converted = adapter.convertRequest(body);
  const deadline = idleDeadline({ timeoutMs, maxDurationMs });
  const started = Date.now();
  try {
    const result = await completeNonStreamingMessage({ complete, adapter, converted, original, deadline });
    return { result, ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  } finally { deadline.clear(); }
}

test('non-streaming: an upstream that keeps flowing past timeoutMs is collected in full', { timeout: 20000 }, async () => {
  // 30 块 × 40 ms ≈ 1.2 s，远超 300 ms 阈值；旧的总时限会在 300 ms 掐断
  const { result, error } = await run({ timeoutMs: 300 }, upstream({ everyMs: 40, count: 30 }));
  assert.equal(error, undefined, String(error?.message));
  const textBlock = result.message.content.find(b => b.type === 'text');
  assert.match(textBlock.text, /p29/);
  assert.equal(result.message.stop_reason, 'end_turn');
});

test('non-streaming: an upstream that goes silent for timeoutMs is aborted', { timeout: 20000 }, async t => {
  holdEventLoop(t);
  const { result, error, ms } = await run({ timeoutMs: 300 }, upstream({ everyMs: 40, count: 30, stallAfter: 5 }));
  assert.ok(error, 'must fail, not return a partial message: ' + JSON.stringify(result?.message?.content));
  assert.ok(ms < 3000, 'ends soon after going silent: ' + ms);
});

test('non-streaming: the absolute cap still ends an upstream that never stops', { timeout: 20000 }, async t => {
  holdEventLoop(t);
  const { result, error, ms } = await run({ timeoutMs: 300, maxDurationMs: 700 }, upstream({ everyMs: 40, count: 1000 }));
  assert.ok(error, 'must fail, not return a partial message');
  assert.ok(ms >= 650 && ms < 3000, 'cut at the cap: ' + ms);
});

test('non-streaming: upstream error status is handed back unchanged', async () => {
  const { result } = await run({ timeoutMs: 300 }, async () => new Response('{"error":"x"}', { status: 429, headers: { 'content-type': 'application/json' } }));
  assert.equal(result.passthrough.status, 429);
});

test('idleDeadline rejects a cap below timeoutMs', async () => {
  const { idleDeadline } = await load('server.mjs');
  assert.throws(() => idleDeadline({ timeoutMs: 1000, maxDurationMs: 500 }), /maxDurationMs/);
});

test('the /v1/messages non-streaming handler uses the idle deadline, not a fixed total timer', () => {
  const src = fs.readFileSync(path.join(dir, 'server.mjs'), 'utf8');
  assert.match(src, /completeNonStreamingMessage\(\{ complete: \(b, o\) => gated\.complete\(b, o\)/);
  assert.doesNotMatch(src, /setTimeout\(\(\) => controller\.abort\(\), opts\.timeoutMs\)/);
});
