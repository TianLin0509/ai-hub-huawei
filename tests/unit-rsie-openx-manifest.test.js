'use strict';
// rsi-e（2026-11-20 群里同事反馈）：公司网络拦了阿里云、又没有外网权限时，GitHub 和阿里云的版本清单都读不到，
// 「检查更新」永远报错、一直停在旧版。外网清单全部失败时改从公司内源读同一份 latest.json；外网能读到时不碰内源清单。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const manifestLib = require('../core/app-update/manifest.js');
manifestLib.currentRuntime = () => ({ electron: '41.2.0', native: { 'node-pty': '1.2.0-beta.13' } });
const openxSource = require('../core/app-update/openx-source.js');
const { createAppUpdateController } = require('../main/app-update-controller.js');

const crypto = require('node:crypto');
const signing = require('../core/app-update/manifest-signing.js');
const API = openxSource.DEFAULT_API;
// 测试密钥（每次现生成）：控制器经 manifestPublicKey 换成它；正式运行用内置公钥，私钥只在发版机。
const TEST_KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_PUB = TEST_KEYS.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const TEST_PEM = TEST_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });
const OTHER_PEM = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
// 附件地址必须在内源站点域名下（openx-config.js 的 fileSite），这里直接取配置，不在测试里写域名。
const FILE_HOST = new URL('files/', require('../core/app-update/openx-config').fileSite).href;
const manifest = version => ({ schema: 1, product: 'x', version, notes: [], runtime: { electron: '41.2.0', native: { 'node-pty': '1.2.0-beta.13' } },
  incremental: { file: `AIHubX-${version}-update.gz`, bytes: 14000, sha256: 'a'.repeat(64) },
  installer: { file: `AIHubX-Setup-${version}.exe`, bytes: 50000, sha256: 'b'.repeat(64) } });
const SOURCES = [{ id: 'aliyun-fast', name: '阿里云高速', manifest: 'https://dl.example.invalid/latest.json', files: 'https://dl.example.invalid/v{version}/' },
  { id: 'aliyun', name: '阿里云', manifest: 'https://me.example.invalid/latest.json', files: 'https://me.example.invalid/v{version}/' }];
const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const blocked = () => new Response('<html>确认页</html>', { status: 403, headers: { 'content-type': 'text/html' } });

// 内源：v<top>（带 latest.json 与签名）、member-v5.6.81（成员版专用，不看）、v5.6.79（老版本）。
// sign：'ok' 测试私钥签 / 'none' 不带 .sig / 'other' 别的私钥签 / 'garbage' 乱码；latestUrl 可换成别的地址；latestRes 可换成跳转等响应。
function openxFetch({ top = '5.6.80', releaseManifest = manifest(top), withLatest = true, sign = 'ok', latestUrl, latestRes } = {}) {
  const raw = JSON.stringify(releaseManifest, null, 2) + '\n';
  const sigText = sign === 'ok' ? signing.signManifest(raw, TEST_PEM) : sign === 'other' ? signing.signManifest(raw, OTHER_PEM) : 'AAAA';
  const lu = latestUrl || FILE_HOST + `v${top}-latest.json`;
  const su = FILE_HOST + `v${top}-latest.json.sig`;
  return url => {
    if (url.startsWith(API + 'by_project_id')) return json({ code: '0', data: { records: [
      { id: 3, version: 'member-v5.6.81', releaseTime: '2026-11-21 10:00:00' },
      { id: 2, version: `v${top}`, releaseTime: '2026-11-21 09:00:00' },
      { id: 1, version: 'v5.6.79', releaseTime: '2026-11-20 09:00:00' }] } });
    if (url.startsWith(API + 'by_id?id=3')) return json({ code: '0', data: { binaryPackages: [{ originalFileName: 'latest.json', url: FILE_HOST + 'member-latest.json' }] } });
    if (url.startsWith(API + 'by_id?id=2')) return json({ code: '0', data: { binaryPackages: [
      ...(withLatest ? [{ originalFileName: 'latest.json', url: lu }] : []),
      ...(withLatest && sign !== 'none' ? [{ originalFileName: 'latest.json.sig', url: su }] : []),
      { originalFileName: `AIHubX-${top}-update.gz`, url: FILE_HOST + `AIHubX-${top}-update.gz` }] } });
    if (url.startsWith(API + 'by_id?id=1')) return json({ code: '0', data: { binaryPackages: [] } });
    if (url === lu) return latestRes ? latestRes() : new Response(raw, { status: 200 });
    if (url === su) return new Response(sigText, { status: 200 });
    if (url === FILE_HOST + 'member-latest.json') throw new Error('不应读成员版专用版本的清单');
    return null;
  };
}

