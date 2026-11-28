'use strict';
// 底栏「用户群」与一键入群·统一包（公开版）也带的那部分：群表与按钮、弹层行为、账号格式、发送端、结果提示。
// 收件机（拉人、限流、日志）与公开版裁剪规则的测试在 unit-welink-join / unit-welink-user-groups，只留成员版。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mod = require('../renderer/welink-user-groups.js');
const groupsConfig = require('../core/welink-user-groups');
const { normalizeAccount } = require('../core/welink-account-format');
const { createWelinkJoinClient, OFFLINE_HINT } = require('../main/welink-join-client');

const IDS = mod.WELINK_USER_GROUPS.map(group => group.id);
const OPEN = groupsConfig.listGroups().find(g => !g.full);
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-join-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('listGroups 丢掉不完整的配置项，方便以后加 3 群时写错也不出坏行', () => {
  assert.deepEqual(mod.listGroups([{ name: ' 3 群 ', id: '1234567' }, { name: '', id: '1234567' }, { name: 'x', id: 'abc' }, null]), [{ name: '3 群', id: '1234567', full: false }]);
  assert.equal(mod.userGroupsButtonHtml({ groups: [] }), '');
});

test('按钮紧凑：带图标和「用户群」三个字，悬停写清用途，展开状态跟随弹层', () => {
  const closed = mod.userGroupsButtonHtml({ open: false });
  assert.match(closed, /class="strip-user-groups"/);
  assert.match(closed, />用户群</);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /title="[^"]*WeLink[^"]*搜索框粘贴/);
  assert.ok(!IDS.some(id => closed.includes(id)), '按钮本身不放群号');
  assert.match(mod.userGroupsButtonHtml({ open: true }), /aria-expanded="true"/);
});

// ---- 弹层行为：最小 DOM 桩 ----
function fakeDom() {
  const listeners = { doc: {}, strip: {}, panel: {}, win: {} };
  const on = bag => (type, fn) => { (bag[type] ||= []).push(fn); };
  let button = { attrs: { 'aria-expanded': 'false' }, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, focus() {}, getBoundingClientRect: () => ({ left: 600, top: 870 }) };
  const strip = {
    addEventListener: on(listeners.strip),
    querySelector: sel => sel === '[data-welink-user-groups]' ? button : null,
    getBoundingClientRect: () => ({ left: 0, top: 870 }),
  };
  const nodes = {};
  const makeEl = tag => {
    const el = { tag, dataset: {}, style: {}, attrs: {}, hidden: false, textContent: '', offsetWidth: 320,
      setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener: on(listeners.panel),
      contains: target => target?.inPanel === true,
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      querySelector(sel) { if (sel === '[data-wug-status]') return (this._status ||= { dataset: {}, textContent: '' }); return null; } };
    return el;
  };
  const doc = {
    head: { appendChild: el => { nodes.style = el; } },
    body: { appendChild: el => { nodes[el.id] = el; } },
    documentElement: { clientWidth: 1440, clientHeight: 900 },
    defaultView: { addEventListener: on(listeners.win) },
    createElement: makeEl,
    getElementById: id => id === 'sidebar-strip' ? strip : nodes[id] || null,
    addEventListener: on(listeners.doc),
  };
  const fire = (bag, type, event) => (bag[type] || []).forEach(fn => fn(event));
  const target = (match, extra = {}) => ({ closest: sel => (match === sel ? {} : null), ...extra });
  return { doc, listeners, fire, target, nodes, replaceButton() { button = { ...button, attrs: { 'aria-expanded': mod.userGroupsButtonHtml().includes('aria-expanded="true"') ? 'true' : 'false' } }; return button; }, get button() { return button; } };
}

