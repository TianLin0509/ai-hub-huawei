'use strict';

// R45（2026-11-25）「自有接口的模型只能选一个」「网关只能用检测到的模型，不能完全自定义」：
// 一个自有接口 / API 账号可以配多个模型，启动中心每个模型一张卡；老配置不用重配照常能用；网关手填测通的模型在启动中心也能选。
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../core/company-api-config');
const profiles = require('../core/cli-api-profiles');
const cards = require('../renderer/launch-model-cards');

test('模型表：去重、默认模型排第一、逗号 / 换行都能分隔，名字带空格时说清', () => {
  assert.deepEqual(api.modelList('glm-5.3-flash, deepseek-v4.1-flash\nqwen3.8-27b，glm-5.3-flash', 'deepseek-v4.1-flash'),
    ['deepseek-v4.1-flash', 'glm-5.3-flash', 'qwen3.8-27b']);
  assert.deepEqual(api.modelList(['GLM-5.3-Auto(Volcano-MaaS)'], ''), ['GLM-5.3-Auto(Volcano-MaaS)']);
  assert.throws(() => api.modelList('bad name', ''), /格式不对/);
});

test('Codex 自有接口存多个模型；只改 Key 不丢模型表；清空可选模型回到单模型', () => {
  let raw = api.withSettings({}, { kind: 'codex', baseURL: 'http://dept/v1', apiKey: 'sk-1', model: 'glm-5.3-flash', models: 'glm-5.3-flash, deepseek-v4.1-flash, qwen3.8-27b', wireApi: 'chat' });
  assert.deepEqual(raw.providers.codex.model_list, ['glm-5.3-flash', 'deepseek-v4.1-flash', 'qwen3.8-27b']);
  assert.equal(raw.providers.codex.model, 'glm-5.3-flash');
  const view = api.settings(raw).codex;
  assert.deepEqual(view.ownModels, ['glm-5.3-flash', 'deepseek-v4.1-flash', 'qwen3.8-27b']);
  assert.deepEqual(view.own.models, ['glm-5.3-flash', 'deepseek-v4.1-flash', 'qwen3.8-27b']);
  assert.doesNotMatch(JSON.stringify(view), /sk-1/, '界面视图不带 Key');
  // 不传 models（例如只换 Key）：模型表沿用
  raw = api.withSettings(raw, { kind: 'codex', baseURL: 'http://dept/v1', apiKey: 'sk-2', model: 'glm-5.3-flash', wireApi: 'chat' });
  assert.equal(raw.providers.codex.model_list.length, 3);
  // 清空可选模型：只剩默认模型，不写模型表
  raw = api.withSettings(raw, { kind: 'codex', baseURL: 'http://dept/v1', apiKey: '', model: 'glm-5.3-flash', models: '', wireApi: 'chat' });
  assert.equal(raw.providers.codex.model_list, undefined);
  assert.equal(api.settings(raw).codex.ownModels, undefined);
});

test('默认模型没填、可选模型填了：取第一个当默认', () => {
  const raw = api.withSettings({}, { kind: 'deepseek-acp', baseURL: 'http://dept/v1', apiKey: 'k', model: '', models: 'm-a, m-b' });
  assert.equal(raw.acp.companyApi.model, 'm-a');
  assert.deepEqual(raw.acp.companyApi.modelList, ['m-a', 'm-b']);
  assert.deepEqual(api.settings(raw)['deepseek-acp'].ownModels, ['m-a', 'm-b']);
});

test('切到 API 网关再切回自有接口：模型表跟着留住、跟着回来', t => {
  t.mock.method(require('../core/api-gateway'), 'configured', () => true);
  t.mock.method(require('../core/api-gateway'), 'resolveModel', (_dir, m) => m || 'deepseek-v4.1-flash');
  let raw = api.withSettings({}, { kind: 'claude', baseURL: 'http://a', apiKey: 'k', model: 'm1', models: 'm1, m2' });
  raw = api.withSettings(raw, { kind: 'claude', backend: 'gateway', model: '' });
  assert.deepEqual(raw.providers.claude.own_api.model_list, ['m1', 'm2']);
  raw = api.withSettings(raw, { kind: 'claude', backend: 'own' });
  assert.equal(raw.providers.claude.backend, 'api');
  assert.deepEqual(raw.providers.claude.model_list, ['m1', 'm2']);
});

