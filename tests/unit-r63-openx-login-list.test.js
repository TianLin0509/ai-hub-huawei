'use strict';
// R63（2026-11-28）：检查更新的第三条路——版本索引读不到（by_id 也被收紧 / 索引过期）且匿名列表要求登录时，
// 借本人 Edge 登录查版本列表（main/openx-login-list.js 注入 openx-source.setLoginLister）。
// 这里不真的拉起 Edge：登录查询用假函数，页面脚本在 vm 里配假 localStorage / fetch 跑。
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
const signing = require('../core/app-update/manifest-signing.js');
const loginList = require('../main/openx-login-list');
const { createAppUpdateController } = require('../main/app-update-controller');

const ENV = { AI_HUB_OPENX: '1' };
const API = openx.DEFAULT_API;
const CONFIG = require('../core/app-update/openx-config');
const FILE_HOST = new URL('files/', CONFIG.fileSite).href;
const KEYS = crypto.generateKeyPairSync('ed25519');
const PUB = KEYS.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PEM = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });
const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const UNAUTH = () => json({ code: '401', message: '未认证的请求', data: null });
const INDEX_ID = 90001;
const manifest = version => ({ schema: 1, product: 'x', version, notes: ['r63'], runtime: { electron: '41.2.0', native: { 'node-pty': '1.2.0-beta.13' } },
  incremental: { file: `AIHubX-${version}-update.gz`, bytes: 14000, sha256: 'a'.repeat(64) },
  installer: { file: `AIHubX-Setup-${version}.exe`, bytes: 50000, sha256: 'b'.repeat(64) } });
const RAW = JSON.stringify(manifest('5.6.141'), null, 2) + '\n';
const PKGS_141 = [
  { id: 1, originalFileName: 'latest.json', url: FILE_HOST + '141-latest.json' },
  { id: 2, originalFileName: 'latest.json.sig', url: FILE_HOST + '141-latest.json.sig' },
  { id: 3, originalFileName: 'AIHubX-5.6.141-update.gz', url: FILE_HOST + 'AIHubX-5.6.141-update.gz' }];
const INDEX_DESC = ['索引', openx.INDEX_MARK, '12790 v5.6.141 2026-11-28T10:00:00+08:00', '12700 cli-codex-0.167.0'].join('\n');

// 内源：列表一律 401；index 决定索引怎么回（'ok' / 'unauth' / 'empty' 无标记 / 'noapp' 只有组件版本）；byIdLocked 时其余 by_id 也 401（只能靠登录带回的详情）。
function openxFetch({ index = 'unauth', byIdLocked = true, calls = [] } = {}) {
  return async url => {
    url = String(url); calls.push(url);
    if (url.startsWith(API + 'by_project_id')) return UNAUTH();
    if (url === `${API}by_id?id=${INDEX_ID}`) {
      if (index === 'unauth') return UNAUTH();
      const desc = index === 'empty' ? '没有标记' : index === 'noapp' ? ['索引', openx.INDEX_MARK, '12700 cli-codex-0.167.0'].join('\n') : INDEX_DESC;
      return json({ code: '0', data: { id: INDEX_ID, version: 'hub-index', description: desc, binaryPackages: [] } });
    }
    if (url.startsWith(API + 'by_id')) {
      if (byIdLocked) return UNAUTH();
      if (url === `${API}by_id?id=12790`) return json({ code: '0', data: { version: 'v5.6.141', binaryPackages: PKGS_141 } });
      return json({ code: '0', data: { binaryPackages: [] } });
    }
    if (url === FILE_HOST + '141-latest.json') return new Response(RAW, { status: 200 });
    if (url === FILE_HOST + '141-latest.json.sig') return new Response(signing.signManifest(RAW, PEM), { status: 200 });
    throw new Error('意外的请求 ' + url);
  };
}
// 假的「借 Edge 登录查列表」：记次数，可延迟、可失败。
function fakeLister({ ok = true, delayMs = 0, reason = 'Edge 里还没登录内源', permanent = false } = {}) {
  const fn = async args => {
    fn.calls.push(args);
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    if (!ok) return { ok: false, reason, permanent };
    return { ok: true, name: '', records: [
      { id: 12790, version: 'v5.6.141', releaseTime: '2026-11-28T10:00:00+08:00' },
      { id: 12700, version: 'cli-codex-0.167.0', releaseTime: '2026-11-20T10:00:00+08:00' }],
    details: [{ id: 12790, version: 'v5.6.141', binaryPackages: PKGS_141 }] };
  };
  fn.calls = [];
  return fn;
}
const fetchManifest = (fetchImpl, extra = {}) => openx.fetchManifest({ fetchImpl, validate: x => x, env: ENV, currentVersion: '5.6.140', publicKey: PUB, timeoutMs: 20000, ...extra });

