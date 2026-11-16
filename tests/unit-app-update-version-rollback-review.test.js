'use strict';
// 版本回退独立审查（r16，2026-11-16）6 项修复的回归：还原留恢复点且失败回滚、SQLite 一致快照、旧版不承诺固定、
// 固定时丢弃静默包、回到最新版接通完整安装包、备份入口与固定无关（界面部分由真实路径截图验收）。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const manifestLib = require('../core/app-update/manifest.js');
const cat = require('../core/app-update/version-catalog.js');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const RT = { electron: '41.2.0', native: {} };

test('P1-1 还原：当前文件先存成恢复点，可以再还原回来；新数据不丢', () => {
  const dir = tmp('rv-restore-');
  fs.writeFileSync(path.join(dir, 'config.json'), '{"v":"before-rollback"}');
  const b = cat.backupForRollback(dir, { from: '5.6.33', to: '5.6.30', now: new Date(2026, 10, 16, 10, 0, 0) });
  fs.writeFileSync(path.join(dir, 'config.json'), '{"v":"new-user-data"}');
  fs.writeFileSync(path.join(dir, 'later.json'), '{"later":1}');
  cat.scheduleRestore(dir, b.dir);
  const r = cat.applyPendingRestore(dir, { now: new Date(2026, 10, 16, 11, 0, 0) });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"v":"before-rollback"}');
  const points = cat.listBackups(dir);
  assert.equal(points[0].kind, 'restore-point', '最新一份是还原前恢复点');
  cat.scheduleRestore(dir, points[0].dir);
  assert.equal(cat.applyPendingRestore(dir, { now: new Date(2026, 10, 16, 12, 0, 0) }).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"v":"new-user-data"}', '从恢复点拿回了新数据');
  assert.equal(cat.readRestoreResult(dir).ok, true);
});

test('P1-1 还原中途失败：已动过的文件全部改回，标记保留重试，3 次后放弃', () => {
  const dir = tmp('rv-restore-fail-');
  fs.writeFileSync(path.join(dir, 'a.json'), 'A0'); fs.writeFileSync(path.join(dir, 'b.json'), 'B0');
  const b = cat.backupForRollback(dir, { from: '5.6.33', to: '5.6.30', now: new Date(2026, 10, 16, 10, 0, 0) });
  fs.writeFileSync(path.join(dir, 'a.json'), 'A1'); fs.writeFileSync(path.join(dir, 'b.json'), 'B1');
  cat.scheduleRestore(dir, b.dir);
  let n = 0;
  const flaky = (src, dest) => { if (++n === 2) throw new Error('磁盘满'); fs.copyFileSync(src, dest); };
  const r = cat.applyPendingRestore(dir, { copy: flaky, now: new Date(2026, 10, 16, 11, 0, 0) });
  assert.equal(r.ok, false); assert.match(r.reason, /已全部改回/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'A1');
  assert.equal(fs.readFileSync(path.join(dir, 'b.json'), 'utf8'), 'B1');
  assert.ok(fs.existsSync(path.join(dir, 'backups', 'restore-pending.json')), '失败不消费标记');
  const always = () => { throw new Error('坏盘'); };
  cat.applyPendingRestore(dir, { copy: always, now: new Date(2026, 10, 16, 11, 0, 1) });
  cat.applyPendingRestore(dir, { copy: always, now: new Date(2026, 10, 16, 11, 0, 2) });
  assert.ok(!fs.existsSync(path.join(dir, 'backups', 'restore-pending.json')), '连续 3 次失败后不再每次启动重试');
  assert.ok(fs.existsSync(path.join(dir, 'backups', 'restore-failed.json')));
});

