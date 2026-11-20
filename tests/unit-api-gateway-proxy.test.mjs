// 2026-11-19 API 网关（部门 API key 用户）：反代把带 "__gw" 标记的会话转给 OpenAI 兼容网关。
// 用本机模拟网关复现 11-19 黄区实测到的形态：思考字段叫 reasoning、回包模型名是简称、坏 key 401、
// 不存在的模型 503 model_not_found、首包前长时间排队。Claude / Codex / DSH 三种入口都走一遍真实反代进程逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, parseTag, gatewayFromEnv, gatewayModel } from '../core/company-proxy/server.mjs';
import { normalizeChunk, explainGatewayError, gatewayBody, createGatewayProvider } from '../core/company-proxy/gateway-provider.mjs';

const GOOD_KEY = 'sk-test-gateway-key';
const MODELS = ['qwen-aw-35b', 'deepseek-v4.1-flash', 'glm-5.3-flash'];

test('会话标识：__gw 标记网关会话，不影响原有 __pin_ 解析', () => {
  assert.deepEqual(parseTag('abc__gw'), { sessionTag: 'abc', pin: '', gateway: true });
  assert.deepEqual(parseTag('abc__pin_personal'), { sessionTag: 'abc', pin: 'personal' });
  assert.deepEqual(parseTag('abc'), { sessionTag: 'abc', pin: '' });
  assert.equal(parseTag('__gw').gateway, undefined, '只有标记、没有会话标识时按普通会话处理');
  assert.equal(parseTag('bad tag__gw'), null);
});

test('网关模型名：表里有原样用，Claude 后台的 haiku 名落到默认模型', () => {
  const g = gatewayFromEnv({ AI_HUB_API_GATEWAY_URL: 'http://gw.example/v1/', AI_HUB_API_GATEWAY_KEY: 'k', AI_HUB_API_GATEWAY_MODELS: MODELS.join(','), AI_HUB_API_GATEWAY_MODEL: 'deepseek-v4.1-flash' });
  assert.equal(g.baseURL, 'http://gw.example/v1');
  assert.equal(gatewayModel(g, 'glm-5.3-flash'), 'glm-5.3-flash');
  assert.equal(gatewayModel(g, 'claude-haiku-4-5'), 'deepseek-v4.1-flash');
  assert.equal(gatewayModel(g, ''), 'deepseek-v4.1-flash');
  assert.equal(gatewayFromEnv({ AI_HUB_API_GATEWAY_URL: 'http://gw.example/v1' }), null, '没有 key 就不算配置好');
});

test('回包归一化：reasoning 改名 reasoning_content，模型名回写成请求名', () => {
  const chunk = normalizeChunk({ model: 'dsv41', choices: [{ delta: { reasoning: '想' } }, { message: { reasoning: '整段', content: 'OK' } }] }, 'deepseek-v4.1-flash');
  assert.equal(chunk.model, 'deepseek-v4.1-flash');
  assert.deepEqual(chunk.choices[0].delta, { reasoning_content: '想' });
  assert.deepEqual(chunk.choices[1].message, { reasoning_content: '整段', content: 'OK' });
  const body = gatewayBody({ model: 'm', messages: [], thinking: { type: 'enabled' }, reasoning_effort: 'high', stream: false });
  assert.equal('thinking' in body, false); assert.equal('reasoning_effort' in body, false);
  assert.equal(body.stream, true); assert.deepEqual(body.stream_options, { include_usage: true });
});

test('网关错误白话：坏 key 401、模型不存在改成 400（不让客户端白重试）、限流 429', () => {
  assert.equal(explainGatewayError(401, '{"error":{"message":"Invalid token"}}').status, 401);
  const missing = explainGatewayError(503, '{"error":{"code":"model_not_found","message":"No available channel"}}');
  assert.equal(missing.status, 400); assert.match(missing.message, /没有这个模型|不对你的分组开放/);
  assert.equal(explainGatewayError(429, '').status, 429);
  assert.equal(explainGatewayError(500, 'x').status, 500);
});

