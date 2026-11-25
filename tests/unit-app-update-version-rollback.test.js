'use strict';
// 版本选择与回退（2026-11-16；R42 2026-11-25 恢复、只走公司内源）：降级计划、运行时不一致被过滤、固定版本下不自动更新、
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

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const RT = { electron: '41.2.0', native: { 'node-pty': '1.2.0-beta.13' } };
const H = c => c.repeat(64);
const entry = (version, runtime = RT, extra = {}) => ({ version, publishedAt: '2026-11-1' + version.slice(-1) + 'T00:00:00Z', runtime,
  incremental: { file: `AIHubHuawei-${version}-update.gz`, bytes: 15000000, sha256: H('a') }, notes: [], ...extra });
const EXTERNAL = /github|aliyun|example\.invalid/i;  // 模拟内源对它之外的任何地址都直接抛错（tests/helpers/openx-release-mock.js），这里再按名字兜一道

test.beforeEach(() => openxSource._reset());

test('降级计划：只在 allowDowngrade 时放行，走完整更新包；运行时不同拒绝', () => {
  const m = cat.targetManifest(entry('5.6.30'));
  assert.equal(manifestLib.planUpdate(m, { version: '5.6.33', runtime: RT }).kind, 'none');
  const p = manifestLib.planUpdate(m, { version: '5.6.33', runtime: RT, allowDowngrade: true });
  assert.equal(p.kind, 'incremental'); assert.equal(p.downgrade, true);
  const bad = manifestLib.planUpdate(cat.targetManifest(entry('5.6.30', { electron: '40.0.0', native: {} })), { version: '5.6.33', runtime: RT, allowDowngrade: true });
  assert.equal(bad.kind, 'none'); assert.match(bad.reason, /运行时/);
  // 升级照旧
  assert.equal(manifestLib.planUpdate(cat.targetManifest(entry('5.6.34')), { version: '5.6.33', runtime: RT, allowDowngrade: true }).kind, 'incremental');
});

test('版本列表：按版本倒序；运行时不一致的过滤；之后修了什么来自更新日志；认不认识固定按版本判断', () => {
  const versions = [entry('5.6.110'), entry('5.6.106'), entry('5.6.104'), entry('5.6.90', { electron: '41.2.0', native: { 'node-pty': '1.1.0' } }), entry('5.6.30')];
  const history = [{ version: '5.6.110', notes: ['n110'] }, { version: '5.6.108', notes: ['n108'] }, { version: '5.6.106', notes: ['n106'] }, { version: '5.6.105', notes: ['n105'] }];
  const c = cat.buildCatalog(versions, { current: '5.6.110', runtime: RT, history });
  assert.deepEqual(c.items.map(i => i.version), ['5.6.110', '5.6.106', '5.6.104', '5.6.30']);
  assert.deepEqual(c.hidden.map(h => h.version), ['5.6.90']);
  const v104 = c.items.find(i => i.version === '5.6.104');
  assert.deepEqual(v104.laterFixes.map(x => x.version), ['5.6.110', '5.6.108', '5.6.106', '5.6.105']);
  assert.ok(c.items[0].current && c.items[0].latest);
  // v5.6.35–v5.6.104 认识固定；v5.6.105–v5.6.107（R35）启动时会删固定；R42 起又认识
  assert.equal(c.items.find(i => i.version === '5.6.104').supportsPin, true);
  assert.equal(c.items.find(i => i.version === '5.6.106').supportsPin, false);
  assert.equal(c.items.find(i => i.version === '5.6.30').supportsPin, false);
  assert.equal(cat.supportsPin('5.6.108'), true);
});

test('固定版本：回退换上后生效；回退没换上清掉并报告；用户另装别的版本也清掉', () => {
  const dir = tmp('pin-');
  cat.writePin(dir, { version: '5.6.30', pending: true });
  let r = cat.settlePin(dir, '5.6.30');
  assert.equal(r.pin.version, '5.6.30'); assert.equal(r.pin.pending, undefined); assert.equal(r.failed, null);
  cat.writePin(dir, { version: '5.6.30', pending: true });
  r = cat.settlePin(dir, '5.6.33', { ok: false, version: '5.6.30' });
  assert.equal(r.pin, null); assert.equal(r.failed.version, '5.6.30'); assert.equal(cat.readPin(dir), null);
  // 回退到不认识固定状态的老版本、之后又升回新版：静默清掉，不误报失败
  cat.writePin(dir, { version: '5.6.30', pending: true });
  r = cat.settlePin(dir, '5.6.34', null);
  assert.equal(r.pin, null); assert.equal(r.failed, null); assert.equal(cat.readPin(dir), null);
  cat.writePin(dir, { version: '5.6.30' });
  assert.equal(cat.settlePin(dir, '5.6.31').pin, null);
});

