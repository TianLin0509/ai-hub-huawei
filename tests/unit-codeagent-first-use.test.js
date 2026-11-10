'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const picker = require('../core/codeagent-model-picker');
const ready = require('../core/group-chat-cli-ready-detector');
const notices = require('../renderer/sticky-notice');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function documentFixture() {
  const elements = new Map();
  const make = tag => ({ tagName: tag, dataset: {}, style: {}, children: [], listeners: {},
    set textContent(value) { this.text = value; this.children = []; }, get textContent() { return this.text || ''; },
    classList: { toggle() {} }, setAttribute() {}, querySelector() { return null; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    appendChild(child) { child.parent = this; this.children.push(child); if (child.id) elements.set(child.id, child); return child; },
    append(...children) { children.forEach(child => this.appendChild(child)); },
    remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); },
  });
  return { createElement: make, body: make('body'), getElementById: id => elements.get(id) || null,
    element(id) { const element = make('div'); elements.set(id, element); return element; } };
}

function promptManager(buffer) {
  const manager = new EventEmitter(), events = [];
  manager.getSessionBuffer = () => buffer;
  manager.on('session-notice', payload => events.push(payload));
  return { manager, events };
}

for (const login of ['W3 用户名', 'Please run /login', 'not logged in', 'No valid auth token', '请先登录', '未登录']) {
  test(`首轮底部的登录提示仍拦截发送，旧提示在输入框出现后不再阻断就绪：${login}`, async () => {
    const sid = `login-${login}`;
    const buffer = `${'x'.repeat(600)}\n${login}\nAnything I can assist you with?\nBypass (Cycle shift+tab)`;
    ready.cleanup(sid);
    assert.equal(ready.isReady(sid, 'codeagent', `${'x'.repeat(600)}\n${login}`), false);
    assert.equal(ready.isReady(sid, 'codeagent', buffer, { lastOutputAt: Date.now() - 2000 }), true);
    assert.equal(picker.inputUsableAfterPick(buffer), false);
    const { manager, events } = promptManager(buffer);
    await assert.rejects(picker.beforePrompt(manager, sid, { allowUnready: true }), error => error.notSent && error.code === 'codeagent-login-required');
    assert.equal(events[0].action, 'codeagent-login');
    ready.cleanup(sid);
  });
}

test('已完成一轮的会话底部含登录词仍可继续发送', async () => {
  const buffer = '回答：WeLink 未登录，接口返回 not authenticated，请检查 please login 提示。\n> Anything I can assist you with?\nBypass (Cycle shift+tab)';
  const { manager, events } = promptManager(buffer);
  manager.getSession = () => ({ lastCompletedAt: Date.now() - 1000 });
  await picker.beforePrompt(manager, 'completed-with-login-text');
  assert.equal(picker.inputUsableAfterPick(buffer, manager.getSession()), true);
  assert.equal(events.length, 0);
});

test('首轮只看最后六行非空内容，上方正文里的登录词不拦截发送', async () => {
  const buffer = '正文：未登录 not authenticated please login\n\n'
    + ['说明一', '说明二', '说明三', '说明四', '> Anything I can assist you with?', 'Bypass (Cycle shift+tab)'].join('\n\n');
  const { manager, events } = promptManager(buffer);
  await picker.beforePrompt(manager, 'first-with-old-login-text');
  assert.equal(picker.inputUsableAfterPick(buffer), true);
  assert.equal(events.length, 0);
  const nearBottom = buffer.split('\n').filter(line => line.trim());
  nearBottom[nearBottom.length - 6] = '未登录';
  assert.equal(picker.inputUsableAfterPick(nearBottom), false);
});

test('模型自动选择失败后，第一条消息在可用输入框继续且只提示一次', async () => {
  const sid = 'first-use-fallback';
  await picker.schedulePick(sid, async () => ({ ok: false, inputReady: true, message: '自动选择模型没成功' }));
  const { manager, events } = promptManager('Anything I can assist you with?\nBypass (Cycle shift+tab)');
  await picker.beforePrompt(manager, sid);
  await picker.beforePrompt(manager, sid);
  assert.equal(events.length, 1);
  assert.match(events[0].message, /本条消息将沿用 CodeAgent 当前模型发送/);
});

test('模型选择失败后菜单仍开着时，第一条消息保持未发送', async () => {
  const sid = 'first-use-menu';
  await picker.schedulePick(sid, async () => ({ ok: false, inputReady: false, message: '模型菜单未关闭' }));
  const { manager } = promptManager('Select model\n⌕ Search\nNavigate ↑ ↓');
  await assert.rejects(picker.beforePrompt(manager, sid), error => error.notSent === true);
  picker.resetFailure(sid);
});