test('老配置（只有一个 model）：视图和卡片与以前一致，不用重新配置', () => {
  const raw = { providers: { claude: { backend: 'api', base_url: 'http://a', api_key: 'k', model: 'm1' } } };
  const view = api.settings(raw).claude;
  assert.equal(view.ownModels, undefined);
  assert.equal(view.own.models, undefined);
  const list = cards.cardsFor('claude', view, null, { source: 'own', model: 'm1' }).filter(c => c.source === 'own');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'own');
  assert.equal(list[0].checked, true);
});

test('启动中心：一个自有接口多个模型 → 每个模型一张卡，选哪张会话就用哪个模型', () => {
  const provider = { backend: 'api', model: 'm1', ownModels: ['m1', 'm2', 'm3'], own: { backend: 'api', model: 'm1', models: ['m1', 'm2', 'm3'] }, companyModels: [] };
  const list = cards.cardsFor('codex', provider, null, { source: 'own', model: 'm2' }).filter(c => c.source === 'own');
  assert.deepEqual(list.map(c => c.id), ['own', 'own#m2', 'own#m3']);
  assert.deepEqual(list.map(c => c.name), ['m1', 'm2', 'm3']);
  assert.deepEqual(list.map(c => c.checked), [false, true, false]);
  // 没指定模型的老选择 → 默认模型那张亮
  assert.deepEqual(cards.cardsFor('codex', provider, null, { source: 'own', model: '' }).filter(c => c.source === 'own').map(c => c.checked), [true, false, false]);
  assert.deepEqual(cards.parseCardId('own#m2'), { base: 'own', model: 'm2' });
  assert.deepEqual(cards.parseCardId('api:abc_1#vendor/model:v2'), { base: 'api:abc_1', model: 'vendor/model:v2' });
  assert.deepEqual(cards.parseCardId('gw:glm#x'), { base: 'gw:glm#x', model: '' }, '网关卡不按 # 拆');
});

test('API 账号多模型：保存、公开视图、启动卡和群成员来源判断都认模型表', () => {
  let raw = api.withSettings({}, { kind: 'codex', profileAction: 'save', label: '供应商 A', baseURL: 'http://a/v1', apiKey: 'sk-a', model: 'm1', models: 'm1, m2', wireApi: 'chat' });
  const saved = profiles.profiles(raw, 'codex')[0];
  assert.deepEqual(saved.modelList, ['m1', 'm2']);
  const pub = profiles.publicProfiles(raw, 'codex')[0];
  assert.deepEqual(pub.models, ['m1', 'm2']);
  assert.equal(pub.apiKey, undefined);
  assert.deepEqual(raw.providers.codex.model_list, ['m1', 'm2'], '选中账号时模型表一并带上');
  const provider = { ...api.settings(raw).codex, companyModels: [] };
  const list = cards.cardsFor('codex', provider, null, { source: 'api', profileId: saved.id, model: 'm2' }).filter(c => c.source === 'api');
  assert.deepEqual(list.map(c => [c.detail, c.checked]), [['m1', false], ['m2', true]]);
  assert.equal(list[1].id, `api:${saved.id}#m2`);
  // 群成员用这个账号的第二个模型：仍算这个账号，不悄悄换到网关
  const reqs = cards.memberSaveRequests([{ kind: 'codex', model: 'm2' }], { codex: { ...provider, gatewayModels: [{ id: 'm2' }] } });
  assert.deepEqual(reqs, [{ kind: 'codex', profileAction: 'select', profileId: saved.id }]);
});

test('网关手填测通的模型：进可选表（带「手填」说明），默认模型能设成它', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r45-gw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gw = require('../core/api-gateway');
  fs.mkdirSync(path.join(dir, 'api-gateway'), { recursive: true });
  fs.writeFileSync(gw.file(dir), JSON.stringify({ encryptedKey: 'x', models: ['deepseek-v4.1-flash'], model: 'deepseek-v4.1-flash', customModels: ['deepseek-v4.1-flash-1017'] }));
  t.mock.method(require('../core/data-dir'), 'getHubDataDir', () => dir);
  const view = api.gatewayView();
  assert.deepEqual(view.choices.map(c => c.id), ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017']);
  assert.match(view.choices[1].note, /手填/);
  gw.setModel(dir, 'deepseek-v4.1-flash-1017');
  assert.equal(gw.read(dir).model, 'deepseek-v4.1-flash-1017');
  assert.throws(() => gw.setModel(dir, 'never-tested'), /没有这个模型/);
});