function make(fetchImpl, env = {}) {
  return createAppUpdateController({ app: { quit() {} }, config: { sources: SOURCES, releasePage: '' }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rsie-openx-')),
    currentVersion: '5.6.72', fetchImpl, isPackaged: false, logger: { warn() {} }, manifestPublicKey: TEST_PUB,
    env: { AI_HUB_OPENX: '1', AI_HUB_OPENX_ONLY: '0', AI_HUB_UPDATE_RESOURCES: os.tmpdir(), AI_HUB_UPDATE_FORCE_APPLY: '1', ...env } });
}

test.beforeEach(() => openxSource._reset());

test('阿里云全被拦：从内源读到 v5.6.80 的版本清单，检查更新显示有新版而不是报错', async () => {
  const ox = openxFetch(); const urls = [];
  const c = make(async url => { url = String(url); urls.push(url); return ox(url) || blocked(); });
  await c.check({ silent: false, quietAllowed: false });
  const s = c.getState();
  assert.equal(s.phase, 'available', s.error || '');
  assert.equal(s.latest.version, '5.6.80');
  assert.equal(s.latest.sourceName, '公司内源 · 版本清单');
  assert.ok(s.checks.some(r => r.id === 'openx-manifest' && r.ok), '检查结果里列出内源版本清单这一行');
  assert.ok(!urls.includes(FILE_HOST + 'member-latest.json'), '成员版专用版本不看');
});

test('外网清单能读到：完全不去内源取版本清单（行为和以前一样）', async () => {
  const ox = openxFetch(); const urls = [];
  const c = make(async url => { url = String(url); urls.push(url); if (url.endsWith('example.invalid/latest.json')) return json(manifest('5.6.80')); return ox(url) || blocked(); });
  await c.check({ silent: false, quietAllowed: false });
  assert.equal(c.getState().latest.version, '5.6.80');
  assert.ok(!urls.some(u => u.startsWith(FILE_HOST) && u.endsWith('latest.json')), '没有读内源的 latest.json');
  assert.ok(!c.getState().checks.some(r => r.id === 'openx-manifest'));
});

test('内源附带的清单版本号和版本名对不上：不采用，照旧提示更新源都连不上', async () => {
  const ox = openxFetch({ releaseManifest: manifest('5.6.99') });
  const c = make(async url => ox(String(url)) || blocked());
  await c.check({ silent: false, quietAllowed: false });
  const s = c.getState();
  assert.equal(s.phase, 'error');
  assert.match(s.checks.find(r => r.id === 'openx-manifest').reason, /不采用/);
});

test('内源还没附带清单（发版脚本没传）：行为和以前一样报「所有更新源都连不上」', async () => {
  const ox = openxFetch({ withLatest: false });
  const c = make(async url => ox(String(url)) || blocked());
  await c.check({ silent: false, quietAllowed: false });
  assert.equal(c.getState().phase, 'error');
  assert.match(c.getState().error, /所有更新源都连不上/);
});

test('内源清单兜底后点下载：更新包先从内源取（外网被拦也能下）', async () => {
  const ox = openxFetch(); const urls = [];
  const c = make(async url => { url = String(url); urls.push(url); return ox(url) || blocked(); });
  await c.check({ silent: false, quietAllowed: false });
  // 下载器按进程环境判断内源开关（Electron 里默认开）；纯 Node 单测里显式打开。
  const prev = process.env.AI_HUB_OPENX; process.env.AI_HUB_OPENX = '1'; const prevOnly = process.env.AI_HUB_OPENX_ONLY; process.env.AI_HUB_OPENX_ONLY = '0';
  try { await c.download(); } finally { if (prevOnly === undefined) delete process.env.AI_HUB_OPENX_ONLY; else process.env.AI_HUB_OPENX_ONLY = prevOnly; if (prev === undefined) delete process.env.AI_HUB_OPENX; else process.env.AI_HUB_OPENX = prev; }
  assert.ok(urls.includes(FILE_HOST + 'AIHubX-5.6.80-update.gz'), '向内源请求了更新包');
});

