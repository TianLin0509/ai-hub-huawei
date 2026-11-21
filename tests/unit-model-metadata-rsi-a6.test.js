'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const models = require('../core/codeagent-models');
const probe = require('../core/codeagent-model-probe');
const pool = require('../core/codeagent-pool');
const { planSessionFork } = require('../core/session-fork-plan');
const ID = 'deepseek4.1';
const nativeId = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-metadata-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  probe.writeProbed(pool.personalModelsFile(dir), { source: 'serve', models: [ID], details: [
    { id: ID, provider: 'max', providerLabel: 'max', contextWindow: 400000 },
    { id: ID, provider: 'free', providerLabel: 'free', contextWindow: 200000 },
  ] });
  return dir;
}
test('unknown context has no invented window or percentage, but retains actual usage', () => {
  assert.deepEqual(models.contextWindowFor(null, ['unlisted-model']), { window: null, source: 'unknown' });
  assert.deepEqual(models.contextFromUsage({ input_tokens: 40000 }, null),
    { contextUsed: 40000, contextEffectiveMax: null, contextPct: null });
});
test('serve context uses the selected group; ambiguous same-name windows stay unknown', t => {
  const dir = fixture(t);
  assert.deepEqual(models.contextWindowFor(null, [ID], fs, { dataDir: dir, provider: 'max' }), { window: 400000, source: 'serve' });
  assert.deepEqual(models.contextWindowFor(null, [ID], fs, { dataDir: dir, provider: 'free' }), { window: 200000, source: 'serve' });
  assert.deepEqual(models.contextWindowFor(null, [ID], fs, { dataDir: dir }), { window: null, source: 'unknown' });
});
test('model options explain max/free and expose group-specific catalog limits', t => {
  const options = models.modelOptions(fixture(t));
  assert.match(options[0].label, /max.*高倍率/);
  assert.match(options[1].label, /free.*免费/);
  assert.equal(options[0].provider, 'max'); assert.equal(options[1].provider, 'free');
  assert.equal(options[0].contextWindow, 400000); assert.equal(options[1].contextWindow, 200000);
});
test('proxy display retains catalog total context while leaving the runtime cap unchanged', t => {
  const dir = fixture(t), catalog = require('../core/company-proxy/model-catalog.cjs');
  const parsed = catalog.parseCatalog([{ modelId: 'example-model', context: 400000, input: 334464, output: 65536 }]);
  assert.equal(parsed[0].contextWindow, 400000);
  catalog.writeCache(dir, { schema: 1, accounts: { personal: { models: parsed } } });
  const proxy = require('../core/company-model-proxy'), list = proxy.companyModels(dir);
  assert.equal(list[0].contextWindow, 400000);
  assert.equal(proxy.codexCatalog(['example-model'], undefined, list).models[0].context_window, 128000);
  const cards = require('../renderer/launch-model-cards').cardsFor('claude', { companyModels: list }, {}, {});
  assert.match(cards.find(c => c.id === 'example-model').tip, /400,000/);
});
test('composer explicitly displays unknown after real usage with no authoritative limit', () => {
  const context = require('../core/session-status-summary').composerContextRing({ contextUsed: 40000, contextPct: null });
  assert.equal(context.visible, true); assert.equal(context.percent, null); assert.match(context.title, /未知/);
  const node = () => ({ append() {}, appendChild() {}, setAttribute(key, value) { this[key] = value; },
    removeAttribute() {}, style: { setProperty() {} }, dataset: {} });
  const nodes = [], document = { createElement: () => { const el = node(); nodes.push(el); return el; } };
  const ui = require('../renderer/composer-context').createComposerContext(document);
  ui.update(context); assert.equal(nodes[1].textContent, '未知'); assert.equal(nodes[2].hidden, true);
  ui.update({ visible: true, percent: 10, level: 'ok' }); assert.equal(nodes[2].hidden, false);
});
test('composer model chip keeps the selected group visible without a duplicated suffix', () => {
  const summary = require('../core/session-status-summary');
  for (const displayName of [ID, `${ID} · free`, `${ID} · free（免费分组）`]) {
    const chip = summary.composerModelChip({ kind: 'codeagent', currentModel: { id: ID, displayName }, codeagentModelProvider: 'free' });
    assert.equal(chip.label, `${ID} · free（免费分组）`);
  }
});
test('fork preserves string-form source model and the exact provider metadata', () => {
  const source = { id: 'source', kind: 'codeagent', ccSessionId: nativeId, currentModel: ID,
    codeagentModelProvider: 'free', codeagentModelProviderLabel: 'free', codeagentModelMenuLabel: ID };
  const plan = planSessionFork({ source });
  assert.equal(plan.ok, true); assert.equal(plan.opts.model, ID);
  assert.equal(plan.opts.codeagentModelProvider, 'free');
  assert.equal(plan.opts.codeagentModelMenuLabel, ID);
  const nested = planSessionFork({ source: { ...source, codeagentModelProvider: '', currentModel: { id: ID, provider: 'max' } } });
  assert.equal(nested.opts.codeagentModelProvider, 'max');
});
test('reference carried into a new scene inherits its source model, account and group', async () => {
  const file = path.join(__dirname, '../renderer/renderer.js'), source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('async function switchSessionScene('), end = source.indexOf('\n// 「引用会话」', start);
  const calls = [], session = { id: 'source', kind: 'codeagent', currentModel: ID, codeagentPoolAccount: 'abcdef12',
    codeagentModelProvider: 'free', cwd: os.tmpdir() };
  const context = vm.createContext({ sessions: new Map([['source', session]]), floatingInputDrafts: new Map(),
    require: createRequire(file), document: {}, readContenteditablePlainText: () => '',
    ipcRenderer: { invoke: async (name, payload) => { calls.push({ name, payload });
      return name === 'session-reference:resolve' ? { ok: true, path: path.join(os.tmpdir(), 'source.md') } : {}; } } });
  vm.runInContext(source.slice(start, end), context);
  await context.switchSessionScene('source', 'general', null, { fresh: false });
  const opts = calls.find(row => row.name === 'create-session').payload.opts;
  assert.equal(opts.model, ID); assert.equal(opts.codeagentPoolAccount, 'abcdef12');
  assert.equal(opts.codeagentModelProvider, 'free');
});
test('turn context uses reported window; unknown GPT/GLM windows never become 128K/200K', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/turn-card-renderer.js'), 'utf8');
  let start = source.indexOf('function _modelCtxWindow(');
  if (start < 0) start = source.indexOf('function _fmtTokens(');
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, source.indexOf('\nfunction renderTurnSpeed(', start)), context);
  const pill = (model, usage) => context._renderMetaPills({ model, usage, role: 'assistant' });
  for (const model of ['gpt-new', 'GLM-new', null]) {
    assert.match(pill(model, { input_tokens: 40000 }), /上下文未知/);
    assert.doesNotMatch(pill(model, { input_tokens: 40000 }), /\d+% ctx/);
  }
  assert.match(pill(ID, { input_tokens: 40000, context_window: 400000 }), /10% ctx/);
});