test('点按钮开弹层、点复制写剪贴板并提示，心跳重绘按钮后弹层仍开着，点外面/Esc 关闭', async () => {
  mod._state.open = false;
  const dom = fakeDom();
  const written = [];
  const api = mod.attachWelinkUserGroups({ document: dom.doc, clipboard: { writeText: value => { written.push(value); } } });
  assert.ok(api);
  const panel = dom.nodes['welink-user-groups-panel'];
  assert.equal(panel.hidden, true);
  assert.equal(IDS.every(id => panel.innerHTML.includes(id)), true);
  assert.equal((panel.innerHTML.match(/data-wug-copy=/g) || []).length, 2);
  const rows = panel.innerHTML.split('<div class="wug-row"').slice(1);
  assert.match(rows[0], /用户群 2 群<span class="wug-tag wug-tag-recommended">推荐<\/span>/);
  assert.match(rows[1], /data-full="true"/);
  assert.match(rows[1], /用户群 1 群<span class="wug-tag wug-tag-full">已满 500 人<\/span>/);
  assert.ok(rows.every(row => /<span class="wug-action" data-wug-action hidden><\/span>/.test(row)), '每行预留隐藏的操作位');
  assert.ok(dom.nodes.style.textContent.includes('.strip-user-groups'));

  dom.fire(dom.listeners.strip, 'click', { target: dom.target('[data-welink-user-groups]'), preventDefault() {} });
  assert.equal(panel.hidden, false);
  assert.equal(dom.button.attrs['aria-expanded'], 'true');
  assert.equal(panel.style.left, '600px');
  assert.equal(panel.style.bottom, '36px');

  // 心跳重绘：按钮被换成新节点（展开状态从模块状态读），弹层挂在 body 上不受影响。
  const fresh = dom.replaceButton();
  assert.equal(fresh.attrs['aria-expanded'], 'true');
  assert.equal(panel.hidden, false);

  const copyTarget = { closest: sel => (sel === '[data-wug-copy]' ? { dataset: { wugCopy: IDS[1] } } : null) };
  dom.fire(dom.listeners.panel, 'click', { target: copyTarget });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(written, [IDS[1]]);
  assert.equal(panel.querySelector('[data-wug-status]').textContent, mod.COPIED_HINT);

  // 在弹层里按下不关；在外面按下关闭。
  dom.fire(dom.listeners.doc, 'pointerdown', { target: { inPanel: true, closest: () => null } });
  assert.equal(panel.hidden, false);
  dom.fire(dom.listeners.doc, 'pointerdown', { target: { closest: () => null } });
  assert.equal(panel.hidden, true);
  assert.equal(mod.userGroupsButtonHtml().includes('aria-expanded="false"'), true);

  dom.fire(dom.listeners.strip, 'click', { target: dom.target('[data-welink-user-groups]'), preventDefault() {} });
  assert.equal(panel.hidden, false);
  dom.fire(dom.listeners.doc, 'keydown', { key: 'Escape' });
  assert.equal(panel.hidden, true);
  assert.equal(mod.attachWelinkUserGroups({ document: dom.doc, clipboard: {} }), null, '重复挂载不建第二个弹层');
});

test('剪贴板失败时提示手动复制，不静默', async () => {
  mod._state.open = false;
  const dom = fakeDom();
  mod.attachWelinkUserGroups({ document: dom.doc, clipboard: { writeText: () => { throw new Error('denied'); } } });
  const panel = dom.nodes['welink-user-groups-panel'];
  dom.fire(dom.listeners.panel, 'click', { target: { closest: sel => (sel === '[data-wug-copy]' ? { dataset: { wugCopy: IDS[0] } } : null) } });
  await new Promise(resolve => setImmediate(resolve));
  const status = panel.querySelector('[data-wug-status]');
  assert.equal(status.dataset.level, 'error');
  assert.match(status.textContent, /复制失败.*手动/);
});

test('account format: letters + digits, normalized to lower case', () => {
  for (const ok of ['a00123456', 'ABC1234567', ' wwx123456 ']) assert.ok(normalizeAccount(ok), ok);
  for (const bad of ['', '123456', 'abc', 'a0012345678901234567x', 'a001;rm', 'a 00123456', 'a001\n23456','--group-id', null, 42])
    assert.equal(normalizeAccount(bad), '', String(bad));
  assert.equal(normalizeAccount('ABC1234567'), 'abc1234567');
});

// ---- 发送端 ----
function fakeReceiverFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return handler(url, init); };
  return { fetchImpl, calls };
}
const reply = (status, json) => ({ ok: status < 300, status, text: async () => JSON.stringify(json) });
const addr = urls => ({ resolve: async () => ({ urls }) });