// ---- R45-3 审查修复（job 20261125-224938-b99858）----
const fsx = require('node:fs'), osx = require('node:os'), pathx = require('node:path');

test('P1-1 网关模型表（DSH / Codex 走网关时的模型定义）含手填测通的模型', t => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'r45-gwids-'));
  t.after(() => fsx.rmSync(dir, { recursive: true, force: true }));
  const gw = require('../core/api-gateway');
  fsx.mkdirSync(pathx.join(dir, 'api-gateway'), { recursive: true });
  fsx.writeFileSync(gw.file(dir), JSON.stringify({ encryptedKey: 'x', models: ['a1'], model: 'a1', customModels: ['a1-1017'] }));
  assert.deepEqual(require('../core/company-model-proxy').gatewayModelIds(dir), ['a1', 'a1-1017']);
});

test('P1-2 DSH 自有接口模型名带括号、斜杠、冒号：启动不再被模型名口径拦下', { skip: !api.isCompany() }, t => {
  const dataDir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'r45-dsh-name-'));
  t.after(() => fsx.rmSync(dataDir, { recursive: true, force: true }));
  const runtime = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'r45-dsh-rt-'));
  t.after(() => fsx.rmSync(runtime, { recursive: true, force: true }));
  for (const rel of ['node_modules/@deepseek-ai/dsh/lib/bin.js', 'node_modules/@deepseek-harness-tui/dsh-tui/package.json']) {
    fsx.mkdirSync(pathx.dirname(pathx.join(runtime, rel)), { recursive: true }); fsx.writeFileSync(pathx.join(runtime, rel), '{}');
  }
  const own = { baseURL: 'http://own.example.test/v1', apiKey: 'sk-own-x', model: 'GLM-5.3-Auto(Volcano-MaaS)', modelList: ['GLM-5.3-Auto(Volcano-MaaS)', 'vendor/m:2'] };
  const config = api.applyCompanyConfig({ acp: { nodePath: process.execPath, providers: { 'deepseek-acp': { cliRoot: runtime } } } }, { acp: { companyApi: own } });
  const build = model => require('../core/dsh-cli-profile').buildDshCliOptions('deepseek-acp', { id: 'n-' + Math.random().toString(36).slice(2), cwd: dataDir, model }, config, dataDir, { PATH: process.env.PATH });
  assert.doesNotThrow(() => build('GLM-5.3-Auto(Volcano-MaaS)'));
  assert.doesNotThrow(() => build('vendor/m:2'));
  assert.throws(() => build('bad name'), /格式不对/);
});

test('P1-3 启动中心模型卡多时折叠：3 行 = 8 张 +「更多模型（+K）」，选中的卡一定可见；展开后全显示并有「收起」', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ id: 'own#m' + i, name: 'm' + i, source: 'own', checked: i === 12 }));
  const folded = cards.foldCards(many);
  assert.equal(folded.length, 9);
  assert.equal(folded.at(-1).id, 'more');
  assert.match(folded.at(-1).name, /更多模型（\+6）/);
  assert.ok(folded.some(c => c.checked), '选中的卡在可见区');
  const open = cards.foldCards(many, { expanded: true });
  assert.equal(open.length, 15);
  assert.equal(open.at(-1).name, '收起');
  assert.equal(cards.foldCards(many.slice(0, 9)).length, 9, '不超过 9 张原样显示');
  assert.match(cards.renderCards(folded, s => String(s)), /data-model-card="more" data-source="more"/);
});

