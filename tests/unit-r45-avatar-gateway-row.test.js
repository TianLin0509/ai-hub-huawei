'use strict';

// R45（2026-11-25）「分身不能配自定义 API / 平台模型，只能用 CodeAgent」：
// 分身页「账号 / 模型」卡里要有「部门 API key（网关）」一行，模型 = key 的模型表 + 手填测通的；
// 选它就是「功能使用的 Agent → 分身」那一项（所有分身共用），会话按网关线路起。用假依赖，不碰真实网关。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gatewayRow } = require('../main/ipc/avatar-handlers');
const choice = require('../core/feature-agent-choice');
const route = require('../core/assistant-gateway-route');

const fakeGateway = (view, choices) => ({ read: () => view, modelChoices: () => choices.map(id => ({ id, label: id })) });
const fakeRoute = available => ({ KIND: route.KIND, LABEL: route.LABEL, availability: () => (available ? { available: true, reason: '' } : { available: false, reason: '还没保存部门 API key' }) });
const fakeRoutes = pref => ({ featurePreference: (_dir, id) => (id === 'avatar' ? pref : null) });

test('部门 key 已存：网关行可选，模型含 key 模型表和手填模型，默认模型照网关', () => {
  const row = gatewayRow('x', { gateway: fakeGateway({ keySet: true, model: 'deepseek-v4.1-flash', customModels: ['deepseek-v4.1-flash-1017'] }, ['deepseek-v4.1-flash', 'glm-5.3-flash']),
    route: fakeRoute(true), routes: fakeRoutes(null) });
  assert.equal(row.id, 'api-gateway');
  assert.equal(row.usable, true);
  assert.equal(row.gateway, true);
  assert.equal(row.pool, false, '不进号池自动挑号');
  assert.deepEqual(row.models, ['deepseek-v4.1-flash', 'glm-5.3-flash', 'deepseek-v4.1-flash-1017']);
  assert.equal(row.defaultModel, 'deepseek-v4.1-flash');
  assert.equal(row.selected, false);
});

test('分身已选部门 key：行标为选中并带上所选模型', () => {
  const row = gatewayRow('x', { gateway: fakeGateway({ keySet: true, model: 'm1', customModels: [] }, ['m1', 'm2']), route: fakeRoute(true),
    routes: fakeRoutes({ kind: 'api-gateway', model: 'm2' }) });
  assert.equal(row.selected, true);
  assert.equal(row.model, 'm2');
});

test('没存部门 key：照样列出但置灰，原因里写清去哪儿配', () => {
  const row = gatewayRow('x', { gateway: fakeGateway({ keySet: false, model: '', customModels: [] }, []), route: fakeRoute(false), routes: fakeRoutes(null) });
  assert.equal(row.usable, false);
  assert.match(row.reason, /还没保存部门 API key/);
  assert.match(row.reason, /API 网关/);
});

test('选了部门 key 的分身：会话按网关线路起（Claude Code + 网关标记），不带 CodeAgent 号池字段', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r45-av-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  require('../core/codeagent-assistant-route').setFeaturePreference(dir, 'avatar', { kind: 'api-gateway', model: 'glm-5.3-flash' });
  const backends = [{ kind: 'api-gateway', available: true, models: [{ id: 'glm-5.3-flash' }] }];
  const picked = choice.session(dir, 'avatar', 'codeagent', { id: 's1', purpose: 'avatar-agent', codeagentAccount: 'pool', codeagentPoolPick: 'acc1', codeagentRouteModel: 'GLM-5' }, { backends });
  assert.equal(picked.kind, 'claude');
  assert.equal(picked.opts.apiGatewayRoute, true);
  assert.equal(picked.opts.model, 'glm-5.3-flash');
  assert.equal(picked.opts.mcpProfile, 'none');
  assert.equal(Object.keys(picked.opts).some(k => /^codeagent/i.test(k)), false);
  assert.equal(route.allowedSession(picked.kind, picked.opts), true, '网关放行规则认这个分身会话');
});

