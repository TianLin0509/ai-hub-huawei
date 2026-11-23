'use strict';
// 后台（终端里 /model）换了 CodeAgent 模型后，输入框下方的模型要跟着改（2026-11-19 反馈 20261119T080512Z-3d260a3c）。
// 真机日志：current=maas-glm-5.2-volcengine-codeagent actual=maas-glm-5-3-260814，同一家被当作 Auto 分流，显示一直是旧的。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const models = require('../core/codeagent-models');

const CATALOG = ['GLM-5.3-Auto(Volcano-MaaS)', 'GLM-5.2-Auto(Tencent-MaaS)', 'GLM-5.3-Auto(Baidu-MaaS)',
  'maas-glm-5.2-volcengine-codeagent', 'maas-DeepSeek-V4.1'].map(id => ({ id }));

test('会话记录里的实际模型去前缀后唯一对应账号清单，同版本不同型号也同步', () => {
  const options = ['ascend/glm-5.3-flash', 'ascend/glm-5.3-pro'].map(id => ({ id }));
  const resolveSwitch = actual => models.resolveObservedSwitch(actual, { options });
  assert.equal(resolveSwitch('glm-5.3-flash'), 'ascend/glm-5.3-flash');
  assert.equal(models.resolveObservedSwitch('ascend/glm-5.3-flash', { options: ['glm-5.3-flash'] }), 'glm-5.3-flash');
  assert.equal(models.resolveObservedSwitch('glm-5.3-flash', { options: ['ascend/glm-5.3-flash', 'provider/glm-5.3-flash'], defaultModel: 'ascend/glm-5.3-flash' }), '');
  const session = { id: 'prefix-switch', kind: 'codeagent', fixedModel: 'ascend/glm-5.3-pro', currentModel: { id: 'ascend/glm-5.3-pro' } };
  const result = models.observeModel(session, 'glm-5.3-flash', { resolveSwitch, followActual: true });
  assert.equal(result.fields.currentModel.id, 'ascend/glm-5.3-flash');
  assert.equal(result.fields.fixedModel, 'ascend/glm-5.3-flash');
  assert.equal(result.fields.actualModel.id, 'glm-5.3-flash');
  assert.equal(result.mismatch, null);
});

test('手动切换后回答记录补上前缀时不误报失败，其他线路同名模型仍核对完整名称', () => {
  const session = { id: 'prefix-confirm', kind: 'codeagent', fixedModel: 'glm-5.3-flash', currentModel: { id: 'glm-5.3-flash' } };
  models.expectModelSwitch(session.id, 'glm-5.3-flash');
  const result = models.observeModel(session, 'ascend/glm-5.3-flash', { resolveSwitch: actual => models.resolveObservedSwitch(actual, { options: ['glm-5.3-flash'] }), followActual: true });
  assert.equal(result.mismatch, null);
  models.expectModelSwitch(session.id, 'ascend/glm-5.3-flash');
  const other = models.observeModel(session, 'provider/glm-5.3-flash', { resolveSwitch: actual => models.resolveObservedSwitch(actual, { options: ['ascend/glm-5.3-flash', 'provider/glm-5.3-flash'] }), followActual: true });
  assert.ok(other.mismatch);
});

test('同版本的旧后端别名不会跟随其他会话改过的账号默认模型', () => {
  const id = 'maas-glm-5.2-volcengine-codeagent';
  const session = { id: 'same-version-alias', kind: 'codeagent', fixedModel: id, currentModel: { id } };
  const result = models.observeModel(session, 'maas-glm-5-2-260617', {
    resolveSwitch: () => 'GLM-5.2-Auto(Tencent-MaaS)', followActual: true,
  });
  assert.equal(result.fields.currentModel, undefined);
  assert.equal(result.fields.fixedModel, undefined);
});

test('model versions are read after the family name; date-like or missing versions stay unknown', () => {
  assert.equal(models.modelVersion('maas-glm-5-3-260814'), '5.3');
  assert.equal(models.modelVersion('maas-glm-5.2-volcengine-codeagent'), '5.2');
  assert.equal(models.modelVersion('GLM-5.3-Auto(Volcano-MaaS)'), '5.3');
  assert.equal(models.modelVersion('deepseek-v4.1-flash'), '4.1');
  assert.equal(models.modelVersion('MiniMax-M2.7'), '2.7');
  assert.equal(models.modelVersion('deepseek0731'), '');
  assert.equal(models.modelVersion('dsv4-dspark'), '');
});