// ---------- 模拟网关 + 真实反代 ----------
function sse(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write('data: ' + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n');
  res.end();
}
async function startGateway() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const auth = req.headers.authorization;
    if (auth !== 'Bearer ' + GOOD_KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"code":"","message":"Invalid token","type":"new_api_error"}}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: MODELS.map(id => ({ id })) })); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push(body);
    if (body.model === 'hang-forever') return; // 首包一直不来：测排队超时与自动重试
    if (!MODELS.includes(body.model)) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":{"code":"model_not_found","message":"No available channel for model","type":"new_api_error"}}'); }
    const id = 'chatcmpl-x', alias = 'dsv41';
    const wantsTool = Array.isArray(body.tools) && body.tools.length && body.messages.at(-1)?.role === 'user';
    if (wantsTool) {
      const name = body.tools[0].function.name;
      return sse(res, [
        { id, model: alias, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
        { id, model: alias, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '{"city":' } }] } }] },
        { id, model: alias, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Shanghai"}' } }] } }] },
        { id, model: alias, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { id, model: alias, choices: [], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } }, '[DONE]']);
    }
    sse(res, [
      { id, model: alias, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
      { id, model: alias, choices: [{ index: 0, delta: { reasoning: '用户要 OK' } }] },
      { id, model: alias, choices: [{ index: 0, delta: { content: 'O' } }] },
      { id, model: alias, choices: [{ index: 0, delta: { content: 'K' } }] },
      { id, model: alias, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id, model: alias, choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }, '[DONE]']);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, seen, origin: `http://127.0.0.1:${server.address().port}` };
}
async function startProxy(t, gatewayOrigin, extraEnv = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gw-proxy-'));
  const key = 'a'.repeat(48);
  const env = { AI_HUB_COMPANY_PROXY_KEY: key, AI_HUB_API_GATEWAY_URL: gatewayOrigin + '/v1', AI_HUB_API_GATEWAY_KEY: GOOD_KEY,
    AI_HUB_API_GATEWAY_MODELS: MODELS.join(','), AI_HUB_API_GATEWAY_MODEL: 'deepseek-v4.1-flash', ...extraEnv };
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
const events = text => text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(x => x && x !== '[DONE]').map(x => JSON.parse(x));

test('真实反代：Claude 会话经网关，思考与正文都转成 Anthropic 流，模型名照用户所选', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin);
  const res = await fetch(p.origin + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': `${p.key}.sess1__gw`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', max_tokens: 1024, stream: true, thinking: { type: 'enabled', budget_tokens: 1000 }, messages: [{ role: 'user', content: 'Reply OK' }] }) });
  assert.equal(res.status, 200);
  const ev = events(await res.text());
  const text = ev.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join('');
  const thinking = ev.filter(e => e.delta?.type === 'thinking_delta').map(e => e.delta.thinking).join('');
  assert.equal(text, 'OK'); assert.equal(thinking, '用户要 OK');
  assert.equal(gw.seen[0].model, 'deepseek-v4.1-flash', '网关收到的是用户选的模型，不是公司模型名');
  assert.equal('thinking' in gw.seen[0], false, '公司上游专用的思考开关不发给网关');
  // Claude Code 后台用 haiku 名的调用：落到网关默认模型
  const bg = await fetch(p.origin + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': `${p.key}.sess1__gw` },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'title' }] }) });
  assert.equal(bg.status, 200);
  assert.equal((await bg.json()).content.find(b => b.type === 'text').text, 'OK');
  assert.equal(gw.seen[1].model, 'deepseek-v4.1-flash');
});

