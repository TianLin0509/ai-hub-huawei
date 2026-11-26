'use strict';
// 公司版「功能使用的 Agent」：Claude Code / Codex / DSH 只当外壳，模型只来自部门 API key（网关）与公司模型（CodeAgent 账号），
// 和启动中心同一份枚举（2026-11-26 修正：以前会列出 claude-opus-5-5 这类公司里用不了的模型）。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const choice = require('../core/feature-agent-choice'), routes = require('../core/codeagent-assistant-route');
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-agent-harness-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const harnessModels = [{ id: 'deepseek-v4.1-flash', label: '部门 API key · deepseek-v4.1-flash', source: 'gateway' },
  { id: 'GLM-5.2-WX', label: '公司模型（CodeAgent 账号） · GLM-5.2-WX', source: 'company' }];
const backends = [
  { kind: 'codeagent', label: 'CodeAgent', available: true, models: [{ id: 'glm-test', provider: 'builtin' }] },
  { kind: 'codeagent-lite', label: 'CodeAgent-Lite（省内存）', available: true, models: [{ id: 'glm-test', provider: 'builtin' }] },
  { kind: 'claude', label: 'Claude Code', harness: true, available: true, models: harnessModels, defaultModel: 'deepseek-v4.1-flash' },
  { kind: 'codex', label: 'Codex', harness: true, available: true, models: harnessModels, defaultModel: 'deepseek-v4.1-flash' },
  { kind: 'deepseek-acp', label: 'DSH', harness: true, available: true, models: harnessModels },
  { kind: 'api-gateway', label: '部门 API key（网关）', available: true, defaultModel: 'deepseek-v4.1-flash', models: [{ id: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash' }], allowCustom: true },
];
const feature = id => choice.FEATURES.find(f => f.id === id);

test('会话功能：Claude Code 外壳只列部门 key 模型、存成原来的部门 key 线路；Codex / DSH 灰显并说明原因；不单列「部门 API key」', () => {
  const opts = choice.featureOptions(feature('assistant'), backends);
  assert.deepEqual(opts.map(o => o.value), ['codeagent', 'codeagent-lite', 'claude', 'codex', 'deepseek-acp']);
  const claude = opts.find(o => o.value === 'claude');
  assert.equal(claude.available, true); assert.equal(claude.store, 'api-gateway'); assert.equal(claude.allowCustom, true);
  assert.deepEqual(claude.models.map(m => m.value), ['deepseek-v4.1-flash']);
  assert.match(claude.models[0].label, /^部门 API key · /);
  for (const kind of ['codex', 'deepseek-acp']) { const o = opts.find(x => x.value === kind); assert.equal(o.available, false); assert.ok(o.reason); assert.equal(o.models.length, 0); }
  for (const o of opts) for (const m of o.models) assert.doesNotMatch(m.id || m.value, /opus|sonnet|haiku|gpt-/i);
});

test('单次功能：Claude Code / Codex 外壳都能选部门 key 或公司模型，值带来源；DSH 暂不支持', () => {
  const opts = choice.featureOptions(feature('help'), backends);
  const codex = opts.find(o => o.value === 'codex');
  assert.equal(codex.available, true);
  assert.deepEqual(codex.models.map(m => m.value), ['src:gateway:deepseek-v4.1-flash', 'src:company:GLM-5.2-WX']);
  assert.equal(opts.find(o => o.value === 'deepseek-acp').available, false);
});

test('下拉值 ↔ 存储：部门 key 会话、外壳 + 来源、空模型取首选，往返一致', t => {
  const dir = temp(t);
  assert.deepEqual(choice.choiceFromUi(dir, 'assistant', { backend: 'claude', model: 'deepseek-v4.1-flash' }, { backends }), { kind: 'api-gateway', model: 'deepseek-v4.1-flash' });
  assert.deepEqual(choice.choiceFromUi(dir, 'help', { backend: 'codex', model: 'src:company:GLM-5.2-WX' }, { backends }), { kind: 'codex', source: 'company', model: 'GLM-5.2-WX' });
  assert.deepEqual(choice.choiceFromUi(dir, 'help', { backend: 'claude', model: '' }, { backends }), { kind: 'claude', source: 'gateway', model: 'deepseek-v4.1-flash' });
  assert.equal(choice.choiceFromUi(dir, 'help', { backend: '', model: '' }, { backends }), null);
  assert.throws(() => choice.choiceFromUi(dir, 'assistant', { backend: 'codex', model: '' }, { backends }), /受控工具/);
  assert.throws(() => choice.choiceFromUi(dir, 'help', { backend: 'deepseek-acp', model: '' }, { backends }), /DSH/);

  choice.setFromUi(dir, 'help', { backend: 'codex', model: 'src:company:GLM-5.2-WX' }, { backends });
  assert.deepEqual(choice.resolve(dir, 'help', { backends }).selected, { kind: 'codex', model: 'GLM-5.2-WX', source: 'company' });
  choice.setFromUi(dir, 'assistant', { backend: 'claude', model: 'deepseek-v4.1-flash' }, { backends });
  const st = choice.state(dir, { backends });
  assert.deepEqual(st.features.find(f => f.id === 'help').current, { backend: 'codex', model: 'src:company:GLM-5.2-WX' });
  assert.deepEqual(st.features.find(f => f.id === 'assistant').current, { backend: 'claude', model: 'deepseek-v4.1-flash' });
  // 分身页、手填模型仍可直接存部门 key（兼容旧调用）。
  assert.equal(choice.resolve(dir, 'assistant', { backends }).selected.kind, 'api-gateway');
});

test('来源对不上或没有来源的外壳选择不写入', t => {
  const dir = temp(t);
  assert.throws(() => choice.set(dir, 'help', { kind: 'claude', model: 'deepseek-v4.1-flash' }, { backends }), /部门 API key 或公司模型/);
  assert.throws(() => choice.set(dir, 'help', { kind: 'claude', model: 'deepseek-v4.1-flash', source: 'company' }, { backends }));
  assert.throws(() => choice.set(dir, 'help', { kind: 'claude', model: 'claude-opus-5-5', source: 'gateway' }, { backends }));
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

test('默认链只跟启动中心存下的线路走：选了部门 key / 公司模型才经反代，自有接口或本机配置照旧用 CLI（审查 P2）', t => {
  const dir = temp(t);
  const rows = backends.map(b => b.harness ? { ...b, defaultSource: 'gateway' } : b);
  const api = require('../core/company-api-config');
  let saved = { claude: { backend: 'proxy', upstream: 'gateway', model: 'glm-5.3-flash' } };
  t.mock.method(api, 'settings', () => saved);
  const gwRows = rows.map(b => b.harness ? { ...b, models: [...b.models, { id: 'glm-5.3-flash', source: 'gateway' }] } : b);
  assert.deepEqual(choice.harnessDefault(dir, 'claude', { backends: gwRows }), { kind: 'claude', source: 'gateway', model: 'glm-5.3-flash' });
  saved = { claude: { backend: 'proxy', upstream: '', model: 'GLM-5.2-WX' } };
  assert.deepEqual(choice.harnessDefault(dir, 'claude', { backends: rows }), { kind: 'claude', source: 'company', model: 'GLM-5.2-WX' });
  saved = { claude: { backend: 'api', model: 'x' } };
  assert.equal(choice.harnessDefault(dir, 'claude', { backends: rows }), null);
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
