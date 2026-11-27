'use strict';
// R44（2026-11-25）：「软件更新」连不上内源时不再满屏红字——不在公司网络快判、灰色说明；内源慢给 20 秒、超时一句话 + 旁边「重试」；
// 原因只说一次；后台自动检查失败不打扰，30 分钟后静默再查。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const openx = require('../core/app-update/openx-source');
const { createAppUpdateController } = require('../main/app-update-controller');

const ENV = { AI_HUB_OPENX: '1' };
const realFetchManifest = openx.fetchManifest;
// 本文件测的是列表路径：显式关掉版本索引（R55 起配置里有索引 id，默认先读索引）。
test.beforeEach(() => openx._reset({ indexId: 0 }));
test.afterEach(() => { openx.fetchManifest = realFetchManifest; });

function netError(message, code) { const e = new TypeError(message); if (code) e.cause = { code }; return e; }

test('不在公司网络快判：域名解析不到、连接被关 / 被拒都在瞬间返回 offline，不等满预算', async () => {
  for (const err of [netError('net::ERR_CONNECTION_CLOSED'), netError('fetch failed', 'ENOTFOUND'), netError('net::ERR_NAME_NOT_RESOLVED'),
    netError('net::ERR_PROXY_CONNECTION_FAILED'), netError('fetch failed', 'ECONNREFUSED')]) {
    openx._reset({ indexId: 0 });
    const started = Date.now();
    const r = await openx.fetchManifest({ fetchImpl: async () => { throw err; }, validate: x => x, env: ENV, currentVersion: '5.6.1' });
    assert.equal(r.ok, false);
    assert.equal(r.offline, true, err.message);
    assert.ok(!r.slow);
    assert.ok(Date.now() - started < 500);
  }
  // 超时、HTTP 错误不算「不在公司网络」
  assert.equal(openx.isOfflineError(netError('超时没响应')), false);
  assert.equal(openx.isOfflineError(new Error('openx 返回 HTTP 500')), false);
});

test('内源慢：到预算返回 slow；手动检查最多给 20 秒，后台默认 8 秒', async () => {
  const started = Date.now();
  const r = await openx.fetchManifest({ fetchImpl: () => new Promise(() => {}), validate: x => x, env: ENV, currentVersion: '5.6.1', timeoutMs: 60 });
  assert.equal(r.slow, true);
  assert.ok(!r.offline);
  assert.ok(Date.now() - started < 1000);
  assert.equal(openx.MANUAL_MANIFEST_BUDGET_MS, 20000);
  assert.equal(openx.MANIFEST_BUDGET_MS, 8000);
  assert.match(openx.slowText(20), /20 秒内没查完.*重试/);
  // 网络栈自己报超时（Chromium net::ERR_TIMED_OUT）也算慢，不标连不上
  openx._reset({ indexId: 0 });
  const t = await openx.fetchManifest({ fetchImpl: async () => { throw netError('net::ERR_TIMED_OUT'); }, validate: x => x, env: ENV, currentVersion: '5.6.1' });
  assert.equal(t.slow, true); assert.ok(!t.offline);
  assert.notEqual(openx.reachability(), 'down');
  assert.doesNotMatch(openx.OFFLINE_TEXT, /重试/);
});

test('查清单只取列表第 1 页 20 条（100 条在公司要 3 秒）', async () => {
  const urls = [];
  await openx.fetchManifest({ fetchImpl: async url => { urls.push(String(url)); return new Response(JSON.stringify({ code: '0', data: { records: [] } })); },
    validate: x => x, env: ENV, currentVersion: '5.6.1' });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /by_project_id\?.*pageSize=20$/);
});

function makeController(extraEnv = {}) {
  return createAppUpdateController({ app: { quit() {} }, config: {}, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r44-update-')),
    currentVersion: '5.6.112', fetchImpl: async () => { throw new Error('不该直接联网'); }, isPackaged: false, logger: { warn() {}, info() {} },
    env: { ...ENV, ...extraEnv } });
}
const row = extra => ({ id: 'openx-manifest', name: '公司内源 · 版本清单', ok: false, ms: 1, ...extra });

