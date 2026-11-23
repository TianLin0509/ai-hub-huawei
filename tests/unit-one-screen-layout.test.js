'use strict';
// 「一个 Tab 一屏」（2026-11-21）的静态与纯逻辑部分；界面实测在 tests/e2e-one-screen-cdp.js。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 只支持 #id / .class 及逗号并列，够描述设置弹窗的直接子元素。
function fakeEl({ id = '', cls = [], kids = [], hidden = false } = {}) {
  const el = { id, hidden, classList: { contains: c => cls.includes(c) }, kids: kids.map(fakeEl) };
  const one = (e, s) => (s.startsWith('#') && e.id === s.slice(1)) || (s.startsWith('.') && s.slice(1).split('.').every(c => e.classList.contains(c)));
  el.matches = sel => sel.split(',').map(s => s.trim()).some(s => one(el, s));
  el.querySelector = sel => { const walk = list => { for (const k of list) { if (k.matches(sel)) return k; const hit = walk(k.kids); if (hit) return hit; } return null; }; return walk(el.kids); };
  return el;
}

test('设置弹窗：直接子元素按类归到页签，小节标题跟下一项、说明跟上一项', () => {
  const { classifyChildren } = require('../renderer/config-settings-tabs.js');
  const kids = [
    { cls: ['company-api-settings-entry'] },
    { cls: ['hub-feature-search'] },
    { cls: ['cfg-tabs'], id: 'cfg-tabs' },
    { cls: ['config-hint'] },
    { cls: ['config-field', 'config-language-field'], kids: [{ cls: ['config-hint'] }] },
    { id: 'cfg-hub-pet', kids: [{ cls: ['config-operations-card'] }] },
    { cls: ['config-field'], kids: [{ id: 'cfg-model-unavailable-policy' }] },
    { cls: ['config-section-label', 'config-operations-title'] },
    { cls: ['config-operations-card'] },
    { id: 'cfg-notify-mode-section' },
    { cls: ['config-section-label', 'config-notification-title'] },
    { id: 'config-notification-card' },
    { id: 'cfg-boot-splash-field' },
    { cls: ['config-section-label', 'config-reading-title'] },
    { cls: ['config-reading-grid'], kids: [{ id: 'cfg-card-font-size' }] },
    { cls: ['config-reading-note'] },
    { id: 'cfg-composer-enter-field' },
    { id: 'cfg-workspace-root-field' },
    { cls: ['config-section-label'] },
    { id: 'cfg-team-auto-approve-field' },
    { id: 'btn-config-accounts' },
    { id: 'something-new-from-another-module' },
  ].map(fakeEl);
  assert.deepEqual(classifyChildren(kids), [
    'general', 'shared', 'shared', 'general', 'general', 'pet', 'general', 'server', 'server', 'pet',
    'notify', 'notify', 'display', 'display', 'display', 'display', 'display', 'display', 'advanced', 'advanced', 'general', 'general',
  ]);
});

test('启动中心「更多选项」摘要：只列显示着的次要项，取值去掉「· 说明」和括号补充', () => {
  const { summaryText, SECONDARY } = require('../renderer/launch-more-options.js');
  assert.ok(SECONDARY.includes('new-session-permission-field'), '权限模式在「更多选项」里');
  const field = (label, text, hidden = false) => ({ hidden, querySelector: q => q === ':scope > span' ? { textContent: label } : q === 'select' ? { selectedOptions: [{ textContent: text }] } : null });
  const fields = {
    'new-session-company-account-field': field('账号', '自动挑号（0 个可用号）'),
    'new-session-mcp-field': field('MCP 工具', 'None · 不加载工具'),
    'new-session-fast-field': field('快速模式', '', true),
    'new-session-permission-field': field('权限模式', '每步确认'),
  };
  const doc = { getElementById: id => fields[id] || null };
  assert.equal(summaryText(doc), '账号 自动挑号 · MCP 工具 None · 权限模式 每步确认');
});

