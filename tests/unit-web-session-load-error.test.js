'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadError, destinationError } = require('../main/web-session-load-error');
const { createWebSessions } = require('../main/web-sessions');

test('加载失败按 net 错误提供原因和下一步，忽略取消导航', () => {
  for (const code of [-111, 'ERR_TUNNEL_CONNECTION_FAILED', -130]) {
    const text = loadError('https://chatgpt.com/', code);
    assert.match(text, /代理连接失败.*chatgpt.com.*重试/);
    assert.doesNotMatch(text, /ERR_|-111|公司网络拦截/);
  }
  assert.match(loadError('https://chatgpt.com/', -105), /地址.*重试/);
  assert.match(loadError('https://chatgpt.com/', -118), /超时.*重试/);
  assert.match(loadError('https://chatgpt.com/', -202), /安全连接.*管理员/);
  assert.match(loadError('https://chatgpt.com/', -2), /无法连接.*重试/);
  assert.equal(loadError('https://chatgpt.com/', -3), '');
  assert.equal(loadError('https://chatgpt.com/', 'ERR_ABORTED'), '');
});

test('识别 HIS 风险页和其他非目标域名，按域名边界匹配', () => {
  assert.match(destinationError('deepseek', 'https://chat.deepseek.com/',
    'http://114.114.114.114:9421/proxycontrolwarn/httpwarning_2902.html'), /公司网络拦截了 chat.deepseek.com.*重试/);
  for (const url of ['https://filter.example/warning', 'https://chatgpt.com.example/chat', 'https://evilchatgpt.com/']) {
    assert.match(destinationError('chatgpt', 'https://chatgpt.com/', url), /其他网站.*网络拦截.*重试/);
  }
});

test('正常站点、官方域名变化、OAuth、验证与空白初始文档不误报', () => {
  for (const url of ['https://chatgpt.com/c/123', 'https://chat.openai.com/', 'https://auth.openai.com/login',
    'https://accounts.google.com/v3/signin', 'https://challenges.cloudflare.com/', 'about:blank', '']) {
    assert.equal(destinationError('chatgpt', 'https://chatgpt.com/', url), '', url);
  }
  assert.equal(destinationError('kimi', 'https://www.kimi.com/', 'https://kimi.moonshot.cn/chat/123'), '');
  assert.equal(destinationError('qwen', 'https://www.qianwen.com/', 'https://login.taobao.com/member/login.jhtml'), '');
  assert.equal(destinationError('doubao', 'https://www.doubao.com/', 'https://sso.bytedance.com/login'), '');
  assert.equal(destinationError('deepseek', 'http://127.0.0.1:4567/', 'http://127.0.0.1:4567/chat'), '');
});

