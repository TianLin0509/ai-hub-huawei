'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { CompanyAttendance } = require('../core/company-attendance/service');
const { CompanyForum, dayKey } = require('../core/company-forum/service');
const { EXTRACTION_VERSION } = require('../core/company-forum/extract');
const { createForumBrowser } = require('../main/company-forum-browser');
const { looksLikeLogin } = require('../core/company-forum/extract');
const originalLogin = require('./fixtures/company-forum-login-407a7af.cjs');
const { registerCompanyForumIpc } = require('../main/ipc/company-forum-handlers');
const turn = () => new Promise(resolve => setImmediate(resolve));
const base = 'https://jx.corp.example';
const url = base + '/?menuKey=hot';

function service(t, browser) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-edges-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const forum = new CompanyForum({ dataDir, browser, accountEmail: () => 'user@corp.example', noTimer: true, noCollect: true });
  forum.setSettings({ summarize: 0 });
  return forum;
}
function ipc(forum) {
  const handlers = new Map();
  registerCompanyForumIpc({ handle: (name, handler) => handlers.set(name, handler) }, forum);
  return (name, request) => handlers.get('company-forum:' + name)({}, request);
}
function seedLegacy(forum, version) {
  const snap = { day: dayKey(), at: Date.now(), sites: ['jx', 'xinsheng'].map(id => ({ id, ok: true, lists: [] })) };
  if (version !== undefined) snap.extractionVersion = version;
  forum.write(`forum-${snap.day}.json`, snap);
}
const loginPage = args => ({ finalUrl: args.url, text: '请输入账号', textLength: 5, needsLogin: true, json: [], sections: [], links: [] });
const normalPage = args => ({ finalUrl: args.url, text: '论坛正常内容 '.repeat(20), textLength: 140, needsLogin: false, json: [], sections: [], links: [] });
function loginState(forum, id) { return forum.status().sites.find(s => s.id === id); }

for (const version of [undefined, 0, 1, 2]) {
  test(`打开页面重抽旧版本当天快照且只重抽一次，旧版本=${version}`, async t => {
    let captures = 0;
    const forum = service(t, { capture: async args => { captures += 1; return normalPage(args); } });
    seedLegacy(forum, version);
    const call = ipc(forum);
    await call('ensure-today');
    await forum.syncing;
    await call('ensure-today');
    await turn();
    assert.equal(captures, 2);
    assert.ok(Number.isInteger(EXTRACTION_VERSION) && EXTRACTION_VERSION > 0);
    assert.equal(forum.snapshot().extractionVersion, EXTRACTION_VERSION);
    assert.equal(forum.status().needsRefresh, false);
  });
}

test('只同步一站不能把另一站的旧快照标成新版', async t => {
  let captures = 0;
  const forum = service(t, { capture: async args => { captures += 1; return normalPage(args); } });
  seedLegacy(forum);
  await forum.sync({ sites: ['jx'], reason: 'login' });
  await ipc(forum)('ensure-today');
  await forum.syncing;
  assert.equal(captures, 3);
  assert.equal(forum.status().needsRefresh, false);
});

test('关闭自动同步时打开旧快照不抓取', async t => {
  let captures = 0;
  const forum = service(t, { capture: async args => { captures += 1; return normalPage(args); } });
  seedLegacy(forum);
  forum.setSettings({ enabled: false });
  await ipc(forum)('ensure-today');
  await turn();
  assert.equal(captures, 0);
});

function clock(t) { t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1800000000000 }); }
async function advance(t, milliseconds) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 100) {
    t.mock.timers.tick(Math.min(100, milliseconds - elapsed));
    await turn();
  }
}
function browserFixture(t, { readyAfter = Infinity, text = '统一身份认证 请输入账号 请输入密码', passwordInput = false, responses = [], factory = createForumBrowser } = {}) {
  const windows = [], started = Date.now();
  let authenticated = false;
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.dead = false;
      const debuggerApi = Object.assign(new EventEmitter(), {
        isAttached: () => false, attach() {}, detach() {},
        sendCommand: async (command, args) => command === 'Network.getResponseBody'
          ? { body: JSON.stringify(responses[Number(args.requestId)].json), base64Encoded: false } : {},
      });
      this.webContents = Object.assign(new EventEmitter(), {
        debugger: debuggerApi, setAudioMuted() {}, setWindowOpenHandler() {}, getURL: () => this.url || 'about:blank',
        executeJavaScript: async script => {
          if (script.includes('el.scrollIntoView')) return false;
          const body = authenticated || Date.now() - started >= readyAfter ? '已登录的论坛首页 '.repeat(20) : text;
          if (script.startsWith('document.body')) return body.length;
          if (script.startsWith('({ n:')) return vm.runInNewContext(script, {
            document: {
              body: { innerText: body },
              querySelector: selector => !authenticated && passwordInput && selector === 'input[type="password"]' ? {} : null,
            },
          });
          return { finalUrl: this.url, text: body, textLength: body.length, sections: [], links: [] };
        },
      });
      windows.push(this);
    }
    async loadURL(target) {
      this.url = target;
      responses.forEach((response, index) => {
        this.webContents.debugger.emit('message', {}, 'Network.responseReceived', {
          requestId: String(index), response: { url: response.url, status: response.status || 200, mimeType: 'application/json' },
        });
        this.webContents.debugger.emit('message', {}, 'Network.loadingFinished', { requestId: String(index), encodedDataLength: 100 });
      });
    }
    isDestroyed() { return this.dead; }
    destroy() { if (!this.dead) { this.dead = true; this.emit('closed'); } }
    show() { this.shown = true; }
    focus() { this.focused = true; }
  }
  const browser = factory({ BrowserWindow: Window, logger: { warn() {} } });
  t.after(() => browser.close());
  return { browser, windows, authenticate() { authenticated = true; } };
}