test('页面接线：样式表在最后加载，两个脚本都挂上，跳转入口先切页签', () => {
  const html = read('renderer/index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  const links = [...head.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
  assert.equal(links[links.length - 1], 'styles/one-screen.css', 'one-screen.css 排在所有样式表之后');
  assert.match(html, /<script src="config-settings-tabs\.js"><\/script>/);
  assert.match(html, /<script src="launch-more-options\.js"><\/script>/);
  const css = read('renderer/styles/one-screen.css');
  assert.match(css, /#config-main-view > \.cfg-tab-off \{ display: none !important; \}/);
  assert.match(css, /lc-more-collapsed :is\([^)]*#new-session-permission-field/);
  assert.match(read('renderer/feature-search.js'), /__hubSettingsTabs\?\.reveal\(e\)/, '搜索跳转先切到目标页签');
  assert.match(read('renderer/renderer.js'), /__hubSettingsTabs\?\.reveal\(el\)/, '回执齿轮先切到「桌宠与回执」');
  assert.match(read('renderer/company-rooms-page.js'), /data-cr-slot="login-why"/, '会议室第 ① 步写明登录按钮为什么灰着');
});

// 小型 DOM 夹具：观察器按微任务异步投递，隐藏页签里的字段无法获得焦点。
function uiFixture(storage = new Map()) {
  const nodes = [], observers = [];
  const changed = (target, attributeName) => {
    for (const o of observers) if (o.target === target && o.options.attributeFilter?.includes(attributeName)) {
      o.records.push({ type: 'attributes', target, attributeName });
      if (!o.queued) {
        o.queued = true;
        queueMicrotask(() => { o.queued = false; const records = o.records.splice(0); o.callback(records); });
      }
    }
  };
  const document = { readyState: 'loading', activeElement: null, addEventListener() {},
    getElementById: id => nodes.find(n => n.id === id) || null, querySelectorAll: () => [] };
  function element(id = '', cls = []) {
    const classes = new Set(cls), attrs = {};
    const n = { id, children: [], dataset: {}, style: {}, listeners: {}, value: '', textContent: '', hidden: false,
      classList: { contains: c => classes.has(c), add: c => { classes.add(c); changed(n, 'class'); },
        remove: c => { classes.delete(c); changed(n, 'class'); },
        toggle: (c, on = !classes.has(c)) => { if (on) classes.add(c); else classes.delete(c); changed(n, 'class'); } },
      setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: k => attrs[k] ?? null,
      addEventListener: (type, fn) => { n.listeners[type] = fn; },
      appendChild(child) { child.parentElement = n; n.children.push(child); return child; },
      prepend(child) { if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1); child.parentElement = n; n.children.unshift(child); },
      after(child) { child.parentElement = n.parentElement; n.parentElement.children.splice(n.parentElement.children.indexOf(n) + 1, 0, child); },
      contains(child) { return child === n || n.children.some(c => c.contains(child)); },
      matches: sel => sel.split(',').some(s => {
        s = s.trim();
        return s.startsWith('#') ? s.slice(1) === n.id : s.startsWith('.') ? classes.has(s.slice(1)) :
          s.startsWith('[data-cfg-tab-btn]') ? !!n.dataset.cfgTabBtn && (!s.includes(':not') || !n.hidden) : false;
      }),
      querySelectorAll: sel => n.children.flatMap(c => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]),
      querySelector(sel) { return sel === ':scope > .hub-feature-search' ? null : n.querySelectorAll(sel)[0] || null; },
      closest(sel) { return n.matches(sel) ? n : n.parentElement?.closest(sel) || null; },
      focus() { for (let p = n; p; p = p.parentElement) if (p.hidden || p.classList.contains('cfg-tab-off') || p.classList.contains('hidden')) return; document.activeElement = n; },
    };
    Object.defineProperties(n, {
      firstElementChild: { get: () => n.children[0] },
      className: { get: () => [...classes].join(' '), set: v => { classes.clear(); v.split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); } },
      innerHTML: { set: html => {
        n.children = [];
        for (const m of html.matchAll(/data-cfg-tab-btn="([^"]+)"/g)) { const b = element(); b.dataset.cfgTabBtn = m[1]; n.appendChild(b); }
        if (html.includes('lc-more-summary')) n.appendChild(element('', ['lc-more-summary']));
      } },
    });
    nodes.push(n);
    return n;
  }
  document.createElement = () => element();
  const window = { setTimeout, localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    getComputedStyle: n => ({ display: n.hidden ? 'none' : 'block' }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.records = []; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
    } };
  document.defaultView = window;
  return { document, window, element, changed };
}

test('设置入口 reveal 后异步观察器保留通知 / 监控页签和焦点', async () => {
  const f = uiFixture(), { element } = f;
  const modal = element('config-modal', ['hidden']), view = modal.appendChild(element('config-main-view'));
  view.appendChild(element('', ['config-hint']));
  const notification = view.appendChild(element('config-notification-card'));
  const target = notification.appendChild(element('cfg-feishu-target'));
  const operations = view.appendChild(element('', ['config-operations-card']));
  const url = operations.appendChild(element('cfg-aliyun-health-url'));
  const tabs = require('../renderer/config-settings-tabs').createSettingsTabs(f);
  for (const [field, tab] of [[target, 'notify'], [url, 'server']]) {
    modal.classList.remove('hidden');
    tabs.reveal(field);
    await Promise.resolve(); // 实际 MutationObserver 会在定时聚焦前投递。
    field.focus();
    assert.equal(tabs.active, tab);
    assert.equal(f.document.activeElement, field);
    modal.classList.add('hidden');
    await Promise.resolve();
  }
});

