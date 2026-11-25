'use strict';
// 版本回退第二轮返工（r16，2026-11-16）：另一个 Hub 开着同一份数据时不回退/不还原；同秒恢复点不覆盖来源；恢复点记下的缺失文件再还原时删除。
// R35 删了抢先版，「回退前关抢先版」两条随之去掉；R42 回退只走内源，版本清单用模拟内源（tests/helpers/openx-release-mock.js）。
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
const RT = { electron: '41.2.0', native: {} };
// 另一个活着的进程：用父进程（测试运行器）的 PID 冒充另一个 Hub 的登记
const registerOtherHub = dataDir => { fs.mkdirSync(path.join(dataDir, 'control'), { recursive: true }); fs.writeFileSync(path.join(dataDir, 'control', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid })); };

function harness() {
  manifestLib.currentRuntime = () => RT;
  delete require.cache[require.resolve('../main/app-update-controller.js')];
  const { createAppUpdateController } = require('../main/app-update-controller.js');
  const { packPayload } = require('../core/app-update/payload.js');
  const res = tmp('vr2-res-');
  fs.writeFileSync(path.join(res, 'app.asar'), crypto.randomBytes(4096));
  fs.mkdirSync(path.join(res, 'app.asar.unpacked'), { recursive: true });
  const gzPath = path.join(tmp('vr2-gz-'), 'p.gz'); packPayload(res, gzPath);
  const gz = fs.readFileSync(gzPath);
  openxSource._reset();
  const net = createOpenxReleaseMock({ payload: gz, releases: [{ version: '5.6.33', runtime: RT }, { version: '5.6.30', runtime: RT }] });
  const requests = net.requests;
  const dataDir = tmp('vr2-data-');
  fs.writeFileSync(path.join(dataDir, 'hub-config.json'), '{}');
  const mk = () => createAppUpdateController({ app: { quit() {}, relaunch() {} }, config: {}, dataDir, currentVersion: '5.6.33', fetchImpl: net.fetchImpl, manifestPublicKey: net.keys.pub,
    env: { AI_HUB_OPENX: '1', AI_HUB_UPDATE_RESOURCES: res, AI_HUB_UPDATE_FORCE_APPLY: '1', AI_HUB_UPDATE_PROGRESS_UI: '0' }, isPackaged: false, logger: { warn() {}, info() {} } });
  return { mk, dataDir, requests };
}

test('另一个 Hub 开着同一份数据：不备份、不下载、不固定，就地提示先关掉另一个窗口', async () => {
  const { mk, dataDir, requests } = harness();
  registerOtherHub(dataDir);
  const c = mk();
  await c.listVersions();
  const before = requests.length;
  await assert.rejects(c.rollbackTo('5.6.30'), /请先关闭另一个 Hub 窗口再回退/);
  assert.equal(requests.length, before, '没有下载');
  assert.equal(cat.listBackups(dataDir).length, 0, '没有做备份');
  assert.equal(cat.readPin(dataDir), null, '没有写固定');
  // 另一个窗口关掉（登记的进程不在了）后重试即可
  fs.writeFileSync(path.join(dataDir, 'control', `${process.ppid}.json`), JSON.stringify({ pid: 2147483000 }));
  assert.equal((await c.rollbackTo('5.6.30')).phase, 'ready');
  c.dispose();
});

test('另一个 Hub 开着时：一键还原不登记；启动时待还原也一个文件都不动、标记保留', () => {
  const { mk, dataDir } = harness();
  fs.writeFileSync(path.join(dataDir, 'config.json'), 'OLD');
  const b = cat.backupForRollback(dataDir, { from: '5.6.33', to: '5.6.30', now: new Date(2026, 10, 16, 10, 0, 0) });
  fs.writeFileSync(path.join(dataDir, 'config.json'), 'NEW');
  registerOtherHub(dataDir);
  const c = mk();
  assert.throws(() => c.restoreBackup(b.dir), /请先关闭另一个 Hub 窗口/);
  c.dispose();
  cat.scheduleRestore(dataDir, b.dir); // 模拟之前已经登记过
  const r = cat.applyPendingRestore(dataDir, { now: new Date(2026, 10, 16, 11, 0, 0) });
  assert.equal(r.ok, false); assert.equal(r.waiting, true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), 'NEW', '没动当前文件');
  assert.equal(cat.listBackups(dataDir).filter(x => x.kind === 'restore-point').length, 0, '没有生成恢复点');
  const mark = JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', 'restore-pending.json'), 'utf8'));
  assert.equal(mark.attempts, 0, '不计失败次数');
});

test('同一秒连着还原：恢复点另起新目录，不覆盖正在读取的来源', () => {
  const dir = tmp('vr2-same-');
  fs.writeFileSync(path.join(dir, 'config.json'), 'OLD');
  const now = new Date(2026, 10, 16, 10, 0, 0);
  const b = cat.backupForRollback(dir, { from: '5.6.33', to: '5.6.30', now });
  fs.writeFileSync(path.join(dir, 'config.json'), 'NEW');
  cat.scheduleRestore(dir, b.dir);
  assert.equal(cat.applyPendingRestore(dir, { now }).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), 'OLD');
  const point = cat.listBackups(dir).find(x => x.kind === 'restore-point');
  cat.scheduleRestore(dir, point.dir);
  const r2 = cat.applyPendingRestore(dir, { now });
  assert.equal(r2.ok, true); assert.notEqual(r2.restorePoint, point.dir);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), 'NEW', '新数据没有被同秒恢复点覆盖');
  assert.equal(fs.readFileSync(path.join(b.dir, 'files', 'config.json'), 'utf8'), 'OLD', '原备份也没被改');
});

test('恢复点记下「还原前不存在」的文件：再还原它时删除，删前先存', () => {
  const dir = tmp('vr2-absent-');
  fs.writeFileSync(path.join(dir, 'config.json'), 'OLD');
  const b = cat.backupForRollback(dir, { from: '5.6.33', to: '5.6.30', now: new Date(2026, 10, 16, 10, 0, 0) });
  fs.rmSync(path.join(dir, 'config.json'));
  fs.writeFileSync(path.join(dir, 'other.json'), 'KEEP');
  cat.scheduleRestore(dir, b.dir);
  assert.equal(cat.applyPendingRestore(dir, { now: new Date(2026, 10, 16, 11, 0, 0) }).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), 'OLD');
  const point = cat.listBackups(dir).find(x => x.kind === 'restore-point');
  cat.scheduleRestore(dir, point.dir);
  const r = cat.applyPendingRestore(dir, { now: new Date(2026, 10, 16, 12, 0, 0) });
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(path.join(dir, 'config.json')), '回到了还原前：config.json 不存在');
  assert.equal(fs.readFileSync(path.join(dir, 'other.json'), 'utf8'), 'KEEP', '未登记的文件不碰');
  assert.equal(fs.readFileSync(path.join(r.restorePoint, 'files', 'config.json'), 'utf8'), 'OLD', '删之前已存进新恢复点');
});