test('P2-1 启动中心选了自有接口 / API 账号的另一个模型：记成默认，下次打开默认选它', t => {
  t.mock.method(require('../core/api-gateway'), 'configured', () => true);
  t.mock.method(require('../core/api-gateway'), 'resolveModel', (_dir, m) => m || 'g1');
  // 自有接口（当前就走它）
  let raw = api.withSettings({}, { kind: 'codex', baseURL: 'http://a/v1', apiKey: 'k', model: 'm1', models: 'm1, m2', wireApi: 'chat' });
  let provider = { ...api.settings(raw).codex, companyModels: [] };
  const req = cards.saveRequest('codex', provider, { source: 'own', model: 'm2' });
  assert.deepEqual(req, { kind: 'codex', ownModel: 'm2' });
  raw = api.withSettings(raw, req);
  assert.equal(raw.providers.codex.model, 'm2');
  assert.deepEqual(raw.providers.codex.model_list, ['m1', 'm2']);
  provider = { ...api.settings(raw).codex, companyModels: [] };
  assert.deepEqual(cards.defaultPick('codex', provider), { source: 'own', model: 'm2' });
  assert.equal(cards.saveRequest('codex', provider, { source: 'own', model: 'not-in-list' }), null, '表外的不记');
  // 走网关时选自有接口的第二个模型：切回自有接口并记住
  raw = api.withSettings(raw, { kind: 'codex', backend: 'gateway', model: '' });
  provider = { ...api.settings(raw).codex, companyModels: [] };
  const back = cards.saveRequest('codex', provider, { source: 'own', model: 'm1' });
  assert.deepEqual(back, { kind: 'codex', backend: 'own', ownModel: 'm1' });
  raw = api.withSettings(raw, back);
  assert.equal(raw.providers.codex.backend, 'api');
  assert.equal(raw.providers.codex.model, 'm1');
  // API 账号
  let r2 = api.withSettings({}, { kind: 'claude', profileAction: 'save', label: 'A', baseURL: 'http://a', apiKey: 'ka', model: 'p1', models: 'p1, p2' });
  const id = profiles.profiles(r2, 'claude')[0].id;
  const pReq = cards.saveRequest('claude', { ...api.settings(r2).claude, companyModels: [] }, { source: 'api', profileId: id, model: 'p2' });
  assert.deepEqual(pReq, { kind: 'claude', profileAction: 'select', profileId: id, model: 'p2' });
  r2 = api.withSettings(r2, pReq);
  assert.equal(profiles.profiles(r2, 'claude')[0].model, 'p2');
  assert.equal(r2.providers.claude.model, 'p2');
  assert.deepEqual(cards.defaultPick('claude', { ...api.settings(r2).claude, companyModels: [] }), { source: 'api', profileId: id, model: 'p2' });
});

test('P2-2 首次加账号时「原有接口」带上模型表；删掉选中的账号时顶层模型表跟着换', () => {
  let raw = api.withSettings({}, { kind: 'codex', baseURL: 'http://old/v1', apiKey: 'ko', model: 'o1', models: 'o1, o2', wireApi: 'chat' });
  raw = api.withSettings(raw, { kind: 'codex', profileAction: 'save', label: '新账号', baseURL: 'http://new/v1', apiKey: 'kn', model: 'n1', wireApi: 'chat' });
  const [legacy, fresh] = profiles.profiles(raw, 'codex');
  assert.equal(legacy.label, '原有接口');
  assert.deepEqual(legacy.modelList, ['o1', 'o2']);
  assert.equal(raw.providers.codex.selected_api_profile, fresh.id);
  assert.equal(raw.providers.codex.model_list, undefined, '新账号只有一个模型，顶层不留旧表');
  raw = api.withSettings(raw, { kind: 'codex', profileAction: 'delete', profileId: fresh.id });
  assert.equal(raw.providers.codex.selected_api_profile, legacy.id);
  assert.deepEqual(raw.providers.codex.model_list, ['o1', 'o2']);
  raw = api.withSettings(raw, { kind: 'codex', profileAction: 'delete', profileId: legacy.id });
  assert.equal(raw.providers.codex.model_list, undefined);
});

test('P2-3 走网关时补填自有接口 Key（表单没带可选模型）：留着的模型表不被清掉；补 Key 视图带模型表', t => {
  t.mock.method(require('../core/api-gateway'), 'configured', () => true);
  t.mock.method(require('../core/api-gateway'), 'resolveModel', (_dir, m) => m || 'g1');
  let raw = api.withSettings({}, { kind: 'claude', baseURL: 'http://a', apiKey: 'k', model: 'm1', models: 'm1, m2' });
  raw = api.withSettings(raw, { kind: 'claude', backend: 'gateway', model: '' });
  raw.providers.claude.own_api = { ...raw.providers.claude.own_api, api_key: '', encrypted_api_key: 'x', api_keyNeedsInput: true };
  assert.deepEqual(api.settings(raw).claude.ownConnection.ownModels, ['m1', 'm2']);
  raw = api.withSettings(raw, { kind: 'claude', baseURL: 'http://a', apiKey: 'k2', model: 'm1' });
  assert.deepEqual(raw.providers.claude.model_list, ['m1', 'm2']);
});
