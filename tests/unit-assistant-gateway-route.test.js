'use strict';
// 假 safeStorage + 假网关 fetch，不碰真实网关和真实 key。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gateway = require('../core/api-gateway');
const route = require('../core/assistant-gateway-route');
const choice = require('../core/feature-agent-choice');
const routes = require('../core/codeagent-assistant-route');
const fakeSafe = require('./helpers/fake-safe-storage');

const KEY = 'sk-dept-secret-0123456789';
const MODELS = ['deepseek-v4.1-flash', 'glm-5.3-flash'];
function tempDir(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-gw-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const sse = text => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
function fakeFetch({ extra = ['deepseek-v4.1-flash-1017'] } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, body: init.body || '' });
    if (init.headers?.authorization !== 'Bearer ' + KEY) return new Response('{"error":{"message":"Invalid token"}}', { status: 401 });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: MODELS.map(id => ({ id })) }), { status: 200 });
    if (url.endsWith('/chat/completions')) {
      const model = JSON.parse(init.body).model;
      if ([...MODELS, ...extra].includes(model)) return sse('ok');
      return new Response(JSON.stringify({ error: { message: `model ${model} not found`, code: 'model_not_found' } }), { status: 503 });
    }
    return new Response('{}', { status: 404 });
  };
  return { impl, calls };
}
async function withKey(dir) {
  const r = await gateway.save(dir, { apiKey: KEY }, { safeStorage: fakeSafe, fetchImpl: fakeFetch().impl });
  assert.equal(r.ok, true);
}
const gatewayRow = (available = true, models = MODELS) => ({ kind: 'api-gateway', label: '部门 API key（网关）', available, reason: available ? '' : '还没保存部门 API key', defaultModel: models[0], models: models.map(id => ({ id })), allowCustom: true });
const codeagentRow = available => ({ kind: 'codeagent', label: 'CodeAgent', available, models: [{ id: 'glm-test', provider: 'builtin' }] });

test('老用户不变：本机有 CodeAgent 时，即使存过部门 key，助理仍走原来的 CodeAgent 且 opts 原样', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  routes.setPreference(dir, 'personal', { model: 'legacy', provider: 'builtin' });
  const opts = { purpose: 'company-assistant', codeagentPoolPick: 'x' };
  const r = choice.session(dir, 'assistant', 'codeagent', opts, { backends: [codeagentRow(true), gatewayRow(true)] });
  assert.equal(r.kind, 'codeagent');
  assert.equal(r.opts, opts, '同一个对象，不加任何字段');
  assert.equal(routes.preference(dir).model, 'legacy');
  // 真实判定（不传目录）：查得到 codeagent 命令就不默认走网关。
  assert.equal(route.autoDefault(dir, { findCommand: kind => (kind === 'codeagent' || kind === 'claude' ? 'C:/x/' + kind + '.exe' : null) }), false);
  // 查命令出错：说不清有没有 CodeAgent，按「有」处理，不悄悄切线路。
  assert.equal(route.autoDefault(dir, { findCommand: kind => { if (kind === 'codeagent') throw new Error('boom'); return 'C:/x/claude.exe'; } }), false);
});