test('P1-2 SQLite：库开着、数据还在 WAL 里也能备到一致快照；还原时清掉旧 -wal/-shm', () => {
  const dir = tmp('rv-sqlite-');
  fs.mkdirSync(path.join(dir, 'feat'));
  const file = path.join(dir, 'feat', 'assistant.sqlite');
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(x); INSERT INTO t VALUES (1);");
  assert.ok(fs.existsSync(file + '-wal'), '数据还在 WAL 里');
  const b = cat.backupForRollback(dir, { from: '5.6.33', to: '5.6.30', now: new Date(2026, 10, 16, 10, 0, 0) });
  db.exec('INSERT INTO t VALUES (2)');
  db.close();
  const listed = JSON.parse(fs.readFileSync(path.join(b.dir, 'backup.json'), 'utf8')).list.map(f => f.rel);
  assert.deepEqual(listed, ['feat/assistant.sqlite'], '不单独复制 -wal/-shm');
  // 模拟下次启动前留下的旧 WAL
  const w = new DatabaseSync(file); w.exec('PRAGMA wal_autocheckpoint=0; INSERT INTO t VALUES (3);');
  fs.copyFileSync(file + '-wal', path.join(dir, 'keep-wal')); w.close();
  if (!fs.existsSync(file + '-wal')) fs.copyFileSync(path.join(dir, 'keep-wal'), file + '-wal');
  cat.scheduleRestore(dir, b.dir);
  assert.equal(cat.applyPendingRestore(dir).ok, true);
  assert.ok(!fs.existsSync(file + '-wal'), '旧 WAL 已移进恢复点');
  const r = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(r.prepare('SELECT x FROM t ORDER BY x').all().map(o => o.x), [1]);
  r.close();
});

test('P1-2 库快照失败：整份备份作废、如实报错，不留半份备份', () => {
  const dir = tmp('rv-sqlite-bad-');
  fs.writeFileSync(path.join(dir, 'x.sqlite'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]));
  assert.throws(() => cat.backupForRollback(dir, { from: '5.6.33', to: '5.6.30', snapshot: () => { throw new Error('database disk image is malformed'); } }),
    e => e.code === 'backup-failed' && /x\.sqlite/.test(e.message));
  assert.equal(cat.listBackups(dir).length, 0);
});

test('P1-3 目标版认不认识固定：来自清单 capabilities，老版本为 false', () => {
  const ent = (v, caps) => ({ version: v, runtime: RT, incremental: { file: `X-${v}.gz`, bytes: 2048, sha256: 'a'.repeat(64) }, ...(caps ? { capabilities: caps } : {}) });
  const versions = cat.validateVersions({ schema: 1, versions: [ent('5.6.35', ['version-pin']), ent('5.6.30')] });
  const c = cat.buildCatalog(versions, { current: '5.6.35', runtime: RT });
  assert.equal(c.items.find(i => i.version === '5.6.35').supportsPin, true);
  assert.equal(c.items.find(i => i.version === '5.6.30').supportsPin, false);
  const prep = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prepare-release.js'), 'utf8');
  assert.match(prep, /capabilities:\['version-pin'\]/, '发版时 latest.json 写上本版能力');
});

// —— 控制器 ——
function controllerFixture({ quietDelivery = false, latestVersion = '5.6.34', latestRuntime = RT, gate = null } = {}) {
  manifestLib.currentRuntime = () => RT;
  delete require.cache[require.resolve('../main/app-update-controller.js')];
  const { createAppUpdateController } = require('../main/app-update-controller.js');
  const { packPayload } = require('../core/app-update/payload.js');
  const res = tmp('rv-res-');
  fs.writeFileSync(path.join(res, 'app.asar'), crypto.randomBytes(4096));
  fs.mkdirSync(path.join(res, 'app.asar.unpacked'), { recursive: true });
  const gzPath = path.join(tmp('rv-gz-'), 'p.gz'); packPayload(res, gzPath);
  const gz = fs.readFileSync(gzPath), sha = b => crypto.createHash('sha256').update(b).digest('hex');
  const exe = crypto.randomBytes(4096);
  const latest = { schema: 1, version: latestVersion, notes: ['n'], runtime: latestRuntime, incremental: { file: `X-${latestVersion}-update.gz`, bytes: gz.length, sha256: sha(gz) },
    installer: { file: `X-Setup-${latestVersion}.exe`, bytes: exe.length, sha256: sha(exe) } };
  const requests = [], spawned = [];
  const bodyOf = buf => ({ ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(buf.length) : 'application/octet-stream') },
    body: { getReader() { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: buf })), cancel: async () => {} }; } } });
  const fetchImpl = async (url, opts) => {
    url = String(url); requests.push(url);
    if (url.endsWith('latest.json')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(latest) };
    if (gate) await gate(opts && opts.signal);
    return bodyOf(url.endsWith('.exe') ? exe : gz);
  };
  const SRC = { id: 'a', name: '源A', manifest: 'https://example.invalid/m/latest.json', files: 'https://example.invalid/m/v{version}/' };
  const dataDir = tmp('rv-data-');
  const c = createAppUpdateController({ app: { quit() {}, relaunch() {} }, config: { sources: [SRC] }, dataDir, currentVersion: '5.6.33', fetchImpl, quietDelivery,
    isPackaged: true, resourcesPath: res, env: { AI_HUB_UPDATE_RESOURCES: res, AI_HUB_UPDATE_PROGRESS_UI: '0' }, prepareLaunch: () => null,
    spawnImpl: (...args) => { spawned.push(args); return { on() {}, unref() {} }; }, logger: { warn() {} } });
  return { c, requests, spawned, dataDir };
}
const settle = async (c, phases) => { for (let i = 0; i < 300; i++) { if (phases.includes(c.getState().phase)) return; await new Promise(r => setTimeout(r, 10)); } };

