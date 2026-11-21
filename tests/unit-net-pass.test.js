'use strict';
// 高速下载镜像与「放行下载服务器」（2026-11-07）：反馈留在主服务器、放行页按主机、一个按钮放行两台、新用户提醒。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ownHosts = require('../core/own-hosts');
const { createNetPass } = require('../core/net-pass');
const view = require('../renderer/net-pass-view');

const config = { sources: [
  { id: 'aliyun-fast', name: '阿里云高速', mirror: true, manifest: 'https://dl.example.tech/hub-update/company/latest.json', files: 'https://dl.example.tech/hub-update/company/v{version}/' },
  { id: 'github', name: 'GitHub', manifest: 'https://github.com/x/y/releases/latest/download/latest.json', files: 'https://github.com/x/y/releases/download/v{version}/' },
  { id: 'aliyun', name: '阿里云', manifest: 'https://me.example.tech/hub-update/company/latest.json', files: 'https://me.example.tech/hub-update/company/v{version}/' },
] };

test('高速镜像排第一时，一键反馈仍投旧服务器；放行页跟着被拦的主机走', () => {
  assert.equal(ownHosts.feedbackEndpoint(config), 'https://me.example.tech/hub-update/api/feedback/submit');
  assert.equal(ownHosts.ownOrigin(config), 'https://me.example.tech');
  assert.equal(ownHosts.unblockPage(config, 'https://dl.example.tech/hub-update/company/latest.json'), 'https://dl.example.tech/hub-update/api/feedback');
  assert.equal(ownHosts.unblockPage(config, 'https://me.example.tech/x'), 'https://me.example.tech/hub-update/api/feedback');
  assert.equal(ownHosts.unblockPage(config, 'https://github.com/x'), 'https://me.example.tech/hub-update/api/feedback');
  assert.deepEqual(ownHosts.ownHosts(config), ['dl.example.tech', 'me.example.tech']);
  assert.deepEqual(ownHosts.downloadHosts(config).map(h => [h.host, h.name, h.mirror]), [['dl.example.tech', '阿里云高速', true], ['me.example.tech', '阿里云', false]]);
  // 只有镜像源时（不该出现，但别崩）：退回镜像本身
  assert.equal(ownHosts.feedbackEndpoint({ sources: [config.sources[0]] }), 'https://dl.example.tech/hub-update/api/feedback/submit');
});

const OWN = '<!doctype html><html><head><title>AI HUB 服务</title></head><body>ok</body></html>';
const GATE = '<!doctype html><html><head><title>安全提示</title></head><body><button>继续访问</button></body></html>';
const res = (text, status = 200) => ({ status, ok: status < 400, text: async () => text });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'net-pass-'));

test('自动放行结束广播终态：弹窗不再停在两台可访问但仍正在放行', async () => {
  const events = [];
  const np = createNetPass({ hosts: ownHosts.downloadHosts(config), fetchImpl: async () => res(OWN),
    onChange: state => events.push(state) });
  await np.passAll();
  assert.equal(events.at(-1).running, false);
  assert.ok(events.at(-1).hosts.every(h => h.state === 'ok'));
  assert.doesNotMatch(view.boxHtml(events.at(-1)), /disabled|正在放行/);
});

test('放行过程中打开更新面板仍返回完整状态', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const np = createNetPass({ hosts: ownHosts.downloadHosts(config), fetchImpl: async () => { await pending; return res(OWN); } });
  const run = np.passAll();
  const refresh = np.refresh();
  release();
  await run;
  assert.equal((await refresh).running, false);
});

