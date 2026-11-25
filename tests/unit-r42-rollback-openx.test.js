'use strict';
// R42（2026-11-25 用户定）：恢复「版本与回退」，只走公司内源。
// 覆盖：可回退版本只来自内源上每版附带的签名清单（没签名 / 签名不对 / 版本对不上 / 缺包 / member-* 都不列，原因说清）；
// 回退下载的包按签名清单的 sha256 核对，对不上拒装、不留固定；本版写的固定重启后不被清，R35 之前留下的固定照旧清；
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const manifestLib = require('../core/app-update/manifest.js');
const cat = require('../core/app-update/version-catalog.js');
const openxSource = require('../core/app-update/openx-source');
const { createOpenxReleaseMock } = require('./helpers/openx-release-mock');

const ROOT = path.join(__dirname, '..');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const RT = { electron: '41.2.0', native: { 'node-pty': '1.2.0-beta.13' } };
const ENV = { AI_HUB_OPENX: '1' };
const EXTERNAL = /github|aliyun|example\.invalid/i;  // 模拟内源对它之外的任何地址都直接抛错（tests/helpers/openx-release-mock.js），这里再按名字兜一道

test.beforeEach(() => openxSource._reset());

test('内源版本清单：只列签名对、版本一致、带完整更新包的程序版本；其余说明原因；member-* 与组件版本不看', async () => {
  const net = createOpenxReleaseMock({ payload: crypto.randomBytes(4096), releases: [
    { version: '5.6.110', runtime: RT },
    { version: '5.6.109', runtime: RT, sig: 'none' },
    { version: '5.6.108', runtime: RT, sig: 'bad' },
    { version: '5.6.104', runtime: RT, manifestVersion: '5.6.103' },
    { version: '5.6.103', runtime: RT, noPackage: true },
    { version: '5.6.102', runtime: RT, name: 'v5.6.102 完整安装包' },
    { version: '5.6.120', runtime: RT, member: true },
    { version: '2.1.0', runtime: RT, name: 'room-runtime-2.1.0' },
  ] });
  const r = await openxSource.listAppReleases({ fetchImpl: net.fetchImpl, validate: manifestLib.validateManifest, publicKey: net.keys.pub, env: ENV });
  assert.equal(r.ok, true);
  assert.deepEqual(r.versions.map(v => v.version), ['5.6.110', '5.6.102']);
  assert.equal(r.versions[0].incremental.file, 'AIHubHuawei-5.6.110-update.gz');
  assert.match(r.versions[0].incremental.sha256, /^[a-f0-9]{64}$/);
  const why = Object.fromEntries(r.skipped.map(s => [s.version, s.why]));
  assert.match(why['5.6.109'], /没有签名/);
  assert.match(why['5.6.108'], /签名不对/);
  assert.match(why['5.6.104'], /写的是 v5\.6\.103/);
  assert.match(why['5.6.103'], /缺完整更新包/);
  assert.equal(why['5.6.120'], undefined, 'member-* 不看');
  assert.ok(!net.requests.some(u => EXTERNAL.test(u)));
  // 已验过的版本缓存：再列一次不再重复下它们的清单（没通过的可能是发版同步到一半，下次照常重查）
  const before = net.requests.length;
  openxSource.clearDown();
  await openxSource.listAppReleases({ fetchImpl: net.fetchImpl, validate: manifestLib.validateManifest, publicKey: net.keys.pub, env: ENV });
  const okIds = net.records.filter(r => ['v5.6.110', 'v5.6.102 完整安装包'].includes(r.version)).map(r => `/${r.id}/`);
  assert.equal(okIds.length, 2);
  assert.ok(!net.requests.slice(before).some(u => okIds.some(id => u.includes(id))), '已验过的签名清单不重复下载');
});

test('内源一版有效清单都没有：ok:false，原因说「没有通过签名校验」并带上逐版原因', async () => {
  const net = createOpenxReleaseMock({ payload: crypto.randomBytes(2048), releases: [{ version: '5.6.99', runtime: RT, sig: 'none' }] });
  const r = await openxSource.listAppReleases({ fetchImpl: net.fetchImpl, validate: manifestLib.validateManifest, publicKey: net.keys.pub, env: ENV });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有通过签名校验/);
  assert.equal(r.skipped[0].version, '5.6.99');
});