test('a same-family version change on a concrete model follows the backstage /model choice from the CodeAgent default', () => {
  const session = { id: 'bg-switch-1', kind: 'codeagent', fixedModel: 'maas-glm-5.2-volcengine-codeagent',
    currentModel: { id: 'maas-glm-5.2-volcengine-codeagent', displayName: 'maas-glm-5.2-volcengine-codeagent' } };
  // Same version on the backend name: unchanged (the menu id and backend id differ only in spelling).
  const same = models.observeModel(session, 'maas-glm-5-2-260617');
  assert.equal(same.fields.currentModel, undefined);
  const resolveSwitch = actual => models.resolveObservedSwitch(actual, { options: CATALOG, defaultModel: 'GLM-5.3-Auto(Volcano-MaaS)' });
  const observed = models.observeModel(session, 'maas-glm-5-3-260814', { resolveSwitch });
  assert.deepEqual(observed.fields.currentModel, { id: 'GLM-5.3-Auto(Volcano-MaaS)', displayName: 'GLM-5.3-Auto(Volcano-MaaS)' });
  assert.equal(observed.fields.fixedModel, 'GLM-5.3-Auto(Volcano-MaaS)', 'resume uses the model the user switched to');
  assert.equal(observed.fields.modelPinSource, 'cli');
  assert.equal(observed.mismatch, null, 'a deliberate switch is not reported as a permission problem');
  assert.deepEqual(observed.backendSwitch, { from: 'maas-glm-5.2-volcengine-codeagent', to: 'GLM-5.3-Auto(Volcano-MaaS)', resolved: true });
});

test('ambiguous candidates only change the display and keep the pinned launch model', () => {
  const session = { id: 'bg-switch-2', kind: 'codeagent', fixedModel: 'maas-glm-5.2-volcengine-codeagent',
    currentModel: { id: 'maas-glm-5.2-volcengine-codeagent' } };
  const resolveSwitch = actual => models.resolveObservedSwitch(actual, { options: CATALOG, defaultModel: 'maas-glm-5.2-volcengine-codeagent' });
  const observed = models.observeModel(session, 'maas-glm-5-3-260814', { resolveSwitch });
  assert.deepEqual(observed.fields.currentModel, { id: 'maas-glm-5-3-260814', displayName: 'maas-glm-5-3-260814' });
  assert.equal(observed.fields.fixedModel, undefined, 'never launch a resumed session with a backend-only name');
  assert.equal(observed.backendSwitch.resolved, false);
  assert.equal(models.resolveObservedSwitch('maas-glm-5-3-260814', { options: CATALOG.filter(o => !/Baidu/.test(o.id)) }), 'GLM-5.3-Auto(Volcano-MaaS)', 'a single candidate is enough');
});

test('Auto routing, Hub-requested switches and unknown versions keep the existing rules', () => {
  const auto = { id: 'bg-switch-3', kind: 'codeagent', currentModel: { id: 'GLM-5.3-Auto(Volcano-MaaS)' } };
  assert.equal(models.observeModel(auto, 'maas-glm-5-2-260617')?.fields?.currentModel, undefined, 'Auto may route to another version');
  const pending = { id: 'bg-switch-4', kind: 'codeagent', currentModel: { id: 'maas-glm-5.2-volcengine-codeagent' } };
  models.expectModelSwitch(pending.id, 'maas-glm-5.2-volcengine-codeagent');
  const checked = models.observeModel(pending, 'maas-glm-5-3-260814', { resolveSwitch: () => 'GLM-5.3-Auto(Volcano-MaaS)' });
  assert.equal(checked.backendSwitch, undefined, 'a Hub switch in flight is verified by the mismatch rule instead');
  const unknown = { id: 'bg-switch-5', kind: 'codeagent', currentModel: { id: 'deepseek0731' } };
  assert.equal(models.observeModel(unknown, 'deepseek-v4.1-flash')?.fields?.currentModel, undefined);
});

test('main passes the account catalog and the CodeAgent default model to the resolver and logs the switch kind', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /observeModel\(session, modelId, \{ at: modelAt, resolveSwitch, followActual: true \}\)/);
  assert.match(source, /resolveAccountModel\(actual, \{/);
  assert.match(source, /backendSwitch: observed\.backendSwitch\.resolved \? 'menu' : 'display-only'/);
});

// ---- 2026-11-18 反馈 20261118T063101Z-147541f7：自配了很多模型，下拉只出现 serve 报的 5 个 ----
const os = require('node:os');
const serve = require('../core/codeagent-serve');
const probe = require('../core/codeagent-model-probe');