// ---- R45-2 审查修复（job 20261125-213414-d86cdc）----
test('P1 存了分身用部门 key，但 key 不可用或所选模型已不在表里：selected=false（与实际走的 CodeAgent 一致），configured=true 留给「点回 CodeAgent 时清残留」', () => {
  const noKey = gatewayRow('x', { gateway: fakeGateway({ keySet: false, model: '', customModels: [] }, []), route: fakeRoute(false),
    routes: fakeRoutes({ kind: 'api-gateway', model: '' }) });
  assert.equal(noKey.configured, true);
  assert.equal(noKey.selected, false);
  const gone = gatewayRow('x', { gateway: fakeGateway({ keySet: true, model: 'm1', customModels: [] }, ['m1']), route: fakeRoute(true),
    routes: fakeRoutes({ kind: 'api-gateway', model: 'removed-model' }) });
  assert.equal(gone.configured, true);
  assert.equal(gone.selected, false);
  assert.equal(gone.model, '');
  const ok = gatewayRow('x', { gateway: fakeGateway({ keySet: true, model: 'm1', customModels: [] }, ['m1']), route: fakeRoute(true),
    routes: fakeRoutes({ kind: 'api-gateway', model: 'm1' }) });
  assert.equal(ok.selected, true);
});

// 分身页的轻量 DOM 桩：只记 innerHTML 字符串和事件处理；点击用假的按钮（带 data-av）直接送进页面的点击委托。
function fakeDom() {
  const el = tag => {
    const node = { tagName: tag.toUpperCase(), hidden: false, style: {}, dataset: {}, children: [], listeners: {}, html: '',
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, [Symbol.iterator]() { return this.set.values(); } },
      setAttribute() {}, addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); }, querySelectorAll: () => [], querySelector: () => null,
      append(child) { node.children.push(child); }, remove() {}, getBoundingClientRect: () => ({ width: 0, height: 0, right: 0, bottom: 0 }), contains: () => false };
    Object.defineProperty(node, 'innerHTML', { get: () => node.html, set: v => { node.html = v; if (/^<div class="avx-root">/.test(v)) node.firstChild = el('div'); } });
    return node;
  };
  const body = el('body');
  const document = { body, createElement: el, getElementById: () => null, activeElement: null };
  const window = { innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  return { document, window, body };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };

function pageHarness(rowsFor) {
  const { createAvatarPage } = require('../renderer/avatar-page');
  const { document, window, body } = fakeDom();
  const calls = [], listeners = {};
  let pref = null;
  let avatar = { id: 'av1', name: '答疑', kind: 'pick', action: 'draft', targets: [], state: { code: 'on', text: '运行中' }, pending: 0,
    stats: { model: 0 }, enabled: true, backend: { account: 'auto', model: '', effort: '' }, prefix: '我的数字分身', hideModel: true, persona: '', notes: '',
    authorities: [], sources: [], examples: 0, memoryLines: 0, session: { alive: false, questions: 0 } };
  const status = () => ({ ok: true, available: true, login: { ok: true }, paused: false, avatars: [avatar], items: [], backends: { rows: rowsFor(pref) } });
  const ipcRenderer = {
    on: (name, fn) => { listeners[name] = fn; },
    removeListener: (name, fn) => { if (listeners[name] === fn) delete listeners[name]; },
    invoke: async (name, payload) => {
      calls.push([name, payload]);
      if (name === 'feature-agents:set') { pref = payload.choice; return { ok: true }; }
      if (name === 'avatar:update') { avatar = { ...avatar, ...payload.patch }; return status(); }
      if (name === 'avatar:targets') return { groups: [], people: [], ready: true };
      return status();
    },
  };
  const page = createAvatarPage({ document, window, ipcRenderer });
  const section = () => body.children[0];
  const root = () => section().firstChild;
  const click = async dataset => {
    for (const fn of section().listeners.click) fn({ target: { closest: () => ({ dataset, disabled: false }) } });
    await settle();
  };
  return { page, calls, listeners, root, click, setPref: p => { pref = p; } };
}
const rowsWith = gateway => pref => [{ id: 'auto', label: '自动选择', usable: true, models: [], pool: false },
  { id: 'personal', label: '个人账号', usable: true, models: ['GLM-5'], defaultModel: 'GLM-5', pool: false },
  { id: 'api-gateway', label: '部门 API key（网关）', usable: gateway.usable, models: ['m1', 'm2'], defaultModel: 'm1', pool: false, gateway: true,
    configured: pref?.kind === 'api-gateway', selected: pref?.kind === 'api-gateway' && gateway.usable, model: pref?.model || '' }];