test('环境体检（probeSources）同样列出内源版本清单', async () => {
  const ox = openxFetch();
  const c = make(async url => ox(String(url)) || blocked());
  const r = await c.probeSources({ timeoutMs: 5000 });
  assert.ok(r.sources.some(x => x.id === 'openx-manifest' && x.ok && x.version === '5.6.80'));
});

// ---- rsi-e 返工（2026-11-21）：内源清单必须验签、不回退、不乱跳主版本、总时长有界 ----
const blockedWith = ox => async url => ox(String(url)) || blocked();
async function checkState(ox) {
  const c = make(blockedWith(ox));
  await c.check({ silent: false, quietAllowed: false });
  const s = c.getState();
  return { s, row: (s.checks || []).find(r => r.id === 'openx-manifest') };
}

test('内源清单没有签名：不采用，照旧报「所有更新源都连不上」，原因写清', async () => {
  const { s, row } = await checkState(openxFetch({ sign: 'none' }));
  assert.equal(s.phase, 'error');
  assert.match(row.reason, /没有签名/);
});

test('内源清单签名用别的私钥签 / 签名是乱码：不采用', async () => {
  for (const sign of ['other', 'garbage']) {
    openxSource._reset();
    const { s, row } = await checkState(openxFetch({ sign }));
    assert.equal(s.phase, 'error', sign);
    assert.match(row.reason, /签名不对/, sign);
  }
});

test('恶意高版本：内源上传 v99.0.0 + 自制清单（无有效签名），不升也不下载', async () => {
  const ox = openxFetch({ top: '99.0.0', sign: 'other' }); const urls = [];
  const c = make(async url => { url = String(url); urls.push(url); return ox(url) || blocked(); });
  await c.check({ silent: false, quietAllowed: false });
  assert.equal(c.getState().phase, 'error');
  assert.ok(!urls.some(u => u.includes('AIHubX-99.0.0')), '没有去拿恶意包');
});

test('签名有效但主版本跳太多（5.6.72 → 99.0.0）：不采用', async () => {
  const { s, row } = await checkState(openxFetch({ top: '99.0.0' }));
  assert.equal(s.phase, 'error');
  assert.match(row.reason, /主版本跳得太多/);
});

test('签名有效但主版本只大 1（5.6.72 → 6.0.0）：采用', async () => {
  const { s } = await checkState(openxFetch({ top: '6.0.0' }));
  assert.equal(s.phase, 'available', s.error || '');
  assert.equal(s.latest.version, '6.0.0');
});

test('内源清单比当前版本旧（签名有效）：不采用，不会回退', async () => {
  const { s, row } = await checkState(openxFetch({ top: '5.6.70' }));
  assert.equal(s.phase, 'error');
  assert.match(row.reason, /比当前 v5.6.72 还旧/);
});

test('清单附件地址不在内源域名白名单：当作没有清单', async () => {
  const { s, row } = await checkState(openxFetch({ latestUrl: 'https://evil.example.invalid/latest.json' }));
  assert.equal(s.phase, 'error');
  assert.match(row.reason, /还没有附带版本清单/);
});

test('清单地址返回跳转：不跟随、不采用', async () => {
  const { s, row } = await checkState(openxFetch({ latestRes: () => new Response('', { status: 302, headers: { location: 'https://evil.example.invalid/x' } }) }));
  assert.equal(s.phase, 'error');
  assert.match(row.reason, /跳转/);
});

test('清单签名对但内容不合规（缺运行时信息）：不采用', async () => {
  const bad = manifest('5.6.80'); delete bad.runtime;
  const { s, row } = await checkState(openxFetch({ releaseManifest: bad }));
  assert.equal(s.phase, 'error');
  assert.match(row.reason, /运行时信息/);
});

// 永远不回的请求：只在被中断时失败（模拟半开连接）。
const hang = (counter) => (url, opts = {}) => new Promise((_, reject) => {
  if (counter) counter.n += 1;
  const sig = opts.signal;
  if (sig) { if (sig.aborted) reject(new Error('aborted')); else sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }
});

