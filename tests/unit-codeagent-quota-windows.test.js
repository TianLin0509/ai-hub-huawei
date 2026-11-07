'use strict';

// 5.5.25：额度栏今日 / 1 小时 / 1 分钟三档、「移到底栏 / 移回右侧」按钮，以及单号、多号时的底栏文本。假 DOM，不起 Electron。
const test = require('node:test');
const assert = require('node:assert/strict');
const { quotaView, renderQuota, renderQuotaFooter, tokenWindows, footerPick } = require('../renderer/codeagent-quota-panel-view');
const { createCodeAgentQuotaPanel } = require('../renderer/codeagent-quota-panel');
const { createQuotaPlacement } = require('../renderer/codeagent-quota-placement');

const now = Date.parse('2026-11-04T06:05:30Z'); // 北京时间 14:05:30
const row = overrides => ({ id: 'pool-a', state: 'ready', personal: false, label: '研发号', ...overrides });
const model = (day, hour, min) => ({ name: 'GLM-5.2-WX-Auto', day: { used: '6M', total: '400M', pct: day },
  hour: hour == null ? null : { used: '1M', total: '200M', pct: hour }, min: min == null ? null : { used: '1K', total: '1M', pct: min } });
const withModel = (m, extra = {}, at = now) => row({ usage: { models: [m], modelsAt: at }, defaultModel: m.name, ...extra });
const windowCell = (html, key) => (html.match(new RegExp(`<span class="qp-win[^"]*" data-qp-window="${key}"[^>]*>.*?</span></span></span>`)) || [''])[0];

test('right panel: each account shows today plus 1-hour and 1-minute remaining in the same capsule form', () => {
  const view = quotaView({ rows: [withModel(model(1.7, 0.21, 31.33)), row({ id: 'b' })] }, { now });
  assert.deepEqual(tokenWindows(view.rows[0].token).map(item => item.text), ['98%', '99%', '68%']);
  const html = renderQuota(view, { now });
  assert.match(html, /data-qp-bucket="token"[^>]*><span>98%<\/span>/, 'today stays the main capsule');
  assert.match(windowCell(html, 'hour'), /<i>1 小时<\/i><span class="qp-mini" style="--v:99\.79"><span>99%<\/span>/);
  assert.match(windowCell(html, 'min'), /<i>1 分钟<\/i><span class="qp-mini" style="--v:68\.67"><span>68%<\/span>/);
  assert.equal((html.match(/class="qp-wins"/g) || []).length, 1, 'an account without any reading gets no extra line');
});

test('unreadable windows show a dash with an explanation, stale windows grey out, near-empty windows warn', () => {
  const missing = renderQuota(quotaView({ rows: [withModel(model(10, null, 5)), row({ id: 'b' })] }, { now }), { now });
  assert.match(windowCell(missing, 'hour'), /class="qp-win none"[^>]*aria-label="1 小时：未读取[^"]*"/);
  assert.match(windowCell(missing, 'hour'), /<span class="qp-mini"><span>—<\/span>/);
  // 读数是 1 分钟前的：分钟窗已换新一轮（置灰、不报警），小时窗还是当前
  const stale = renderQuota(quotaView({ rows: [withModel(model(10, 85, 99), {}, now - 60000), row({ id: 'b' })] }, { now }), { now });
  assert.match(windowCell(stale, 'min'), /class="qp-win stale"/); assert.match(windowCell(stale, 'min'), /上次读数剩 1%/);
  assert.match(windowCell(stale, 'hour'), /class="qp-win low"[^>]*>.*<span>15%<\/span>/);
  const out = renderQuota(quotaView({ rows: [withModel(model(10, 20, 100)), row({ id: 'b' })] }, { now }), { now });
  assert.match(windowCell(out, 'min'), /class="qp-win out"[^>]*>.*<span>用完<\/span>/);
  assert.match(windowCell(out, 'hour'), /class="qp-win"[^>]*>.*<span>80%<\/span>/, 'exactly 80% left is calm, like the today capsule');
  const login = renderQuota(quotaView({ rows: [withModel(model(10, 20, 30), { state: 'expired' }), row({ id: 'b' })] }, { now }), { now });
  assert.doesNotMatch(login, /qp-wins/, 'a login-required account shows no stale windows');
});

test('right panel header offers the move-to-footer button; a lone shared account gets the short hint', () => {
  const two = renderQuota(quotaView({ rows: [withModel(model(10, 20, 30)), row({ id: 'b' })] }, { now }), { now });
  assert.match(two, /data-qp-action="to-bottom" title="移到底部状态栏"/); assert.doesNotMatch(two, /<span>移到底栏<\/span>/);
  const lone = renderQuota(quotaView({ shared: true, connection: 'online', rows: [withModel(model(10, 20, 30))] }, { now }), { now });
  assert.match(lone, /qp-move with-text[^>]*title="只有 1 个号，放到底部状态栏更省地方"/); assert.match(lone, /<span>移到底栏<\/span>/);
});

