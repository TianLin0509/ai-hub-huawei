'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// 执行真实面板的打开 / 关闭流程；最小 DOM 只承接布局，不模拟可用性判断。
function panelFixture({ edition, probe }) {
  const filename = path.join(__dirname, '../renderer/capability-panel.js'), localRequire = createRequire(filename);
  const classes = { add() {}, remove() {}, toggle() {} };
  const listeners = {}, externalUrls = [];
  let page;
  const doc = { addEventListener() {}, getElementById() { return null; }, body: { classList: classes, appendChild() {} },
    createElement() { return page = { classList: classes, style: {}, setAttribute() {}, addEventListener(name, fn) { listeners[name] = fn; },
      querySelector(selector) { return selector === '.cp-scroll' ? { scrollTop: 0 } : null; }, innerHTML: '', hidden: false }; } };
  const calls = [];
  const ipcRenderer = { on() {}, async invoke(channel, payload) {
    calls.push(channel);
    if (channel === 'capabilities:market-status') return probe();
    if (channel === 'capabilities:catalog') return { ok: true, data: { rows: [], sessions: [], generatedAt: 0 } };
    if (channel === 'open-external-url') { externalUrls.push(payload);return { success: true }; }
    throw Error('非预期 IPC：' + channel);
  } };
  const context = { module: { exports: {} }, window: { addEventListener() {} }, URL,
    require: name => name === '../core/distribution' ? { ...edition, kindAllowed: () => true } : localRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const panel = context.module.exports.createCapabilityPanel({ document: doc, ipcRenderer,
    escapeHtml: value => String(value || ''), getActiveSessionId: () => '' });
  return { panel, calls, externalUrls, click: action => listeners.click({ target: { closest: () => ({ dataset: { cpAction: action } }) } }), html: () => page.innerHTML };
}

test('公司版先探测：未收到可用结果不渲染页签，确认 CodeAgent 可用才出现', async () => {
  let reply;
  const fixture = panelFixture({ edition: { community: true, target: 'company' },
    probe: () => new Promise(resolve => { reply = resolve; }) });
  const pending = fixture.panel.open();
  assert.doesNotMatch(fixture.html(), /data-cp-tab="market"/);
  reply({ ok: true, data: { available: true } });await pending;
  assert.match(fixture.html(), /data-cp-tab="market"/);
});

test('缺少 CodeAgent、探测失败或重新打开后不可用，都不渲染市场页签', async () => {
  let result = { ok: true, data: { available: true } };
  const fixture = panelFixture({ edition: { community: true, target: 'company' }, probe: () => result });
  await fixture.panel.open();assert.match(fixture.html(), /data-cp-tab="market"/);
  for (result of [{ ok: true, data: { available: false } }, { ok: false, error: '探测失败' }]) {
    fixture.panel.close();await fixture.panel.open();assert.doesNotMatch(fixture.html(), /data-cp-tab="market"/);
  }
  const failed = panelFixture({ edition: { community: true, target: 'company' }, probe: () => { throw Error('连接断开'); } });
  await failed.panel.open();assert.doesNotMatch(failed.html(), /data-cp-tab="market"/);
});

test('非公司公开版不渲染市场，也不调用公司市场探测接口', async () => {
  const fixture = panelFixture({ edition: { community: true, target: 'public' }, probe: () => assert.fail('不应探测公司市场') });
  await fixture.panel.open();
  assert.doesNotMatch(fixture.html(), /data-cp-tab="market"/);
  assert.deepEqual(fixture.calls, ['capabilities:catalog']);
});

test('面板关闭后到达的探测回执不更新已关闭页面', async () => {
  let reply;
  const fixture = panelFixture({ edition: { community: true, target: 'company' }, probe: () => new Promise(resolve => { reply = resolve; }) });
  const pending = fixture.panel.open();fixture.panel.close();
  reply({ ok: true, data: { available: true } });await pending;
  assert.doesNotMatch(fixture.html(), /data-cp-tab="market"/);
  assert.equal(fixture.calls.length, 1);
});

test('打开 AgentCenter 复用已批准的官方入口与系统外链 IPC', async () => {
  const fixture=panelFixture({edition:{community:true,target:'company'},probe:()=>({ok:true,data:{available:true}})});
  await fixture.panel.open();fixture.click('market-browse');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(fixture.externalUrls,[new URL(require('../renderer/codeagent-setup').OFFICIAL_INSTALL_URL).origin]);
});
