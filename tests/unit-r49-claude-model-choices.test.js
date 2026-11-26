'use strict';

// R49（2026-11-26 一键反馈 v5.6.116）「我想选其他模型，但是给的选项里面只能选这几个，我也没有这些模型」：
// 只配了部门 key / 自有接口、没有 CodeAgent 权限、没有 Claude 官方订阅的人，所有选模型的地方都要列他接口上的模型。
const test = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../renderer/launch-model-cards');
const { setRuntimeModelOptions, clearRuntimeModelOptions, modelOptionsFor } = require('../core/model-options');
const { createModelUiController } = require('../renderer/model-ui.js');

const OFFICIAL = /\b(?:Opus|Sonnet|Haiku|Fable)\b|claude-(?:opus|sonnet|haiku|fable)/;
const COMPANY = [{ id: 'GLM-5.2-WX', label: 'GLM-5.2-WX' }, { id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash' }];
const GATEWAY = [{ id: 'qwen-aw-35b', note: '首字 1.2 秒' }, { id: 'deepseek-v4.1-flash', note: '' }, { id: 'deepseek-v4.1-flash-0925', note: '手填 · 已测通' }];
// company-api-config.settings() 给启动中心的视图（不含 Key）：走 API 网关、本机没有 CodeAgent。
const gatewayUser = { backend: 'proxy', upstream: 'gateway', model: 'qwen-aw-35b', companyModels: COMPANY, models: COMPANY, gatewayModels: GATEWAY,
  own: { backend: 'local', model: '' }, companyDefault: false };
// 全新用户：只在启动中心 / 首页存了部门 key，还没选过来源。
const freshUser = { backend: 'local', model: '', companyModels: COMPANY, gatewayModels: GATEWAY, own: { backend: 'local', model: '' }, companyDefault: true };
// 自有接口（R45 多模型），没配网关。
const ownUser = { backend: 'api', model: 'ma-1', ownModels: ['ma-1', 'ma-2'], companyModels: COMPANY, own: { backend: 'api', model: 'ma-1', models: ['ma-1', 'ma-2'] }, companyDefault: false };

test('网关模型清单进入 Claude 的模型选择：网关表 + 手填测通的都在，没有 CodeAgent 时不列用不了的公司模型', () => {
  const list = cards.modelOptions('claude', gatewayUser, null, { codeagentInstalled: false });
  assert.deepEqual(list.filter(o => o.route === 'gateway').map(o => o.id), ['qwen-aw-35b', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-0925']);
  assert.equal(list.some(o => o.route === 'company'), false, '公司模型此刻用不了（模型卡上也不显示）就不进下拉');
  assert.doesNotMatch(JSON.stringify(list), OFFICIAL, '没有官方订阅：不列 Opus / Sonnet');
  // 全新用户（没选过来源、没装 CodeAgent）：网关模型同样在清单里
  const fresh = cards.modelOptions('claude', freshUser, null, { codeagentInstalled: false });
  assert.deepEqual(fresh.filter(o => o.route === 'gateway').map(o => o.id), GATEWAY.map(m => m.id));
  assert.doesNotMatch(JSON.stringify(fresh), OFFICIAL);
});

test('会话里切换：只列这个会话实际线路上的模型', () => {
  const list = cards.modelOptions('claude', { ...gatewayUser, gatewayModels: GATEWAY }, { state: 'running', accounts: [{ id: 'personal', kind: 'personal' }] }, { codeagentInstalled: true });
  assert.ok(list.some(o => o.route === 'company'), '有 CodeAgent 且公司模型可用时，启动清单仍有公司模型');
  const gwSession = { kind: 'claude', companyRoute: 'proxy', companyUpstream: 'gateway' };
  assert.deepEqual(cards.optionsForSession(list, gwSession).map(o => o.id), GATEWAY.map(m => m.id), '网关会话只能换网关模型');
  const companySession = { kind: 'claude', companyRoute: 'proxy' };
  assert.deepEqual(cards.optionsForSession(list, companySession).map(o => o.id), COMPANY.map(m => m.id));
  const ownSession = { kind: 'claude', companyRoute: 'api' };
  assert.deepEqual(cards.optionsForSession(cards.modelOptions('claude', ownUser, null, { codeagentInstalled: false }), ownSession).map(o => o.id), ['ma-1', 'ma-2'], '自有接口会话只列它的模型表');
  const plain = [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }];
  assert.equal(cards.optionsForSession(plain, gwSession), plain);
});

test('没有官方订阅时不列官方模型：公司版清单为空也不回落到内置的 Opus / Sonnet 清单', () => {
  try {
    setRuntimeModelOptions('claude', [{ id: '', label: '沿用本机 CLI 配置' }], { keepEmpty: true });
    assert.deepEqual(modelOptionsFor('claude'), []);
    assert.deepEqual(modelOptionsFor('claude-resume'), []);
    setRuntimeModelOptions('claude', []);
    assert.match(JSON.stringify(modelOptionsFor('claude')), OFFICIAL);
  } finally { clearRuntimeModelOptions('claude'); }
});

test('公司版「设为默认」的网关模型能读回来（以前被 Claude 官方名校验扔掉）', () => {
  const pref = require('../core/default-model-preference');
  assert.equal(require('../core/distribution').target, 'company');
  const config = pref.withDefaultModelInJson({}, 'claude', 'qwen-aw-35b', { availableIds: ['qwen-aw-35b', 'deepseek-v4.1-flash'] });
  assert.equal(pref.readDefaultModels({ defaultModels: config.models.defaults }).claude, 'qwen-aw-35b');
  assert.equal(pref.resolveDefaultModel('claude', { defaultModels: config.models.defaults }, ['qwen-aw-35b', 'deepseek-v4.1-flash']), 'qwen-aw-35b');
  assert.equal(pref.isModelValidForKind('claude', 'bad name'), false, '命令行安全校验照旧');
});

function fakeDocument() {
  const document = {
    defaultView: {},
    createElement() {
      const el = { children: [], dataset: {}, style: {}, className: '', ownerDocument: document, listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, remove() { this._removed = true; }, contains: () => false,
        appendChild(child) { this.children.push(child); }, getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, width: 200, height: 20 }) };
      el.classList = { add(name) { el.className += ` ${name}`; }, contains: () => false };
      Object.defineProperty(el, 'innerHTML', { get() { return this.markup; }, set(value) { this.markup = value; this.children = []; } });
      return el;
    },
    body: { appendChild() {} }, addEventListener() {}, removeEventListener() {},
  };
  return document;
}
const walk = (el, out = []) => { out.push(el); for (const c of el.children || []) walk(c, out); return out; };

test('会话内切换菜单：网关会话只显示网关模型；一个也拿不到时就地说原因并给「去 设置 → 自有 API 添加模型」', async () => {
  const opened = [];
  const document = fakeDocument();
  document.defaultView.__companyApiOpen = (...args) => { opened.push(args); };
  // 有 CodeAgent、公司模型也可用：启动清单里有公司模型，网关会话的切换菜单里不该有。
  const list = cards.modelOptions('claude', gatewayUser, { state: 'running', accounts: [{ id: 'personal', kind: 'personal' }] }, { codeagentInstalled: true });
  assert.ok(list.some(o => o.route === 'company'));
  let current = list;
  const session = { kind: 'claude', companyRoute: 'proxy', companyUpstream: 'gateway', currentModel: { id: 'qwen-aw-35b' } };
  const menus = [];
  const realCreate = document.createElement.bind(document);
  document.createElement = tag => { const el = realCreate(tag); if (menus.length === 0 || tag === 'div') menus.push(el); return el; };
  const controller = createModelUiController({ document, sessions: new Map([['s1', session]]), ipcRenderer: { invoke: async () => ({ ok: true }) },
    terminalPanelEl: {}, getActiveSessionId: () => 's1', escapeHtml: String, setTimeoutFn() {},
    getModelOptions: () => current, refreshModelCatalog: async () => ({ ok: true }) });
  await controller.showModelPicker(realCreate('span'), 's1');
  const ids = menus.flatMap(m => walk(m)).filter(el => el.dataset.modelId).map(el => el.dataset.modelId);
  assert.deepEqual([...new Set(ids)], GATEWAY.map(m => m.id));
  // 网关上一个模型也没有
  current = [];
  menus.length = 0;
  await controller.showModelPicker(realCreate('span'), 's1');
  const all = menus.flatMap(m => walk(m));
  assert.ok(all.some(el => /部门 API key 这边还没有可选的模型/.test(el.textContent || '')), '就地说原因');
  const go = all.find(el => el.dataset.r49Settings === '1');
  assert.ok(go, '有「去 设置 → 自有 API 添加模型」');
  assert.equal(go.textContent, '去 设置 → 自有 API 添加模型');
  go.listeners.click({ stopPropagation() {} });
  assert.deepEqual(opened, [['claude', undefined, { mode: 'gateway' }]]);
});