test('放行文案区分成功、失败、超时和本来可访问', () => {
  const status = { available: true, running: false, needed: false,
    hosts: [{ name: 'mirror', state: 'ok' }] };
  assert.match(view.boxHtml(status), /本来就可以访问/);
  assert.match(view.boxHtml(status, { last: { results: [{ first: 'blocked', result: 'ok' }] } }), /放行成功/);
  const blocked = { ...status, needed: true, hosts: [{ name: 'mirror', state: 'blocked' }] };
  assert.match(view.boxHtml(blocked, { last: { results: [{ first: 'blocked', result: 'blocked' }] } }), /放行失败/);
  assert.match(view.boxHtml(blocked, { last: { results: [{ result: 'blocked', timedOut: true }] } }), /放行超时/);
  assert.match(view.boxHtml({ ...status, hosts: [{ name: 'mirror', state: 'error', reason: '连接超时' }] }, { last: { results: [] } }), /放行超时/);
  const recovered = view.boxHtml({ ...status, results: [{ first: 'blocked', result: 'ok' }] },
    { last: { error: true, results: [{ result: 'blocked', name: 'mirror' }] } });
  assert.match(recovered, /放行成功/);
  assert.doesNotMatch(recovered, /放行失败|np-need|data-np="open"/);
});

test('首次检查被拦、失败或超时，没有放行记录时不显示放行终态', () => {
  for (const host of [{ state: 'blocked' }, { state: 'error', reason: 'offline' }, { state: 'error', reason: '连接超时' }]) {
    const html = view.boxHtml({ available: true, needed: true, hosts: [{ name: 'mirror', ...host }] });
    assert.match(html, /第一次使用请先放行/);
    assert.doesNotMatch(html, /放行失败|放行超时|放行成功/);
  }
});

test('后来已能访问时，旧失败或超时快照不再显示失败或手动放行入口', () => {
  const status = { available: true, needed: false, hosts: [{ host: 'mirror', name: 'mirror', state: 'ok' }] };
  for (const last of [
    { error: true },
    { results: [{ host: 'mirror', name: 'mirror', result: 'blocked', timedOut: true }] },
    { results: [{ host: 'mirror', name: 'mirror', first: 'blocked', result: 'blocked' }] },
  ]) {
    const html = view.boxHtml(status, { last });
    assert.match(html, /放行成功|本来就可以访问/);
    assert.doesNotMatch(html, /放行失败|放行超时|np-need|data-np="open"/);
  }
});

test('检查期间排队的多次放行不会同时打开同一主机的放行窗口', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const hosts = ownHosts.downloadHosts(config);
  const active = new Map();
  const runningStates = [];
  let maxActive = 0, opened = 0;
  const np = createNetPass({ hosts, fetchImpl: async () => { await pending; return res(GATE); },
    openGate: async page => {
      const host = new URL(page).host;
      active.set(host, (active.get(host) || 0) + 1);
      maxActive = Math.max(maxActive, active.get(host));
      opened++;
      await new Promise(resolve => setImmediate(resolve));
      active.set(host, active.get(host) - 1);
      runningStates.push(np.status().running);
      return { clicked: false };
    } });
  const calls = [np.refresh(), np.passAll(), np.passAll(), np.passUrl(hosts[0].page)];
  release();
  const results = await Promise.all(calls);
  assert.equal(maxActive, 1);
  assert.ok(runningStates.every(Boolean), '队列仍在执行时不能提前清除 running');
  assert.equal(opened, 5);
  assert.deepEqual(results[1].results.map(r => r.result), ['blocked', 'blocked']);
  assert.deepEqual(results[2].results.map(r => r.result), ['blocked', 'blocked']);
  assert.equal(results[3], 'blocked');
  assert.equal(np.status().running, false);
});

test('IPC 放行失败恢复按钮并显示可重试文字', async () => {
  let listener, update;
  const button = { dataset: { np: 'run' }, disabled: false, textContent: '', closest: () => button };
  const root = { dataset: {}, contains: () => true, addEventListener: (_event, fn) => { listener = fn; } };
  view.bind(root, { ipcRenderer: { invoke: async () => { throw new Error('IPC unavailable'); } },
    onUpdate: (next, last) => { update = { next, last }; } });
  await listener({ target: button, preventDefault() {} });
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /放行失败/);
  assert.match(view.boxHtml({ available: true, hosts: [{ state: 'blocked' }] }, { last: update.last }), /放行失败/);
});