const lastSet = h => h.calls.filter(c => c[0] === 'feature-agents:set').at(-1)?.[1];

test('分身页交互：选部门 key 行 → 换网关模型 → 点回 CodeAgent 账号撤销；作用范围写明；向导账号下拉不列网关行', async () => {
  const h = pageHarness(rowsWith({ usable: true }));
  h.page.open(); await settle();
  await h.click({ av: 'sel', id: 'av1' });
  await h.click({ av: 'tab', k: 'back' });
  assert.match(h.root().innerHTML, /所有分身共用；切回 CodeAgent 账号即撤销/);
  await h.click({ av: 'account', id: 'api-gateway' });
  assert.deepEqual(lastSet(h), { feature: 'avatar', choice: { kind: 'api-gateway', model: '' } });
  assert.match(h.root().innerHTML, /网关默认模型/);
  await h.click({ av: 'model', id: 'm2' });
  assert.deepEqual(lastSet(h), { feature: 'avatar', choice: { kind: 'api-gateway', model: 'm2' } });
  const before = h.calls.length;
  await h.click({ av: 'account', id: 'personal' });
  const names = h.calls.slice(before).map(c => c[0]);
  assert.ok(names.includes('feature-agents:set') && names.indexOf('feature-agents:set') < names.indexOf('avatar:update'), '先撤销部门 key，再保存 CodeAgent 账号');
  // R49-2 窄复审 P2-1：存明确的 CodeAgent（只撤掉的话，没有可用 CodeAgent 时自动默认会把部门 key 盖回来）。
  assert.deepEqual(lastSet(h).choice, { kind: 'codeagent', model: '' });
  assert.equal(h.calls.filter(c => c[0] === 'avatar:update').at(-1)[1].patch.backend.account, 'personal');
  // 向导高级设置的账号下拉：不列网关行
  await h.click({ av: 'new' });
  await h.click({ av: 'tpl', t: 'watch' });
  await h.click({ av: 'wiz-adv' });
  const select = /data-chg="wiz-account">([\s\S]*?)<\/select>/.exec(h.root().innerHTML)?.[1] || '';
  assert.match(select, /personal/);
  assert.doesNotMatch(select, /api-gateway/);
  h.page.destroy(); // 停掉向导里读群名单的轮询计时器
});

test('分身页交互：key 失效时网关行不亮、模型卡是 CodeAgent 的；点 CodeAgent 账号连残留一起清', async () => {
  const h = pageHarness(rowsWith({ usable: false }));
  h.setPref({ kind: 'api-gateway', model: 'm1' });
  h.page.open(); await settle();
  await h.click({ av: 'sel', id: 'av1' });
  await h.click({ av: 'tab', k: 'back' });
  const html = h.root().innerHTML;
  assert.doesNotMatch(html, /class="avx-ac on" data-av="account" data-id="api-gateway"/);
  assert.match(html, /账号默认模型/);
  await h.click({ av: 'account', id: 'personal' });
  assert.deepEqual(lastSet(h)?.choice, { kind: 'codeagent', model: '' }, '失效残留也改掉（存成明确的 CodeAgent）');
  h.page.destroy();
});

test('分身页监听 feature-agents:changed，destroy 时移除', () => {
  const h = pageHarness(rowsWith({ usable: true }));
  assert.equal(typeof h.listeners['feature-agents:changed'], 'function');
  assert.equal(typeof h.listeners['avatar:changed'], 'function');
  h.page.destroy();
  assert.equal(h.listeners['feature-agents:changed'], undefined);
  assert.equal(h.listeners['avatar:changed'], undefined);
});
