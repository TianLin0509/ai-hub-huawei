'use strict';
// 公司网页登录体检（R60）：只记 cookie 个数、会话级/持久、剩余有效期，不记名字、值和域名。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { summarize, createLoginCheck, LOG_FILE } = require('../core/company-forum/cookie-health');
const { createForumBrowser } = require('../main/company-forum-browser');

const NOW = 1_800_000_000;
const COOKIES = [
  { name: 'SSO_SECRET_NAME', value: 'SECRET_VALUE_1', domain: '.corp.example', session: true },
  { name: 'login_tgc', value: 'SECRET_VALUE_2', domain: 'login.corp.example', session: true },
  { name: 'login_keep', value: 'SECRET_VALUE_3', domain: 'login.corp.example', session: false, expirationDate: NOW + 8 * 3600 },
  { name: 'jx_pref', value: 'SECRET_VALUE_4', domain: 'jx.corp.example', session: false, expirationDate: NOW + 30 * 24 * 3600 },
  { name: 'hr_x', value: 'SECRET_VALUE_5', domain: '.hr.corp.example', session: true },
  { name: 'foreign', value: 'SECRET_VALUE_6', domain: '.other.example', session: true },
];
const SECRETS = /SECRET|SSO_SECRET_NAME|login_tgc|login_keep|jx_pref|hr_x|foreign|corp\.example|other\.example/;

test('summarize：按根域/登录站/目标站/其他分组计数，只算公司根域下的 cookie，不带名字、值和域名', () => {
  const s = summarize(COOKIES, 'https://jx.corp.example/home', NOW);
  assert.equal(s.total, 5);
  assert.equal(s.session, 3);
  assert.equal(s.persistent, 2);
  assert.equal(s.minLeftH, 8);
  assert.equal(s.maxLeftH, 720);
  assert.deepEqual(s.groups, {
    root: { session: 1, persistent: 0, minLeftH: null },
    login: { session: 1, persistent: 1, minLeftH: 8 },
    site: { session: 0, persistent: 1, minLeftH: 720 },
    other: { session: 1, persistent: 0, minLeftH: null },
  });
  assert.doesNotMatch(JSON.stringify(s), SECRETS);
  assert.deepEqual(summarize(COOKIES, 'not a url', NOW).total, 0);
});

function fakeSession(cookies = COOKIES) {
  const calls = { flush: 0, get: 0 };
  return { calls, cookies: { async get() { calls.get += 1; return cookies; }, async flushStore() { calls.flush += 1; } } };
}

test('record：写一行进 logs/company-login-check.log，登好时先写盘；同一时刻类型 30 分钟只记一次', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-check-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = NOW * 1000;
  const check = createLoginCheck({ dataDir, now: () => now, logger: { info() {} } });
  const ses = fakeSession();
  const a = await check.record(ses, 'login-ok', 'https://jx.corp.example/', { flush: true });
  assert.equal(a.stage, 'login-ok');
  assert.equal(a.session, 3);
  assert.equal(ses.calls.flush, 1);
  assert.equal(await check.record(ses, 'login-ok', 'https://jx.corp.example/'), null, '30 分钟内同类不重复记');
  assert.ok(await check.record(ses, 'needs-login', 'https://jx.corp.example/'), '另一类照记');
  now += 31 * 60000;
  assert.ok(await check.record(ses, 'login-ok', 'https://jx.corp.example/'));
  const lines = fs.readFileSync(path.join(dataDir, 'logs', LOG_FILE), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.doesNotMatch(lines.join('\n'), SECRETS);
  assert.equal(JSON.parse(lines[1]).stage, 'needs-login');
  // 读 cookie 出错不抛
  assert.equal(await createLoginCheck({ dataDir }).record({ cookies: { get: async () => { throw new Error('x'); } } }, 'login-ok', 'https://jx.corp.example/'), null);
});

function fakeWindows(url, page) {
  class Window extends EventEmitter {
    constructor() {
      super(); this.dead = false;
      this.webContents = Object.assign(new EventEmitter(), { setAudioMuted() {}, setWindowOpenHandler() {}, getURL: () => url,
        executeJavaScript: async () => page, debugger: { isAttached: () => false, attach() {}, on() {}, removeListener() {}, detach() {}, sendCommand: async () => ({}) } });
    }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return this.dead; }
    destroy() { if (!this.dead) { this.dead = true; this.emit('closed'); } }
    show() {} focus() {}
  }
  return Window;
}