test('总预算：内源列表半开不回，fetchManifest 按预算返回，不挂死', async () => {
  const t0 = Date.now();
  const r = await openxSource.fetchManifest({ fetchImpl: hang(), validate: x => x, env: { AI_HUB_OPENX: '1', AI_HUB_OPENX_ONLY: '0' }, currentVersion: '5.6.72', publicKey: TEST_PUB, timeoutMs: 400 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 1500, `用了 ${Date.now() - t0} ms`);
});

test('总预算：列表很快、清单下载半开不回，也按预算返回；传更大的预算也封顶 8 秒', async () => {
  const ox = openxFetch();
  const f = (url, opts) => url.endsWith('-latest.json') ? hang()(url, opts) : ox(url);
  const t0 = Date.now();
  const r = await openxSource.fetchManifest({ fetchImpl: f, validate: x => x, env: { AI_HUB_OPENX: '1', AI_HUB_OPENX_ONLY: '0' }, currentVersion: '5.6.72', publicKey: TEST_PUB, timeoutMs: 400 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /秒内没读完/);
  assert.ok(Date.now() - t0 < 1500);
  assert.ok(openxSource.MANIFEST_BUDGET_MS <= 8000);
});

test('内源刚连不上（5 分钟内）：直接跳过，不再发请求、不拖慢检查', async () => {
  const bad = async () => { throw new Error('ECONNREFUSED'); };
  await openxSource.fetchManifest({ fetchImpl: bad, validate: x => x, env: { AI_HUB_OPENX: '1', AI_HUB_OPENX_ONLY: '0' }, publicKey: TEST_PUB });
  assert.equal(openxSource.reachability(), 'down');
  const counter = { n: 0 };
  const t0 = Date.now();
  const r = await openxSource.fetchManifest({ fetchImpl: hang(counter), validate: x => x, env: { AI_HUB_OPENX: '1', AI_HUB_OPENX_ONLY: '0' }, publicKey: TEST_PUB });
  assert.equal(r.ok, false);
  assert.equal(counter.n, 0, '没有再发请求');
  assert.ok(Date.now() - t0 < 100);
});

test('环境体检：内源半开不回时，体检总时长不超出给定预算太多', async () => {
  const c = make(async (url, opts) => { url = String(url); return url.startsWith(API) ? hang()(url, opts) : blocked(); });
  const t0 = Date.now();
  await c.probeSources({ timeoutMs: 800 });
  assert.ok(Date.now() - t0 < 2500, `体检用了 ${Date.now() - t0} ms`);
});

test('取消检查：外部 signal 中断后 fetchManifest 立即返回「已取消」', async () => {
  const ac = new AbortController();
  const p = openxSource.fetchManifest({ fetchImpl: hang(), validate: x => x, env: { AI_HUB_OPENX: '1', AI_HUB_OPENX_ONLY: '0' }, publicKey: TEST_PUB, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.reason, '已取消');
  assert.ok(Date.now() - t0 < 1000);
});

test('签名工具：内置公钥能解析；同一私钥签的能验过，改一个字节就验不过', () => {
  const raw = Buffer.from('{"version":"5.6.80"}\n');
  const sig = signing.signManifest(raw, TEST_PEM);
  assert.equal(signing.verifyManifest(raw, sig, TEST_PUB), true);
  assert.equal(signing.verifyManifest(Buffer.from('{"version":"5.6.81"}\n'), sig, TEST_PUB), false);
  assert.equal(signing.verifyManifest(raw, sig), false, '内置公钥不认测试私钥');
  assert.doesNotThrow(() => crypto.createPublicKey({ key: Buffer.from(signing.PUBLIC_KEY_B64, 'base64'), format: 'der', type: 'spki' }));
});

test('发版签名：私钥不存在只跳过并警告、不抛错、不留旧 .sig；有私钥但和内置公钥不配对也不写 .sig', () => {
  const { signFile } = require('../scripts/sign-manifest.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsie-sign-'));
  const file = path.join(dir, 'latest.json');
  fs.writeFileSync(file, JSON.stringify(manifest('5.6.80')));
  fs.writeFileSync(file + '.sig', 'old');
  const warns = [];
  const r1 = signFile(file, { env: { AI_HUB_MANIFEST_SIGNING_KEY: path.join(dir, 'nope.key') }, log: { warn: m => warns.push(m) } });
  assert.equal(r1.signed, false);
  assert.ok(!fs.existsSync(file + '.sig'), '旧签名已删');
  assert.match(warns[0], /跳过签名/);
  fs.writeFileSync(path.join(dir, 'test.key'), TEST_PEM);
  const r2 = signFile(file, { env: { AI_HUB_MANIFEST_SIGNING_KEY: path.join(dir, 'test.key') }, log: { warn: m => warns.push(m) } });
  assert.equal(r2.signed, false);
  assert.match(r2.reason, /不配对/);
  assert.ok(!fs.existsSync(file + '.sig'));
});
