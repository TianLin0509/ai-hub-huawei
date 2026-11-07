'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { PptDoctor } = require('../core/company-assistant/ppt-doctor');
const { parallelQueries } = require('../core/company-assistant/ppt-search');
function fixture(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ppt-doctor-'));
  const a = { dir, settings: () => ({ ppt: { doctorExe: process.execPath } }) };
  const seen = [], doctor = new PptDoctor(a, { pptDoctorTrustedExecutable: true, pptDoctorArgs: [path.join(__dirname, 'fixtures/ppt-doctor-fake.js')], pptDoctorSpawn(exe, args, opts) { seen.push(opts); return spawn(exe, args, opts); }, ...extra });
  return { doctor, seen, dir };
}
test('Doctor 文件协议：成功回传、中文失败、过旧、错误关联和无效输出均可区分', async () => {
  const { doctor, seen, dir } = fixture();
  assert.equal((await doctor.call('status')).doctorVersion, '9.9.fixture');
  for (const [mode, code] of [['failed', 'OCR_UNAVAILABLE'], ['old', 'DOCTOR_UPGRADE_REQUIRED'], ['wrong-id', 'DOCTOR_WRONG_RESPONSE'], ['bad-json', 'DOCTOR_INVALID_RESPONSE'], ['missing-output', 'DOCTOR_INVALID_RESPONSE']]) {
    await assert.rejects(doctor.call('status', { fixture: mode }), error => error.code === code);
  }
  assert.ok(seen.every(o => o.windowsHide === true && o.shell === false && o.stdio === 'ignore'));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'ppt-doctor/requests')), []); doctor.close();
});
test('Doctor 超时会结束本次进程且不会把 close 事件当成功', async () => {
  const { doctor } = fixture({ pptDoctorTimeoutMs: 300 });
  await assert.rejects(doctor.call('search', { fixture: 'timeout' }), error => error.code === 'DOCTOR_TIMEOUT' && error.resultMayBePartial !== true);
  assert.equal(doctor.children.size, 0); doctor.close();
});
test('单次索引读取进度遇到短暂EPERM时继续等待，不误杀正在更新的进程', async t => {
  if (process.platform !== 'win32') return t.skip('Windows sharing violation');
  const { doctor, dir } = fixture(), original = fs.readFileSync, progress = [];
  let denied = 0;
  fs.readFileSync = function(file, ...args) {
    if (String(file).startsWith(dir) && path.basename(String(file)) === 'progress.json' && denied < 2) { denied++; throw Object.assign(new Error('temporary sharing violation'), { code: 'EPERM' }); }
    return original.call(this, file, ...args);
  };
  try {
    const result = await doctor.call('index', { fixture: 'progress' }, { onProgress: value => progress.push(value) });
    assert.equal(result.ok, true); assert.equal(denied, 2); assert.ok(progress.length > 0);
  } finally { fs.readFileSync = original; doctor.close(); }
});
test('单次写调用失去完整回执时保留部分产物标记，已确认的业务失败保持原语义', async () => {
  const { doctor } = fixture();
  try {
    for (const [mode, code, options] of [['timeout', 'DOCTOR_TIMEOUT', { timeoutMs: 300 }], ['bad-json', 'DOCTOR_INVALID_RESPONSE', {}], ['missing-output', 'DOCTOR_INVALID_RESPONSE', {}]]) {
      await assert.rejects(doctor.call('imgtext-build', { fixture: mode }, options), error => error.code === code && error.resultMayBePartial === true && error.retryable === false);
    }
    await assert.rejects(doctor.call('imgtext-build', { fixture: 'failed' }), error => error.code === 'OCR_UNAVAILABLE' && error.resultMayBePartial === false);
  } finally { doctor.close(); }
});
test('Doctor 缺失时明确安装入口，不调用 Python', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ppt-missing-'));
  const doctor = new PptDoctor({ dir, settings: () => ({ ppt: { doctorExe: path.join(dir, 'missing.exe') } }) }, { pptDoctorCandidates: [], pptDoctorSpawn() { throw new Error('must not spawn'); } });
  const status = await doctor.status(); assert.equal(status.state, 'missing'); assert.match(status.error, /安装/); assert.match(status.downloadUrl, /^https:/);
});

test('退出Hub发生在Doctor发现期间时，不启动迟到的程序', async () => {
  const { doctor, seen } = fixture(); let discover;
  doctor.discover = () => new Promise(resolve => { discover = resolve; });
  const pending = doctor.call('status'); doctor.close(); discover(process.execPath);
  await assert.rejects(pending, error => error.code === 'DOCTOR_CLOSED'); assert.equal(seen.length, 0);
});
test('旧Doctor没有能力标记时不启动，避免未知参数打开GUI', async () => {
  const { doctor, seen } = fixture({ pptDoctorTrustedExecutable: false });
  const status = await doctor.status(); assert.equal(status.state, 'upgrade'); assert.equal(seen.length, 0);
});
test('Doctor能力标记必须匹配程序名和SHA256，升级后缓存不能误认旧程序', async () => {
  const { capability } = require('../core/company-assistant/ppt-doctor-discovery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-marker-')), exe = path.join(dir, 'PPT-Doctor.exe');
  fs.writeFileSync(exe, 'version one');
  const marker = { apiVersion: 1, executable: 'PPT-Doctor.exe', exeSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(exe)).digest('hex'), capabilities: ['status', 'search'] };
  fs.writeFileSync(path.join(dir, 'hub-api.json'), JSON.stringify(marker)); assert.ok(await capability(exe));
  fs.writeFileSync(exe, 'version two - changed bytes'); assert.equal(await capability(exe), null);
  fs.writeFileSync(path.join(dir, 'hub-api.json'), JSON.stringify({ ...marker, executable: 'Other.exe' })); assert.equal(await capability(exe), null);
});
test('多索引多组查询同时启动，保留部分失败；全失败和坏计划显式拒绝', async () => {
  const sources = [{ label: 'A' }, { label: 'B' }], started = [], releases = [];
  const pending = parallelQueries(sources, { plan: { queries: ['SRS', 'CSI'] } }, (source, q) => new Promise((resolve, reject) => { started.push(source.label + q.query); releases.push(() => source.label === 'B' && q.query === 'CSI' ? reject(new Error('读取超时')) : resolve({ ok: true, candidates: [] })); }));
  assert.equal(started.length, 4, '未等待前一个查询结束才启动后一个'); releases.forEach(fn => fn());
  const r = await pending; assert.equal(r.successes.length, 3); assert.deepEqual(r.errors, [{ source: 'B', query: 'CSI', message: '读取超时' }]);
  await assert.rejects(parallelQueries(sources, { query: 'SRS' }, async () => { throw new Error('坏库'); }), /坏库/);
  await assert.rejects(parallelQueries(sources, { plan: { queries: [] } }, async () => {}), /queries/);
});
