'use strict';
// 版本选择与回退（2026-11-16）：降级计划、运行时不一致被过滤、固定版本下不自动更新、回到最新版恢复、备份与还原。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const manifestLib = require('../core/app-update/manifest.js');
const cat = require('../core/app-update/version-catalog.js');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const RT = { electron: '41.2.0', native: { 'node-pty': '1.2.0-beta.13' } };
const H = c => c.repeat(64);
const entry = (version, runtime = RT, extra = {}) => ({ version, publishedAt: '2026-11-1' + version.slice(-1) + 'T00:00:00Z', runtime,
  incremental: { file: `AIHubHuawei-${version}-update.gz`, bytes: 15000000, sha256: H('a') }, ...extra });

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

test('版本列表：坏条目丢弃、按版本倒序；运行时不一致的过滤；之后修了什么来自更新日志', () => {
  const raw = { schema: 1, versions: [entry('5.6.29'), entry('5.6.33'), { version: 'x' }, entry('5.6.24', { electron: '41.2.0', native: { 'node-pty': '1.1.0' } }), entry('5.6.31')] };
  const versions = cat.validateVersions(JSON.stringify(raw));
  assert.deepEqual(versions.map(v => v.version), ['5.6.33', '5.6.31', '5.6.29', '5.6.24']);
  const history = [{ version: '5.6.33', notes: ['n33'] }, { version: '5.6.32', notes: ['n32'] }, { version: '5.6.31', notes: ['n31'] }, { version: '5.6.30', notes: ['n30'] }];
  const c = cat.buildCatalog(versions, { current: '5.6.33', runtime: RT, history });
  assert.deepEqual(c.items.map(i => i.version), ['5.6.33', '5.6.31', '5.6.29']);
  assert.deepEqual(c.hidden.map(h => h.version), ['5.6.24']);
  const v29 = c.items.find(i => i.version === '5.6.29');
  assert.deepEqual(v29.laterFixes.map(x => x.version), ['5.6.33', '5.6.32', '5.6.31', '5.6.30']);
  assert.ok(c.items[0].current && c.items[0].latest);
  assert.equal(cat.versionsUrl('https://h/x/m-1/latest.json'), 'https://h/x/m-1/versions.json');
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

test('控制器：固定版本下后台检查不发请求；回退下载完整包；回到最新版恢复检查', async () => {
  manifestLib.currentRuntime = () => RT;
  delete require.cache[require.resolve('../main/app-update-controller.js')];
  const { createAppUpdateController } = require('../main/app-update-controller.js');
  const { packPayload } = require('../core/app-update/payload.js');
  const res = tmp('vr-res-');
  fs.writeFileSync(path.join(res, 'app.asar'), crypto.randomBytes(4096));
  fs.mkdirSync(path.join(res, 'app.asar.unpacked'), { recursive: true });
  const gzPath = path.join(tmp('vr-gz-'), 'p.gz'); packPayload(res, gzPath);
  const gz = fs.readFileSync(gzPath), sha = crypto.createHash('sha256').update(gz).digest('hex');
  const latest = { schema: 1, version: '5.6.33', notes: ['n'], runtime: RT, incremental: { file: 'AIHubHuawei-5.6.33-update.gz', bytes: gz.length, sha256: sha },
    installer: { file: 'AIHubHuawei-Setup-5.6.33.exe', bytes: 4096, sha256: H('b') } };
  const versions = { schema: 1, versions: [{ ...entry('5.6.33'), incremental: latest.incremental }, { ...entry('5.6.30'), incremental: { file: 'AIHubHuawei-5.6.30-update.gz', bytes: gz.length, sha256: sha } }] };
  const requests = [];
  const ok = (body, isFile) => ({ ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(isFile ? gz.length : 0) : 'application/json') },
    text: async () => JSON.stringify(body),
    body: { getReader() { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: gz })), cancel: async () => {} }; } } });
  const fetchImpl = async url => { url = String(url); requests.push(url);
    if (url.endsWith('latest.json')) return ok(latest); if (url.endsWith('versions.json')) return ok(versions); return ok(null, true); };
  const dataDir = tmp('vr-data-');
  fs.writeFileSync(path.join(dataDir, 'hub-config.json'), '{}');
  const SRC = { id: 'a', name: '源A', manifest: 'https://example.invalid/m/latest.json', files: 'https://example.invalid/m/v{version}/' };
  const mk = () => createAppUpdateController({ app: { quit() {}, relaunch() {} }, config: { sources: [SRC] }, dataDir, currentVersion: '5.6.33', fetchImpl,
    env: { AI_HUB_UPDATE_RESOURCES: res, AI_HUB_UPDATE_FORCE_APPLY: '1', AI_HUB_UPDATE_PROGRESS_UI: '0' }, isPackaged: false, logger: { warn() {} } });
  const c = mk();
  const listed = await c.listVersions();
  assert.equal(listed.ok, true); assert.deepEqual(listed.items.map(i => i.version), ['5.6.33', '5.6.30']);
  const after = await c.rollbackTo('5.6.30');
  assert.equal(after.phase, 'ready');
  assert.ok(requests.some(u => u.endsWith('/v5.6.30/AIHubHuawei-5.6.30-update.gz')), '下载的是 5.6.30 完整更新包');
  assert.equal(cat.readPin(dataDir).version, '5.6.30');
  assert.equal(cat.readPin(dataDir).supportsPin, false, '清单没写 version-pin 的老版本不承诺固定');
  assert.equal(cat.listBackups(dataDir).length, 1);
  c.dispose();
  // 模拟回退已换上：以 5.6.30 启动，后台检查不发请求
  const c2 = createAppUpdateController({ app: { quit() {} }, config: { sources: [SRC] }, dataDir, currentVersion: '5.6.30', fetchImpl,
    env: { AI_HUB_UPDATE_RESOURCES: res }, isPackaged: false, logger: { warn() {} } });
  assert.equal(c2.getState().pinned.version, '5.6.30');
  const before = requests.length;
  await c2.check({ silent: true });
  assert.equal(requests.length, before, '固定版本下后台不检查');
  const back = await c2.returnToLatest();
  assert.equal(back.pinned, null);
  assert.ok(requests.slice(before).some(u => u.endsWith('latest.json')), '回到最新版后照常检查');
  assert.equal(back.latest.version, '5.6.33');
  assert.equal(cat.readPin(dataDir), null);
  c2.dispose();
});

test('读不到版本列表：就地给出原因', async () => {
  delete require.cache[require.resolve('../main/app-update-controller.js')];
  const { createAppUpdateController } = require('../main/app-update-controller.js');
  const SRC = { id: 'a', name: '源A', manifest: 'https://example.invalid/m/latest.json', files: 'https://example.invalid/m/v{version}/' };
  const c = createAppUpdateController({ app: {}, config: { sources: [SRC] }, dataDir: tmp('vr-e-'), currentVersion: '5.6.33',
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }), env: {}, isPackaged: false, logger: { warn() {} } });
  const r = await c.listVersions();
  assert.equal(r.ok, false); assert.match(r.error, /源A：HTTP 404/);
  c.dispose();
});