test('P2-4 已暂存的静默包：固定当前版本后丢弃，退出时不替换', async () => {
  const f = controllerFixture({ quietDelivery: true });
  await f.c.check({ silent: true });
  await settle(f.c, ['ready']);
  assert.equal(f.c.getState().phase, 'ready'); assert.equal(f.c.getState().quiet, true);
  f.c.pinCurrent();
  assert.equal(f.c.getState().phase, 'idle');
  assert.equal(f.c.applyOnQuit(), false);
  assert.equal(f.spawned.length, 0);
  f.c.dispose();
});

test('P2-4 静默下载途中固定：下载被取消/下好也丢弃，退出时不替换', async () => {
  let release;
  const f = controllerFixture({ quietDelivery: true, gate: () => new Promise(r => { release = r; }) });
  await f.c.check({ silent: true });
  await settle(f.c, ['downloading']);
  for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 10));
  f.c.pinCurrent();
  release();
  await settle(f.c, ['idle', 'available']);
  await new Promise(r => setTimeout(r, 50));
  assert.notEqual(f.c.getState().phase, 'ready');
  assert.equal(f.c.applyOnQuit(), false);
  assert.equal(f.spawned.length, 0);
  f.c.dispose();
});

test('P2-5 回到最新版遇到运行时变化：接通完整安装包下载，下好可安装', async () => {
  const f = controllerFixture({ latestRuntime: { electron: '42.0.0', native: {} } });
  f.c.pinCurrent();
  const r = await f.c.returnToLatest();
  assert.equal(r.pinned, null);
  assert.equal(r.plan.kind, 'full');
  assert.ok(f.requests.some(u => u.endsWith('.exe')), '下载了完整安装包');
  assert.equal(r.phase, 'ready');
  f.c.dispose();
});

test('后台/隐藏 e2e 实例默认关掉升级进度小窗；显式传值、可见模式照旧', () => {
  const { buildIsolatedHubEnv } = require('./helpers/hub-launcher.js');
  const data = path.join(tmp('rv-launcher-'), 'data');
  const base = { PATH: process.env.PATH || '', AI_HUB_UPDATE_PROGRESS_UI: '1' };
  assert.equal(buildIsolatedHubEnv(data, {}, base, { windowMode: 'background' }).AI_HUB_UPDATE_PROGRESS_UI, '0');
  assert.equal(buildIsolatedHubEnv(data, {}, base, { windowMode: 'hidden' }).AI_HUB_UPDATE_PROGRESS_UI, '0');
  assert.equal(buildIsolatedHubEnv(data, { AI_HUB_UPDATE_PROGRESS_UI: '1' }, base, { windowMode: 'background' }).AI_HUB_UPDATE_PROGRESS_UI, '1', '调用方显式要看小窗');
  const visible = buildIsolatedHubEnv(data, {}, { PATH: base.PATH, HUB_E2E_SHOW_WINDOWS: '1' }, { windowMode: 'visible' });
  assert.equal(visible.AI_HUB_UPDATE_PROGRESS_UI, undefined, '可见模式不改');
});
