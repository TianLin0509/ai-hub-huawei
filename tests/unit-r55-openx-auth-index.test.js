'use strict';
// R55（2026-11-27）：同事在 v5.6.130 点「检查更新」看到「连不上公司内源」。公司电脑实测：内源版本列表接口（by_project_id）
// 匿名请求回 HTTP 200 + {code:"401",message:"未认证的请求"}（所有项目都这样），单个版本详情（by_id）和附件下载匿名照常。
// 修法：401/403 单独当「内源要求登录」说清（不说连不上、不催查网络）；配置了版本索引时，用 by_id 读索引代替列表，查更新和下载照常。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const manifestLib = require('../core/app-update/manifest.js');
manifestLib.currentRuntime = () => ({ electron: '41.2.0', native: { 'node-pty': '1.2.0-beta.13' } });
const openx = require('../core/app-update/openx-source');
const sourceStatus = require('../core/app-update/source-status');
const signing = require('../core/app-update/manifest-signing.js');
const { createAppUpdateController } = require('../main/app-update-controller');
const { createReceiverAddress } = require('../core/feedback-receiver-address');

const ENV = { AI_HUB_OPENX: '1' };
const API = openx.DEFAULT_API;
const CONFIG = require('../core/app-update/openx-config');
const FILE_HOST = new URL('files/', CONFIG.fileSite).href;
const SLUG = new URL(CONFIG.projectPage).pathname.replace(/^\/+|\/+$/g, '');   // 内源项目名，不在测试里写死
const KEYS = crypto.generateKeyPairSync('ed25519');
const PUB = KEYS.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PEM = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });
const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
// 公司电脑 2026-11-27 22:45 实测的原样回包（HTTP 200，正文 57 字节）。
const UNAUTH = () => json({ code: '401', message: '未认证的请求', data: null });
const INDEX_ID = 90001;
const manifest = version => ({ schema: 1, product: 'x', version, notes: ['r55'], runtime: { electron: '41.2.0', native: { 'node-pty': '1.2.0-beta.13' } },
  incremental: { file: `AIHubX-${version}-update.gz`, bytes: 14000, sha256: 'a'.repeat(64) },
  installer: { file: `AIHubX-Setup-${version}.exe`, bytes: 50000, sha256: 'b'.repeat(64) } });
const INDEX_DESC = ['AI HUB 版本索引（Hub 自动读取，请勿手改）', openx.INDEX_MARK,
  '12785 v5.6.132 2026-11-27T21:10:00+08:00', '12784 v5.6.131 2026-11-27T19:40:00+08:00', '12700 cli-codex-0.167.0', '12500 feedback-receiver', '11799 v5.6.34 更新包'].join('\n');