function payloadFixture() {
  const { packPayload } = require('../core/app-update/payload.js');
  const res = tmp('r42-res-');
  fs.writeFileSync(path.join(res, 'app.asar'), crypto.randomBytes(4096));
  fs.mkdirSync(path.join(res, 'app.asar.unpacked'), { recursive: true });
  const gzPath = path.join(tmp('r42-gz-'), 'p.gz'); packPayload(res, gzPath);
  return { res, gz: fs.readFileSync(gzPath) };
}
function makeController({ net, dataDir, res, currentVersion = '5.6.110' }) {
  manifestLib.currentRuntime = () => RT;
  delete require.cache[require.resolve('../main/app-update-controller.js')];
  const { createAppUpdateController } = require('../main/app-update-controller.js');
  return createAppUpdateController({ app: { quit() {}, relaunch() {} }, config: {}, dataDir, currentVersion, fetchImpl: net.fetchImpl, manifestPublicKey: net.keys.pub,
    env: { ...ENV, AI_HUB_UPDATE_RESOURCES: res, AI_HUB_UPDATE_FORCE_APPLY: '1', AI_HUB_UPDATE_PROGRESS_UI: '0' }, isPackaged: false, logger: { warn() {}, info() {} } });
}

test('回退包校验失败：内源给的字节和签名清单的 sha256 对不上就拒装，不暂存、不留固定', async () => {
  const { res, gz } = payloadFixture();
  const tampered = Buffer.from(gz); tampered[tampered.length - 1] ^= 0xff;
  const net = createOpenxReleaseMock({ payload: gz, releases: [{ version: '5.6.110', runtime: RT }, { version: '5.6.104', runtime: RT, payload: tampered }] });
  const dataDir = tmp('r42-bad-');
  const c = makeController({ net, dataDir, res });
  assert.equal((await c.listVersions()).ok, true);
  const after = await c.rollbackTo('5.6.104');
  assert.equal(after.phase, 'error');
  assert.match(after.error, /校验/);
  assert.doesNotMatch(after.error, /阿里云|GitHub|镜像|发布页/);
  assert.equal(cat.readPin(dataDir), null, '没换上就不留固定');
  assert.equal(c.getState().pinned, null);
  assert.equal(c.applyOnQuit(), false, '没有暂存的包');
  assert.ok(!net.requests.some(u => EXTERNAL.test(u)));
  c.dispose();
});

test('固定版本：本版写的固定（回退后或「跟随最新版」关掉）重启后保留；R35 之前留下的固定照旧清掉', () => {
  const { res } = payloadFixture();
  const net = createOpenxReleaseMock({ payload: Buffer.alloc(2048), releases: [{ version: '5.6.110', runtime: RT }] });
  const dataDir = tmp('r42-pin-');
  const c = makeController({ net, dataDir, res });
  c.pinCurrent();
  c.dispose();
  const c2 = makeController({ net, dataDir, res });
  assert.equal(c2.getState().pinned.version, '5.6.110', '新固定的版本重启后还在');
  assert.equal(cat.readPin(dataDir).channel, 'openx');
  c2.dispose();
  // R35 之前外网时代的固定：不带 channel
  fs.writeFileSync(path.join(dataDir, 'app-update', 'pinned-version.json'), JSON.stringify({ version: '5.6.110', manual: true }));
  const c3 = makeController({ net, dataDir, res });
  assert.equal(c3.getState().pinned, null);
  assert.equal(fs.existsSync(path.join(dataDir, 'app-update', 'pinned-version.json')), false);
  c3.dispose();
});

test('回退到 v5.6.105–107：确认框如实说明它会自动升回最新版（固定文件写下但标记不支持）', async () => {
  const { res, gz } = payloadFixture();
  const net = createOpenxReleaseMock({ payload: gz, releases: [{ version: '5.6.110', runtime: RT }, { version: '5.6.106', runtime: RT }] });
  const dataDir = tmp('r42-106-');
  const c = makeController({ net, dataDir, res });
  const listed = await c.listVersions();
  assert.equal(listed.items.find(i => i.version === '5.6.106').supportsPin, false);
  assert.equal((await c.rollbackTo('5.6.106')).phase, 'ready');
  assert.equal(cat.readPin(dataDir).supportsPin, false);
  c.dispose();
  const ui = fs.readFileSync(path.join(ROOT, 'renderer/version-picker.js'), 'utf8');
  assert.match(ui, /这一版不认识「固定版本」：打开后会照常在后台自动更新回最新版/);
});

