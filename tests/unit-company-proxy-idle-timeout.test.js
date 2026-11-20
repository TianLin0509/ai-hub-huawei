'use strict';
// 反代超时按空闲计（2026-11-20 一键反馈 v5.6.65）：Codex 一轮长回答在第 900 秒（15 分钟总时限）被掐断，
// 日志：最后一块在回头后 +755.9 s，request_aborted 正好距发出 900.03 s。
// 这里用小阈值模拟：持续出数据的流超过 timeoutMs 不断；停止出数据超过 timeoutMs 要断；超过绝对上限要断。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'core', 'company-proxy', 'transport.mjs')).href);
const key = 'idle-timeout-test-key-0123456789';
const frame = text => `data: ${JSON.stringify({ id: 'c', model: 'm', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
const done = `data: ${JSON.stringify({ id: 'c', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

// 上游：每 everyMs 吐一块，共 count 块；stallAfter 块之后不再吐（也不结束）。
function upstream({ everyMs, count, stallAfter = Infinity }) {
  return async (_body, { signal } = {}) => {
    const enc = new TextEncoder();
    let timer, i = 0;
    const stream = new ReadableStream({
      start(c) {
        const tick = () => {
          if (i >= stallAfter) return;
          if (i >= count) { c.enqueue(enc.encode(done)); c.close(); return; }
          c.enqueue(enc.encode(frame('part' + i))); i += 1;
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

async function run(options, up) {
  const { createProxy } = await load();
  const events = [];
  const proxy = createProxy({ provider: { listModels: async () => [], complete: up }, accessKey: key, onEvent: e => events.push(e), ...options });
  const { port } = await proxy.listen(0);
  const started = Date.now();
  try {
    const text = await new Promise((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('client guard timeout')), 10000);
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }, res => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => { clearTimeout(guard); resolve(body); });
        res.on('error', () => { clearTimeout(guard); resolve(body); });
      });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    });
    return { text, events, ms: Date.now() - started };
  } finally { await proxy.close(); }
}

test('a stream that keeps flowing past timeoutMs is not cut off', { timeout: 20000 }, async () => {
  // 30 块 × 40 ms ≈ 1.2 s，远超 300 ms 的空闲阈值；旧的总时限会在 300 ms 掐断
  const { text, events } = await run({ timeoutMs: 300 }, upstream({ everyMs: 40, count: 30 }));
  assert.match(text, /part29/);
  assert.match(text, /\[DONE\]/);
  assert.doesNotMatch(text, /超时/);
  assert.deepEqual(events.map(e => e.type).filter(t => t !== 'request_started'), ['request_finished']);
});

test('a stream that goes silent for timeoutMs is ended with the timeout frame', { timeout: 20000 }, async () => {
  const { text, events, ms } = await run({ timeoutMs: 300 }, upstream({ everyMs: 40, count: 30, stallAfter: 5 }));
  assert.match(text, /part4/);
  assert.doesNotMatch(text, /part5/);
  assert.match(text, /超时/);
  assert.ok(ms < 3000, 'ends soon after going silent: ' + ms);
  assert.ok(events.some(e => e.type === 'request_aborted'));
});

test('the absolute cap still ends a stream that never stops', { timeout: 20000 }, async () => {
  const { text, ms } = await run({ timeoutMs: 300, maxDurationMs: 700 }, upstream({ everyMs: 40, count: 1000 }));
  assert.match(text, /超时/);
  assert.ok(ms >= 650 && ms < 3000, 'cut at the cap: ' + ms);
});

test('maxDurationMs below timeoutMs is rejected', async () => {
  const { createProxy } = await load();
  assert.throws(() => createProxy({ provider: { listModels: async () => [], complete: async () => null }, accessKey: key, timeoutMs: 1000, maxDurationMs: 500 }), /maxDurationMs/);
});