test('备份与还原：只备份小文件，跳过备份目录；登记后下次启动还原', () => {
  const dir = tmp('bk-');
  fs.writeFileSync(path.join(dir, 'config.json'), '{"a":1}');
  fs.mkdirSync(path.join(dir, 'assistant')); fs.writeFileSync(path.join(dir, 'assistant', 'assistant.sqlite'), 'DB1');
  fs.mkdirSync(path.join(dir, 'logs')); fs.writeFileSync(path.join(dir, 'logs', 'x.txt'), 'log');
  fs.writeFileSync(path.join(dir, 'big.bin'), 'x');
  const b = cat.backupForRollback(dir, { from: '5.6.33', to: '5.6.30', now: new Date(2026, 10, 16, 10, 0, 0) });
  assert.equal(b.files, 2);
  assert.match(path.basename(b.dir), /^rollback-20261116-100000$/);
  fs.writeFileSync(path.join(dir, 'config.json'), '{"a":2}');
  fs.writeFileSync(path.join(dir, 'assistant', 'assistant.sqlite'), 'DB2');
  assert.equal(cat.listBackups(dir).length, 1);
  cat.scheduleRestore(dir, b.dir);
  const res = cat.applyPendingRestore(dir);
  assert.equal(res.ok, true); assert.equal(res.restored, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"a":1}');
  assert.equal(fs.readFileSync(path.join(dir, 'assistant', 'assistant.sqlite'), 'utf8'), 'DB1');
  assert.equal(cat.applyPendingRestore(dir), null, '还原只做一次');
  assert.throws(() => cat.scheduleRestore(dir, os.tmpdir()), /找不到/);
  // 第二次备份不会把 backups 目录套进去
  const b2 = cat.backupForRollback(dir, { from: '5.6.30', to: '5.6.29', now: new Date(2026, 10, 16, 11, 0, 0) });
  assert.equal(b2.files, 2);
});

// —— 控制器：内源上的签名清单 → 回退 → 固定 → 回到最新版 ——
function payloadFixture() {
  const { packPayload } = require('../core/app-update/payload.js');
  const res = tmp('vr-res-');
  fs.writeFileSync(path.join(res, 'app.asar'), crypto.randomBytes(4096));
  fs.mkdirSync(path.join(res, 'app.asar.unpacked'), { recursive: true });
  const gzPath = path.join(tmp('vr-gz-'), 'p.gz'); packPayload(res, gzPath);
  return { res, gz: fs.readFileSync(gzPath) };
}
function loadController() {
  manifestLib.currentRuntime = () => RT;
  delete require.cache[require.resolve('../main/app-update-controller.js')];
  return require('../main/app-update-controller.js').createAppUpdateController;
}

test('控制器：版本列表只读内源签名清单；回退从内源下完整包并核对；固定版本下后台不查；回到最新版恢复', async () => {
  const createAppUpdateController = loadController();
  const { res, gz } = payloadFixture();
  const net = createOpenxReleaseMock({ payload: gz, releases: [{ version: '5.6.110', runtime: RT }, { version: '5.6.104', runtime: RT }] });
  const dataDir = tmp('vr-data-');
  fs.writeFileSync(path.join(dataDir, 'hub-config.json'), '{}');
  const env = { AI_HUB_OPENX: '1', AI_HUB_UPDATE_RESOURCES: res, AI_HUB_UPDATE_FORCE_APPLY: '1', AI_HUB_UPDATE_PROGRESS_UI: '0' };
  const c = createAppUpdateController({ app: { quit() {}, relaunch() {} }, config: {}, dataDir, currentVersion: '5.6.110', fetchImpl: net.fetchImpl,
    manifestPublicKey: net.keys.pub, env, isPackaged: false, logger: { warn() {}, info() {} } });
  const listed = await c.listVersions();
  assert.equal(listed.ok, true, listed.error);
  assert.equal(listed.source, '公司内源');
  assert.deepEqual(listed.items.map(i => i.version), ['5.6.110', '5.6.104']);
  const after = await c.rollbackTo('5.6.104');
  assert.equal(after.phase, 'ready', after.error || '');
  assert.ok(net.requests.some(u => u.startsWith(net.FILE_HOST) && u.endsWith('/AIHubHuawei-5.6.104-update.gz')), '从内源下的是 5.6.104 完整更新包');
  assert.ok(!net.requests.some(u => EXTERNAL.test(u)), '一次都没碰外网');
  const pin = cat.readPin(dataDir);
  assert.equal(pin.version, '5.6.104'); assert.equal(pin.channel, 'openx'); assert.equal(pin.supportsPin, true);
  assert.equal(cat.listBackups(dataDir).length, 1);
  c.dispose();
  // 模拟回退已换上：以 5.6.104 启动，后台检查不发请求
  const c2 = createAppUpdateController({ app: { quit() {} }, config: {}, dataDir, currentVersion: '5.6.104', fetchImpl: net.fetchImpl,
    manifestPublicKey: net.keys.pub, env, isPackaged: false, logger: { warn() {}, info() {} } });
  assert.equal(c2.getState().pinned.version, '5.6.104');
  const before = net.requests.length;
  await c2.check({ silent: true });
  assert.equal(net.requests.length, before, '固定版本下后台不检查');
  const back = await c2.returnToLatest();
  assert.equal(back.pinned, null);
  assert.ok(net.requests.slice(before).some(u => u.endsWith('/latest.json')), '回到最新版后照常读内源清单');
  assert.equal(back.latest.version, '5.6.110');
  assert.equal(cat.readPin(dataDir), null);
  c2.dispose();
});

test('读不到版本列表（内源连不上）：就地给出原因与下一步，不改去外网', async () => {
  const createAppUpdateController = loadController();
  const net = createOpenxReleaseMock({ payload: Buffer.alloc(2048), releases: [{ version: '5.6.104', runtime: RT }], down: true });
  const c = createAppUpdateController({ app: {}, config: {}, dataDir: tmp('vr-e-'), currentVersion: '5.6.110', fetchImpl: net.fetchImpl,
    manifestPublicKey: net.keys.pub, env: { AI_HUB_OPENX: '1' }, isPackaged: false, logger: { warn() {}, info() {} } });
  const r = await c.listVersions();
  assert.equal(r.ok, false);
  assert.match(r.error, /^读不到可回退的版本：连不上公司内源/);
  assert.match(r.error, /请确认电脑连着公司网络/);
  assert.doesNotMatch(r.error, /阿里云|GitHub|镜像|发布页/);
  assert.ok(!net.requests.some(u => EXTERNAL.test(u)));
  c.dispose();
});