test('footer with one account: one compact line with all three windows and no way back to a panel that does not exist', () => {
  const view = quotaView({ rows: [withModel(model(38, 20, 5))] }, { now });
  assert.equal(view.visible, false);
  const html = renderQuotaFooter(view, { now });
  assert.equal(html.replace(/<[^>]+>/g, ''), '研研发号今日 62%时 80%分 95%', 'avatar, name, then today · hour · minute');
  assert.doesNotMatch(html, /to-right|qp-foot-more/);
  assert.equal((html.match(/class="qp-foot-item/g) || []).length, 1);
});

test('footer with several accounts shows the current one, else the tightest one, and lists everyone on hover', () => {
  const rows = [withModel(model(10, 10, 10), { id: 'a', label: '甲号' }), withModel(model(10, 90, 10), { id: 'b', label: '乙号' }),
    row({ id: 'c', label: '丙号', state: 'expired' }), row({ id: 'd', label: '丁号' })];
  const tightest = quotaView({ rows }, { now });
  assert.equal(footerPick(tightest).id, 'b', 'the account with the least left in any current window');
  const html = renderQuotaFooter(tightest, { now });
  assert.match(html, /data-qp-account="b"/); assert.match(html, /<span class="qp-foot-more">\+3<\/span>/);
  assert.match(html, /class="qp-foot-w low" data-qp-window="hour">时 <b>10%<\/b>/);
  assert.match(html, /title="3\/4 个号可用\n/);
  for (const line of ['甲号：今日 90% · 1 小时 90% · 1 分钟 90%', '乙号：今日 90% · 1 小时 10% · 1 分钟 90%', '丙号：需登录', '丁号：未读取']) assert.ok(html.includes(line), line);
  assert.match(html, /data-qp-action="to-right"/);
  const current = quotaView({ rows }, { now, currentAccountId: 'a' });
  assert.match(renderQuotaFooter(current, { now }), /qp-foot-item is-current" data-qp-account="a"/);
  // 谁都没读数时放第一个号，写清楚它的状态
  assert.match(renderQuotaFooter(quotaView({ rows: [row({ id: 'x', state: 'expired' }), row({ id: 'y' })] }, { now }), { now }), /<b>需登录<\/b>/);
  assert.equal(renderQuotaFooter(quotaView({ rows: [] }, { now }), { now }), '');
});

function fakeEl() {
  const classes = new Set(), listeners = {};
  return { hidden: false, innerHTML: '', dataset: {}, style: {}, listeners,
    classList: { add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c) },
    setAttribute() {}, before() {}, remove() {}, append() {}, removeEventListener() {},
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    querySelector: () => null, querySelectorAll: () => [], contains: () => true };
}
function memoryStorage() { const data = {}; return { data, getItem: key => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); } }; }
function mount(rows, storage = memoryStorage()) {
  const root = fakeEl(), footerRoot = fakeEl(), select = fakeEl(), field = fakeEl();
  const placement = createQuotaPlacement({ storage });
  const document = { createElement: fakeEl, addEventListener() {}, removeEventListener() {}, activeElement: null, body: fakeEl() };
  const window = { innerWidth: 1440, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  const ipcRenderer = { invoke: async () => ({ ok: true, serveEnabled: true, rows }), on() {}, removeListener() {} };
  const panel = createCodeAgentQuotaPanel({ document, root, window, ipcRenderer, storage, now: () => now, footerRoot,
    setIntervalFn: () => 0, clearIntervalFn() {}, getPlacement: () => placement.get(), setPlacement: value => placement.set(value) });
  placement.subscribe(() => panel.render());
  placement.bindSelect(field, select);
  const click = (host, action) => {
    const target = { dataset: { qpAction: action }, disabled: false };
    host.listeners.click.forEach(fn => fn({ type: 'click', target: { closest: () => target }, preventDefault() {} }));
  };
  return { panel, root, footerRoot, select, placement, storage, click };
}

test('the move buttons switch placement at once, remember it, and keep the settings dropdown in sync', async () => {
  const rows = [withModel(model(10, 20, 30)), withModel(model(50, 20, 30), { id: 'b', label: '乙号' })];
  const ui = mount(rows);
  await ui.panel.whenIdle();
  assert.equal(ui.root.hidden, false); assert.equal(ui.footerRoot.hidden, true); assert.equal(ui.select.value, 'right');
  ui.click(ui.root, 'to-bottom');
  assert.equal(ui.placement.get(), 'bottom'); assert.equal(ui.select.value, 'bottom', 'settings dropdown follows the button');
  assert.equal(ui.root.hidden, true); assert.equal(ui.footerRoot.hidden, false);
  assert.match(ui.footerRoot.innerHTML, /今日 <b>50%<\/b>/); assert.match(ui.footerRoot.innerHTML, /data-qp-action="to-right"/);
  assert.equal(ui.storage.data['hub.codeagentQuotaPlacement'], 'bottom');
  ui.click(ui.footerRoot, 'to-right');
  assert.equal(ui.placement.get(), 'right'); assert.equal(ui.select.value, 'right');
  assert.equal(ui.root.hidden, false); assert.equal(ui.footerRoot.hidden, true);
  // 设置页下拉改了，按钮这边也跟着变
  ui.select.value = 'bottom'; ui.select.listeners.change.forEach(fn => fn());
  assert.equal(ui.root.hidden, true); assert.equal(ui.footerRoot.hidden, false);
  ui.panel.destroy();
});

test('a single account always shows in the footer, whichever placement is chosen', async () => {
  for (const choice of ['right', 'bottom']) {
    const storage = memoryStorage(); storage.setItem('hub.codeagentQuotaPlacement', choice);
    const ui = mount([withModel(model(38, 20, 5))], storage);
    await ui.panel.whenIdle();
    assert.equal(ui.root.hidden, true, choice);
    assert.equal(ui.footerRoot.hidden, false, choice);
    assert.match(ui.footerRoot.innerHTML, /今日 <b>62%<\/b>/); assert.doesNotMatch(ui.footerRoot.innerHTML, /to-right/);
    ui.panel.destroy();
  }
});