test('开箱即用：没 CodeAgent、存过部门 key、有 Claude Code 时默认走网关；会话是 Claude Code + 网关标记，不带 CodeAgent 字段', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  assert.equal(route.autoDefault(dir, { findCommand: kind => (kind === 'claude' ? 'C:/x/claude.exe' : null) }), true);
  assert.equal(route.autoDefault(dir, { findCommand: () => null }), false, '没 Claude Code 不默认');
  const backends = [codeagentRow(false), gatewayRow(true)];
  const r = choice.session(dir, 'assistant', 'codeagent', { purpose: 'company-assistant', autonomous: true, codeagentRouteModel: 'glm' }, { backends });
  assert.equal(r.kind, 'claude');
  assert.equal(r.opts.apiGatewayRoute, true);
  assert.equal(r.opts.mcpProfile, 'none', '只挂助理自己的会话工具');
  assert.equal(r.opts.model, 'deepseek-v4.1-flash');
  assert.ok(!Object.keys(r.opts).some(k => /^codeagent/i.test(k)));
  assert.doesNotThrow(() => choice.assertSessionKind(r.kind, r.opts));
  // R49-2（11-26）：其余 7 项没选过时同样默认走部门 key（以前只有助理，其余默认落到用不了的 CodeAgent）。
  for (const id of ['ppt', 'pptMake', 'pptImgtext', 'avatar', 'forum', 'meeting', 'text']) {
    assert.deepEqual(choice.resolve(dir, id, { backends }).selected, { kind: 'api-gateway', model: '' }, id);
    const other = choice.session(dir, id, 'codeagent', { purpose: route.FEATURE_PURPOSES[id] }, { backends });
    assert.equal(other.kind, 'claude', id); assert.equal(other.opts.apiGatewayRoute, true, id);
    assert.doesNotThrow(() => choice.assertSessionKind(other.kind, other.opts), id);
  }
  // 有 CodeAgent 的保持原默认（CodeAgent），opts 原样。
  const withCa = [codeagentRow(true), gatewayRow(true)];
  const opts = { purpose: route.FEATURE_PURPOSES.ppt };
  const keep = choice.session(dir, 'ppt', 'codeagent', opts, { backends: withCa });
  assert.equal(keep.kind, 'codeagent'); assert.equal(keep.opts, opts);
  // 状态页写清默认是部门 key。
  const st = choice.state(dir, { backends });
  assert.match(st.features.find(f => f.id === 'assistant').defaultText, /部门 API key/);
});

test('显式选部门 key：可保存可恢复默认；key 没存时报原因、不写配置；其他功能和无标记会话仍拒绝 Claude', async t => {
  const dir = tempDir(t);
  assert.throws(() => choice.set(dir, 'assistant', { kind: 'api-gateway', model: '' }, { backends: [codeagentRow(true), gatewayRow(false)] }), /还没保存部门 API key/);
  assert.equal(routes.featurePreference(dir, 'assistant'), null);
  // 问问 Hub、库地图、进展卡这类单次调用功能不提供部门 key。
  for (const id of ['help', 'pptMap', 'progress']) assert.throws(() => choice.set(dir, id, { kind: 'api-gateway', model: '' }, { backends: [gatewayRow(true)] }), id);
  choice.set(dir, 'assistant', { kind: 'api-gateway', model: 'glm-5.3-flash' }, { backends: [codeagentRow(true), gatewayRow(true)] });
  const r = choice.session(dir, 'assistant', 'codeagent', { purpose: 'company-assistant' }, { backends: [codeagentRow(true), gatewayRow(true)] });
  assert.equal(r.kind, 'claude'); assert.equal(r.opts.model, 'glm-5.3-flash');
  choice.set(dir, 'assistant', null, { backends: [codeagentRow(true), gatewayRow(true)] });
  assert.equal(choice.session(dir, 'assistant', 'codeagent', {}, { backends: [codeagentRow(true), gatewayRow(true)] }).kind, 'codeagent');
  // 受控边界：只有带网关标记的助理会话能用 Claude。
  assert.throws(() => choice.assertSessionKind('claude', { featureAgent: 'assistant', purpose: 'company-assistant' }), e => e.code === 'FEATURE_AGENT_UNSAFE_BACKEND');
  assert.throws(() => choice.assertSessionKind('claude', { featureAgent: 'avatar', purpose: 'avatar-agent', apiGatewayRoute: true }), e => e.code === 'FEATURE_AGENT_UNSAFE_BACKEND');
  assert.throws(() => choice.assertSessionKind('codex', { featureAgent: 'assistant', purpose: 'company-assistant', apiGatewayRoute: true }));
  // 真实会话参数（session 给出的）放行；伪造的都不放行：别的功能、没有选型记录、选型记录不是部门 key。
  const real = choice.session(dir, 'assistant', 'codeagent', { purpose: 'company-assistant' }, { backends: [codeagentRow(false), gatewayRow(true)] });
  assert.doesNotThrow(() => choice.assertSessionKind(real.kind, real.opts));
  const gwChoice = JSON.stringify({ kind: 'api-gateway', model: '' });
  for (const forged of [{ featureAgent: 'avatar', featureAgentChoice: gwChoice }, { featureAgent: 'help', featureAgentChoice: gwChoice }, { featureAgent: 'assistant' }, { featureAgent: 'assistant', featureAgentChoice: JSON.stringify({ kind: 'claude', model: 'haiku' }) },
    { featureAgent: 'assistant', featureAgentChoice: '{坏' }]) {
    const opts = { purpose: 'company-assistant', apiGatewayRoute: true, ...forged };
    assert.equal(route.allowedSession('claude', opts), false, JSON.stringify(forged));
    assert.throws(() => choice.assertSessionKind('claude', opts), e => e.code === 'FEATURE_AGENT_UNSAFE_BACKEND');
  }
});

