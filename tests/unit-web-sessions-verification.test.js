'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createWebSessions, browserUserAgent, PROBE } = require('../main/web-sessions');

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-web-verification-unit-'));
  const views = [], partitions = new Map(), external = [];
  let clock = 1000, interval;
  t.mock.method(global, 'setInterval', fn => { interval = fn; return { unref() {} }; });
  t.mock.method(global, 'clearInterval', () => {});
  class View {
    constructor(options) {
      this.options = options; views.push(this);
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => false, close() {}, focus() {}, getURL: () => this.url || '',
        loadURL: async url => { this.url = url; }, reload() {},
        setWindowOpenHandler: fn => { this.open = fn; },
        executeJavaScript: async () => this.probe || { generating: false, challenge: false, url: this.url },
      });
    }
    setBackgroundColor() {} setVisible() {} setBounds() {} getVisible() { return true; } getBounds() { return {}; }
  }
  const win = { isDestroyed: () => false, isFocused: () => true,
    contentView: { children: views, addChildView() {}, removeChildView() {} } };
  const web = createWebSessions({ dataDir, getWindow: () => win, WebContentsView: View,
    session: { fromPartition(partition) {
      if (!partitions.has(partition)) partitions.set(partition, {
        setUserAgent(ua) { this.ua = ua; }, getUserAgent: () => 'Mozilla/5.0 Chrome/144.0.7559.20 Electron/41.2.0 Safari/537.36',
        setPermissionRequestHandler(fn) { this.request = fn; }, setPermissionCheckHandler(fn) { this.check = fn; },
      });
      return partitions.get(partition);
    } }, shell: { openExternal: async url => { external.push(url); } }, now: () => clock,
    logger: { log() {}, warn() {} },
  });
  t.after(() => { web.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const item = web.create({ site: 'chatgpt' }); web.show({ id: item.id });
  return { web, item, views, partitions, external, advance(ms) { clock += ms; },
    async poll() { interval(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('AI webpage disables the automation flag only in its sandboxed view', t => {
  const h = setup(t), prefs = h.views[0].options.webPreferences;
  assert.equal(prefs.disableBlinkFeatures, 'AutomationControlled');
  assert.equal(prefs.webSecurity, true); assert.equal(prefs.sandbox, true); assert.equal(prefs.nodeIntegration, false);
});

test('site identity partition persists across sleep and separates accounts', t => {
  const h = setup(t), original = h.views[0].options.webPreferences.session;
  assert.ok(h.partitions.has('persist:aiweb-chatgpt-main'));
  h.web.suspend(h.item.id); h.web.show({ id: h.item.id });
  assert.equal(h.views[1].options.webPreferences.session, original);
  const alt = h.web.create({ site: 'chatgpt', identity: 'alt' }); h.web.show({ id: alt.id });
  assert.notEqual(h.views[2].options.webPreferences.session, original);
});

test('verification iframe can request storage without granting unrelated permissions', t => {
  const h = setup(t), ses = h.views[0].options.webPreferences.session;
  let granted;
  ses.request(h.views[0].webContents, 'storage-access', value => { granted = value; }, { requestingUrl: 'https://challenges.cloudflare.com/' });
  assert.equal(granted, true);
  assert.equal(ses.check(h.views[0].webContents, 'storage-access', 'https://challenges.cloudflare.com'), true);
  ses.request(h.views[0].webContents, 'storage-access', value => { granted = value; }, { requestingUrl: 'https://unrelated.example/' });
  assert.equal(granted, false);
  assert.equal(ses.check(null, 'notifications', 'https://chatgpt.com'), false);
});

test('verification popup remains in the same sandbox and cookie session', t => {
  const h = setup(t), view = h.views[0];
  const result = view.open({ url: 'https://challenges.cloudflare.com/turnstile/', features: '' });
  assert.equal(result.action, 'allow');
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.session, view.options.webPreferences.session);
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.disableBlinkFeatures, 'AutomationControlled');
  assert.equal(view.open({ url: 'file:///test', features: 'popup' }).action, 'deny');
  assert.equal(view.open({ url: 'https://unrelated.example/', features: '' }).action, 'deny');
});

test('challenge warning appears after 30 seconds, survives blank reload documents and clears on success', async t => {
  const h = setup(t); h.views[0].probe = { generating: false, challenge: true, url: 'https://chatgpt.com/' };
  await h.poll(); assert.equal(h.web.list().items[0].verificationRequired, false);
  h.advance(29000); await h.poll(); assert.equal(h.web.list().items[0].verificationRequired, false);
  h.views[0].webContents.emit('did-start-loading');
  h.views[0].probe = { generating: false, challenge: false, url: 'about:blank' };
  h.advance(1000); await h.poll();
  assert.equal(h.web.list().items[0].verificationRequired, true);
  h.web.navigate(h.item.id, 'external'); assert.equal(h.external[0], 'https://chatgpt.com/');
  h.views[0].probe.url = 'https://chatgpt.com/';
  h.views[0].webContents.emit('did-stop-loading'); await h.poll(); assert.equal(h.web.list().items[0].verificationRequired, false);
});

test('probe distinguishes challenge UI from ordinary chat text and hidden widgets', () => {
  function probe(title, heading = '', frame = false, hidden = false) {
    const visible = { getClientRects: () => [1], getBoundingClientRect: () => ({ width: 300, height: 65 }), innerText: heading };
    return vm.runInNewContext(PROBE, { document: { title, querySelectorAll: selector =>
      selector === 'h1,h2,[role="heading"]' ? [visible] : selector.startsWith('iframe') && frame ? [visible] : [] },
      getComputedStyle: () => ({ visibility: hidden ? 'hidden' : 'visible', opacity: '1' }), location: { href: 'https://chatgpt.com/' } });
  }
  assert.equal(probe('Just a moment...').challenge, true);
  assert.equal(probe('ChatGPT', 'Verify you are human').challenge, true);
  assert.equal(probe('ChatGPT', 'Discussion of verify you are human').challenge, false);
  assert.equal(probe('ChatGPT').challenge, false);
  assert.equal(probe('ChatGPT', '', true).challenge, true);
  assert.equal(probe('ChatGPT', '', true, true).challenge, false);
});

test('Chrome UA keeps the runtime Chrome version, and Google sign-in keeps the native profile', t => {
  const h = setup(t);
  assert.equal(h.partitions.get('persist:aiweb-chatgpt-main').ua, undefined);
  const ua = browserUserAgent('Mozilla/5.0 AppleWebKit/537.36 ai-hub-community/5.6.77 Chrome/144.0.7559.20 Electron/41.2.0 Safari/537.36');
  assert.match(ua, /Chrome\/144\.0\.7559\.20/); assert.doesNotMatch(ua, /Electron|ai-hub-community/);
});