function setup(t, { site = 'chatgpt', reject = null, saved = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-web-load-error-'));
  const views = [], external = [], loads = [];
  t.mock.method(global, 'setInterval', () => ({ unref() {} }));
  t.mock.method(global, 'clearInterval', () => {});
  class View {
    constructor() {
      views.push(this);
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => false, isLoading: () => false, close() {}, focus() {}, getURL: () => this.url || '',
        loadURL: async url => {
          loads.push(url); this.url = url;
          if (reject) { const error = reject; reject = null; throw error; }
        }, reload: () => { this.reloads = (this.reloads || 0) + 1; },
        setWindowOpenHandler() {}, executeJavaScript: async () => ({}),
      });
    }
    setBackgroundColor() {} setVisible() {} setBounds() {} getVisible() { return true; } getBounds() { return {}; }
  }
  if (saved) fs.writeFileSync(path.join(dataDir, 'web-sessions.json'), JSON.stringify({ items: [saved] }));
  const win = { isDestroyed: () => false, isFocused: () => true,
    contentView: { children: views, addChildView() {}, removeChildView() {} } };
  const web = createWebSessions({ dataDir, getWindow: () => win, WebContentsView: View,
    session: { fromPartition: () => ({ setUserAgent() {}, getUserAgent: () => '',
      setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
    shell: { openExternal: async url => { external.push(url); } }, logger: { log() {}, warn() {} },
  });
  t.after(() => { web.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const item = saved || web.create({ site });
  if (saved) web.list();
  web.show({ id: item.id });
  return { web, item, views, external, loads, current: () => web.list().items[0] };
}

test('顶层失败不会被停止加载或 Promise 拒绝覆盖，重试可以恢复', async t => {
  const h = setup(t, { reject: Object.assign(new Error('ERR_TUNNEL_CONNECTION_FAILED (-111)'), { errno: -111 }) });
  const wc = h.views[0].webContents;
  wc.emit('did-fail-load', {}, -111, 'ERR_TUNNEL_CONNECTION_FAILED', 'https://chatgpt.com/', true);
  wc.emit('did-stop-loading');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.current().status, 'error');
  assert.match(h.current().error, /代理连接失败/);
  assert.doesNotMatch(h.current().error, /ERR_|-111/);
  h.web.navigate(h.item.id, 'reload');
  assert.equal(h.loads.at(-1), 'https://chatgpt.com/');
  wc.emit('did-start-loading'); wc.emit('did-navigate', {}, 'https://chatgpt.com/'); wc.emit('did-stop-loading');
  assert.equal(h.current().status, 'ready'); assert.equal(h.current().error, '');
});

test('子框架错误与 ERR_ABORTED 不影响正常网页', t => {
  const h = setup(t), wc = h.views[0].webContents;
  wc.emit('did-stop-loading');
  wc.emit('did-fail-load', {}, -111, 'ERR_TUNNEL_CONNECTION_FAILED', '', false);
  wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', '', true);
  assert.equal(h.current().status, 'ready'); assert.equal(h.current().error, '');
});

test('登录跳转不误报也不覆盖已保存的对话地址', t => {
  const h = setup(t), view = h.views[0], wc = view.webContents;
  view.url = 'https://chatgpt.com/c/123'; wc.emit('did-navigate', {}, view.url); wc.emit('did-stop-loading');
  view.url = 'https://accounts.google.com/v3/signin';
  wc.emit('did-start-loading'); wc.emit('did-navigate', {}, view.url); wc.emit('did-stop-loading');
  assert.equal(h.current().status, 'ready'); assert.equal(h.current().error, '');
  assert.equal(h.current().url, 'https://chatgpt.com/c/123');
});

test('圆桌后台新开对话失败时也传递友好原因', async t => {
  const h = setup(t), wc = h.views[0].webContents;
  wc.emit('did-stop-loading');
  t.mock.method(wc, 'loadURL', async () => { throw Object.assign(new Error('ERR_TUNNEL_CONNECTION_FAILED'), { code: 'ERR_TUNNEL_CONNECTION_FAILED' }); });
  await assert.rejects(h.web.pageFor(h.item.id, { fresh: true }), error => {
    assert.match(error.message, /代理连接失败.*重试/); assert.doesNotMatch(error.message, /ERR_/); return true;
  });
});

test('HIS 拦截不保存地址标题，重试及浏览器打开均返回目标站', async t => {
  const h = setup(t, { site: 'deepseek' });
  await new Promise(resolve => setImmediate(resolve));
  const view = h.views[0], wc = view.webContents;
  const target = 'https://chat.deepseek.com/';
  const blocked = 'http://114.114.114.114:9421/proxycontrolwarn/httpwarning_2902.html';
  view.url = blocked;
  wc.emit('did-start-loading'); wc.emit('did-navigate', {}, blocked);
  wc.emit('page-title-updated', {}, 'HIS Proxy Notification'); wc.emit('did-stop-loading');
  assert.equal(h.current().status, 'error'); assert.match(h.current().error, /公司网络拦截/);
  assert.equal(h.current().verificationRequired, false);
  assert.equal(h.current().url, target); assert.equal(h.current().title, '');
  await assert.rejects(h.web.pageFor(h.item.id), /公司网络拦截/);
  h.web.navigate(h.item.id, 'external'); assert.equal(h.external.at(-1), target);
  h.web.navigate(h.item.id, 'reload'); assert.equal(h.loads.at(-1), target); assert.equal(view.reloads, undefined);
  wc.emit('did-navigate', {}, target); wc.emit('did-stop-loading');
  assert.equal(h.current().status, 'ready'); assert.equal(h.current().error, '');
});

test('仅靠停止加载也能发现非目标页；老版本保存的拦截页在唤醒前修正', t => {
  const saved = { id: 'web-saved', site: 'chatgpt', identity: 'main', title: 'HIS Proxy Notification',
    url: 'http://114.114.114.114:9421/proxycontrolwarn/httpwarning_2902.html' };
  const h = setup(t, { saved });
  assert.equal(h.loads.at(-1), 'https://chatgpt.com/');
  assert.equal(h.current().title, '');
  h.views[0].url = 'https://filter.example/blocked'; h.views[0].webContents.emit('did-stop-loading');
  assert.equal(h.current().status, 'error'); assert.match(h.current().error, /其他网站/);
});

test('第三方登录跳转（抖音、支付宝、企业 SSO、passport/login/auth.*）不报跳到其他网站', () => {
  const { destinationError } = require('../main/web-session-load-error.js');
  for (const [site, target, url] of [
    ['doubao', 'https://www.doubao.com/chat/', 'https://passport.douyin.com/web/login'],
    ['qwen', 'https://www.qianwen.com/', 'https://auth.alipay.com/login'],
    ['chatgpt', 'https://chatgpt.com/', 'https://acme.okta.com/app/sso'],
    ['kimi', 'https://www.kimi.com/', 'https://login.example-sso.cn/'],
  ]) assert.equal(destinationError(site, target, url), '', url);
  assert.match(destinationError('chatgpt', 'https://chatgpt.com/', 'https://risk.example.com/warn'), /跳到了其他网站/);
});