test('登录窗口判定登好时做一次体检（先写盘），用的是同一个登录分区', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW * 1000 });
  const calls = [];
  const ses = fakeSession();
  const session = { fromPartition: p => { calls.push(['partition', p]); return ses; } };
  const loginCheck = { record: async (s, stage, url, opts) => { calls.push([stage, url, !!opts?.flush, s === ses]); } };
  const Window = fakeWindows('https://jx.corp.example/home', { n: 500, t: '热点 帖子 首页' });
  const browser = createForumBrowser({ BrowserWindow: Window, session, loginCheck, logger: { warn() {} } });
  t.after(() => browser.close());
  let result;
  browser.login({ url: 'https://jx.corp.example/', base: 'https://jx.corp.example' }).then(r => { result = r; });
  for (let i = 0; i < 8 && !result; i += 1) { t.mock.timers.tick(1000); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); }
  assert.equal(result?.ok, true);
  assert.deepEqual(calls, [['partition', 'persist:company-forum'], ['login-ok', 'https://jx.corp.example', true, true]]);
});

test('经统一登录入口进站：登录站的 cookie 仍归「登录站」，不因目标页是登录入口而算成目标站（审查 P2）', () => {
  const s = summarize(COOKIES, 'https://login.corp.example/login1/?redirect=https%3A%2F%2Fjx.corp.example%2F', NOW);
  assert.deepEqual(s.groups.login, { session: 1, persistent: 1, minLeftH: 8 });
  assert.equal(s.groups.site, undefined);
});

test('取数发现要登录时，体检按目标站（base）分组，而不是登录入口（审查 P2）', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW * 1000 });
  const seen = [];
  const session = { fromPartition: () => fakeSession() };
  const loginCheck = { record: async (_s, stage, url) => { seen.push([stage, url]); } };
  const loginPage = { finalUrl: 'https://login.corp.example/login1/', title: '登录', textLength: 200, text: '账号登录 扫码登录 忘记密码', links: [], sections: [] };
  const Window = fakeWindows('https://login.corp.example/login1/', loginPage);
  const browser = createForumBrowser({ BrowserWindow: Window, session, loginCheck, logger: { warn() {} } });
  t.after(() => browser.close());
  let result;
  browser.capture({ url: 'https://login.corp.example/login1/?redirect=https%3A%2F%2Fjx.corp.example%2F', base: 'https://jx.corp.example' }).then(r => { result = r; });
  for (let i = 0; i < 60 && !result; i += 1) { t.mock.timers.tick(500); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); }
  assert.equal(result?.needsLogin, true);
  assert.deepEqual(seen, [['needs-login', 'https://jx.corp.example']]);
});

test('一键反馈精简版的「当时的状态」带上最近一次登好与要登录时的体检摘要（审查 P1）', async t => {
  const { feedbackSummary } = require('../core/company-forum/cookie-health');
  const { slimFeedback } = require('../core/hub-feedback-slim');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-check-fb-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const now = NOW * 1000;
  const check = createLoginCheck({ dataDir, now: () => now, logger: { info() {} } });
  await check.record(fakeSession(), 'login-ok', 'https://jx.corp.example/', { flush: true });
  await check.record(fakeSession([COOKIES[2]]), 'needs-login', 'https://jx.corp.example/');
  const sum = feedbackSummary({ dataDir, now });
  assert.match(sum, /登好时（[^）]+）会话级 3 个、持久 2 个、持久最短剩 8h：根域 会话1\/持久0、登录站 会话1\/持久1（剩8h）/);
  assert.match(sum, /要登录时（[^）]+）会话级 0 个、持久 1 个/);
  assert.doesNotMatch(sum, SECRETS);
  assert.equal(feedbackSummary({ dataDir, now: now + 8 * 24 * 3600000 }), '', '超过 7 天的不带');
  const out = slimFeedback({ info: { productName: 'AI Hub', version: '9.9.9' }, description: '考勤每天都要重新登录', logsDir: path.join(dataDir, 'logs'), dataDir, now, ctx: { view: '考勤' } });
  assert.match(out.text, /## 当时的状态[\s\S]*- 网页登录体检：登好时/);
  assert.deepEqual(out.leaks, []);
});