// 内源：列表一律 401；by_id 正常（索引、v5.6.132 带签名清单与更新包）。
function openxFetch({ indexDesc = INDEX_DESC, calls = [] } = {}) {
  const raw = JSON.stringify(manifest('5.6.132'), null, 2) + '\n';
  return async url => {
    url = String(url); calls.push(url);
    if (url.startsWith(API + 'by_project_id')) return UNAUTH();
    if (url === `${API}by_id?id=${INDEX_ID}`) return json({ code: '0', message: 'success', data: { id: INDEX_ID, version: 'hub-index', description: indexDesc, binaryPackages: [] } });
    if (url === `${API}by_id?id=12785`) return json({ code: '0', data: { binaryPackages: [
      { originalFileName: 'latest.json', url: FILE_HOST + '132-latest.json' }, { originalFileName: 'latest.json.sig', url: FILE_HOST + '132-latest.json.sig' },
      { originalFileName: 'AIHubX-5.6.132-update.gz', url: FILE_HOST + 'AIHubX-5.6.132-update.gz' }] } });
    if (url === `${API}by_id?id=12700`) return json({ code: '0', data: { binaryPackages: [{ originalFileName: 'codex-cli.zip', url: FILE_HOST + 'codex-cli.zip' }] } });
    if (url === `${API}by_id?id=12500`) return json({ code: '0', data: { binaryPackages: [{ originalFileName: 'feedback-receiver.json', url: FILE_HOST + 'fr.json' }] } });
    if (url.startsWith(API + 'by_id')) return json({ code: '0', data: { binaryPackages: [] } });
    if (url === FILE_HOST + '132-latest.json') return new Response(raw, { status: 200 });
    if (url === FILE_HOST + '132-latest.json.sig') return new Response(signing.signManifest(raw, PEM), { status: 200 });
    if (url === FILE_HOST + 'fr.json') return json({ urls: ['http://10.1.2.3:18767'] });
    throw new Error('意外的请求 ' + url);
  };
}
function makeController(fetchImpl, currentVersion = '5.6.130') {
  return createAppUpdateController({ app: { quit() {} }, config: {}, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r55-update-')),
    currentVersion, fetchImpl, isPackaged: false, logger: { warn() {}, info() {} }, manifestPublicKey: PUB,
    env: { ...ENV, AI_HUB_UPDATE_RESOURCES: os.tmpdir(), AI_HUB_UPDATE_RECHECK_MS: '3600000' } });
}
test.beforeEach(() => { openx._reset(); sourceStatus._reset(); });
test.after(() => openx._reset());

test('130 的现场：列表接口回 code 401，没有版本索引 → 「内源要求登录」，不说连不上、不催查网络，也不算不在公司网络', async () => {
  openx._reset({ indexId: 0 });
  const r = await openx.fetchManifest({ fetchImpl: openxFetch(), validate: x => x, env: ENV, currentVersion: '5.6.130', timeoutMs: 20000 });
  assert.equal(r.ok, false);
  assert.equal(r.auth, true);
  assert.ok(!r.offline && !r.slow);
  assert.match(r.reason, /内源要求登录（接口返回 401 未认证的请求）/);
  assert.doesNotMatch(r.reason, /连不上/);
  const text = openx.userReason(r.reason, { file: '版本清单' });
  assert.match(text, /要求登录.*不是网络问题/);
  assert.doesNotMatch(text, /连不上|确认电脑连着公司网络/);
  // HTTP 401 且回内源 JSON → 要求登录；HTTP 403 回网页（公司代理拦截 / 确认页）→ 不是要求登录，按 HTTP 错误
  openx._reset({ indexId: 0 });
  const h = await openx.fetchManifest({ fetchImpl: async () => new Response(JSON.stringify({ code: '401', message: '未认证的请求' }), { status: 401 }), validate: x => x, env: ENV, currentVersion: '5.6.130' });
  assert.equal(h.auth, true);
  openx._reset({ indexId: 0 });
  const p = await openx.fetchManifest({ fetchImpl: async () => new Response('<html>HIS Proxy Notification</html>', { status: 403, headers: { 'content-type': 'text/html' } }), validate: x => x, env: ENV, currentVersion: '5.6.130' });
  assert.ok(!p.auth);
  assert.match(p.reason, /HTTP 403/);
});

test('控制器：手动检查遇到要求登录 → errorKind auth，提示照实说，30 分钟后静默再查', async () => {
  openx._reset({ indexId: 0 });
  const c = makeController(openxFetch());
  try {
    const s = await c.check({ silent: false });
    assert.equal(s.phase, 'error');
    assert.equal(s.errorKind, 'auth');
    assert.match(s.error, /^查不到新版本：公司内源的版本查询接口现在要求登录/);
    assert.doesNotMatch(s.error, /连不上|确认电脑连着公司网络/);
  } finally { c.dispose(); }
});