test('内源关闭（排查开关 AI_HUB_OPENX=0）：版本列表一行说明，不去任何别处取', async () => {
  manifestLib.currentRuntime = () => RT;
  delete require.cache[require.resolve('../main/app-update-controller.js')];
  const { createAppUpdateController } = require('../main/app-update-controller.js');
  const requests = [];
  const c = createAppUpdateController({ app: {}, config: { sources: [{ id: 'a', name: '源A', manifest: 'https://example.invalid/m/latest.json', files: 'https://example.invalid/m/v{version}/' }] },
    dataDir: tmp('r42-off-'), currentVersion: '5.6.110', fetchImpl: async url => { requests.push(String(url)); throw new Error('不应联网'); },
    env: { AI_HUB_OPENX: '0' }, isPackaged: false, logger: { warn() {}, info() {} } });
  const r = await c.listVersions();
  assert.equal(r.ok, false);
  assert.match(r.error, /只从公司内源取旧版本/);
  assert.deepEqual(requests, []);
  c.dispose();
});

test('界面（R42）：版本与回退页不提镜像 / 阿里云 / GitHub / versions.json；入口、帮助手册与功能索引都在', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'renderer/version-picker.js'), 'utf8');
  assert.doesNotMatch(ui, /镜像|阿里云|GitHub|github\.com|versions\.json|抢先版|previewEnabled/);
  assert.match(ui, /options-versions/);
  assert.match(ui, /data-vp-error/, '内源拿不到清单时一行原因 + 重试');
  const ctrl = fs.readFileSync(path.join(ROOT, 'main/app-update-controller.js'), 'utf8');
  assert.doesNotMatch(ctrl, /versionsUrl|versions\.json/);
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'core/help-ask/feature-index.json'), 'utf8'));
  assert.ok((index.items || index).some(i => i.name === '版本与回退' && JSON.stringify(i.steps).includes('#options-versions')));
  // 公开版发布树里没有成员版手册，只核对存在的那份（公开版手册两边都有）。
  for (const f of ['core/help-ask/manual-member.md', 'core/help-ask/manual-public.md']) {
    const file = path.join(ROOT, f);
    if (f.endsWith('member.md') && !fs.existsSync(file)) continue;
    assert.match(fs.readFileSync(file, 'utf8'), /🕘 版本与回退/);
  }
});

// ---------- R42 审查（Antigravity）4 项与「取消回退」 ----------
test('审查 P1-1：固定后与回退包不当作「有新版本」——红点、底栏已就绪一行都排除 pinned 与 latest.rollback', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/app-update.js'), 'utf8');
  const pending = src.slice(src.indexOf('function pendingVersion()'), src.indexOf('function pendingVersion()') + 400);
  assert.match(pending, /!state\.pinned/); assert.match(pending, /!state\.latest\.rollback/);
  const ready = src.slice(src.indexOf('function renderReadyLine()'), src.indexOf('function renderReadyLine()') + 400);
  assert.match(ready, /!state\.pinned/); assert.match(ready, /!state\.latest\.rollback/);
  const pill = src.slice(src.indexOf('function renderPill()'), src.indexOf('function renderPill()') + 600);
  assert.match(pill, /!state\.latest\.rollback/);
});

test('审查 P1-2：回退失败后界面状态清干净（latest / plan / rollback 都没了，保留原因）', async () => {
  const { res, gz } = payloadFixture();
  const tampered = Buffer.from(gz); tampered[0] ^= 0xff;
  const net = createOpenxReleaseMock({ payload: gz, releases: [{ version: '5.6.110', runtime: RT }, { version: '5.6.104', runtime: RT, payload: tampered }] });
  const c = makeController({ net, dataDir: tmp('r42-p12-'), res });
  await c.listVersions();
  const after = await c.rollbackTo('5.6.104');
  assert.equal(after.phase, 'error');
  assert.ok(after.error);
  for (const k of ['latest', 'plan', 'rollback', 'pinned']) assert.equal(after[k], null, k);
  c.dispose();
});

