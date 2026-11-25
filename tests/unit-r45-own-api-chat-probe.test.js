'use strict';

// R45（2026-11-25）「部门 key / 自有接口连上了，对话却不生效」：
// 1) 自有接口「测试连接」要按会话真实走的协议发一句话（同地址、同 Key、同模型），测通才等于对话能用；
// 2) 部门 key 已配好、CodeAgent 没有可用模型时，启动中心就地说清 CodeAgent 不走部门 key。
// 全部用假的 fetch，不发任何真实请求。
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeChat, endpointOf } = require('../core/own-api-chat-probe');
const cards = require('../renderer/launch-model-cards');

// 模拟一个只懂 OpenAI chat 的部门接口（New API 这类）：/models 和 /chat/completions 能用，别的路径 404 / 405。
function openaiOnly({ key = 'sk-dept', models = ['deepseek-v4.1-flash', 'glm-5.3-flash'], responsesStatus = 404, messagesStatus = 405 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : null });
    if ((init.headers?.authorization || '') !== 'Bearer ' + key) return new Response('{"error":{"message":"Invalid token"}}', { status: 401 });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: models.map(id => ({ id })) }), { status: 200 });
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(init.body);
      if (!models.includes(body.model)) return new Response(JSON.stringify({ error: { message: `model ${body.model} not found` } }), { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'p' } }] }), { status: 200 });
    }
    if (url.endsWith('/v1/messages')) return new Response('{"detail":"Method Not Allowed"}', { status: messagesStatus });
    if (url.endsWith('/responses')) return new Response('{"detail":"Not Found"}', { status: responsesStatus });
    return new Response('{}', { status: 404 });
  };
  return { impl, calls };
}

test('会话实际请求的地址：Claude 拼 /v1/messages，Codex responses 拼 /responses，chat 与 DSH 拼 /chat/completions', () => {
  assert.equal(endpointOf('claude', 'http://x/api/').url, 'http://x/api/v1/messages');
  assert.equal(endpointOf('codex', 'http://x/v1', 'responses').url, 'http://x/v1/responses');
  assert.equal(endpointOf('codex', 'http://x/v1', 'chat').url, 'http://x/v1/chat/completions');
  assert.equal(endpointOf('deepseek-acp', 'http://x/v1').url, 'http://x/v1/chat/completions');
});

