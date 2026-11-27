// 2026-11-27 网关原生 Anthropic 直通：网关目录声明支持 anthropic 接口的模型（黄区实测只有 glm-5.3-flash），
// Claude 会话的请求原样发到网关 /v1/messages（能命中网关提示缓存），回包原样交回；其余模型、Codex / DSH 照旧转 chat。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { main, gatewayFromEnv } from '../core/company-proxy/server.mjs';

const require = createRequire(import.meta.url);
const GOOD_KEY = 'sk-test-gateway-key';
const gwFlaky = { hit: 0 };
const MODELS = ['deepseek-v4.1-flash', 'glm-5.3-flash'];

function sse(res, frames, named = false) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write((named && f.type ? `event: ${f.type}\n` : '') + 'data: ' + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n');
  res.end();
}
async function startGateway() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.headers.authorization !== 'Bearer ' + GOOD_KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Invalid token","type":"new_api_error"}}'); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push({ path: req.url, version: req.headers['anthropic-version'], body });
    if (req.url === '/v1/messages') {
      if (body.model === 'html-page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>login</html>'); }
      if (body.model === 'crlf-model') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const fr = [{ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 7, cache_read_input_tokens: 50 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'CRLF' } },
          { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
        for (const f of fr) res.write(`event: ${f.type}\r\ndata: ${JSON.stringify(f)}\r\n\r\n`);
        return res.end('data: [DONE]\r\n\r\n');
      }
      if (body.model === 'quota-out') { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"token quota is not enough","type":"new_api_error"}}'); }
      return sse(res, [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一下' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'NATIVE' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' }], true);
    }
    if (body.model === 'flaky' && gwFlaky.hit < 2) { gwFlaky.hit++; res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"openai_error","type":"bad_response_status_code"}}'); }
    if (body.model === 'gone') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":{"code":"model_not_found","message":"No available channel for model gone","type":"new_api_error"}}'); }
    const id = 'c1';
    sse(res, [
      { id, model: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: 'CHAT' } }] },
      { id, model: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id, model: 'x', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }, '[DONE]']);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, seen, origin: `http://127.0.0.1:${server.address().port}` };
}
async function startProxy(t, gatewayOrigin, extraEnv = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gw-native-'));
  const key = 'b'.repeat(48);
  const env = { AI_HUB_COMPANY_PROXY_KEY: key, AI_HUB_API_GATEWAY_URL: gatewayOrigin + '/v1', AI_HUB_API_GATEWAY_KEY: GOOD_KEY,
    AI_HUB_API_GATEWAY_MODELS: [...MODELS, 'quota-out', 'html-page', 'crlf-model', 'flaky', 'gone'].join(','), AI_HUB_API_GATEWAY_MODEL: 'deepseek-v4.1-flash',
    AI_HUB_API_GATEWAY_NATIVE: 'glm-5.3-flash,quota-out,html-page,crlf-model', ...extraEnv };
  const running = main(['--data-dir', dataDir, '--port', '0', '--mock-upstream'], { env });
  const stateFile = join(dataDir, 'company-model-proxy', 'proxy-state.json');
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) { try { port = JSON.parse(await readFile(stateFile, 'utf8')).port; } catch { await new Promise(r => setTimeout(r, 50)); } }
  assert.ok(port, 'proxy listening');
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await fetch(origin + '/admin/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + key } }).catch(() => {});
    await running.catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });
  return { origin, key };
}
const claudeAsk = (p, tag, body) => fetch(p.origin + '/v1/messages', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': `${p.key}.${tag}__gw`, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
const TOOLS = [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];

test('环境变量：直通名单按模型名解析，坏名字丢掉', () => {
  const g = gatewayFromEnv({ AI_HUB_API_GATEWAY_URL: 'http://gw/v1', AI_HUB_API_GATEWAY_KEY: 'k', AI_HUB_API_GATEWAY_MODELS: MODELS.join(','),
    AI_HUB_API_GATEWAY_NATIVE: 'glm-5.3-flash, bad name ,' });
  assert.deepEqual(g.nativeMessages, ['glm-5.3-flash']);
  assert.deepEqual(gatewayFromEnv({ AI_HUB_API_GATEWAY_URL: 'http://gw/v1', AI_HUB_API_GATEWAY_KEY: 'k' }).nativeMessages, []);
});

test('真实反代：名单里的模型，Claude 请求原样直通 /v1/messages，思考块与缓存用量原样回到客户端', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin);
  const req = { model: 'glm-5.3-flash', max_tokens: 64000, stream: true, thinking: { type: 'enabled', budget_tokens: 2000 },
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }], tools: TOOLS, messages: [{ role: 'user', content: 'hi' }] };
  const res = await claudeAsk(p, 's1', req);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"cache_read_input_tokens":900/);
  assert.match(text, /thinking_delta/);
  assert.match(text, /NATIVE/);
  const sent = gw.seen.at(-1);
  assert.equal(sent.path, '/v1/messages');
  assert.equal(sent.version, '2023-06-01');
  assert.deepEqual(sent.body.thinking, req.thinking, '思考参数原样给网关');
  assert.deepEqual(sent.body.system, req.system, 'cache_control 原样保留');
  assert.deepEqual(sent.body.tools, TOOLS, '工具保持 Anthropic 格式');
  assert.equal(sent.body.max_tokens, 32768, '输出上限按反代统一上限截');
});