test('审查 P1-2：固定版本时，即使允许静默也不在后台下载新版', async () => {
  const { res, gz } = payloadFixture();
  const net = createOpenxReleaseMock({ payload: gz, releases: [{ version: '5.6.110', runtime: RT }] });
  manifestLib.currentRuntime = () => RT;
  delete require.cache[require.resolve('../main/app-update-controller.js')];
  const { createAppUpdateController } = require('../main/app-update-controller.js');
  const c = createAppUpdateController({ app: { quit() {} }, config: {}, dataDir: tmp('r42-quiet-'), currentVersion: '5.6.109', fetchImpl: net.fetchImpl, manifestPublicKey: net.keys.pub,
    quietDelivery: true, isPackaged: true, resourcesPath: res, env: { ...ENV, AI_HUB_UPDATE_RESOURCES: res, AI_HUB_UPDATE_PROGRESS_UI: '0' }, logger: { warn() {}, info() {} } });
  c.pinCurrent();
  await c.check({ silent: false, quietAllowed: true });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(c.getState().phase, 'available');
  assert.ok(!net.requests.some(u => u.endsWith('-update.gz')), '没有静默下载');
  c.dispose();
});

test('取消回退：回退包已下好待重启时点「取消回退」，丢掉暂存包、清掉固定，退出时不替换', async () => {
  const { res, gz } = payloadFixture();
  const net = createOpenxReleaseMock({ payload: gz, releases: [{ version: '5.6.110', runtime: RT }, { version: '5.6.104', runtime: RT }] });
  const dataDir = tmp('r42-cancel-');
  const c = makeController({ net, dataDir, res });
  await c.listVersions();
  assert.equal((await c.rollbackTo('5.6.104')).phase, 'ready');
  const back = await c.returnToLatest();
  assert.equal(back.pinned, null);
  assert.equal(cat.readPin(dataDir), null);
  assert.notEqual(back.phase, 'ready', '当前已是最新，没有要装的包');
  assert.ok(!back.latest || !back.latest.rollback);
  assert.equal(c.applyOnQuit(), false);
  assert.match(fs.readFileSync(path.join(ROOT, 'renderer/version-picker.js'), 'utf8'), /data-vp="latest"[^>]*>取消回退/);
  c.dispose();
});

test('审查 P2-3：预算到点时最后一版被中断，说「没读完」而不是「没有通过签名校验」；签名类原因给对提示', async () => {
  const net = createOpenxReleaseMock({ payload: crypto.randomBytes(2048), releases: [{ version: '5.6.110', runtime: RT }] });
  const slow = async (url, opts = {}) => {
    if (String(url).includes('by_id')) await new Promise((resolve, reject) => { const t = setTimeout(resolve, 800); opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }); });
    return net.fetchImpl(url, opts);
  };
  const r = await openxSource.listAppReleases({ fetchImpl: slow, validate: manifestLib.validateManifest, publicKey: net.keys.pub, env: ENV, timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /秒内没读完/);
  assert.match(openxSource.userReason('内源上的版本都没有通过签名校验的清单'), /还在同步签名或没通过校验/);
  assert.match(openxSource.userReason('内源上还没有程序版本'), /暂时没有/);
});

test('审查 P2-4：没通过的版本不缓存附件列表，补传签名后再列一次就能列出', async () => {
  const net = createOpenxReleaseMock({ payload: crypto.randomBytes(2048), releases: [{ version: '5.6.110', runtime: RT, sig: 'none' }] });
  const list = () => openxSource.listAppReleases({ fetchImpl: net.fetchImpl, validate: manifestLib.validateManifest, publicKey: net.keys.pub, env: ENV });
  assert.equal((await list()).ok, false);
  // 发版同步补传了签名
  const full = createOpenxReleaseMock({ payload: crypto.randomBytes(2048), releases: [{ version: '5.6.110', runtime: RT }], keys: net.keys });
  net.records[0].files['latest.json.sig'] = full.records[0].files['latest.json.sig'];
  net.records[0].files['latest.json'] = full.records[0].files['latest.json'];
  net.records[0].files['AIHubHuawei-5.6.110-update.gz'] = full.records[0].files['AIHubHuawei-5.6.110-update.gz'];
  openxSource.clearDown();
  const r = await list();
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.versions.map(v => v.version), ['5.6.110']);
});