function configFixture() {
  const f = uiFixture(), { document, element } = f;
  for (const m of read('renderer/config-modal.js').matchAll(/(?:configEl|getElementById)\('([^']+)'\)/g)) if (!document.getElementById(m[1])) element(m[1]);
  const calls = [], saves = [];
  let active = 'advanced';
  f.window.__hubSettingsTabs = {
    activate(id) { active = id; calls.push(['activate', id]); },
    reveal(field) { active = field?.id === 'cfg-feishu-target' || field?.id === 'config-notification-card' ? 'notify' : field?.id === 'cfg-aliyun-health-url' ? 'server' : 'advanced'; calls.push(['reveal', field?.id]); },
  };
  const controller = require('../renderer/config-modal').createConfigModalController({ document, providerModes: {}, renderAccountUsage() {},
    ipcRenderer: { async invoke(name, value) { if (name === 'save-hub-config') saves.push(value); return name === 'get-hub-config-raw' ? {} : { success: true }; } } });
  controller.init();
  return { ...f, controller, calls, saves, get active() { return active; } };
}

test('普通打开设置先同步初始化常用页签，通知入口随后 reveal', async () => {
  const f = configFixture();
  await f.controller.open();
  assert.equal(f.active, 'general');
  await f.controller.openNotificationSetup();
  assert.deepEqual(f.calls.slice(-2), [['activate', 'general'], ['reveal', 'config-notification-card']]);
  assert.equal(f.active, 'notify');
  await new Promise(resolve => setTimeout(resolve, 5));
});

for (const scenario of [
  { name: '接收 ID 格式错误', field: 'cfg-feishu-target', value: 'wrong', tab: 'notify', message: /ID 必须/ },
  { name: '启用通知但接收 ID 为空', field: 'cfg-feishu-target', value: '', enable: 'cfg-notification-enabled', tab: 'notify', message: /先填写飞书/ },
  { name: '监控 URL 格式错误', field: 'cfg-aliyun-health-url', value: 'wrong', enable: 'cfg-aliyun-enabled', tab: 'server', message: /HTTP\(S\)/ },
]) test(`保存校验：${scenario.name}时切到字段所在页签再聚焦并显示错误`, async () => {
  const f = configFixture();
  await f.controller.open();
  const field = f.document.getElementById(scenario.field);
  field.value = scenario.value;
  if (scenario.enable) f.document.getElementById(scenario.enable).checked = true;
  const focus = field.focus;
  field.focus = () => { assert.equal(f.active, scenario.tab, '聚焦时目标页签已经展开'); focus(); };
  await f.document.getElementById('config-save').listeners.click();
  assert.equal(f.active, scenario.tab);
  assert.equal(f.document.activeElement, field);
  const message = f.document.getElementById('config-save-msg');
  assert.match(message.textContent, scenario.message);
  assert.equal(message.style.display, 'block');
  assert.equal(f.saves.length, 0, '非法配置没有写入');
});

function launcherFixture(storage) {
  const f = uiFixture(storage), section = f.element('new-session-config-section');
  section.appendChild(f.element('new-session-tuning'));
  section.appendChild(f.element('new-session-permission-field'));
  f.menu = f.element('new-session-menu');
  f.menu.style.display = 'none';
  f.api = require('../renderer/launch-more-options').mount(f);
  return f;
}

test('更多选项：新用户收起，点击后重开和重新挂载记住展开 / 收起', async () => {
  const storage = new Map(), f = launcherFixture(storage);
  assert.equal(f.api.open, false);
  f.document.getElementById('new-session-more-toggle').listeners.click();
  assert.equal(f.api.open, true);
  for (const display of ['none', 'block']) { f.menu.style.display = display; f.changed(f.menu, 'style'); await Promise.resolve(); }
  assert.equal(f.api.open, true, '同一实例关闭重开仍然展开');
  const reopened = launcherFixture(storage);
  assert.equal(reopened.api.open, true, '重启重新挂载从本地设置恢复');
  reopened.document.getElementById('new-session-more-toggle').listeners.click();
  assert.equal(launcherFixture(storage).api.open, false, '收起状态同样持久化');
});

test('更多选项：本地设置不可读写时仍可展开 / 收起', () => {
  const storage = { get() { throw Error('unavailable'); }, set() { throw Error('unavailable'); } };
  const f = launcherFixture(storage);
  assert.equal(f.api.open, false);
  f.api.expand();
  assert.equal(f.api.open, true);
  f.api.collapse();
  assert.equal(f.api.open, false);
});