test('索引优先：用 by_id 读索引，查到 v5.6.132 签名清单 → 有新版本；索引是新的就一次列表都不请求', async () => {
  openx._reset({ indexId: INDEX_ID });
  const calls = [];
  const c = makeController(openxFetch({ calls }));
  try {
    const s = await c.check({ silent: false });
    assert.equal(s.phase, 'available', s.error);
    assert.equal(s.latest.version, '5.6.132');
    assert.equal(calls.filter(u => u.includes('by_project_id')).length, 0);
    assert.ok(calls.includes(`${API}by_id?id=${INDEX_ID}`));
    assert.equal(openx.reachability(), 'up');
  } finally { c.dispose(); }
});

test('配了版本索引：当前已是 v5.6.132 → 已是最新，「公司内源」一行是可用', async () => {
  openx._reset({ indexId: INDEX_ID });
  const c = makeController(openxFetch(), '5.6.132');
  try {
    const s = await c.check({ silent: false });
    assert.equal(s.phase, 'none', s.error);
    assert.equal(s.internalSource.ok, true);
  } finally { c.dispose(); }
});

test('索引优先：组件下载 find 能在索引里找到老版本（不在前 20 个也行），不碰列表', async () => {
  openx._reset({ indexId: INDEX_ID });
  const calls = [];
  const hit = await openx.find({ file: 'codex-cli.zip', version: '0.167.0', release: 'cli-codex-0.167.0', fetchImpl: openxFetch({ calls }), env: ENV });
  assert.ok(hit, openx.lastReason());
  assert.equal(hit.releaseId, 12700);
  assert.equal(calls.filter(u => u.includes('by_project_id')).length, 0);
  // 完整列表也直接用索引（findLatestFull / 回退页走 loadList）
  const full = await openx.findLatestFull({ fetchImpl: openxFetch({ calls }), currentVersion: '5.6.130', env: ENV });
  assert.equal(full.ok, false);
  assert.match(full.reason, /没找到完整安装包/);
  assert.equal(calls.filter(u => u.includes('by_project_id')).length, 0);
  // 索引模式下项目名取 openx-config.projectPage 的路径（下载页地址要用）
  assert.equal(openx.projectName(), SLUG);
});

// 列表恢复匿名时的回包（第 1 页只给 v5.6.134）
const LIST_OK = () => json({ code: '0', data: { name: SLUG, total: 1, records: [{ id: 12800, version: 'v5.6.134', releaseTime: '2026-11-28 10:00:00' }] } });
test('索引没跟上（最新程序版本比本机还旧）：顺手再试一次列表；列表 401 就以索引为准，列表能读就用列表', async () => {
  openx._reset({ indexId: INDEX_ID, localVersion: '5.6.133' });
  const calls = [];
  let r = await openx.fetchManifest({ fetchImpl: openxFetch({ calls }), validate: x => x, env: ENV, currentVersion: '5.6.133', publicKey: PUB });
  assert.equal(calls.filter(u => u.includes('by_project_id')).length, 1, '试过一次列表');
  assert.equal(r.older, true, '列表 401，按索引里的 v5.6.132 → 比本机旧 = 已是最新');
  openx._reset({ indexId: INDEX_ID, localVersion: '5.6.133' });
  const base = openxFetch();
  const seen = [];
  const withList = async url => { seen.push(String(url)); return String(url).startsWith(API + 'by_project_id') ? LIST_OK() : String(url) === `${API}by_id?id=12800` ? json({ code: '0', data: { binaryPackages: [] } }) : base(url); };
  r = await openx.fetchManifest({ fetchImpl: withList, validate: x => x, env: ENV, currentVersion: '5.6.133', publicKey: PUB });
  assert.ok(seen.includes(`${API}by_id?id=12800`), '用了列表里的 v5.6.134');
  // 索引里一个程序版本都没有，也算没跟上
  openx._reset({ indexId: INDEX_ID });
  const c2 = [];
  await openx.fetchManifest({ fetchImpl: openxFetch({ calls: c2, indexDesc: `${openx.INDEX_MARK}
12700 cli-codex-0.167.0` }), validate: x => x, env: ENV, currentVersion: '5.6.130', publicKey: PUB });
  assert.equal(c2.filter(u => u.includes('by_project_id')).length, 1);
});