test('经论坛服务抓取时等待第八秒自动 SSO 返回', async t => {
  clock(t);
  const { browser, windows } = browserFixture(t, { readyAfter: 8000 });
  const options = [];
  const forum = service(t, { capture: args => { options.push(args); return browser.capture(args); } });
  let result;
  forum.sync().then(r => { result = r; });
  await advance(t, 24000);
  assert.equal(result?.sites[0].needsLogin, false);
  assert.ok(options.every(args => args.loginGraceMs === 25000));
  assert.equal(windows.filter(w => w.options.show).length, 0);
  assert.ok(windows.every(w => w.dead));
});

test('跨站登录占用原因经 IPC 状态传到真实页面渲染函数', async t => {
  clock(t);
  const { browser, windows } = browserFixture(t);
  const forum = service(t, browser);
  const call = ipc(forum);
  seedLegacy(forum);
  const snap = forum.snapshot();
  snap.sites.forEach(entry => { entry.needsLogin = true; entry.error = '需要登录'; });
  forum.write(`forum-${snap.day}.json`, snap);
  await call('login', { site: 'xinsheng' });
  await turn();
  await call('login', { site: 'jx' });
  await turn();
  const data = await call('status');
  const jx = loginState(forum, 'jx');
  assert.equal(jx.login, 'closed');
  assert.match(jx.loginError, /心声.*登录窗口.*(?:登录|关)/);
  assert.equal(windows.filter(w => w.options.show).length, 1);
  assert.match(windows[0].url, /xinsheng/);
  const source = fs.readFileSync(path.join(__dirname, '../renderer/company-forum-page.js'), 'utf8');
  const functions = source.slice(source.indexOf('  function siteHtml(site) {'), source.indexOf('  function panelHtml() {'));
  const render = new Function('data', 'tab', 'esc', 'when', 'num', 'postKey', functions + '\nreturn siteHtml(data.sites.find(s => s.id === "jx"));');
  const html = render(data, {}, String, String, String, (id, title) => id + '|' + title);
  assert.match(html, /心声.*登录窗口.*(?:登录|关)/);
});

for (const siteIds of [['jx'], ['jx', 'xinsheng', 'jx']]) {
  test(`同步期间登录成功合并为一次补抓，登录顺序=${siteIds.join(',')}`, async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const requests = [];
    const forum = service(t, {
      capture: async args => {
        requests.push(args);
        if (requests.length <= 2) { await pending; return loginPage(args); }
        return normalPage(args);
      },
      login: async () => ({ ok: true }),
    });
    const syncing = forum.sync();
    for (const id of siteIds) { await ipc(forum)('login', { site: id }); await turn(); }
    assert.equal(requests.length, 1);
    release();
    await syncing;
    for (let i = 0; i < 5; i += 1) await turn();
    const expectedCaptures = siteIds.length === 1 ? 3 : 4;
    assert.equal(requests.length, expectedCaptures);
    assert.equal(forum.snapshot().reason, 'login');
    for (const id of new Set(siteIds)) {
      assert.equal(loginState(forum, id).login, 'ok');
      assert.equal(forum.snapshot().sites.find(s => s.id === id).needsLogin, false);
    }
    assert.equal(forum.syncing, null);
  });
}

const englishShortPages = [
  { text: 'Attendance dashboard. Last log in yesterday. Records are ready. '.repeat(3), passwordInput: false },
  { text: 'Design insights from our engineering team. '.repeat(4), passwordInput: true },
  { text: 'Catalog information for all available equipment. '.repeat(4), passwordInput: true },
];
for (const scenario of englishShortPages) {
  for (const operation of ['capture', 'detail', 'login']) {
    test(`正常英文短页 ${operation} 可以完成，正文=${scenario.text.slice(0, 20)}`, async t => {
      clock(t);
      const { browser } = browserFixture(t, scenario);
      let result;
      browser[operation]({ url, base, site: 'jx' }).then(r => { result = r; });
      await advance(t, 10000);
      if (operation === 'login') assert.equal(result?.ok, true);
      else assert.equal(result?.needsLogin, false);
    });
  }
}

function renderOverview(data) {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/company-forum-page.js'), 'utf8');
  const definition = source.slice(source.indexOf('  function overviewHtml() {'), source.indexOf('  function siteShort('));
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return new Function('data', 'esc', 'when', definition + '\nreturn overviewHtml();')(data, escape, String);
}