test('client: account from local WeLink login; otherwise asks once and remembers', async t => {
  const dir = tmp(t);
  const f = fakeReceiverFetch(() => reply(200, { ok: true, result: 'joined', group: { id: OPEN.id, name: OPEN.name } }));
  const c = createWelinkJoinClient({ dataDir: dir, receiverAddress: addr(['http://10.0.0.9:18767']), fetchImpl: f.fetchImpl });
  assert.equal(c.state().needAccount, true);
  const need = await c.join({ group: OPEN.id });
  assert.equal(need.needAccount, true); assert.equal(f.calls.length, 0);
  assert.equal((await c.join({ group: OPEN.id, account: 'bad!' })).needAccount, true);
  const ok = await c.join({ group: OPEN.id, account: 'A00000009' });
  assert.equal(ok.ok, true); assert.match(ok.message, new RegExp('已加入 ' + OPEN.name));
  assert.equal(f.calls[0].url, 'http://10.0.0.9:18767/join/v1/request');
  assert.deepEqual(f.calls[0].body, { account: 'a00000009', group: OPEN.id });
  assert.equal(c.state().account, 'a00000009');
  // 本机 WeLink 登录的身份优先
  fs.mkdirSync(path.join(dir, 'company-assistant'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'company-assistant', 'auth.json'), JSON.stringify({ state: 'online', login: { ok: true, uid: 'b00000001' } }));
  assert.equal(c.state().account, 'b00000001');
});

test('client: offline receiver, no address, old receiver → offline hint; result messages', async t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'welink-join.json'), JSON.stringify({ account: 'a00000009' }));
  const down = fakeReceiverFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
  const c1 = createWelinkJoinClient({ dataDir: dir, receiverAddress: addr(['http://10.0.0.9:18767', 'http://10.0.0.8:18767']), fetchImpl: down.fetchImpl, logger: { warn() {} } });
  const r1 = await c1.join({ group: OPEN.id });
  assert.equal(r1.offline, true); assert.equal(r1.message, OFFLINE_HINT); assert.equal(down.calls.length, 2);
  assert.equal((await createWelinkJoinClient({ dataDir: dir, receiverAddress: addr([]) }).join({})).message, OFFLINE_HINT);
  const old = fakeReceiverFetch(() => reply(404, { ok: false, error: 'not found' }));
  assert.equal((await createWelinkJoinClient({ dataDir: dir, receiverAddress: addr(['http://10.0.0.9:18767']), fetchImpl: old.fetchImpl, logger: { warn() {} } }).join({})).offline, true);
  const mk = json => createWelinkJoinClient({ dataDir: dir, receiverAddress: addr(['http://10.0.0.9:18767']), fetchImpl: fakeReceiverFetch(() => reply(json.ok ? 200 : 429, json)).fetchImpl });
  assert.match((await mk({ ok: true, result: 'already', group: { name: OPEN.name } }).join({})).message, new RegExp('你已在 ' + OPEN.name));
  assert.match((await mk({ ok: true, result: 'joined', group: { name: 'G3' }, redirectedFrom: { name: 'G2' } }).join({})).message, /G2已满，已为你加入 G3/);
  const limited = await mk({ ok: false, code: 'rate_limited', error: '申请太频繁：同一个账号一天最多 3 次' }).join({});
  assert.equal(limited.ok, false); assert.match(limited.message, /一天最多 3 次/);
  assert.equal((await mk({}).join({ group: '42' })).message, '只能加入 AI HUB-H 用户群');
});

test('ui: first-time missing account is a neutral prompt, bad format is red, results map to ok/error', () => {
  const { describeResult } = require('../renderer/welink-join-ui');
  assert.deepEqual(describeResult({ ok: false, needAccount: true, message: 'm' }), { text: 'm', level: 'info', askAccount: true });
  assert.equal(describeResult({ ok: false, needAccount: true, invalid: true, message: 'm' }).level, 'error');
  assert.deepEqual(describeResult({ ok: true, message: '已加入 X' }), { text: '已加入 X', level: 'ok', askAccount: false });
  assert.deepEqual(describeResult({ ok: false, offline: true, message: OFFLINE_HINT }), { text: OFFLINE_HINT, level: 'error', askAccount: false });
  assert.equal(describeResult(null).level, 'error');
});