test('索引读不到时照旧读列表：列表能读就正常；索引和列表都是网络错误 → 仍按「不在公司网络」快判', async () => {
  openx._reset({ indexId: INDEX_ID });
  const base = openxFetch();
  const r = await openx.find({ file: 'codex-cli.zip', version: '0.167.0', release: 'cli-codex-0.167.0', env: ENV,
    fetchImpl: async url => String(url) === `${API}by_id?id=${INDEX_ID}` ? json({ code: '500', message: '服务忙' })
      : String(url).startsWith(API + 'by_project_id') ? json({ code: '0', data: { total: 1, records: [{ id: 12700, version: 'cli-codex-0.167.0' }] } }) : base(url) });
  assert.ok(r, openx.lastReason());
  assert.equal(r.releaseId, 12700);
  openx._reset({ indexId: INDEX_ID });
  const off = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const m = await openx.fetchManifest({ fetchImpl: async () => { throw off; }, validate: x => x, env: ENV, currentVersion: '5.6.130' });
  assert.equal(m.offline, true);
  assert.ok(!m.auth);
});

test('AI_HUB_OPENX_INDEX_ID 只在设置时覆盖配置里的索引 id', () => {
  assert.equal(openx.indexIdFromEnv({ AI_HUB_OPENX_INDEX_ID: '90001' }), 90001);
  assert.equal(openx.indexIdFromEnv({}), 0);
  assert.equal(openx.indexIdFromEnv({ AI_HUB_OPENX_INDEX_ID: 'x' }), 0);
  // 填 id 后（审查 P2-1）：写 0 能显式关掉索引；没设或写错仍用配置里的 id。
  assert.equal(openx.indexOverrideFromEnv({ AI_HUB_OPENX_INDEX_ID: '0' }), 0);
  assert.equal(openx.indexOverrideFromEnv({ AI_HUB_OPENX_INDEX_ID: ' 90001 ' }), 90001);
  assert.equal(openx.indexOverrideFromEnv({}), null);
  assert.equal(openx.indexOverrideFromEnv({ AI_HUB_OPENX_INDEX_ID: 'x' }), null);
});

test('AI_HUB_OPENX_INDEX_ID=0：配置里有索引 id 也不读索引，直接走列表（列表 401 照实报要求登录）', async t => {
  const prev = process.env.AI_HUB_OPENX_INDEX_ID;
  t.after(() => { if (prev === undefined) delete process.env.AI_HUB_OPENX_INDEX_ID; else process.env.AI_HUB_OPENX_INDEX_ID = prev; openx._reset(); });
  process.env.AI_HUB_OPENX_INDEX_ID = '0';
  openx._reset();
  const calls = [];
  const fetchImpl = async url => { calls.push(String(url)); return json({ code: 401, message: '请先登录' }); };
  const r = await openx.fetchManifest({ fetchImpl, validate: x => x, env: { AI_HUB_OPENX: '1' }, currentVersion: '5.6.130' });
  assert.equal(r.ok, false); assert.match(r.reason, /要求登录/, r.reason);
  assert.ok(calls.length && calls.every(u => u.includes('by_project_id')), calls.join(' | '));
  delete process.env.AI_HUB_OPENX_INDEX_ID;
  openx._reset();
  calls.length = 0;
  await openx.fetchManifest({ fetchImpl, validate: x => x, env: { AI_HUB_OPENX: '1' }, currentVersion: '5.6.130' }).catch(() => {});
  if (openx.INDEX_RELEASE_ID) assert.ok(calls[0].includes(`by_id?id=${openx.INDEX_RELEASE_ID}`), '没设时默认先读配置里的索引：' + calls[0]);
});