test.beforeEach(() => { openx._reset({ indexId: INDEX_ID, localVersion: '5.6.140' }); });
test.after(() => openx._reset());

test('索引正常 → 不开 Edge', async () => {
  const lister = fakeLister();
  openx.setLoginLister(lister);
  const r = await fetchManifest(openxFetch({ index: 'ok', byIdLocked: false }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.manifest.version, '5.6.141');
  assert.equal(lister.calls.length, 0);
});

test('索引读不到（by_id 也 401）+ 列表 401 → 借 Edge 登录拿到记录，详情也从登录结果来，查到新版', async () => {
  const lister = fakeLister();
  openx.setLoginLister(lister);
  const calls = [];
  const r = await fetchManifest(openxFetch({ index: 'unauth', byIdLocked: true, calls }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.manifest.version, '5.6.141');
  assert.equal(lister.calls.length, 1);
  assert.equal(lister.calls[0].projectId, openx.PROJECT_ID);
  // v5.6.141 的附件来自登录带回的详情：没有再匿名请求 by_id?id=12790（它会 401）
  assert.ok(!calls.includes(`${API}by_id?id=12790`));
  // 登录查到的列表当全量：同一轮里下载找文件直接命中，不翻页、不再开 Edge
  const hit = await openx.find({ file: 'AIHubX-5.6.141-update.gz', version: '5.6.141', fetchImpl: openxFetch({ calls }), env: ENV });
  assert.ok(hit && hit.url.endsWith('AIHubX-5.6.141-update.gz'));
  assert.equal(lister.calls.length, 1);
  assert.equal(openx.diagnostics().login.ok, true);
  assert.equal(openx.diagnostics().login.records, 2);
});

test('索引格式不对（by_id 匿名可读）+ 列表 401 → 也走登录路', async () => {
  const lister = fakeLister();
  openx.setLoginLister(lister);
  const r = await fetchManifest(openxFetch({ index: 'empty', byIdLocked: false }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(lister.calls.length, 1);
});

test('登录也失败 → 原来的「要求登录」提示，并补一句请在 Edge 里登录一次内源', async () => {
  const lister = fakeLister({ ok: false, reason: 'Edge 里还没登录内源' });
  openx.setLoginLister(lister);
  const r = await fetchManifest(openxFetch({ index: 'unauth' }));
  assert.equal(r.ok, false);
  assert.equal(r.auth, true);
  assert.ok(!r.offline && !r.slow);
  assert.match(r.reason, /内源要求登录/);
  assert.match(r.reason, /借 Edge 登录也没查到：Edge 里还没登录内源/);
  const text = openx.userReason(r.reason, { file: '版本清单' });
  assert.ok(text.startsWith(openx.AUTH_TEXT('新版本')), text);   // 原文案保留
  assert.match(text, /请在 Edge 里登录一次内源/);
  assert.doesNotMatch(text, /连不上|确认电脑连着公司网络/);
  assert.equal(lister.calls.length, 1);
});

test('没注入登录查询（纯 Node、成员版之外的测试、内源未生效）→ 行为和以前一样', async () => {
  const r = await fetchManifest(openxFetch({ index: 'unauth' }));
  assert.equal(r.auth, true);
  assert.doesNotMatch(r.reason, /Edge/);
  assert.doesNotMatch(openx.userReason(r.reason, { file: '版本清单' }), /Edge/);
});

test('同一轮只开一次：并发的检查、预热、下载共用一次；普通 clearDown 两分钟内复用；手动检查（relogin）才真的再试', async () => {
  const lister = fakeLister({ ok: false, delayMs: 50 });
  openx.setLoginLister(lister);
  const f = openxFetch({ index: 'unauth' });
  const [a, b] = await Promise.all([fetchManifest(f), fetchManifest(f), openx.prewarm({ fetchImpl: f, env: ENV })]);
  assert.equal(a.auth, true); assert.equal(b.auth, true);
  assert.equal(lister.calls.length, 1);
  // 下载前的 clearDown（不是手动检查）：失败结果在 2 分钟内复用，不再开 Edge
  openx.clearDown();
  const miss = await openx.find({ file: 'AIHubX-5.6.141-update.gz', version: '5.6.141', fetchImpl: f, env: ENV });
  assert.equal(miss, null);
  assert.match(openx.lastReason(), /借 Edge 登录也没查到/);
  assert.equal(lister.calls.length, 1);
  // 手动检查更新：真的再试一次
  openx.clearDown({ relogin: true });
  await fetchManifest(f);
  assert.equal(lister.calls.length, 2);
});

test('两分钟后（下一轮后台检查）会再试；本机没有 Edge 这类失败一直复用到手动检查', async () => {
  let t = 1_000_000;
  const now = () => t;
  const lister = fakeLister({ ok: false });
  openx.setLoginLister(lister);
  const f = openxFetch({ index: 'unauth' });
  await fetchManifest(f, { now });
  t += openx.LOGIN_REUSE_MS + 1;
  openx.clearDown();
  await fetchManifest(f, { now });
  assert.equal(lister.calls.length, 2);

  openx._reset({ indexId: INDEX_ID, localVersion: '5.6.140' });
  const noEdge = fakeLister({ ok: false, reason: '本机没有找到 Edge 浏览器', permanent: true });
  openx.setLoginLister(noEdge);
  await fetchManifest(f, { now });
  t += 60 * 60 * 1000;
  openx.clearDown();
  const r = await fetchManifest(f, { now });
  assert.match(r.reason, /本机没有找到 Edge/);
  assert.equal(noEdge.calls.length, 1);
  openx.clearDown({ relogin: true });
  await fetchManifest(f, { now });
  assert.equal(noEdge.calls.length, 2);
});

test('后台检查只给 8 秒：走到登录这一步时预算顺延，不被截成「内源慢」', async () => {
  const lister = fakeLister({ delayMs: 250 });
  openx.setLoginLister(lister);
  const r = await fetchManifest(openxFetch({ index: 'unauth' }), { timeoutMs: 120 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(lister.calls.length, 1);
});

test('审查 P1：本机已是最新（索引最高版本 = 本机）+ 列表 401 → 不开 Edge，以索引为准；下载、回退、找完整包也不开', async () => {
  openx._reset({ indexId: INDEX_ID, localVersion: '5.6.141' });
  const lister = fakeLister();
  openx.setLoginLister(lister);
  const f = openxFetch({ index: 'ok', byIdLocked: false });
  const r = await fetchManifest(f, { currentVersion: '5.6.141' });
  assert.ok(!r.auth && (r.ok || r.older), r.reason);
  openx.clearDown();
  const hit = await openx.find({ file: 'AIHubX-5.6.141-update.gz', version: '5.6.141', fetchImpl: f, env: ENV });
  assert.ok(hit);
  openx.clearDown();
  await openx.findLatestFull({ fetchImpl: f, currentVersion: '5.6.141', env: ENV });
  openx.clearDown({ relogin: true });
  await openx.listAppReleases({ fetchImpl: f, validate: x => x, publicKey: PUB, env: ENV });
  assert.equal(lister.calls.length, 0);
});

test('索引里一个程序版本都没有（明显过期）+ 列表 401 → 借登录查；登录没成就以索引为准', async () => {
  const lister = fakeLister();
  openx.setLoginLister(lister);
  const r1 = await fetchManifest(openxFetch({ index: 'noapp', byIdLocked: false }));
  assert.equal(lister.calls.length, 1);
  assert.equal(r1.ok, true, r1.reason);

  openx._reset({ indexId: INDEX_ID, localVersion: '5.6.140' });
  const bad = fakeLister({ ok: false });
  openx.setLoginLister(bad);
  const r2 = await fetchManifest(openxFetch({ index: 'noapp', byIdLocked: false }));
  assert.equal(bad.calls.length, 1);
  assert.ok(!r2.auth, r2.reason);   // 以索引为准（索引可读），不报要求登录
});

test('审查 P2：查到了的结果 10 分钟内复用（看到新版几分钟后再点下载不再开 Edge），过了 10 分钟才再查', async () => {
  let t = 2_000_000;
  const now = () => t;
  const lister = fakeLister();
  openx.setLoginLister(lister);
  const f = openxFetch({ index: 'unauth' });
  assert.equal((await fetchManifest(f, { now })).ok, true);
  t += 5 * 60 * 1000;
  openx.clearDown();   // 下载前的 clearDown
  const hit = await openx.find({ file: 'AIHubX-5.6.141-update.gz', version: '5.6.141', fetchImpl: f, env: ENV, now });
  assert.ok(hit);
  assert.equal(lister.calls.length, 1);
  t += 6 * 60 * 1000;
  openx.clearDown();
  await fetchManifest(f, { now });
  assert.equal(lister.calls.length, 2);
});

test('审查 P2：登录预算从现在起算并留余量（前面已耗掉大半预算、登录又慢也不被截成「内源慢」）；AI_HUB_OPENX_LOGIN_MS 也算进去', async () => {
  const lister = fakeLister({ delayMs: 300 });
  openx.setLoginLister(lister);
  const base = openxFetch({ index: 'unauth' });
  const slowIndex = async url => { if (String(url).includes(`by_id?id=${INDEX_ID}`)) await new Promise(r => setTimeout(r, 100)); return base(url); };
  const r = await fetchManifest(slowIndex, { timeoutMs: 120, env: { ...ENV, AI_HUB_OPENX_LOGIN_MS: '30000' } });
  assert.equal(r.ok, true, r.reason);
});

test('审查 P2：登录列表超过 20 条时 loadList 不翻页；5 分钟冷却期内的提示不出现嵌套括号', async () => {
  const many = async args => { many.n = (many.n || 0) + 1; return { ok: true, records: Array.from({ length: 25 }, (_, i) => ({ id: 13000 + i, version: `v5.6.${141 - i}` })), details: [] }; };
  openx.setLoginLister(many);
  const calls = [];
  const f = openxFetch({ index: 'unauth', byIdLocked: false, calls });
  await openx.findLatestFull({ fetchImpl: f, currentVersion: '5.6.140', env: ENV });
  assert.equal(calls.filter(u => u.includes('by_project_id')).length, 1);   // 只有第 1 页那次（401），之后不翻页
  assert.equal(many.n, 1);

  openx._reset({ indexId: INDEX_ID, localVersion: '5.6.140' });
  openx.setLoginLister(fakeLister({ ok: false, reason: 'Edge 里还没登录内源' }));
  await fetchManifest(openxFetch({ index: 'unauth' }));
  const miss = await openx.find({ file: 'x.gz', version: '1.0.0', fetchImpl: openxFetch({ index: 'unauth' }), env: ENV });
  assert.equal(miss, null);
  assert.match(openx.lastReason(), /5 分钟内自动重试/);
  const text = openx.userReason(openx.lastReason(), { file: 'x.gz' });
  assert.match(text, /没成（Edge 里还没登录内源）/);
  assert.doesNotMatch(text, /）（|）\)）/);
});

test('不在公司网络（索引就连不上）→ 不开 Edge', async () => {
  const lister = fakeLister();
  openx.setLoginLister(lister);
  const offline = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
  const r = await fetchManifest(offline);
  assert.equal(r.offline, true);
  assert.equal(lister.calls.length, 0);
});

// —— 控制器接线 ——
function makeController(fetchImpl, extra = {}) {
  return createAppUpdateController({ app: { quit() {} }, config: {}, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r63-update-')),
    currentVersion: '5.6.140', fetchImpl, isPackaged: false, logger: { warn() {}, info() {} }, manifestPublicKey: PUB,
    env: { ...ENV, AI_HUB_UPDATE_RESOURCES: os.tmpdir(), AI_HUB_UPDATE_RECHECK_MS: '3600000' }, ...extra });
}
test('控制器：公司版注入登录查询，检查更新走第三步查到新版；手动检查每次都真的再试', async () => {
  const lister = fakeLister();
  const c = makeController(openxFetch({ index: 'unauth' }), { openxLoginLister: lister });
  const s = await c.check();
  assert.equal(s.phase, 'available', s.error);
  assert.equal(s.latest.version, '5.6.141');
  assert.equal(lister.calls.length, 1);
  c.dispose?.();
});
test('控制器：登录失败时界面文案 = 原提示 + 请在 Edge 里登录一次内源；纯 Node 不传时不开 Edge', async () => {
  const c = makeController(openxFetch({ index: 'unauth' }), { openxLoginLister: fakeLister({ ok: false }) });
  const s = await c.check();
  assert.equal(s.errorKind, 'auth');
  assert.match(s.error, /要求登录/);
  assert.match(s.error, /请在 Edge 里登录一次内源/);
  c.dispose?.();
  const c2 = makeController(openxFetch({ index: 'unauth' }));
  const s2 = await c2.check();
  assert.equal(s2.errorKind, 'auth');
  assert.doesNotMatch(s2.error, /Edge/);
  c2.dispose?.();
});
test('控制器：内源未生效（测试源）时不挂登录查询', async () => {
  const lister = fakeLister();
  createAppUpdateController({ app: { quit() {} }, config: {}, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r63-update-')),
    currentVersion: '5.6.140', fetchImpl: openxFetch(), isPackaged: false, logger: { warn() {}, info() {} },
    env: { ...ENV, AI_HUB_UPDATE_SOURCES: JSON.stringify([{ id: 'fixture', name: '本机', manifest: 'http://127.0.0.1:9/latest.json', files: 'http://127.0.0.1:9/' }]) }, openxLoginLister: lister });
  const r = await fetchManifest(openxFetch({ index: 'unauth' }));
  assert.equal(lister.calls.length, 0);
  assert.doesNotMatch(r.reason, /Edge/);
});

// —— 主进程模块 ——
test('loginListEnabled：只在 Electron 里默认开，0 关、1 开', () => {
  assert.equal(loginList.loginListEnabled({}, { node: '22' }), false);
  assert.equal(loginList.loginListEnabled({}, { electron: '41' }), true);
  assert.equal(loginList.loginListEnabled({ AI_HUB_OPENX_LOGIN_LIST: '0' }, { electron: '41' }), false);
  assert.equal(loginList.loginListEnabled({ AI_HUB_OPENX_LOGIN_LIST: '1' }, { node: '22' }), true);
});

test('createOpenxLoginLister：没有 Edge / 不是公司版不开；需要登录给短句；成功只回裁剪后的结果', async () => {
  let runs = 0;
  const run = value => async opts => { runs += 1; run.last = opts; return value; };
  const mk = (runInEdge, extra = {}) => loginList.createOpenxLoginLister({ env: ENV, logger: { info() {} }, runInEdge, findEdgeFn: () => 'edge.exe', ...extra });

  const noEdge = await loginList.createOpenxLoginLister({ env: ENV, runInEdge: run({}), findEdgeFn: () => '' })({});
  assert.deepEqual([noEdge.ok, noEdge.permanent], [false, true]);
  const off = await loginList.createOpenxLoginLister({ env: { AI_HUB_OPENX: '0' }, runInEdge: run({}), findEdgeFn: () => 'edge.exe' })({});
  assert.equal(off.ok, false);
  assert.equal(runs, 0);

  const need = await mk(run({ ok: false, needsLogin: true, error: '需要登录（停在 login）' }))({ projectId: 7 });
  assert.equal(need.reason, 'Edge 里还没登录内源');
  const notYet = await mk(run({ ok: false, error: '页面还没登录好' }))({});
  assert.match(notYet.reason, /还没登录内源/);

  const ok = await mk(run({ ok: true, value: { ok: true, records: [{ id: 1, version: 'v5.6.141' }], details: [], name: 'x' } }))({ projectId: 7, timeoutMs: 15000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.records.length, 1);
  // 打开的是内源下载页，readyUrl 只认内源自己的域名；整体有超时信号
  assert.equal(new URL(run.last.url).host, new URL(CONFIG.fileSite).host);
  assert.ok(run.last.readyUrl.test(CONFIG.fileSite));
  assert.ok(!run.last.readyUrl.test('https://evil.example/'));
  assert.ok(run.last.signal && typeof run.last.signal.aborted === 'boolean');
  assert.ok(run.last.timeoutMs <= 15000);
  assert.ok(run.last.accept({ ok: true }) && !run.last.accept({ needsLogin: true }));
});

// 页面脚本：在 vm 里配假 localStorage / fetch / document 跑。
async function runScript({ token = 'SECRET-TOKEN-123', listStatus = 'ok', total = 3 } = {}) {
  const apiPath = new URL(API).pathname;
  const seen = [];
  const records = Array.from({ length: total }, (_, i) => ({ id: 100 + i, version: i === 1 ? 'cli-x-1.0' : `v5.6.${141 - i}`, releaseTime: '2026-11-28', extra: 'drop' }));
  const ctx = {
    localStorage: { getItem: k => (k === 'token' ? token : null) }, sessionStorage: { getItem: () => null },
    document: { querySelectorAll: () => [] }, window: {}, AbortSignal, Date, Math, Number, String, Array, JSON, Promise, encodeURIComponent,
    fetch: async (url, opts) => {
      seen.push({ url, auth: opts && opts.headers && opts.headers.Authorization });
      const pg = Number((/currentPage=(\d+)/.exec(url) || [])[1] || 1);
      const body = /by_project_id/.test(url)
        ? (listStatus === 'unauth' ? { code: '401' } : { code: '0', data: { total, name: 'AI-Hub', records: records.slice((pg - 1) * 2, pg * 2) } })
        : { code: '0', data: { version: 'v5.6.141', binaryPackages: [{ id: 9, originalFileName: 'latest.json', url: 'https://x/latest.json', secretField: 'drop' }] } };
      return { status: 200, json: async () => body };
    },
  };
  ctx.window = ctx;
  const value = await vm.runInNewContext(loginList.buildLoginListScript({ apiPath, projectId: 7938, pageSize: 2 }), ctx);
  return { value, seen, apiPath };
}
test('页面脚本：带 Bearer 口令调同源列表、翻页、取程序版本详情；返回里没有口令和多余字段', async () => {
  const { value, seen, apiPath } = await runScript();
  assert.equal(value.ok, true);
  assert.equal(value.records.length, 3);
  assert.deepEqual(Object.keys(value.records[0]).sort(), ['id', 'releaseTime', 'version']);
  assert.ok(seen.every(s => s.auth === 'Bearer SECRET-TOKEN-123'));
  assert.ok(seen.every(s => s.url.startsWith(apiPath)));                       // 相对路径，同源
  assert.ok(seen.some(s => /currentPage=2/.test(s.url)));                       // 3 条、每页 2 条 → 翻到第 2 页
  assert.equal(value.details.length, 2);                                        // 只取程序版本（v5.6.x）的详情
  assert.deepEqual(Object.keys(value.details[0].binaryPackages[0]).sort(), ['id', 'originalFileName', 'tag', 'url', 'urlSource']);
  assert.doesNotMatch(JSON.stringify(value), /SECRET-TOKEN/);
});
test('页面脚本：没有口令或接口仍未认证 → needsLogin（外面过一会儿再跑一次）', async () => {
  assert.equal((await runScript({ token: '' })).value.needsLogin, true);
  assert.equal((await runScript({ listStatus: 'unauth' })).value.needsLogin, true);
});