test('serve parsing records providers it skipped, with status and model count', () => {
  const parsed = serve.parseProviders({ providers: [
    { id: 'w3', status: 'available', models: { 'dsv4-dspark': { id: 'dsv4-dspark' } } },
    { id: 'my-provider', status: 'unavailable', models: { a: { id: 'a' }, b: { id: 'b' } } },
  ] });
  assert.deepEqual(parsed.models.map(m => m.id), ['dsv4-dspark']);
  assert.deepEqual(parsed.skipped, [{ id: 'my-provider', status: 'unavailable', models: 2, modelIds: ['a', 'b'], label: 'my-provider' }]);
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'session-handlers.js'), 'utf8');
  assert.match(source, /skippedProviders: served\.skipped\.map/, 'serve-read log names the skipped providers');
});

test('models the user configured under enterprise.providers are added after the serve catalog', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-settings-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'), cac = path.join(root, '.cac');
  fs.mkdirSync(path.join(data, 'codeagent-pool'), { recursive: true }); fs.mkdirSync(cac, { recursive: true });
  const served = ['deepseek-v4.1-flash', 'glm-5.3-flash', 'qwen3.8-27b', 'qwen-aw-35b', 'dsv4-dspark'];
  probe.writeProbed(path.join(data, 'codeagent-pool', 'personal-models.json'), { models: served, source: 'serve' });
  fs.writeFileSync(path.join(cac, 'settings.json'), JSON.stringify({ model: 'dsv4-dspark', enterprise: { providers: {
    'team-a': { provider: 'openai', protocol: 'openai', apiBaseUrl: 'http://x.invalid/v1', apiKey: 'xxx', mainModel: 'dsv4-dspark', smallModel: 'kimi-k3-mini', deepModel: 'dsr2-think', vlModel: 'qwen3-vl-32b' },
    'team-b': { mainModel: 'glm-5.3-flash', modelCapabilities: { 'minimax-m3-int': { contextWindow: 200000 } } },
  } } }));
  const options = models.modelOptions(data, { configDir: cac });
  assert.deepEqual(options.map(o => o.id), [...served, 'dsv4-dspark', 'kimi-k3-mini', 'dsr2-think', 'glm-5.3-flash', 'minimax-m3-int'], '先列 serve 清单，再列各自配供应商；同名但供应商不同的项保留，视觉专用模型不列入');
  assert.equal(options.find(o => o.id === 'dsv4-dspark' && o.source === 'settings').provider, 'team-a');
  assert.equal(options.find(o => o.id === 'glm-5.3-flash' && o.source === 'settings').provider, 'team-b');
  const extra = options.find(o => o.id === 'kimi-k3-mini');
  assert.equal(extra.source, 'settings'); assert.equal(extra.label, 'kimi-k3-mini · team-a');
  assert.ok(!JSON.stringify(options).includes('x.invalid') && !JSON.stringify(options).includes('xxx'), 'never copies endpoints or keys');
  fs.writeFileSync(path.join(cac, 'settings.json'), JSON.stringify({ model: 'dsv4-dspark' }));
  assert.deepEqual(models.modelOptions(data, { configDir: cac }).map(o => o.id), served, 'no enterprise.providers: unchanged');
});

// ---- 2026-11-19 审查补点（fix1）----
test('a major-only backend name is the same generation as any minor of that major', () => {
  assert.equal(models.modelVersion('maas-glm-5-260814'), '5');
  assert.equal(models.versionsDiffer('5.1', '5'), false);
  assert.equal(models.versionsDiffer('5.1', '5.3'), true);
  assert.equal(models.versionsDiffer('4', '5'), true);
  const session = { id: 'gen-1', kind: 'codeagent', fixedModel: 'glm-5.1', currentModel: { id: 'glm-5.1' } };
  const observed = models.observeModel(session, 'maas-glm-5-260814', { resolveSwitch: () => { throw new Error('must not resolve'); } });
  assert.equal(observed.fields.currentModel, undefined, 'glm-5.1 answered as maas-glm-5-260814 is not a switch');
  assert.equal(observed.backendSwitch, undefined);
});