test('索引本身读不到或格式不对：照实报「要求登录」+ 索引的问题，不说连不上', async () => {
  openx._reset({ indexId: INDEX_ID });
  const r = await openx.fetchManifest({ fetchImpl: openxFetch({ indexDesc: '没有标记行' }), validate: x => x, env: ENV, currentVersion: '5.6.130' });
  assert.equal(r.auth, true);
  assert.match(r.reason, /要求登录.*版本索引也没读到/);
  assert.doesNotMatch(r.reason, /连不上/);
});

test('下载点状态：要求登录显示 auth（不是「连不上 + 查网络」），5 分钟内复查也一样', async () => {
  openx._reset({ indexId: 0 });
  const v = await sourceStatus.check({ files: ['codex-cli.zip'], release: 'cli-codex-0.167.0' }, { fetchImpl: openxFetch(), env: ENV });
  assert.equal(v.status, 'auth');
  assert.match(v.text, /要求登录.*不是网络问题/);
  assert.doesNotMatch(v.text, /连不上/);
  sourceStatus._reset();
  const again = await sourceStatus.check({ files: ['other.zip'] }, { fetchImpl: openxFetch(), env: ENV });
  assert.equal(again.status, 'auth');
  assert.equal(openx.diagnostics().down.auth, true);
});

test('parseIndex：标记行之后每行一个版本；版本名可带空格；时间可省；重复 id 只留第一条；没有标记行返回空', () => {
  const r = openx.parseIndex(INDEX_DESC);
  assert.deepEqual(r.map(x => x.id), [12785, 12784, 12700, 12500, 11799]);
  assert.equal(r[0].version, 'v5.6.132');
  assert.equal(r[0].releaseTime, '2026-11-27T21:10:00+08:00');
  assert.equal(r[4].version, 'v5.6.34 更新包');
  assert.equal(r[2].releaseTime, '');
  assert.deepEqual(openx.parseIndex('12785 v5.6.132'), []);
  assert.equal(openx.parseIndex(`${openx.INDEX_MARK}\n1 a\n1 b\n乱写一行`).length, 1);
});

