'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const openx = require('../core/app-update/openx-source');
const { sourceText, MEMBER_NOTE } = require('../core/app-update/source-view');
const { createAppUpdateController } = require('../main/app-update-controller');
const { runEnvCheck } = require('../core/env-check');
const originalEdition = openx.EDITION_ON;
const version = '5.6.57';
const file = 'Hub-update.gz';
const sources = [{ id: 'external', name: '外网源', manifest: 'https://example.invalid/latest.json', files: 'https://example.invalid/v{version}/' }];
const manifest = { schema: 1, product: 'x', version, notes: [], runtime: { electron: '41.2.0', native: {} },
  incremental: { file, bytes: 14000, sha256: 'a'.repeat(64) }, installer: { file: 'Hub.exe', bytes: 50000, sha256: 'b'.repeat(64) } };
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
function fakeNet({ releases = [{ id: 1, version: 'v' + version }], down = false, packages = [{ originalFileName: file, url: new URL('package.gz', openx.DEFAULT_API).href }] } = {}) {
  const calls = [];
  return { calls, fetchImpl: async url => {
    calls.push(String(url));
    if (url === sources[0].manifest) return json(manifest);
    if (down) throw new Error('DNS 无法解析');
    return json({ code: '0', data: String(url).includes('by_project_id') ? { records: releases } : { binaryPackages: packages } });
  } };
}
function controller(net, isPublic) {
  openx.EDITION_ON = isPublic;
  return createAppUpdateController({ config: { sources }, currentVersion: '5.6.56', fetchImpl: net.fetchImpl,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'update-source-')),
    // 版本清单用测试注入的本机源（AI_HUB_UPDATE_SOURCES），这里只测内源那一行的探测。
    env: { AI_HUB_OPENX: '1', AI_HUB_UPDATE_SOURCES: JSON.stringify(sources) } });
}
test.beforeEach(() => openx._reset());
test.afterEach(() => { openx.EDITION_ON = originalEdition; });

test('成员版（r56）：内源行显示 member-v<版本> 的真实探测结果；只有公开版同名版本时显示没有该版本', async () => {
  let net = fakeNet({ releases: [{ id: 2, version: 'v' + version }, { id: 3, version: 'member-v' + version }] });
  let c = controller(net, false);
  try {
    const state = await c.check();
    assert.equal(state.sourceEdition, '成员版');
    assert.equal(state.checks[0].id, 'openx');
    assert.equal(sourceText(state.internalSource), '可用，最新 v' + version);
    assert.deepEqual(net.calls.filter(url => url.includes('by_id')).map(url => url.split('=').pop()), ['3'], '只查 member 版本详情');
    assert.equal((await c.probeSources()).sources[0].ok, true);
  } finally { c.dispose(); }
  openx._reset();
  net = fakeNet({ releases: [{ id: 2, version: 'v' + version }] });
  c = controller(net, false);
  try {
    assert.equal(sourceText((await c.check()).internalSource), '没有该版本 v' + version);
    assert.equal(net.calls.filter(url => url.includes('by_id')).length, 0, '公开版版本不查');
  } finally { c.dispose(); }
  // 公开版看不到 member-*
  openx._reset();
  net = fakeNet({ releases: [{ id: 3, version: 'member-v' + version }] });
  c = controller(net, true);
  try { assert.equal(sourceText((await c.check()).internalSource), '没有该版本 v' + version); } finally { c.dispose(); }
});

test('公开版：窗口与体检均显示可用的目标版本，和下载器共用列表及详情缓存', async () => {
  const net = fakeNet();
  const c = controller(net, true);
  try {
    const state = await c.check();
    assert.equal(state.sourceEdition, '公开版');
    assert.equal(state.checks[0].id, 'openx');
    assert.equal(sourceText(state.internalSource), '可用，最新 v' + version);
    const probe = await c.probeSources();
    assert.equal(probe.sources[0].ok, true);
    assert.equal(net.calls.filter(url => url.includes('by_project_id')).length, 1);
    assert.equal(net.calls.filter(url => url.includes('by_id')).length, 1);
    assert.equal((await openx.find({ file, version, fetchImpl: net.fetchImpl, env: { AI_HUB_OPENX: '1' } })).releaseId, 1);
    assert.equal(net.calls.filter(url => url.includes('by_id')).length, 1);
  } finally { c.dispose(); }
});

test('公开版：内源连不上显示原因，5 分钟失败缓存避免重复请求', async () => {
  const net = fakeNet({ down: true });
  const c = controller(net, true);
  try {
    assert.equal((await c.check()).phase, 'available');
    assert.match(sourceText(c.getState().internalSource), /连不上：DNS 无法解析/);
    assert.equal((await c.probeSources()).sources[0].status, 'failed');
    assert.equal(net.calls.filter(url => url.includes('by_project_id')).length, 1);
  } finally { c.dispose(); }
});