test('控制器：手动检查给 20 秒、后台给 8 秒；不在公司网络 → offline，内源慢 → slow，都不再另探一次内源', async () => {
  const budgets = [];
  openx.fetchManifest = async opts => { budgets.push(opts.timeoutMs); return row({ reason: '内源连不上：net::ERR_CONNECTION_CLOSED', offline: true }); };
  const c = makeController();
  try {
    let s = await c.check({ silent: false });
    assert.equal(s.phase, 'error');
    assert.equal(s.errorKind, 'offline');
    assert.equal(s.error, openx.OFFLINE_TEXT);
    assert.deepEqual(budgets, [20000]);
    openx.fetchManifest = async opts => { budgets.push(opts.timeoutMs); return row({ reason: '20 秒内没读完内源版本清单', slow: true }); };
    s = await c.check({ silent: false });
    assert.equal(s.errorKind, 'slow');
    assert.match(s.error, /20 秒内没查完/);
    openx.fetchManifest = async opts => { budgets.push(opts.timeoutMs); return row({ reason: 'x', slow: true }); };
    await c.check({ silent: true });
    assert.equal(budgets[2], undefined, '后台检查用默认 8 秒');
  } finally { c.dispose(); }
});

test('后台自动检查失败：不进 error、不标红，稍后静默再查一次', async () => {
  let calls = 0;
  openx.fetchManifest = async () => { calls += 1; return row({ reason: '内源连不上：ENOTFOUND', offline: true }); };
  const c = makeController({ AI_HUB_UPDATE_RECHECK_MS: '40' });
  try {
    const s = await c.check({ silent: true });
    assert.equal(s.phase, 'idle');
    assert.equal(s.silentFailure, true);
    await new Promise(r => setTimeout(r, 150));
    assert.ok(calls >= 2, '静默再查过');
    assert.equal(c.getState().phase, 'idle');
    const html = await render(s);
    assert.doesNotMatch(html, /au-msg bad|ENOTFOUND|连不上/);
  } finally { c.dispose(); }
});

test('之前一次 offline 不会让后来的下载失败也显示成灰色', async () => {
  openx.fetchManifest = async () => row({ reason: 'x', offline: true });
  const c = makeController();
  try {
    assert.equal((await c.check({ silent: true })).errorKind, 'offline');
    // 网络恢复后再查：任何换 phase 的状态都会清掉 errorKind，后面的下载失败按原样显示红框。
    openx.fetchManifest = async () => row({ reason: '内源上的程序版本还没有附带版本清单', pending: true });
    const s = await c.check({ silent: true });
    assert.equal(s.phase, 'none');
    assert.equal(s.errorKind, null);
  } finally { c.dispose(); }
});