test('后台放行超时仍广播终态并保留超时原因', async () => {
  const events = [];
  const np = createNetPass({ hosts: ownHosts.downloadHosts(config), fetchImpl: async () => res(GATE),
    openGate: async () => ({ timedOut: true }), onChange: s => events.push(s) });
  const result = await np.passAll();
  assert.ok(result.results.every(r => r.timedOut));
  assert.equal(events.at(-1).running, false);
});

test('服务器连接失败后也广播终态，按钮允许再次放行', async () => {
  const events = [];
  const np = createNetPass({ hosts: ownHosts.downloadHosts(config), fetchImpl: async () => { throw new Error('offline'); },
    onChange: s => events.push(s) });
  await np.passAll();
  const html = view.boxHtml(events.at(-1));
  assert.equal(events.at(-1).running, false);
  assert.match(html, /放行失败，请重试/);
  assert.doesNotMatch(html, /disabled|正在放行/);
});

test('一个按钮放行两台：拦着的逐台开放行页，放行后都显示可以访问，并记住', async () => {
  const passed = new Set(), opened = [], dataDir = tmp(), events = [];
  const hosts = ownHosts.downloadHosts(config);
  const np = createNetPass({ hosts, dataDir, fetchImpl: async url => res(passed.has(new URL(url).host) ? OWN : GATE),
    openGate: async page => { opened.push(page); passed.add(new URL(page).host); return { clicked: true }; }, onChange: s => events.push(s) });
  assert.equal(np.status().needed, true, '没查过、也从没放行过：提醒');
  await np.refresh();
  assert.deepEqual(np.status().hosts.map(h => h.state), ['blocked', 'blocked']);
  const r = await np.passAll();
  assert.deepEqual(opened, ['https://dl.example.tech/hub-update/api/feedback', 'https://me.example.tech/hub-update/api/feedback']);
  assert.deepEqual(r.results.map(x => x.result), ['ok', 'ok']);
  assert.equal(r.needed, false);
  assert.match(view.boxHtml(events.at(-1)), /放行成功/);
  // 换个进程（重启 Hub）：记得放行过，查之前不再提醒
  const again = createNetPass({ hosts, dataDir, fetchImpl: async () => res(OWN) });
  assert.equal(again.status().needed, false);
  assert.ok(again.status().hosts.every(h => h.okAt));
});

test('后台放行没成功的给出浏览器打开；连不上不是放行能解决的，不催', async () => {
  const hosts = ownHosts.downloadHosts(config);
  const np = createNetPass({ hosts, fetchImpl: async url => { if (url.includes('dl.')) throw new Error('getaddrinfo ENOTFOUND'); return res(GATE); },
    openGate: async () => ({ clicked: false }) });
  const r = await np.passAll();
  assert.deepEqual(r.results.map(x => x.result), ['error', 'blocked']);
  assert.equal(r.needed, true);
  const html = view.boxHtml(r, { last: r });
  assert.match(html, /第一次使用请先放行下载服务器/);
  assert.match(html, /打开放行页「阿里云」/);
  assert.doesNotMatch(html, /打开放行页「阿里云高速」/);
  assert.match(html, /连不上/);
});

test('都能访问时只显示一行和「重新放行」；没有自家主机时什么都不显示', async () => {
  const np = createNetPass({ hosts: ownHosts.downloadHosts(config), fetchImpl: async () => res(OWN) });
  await np.refresh();
  const html = view.boxHtml(np.status());
  assert.match(html, /np-line/); assert.match(html, /重新放行/); assert.doesNotMatch(html, /第一次使用/);
  assert.equal(view.boxHtml(createNetPass({ hosts: [] }).status()), '');
  assert.equal(view.boxHtml(null), '');
});

