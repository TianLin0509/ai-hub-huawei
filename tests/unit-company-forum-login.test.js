'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { CompanyForum } = require('../core/company-forum/service');
const { createForumBrowser } = require('../main/company-forum-browser');
const turn = () => new Promise(r => setImmediate(r));

function service(t, browser) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-login-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return new CompanyForum({ dataDir, browser, accountEmail: () => 'user@corp.example', noTimer: true, noCollect: true });
}

test('登录窗口创建同步失败后退出 waiting，并向页面提供失败原因', async t => {
  const forum = service(t, { login() { throw new Error('窗口创建失败'); } });
  await forum.login('jx').catch(() => {});
  await turn();
  const site = forum.status().sites.find(s => s.id === 'jx');
  assert.equal(site.login, 'closed');
  assert.match(site.loginError, /窗口创建失败/);
});

test('登录加载失败传到页面，重试时清掉上一次失败原因', async t => {
  let attempts = 0;
  const forum = service(t, { async login() {
    attempts += 1;
    return attempts === 1 ? { ok: false, error: '网络不可达' } : new Promise(() => {});
  } });
  await forum.login('jx');
  await turn();
  assert.match(forum.status().sites.find(s => s.id === 'jx').loginError, /网络不可达/);
  await forum.login('jx');
  assert.equal(forum.status().sites.find(s => s.id === 'jx').loginError, '');
});

function fakeWindows(loadURL = async () => {}) {
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.dead = false;
      this.webContents = Object.assign(new EventEmitter(), { setAudioMuted() {}, setWindowOpenHandler() {}, getURL: () => 'https://jx.corp.example/login' });
      windows.push(this);
    }
    loadURL(url) { return loadURL(url); }
    isDestroyed() { return this.dead; }
    destroy() { if (!this.dead) { this.dead = true; this.emit('closed'); } }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    isMinimized() { return true; }
    restore() { this.restored = true; }
  }
  return { Window, windows };
}

test('登录页加载失败及时返回原因，不在 waiting 状态空等十分钟', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { Window } = fakeWindows(async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); });
  const browser = createForumBrowser({ BrowserWindow: Window, logger: { warn() {} } });
  t.after(() => browser.close());
  let result;
  browser.login({ url: 'https://jx.corp.example/', base: 'https://jx.corp.example' }).then(r => { result = r; });
  await turn();
  assert.equal(result?.ok, false);
  assert.match(result.error, /ERR_CONNECTION_REFUSED/);
});

test('可见登录窗口不归隐藏宿主管，且打开时主动取得焦点', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { Window, windows } = fakeWindows();
  const browser = createForumBrowser({ BrowserWindow: Window, BaseWindow: Window });
  t.after(() => browser.close());
  const pending = browser.login({ url: 'https://jx.corp.example/', base: 'https://jx.corp.example' });
  const win = windows.find(w => w.options.show);
  assert.equal(win.options.parent, undefined);
  assert.equal(win.focused, true);
  browser.close();
  await pending;
});

test('单点登录后续主页面跳转失败也应结束等待；子资源和取消跳转不影响登录', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { Window, windows } = fakeWindows();
  const browser = createForumBrowser({ BrowserWindow: Window });
  t.after(() => browser.close());
  let result;
  browser.login({ url: 'https://jx.corp.example/', base: 'https://jx.corp.example' }).then(r => { result = r; });
  const contents = windows[0].webContents;
  contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://sso.corp.example/icon.png', false);
  contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://sso.corp.example/', true);
  await turn();
  assert.equal(result, undefined);
  contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://sso.corp.example/', true);
  await turn();
  assert.equal(result?.ok, false);
  assert.match(result.error, /ERR_NAME_NOT_RESOLVED/);
});