function render(state) {
  let dialog;
  class El {
    constructor() { this.style = {}; this.dataset = {}; this.classList = { toggle() {}, contains() { return false; } }; }
    addEventListener() {} appendChild() {} remove() {} querySelector() { return null; } querySelectorAll() { return []; }
    showModal() { this.open = true; } close() { this.open = false; }
  }
  const context = { console, window: {}, setTimeout() {}, clearTimeout() {}, setInterval() {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: { head: new El(), body: new El(), getElementById() { return null; }, createElement(tag) { const e = new El(); if (tag === 'dialog') dialog = e; return e; } },
    require(id) {
      if (id === '../core/distribution') return { productName: 'Hub', editionBadge: '内测先锋版', updateConfig: { sources: [] } };
      if (id === '../core/app-update/source-view') return require(id);
      if (id === 'electron') return { ipcRenderer: { on() {}, invoke: async k => k === 'app-update:get-state' ? state : null }, shell: {} };
      if (id === './download-progress-view') return require('../renderer/download-progress-view');
      throw new Error(id);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/app-update.js'), 'utf8'), context);
  return new Promise(resolve => setImmediate(() => { context.window.__appUpdate.open(); resolve(dialog.innerHTML); }));
}
const count = (s, sub) => s.split(sub).length - 1;

test('更新窗 offline：灰色一句话 + 旁边一个不高亮的「重试」，不红、不出「公司内源」重复行、底部无高亮按钮', async () => {
  const r = row({ reason: '内源连不上：net::ERR_CONNECTION_CLOSED', offline: true });
  const html = await render({ phase: 'error', errorKind: 'offline', error: openx.OFFLINE_TEXT, current: '5.6.112', checks: [r],
    internalSource: { id: 'openx', status: 'failed', reason: r.reason }, attempts: [] });
  assert.match(html, /au-msg info" data-au-offline/);
  assert.equal(count(html, '不在公司网络'), 1);
  assert.match(html, /data-au-offline[^>]*>.*<button class="au-btn" data-au="retry">重试<\/button><\/div>/);
  assert.equal(count(html, 'data-au="retry"'), 1);
  assert.doesNotMatch(html, /au-msg bad|data-source=|class="au-btn primary"/);
});

test('代理类错误（ERR_PROXY_* / ERR_TUNNEL_* / ECONNREFUSED）：仍按不在公司网络，提示补「或本机代理没放行公司内网」', async () => {
  for (const err of [netError('net::ERR_PROXY_CONNECTION_FAILED'), netError('net::ERR_TUNNEL_CONNECTION_FAILED'), netError('fetch failed', 'ECONNREFUSED')]) {
    openx._reset({ indexId: 0 });
    const r = await openx.fetchManifest({ fetchImpl: async () => { throw err; }, validate: x => x, env: ENV, currentVersion: '5.6.1' });
    assert.equal(r.offline, true); assert.equal(r.proxy, true, err.message);
  }
  openx._reset({ indexId: 0 });
  const r = await openx.fetchManifest({ fetchImpl: async () => { throw netError('net::ERR_CONNECTION_CLOSED'); }, validate: x => x, env: ENV, currentVersion: '5.6.1' });
  assert.equal(r.offline, true); assert.ok(!r.proxy);
  openx.fetchManifest = async () => row({ reason: '内源连不上：net::ERR_PROXY_CONNECTION_FAILED', offline: true, proxy: true });
  const c = makeController();
  try {
    const s = await c.check({ silent: false });
    assert.equal(s.error, openx.OFFLINE_PROXY_TEXT);
    assert.match(s.error, /或本机代理没放行公司内网/);
  } finally { c.dispose(); }
});

test('后台静默检查在途时用户点检查更新：中断静默的那次，按手动重查（checking、20 秒）', async () => {
  const budgets = [];
  let release;
  openx.fetchManifest = opts => { budgets.push(opts.timeoutMs);
    if (budgets.length === 1) return new Promise(r => { release = r; opts.signal.addEventListener('abort', () => r(row({ reason: '已取消' }))); });
    return Promise.resolve(row({ reason: '20 秒内没读完内源版本清单', slow: true })); };
  const phases = [];
  const c = createAppUpdateController({ app: { quit() {} }, config: {}, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r44-update-')),
    currentVersion: '5.6.112', fetchImpl: async () => { throw new Error('x'); }, isPackaged: false, logger: { warn() {}, info() {} }, env: ENV,
    sendToRenderer: (_ch, st) => phases.push(st.phase) });
  try {
    const silentRun = c.check({ silent: true });
    await new Promise(r => setTimeout(r, 20));
    const s = await c.check({ silent: false });
    assert.equal(s.phase, 'error');
    assert.equal(s.errorKind, 'slow');
    assert.deepEqual(budgets, [undefined, 20000]);
    assert.ok(phases.includes('checking'));
    await silentRun;
    assert.equal(c.getState().phase, 'error', '被接管的静默检查不把界面改回 idle');
    void release;
  } finally { c.dispose(); }
});

test('静默检查失败不把用户正看着的错误说明刷回 idle', async () => {
  openx.fetchManifest = async () => row({ reason: '内源连不上：ENOTFOUND', offline: true });
  const c = makeController();
  try {
    assert.equal((await c.check({ silent: false })).phase, 'error');
    assert.equal((await c.check({ silent: true })).phase, 'error');
    assert.equal(c.getState().errorKind, 'offline');
  } finally { c.dispose(); }
});

test('外部取消（用户取消、体检到点）不把内源标成连不上', async () => {
  const ac = new AbortController();
  const p = openx.fetchManifest({ fetchImpl: (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    validate: x => x, env: ENV, currentVersion: '5.6.1', signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const r = await p;
  assert.equal(r.reason, '已取消');
  await new Promise(res => setTimeout(res, 20));
  assert.notEqual(openx.reachability(), 'down');
});

test('更新窗 slow：一句话 +「重试」在提示旁边，底部不再重复高亮重试，原因只说一次', async () => {
  const text = openx.slowText(20);
  const r = row({ reason: '20 秒内没读完内源版本清单', slow: true });
  const html = await render({ phase: 'error', errorKind: 'slow', error: text, current: '5.6.112', checks: [r],
    internalSource: { id: 'openx', status: 'failed', reason: r.reason }, attempts: [] });
  assert.match(html, /data-au-slow[^>]*>.*<button class="au-btn" data-au="retry">重试<\/button><\/div>/);
  assert.equal(count(html, 'data-au="retry"'), 1);
  assert.equal(count(html, '秒内没'), 1);
  assert.doesNotMatch(html, /au-msg bad|data-source=|class="au-btn primary"/);
});

test('其他失败仍是红框，但「公司内源」那一行不再重复同一句话', async () => {
  const error = '查不到新版本：' + openx.userReason('内源返回 HTTP 500', { file: '版本清单' });
  const r = row({ reason: '内源返回 HTTP 500' });
  const html = await render({ phase: 'error', error, current: '5.6.112', checks: [r], internalSource: { id: 'openx', status: 'failed', reason: r.reason }, attempts: [] });
  assert.match(html, /au-msg bad/);
  assert.equal(count(html, 'HTTP 500'), 1);
  assert.doesNotMatch(html, /data-source=/);
});

// ---- R44 第二步：内源列表变慢的同根问题——列表超时 3→8 秒、分页取全、下载先看第 1 页 ----
function pagedNet(total, { delayMs = 0, files = {}, noTotal = false } = {}) {
  // 版本 id 从新到旧：id = total..1，版本名 v5.6.<id>；files：{ id: 文件名 } 给某个版本挂附件。
  const all = Array.from({ length: total }, (_, i) => total - i).map(id => ({ id, version: files[id] && files[id].release ? files[id].release : `v5.6.${id}`, releaseTime: new Date(Date.UTC(2026, 0, 1) + id * 60000).toISOString() }));
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    url = String(url); calls.push(url);
    if (url.includes('by_project_id')) {
      // 只有列表慢（详情照常快），并且响应取消信号。
      if (delayMs) await new Promise((r, j) => { const t = setTimeout(r, delayMs); opts.signal && opts.signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
      const q = new URL(url).searchParams;
      const page = Number(q.get('currentPage')), size = Number(q.get('pageSize'));
      return new Response(JSON.stringify({ code: '0', data: { ...(noTotal ? {} : { total }), records: all.slice((page - 1) * size, page * size) } }));
    }
    const id = Number(new URL(url).searchParams.get('id'));
    const f = files[id];
    return new Response(JSON.stringify({ code: '0', data: { binaryPackages: f ? [{ originalFileName: f.file, url: new URL('f/' + f.file, openx.DEFAULT_API).href }] : [] } }));
  };
  return { calls, fetchImpl, pages: () => calls.filter(u => u.includes('by_project_id')) };
}

test('列表超时默认 8 秒：内源 3.5 秒才回（公司实测）也能取到，不再被标成连不上', async () => {
  assert.equal(openx.LIST_TIMEOUT_MS, 8000);
  const net = pagedNet(5, { delayMs: 3500, files: { 5: { file: 'Hub-update.gz' } } });
  const hit = await openx.find({ file: 'Hub-update.gz', version: '5.6.5', fetchImpl: net.fetchImpl, env: ENV });
  assert.ok(hit && hit.url, openx.lastReason());
  assert.equal(openx.reachability(), 'up');
});

test('完整列表分页取全：104 条不再漏掉最老的 4 条（每页 20 条，6 页）', async () => {
  const net = pagedNet(104, { files: { 2: { file: 'old-comp.zip', release: 'comp-1.0.0' } } });
  const hit = await openx.find({ file: 'old-comp.zip', release: 'comp-1.0.0', fetchImpl: net.fetchImpl, env: ENV });
  assert.ok(hit, openx.lastReason());
  assert.equal(hit.releaseVersion, 'comp-1.0.0');
  const pages = net.pages().map(u => new URL(u).searchParams.get('currentPage') + '/' + new URL(u).searchParams.get('pageSize'));
  assert.deepEqual(pages.slice().sort(), ['1/20', '2/20', '3/20', '4/20', '5/20', '6/20'], '第 1 页只取一次（复用刚取到的第 1 页）');
  assert.ok(net.pages().every(u => !/pageSize=100/.test(u)), '不再一次取 100 条');
});

test('程序更新包：第 1 页里就有这个版本时只取 1 页列表、不取全量', async () => {
  const net = pagedNet(104, { files: { 104: { file: 'Hub-update.gz' } } });
  const hit = await openx.find({ file: 'Hub-update.gz', version: '5.6.104', fetchImpl: net.fetchImpl, env: ENV });
  assert.ok(hit);
  assert.equal(net.pages().length, 1);
  // 探测复用同一页缓存，不再另取列表
  const row = await openx.probe({ version: '5.6.104', file: 'Hub-update.gz', fetchImpl: net.fetchImpl, env: ENV });
  assert.equal(row.ok, true);
  assert.equal(net.pages().length, 1);
});

test('探测：要看的版本不在第 1 页时取完整列表；整体预算默认 8 秒', async () => {
  const net = pagedNet(60);
  const row = await openx.probe({ version: '5.6.3', fetchImpl: net.fetchImpl, env: ENV });
  assert.equal(row.ok, true, JSON.stringify(row));
  assert.equal(row.version, '5.6.3');
});

test('某一页没取到：第 2 页上的版本照样找到；要找的在失败页上时说「没取全」，不报「没有这个文件」、不污染共享缓存、不标连不上', async () => {
  const base = pagedNet(60, { files: { 35: { file: 'a.zip', release: 'a-1' }, 10: { file: 'b.zip', release: 'b-1' } } });
  let fail3 = true;
  const fetchImpl = async (url, opts) => { if (fail3 && /currentPage=3/.test(String(url))) throw new Error('openx 返回 HTTP 502'); return base.fetchImpl(url, opts); };
  // id 35 在第 2 页（60..41 第 1 页，40..21 第 2 页）
  const hit = await openx.find({ file: 'a.zip', release: 'a-1', fetchImpl, env: ENV });
  assert.ok(hit, openx.lastReason());
  // id 10 在第 3 页（失败页）
  const details = () => base.calls.filter(u => u.includes('by_id')).length;
  const before = details();
  const miss = await openx.find({ file: 'b.zip', release: 'b-1', fetchImpl, env: ENV });
  assert.equal(miss, null);
  assert.match(openx.lastReason(), /没取全.*第 3 页/);
  assert.doesNotMatch(openx.lastReason(), /没有这个文件/);
  assert.equal(details(), before, '不盲查无关版本详情');
  assert.notEqual(openx.reachability(), 'down');
  // 残缺列表没进共享缓存：第 3 页恢复后立刻能找到
  fail3 = false;
  const hit2 = await openx.find({ file: 'b.zip', release: 'b-1', fetchImpl, env: ENV });
  assert.ok(hit2, openx.lastReason());
});

test('接口没给总数：第 1 页满 20 条就继续翻页，直到某页不满', async () => {
  const net = pagedNet(45, { noTotal: true, files: { 1: { file: 'c.zip', release: 'c-1' } } });
  const hit = await openx.find({ file: 'c.zip', release: 'c-1', fetchImpl: net.fetchImpl, env: ENV });
  assert.ok(hit, openx.lastReason());
  assert.deepEqual(net.pages().map(u => new URL(u).searchParams.get('currentPage')), ['1', '2', '3']);
});
