'use strict';
// 公司版「功能使用的 Agent」：Claude Code / Codex / DSH 只当外壳，模型来自部门 API key（网关）、公司模型（CodeAgent 账号）、自有接口、自有 API 账号（11-27），
// 和启动中心同一份枚举（2026-11-26 修正：以前会列出 claude-opus-5-5 这类公司里用不了的模型）。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const choice = require('../core/feature-agent-choice'), routes = require('../core/codeagent-assistant-route');
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-agent-harness-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const harnessModels = [{ id: 'deepseek-v4.1-flash', label: '部门 API key · deepseek-v4.1-flash', source: 'gateway' },
  { id: 'GLM-5.2-WX', label: '公司模型（CodeAgent 账号） · GLM-5.2-WX', source: 'company' },
  { id: 'own-model', label: '自有接口 · own-model', source: 'own' },
  { id: 'qwen3-coder', label: '自有 API · 组里的账号 · qwen3-coder', source: 'api', profileId: 'p1' }];
const backends = [
  { kind: 'codeagent', label: 'CodeAgent', available: true, models: [{ id: 'glm-test', provider: 'builtin' }] },
  { kind: 'codeagent-lite', label: 'CodeAgent-Lite（省内存）', available: true, models: [{ id: 'glm-test', provider: 'builtin' }] },
  { kind: 'claude', label: 'Claude Code', harness: true, available: true, models: harnessModels, defaultModel: 'deepseek-v4.1-flash', defaultSource: 'gateway' },
  { kind: 'codex', label: 'Codex', harness: true, available: true, models: harnessModels, defaultModel: 'deepseek-v4.1-flash', defaultSource: 'gateway' },
  { kind: 'deepseek-acp', label: 'DSH', harness: true, available: true, models: harnessModels.filter(m => m.source !== 'api'), defaultModel: 'deepseek-v4.1-flash', defaultSource: 'gateway' },
  { kind: 'api-gateway', label: '部门 API key（网关）', available: true, defaultModel: 'deepseek-v4.1-flash', models: [{ id: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash' }], allowCustom: true },
];
const feature = id => choice.FEATURES.find(f => f.id === id);

test('会话功能：Claude Code 外壳列出部门 key / 公司模型 / 自有接口 / 自有 API 四种来源；Codex / DSH 灰显并说明原因；不单列「部门 API key」', () => {
  const opts = choice.featureOptions(feature('assistant'), backends);
  assert.deepEqual(opts.map(o => o.value), ['codeagent', 'codeagent-lite', 'claude', 'codex', 'deepseek-acp']);
  const claude = opts.find(o => o.value === 'claude');
  assert.equal(claude.available, true); assert.equal(claude.store, 'api-gateway'); assert.equal(claude.allowCustom, true);
  assert.deepEqual(claude.models.map(m => m.value), ['src:gateway:deepseek-v4.1-flash', 'src:company:GLM-5.2-WX', 'src:own:own-model', 'src:api:p1:qwen3-coder']);
  for (const kind of ['codex', 'deepseek-acp']) { const o = opts.find(x => x.value === kind); assert.equal(o.available, false); assert.match(o.reason, /Claude Code/); assert.equal(o.models.length, 0); }
  for (const o of opts) for (const m of o.models) assert.doesNotMatch(m.id || m.value, /opus|sonnet|haiku|gpt-/i);
});

test('单次功能：Claude Code / Codex 四种来源都能选，DSH 支持部门 key / 公司模型 / 自有接口，值带来源', () => {
  const opts = choice.featureOptions(feature('help'), backends);
  const codex = opts.find(o => o.value === 'codex');
  assert.equal(codex.available, true);
  assert.deepEqual(codex.models.map(m => m.value), ['src:gateway:deepseek-v4.1-flash', 'src:company:GLM-5.2-WX', 'src:own:own-model', 'src:api:p1:qwen3-coder']);
  const dsh = opts.find(o => o.value === 'deepseek-acp');
  assert.equal(dsh.available, true);
  assert.deepEqual(dsh.models.map(m => m.source), ['gateway', 'company', 'own']);
});

test('下拉值 ↔ 存储：部门 key 会话存成原线路，其余来源存外壳 + 来源（自有 API 带账号），空模型取首选，往返一致', t => {
  const dir = temp(t);
  assert.deepEqual(choice.choiceFromUi(dir, 'assistant', { backend: 'claude', model: 'src:gateway:deepseek-v4.1-flash' }, { backends }), { kind: 'api-gateway', model: 'deepseek-v4.1-flash' });
  assert.deepEqual(choice.choiceFromUi(dir, 'assistant', { backend: 'claude', model: 'deepseek-custom' }, { backends }), { kind: 'api-gateway', model: 'deepseek-custom' }, '手填模型名算部门 key');
  assert.deepEqual(choice.choiceFromUi(dir, 'assistant', { backend: 'claude', model: 'src:own:own-model' }, { backends }), { kind: 'claude', source: 'own', model: 'own-model' });
  assert.deepEqual(choice.choiceFromUi(dir, 'help', { backend: 'codex', model: 'src:api:p1:qwen3-coder' }, { backends }), { kind: 'codex', source: 'api', profileId: 'p1', model: 'qwen3-coder' });
  assert.deepEqual(choice.choiceFromUi(dir, 'help', { backend: 'claude', model: '' }, { backends }), { kind: 'claude', source: 'gateway', model: 'deepseek-v4.1-flash' });
  assert.deepEqual(choice.choiceFromUi(dir, 'assistant', { backend: 'claude', model: '' }, { backends }), { kind: 'api-gateway', model: 'deepseek-v4.1-flash' });
  assert.equal(choice.choiceFromUi(dir, 'help', { backend: '', model: '' }, { backends }), null);
  assert.throws(() => choice.choiceFromUi(dir, 'assistant', { backend: 'codex', model: '' }, { backends }), /Hub 工具/);
  assert.throws(() => choice.choiceFromUi(dir, 'assistant', { backend: 'deepseek-acp', model: '' }, { backends }), /Hub 工具/);

  choice.setFromUi(dir, 'help', { backend: 'codex', model: 'src:api:p1:qwen3-coder' }, { backends });
  assert.deepEqual(choice.resolve(dir, 'help', { backends }).selected, { kind: 'codex', model: 'qwen3-coder', source: 'api', profileId: 'p1' });
  choice.setFromUi(dir, 'pptMap', { backend: 'deepseek-acp', model: 'src:own:own-model' }, { backends });
  assert.equal(choice.resolve(dir, 'pptMap', { backends }).selected.source, 'own');
  choice.setFromUi(dir, 'assistant', { backend: 'claude', model: 'src:gateway:deepseek-v4.1-flash' }, { backends });
  choice.setFromUi(dir, 'ppt', { backend: 'claude', model: 'src:own:own-model' }, { backends });
  const st = choice.state(dir, { backends });
  assert.deepEqual(st.features.find(f => f.id === 'help').current, { backend: 'codex', model: 'src:api:p1:qwen3-coder' });
  assert.deepEqual(st.features.find(f => f.id === 'assistant').current, { backend: 'claude', model: 'src:gateway:deepseek-v4.1-flash' });
  assert.deepEqual(st.features.find(f => f.id === 'ppt').current, { backend: 'claude', model: 'src:own:own-model' });
  assert.equal(choice.resolve(dir, 'assistant', { backends }).selected.kind, 'api-gateway');
});

test('会话功能选 Claude Code + 自有接口：Claude Code 会话、固定线路标记、none 档 MCP，不带 CodeAgent 字段；启动值只改这一个会话', t => {
  const dir = temp(t);
  choice.set(dir, 'ppt', { kind: 'claude', source: 'own', model: 'own-model' }, { backends });
  const r = choice.session(dir, 'ppt', 'codeagent', { purpose: 'company-assistant', codeagentRouteModel: 'glm', model: 'glm' }, { backends });
  assert.equal(r.kind, 'claude'); assert.equal(r.opts.apiGatewayRoute, true); assert.equal(r.opts.mcpProfile, 'none'); assert.equal(r.opts.model, 'own-model');
  assert.ok(!Object.keys(r.opts).some(k => /^codeagent/i.test(k)));
  assert.doesNotThrow(() => choice.assertSessionKind(r.kind, r.opts));
  const gw = require('../core/assistant-gateway-route');
  assert.equal(gw.isGatewaySession(r.opts), false, '报错口径不套部门 key');
  t.mock.method(require('../core/company-api-config'), 'ownConnection', () => ({ baseURL: 'https://own.example/anthropic', apiKey: 'sk-own', model: 'own-model' }));
  const v = gw.launchValues({ CLAUDE_BACKEND: 'proxy', CLAUDE_UPSTREAM: 'gateway' }, r.opts.featureAgentChoice);
  assert.equal(v.CLAUDE_BACKEND, 'api'); assert.equal(v.CLAUDE_API_BASE_URL, 'https://own.example/anthropic'); assert.equal(v.CLAUDE_API_KEY, 'sk-own'); assert.equal(v.CLAUDE_UPSTREAM, '');
  // 公司模型：经反代、上游 company；部门 key 的旧调用（不带选型）仍是网关。
  assert.equal(gw.launchValues({}, JSON.stringify({ kind: 'claude', source: 'company', model: 'GLM-5.2-WX' })).CLAUDE_UPSTREAM, 'company');
  assert.equal(gw.launchValues({}).CLAUDE_UPSTREAM, 'gateway');
  assert.ok(gw.resumeFields({ kind: 'claude', featureAgent: 'ppt', purpose: 'company-assistant', featureAgentChoice: r.opts.featureAgentChoice }));
});

test('来源对不上或没有来源的外壳选择不写入', t => {
  const dir = temp(t);
  assert.throws(() => choice.set(dir, 'help', { kind: 'claude', model: 'deepseek-v4.1-flash' }, { backends }), /模型来源/);
  assert.throws(() => choice.set(dir, 'help', { kind: 'claude', model: 'deepseek-v4.1-flash', source: 'company' }, { backends }));
  assert.throws(() => choice.set(dir, 'help', { kind: 'claude', model: 'claude-opus-5-5', source: 'gateway' }, { backends }));
  assert.throws(() => choice.set(dir, 'help', { kind: 'codex', model: 'qwen3-coder', source: 'api', profileId: 'p2' }, { backends }), /不可用/);
  assert.throws(() => choice.set(dir, 'help', { kind: 'claude', model: '', source: 'local' }, { backends }), /模型来源/);
  assert.equal(routes.featurePreference(dir, 'help'), null);
});

test('升级前存下的错误选择（claude-opus-5-5 / 本机默认模型）：不再照跑，本次回默认并提示重选', t => {
  const dir = temp(t);
  routes.setFeaturePreference(dir, 'help', { kind: 'claude', model: 'claude-opus-5-5' });
  routes.setFeaturePreference(dir, 'progress', { kind: 'codex', model: '' });
  for (const id of ['help', 'progress']) {
    const r = choice.resolve(dir, id, { backends });
    assert.equal(r.selected, null); assert.equal(r.legacy, true); assert.match(r.warning, /公司里用不了.*请重新选择/);
  }
  const help = choice.state(dir, { backends }).features.find(f => f.id === 'help');
  assert.equal(help.current.backend, 'claude'); assert.equal(help.legacy, true);
});

test('单次执行器：外壳 + 部门 key 经本机反代，不用 CLI 自己的登录；用前拉起反代', async t => {
  const dir = temp(t);
  require('../core/company-model-proxy').ensureEndpoint(dir, { preferredPort: 47123 });
  const ensured = [];
  choice.setRuntime({ ensureProxy: async source => { ensured.push(source); return { state: 'running' }; } });
  t.after(() => choice.setRuntime({ ensureProxy: null }));
  const calls = [];
  const runOnce = async request => { calls.push(request); return { code: 0, stdout: request.args.includes('--help') ? '--tools --model --print' : '回答' }; };
  const env = { ANTHROPIC_API_KEY: 'personal-login', PATH: process.env.PATH };
  const text = await require('../core/feature-agent-run').run({ kind: 'claude', source: 'gateway', model: 'deepseek-v4.1-flash' }, '问题', { dataDir: dir, runOnce, findCommand: () => 'fixture', env });
  assert.equal(text, '回答');
  assert.deepEqual(ensured, ['gateway']);
  const e = calls.at(-1).env;
  assert.equal(e.ANTHROPIC_BASE_URL, 'http://127.0.0.1:47123');
  assert.match(e.ANTHROPIC_AUTH_TOKEN, /__gw$/);
  assert.equal(e.ANTHROPIC_API_KEY, undefined);
  // 反代起不来：说人话，不悄悄用 CLI 自己的登录。
  choice.setRuntime({ ensureProxy: async () => ({ state: 'failed', message: '本机反代没有启动' }) });
  await assert.rejects(() => require('../core/feature-agent-run').run({ kind: 'claude', source: 'gateway', model: 'x' }, '问题', { dataDir: dir, runOnce, findCommand: () => 'fixture', env }), /本机反代没有启动/);
});

test('有功能选了外壳 + 来源时本机反代要常驻', t => {
  const dir = temp(t);
  assert.equal(choice.harnessInUse(dir), false);
  routes.setFeaturePreference(dir, 'help', { kind: 'claude', model: 'deepseek-v4.1-flash', source: 'gateway' });
  assert.equal(choice.harnessInUse(dir), true);
});

test('默认链只跟启动中心存下的线路走：部门 key / 公司模型经反代，自有接口 / 自有 API 直连，本机 CLI 配置照旧用 CLI（审查 P2）', t => {
  const dir = temp(t);
  const rows = backends.map(b => b.harness ? { ...b, defaultSource: 'gateway' } : b);
  const api = require('../core/company-api-config');
  let saved = { claude: { backend: 'proxy', upstream: 'gateway', model: 'glm-5.3-flash' } };
  t.mock.method(api, 'settings', () => saved);
  const gwRows = rows.map(b => b.harness ? { ...b, models: [...b.models, { id: 'glm-5.3-flash', source: 'gateway' }] } : b);
  assert.deepEqual(choice.harnessDefault(dir, 'claude', { backends: gwRows }), { kind: 'claude', source: 'gateway', model: 'glm-5.3-flash' });
  saved = { claude: { backend: 'proxy', upstream: '', model: 'GLM-5.2-WX' } };
  assert.deepEqual(choice.harnessDefault(dir, 'claude', { backends: rows }), { kind: 'claude', source: 'company', model: 'GLM-5.2-WX' });
  // 2026-11-27：启动中心选的是自有接口 / 自有 API 账号，也照它走（不再落回 CLI 自己的登录）。
  saved = { claude: { backend: 'api', model: 'own-model' } };
  assert.deepEqual(choice.harnessDefault(dir, 'claude', { backends: rows }), { kind: 'claude', source: 'own', model: 'own-model' });
  saved = { claude: { backend: 'api', model: 'qwen3-coder', selectedProfileId: 'p1', apiProfiles: [{ id: 'p1', model: 'qwen3-coder' }] } };
  assert.deepEqual(choice.harnessDefault(dir, 'claude', { backends: rows }), { kind: 'claude', source: 'api', model: 'qwen3-coder', profileId: 'p1' });
  saved = { claude: { backend: 'local' } };
  assert.equal(choice.harnessDefault(dir, 'claude', { backends: rows }), null);
  saved = { claude: { backend: 'proxy', upstream: 'gateway' } };
  assert.equal(choice.harnessDefault(dir, 'claude', { backends: rows.map(b => b.kind === 'claude' ? { ...b, available: false } : b) }), null);
});

test('部门 key 只要本机反代在跑：公司上游未就绪不拦网关，只拦公司模型（审查 P1）', async t => {
  t.after(() => choice.setRuntime({ ensureProxy: null }));
  choice.setRuntime({ ensureProxy: async () => ({ state: 'not-ready', message: 'CodeAgent 没就绪' }) });
  await choice.ensureProxy('gateway');
  await assert.rejects(() => choice.ensureProxy('company'), /CodeAgent 没就绪/);
  choice.setRuntime({ ensureProxy: async () => ({ state: 'stopped', message: '' }) });
  await assert.rejects(() => choice.ensureProxy('gateway'), /本机反代没有启动/);
});

test('问问 Hub 默认模型不再落到内置的 claude-opus / gpt；进展卡默认不标 Claude Haiku', t => {
  const dir = temp(t);
  const rows = backends.map(b => b.harness ? { ...b, defaultSource: 'gateway' } : b);
  const mc = require('../core/help-ask/model-choice');
  assert.equal(mc.defaultModel(dir, 'claude', { config: {} }), '');
  const progress = choice.state(dir, { backends: rows }).features.find(f => f.id === 'progress');
  assert.doesNotMatch(progress.defaultText, /Haiku|Claude/);
});

test('单次执行器：自有接口直连（不拉反代），连接经 --settings 覆盖；Codex 自有 API 账号写专用 CODEX_HOME；DSH 交给 ACP 单次问答', async t => {
  const dir = temp(t);
  const ensured = [];
  choice.setRuntime({ ensureProxy: async source => { ensured.push(source); return { state: 'running' }; } });
  t.after(() => choice.setRuntime({ ensureProxy: null }));
  const cfg = require('../core/company-api-config');
  t.mock.method(cfg, 'ownConnection', () => ({ baseURL: 'https://own.example/anthropic', apiKey: 'sk-own-0123456789', model: 'own-model' }));
  t.mock.method(require('../core/hub-config'), 'readConfigJsonForUpdate', () => ({ providers: { codex: { api_profiles: [{ id: 'p1', label: '组里的账号', baseURL: 'https://grp.example/v1', apiKey: 'sk-grp-0123456789', model: 'qwen3-coder', wireApi: 'chat' }] } } }));
  const calls = [], settings = [];
  const runOnce = async request => {
    calls.push(request);
    const at = request.args.indexOf('--settings');
    if (at >= 0) settings.push(JSON.parse(fs.readFileSync(request.args[at + 1], 'utf8')));
    if (request.args.includes('--help')) return { code: 0, stdout: '--tools --model --print --settings' };
    const out = request.args[request.args.indexOf('--output-last-message') + 1];
    if (out && request.args[0] === 'exec') fs.writeFileSync(out, '答');
    return { code: 0, stdout: '回答' };
  };
  const env = { ANTHROPIC_API_KEY: 'personal-login', OPENAI_API_KEY: 'personal', PATH: process.env.PATH };
  const run = require('../core/feature-agent-run').run;
  assert.equal(await run({ kind: 'claude', source: 'own', model: 'own-model' }, '问题', { dataDir: dir, runOnce, findCommand: () => 'fixture', env }), '回答');
  const e = calls.at(-1).env;
  assert.equal(e.ANTHROPIC_BASE_URL, 'https://own.example/anthropic'); assert.equal(e.ANTHROPIC_AUTH_TOKEN, 'sk-own-0123456789'); assert.equal(e.ANTHROPIC_API_KEY, undefined);
  assert.equal(settings.at(-1).env.ANTHROPIC_BASE_URL, 'https://own.example/anthropic');
  assert.deepEqual(ensured, [], '自有接口不拉反代');
  assert.equal(fs.readdirSync(path.join(dir, 'feature-agent-cwd')).filter(f => f.endsWith('.settings.json')).length, 0, '含 Key 的覆盖文件用完即删');

  assert.equal(await run({ kind: 'codex', source: 'api', profileId: 'p1', model: 'qwen3-coder' }, '问题', { dataDir: dir, runOnce, findCommand: () => 'fixture', env }), '答');
  const ce = calls.at(-1).env;
  assert.match(ce.CODEX_HOME, /feature-agent-codex/); assert.equal(ce.OPENAI_API_KEY, undefined);
  const toml = fs.readFileSync(path.join(ce.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(toml, /base_url = "https:\/\/grp\.example\/v1"/); assert.match(toml, /wire_api = "chat"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ce.CODEX_HOME, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'sk-grp-0123456789');

  const dsh = require('../core/dsh-oneshot');
  t.mock.method(dsh, 'run', async (sel, prompt) => `DSH:${sel.source}:${prompt}`);
  assert.equal(await run({ kind: 'deepseek-acp', source: 'gateway', model: 'deepseek-v4.1-flash' }, '问', { dataDir: dir, runOnce, findCommand: () => '', env }), 'DSH:gateway:问');
});

test('开箱即用：没装 CodeAgent、启动中心给 Claude Code 选了自有接口，会话功能默认就走它', t => {
  const dir = temp(t);
  const rows = backends.map(b => b.kind === 'codeagent' || b.kind === 'codeagent-lite' ? { ...b, available: false } : b);
  t.mock.method(require('../core/company-api-config'), 'settings', () => ({ claude: { backend: 'api', model: 'own-model' } }));
  const r = choice.resolve(dir, 'avatar', { backends: rows });
  assert.equal(r.auto, true); assert.deepEqual(r.selected, { kind: 'claude', source: 'own', model: 'own-model' });
  assert.equal(choice.session(dir, 'forum', 'codeagent', { purpose: 'company-forum' }, { backends: rows }).kind, 'claude');
  assert.equal(choice.resolve(dir, 'meeting', { backends: rows }).auto, true, '会议没选过也默认（R49-2 的 8 项）；本场手选仍优先');
  assert.match(choice.state(dir, { backends: rows }).features.find(f => f.id === 'avatar').defaultText, /^自有接口 · Claude Code · own-model/);
  // 有 CodeAgent 的不变。
  assert.equal(choice.resolve(dir, 'avatar', { backends }).selected, null);
});

test('PPT 库地图：没装 CodeAgent 时默认用启动中心为外壳存下的线路，不再退成规则分类', t => {
  const dir = temp(t);
  const rows = backends.map(b => b.kind === 'codeagent' || b.kind === 'codeagent-lite' ? { ...b, available: false } : b);
  t.mock.method(require('../core/company-api-config'), 'settings', () => ({ claude: { backend: 'local' }, codex: { backend: 'api', model: 'own-model' } }));
  assert.deepEqual(choice.resolve(dir, 'pptMap', { backends: rows }).selected, { kind: 'codex', source: 'own', model: 'own-model' });
  // 启动中心都没选过：取第一个可用外壳的首选（部门 key 优先）；首选是部门 key 时要 key 真存着。
  t.mock.method(require('../core/company-api-config'), 'settings', () => ({}));
  assert.equal(choice.resolve(dir, 'pptMap', { backends: rows }).selected, null, '没存部门 key 不自动走部门 key');
  t.mock.method(require('../core/api-gateway'), 'read', () => ({ keySet: true, models: [], customModels: [], model: '' }));
  assert.deepEqual(choice.resolve(dir, 'pptMap', { backends: rows }).selected, { kind: 'claude', source: 'gateway', model: 'deepseek-v4.1-flash' });
  assert.equal(choice.resolve(dir, 'help', { backends: rows }).selected, null, '问问 Hub 有自己的默认链');
  assert.equal(choice.resolve(dir, 'pptMap', { backends }).selected, null, '有 CodeAgent 不变');
});

test('替用户新开干活会话：有 CodeAgent 用 CodeAgent；没有就用启动中心配了模型来源的 Claude Code / Codex', () => {
  const find = have => kind => (have.includes(kind) ? 'C:/x/' + kind + '.exe' : '');
  assert.equal(choice.workKind({ findCommand: find(['codeagent', 'claude']), providers: {} }), 'codeagent');
  assert.equal(choice.workKind({ findCommand: find(['claude', 'codex']), providers: { claude: { backend: 'local' }, codex: { backend: 'api', model: 'm' } } }), 'codex');
  assert.equal(choice.workKind({ findCommand: find(['claude']), providers: { claude: { backend: 'proxy', upstream: 'gateway' } } }), 'claude');
  assert.equal(choice.workKind({ findCommand: find(['claude']), providers: { claude: { backend: 'local' } } }), 'codeagent', '都没配来源：仍按 CodeAgent，由原有提示说明');
});