test('Claude Code 填 OpenAI 兼容的部门接口：列模型能过，但对话测试判为协议对不上，并给「改用 API 网关接入」', async () => {
  const f = openaiOnly();
  const r = await probeChat({ kind: 'claude', baseURL: 'http://dept/v1', apiKey: 'sk-dept', model: 'deepseek-v4.1-flash', fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'protocol_mismatch');
  assert.equal(r.fix, 'gateway');
  assert.match(r.message, /OpenAI 格式/);
  assert.match(r.message, /HTTP 405/);
  // 和会话同一个地址、Key、模型：先打 Claude Code 真正会打的 /v1/messages，再试 chat 判断原因。
  assert.equal(f.calls[0].url, 'http://dept/v1/v1/messages');
  assert.equal(f.calls[0].body.model, 'deepseek-v4.1-flash');
  assert.equal(f.calls[0].auth, 'Bearer sk-dept');
  // 地址以 /v1 结尾：先去掉多余 /v1 再试一次 Anthropic 路径（仍不认），最后才试 chat 判断原因。
  assert.equal(f.calls[1].url, 'http://dept/v1/messages');
  assert.equal(f.calls[2].url, 'http://dept/v1/chat/completions');
  assert.doesNotMatch(JSON.stringify(r), /sk-dept/, '结果里不带 key');
});

test('Codex 默认 responses 协议遇到只支持 chat 的接口：给「改用 chat 协议」；改成 chat 后对话测试通过', async () => {
  const f = openaiOnly();
  const bad = await probeChat({ kind: 'codex', baseURL: 'http://dept/v1', apiKey: 'sk-dept', model: 'glm-5.3-flash', wireApi: 'responses', fetchImpl: f.impl });
  assert.equal(bad.ok, false);
  assert.equal(bad.fix, 'chat');
  assert.match(bad.message, /chat 协议/);
  const good = await probeChat({ kind: 'codex', baseURL: 'http://dept/v1', apiKey: 'sk-dept', model: 'glm-5.3-flash', wireApi: 'chat', fetchImpl: f.impl });
  assert.equal(good.ok, true);
  assert.match(good.message, /对话测试通过/);
});

test('DSH 自有接口：chat 协议直接通过；模型名写错时说清是模型问题，不误判成协议', async () => {
  const f = openaiOnly();
  assert.equal((await probeChat({ kind: 'deepseek-acp', baseURL: 'http://dept/v1', apiKey: 'sk-dept', model: 'deepseek-v4.1-flash', fetchImpl: f.impl })).ok, true);
  const wrong = await probeChat({ kind: 'deepseek-acp', baseURL: 'http://dept/v1', apiKey: 'sk-dept', model: 'nope-1', fetchImpl: f.impl });
  assert.equal(wrong.ok, false);
  assert.notEqual(wrong.code, 'protocol_mismatch');
  assert.equal(wrong.fix, '');
});

test('Key 不对：对话测试给 key 无效的人话，不建议改协议', async () => {
  const f = openaiOnly();
  const r = await probeChat({ kind: 'codex', baseURL: 'http://dept/v1', apiKey: 'sk-wrong', model: 'glm-5.3-flash', wireApi: 'chat', fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_key');
  assert.equal(r.fix, '');
  assert.doesNotMatch(r.message, /网关/, '自有接口的人话里不写「网关」');
});

test('真正支持 Anthropic 格式的接口：Claude 对话测试直接通过，不打扰', async () => {
  const impl = async url => (url.endsWith('/v1/messages') ? new Response('{"content":[{"type":"text","text":"p"}]}', { status: 200 }) : new Response('{}', { status: 404 }));
  const r = await probeChat({ kind: 'claude', baseURL: 'http://anthropic-proxy', apiKey: 'k', model: 'claude-x', fetchImpl: impl });
  assert.equal(r.ok, true);
  assert.equal(r.fix, '');
});

test('没填模型：不发对话请求，说明会用 CLI 默认模型', async () => {
  let called = 0;
  const r = await probeChat({ kind: 'claude', baseURL: 'http://x', apiKey: 'k', model: '', fetchImpl: async () => { called += 1; return new Response('{}'); } });
  assert.equal(r.skipped, true);
  assert.equal(called, 0);
});

test('连不上 / 超时：如实说没确认，不说通过', async () => {
  const down = await probeChat({ kind: 'codex', baseURL: 'http://x', apiKey: 'k', model: 'm', wireApi: 'chat', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down.ok, false);
  assert.equal(down.code, 'unreachable');
  const slow = await probeChat({ kind: 'codex', baseURL: 'http://x', apiKey: 'k', model: 'm', wireApi: 'chat', timeoutMs: 30,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  assert.equal(slow.ok, false);
  assert.equal(slow.code, 'timeout');
});

test('启动中心：选 CodeAgent、部门 key 已配好、CodeAgent 实时读不到可用模型 → 就地提示改用部门 key', () => {
  const hint = cards.codeagentGatewayHint({ selectedKind: 'codeagent', gatewayReady: true, catalogState: 'failed', usableCount: 0 });
  assert.match(hint, /部门 API key 不走 CodeAgent/);
  assert.equal(cards.codeagentGatewayHint({ selectedKind: 'codeagent', gatewayReady: true, catalogState: 'ready', usableCount: 0 }) !== '', true);
  // 不该提示的：CodeAgent 有模型、还在读、没配部门 key、选的不是 CodeAgent。
  assert.equal(cards.codeagentGatewayHint({ selectedKind: 'codeagent', gatewayReady: true, catalogState: 'ready', usableCount: 3 }), '');
  assert.equal(cards.codeagentGatewayHint({ selectedKind: 'codeagent', gatewayReady: true, catalogState: 'loading', usableCount: 0 }), '');
  assert.equal(cards.codeagentGatewayHint({ selectedKind: 'codeagent', gatewayReady: true, catalogState: 'ready', usableCount: null }), '');
  assert.equal(cards.codeagentGatewayHint({ selectedKind: 'codeagent', gatewayReady: false, catalogState: 'ready', usableCount: 0 }), '');
  assert.equal(cards.codeagentGatewayHint({ selectedKind: 'claude', gatewayReady: true, catalogState: 'ready', usableCount: 0 }), '');
});

// ---- R45-1 审查修复（job 20261125-212232-338e3c）----
const { probeOwnApi } = require('../main/ipc/company-api-probe');

// 同时懂 /v1/models、/v1/messages（Anthropic）和 /v1/chat/completions 的接口（New API / LiteLLM 这类）。
function dualFormat({ key = 'k-dual-123456', models = ['m1', 'm2'], echoKey = false } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const auth = init.headers?.authorization === 'Bearer ' + key;
    if (!auth) return new Response(JSON.stringify({ error: { message: echoKey ? `bad token ${init.headers?.authorization?.slice(7)}` : 'bad token' } }), { status: 401 });
    if (path === '/v1/models') return new Response(JSON.stringify({ data: models.map(id => ({ id })) }), { status: 200 });
    if (path === '/v1/messages' || path === '/v1/chat/completions') {
      const body = JSON.parse(init.body);
      if (!models.includes(body.model)) return new Response(JSON.stringify({ error: { message: `model ${body.model} not found` } }), { status: 404 });
      return new Response('{}', { status: 200 });
    }
    return new Response('{"detail":"Not Found"}', { status: 404 });
  };
  return { impl, calls };
}

test('P1-1 Claude 填根地址：列模型补了 /v1，对话测试去掉多余 /v1 再测通，并把不带 /v1 的根地址交回', async () => {
  const f = dualFormat();
  const r = await probeOwnApi({ kind: 'claude', baseURL: 'http://proxy', apiKey: 'k-dual-123456', model: '' }, { raw: {}, fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.equal(r.chat.ok, true, JSON.stringify(r.chat));
  assert.equal(r.baseURL, undefined, '最终地址就是用户填的根地址，不改表单');
  assert.ok(f.calls.some(c => c.path === '/v1/v1/messages'), '先按会话会打的路径试');
  assert.ok(f.calls.some(c => c.path === '/v1/messages' && c.method === 'POST'), '再去掉多余 /v1 测通');
  assert.equal(f.calls.some(c => c.path === '/v1/chat/completions'), false, '没误判成 OpenAI 格式');
});

test('P1-1 Claude 填了带 /v1 的地址：测通后交回根地址，提示已去掉 /v1', async () => {
  const f = dualFormat();
  const r = await probeOwnApi({ kind: 'claude', baseURL: 'http://proxy/v1', apiKey: 'k-dual-123456', model: 'm2' }, { raw: {}, fetchImpl: f.impl });
  assert.equal(r.chat.ok, true);
  assert.equal(r.baseURL, 'http://proxy');
  assert.equal(r.baseChange, 'removed-v1');
});

test('P1-2 换了接口、框里还是旧接口的模型且测不通：自动改选新接口的模型重测并说明', async () => {
  const f = dualFormat({ models: ['n1', 'deepseek-v4.1-flash'] });
  const r = await probeOwnApi({ kind: 'deepseek-acp', baseURL: 'http://new/v1', apiKey: 'k-dual-123456', model: 'old-model' }, { raw: {}, fetchImpl: f.impl });
  assert.equal(r.model, 'deepseek-v4.1-flash');
  assert.equal(r.replacedModel, 'old-model');
  assert.equal(r.chat.ok, true);
});

test('P1-2 手填的隐藏模型（列表里没有、但能用）测得通就照用，不改', async () => {
  const f = dualFormat({ models: ['n1', 'hidden-1017'] });
  const listed = f.impl;
  const impl = async (url, init) => (new URL(url).pathname === '/v1/models' ? new Response(JSON.stringify({ data: [{ id: 'n1' }] }), { status: 200 }) : listed(url, init));
  const r = await probeOwnApi({ kind: 'deepseek-acp', baseURL: 'http://new/v1', apiKey: 'k-dual-123456', model: 'hidden-1017' }, { raw: {}, fetchImpl: impl });
  assert.equal(r.model, 'hidden-1017');
  assert.equal(r.replacedModel, undefined);
  assert.equal(r.chat.ok, true);
});

test('模型框留空：自动填接口上的模型并做对话测试（开箱即用）', async () => {
  const f = dualFormat({ models: ['a1', 'a2'] });
  const r = await probeOwnApi({ kind: 'deepseek-acp', baseURL: 'http://x/v1', apiKey: 'k-dual-123456', model: '' }, { raw: {}, fetchImpl: f.impl });
  assert.equal(r.model, 'a1');
  assert.equal(r.chat.ok, true);
  assert.equal(r.chat.skipped, undefined);
});

test('P2 表单没传协议时用保存过的 wireApi：Codex 存的是 chat 就按 chat 测', async () => {
  const f = dualFormat();
  const raw = { providers: { codex: { backend: 'api', base_url: 'http://x/v1', api_key: 'k-dual-123456', model: 'm1', wire_api: 'chat' } } };
  const r = await probeOwnApi({ kind: 'codex', baseURL: 'http://x/v1', apiKey: '', model: 'm1' }, { raw, fetchImpl: f.impl });
  assert.equal(r.chat.ok, true);
  assert.equal(r.chat.protocol, 'chat');
  assert.equal(r.keyUsed, 'saved');
});

test('P2 失败回显里出现本次的 Key（不像 sk- 的自定义 Key）时精确抹掉', async () => {
  const key = 'mycorpkey42';
  const impl = async () => new Response(JSON.stringify({ error: { message: `token ${key} is disabled` } }), { status: 403 });
  const r = await probeChat({ kind: 'deepseek-acp', baseURL: 'http://x/v1', apiKey: key, model: 'm', fetchImpl: impl });
  assert.equal(r.ok, false);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(key));
});

test('P1-3 「改用部门 key」挑本机已装的第一个：Claude Code → Codex → DSH，都没装落回 Claude Code', () => {
  const pick = map => cards.gatewayLaunchTarget(option => map[option] ?? null);
  assert.equal(pick({ claude: true, codex: true }).kind, 'claude');
  assert.equal(pick({ claude: false, codex: true }).kind, 'codex');
  assert.equal(pick({ claude: false, codex: false, deepseek: true }).kind, 'deepseek-acp');
  assert.equal(pick({ claude: false, codex: false, deepseek: false }).kind, 'claude');
  assert.equal(pick({}).label, 'Claude Code');
});

test('R45-3 审查 P2-5 Claude 去掉 /v1 重试时根地址回了排队 / 限流这类业务错：按它说原因，地址仍交回根地址', async () => {
  const impl = async url => {
    const path = new URL(url).pathname;
    if (path === '/v1/models') return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
    if (path === '/v1/messages') return new Response(JSON.stringify({ error: { message: 'No available channel for model m1 under group default' } }), { status: 503 });
    return new Response('{"detail":"Not Found"}', { status: 404 });
  };
  const r = await probeOwnApi({ kind: 'claude', baseURL: 'http://proxy', apiKey: 'k-dual-123456', model: 'm1' }, { raw: {}, fetchImpl: impl });
  assert.equal(r.chat.ok, false);
  assert.notEqual(r.chat.code, 'route_missing');
  assert.equal(r.baseURL, undefined, '根地址就是用户填的，不被改成带 /v1');
});