test('首次账号提示旁的登录按钮可直接调用个人账号登录，已登录或暂停时不出现', async () => {
  const document = documentFixture(), note = document.element('new-session-codeagent-account-note');
  document.element('new-session-codeagent-account');
  const calls = [], personal = { present: false, state: 'login-required' };
  const state = require('../renderer/codeagent-account-state');
  const context = { document, selectedKind: 'codeagent', companyAccounts: true, codeagentAccount: 'personal',
    codeagentSetup: { current: { installed: true } }, codeagentPool: { personal, accounts: [] }, codeagentPoolError: '',
    codeagentPoolPick: '', codeagentManualPick: () => '', personalStateText: () => state.accountState(personal, { personal: true }).detail,
    autoCandidateCount: () => 0, codeagentUsesPool: () => false, codeagentSelectionUnavailable: () => false,
    escapeHtml: text => text, submitting: false, ...state,
    ipcRenderer: { invoke: async channel => { calls.push(channel); return { ok: true }; } },
    require: () => require('../renderer/sticky-notice.js') };
  const fn = read('renderer/workspace-controller.js').match(/  function paintCodeagentAccount\(\) \{[\s\S]*?\n  }(?=\s*function paintCompanyAccount)/)[0];
  vm.runInNewContext(`${fn}\npaintCodeagentAccount();`, context);
  assert.match(note.textContent, /尚未登录/);
  assert.equal(note.children[0].textContent, '登录');
  await note.children[0].listeners.click();
  assert.deepEqual(calls, ['codeagent-pool:personal-login']);
  personal.present = true; personal.state = 'ready';
  vm.runInNewContext(`${fn}\npaintCodeagentAccount();`, context);
  assert.equal(note.children.length, 0);
  personal.avoid = { source: 'manual' };
  vm.runInNewContext(`${fn}\npaintCodeagentAccount();`, context);
  assert.equal(note.children.length, 0);
});

test('常驻提示里的登录和后台按钮可操作，重复提示不重复按钮', async () => {
  const document = documentFixture(), listeners = new Map(), calls = [];
  const context = { document, sessions: new Map([['sid', { title: '会话' }]]),
    ipcRenderer: { on: (name, fn) => listeners.set(name, fn), invoke: async channel => { calls.push(channel); return { ok: true }; } },
    require: () => require('../renderer/sticky-notice.js'), selectSession: async (sid, opts) => calls.push([sid, opts.splitBypass]),
    applyViewMode: mode => calls.push(mode), showToast: () => assert.fail('应为常驻提示') };
  const handler = read('renderer/renderer.js').match(/ipcRenderer.on\('session-notice',[\s\S]*?\n}\);/)[0];
  vm.runInNewContext(handler, context);
  const login = { message: '请先登录', sessionId: 'sid', persistent: true, action: 'codeagent-login' };
  listeners.get('session-notice')(null, login);
  listeners.get('session-notice')(null, login);
  const stack = document.getElementById(notices.STACK_ID);
  assert.equal(stack.children.length, 1);
  assert.equal(stack.children[0].children[0].children.length, 1);
  await stack.children[0].children[0].children[0].listeners.click();
  assert.deepEqual(calls, ['codeagent-pool:personal-login']);
  listeners.get('session-notice')(null, { message: '请确认目录信任', sessionId: 'sid', persistent: true, action: 'open-backstage' });
  const button = stack.children[1].children[0].children[0];
  assert.equal(button.textContent, '打开后台');
  await button.listeners.click();
  assert.deepEqual(calls.slice(1), [['sid', true], 'pty']);
});

test('登录窗口打开失败时保留可重试按钮', async () => {
  const document = documentFixture(), host = document.createElement('div');
  const button = notices.appendCodeAgentLoginButton(document, host, { invoke: async () => ({ ok: false, error: 'CodeAgent 未安装' }) });
  await button.listeners.click();
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /CodeAgent 未安装.*重试/);
});

test('信任确认失败的主进程提示携带打开后台动作', () => {
  const source = read('main/ipc/session-handlers.js');
  assert.match(source, /phase === 'trust-stuck'[\s\S]*?action: 'open-backstage'/);
});

test('公司版全新配置默认公司模型，已有本机、自有接口、公司模型选择继续尊重', t => {
  t.mock.method(require('../core/state-store'), 'load', () => ({ sessions: [] }));
  const api = require('../core/company-api-config'), cards = require('../renderer/launch-model-cards');
  for (const kind of ['claude', 'codex']) {
    const fresh = api.settings({})[kind];
    assert.equal(cards.defaultPick(kind, fresh).source, api.isCompany() ? 'company' : 'own');
    if (api.isCompany()) {
      const request = cards.saveRequest(kind, fresh, { source: 'own', model: '' });
      assert.deepEqual(request, { kind, backend: 'own' });
      assert.equal(cards.defaultPick(kind, api.settings(api.withSettings({}, request))[kind]).source, 'own');
    }
    const savedLocal = api.withSettings({}, { kind, useLocal: true });
    assert.equal(cards.defaultPick(kind, api.settings(savedLocal)[kind]).source, 'own');
    const own = api.withSettings({}, { kind, baseURL: 'https://example.com/v1', apiKey: 'test', model: 'own-model' });
    assert.deepEqual(cards.defaultPick(kind, api.settings(own)[kind]), { source: 'own', model: 'own-model' });
    const company = api.withSettings({}, { kind, backend: 'proxy', model: 'GLM-5.2-WX' });
    assert.deepEqual(cards.defaultPick(kind, api.settings(company)[kind]), { source: 'company', model: 'GLM-5.2-WX' });
  }
});