test('手填模型：先试跑一句测通才记下，之后会话与本机反代都认它；不通给一行原因、不记；名字不对直接拒', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  const f = fakeFetch();
  const ok = await gateway.addCustomModel(dir, ' deepseek-v4.1-flash-1017 ', { safeStorage: fakeSafe, fetchImpl: f.impl });
  assert.equal(ok.ok, true); assert.equal(ok.model, 'deepseek-v4.1-flash-1017');
  assert.equal(f.calls.filter(c => c.url.endsWith('/chat/completions')).length, 1, '只试跑一次');
  assert.deepEqual(gateway.read(dir).customModels, ['deepseek-v4.1-flash-1017']);
  assert.equal(gateway.resolveModel(dir, 'deepseek-v4.1-flash-1017'), 'deepseek-v4.1-flash-1017', '不被换成默认模型');
  assert.ok(gateway.allModels(dir).includes('deepseek-v4.1-flash-1017'), '交给本机反代的模型表里有它');
  const bad = await gateway.addCustomModel(dir, 'nope-model', { safeStorage: fakeSafe, fetchImpl: f.impl });
  assert.equal(bad.ok, false);
  assert.ok(bad.message && !/\n/.test(bad.message), '一行原因');
  assert.ok(!gateway.read(dir).customModels.includes('nope-model'));
  const name = await gateway.addCustomModel(dir, 'a b', { safeStorage: fakeSafe, fetchImpl: f.impl });
  assert.equal(name.code, 'bad_name');
  // 选用手填模型：目录里带「手填」，set 认它。
  const row = { ...gatewayRow(true), models: [...MODELS.map(id => ({ id })), { id: 'deepseek-v4.1-flash-1017', custom: true }] };
  choice.set(dir, 'assistant', { kind: 'api-gateway', model: 'deepseek-v4.1-flash-1017' }, { backends: [codeagentRow(true), row] });
  assert.equal(choice.session(dir, 'assistant', 'codeagent', { purpose: 'company-assistant' }, { backends: [codeagentRow(true), row] }).opts.model, 'deepseek-v4.1-flash-1017');
  // 没有 key 时直接说先存 key，不发请求。
  const empty = tempDir(t), g = fakeFetch();
  const nokey = await gateway.addCustomModel(empty, 'x-model', { safeStorage: fakeSafe, fetchImpl: g.impl });
  assert.equal(nokey.code, 'no_key'); assert.equal(g.calls.length, 0);
});