test('反馈收件地址：索引优先找到 feedback-receiver；没配索引时如实说要求登录，并仍判定人在公司内', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r55-fr-'));
  const frCalls = [];
  const ok = await createReceiverAddress({ dataDir: dir, fetchImpl: openxFetch({ calls: frCalls }), config: { ...CONFIG, indexReleaseId: INDEX_ID } }).resolve();
  assert.equal(ok.from, 'openx');
  assert.equal(frCalls.filter(u => u.includes('by_project_id')).length, 0, '索引优先，不碰列表');
  // 索引读到了但里面没有收件地址版本：以索引为准，不再翻列表
  const c3 = [];
  const miss = await createReceiverAddress({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r55-fr-')), fetchImpl: openxFetch({ calls: c3, indexDesc: `${openx.INDEX_MARK}
12785 v5.6.132` }),
    config: { ...CONFIG, indexReleaseId: INDEX_ID } }).resolve();
  assert.equal(c3.filter(u => u.includes('by_project_id')).length, 0);
  assert.equal(miss.openxReachable, true);
  assert.match(miss.reason, /还没有发布收件地址/);
  assert.deepEqual(ok.urls, ['http://10.1.2.3:18767']);
  const none = await createReceiverAddress({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r55-fr-')), fetchImpl: openxFetch(), config: { ...CONFIG, indexReleaseId: 0 } }).resolve();
  assert.equal(none.openxReachable, true);
  assert.match(none.reason, /要求登录/);
});

function render(state) {
  let dialog;
  class El {
    constructor() { this.style = {}; this.dataset = {}; this.classList = { toggle() {}, contains() { return false; } }; }
    addEventListener() {} appendChild() {} remove() {} querySelector() { return null; } querySelectorAll() { return []; }
    showModal() { this.open = true; } close() { this.open = false; }
  }
  const context = { console, URL, window: {}, setTimeout() {}, clearTimeout() {}, setInterval() {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: { head: new El(), body: new El(), getElementById() { return null; }, createElement(tag) { const e = new El(); if (tag === 'dialog') dialog = e; return e; } },
    require(id) {
      if (id === '../core/distribution') return { productName: 'Hub', editionBadge: '内测先锋版', updateConfig: { sources: [] } };
      if (id === '../core/app-update/source-view' || id === '../core/app-update/openx-config') return require(id);
      if (id === 'electron') return { ipcRenderer: { on() {}, invoke: async k => k === 'app-update:get-state' ? state : null }, shell: {} };
      if (id === './download-progress-view') return require('../renderer/download-progress-view');
      throw new Error(id);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/app-update.js'), 'utf8'), context);
  return new Promise(resolve => setImmediate(() => { context.window.__appUpdate.open(); resolve(dialog.innerHTML); }));
}

test('更新窗 auth：黄色说明一次、不红、不给「重试」，给「打开内源项目页」', async () => {
  const error = '查不到新版本：' + openx.userReason('内源要求登录（接口返回 401 未认证的请求）', { file: '版本清单' });
  const html = await render({ phase: 'error', errorKind: 'auth', error, current: '5.6.130', checks: [], attempts: [] });
  assert.match(html, /au-msg warn" data-au-auth/);
  assert.equal(html.split('要求登录').length - 1, 1);
  assert.match(html, /data-au="project-page">打开内源项目页/);
  assert.doesNotMatch(html, /au-msg bad|data-au="retry"|连不上/);
});

// ---------- Antigravity 审查（2026-11-28）逐条 ----------
test('审查 P1-1：下载点胶囊 auth 显示「内源 · 需登录」并有重测/复制排错按钮', () => {
  const view = require('../renderer/download-source-view');
  const h = view.html({ status: 'auth', text: 'x' }, 'p');
  assert.match(h, /内源 · 需登录/);
  assert.match(h, /data-dl-act="retest"/);
  assert.match(view.CSS, /data-status="auth"\] \.dl-src-tag/);
});

test('审查 P1-2：列表从没读到（要求登录）时，项目名和下载页地址回落 openx-config.projectPage', async () => {
  openx._reset({ indexId: 0 });
  await openx.fetchManifest({ fetchImpl: openxFetch(), validate: x => x, env: ENV, currentVersion: '5.6.130' });
  assert.equal(openx.projectName(), SLUG);
  assert.ok(openx.downloadPageUrl().endsWith('/' + SLUG + '/download'), openx.downloadPageUrl());
});

test('审查 P1-3 ①：索引里最新版本等于本机（<=）也顺手试一次列表；列表恢复匿名时能查到更新的版本', async () => {
  openx._reset({ indexId: INDEX_ID, localVersion: '5.6.132' });
  const base = openxFetch();
  const seen = [];
  const withList = async url => { seen.push(String(url)); return String(url).startsWith(API + 'by_project_id') ? LIST_OK() : String(url) === `${API}by_id?id=12800` ? json({ code: '0', data: { binaryPackages: [] } }) : base(url); };
  await openx.fetchManifest({ fetchImpl: withList, validate: x => x, env: ENV, currentVersion: '5.6.132', publicKey: PUB });
  assert.equal(seen.filter(u => u.includes('by_project_id')).length, 1);
  assert.ok(seen.includes(`${API}by_id?id=12800`), '用了列表里的 v5.6.134');
});

test('审查 P1-3 ②：读索引离线或超时，直接按离线 / 慢处理，不再请求列表；反馈收件地址同样', async () => {
  const off = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  for (const failure of [off, Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })]) {
    openx._reset({ indexId: INDEX_ID });
    const calls = [];
    const f = async url => { calls.push(String(url)); throw failure; };
    const r = await openx.find({ file: 'codex-cli.zip', version: '0.167.0', release: 'cli-codex-0.167.0', fetchImpl: f, env: ENV });
    assert.equal(r, null);
    assert.equal(calls.length, 1, failure.message);
    assert.ok(calls[0].includes(`by_id?id=${INDEX_ID}`));
    assert.equal(openx.reachability(), 'down');
  }
  const calls = [];
  const fr = await createReceiverAddress({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r55-fr-')), fetchImpl: async url => { calls.push(String(url)); throw off; },
    config: { ...CONFIG, indexReleaseId: INDEX_ID } }).resolve();
  assert.equal(calls.length, 1);
  assert.equal(fr.openxReachable, false);
});

test('审查 P2-4：by_id 回的版本名和索引里对不上（索引 id 填错）就当没有附件，不串版；反馈收件地址同样', async () => {
  openx._reset({ indexId: INDEX_ID });
  const base = openxFetch();
  const wrong = async url => String(url) === `${API}by_id?id=12700`
    ? json({ code: '0', data: { version: 'member-v5.6.132', binaryPackages: [{ originalFileName: 'codex-cli.zip', url: FILE_HOST + 'codex-cli.zip' }] } }) : base(url);
  assert.equal(await openx.find({ file: 'codex-cli.zip', version: '0.167.0', release: 'cli-codex-0.167.0', fetchImpl: wrong, env: ENV }), null);
  // 版本名对得上（大小写不同也算）照常
  openx._reset({ indexId: INDEX_ID });
  const right = async url => String(url) === `${API}by_id?id=12700`
    ? json({ code: '0', data: { version: 'CLI-codex-0.167.0', binaryPackages: [{ originalFileName: 'codex-cli.zip', url: FILE_HOST + 'codex-cli.zip' }] } }) : base(url);
  assert.ok(await openx.find({ file: 'codex-cli.zip', version: '0.167.0', release: 'cli-codex-0.167.0', fetchImpl: right, env: ENV }));
  const fr = await createReceiverAddress({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r55-fr-')), config: { ...CONFIG, indexReleaseId: INDEX_ID },
    fetchImpl: async url => String(url) === `${API}by_id?id=12500` ? json({ code: '0', data: { version: 'v5.6.1', binaryPackages: [{ originalFileName: 'feedback-receiver.json', url: FILE_HOST + 'fr.json' }] } }) : base(url) }).resolve();
  assert.notEqual(fr.from, 'openx');
});

test('审查 P2-5：反馈收件地址遇到 HTTP 401/403 回 JSON 算要求登录（人在公司内）；回网页（代理拦截页）仍按 HTTP 错误', async () => {
  const mk = res => createReceiverAddress({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r55-fr-')), config: { ...CONFIG, indexReleaseId: 0 }, fetchImpl: async () => res() }).resolve();
  const a = await mk(() => new Response(JSON.stringify({ code: '401', message: '未认证的请求' }), { status: 401 }));
  assert.equal(a.openxReachable, true); assert.match(a.reason, /要求登录/);
  const b = await mk(() => new Response('<html>HIS Proxy Notification</html>', { status: 403 }));
  assert.equal(b.openxReachable, false); assert.match(b.reason, /HTTP 403/);
});

test('审查 P2-7：要求登录时不再后台找完整安装包（不白占 1 分钟冷却）；回退页文案写「可回退的旧版本」', async () => {
  openx._reset({ indexId: 0 });
  const calls = [];
  const c = makeController(openxFetch({ calls }));
  try {
    const s = await c.check({ silent: false });
    assert.equal(s.errorKind, 'auth');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(calls.filter(u => u.includes('by_project_id')).length, 1, '没有为找完整包再读列表');
  } finally { c.dispose(); }
  assert.match(openx.userReason('内源要求登录（接口返回 401）', { file: '版本清单', what: '可回退的旧版本' }), /自动查不到可回退的旧版本/);
});