// 2026-11-08 事故：放行失败后给的是被拦的 .gz 地址，点开变成下载文件。放行一律开主机的放行小页面，放行窗口里不下载。
const { openVisibleGateWindow, openHiddenGateWindow } = require('../core/net-unblock');
function fakeWindowClass(script) {
  return class FakeWin {
    constructor(opts) { FakeWin.last = this; this.opts = opts; this.handlers = {}; this.destroyed = false;
      this.webContents = { session: { on: (_n, fn) => { FakeWin.onDownload = fn; }, removeListener: () => { FakeWin.removed = true; } }, isLoading: () => false, getURL: () => this.url,
        executeJavaScript: async code => script(code, this), once: () => {} }; }
    on(name, fn) { this.handlers[name] = fn; }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  };
}

test('被拦的是 .gz 下载地址时，放行页仍是那台主机的小页面', () => {
  const page = ownHosts.unblockPage(config, 'https://dl.example.tech/hub-update/company/v5.5.42/AIHubHuawei-5.5.42-update.gz');
  assert.equal(page, 'https://dl.example.tech/hub-update/api/feedback');
  assert.doesNotMatch(page, /\.gz/);
});

test('Hub 里弹出的放行窗：自动点按钮，看到自家页面就关窗', async () => {
  // 第 1 轮：定位到放行按钮（locate）→ 点（DOM 补点，没有真实点击用的调试器）；第 2 轮：已是自家页面。
  let n = 0;
  const Win = fakeWindowClass(code => { n += 1; if (n === 1) return { found: true, index: 0, text: '接受风险并访问', rect: null };
    if (n === 2) { assert.match(code, /el\.click\(\)/); return { clicked: true, text: '接受风险并访问' }; } return { notGate: true }; });
  const r = await openVisibleGateWindow(Win, 'https://dl.example.tech/hub-update/api/feedback', { pollMs: 1, afterClickMs: 1 });
  assert.equal(r.passed, true); assert.equal(r.clicked, true); assert.equal(r.text, '接受风险并访问');
  assert.equal(Win.last.opts.show, true); assert.equal(Win.last.destroyed, true); assert.equal(Win.removed, true);
});

test('放行窗：用户关掉窗口时结束，超时时也结束', async () => {
  const Win = fakeWindowClass(() => ({ clicked: false }));
  const closing = openVisibleGateWindow(Win, 'https://dl.example.tech/p', { pollMs: 1 });
  setTimeout(() => Win.last.handlers.closed(), 5);
  assert.equal((await closing).closed, true);
  assert.equal((await openVisibleGateWindow(Win, 'https://dl.example.tech/p', { pollMs: 1, timeoutMs: 5 })).timedOut, true);
  assert.equal((await openVisibleGateWindow(Win, 'file:///x')).error, '放行页地址无效');
});

test('放行窗里的下载一律取消，别的窗口的下载不管', async () => {
  const Win = fakeWindowClass(() => ({ notGate: true }));
  await openVisibleGateWindow(Win, 'https://dl.example.tech/p', { pollMs: 1 });
  let prevented = 0;
  Win.onDownload({ preventDefault: () => { prevented++; } }, {}, Win.last.webContents);
  Win.onDownload({ preventDefault: () => { prevented++; } }, {}, { other: true });
  assert.equal(prevented, 1);
});

test('后台放行失败时弹出放行页，放行后核对通过；后台放行成功就不弹', async () => {
  const hosts = [{ host: 'dl.example.tech', name: '阿里云高速', page: 'https://dl.example.tech/hub-update/api/feedback' }];
  let passed = false, visible = 0;
  const pass = createNetPass({ hosts, dataDir: tmp(), fetchImpl: async () => res(passed ? OWN : GATE), openGate: async () => ({ clicked: false }),
    openVisible: async page => { visible++; assert.equal(page, hosts[0].page); passed = true; return { passed: true }; } });
  const r = await pass.passAll();
  assert.equal(visible, 1); assert.equal(r.results[0].result, 'ok');
  let visible2 = 0, passed2 = false;
  const pass2 = createNetPass({ hosts, dataDir: tmp(), fetchImpl: async () => res(passed2 ? OWN : GATE), openGate: async () => { passed2 = true; return { clicked: true }; },
    openVisible: async () => { visible2++; return {}; } });
  await pass2.passAll();
  assert.equal(visible2, 0);
});