test('key 不落明文：网关配置文件、手填模型记录、会话参数、启动参数里都没有部门 key', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  await gateway.addCustomModel(dir, 'deepseek-v4.1-flash-1017', { safeStorage: fakeSafe, fetchImpl: fakeFetch().impl });
  for (const file of fs.readdirSync(path.join(dir, 'api-gateway'))) assert.doesNotMatch(fs.readFileSync(path.join(dir, 'api-gateway', file), 'utf8'), /sk-dept-secret/);
  const r = choice.session(dir, 'assistant', 'codeagent', { purpose: 'company-assistant' }, { backends: [codeagentRow(false), gatewayRow(true)] });
  assert.doesNotMatch(JSON.stringify(r), /sk-dept-secret/);
  const values = route.launchValues({ CLAUDE_API_KEY: '' });
  assert.deepEqual([values.COMPANY_CLI, values.CLAUDE_BACKEND, values.CLAUDE_UPSTREAM], [true, 'proxy', 'gateway']);
  assert.doesNotMatch(JSON.stringify(values), /sk-dept-secret/);
  // 会话环境只拿本机反代的 Key（主 Key.会话标识__gw），不是部门 key。
  const proxy = require('../core/company-model-proxy');
  proxy.ensureEndpoint(dir);
  const env = {};
  proxy.applyClaudeEnv(env, { dataDir: dir, sessionId: 'abc', model: 'deepseek-v4.1-flash', gateway: true });
  assert.doesNotMatch(JSON.stringify(env), /sk-dept-secret/);
  assert.match(JSON.stringify(env), /__gw/);
});

test('网关报错：401/403/405/413/超时都给一行人话和下一步按钮', () => {
  const errors = require('../core/api-gateway-errors');
  const proxied = status => `API Error: ${status} {"type":"error","error":{"message":"${errors.sentence(errors.classify({ status, body: '{"error":{"message":"x"}}', model: 'm1' }))}"}}`;
  const key = route.failure(proxied(401));
  assert.match(key.line, /^部门 API key（网关）：key 无效/); assert.deepEqual(key.actions, ['gateway-settings']);
  assert.deepEqual(route.failure(proxied(403)).actions, ['model']);
  const m405 = route.failure(proxied(405));
  assert.match(m405.line, /地址/); assert.ok(m405.actions.includes('gateway-settings'));
  const m413 = route.failure(proxied(413));
  assert.match(m413.line, /太大|413/); assert.ok(m413.actions.includes('model'));
  // 没经本机反代翻译的原始状态码也套同一口径。
  assert.match(route.failure('API Error: 405 Method Not Allowed').line, /网关地址/);
  assert.match(route.failure('Request timed out').line, /太久没开始回答/);
  for (const r of [key, m405, m413]) assert.ok(!/\n/.test(r.line));
  assert.equal(route.failure('一切正常'), null);
});

test('网关会话的 401 报成 key 的问题，不报「Agent 尚未登录」；CodeAgent 会话仍按原口径', () => {
  const reader = require('../core/feature-agent-session-failure').createReader;
  const text = 'API Error: 401 {"error":{"message":"API 网关：key 无效：网关不认这个 key（复制不完整、已过期或被禁用）。请重新粘贴 key 再试。"}}';
  const gw = reader({ getSession: () => ({ apiGatewayRoute: true }), readTurnApiError: () => ({ id: 'e1', text }) }).read('s1');
  assert.match(gw, /^部门 API key（网关）：key 无效/);
  const ca = reader({ getSession: () => ({}), readTurnApiError: () => ({ id: 'e1', text: 'API Error: 401 unauthorized' }) }).read('s1');
  assert.match(ca, /Agent 尚未登录/);
  // 限流这类可重试的不在这里提前收。
  const rate = reader({ getSession: () => ({ apiGatewayRoute: true }), readTurnApiError: () => ({ id: 'e2', text: 'API Error: 429 {"error":{"message":"API 网关：网关限流了：请求太密，请稍等半分钟再发。"}}' }) }).read('s1');
  assert.equal(rate, '');
});

test('输入框状态：没装 CodeAgent 但助理走部门 key 时不再说「还不能提问」', () => {
  const { composerState } = require('../renderer/company-assistant-connection');
  assert.equal(composerState({}, { codeagentInstalled: false }).tone, 'bad');
  assert.notEqual(composerState({ answerRoute: { kind: 'api-gateway' } }, { codeagentInstalled: false }).tone, 'bad');
});