test('真实反代：Codex 会话经网关，工具调用转成 Responses 的 function_call，简称模型名不触发校验失败', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin);
  const res = await fetch(p.origin + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.sess2__gw` },
    body: JSON.stringify({ model: 'glm-5.3-flash', stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: '上海天气' }] }],
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }] }) });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /response\.completed/);
  assert.match(body, /get_weather/);
  assert.match(body, /Shanghai/);
  assert.doesNotMatch(body, /model identity/i);
  assert.equal(gw.seen[0].model, 'glm-5.3-flash');
});

test('真实反代：DSH 会话经网关，OpenAI 流原样透传但思考字段已改名', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin);
  const res = await fetch(p.origin + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.sess3__gw` },
    body: JSON.stringify({ model: 'qwen-aw-35b', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(res.status, 200);
  const ev = events(await res.text());
  assert.ok(ev.some(e => e.choices?.[0]?.delta?.reasoning_content === '用户要 OK'));
  assert.ok(ev.every(e => !e.choices?.[0]?.delta || !('reasoning' in e.choices[0].delta)));
  assert.ok(ev.every(e => e.model === 'qwen-aw-35b'));
});

test('真实反代：网关会话用了表外的模型名落到默认模型；同一反代里公司会话仍走公司上游', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin);
  const ask = (model, tag) => fetch(p.origin + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.${tag}` },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const outside = await ask('GLM-5.2-WX', 'e__gw');
  assert.equal(outside.status, 200); await outside.text();
  assert.equal(gw.seen.at(-1).model, 'deepseek-v4.1-flash');
  const before = gw.seen.length;
  const company = await ask('GLM-5.2-WX', 'c1');
  await company.text();
  assert.equal(gw.seen.length, before, '公司会话的请求没有发到网关');
  const status = await (await fetch(p.origin + '/admin/status', { headers: { authorization: 'Bearer ' + p.key } })).json();
  assert.equal(status.gateway.configured, true);
  assert.equal(status.stats.gateway.ok, 1);
});

test('真实反代：模型表为空时名字原样透传——网关说没有这个模型给 400 白话、首包超时自动重试一次后给 504 白话', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin, { AI_HUB_API_GATEWAY_MODELS: '', AI_HUB_API_GATEWAY_HEADER_TIMEOUT_MS: '300' });
  const ask = model => fetch(p.origin + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.x__gw` },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const missing = await ask('no-such-model');
  assert.equal(missing.status, 400);
  assert.match(JSON.stringify(await missing.json()), /没有这个模型|不对你的分组开放/);
  const before = gw.seen.length;
  const hang = await ask('hang-forever');
  assert.equal(hang.status, 504);
  assert.match(JSON.stringify(await hang.json()), /排队太久/);
  assert.equal(gw.seen.length - before, 2, '首包超时后自动重试一次，共发两次');
});

test('真实反代：网关 key 无效给 401 白话，提示去设置里重新粘贴', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin, { AI_HUB_API_GATEWAY_KEY: 'sk-wrong' });
  const res = await fetch(p.origin + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.k__gw` },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(res.status, 401);
  assert.match(JSON.stringify(await res.json()), /重新粘贴 key/);
});

test('真实反代：没配网关时网关会话得到 503 白话，状态接口报 configured=false', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin, { AI_HUB_API_GATEWAY_KEY: '' });
  const res = await fetch(p.origin + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.n__gw` },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(res.status, 503);
  assert.match(JSON.stringify(await res.json()), /还没配置好/);
  const status = await (await fetch(p.origin + '/admin/status', { headers: { authorization: 'Bearer ' + p.key } })).json();
  assert.equal(status.gateway.configured, false);
});