test('公开版：缺少该版本或其程序附件显示没有该版本，不查询无关组件详情', async () => {
  for (const opts of [{ releases: [{ id: 9, version: 'room-runtime-2.1.0' }] }, { packages: [] }]) {
    openx._reset();
    const net = fakeNet(opts);
    const c = controller(net, true);
    try {
      const state = await c.check();
      assert.equal(sourceText(state.internalSource), '没有该版本 v' + version);
      if (opts.releases) assert.equal(net.calls.filter(url => url.includes('by_id')).length, 0);
    } finally { c.dispose(); }
  }
});

test('内源探测有整体预算，慢网络和不响应取消的网络都按时返回', async () => {
  const started = Date.now();
  const row = await openx.probe({ version, file, env: { AI_HUB_OPENX: '1' }, timeoutMs: 35, fetchImpl: () => new Promise(() => {}) });
  assert.ok(Date.now() - started < 500);
  assert.match(sourceText(row), /连不上：.*未完成探测/);
});

test('环境体检：内源在单独一行，成员版不误报故障，内源可用也不掩盖外网清单全部失败', async () => {
  for (const [internal, externalOk, expected] of [
    [{ status: 'off', reason: MEMBER_NOTE }, true, 'ok'],
    [{ status: 'failed', reason: 'DNS 无法解析' }, true, 'ok'],
    [{ status: 'missing', version }, true, 'ok'],
    [{ status: 'ok', ok: true, version }, false, 'bad'],
  ]) {
    const r = await runEnvCheck({ platform: 'linux', kindAllowed: () => false,
      appUpdate: () => ({ probeSources: async () => ({ sources: [
        { id: 'openx', name: '内源（公司内网）', informational: true, ok: false, ...internal },
        { id: 'external', name: '外网源', ok: externalOk, version: externalOk ? version : null, reason: '网络不通' },
      ] }) }) });
    const row = r.items.find(i => i.id === 'app-update');
    assert.equal(row.status, expected);
    assert.match(row.detail, /\n内源（公司内网）：/);
    assert.ok(row.detail.includes(sourceText(internal)));
  }
});

function render(state, isPublic) {
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
      if (id === '../core/app-update/openx-config') return { enabledInEdition: isPublic };
      if (id === '../core/app-update/source-view') return require(id);
      if (id === 'electron') return { ipcRenderer: { on() {}, invoke: async k => k === 'app-update:get-state' ? state : null }, shell: {} };
      if (id === './download-progress-view') return require('../renderer/download-progress-view');
      throw new Error(id);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/app-update.js'), 'utf8'), context);
  return new Promise(resolve => setImmediate(() => { context.window.__appUpdate.open(); resolve(dialog.innerHTML); }));
}
test('更新窗真实渲染（R35）：只有一行「公司内源」状态，写清原因和下一步；没有多源列表、版本类别、放行框、抢先版', async () => {
  const { internalLine } = require('../core/app-update/source-view');
  for (const internal of [{ status: 'failed', reason: '<错误>' }, { status: 'missing', version }, { ok: true, version }, { status: 'down', reason: '内源连不上：DNS 无法解析' }]) {
    const row = { id: 'openx', name: '内源（公司内网）', ...internal };
    for (const phase of ['none', 'available', 'error']) {
      const html = await render({ phase, current: version, latest: { version }, plan: { kind: 'full' }, internalSource: row, checks: [row], attempts: [] }, true);
      assert.ok(html.includes('内测先锋版'));
      // R44：error 时红框已写明原因，不再另列「公司内源」一行重复同一句话。
      assert.equal((html.match(/data-source=/g) || []).length, phase === 'error' ? 0 : 1, phase + ' 来源行数');
      if (phase !== 'error') {
        assert.ok(html.includes('data-source="openx"'));
        assert.ok(html.includes(internalLine(row).replace(/</g, '&lt;').replace(/>/g, '&gt;')), phase);
      }
      assert.doesNotMatch(html, /公开版|成员版|更新源|外网源|按顺序尝试|抢先版|放行下载服务器|data-au="preview"|只能更新到最新版/);
    }
  }
  assert.match(internalLine({ status: 'missing', version }), /缺包.*请过几分钟再试/);
  assert.match(internalLine({ status: 'down', reason: '内源连不上：DNS 无法解析' }), /连不上公司内源.*公司网络/);
});

test('内源新版清单还没上来（pending）：一行平静提示，不红、不叫重试和反馈（2026-11-25）', async () => {
  const row = { id: 'openx-manifest', name: '公司内源 · 版本清单', ok: false, reason: '内源上的程序版本还没有附带版本清单' };
  const html = await render({ phase: 'none', pending: true, current: version, latest: null, plan: null, internalSource: row, checks: [row], attempts: [] }, true);
  assert.match(html, /data-au-pending/);
  assert.match(html, /暂时没有可安装的新版本/);
  assert.doesNotMatch(html, /au-msg bad|一键反馈|data-au="retry"|已是最新版本|版本清单/);
});