test('真实反代：不在名单的模型、Codex / DSH 入口照旧转 chat；Claude 后台 haiku 名落到默认模型也转 chat', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin);
  const ds = await claudeAsk(p, 's2', { model: 'deepseek-v4.1-flash', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(ds.status, 200); assert.match(await ds.text(), /CHAT/);
  assert.equal(gw.seen.at(-1).path, '/v1/chat/completions');
  const bg = await claudeAsk(p, 's2', { model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'title' }] });
  assert.equal(bg.status, 200); await bg.text();
  assert.equal(gw.seen.at(-1).path, '/v1/chat/completions');
  const dsh = await fetch(p.origin + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.s3__gw` },
    body: JSON.stringify({ model: 'glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(dsh.status, 200); await dsh.text();
  assert.equal(gw.seen.at(-1).path, '/v1/chat/completions', 'DSH 用 glm 也不直通');
});

test('真实反代：直通的非流式请求（Claude Code 后台调用）收成一条 Message；网关报额度不足给中文白话', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin);
  const one = await claudeAsk(p, 's4', { model: 'glm-5.3-flash', max_tokens: 64, messages: [{ role: 'user', content: 'title' }] });
  assert.equal(one.status, 200);
  const msg = await one.json();
  assert.equal(msg.content.find(b => b.type === 'text')?.text, 'NATIVE');
  assert.equal(gw.seen.at(-1).path, '/v1/messages');
  const out = await claudeAsk(p, 's4', { model: 'quota-out', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(out.status >= 400 && out.status < 500);
  assert.match(JSON.stringify(await out.json()), /额度/);
});

test('Hub 侧：直通名单取网关目录里声明 anthropic 接口、且在这把 key 模型表里的模型', async t => {
  const gateway = require('../core/api-gateway.js');
  const catalog = require('../core/api-gateway-catalog.js');
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'gw-native-cat-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  assert.deepEqual(gateway.nativeMessages(dataDir), [], '没目录：空表');
  fs.mkdirSync(join(dataDir, 'api-gateway'), { recursive: true });
  fs.writeFileSync(gateway.file(dataDir), JSON.stringify({ baseURL: 'http://models.example/v1', models: ['deepseek-v4.1-flash', 'glm-5.3-flash'] }));
  catalog.writeCache(dataDir, { origin: 'http://models.example', models: [
    { id: 'deepseek-v4.1-flash', endpoints: ['openai'] }, { id: 'glm-5.3-flash', endpoints: ['openai', 'anthropic'] }, { id: 'other-anthropic', endpoints: ['anthropic'] }] });
  assert.deepEqual(gateway.nativeMessages(dataDir), ['glm-5.3-flash']);
});

test('审查修复：关闭思考在直通里照办；思考预算超过截后的输出上限时夹到一半', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin, { AI_HUB_API_GATEWAY_NO_THINK: 'crlf-model' });
  const r1 = await claudeAsk(p, 'n1', { model: 'glm-5.3-flash', max_tokens: 64000, stream: true, thinking: { type: 'enabled', budget_tokens: 40000 }, messages: [{ role: 'user', content: 'hi' }] });
  await r1.text();
  assert.deepEqual(gw.seen.at(-1).body.thinking, { type: 'enabled', budget_tokens: 16384 });
  const r2 = await claudeAsk(p, 'n1', { model: 'crlf-model', max_tokens: 4000, stream: true, thinking: { type: 'enabled', budget_tokens: 3000 }, messages: [{ role: 'user', content: 'hi' }] });
  await r2.text();
  assert.deepEqual(gw.seen.at(-1).body.thinking, { type: 'enabled', budget_tokens: 1024 }, '网关只认小预算写法关思考');
  const r3 = await claudeAsk(p, 'n1', { model: 'glm-5.3-flash', max_tokens: 512, stream: true, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: 'hi' }] });
  await r3.text();
  assert.equal('thinking' in gw.seen.at(-1).body, false, '输出上限不到 1024 不带思考参数');
});

test('审查修复：非流式收包合并用量、认 \r\n 分帧和 [DONE]；网关 200 回 HTML 不当成功', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin);
  const one = await claudeAsk(p, 'u1', { model: 'glm-5.3-flash', max_tokens: 64, messages: [{ role: 'user', content: 'title' }] });
  const msg = await one.json();
  assert.equal(msg.usage.input_tokens, 5); assert.equal(msg.usage.cache_read_input_tokens, 900); assert.equal(msg.usage.output_tokens, 3);
  const crlf = await (await claudeAsk(p, 'u1', { model: 'crlf-model', max_tokens: 64, messages: [{ role: 'user', content: 'x' }] })).json();
  assert.equal(crlf.content.find(b => b.type === 'text')?.text, 'CRLF');
  assert.equal(crlf.usage.cache_read_input_tokens, 50); assert.equal(crlf.usage.output_tokens, 2);
  const html = await claudeAsk(p, 'u1', { model: 'html-page', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.ok(html.status >= 500, 'HTML 回包按上游协议错误处理，状态 ' + html.status);
  await html.text();
});

test('网关偶发 500：反代自动重试一次，客户端拿到正常回答；模型不存在（503 model_not_found）不重试', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin);
  gwFlaky.hit = 0;
  const ask = model => fetch(p.origin + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.r1__gw` },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const before = gw.seen.length;
  const ok = await ask('flaky');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /CHAT/);
  assert.equal(gw.seen.length - before, 3, '连续两次 500 之后第三次成功');
  const mid = gw.seen.length;
  const gone = await ask('gone');
  assert.equal(gone.status, 400);
  await gone.text();
  assert.equal(gw.seen.length - mid, 1, '模型不存在不重试');
});