test('首包超时按正文第一块算：网关先回响应头、正文卡住，也会自动重试，重试拿到的回答完整交给下游', async () => {
  let calls = 0;
  const enc = new TextEncoder();
  const fetchImpl = async (_url, { signal }) => {
    calls++;
    const stall = calls === 1;
    return new Response(new ReadableStream({
      start(c) {
        if (stall) { signal.addEventListener('abort', () => c.error(new Error('aborted'))); return; }
        c.enqueue(enc.encode('data: {"model":"dsv41","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n')); c.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const waits = [];
  const provider = createGatewayProvider({ baseURL: 'http://gw.test/v1', apiKey: 'k', fetchImpl, headerTimeoutMs: 40,
    ownError: (status, message) => new Response(message, { status }), onWait: w => waits.push(w.waiting) });
  const response = await provider.complete({ model: 'deepseek-v4.1-flash', messages: [] });
  assert.equal(calls, 2, '第一次正文卡住超时后重试了一次');
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /"content":"hi"/);
  assert.match(text, /"model":"deepseek-v4.1-flash"/);
  assert.deepEqual([waits[0], waits.at(-1)], [true, false]);
});

test('真实反代：换 key 经 /admin/gateway 热更新、不重启反代；清空后网关会话得到 503；在途计数回到 0', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin, { AI_HUB_API_GATEWAY_KEY: 'sk-wrong' });
  const ask = () => fetch(p.origin + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.h__gw` },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const admin = (path, body) => fetch(p.origin + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + p.key, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json());
  assert.equal((await ask()).status, 401);
  const pid = (await admin('/admin/status')).pid;
  const updated = await admin('/admin/gateway', { baseURL: gw.origin + '/v1', apiKey: GOOD_KEY, models: MODELS, model: 'glm-5.3-flash' });
  assert.equal(updated.gateway.defaultModel, 'glm-5.3-flash');
  const ok = await ask();
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /"content":"O"/);
  await admin('/admin/gateway', {});
  assert.equal((await ask()).status, 503);
  const status = await admin('/admin/status');
  assert.equal(status.pid, pid, '同一个反代进程');
  assert.equal(status.gateway.configured, false);
  assert.equal(status.stats.gateway.inFlight, 0);
});

test('真实反代：同一会话两个并发请求，先回的那个不清掉另一个的「排队中」（11-19 黄区实测：Claude Code 主回答 + 后台小请求同时发）', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin, { AI_HUB_API_GATEWAY_MODELS: '', AI_HUB_API_GATEWAY_HEADER_TIMEOUT_MS: '5000' });
  const post = (model, signal) => fetch(p.origin + '/v1/chat/completions', { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.w__gw` },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const abort = new AbortController();
  const slow = post('hang-forever', abort.signal).catch(() => null);
  await new Promise(r => setTimeout(r, 200));
  const fast = await post('deepseek-v4.1-flash');
  await fast.text();
  const status = await (await fetch(p.origin + '/admin/status', { headers: { authorization: 'Bearer ' + p.key } })).json();
  assert.ok(status.gateway.waiting.w, '慢的那个还在排队，状态里仍有这个会话');
  abort.abort();
  await slow;
});

test('真实反代：Claude 不带工具的后台小请求排队不算「排队中」，带工具的正式回答才算', async t => {
  const gw = await startGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin, { AI_HUB_API_GATEWAY_MODELS: '', AI_HUB_API_GATEWAY_HEADER_TIMEOUT_MS: '5000' });
  const send = (tag, extra, signal) => fetch(p.origin + '/v1/messages', { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-api-key': `${p.key}.${tag}__gw`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'hang-forever', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }], ...extra }) }).catch(() => null);
  const abort = new AbortController();
  const bg = send('bg', {}, abort.signal);
  const main = send('mn', { tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: {} } }] }, abort.signal);
  await new Promise(r => setTimeout(r, 400));
  const status = await (await fetch(p.origin + '/admin/status', { headers: { authorization: 'Bearer ' + p.key } })).json();
  assert.equal(status.gateway.waiting.bg, undefined, '后台小请求不显示排队');
  assert.ok(status.gateway.waiting.mn, '正式回答显示排队');
  abort.abort();
  await Promise.all([bg, main]);
});