test('连不上网关：连接被拒不写成「N 秒内没有响应」', async () => {
  const refused = await gateway.probe({ baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  assert.equal(refused.code, 'unreachable'); assert.match(refused.message, /连接被拒绝/); assert.doesNotMatch(refused.message, /秒内没有响应/);
  const slow = await gateway.probe({ baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', timeoutMs: 20, fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  assert.match(slow.message, /秒内没有响应/);
});

test('本机反代热更新失败不吞：返回 gatewayStale，手填模型界面提示重启 Hub 后生效', async () => {
  const { CompanyProxyService } = require('../main/company-proxy-service');
  const svc = Object.create(CompanyProxyService.prototype);
  Object.assign(svc, { child: {}, logger: { warn() {} }, gatewaySettings: () => ({ models: ['m'] }), request: async () => { throw new Error('busy'); },
    restart: async () => { throw new Error('不该重启'); }, syncWithConfig: async () => ({ state: 'running' }) });
  assert.deepEqual(await svc.applyGatewayChange(), { state: 'running', gatewayStale: true });
  svc.request = async () => ({ ok: true });
  assert.deepEqual(await svc.applyGatewayChange(), { state: 'running' });
});

// ---- 2026-11-24 扩到 8 项会话功能（心声 / PPT / 分身 / 会议 / 文字） ----
const SESSION_FEATURES = ['assistant', 'ppt', 'pptMake', 'pptImgtext', 'avatar', 'forum', 'meeting', 'text'];

test('8 项会话功能都能显式选部门 key：会话是 Claude Code + none 档 MCP，剔除 CodeAgent 字段、保留其余字段，同一选型不判过期', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  const backends = [codeagentRow(true), gatewayRow(true)];
  assert.deepEqual(Object.keys(route.FEATURE_PURPOSES).sort(), [...SESSION_FEATURES].sort());
  for (const id of SESSION_FEATURES) {
    choice.set(dir, id, { kind: 'api-gateway', model: '' }, { backends });
    const opts = { id: 'sid-' + id, cwd: 'C:/w', title: 't', purpose: route.FEATURE_PURPOSES[id], autonomous: true, noInheritCursor: true, openInBackground: true,
      addDirs: ['C:/src'], effort: 'high', codeagentAccount: 'pool', codeagentPoolPick: 'x', codeagentRouteModel: 'glm', CodeAgentFoo: 1 };
    const r = choice.session(dir, id, 'codeagent', opts, { backends });
    assert.equal(r.kind, 'claude', id);
    assert.equal(r.opts.apiGatewayRoute, true, id); assert.equal(r.opts.mcpProfile, 'none', id);
    assert.equal(r.opts.featureAgent, id); assert.equal(JSON.parse(r.opts.featureAgentChoice).kind, 'api-gateway');
    assert.equal(r.opts.model, 'deepseek-v4.1-flash', '空模型用网关默认模型');
    for (const k of ['id', 'cwd', 'title', 'purpose', 'autonomous', 'noInheritCursor', 'openInBackground', 'addDirs']) assert.deepEqual(r.opts[k], opts[k], `${id} 保留 ${k}`);
    assert.ok(!Object.keys(r.opts).some(k => /^codeagent/i.test(k)), id);
    assert.doesNotThrow(() => choice.assertSessionKind(r.kind, r.opts), id);
    assert.doesNotThrow(() => choice.assertSessionKind('claude-resume', r.opts), id + ' 恢复');
    assert.equal(choice.stale(dir, id, r.opts, { backends }), false, `${id} 同一选型不判过期（分身、论坛不会每轮重建会话）`);
    assert.doesNotMatch(JSON.stringify(r), /sk-dept-secret/);
    // 原始未受控后端仍拒绝：同样的参数换成 codex / ACP 都不放行。
    for (const kind of ['codex', 'deepseek-acp', 'qwen', 'glm']) assert.throws(() => choice.assertSessionKind(kind, r.opts), e => e.code === 'FEATURE_AGENT_UNSAFE_BACKEND', `${id} ${kind}`);
  }
  // 状态页：选了网关的功能标出部门 key。
  const st = choice.state(dir, { backends });
  for (const id of SESSION_FEATURES) assert.equal(st.features.find(f => f.id === id).selected.kind, 'api-gateway', id);
});

test('跨功能伪造：功能和用途不配套、功能不在表里、没有网关标记、不是 Claude Code，一律不放行', () => {
  const gwChoice = JSON.stringify({ kind: 'api-gateway', model: '' });
  const purposes = ['company-assistant', 'company-forum', 'company-ai', 'avatar-agent'];
  for (const id of SESSION_FEATURES) for (const purpose of purposes) {
    const opts = { featureAgent: id, purpose, apiGatewayRoute: true, featureAgentChoice: gwChoice, mcpProfile: 'none' };
    const ok = route.FEATURE_PURPOSES[id] === purpose;
    assert.equal(route.allowedSession('claude', opts), ok, `${id} + ${purpose}`);
    if (ok) assert.doesNotThrow(() => choice.assertSessionKind('claude', opts));
    else assert.throws(() => choice.assertSessionKind('claude', opts), e => e.code === 'FEATURE_AGENT_UNSAFE_BACKEND', `${id} + ${purpose}`);
  }
  for (const featureAgent of ['help', 'pptMap', 'progress', '__proto__', 'constructor', 'toString'])
    assert.equal(route.allowedSession('claude', { featureAgent, purpose: 'company-assistant', apiGatewayRoute: true, featureAgentChoice: gwChoice, mcpProfile: 'none' }), false, featureAgent);
  assert.equal(route.allowedSession('claude', { featureAgent: 'forum', purpose: 'company-forum', featureAgentChoice: gwChoice, mcpProfile: 'none' }), false);
  assert.equal(route.allowedSession('codex', { featureAgent: 'forum', purpose: 'company-forum', apiGatewayRoute: true, featureAgentChoice: gwChoice, mcpProfile: 'none' }), false);
});

test('本机反代常驻：只把论坛 / PPT / 分身 / 会议 / 文字之一设成部门 key、助理仍是 CodeAgent 时也常驻；都撤下就不常驻', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  const both = { findCommand: kind => (kind === 'claude' || kind === 'codeagent' ? 'C:/x/' + kind + '.exe' : null) };
  const claudeOnly = { findCommand: kind => (kind === 'claude' ? 'C:/x/claude.exe' : null) };
  assert.equal(route.inUse(dir, both), false, '有 CodeAgent、谁都没选：不常驻');
  routes.setFeaturePreference(dir, 'assistant', { kind: 'codeagent', model: '' });
  for (const id of SESSION_FEATURES.filter(id => id !== 'assistant')) {
    routes.setFeaturePreference(dir, id, { kind: 'api-gateway', model: '' });
    assert.equal(route.inUse(dir, both), true, id);
    routes.setFeaturePreference(dir, id, null);
    assert.equal(route.inUse(dir, both), false, id + ' 撤下后');
  }
  routes.setFeaturePreference(dir, 'forum', { kind: 'api-gateway', model: '' });
  assert.equal(route.inUse(dir, { findCommand: () => null }), false, '本机没有 Claude Code：会话起不来，不常驻');
  routes.setFeaturePreference(dir, 'forum', null);
  // R49-2：助理显式选了 CodeAgent，其余 7 项没选过、没装 CodeAgent → 它们自动走部门 key，反代要常驻。
  assert.equal(route.inUse(dir, claudeOnly), true, '其余功能没选过 + 没 CodeAgent：自动默认，常驻');
  for (const id of SESSION_FEATURES) routes.setFeaturePreference(dir, id, { kind: 'codeagent', model: '' });
  assert.equal(route.inUse(dir, claudeOnly), false, '8 项都显式选了 CodeAgent：没装 CodeAgent 也不走自动默认');
  for (const id of SESSION_FEATURES) routes.setFeaturePreference(dir, id, null);
  assert.equal(route.inUse(dir, claudeOnly), true, '助理没选过 + 没 CodeAgent：自动默认，常驻');
});

test('手填模型对非助理功能同样生效（论坛 / PPT），只改这一项', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  await gateway.addCustomModel(dir, 'deepseek-v4.1-flash-1017', { safeStorage: fakeSafe, fetchImpl: fakeFetch().impl });
  const row = { ...gatewayRow(true), models: [...MODELS.map(id => ({ id })), { id: 'deepseek-v4.1-flash-1017', custom: true }] };
  const backends = [codeagentRow(true), row];
  for (const id of ['forum', 'ppt']) {
    choice.set(dir, id, { kind: 'api-gateway', model: 'deepseek-v4.1-flash-1017' }, { backends });
    const r = choice.session(dir, id, 'codeagent', { purpose: route.FEATURE_PURPOSES[id] }, { backends });
    assert.equal(r.kind, 'claude'); assert.equal(r.opts.model, 'deepseek-v4.1-flash-1017'); assert.equal(r.opts.fixedModel, 'deepseek-v4.1-flash-1017');
  }
  assert.equal(choice.resolve(dir, 'assistant', { backends }).selected, null, '助理不受影响');
  assert.equal(choice.resolve(dir, 'meeting', { backends }).selected, null, '会议不受影响');
});

test('各功能对接点：论坛 / 分身 / PPT 找页与做页 / 会议 / 文字选网关后，真实调用链建出 Claude Code 网关会话', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  const backends = [codeagentRow(true), gatewayRow(true)];
  for (const id of ['forum', 'avatar', 'text', 'meeting', 'ppt', 'pptMake']) choice.set(dir, id, { kind: 'api-gateway', model: 'glm-5.3-flash' }, { backends });
  const original = choice.session;
  t.mock.method(choice, 'session', (data, feature, kind, opts) => original(data, feature, kind, opts, { backends }));
  t.mock.method(choice, 'resolve', ((orig) => (data, id, options) => orig(data, id, { backends, ...(options || {}) }))(choice.resolve));
  const created = [];
  const createSession = async (kind, opts) => { choice.assertSessionKind(kind, opts); created.push({ kind, opts }); return { id: opts.id, ok: true }; };

  // 论坛：ensureSession 新开整理会话。
  const { CompanyForum } = require('../core/company-forum/service');
  const forum = Object.create(CompanyForum.prototype);
  let fstate = {};
  Object.assign(forum, { deps: { dataDir: dir, createSession, getSession: () => null }, workspace: dir, state: () => fstate, saveState: p => { fstate = { ...fstate, ...p }; } });
  await forum.ensureSession();
  assert.equal(created.at(-1).kind, 'claude'); assert.equal(created.at(-1).opts.purpose, 'company-forum'); assert.equal(created.at(-1).opts.apiGatewayRoute, true);

  // 分身：资料目录随 addDirs 传给 Claude Code（--add-dir）；同一选型下复用会话，不每轮重建。
  const { AgentSessions } = require('../core/avatar/agent-session');
  const metas = new Map();
  const av = { id: 'a1', name: '甲', sources: [{ type: 'dir', path: path.join(dir, 'src') }], backend: { model: 'm', account: 'personal' } };
  const sessions = new AgentSessions({ dataDir: dir, createSession: async (kind, opts) => { const r = await createSession(kind, opts); metas.set(opts.id, { ...opts, kind, status: 'idle' }); return r; },
    getSession: id => metas.get(id), closeSession: async id => { metas.delete(id); } });
  const s1 = await sessions.ensure(av, null, dir);
  assert.equal(created.at(-1).kind, 'claude'); assert.deepEqual(created.at(-1).opts.addDirs, [path.join(dir, 'src')]); assert.equal(created.at(-1).opts.model, 'glm-5.3-flash');
  const count = created.length;
  assert.equal(await sessions.ensure(av, s1, dir), s1, '分身同一选型复用会话');
  assert.equal(created.length, count);

  // PPT 找页 / 做页：openPooled 按 company-assistant 用途建会话，功能标记分别是 ppt / pptMake。
  const { CompanyAssistant } = require('../core/company-assistant/service');
  for (const feature of ['ppt', 'pptMake']) {
    const a = Object.create(CompanyAssistant.prototype, { pptWorkspace: { value: dir }, workspace: { value: dir } });
    Object.assign(a, { deps: { dataDir: dir, createSession }, pool: new Map(), prepareWorkspace() {}, preparePptWorkspace() {}, settings: () => ({}), now: () => 1 });
    await a.openPooled('ppt', feature);
    assert.equal(created.at(-1).kind, 'claude', feature); assert.equal(created.at(-1).opts.featureAgent, feature); assert.equal(created.at(-1).opts.mcpProfile, 'none');
  }

  // 会议：engineFor 认出部门 key（标签写部门 key），按它建 Claude 网关会话。
  const { MeetingCompanion } = require('../core/company-assistant/meeting');
  const engine = MeetingCompanion.prototype.engineFor.call({ a: { deps: { dataDir: dir } }, deps: {} }, {});
  assert.equal(engine.harness, 'api-gateway'); assert.equal(engine.label, '部门 API key（网关）');
  const mt = choice.session(dir, 'meeting', 'api-gateway', { id: 'm1', cwd: dir, title: '会议理解', purpose: 'company-assistant', autonomous: true, noInheritCursor: true, model: 'glm-5.3-flash' });
  assert.equal(mt.kind, 'claude'); assert.equal(mt.opts.model, 'glm-5.3-flash'); assert.doesNotThrow(() => choice.assertSessionKind(mt.kind, mt.opts));

  // 文字任务：跑通回执，任务记录写模型名；网关没配默认模型时写「部门 API key（网关）」，不写裸 claude。
  let final;
  const tasks = new (require('../core/company-ai-tasks').CompanyAiTasks)({ dataDir: dir, createSession,
    sendPrompt: async (_id, prompt) => { final = { text: '结果\n' + prompt.match(/\[任务回执:[^\]]+\]/)[0] }; return { ok: true }; },
    lastFinal: () => final, closeSession: async () => {}, pollMs: 1 });
  const result = await tasks.run({ text: '材料', label: '草稿' });
  assert.equal(created.at(-1).kind, 'claude'); assert.equal(created.at(-1).opts.purpose, 'company-ai'); assert.equal(result.model, 'glm-5.3-flash'); assert.equal(result.text, '结果');
  choice.set(dir, 'text', { kind: 'api-gateway', model: '' }, { backends });
  t.mock.method(gateway, 'read', () => ({ model: '', models: [], customModels: [] }));
  assert.equal((await tasks.run({ text: '材料', label: '草稿' })).model, '部门 API key（网关）');
  tasks.close();
});

test('分身网关报错：按网关口径给一行人话并换新会话，不套 CodeAgent 供应商说法和修复卡', async t => {
  const { AgentSessions } = require('../core/avatar/agent-session');
  const errors = require('../core/company-assistant/turn-api-error');
  let n = 0, clock = 0;
  t.mock.method(errors, 'lastApiError', () => (n++ === 0 ? null : { id: 'e1', text: 'API Error: 405 Method Not Allowed' }));
  const sessions = new AgentSessions({ now: () => (clock += 5000), pollMs: 1, getSession: () => ({ apiGatewayRoute: true, transcriptPath: 'x' }),
    sendPrompt: async () => ({ ok: true }), lastFinal: () => null, readTurnApiError: () => null });
  await assert.rejects(() => sessions.ask({ id: 's1' }, 'in.json', { timeoutMs: 600000 }), e => /^部门 API key（网关）：/.test(e.message) && e.restart === true && !e.providerRepair);
});