test('one unresolved backend switch is written once, not on every later answer', () => {
  const session = { id: 'once-1', kind: 'codeagent', fixedModel: 'maas-glm-5.2-volcengine-codeagent',
    currentModel: { id: 'maas-glm-5.2-volcengine-codeagent' } };
  const first = models.observeModel(session, 'maas-glm-5-3-260814', { resolveSwitch: () => '' });
  assert.equal(first.backendSwitch.resolved, false);
  assert.equal(first.fields.codeagentBackendSwitch.from, 'maas-glm-5.2-volcengine-codeagent');
  assert.equal(first.fields.codeagentBackendSwitch.actual, 'maas-glm-5-3-260814');
  Object.assign(session, first.fields);
  assert.equal(models.observeModel(session, 'maas-glm-5-3-260814', { resolveSwitch: () => '' }), null, 'second answer: nothing to write or log');
  assert.equal(models.observeModel(session, 'maas-glm-5-3-260814', { resolveSwitch: () => '' }), null, 'third answer: still nothing');
  const again = models.observeModel(session, 'maas-glm-5-4-261001', { resolveSwitch: () => '' });
  assert.equal(again.fields.codeagentBackendSwitch.actual, 'maas-glm-5-4-261001', 'a further generation is noted again');
});

test('the vision model of a provider never enters the chat dropdown, even via modelCapabilities', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-settings-vl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ enterprise: { providers: {
    p: { mainModel: 'glm-5.3-int', vlModel: 'qwen3-vl-32b', modelCapabilities: { 'qwen3-vl-32b': {}, 'glm-5.3-int': {} } },
    q: { mainModel: 'shared-vl-and-chat', vlModel: 'shared-vl-and-chat' },
  } } }));
  assert.deepEqual(models.settingsProviderModels(root).map(r => r.id), ['glm-5.3-int', 'shared-vl-and-chat'], 'a model also used as a chat slot stays');
});

test('configured-only models are left out of the meeting fast-model pick', () => {
  const ctx = require('../core/company-assistant/meeting-context');
  const listed = [{ id: 'GLM-5.2-WX-Auto', label: 'GLM-5.2 Auto' }, { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
    { id: 'my-flash-int', label: 'my-flash-int · team', source: 'settings' }];
  const options = ctx.modelOptions({ meetingModels: () => listed });
  assert.deepEqual(options.map(m => m.id), ['GLM-5.2-WX-Auto', 'MiniMax-M2.7']);
  assert.equal(ctx.fastModel(options), 'MiniMax-M2.7', 'the configured flash model is not auto-picked');
  assert.equal(ctx.selectedModel({ speed: 'fast' }, { meetingModels: () => listed }), 'MiniMax-M2.7');
});

test('resume launches with the last confirmed model instead of reverting a backstage /model switch', t => {
  const pins = require('../core/session-model-pin');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-resume-pin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cac = path.join(root, '.cac'), data = path.join(root, 'data');
  fs.mkdirSync(cac, { recursive: true }); fs.mkdirSync(data, { recursive: true });
  const writeDefault = model => fs.writeFileSync(path.join(cac, 'settings.json'), JSON.stringify({ model }));
  const pool = { account: { models: [], modelsAuthoritative: false } };
  const opts = { dataDir: data, configDir: cac, command: 'codeagent', pool };
  const marker = { from: 'maas-glm-5.2-volcengine-codeagent', actual: 'maas-glm-5-3-260814', at: 1 };
  const base = { fixedModel: 'maas-glm-5.2-volcengine-codeagent', modelPinSource: 'user', resumeCCSessionId: 'x', codeagentBackendSwitch: marker };
  assert.deepEqual(pins.modelPinFields(base).codeagentBackendSwitch, marker, 'the marker survives into the resume options');
  writeDefault('GLM-5.3-Volcano-int');
  const resumed = pins.resolveCodeAgentPin(base, opts);
  assert.equal(resumed.fixedModel, 'GLM-5.3-Volcano-int', 'the model the terminal /model confirmed');
  assert.equal(resumed.modelPinSource, 'cli');
  assert.equal(pins.resolveCodeAgentPin({ ...base, fixedModel: 'MiniMax-M2.7' }, opts).fixedModel, 'MiniMax-M2.7', 're-picked in Hub later: marker is stale');
  writeDefault('GLM-5.2-WX-Auto');
  assert.equal(pins.resolveCodeAgentPin(base, opts).fixedModel, base.fixedModel, 'default of another generation is not trusted');
  writeDefault('deepseek-v4.1-flash');
  assert.equal(pins.resolveCodeAgentPin(base, opts).fixedModel, base.fixedModel, 'default of another family is not trusted');
  writeDefault('GLM-5.3-Volcano-int');
  assert.equal(pins.resolveCodeAgentPin({ ...base, codeagentBackendSwitch: undefined }, opts).fixedModel, base.fixedModel, 'no marker: unchanged');
  const persist = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'persistence-handlers.js'), 'utf8');
  assert.match(persist, /'codeagentBackendSwitch'/, 'the marker is kept across renderer saves');
});