test('自动同步关闭的旧版本当天快照显示手动刷新提示', async t => {
  let captures = 0;
  const forum = service(t, { capture: async args => { captures += 1; return normalPage(args); } });
  seedLegacy(forum);
  forum.setSettings({ enabled: false });
  const data = await ipc(forum)('ensure-today');
  assert.equal(captures, 0);
  assert.match(renderOverview(data), /这是旧版本抓的，点刷新更新/);
});

test('手动同步落盘失败进入可见状态，重试成功后清除原因', async t => {
  const forum = service(t, { capture: async args => normalPage(args) });
  const temporary = forum.file(`forum-${forum.status().day}.json.${process.pid}.tmp`);
  fs.mkdirSync(temporary);
  await assert.rejects(forum.sync(), { code: 'EISDIR' });
  assert.match(forum.status().syncError || '', /EISDIR/);
  assert.match(renderOverview(forum.status()), /EISDIR/);
  fs.rmdirSync(temporary);
  await forum.sync();
  assert.equal(forum.status().syncError, '');
  assert.doesNotMatch(renderOverview(forum.status()), /EISDIR/);
});

test('登录后的补抓落盘失败进入页面状态且不会自行重复补抓', async t => {
  const releases = [];
  let captures = 0;
  const forum = service(t, {
    capture: async args => {
      captures += 1;
      await new Promise(resolve => { releases.push(resolve); });
      return captures <= 2 ? loginPage(args) : normalPage(args);
    },
    login: async () => ({ ok: true }),
  });
  const original = forum.sync();
  await forum.login('jx'); await turn();
  releases.shift()(); await turn();
  releases.shift()(); await original; await turn();
  assert.equal(captures, 3);
  fs.mkdirSync(forum.file(`forum-${forum.status().day}.json.${process.pid}.tmp`));
  const followup = forum.syncing;
  releases.shift()();
  await assert.rejects(followup, { code: 'EISDIR' });
  await turn();
  const data = await ipc(forum)('status');
  assert.match(data.syncError || '', /EISDIR/);
  assert.match(renderOverview(data), /EISDIR/);
  assert.equal(data.syncing, false);
  assert.equal(captures, 3);
  assert.equal(forum.pendingLoginSites.size, 0);
});

test('登录识别与 407a7af 一致', async t => {
  const scenarios = [
    { name: 'NEW_ENGLISH_CAPTURE', text: 'Sign in. Enter your company account and password to continue. '.repeat(3), passwordInput: true, operation: 'capture' },
    { name: 'NEW_QR_LOGIN', text: 'Sign in with your company account. Scan the QR code using your phone to continue. '.repeat(2), operation: 'login' },
    { name: 'NEW_BUSINESS_ERROR', text: '统一身份认证 请输入账号和密码', operation: 'attendance', responses: [{
      url: 'https://hr.corp.example/attendanceCompanion/services/attendance/card/queryCardRecord',
      status: 200, json: { code: 401, message: 'not authenticated', data: [] },
    }] },
    { name: 'NEW_BUSINESS_SSO', text: '统一身份认证 请输入账号和密码', readyAfter: 8000, operation: 'capture', responses: [{
      url: base + '/jxService/v1/auth/config', status: 200, json: { loginRequired: true },
    }] },
    { name: 'Last log in', text: 'Welcome to your account dashboard. Last log in yesterday. Everything is ready. '.repeat(2), passwordInput: true, operation: 'login' },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async t => {
      clock(t);
      const results = [];
      for (const reference of [true, false]) {
        const factory = reference ? originalLogin.createForumBrowser : createForumBrowser;
        const extractLogin = reference ? originalLogin.looksLikeLogin : looksLikeLogin;
        const { browser } = browserFixture(t, { ...scenario, factory });
        let result;
        if (scenario.operation === 'attendance') {
          const forum = service(t, browser);
          const attendance = new CompanyAttendance({ dataDir: forum.deps.dataDir, browser, noTimer: true, accountEmail: () => 'user@corp.example' });
          attendance.setSettings({ domain: 'corp.example' });
          attendance.sync().then(r => { result = r; });
          await advance(t, 40000);
          assert.ok(result);
          const state = attendance.read('state', {});
          results.push({ ok: result.ok, needsLogin: result.needsLogin, lastSuccessDay: state.lastSuccessDay || null });
        } else if (scenario.operation === 'login') {
          const observations = [];
          for (const suffix of ['/?menuKey=hot', '/signin']) {
            result = undefined;
            browser.login({ url: base + suffix, base, site: 'jx' }).then(r => { result = r; });
            await advance(t, 4500);
            observations.push(result || null);
          }
          results.push({ observations, extractLogin: extractLogin({ finalUrl: url, text: scenario.text, textLength: scenario.text.length }, base) });
        } else {
          browser.capture({ url, api: /jxService/, loginGraceMs: 25000 }).then(r => { result = r; });
          await advance(t, 35000);
          assert.ok(result);
          results.push({ capture: result, extractLogin: extractLogin(result, base) });
        }
      }
      assert.deepEqual(results[1], results[0]);
    });
  }
});
