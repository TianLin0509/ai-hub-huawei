'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { PptDoctor } = require('../core/company-assistant/ppt-doctor');
const { ensureLocalDirectory } = require('../core/company-assistant/ppt-doctor-server');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, timeout = 10000) => { const end = Date.now() + timeout; while (!fn()) { if (Date.now() > end) throw new Error('fixture wait timed out'); await pause(30); } };
function fixture(t, extra = {}, a) {
  const dir = a?.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ppt-server-'));
  const trace = path.join(dir, 'trace.jsonl'), children = [], seen = [];
  const deps = { pptDoctorTrustedExecutable: true, pptDoctorCapability: { apiVersion: 1, exeSha256: 'a'.repeat(64), capabilities: ['serve', 'status', 'search'] },
    pptDoctorArgs: [path.join(__dirname, 'fixtures/ppt-doctor-server-fake.js')], pptDoctorPollMs: 25, pptDoctorHealthPollMs: 100, pptDoctorServerStartMs: 15000, pptDoctorCleanupMs: 30,
    pptDoctorVerifyProcess: async (pid, exe) => exe === process.execPath && children.some(child => child.pid === pid && child.exitCode === null),
    pptEnv: { ...process.env, PPT_DOCTOR_FIXTURE_TRACE: trace },
    pptDoctorSpawn(exe, args, options) { seen.push({ args, options }); const child = spawn(exe, args, options); children.push(child); return child; }, ...extra };
  const assistant = a || { dir, settings: () => ({ ppt: { doctorExe: process.execPath } }) };
  const doctor = new PptDoctor(assistant, deps);
  const rows = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  t.after(async () => {
    doctor.close(); await doctor.server.close();
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try { await until(() => child.exitCode !== null || child.signalCode !== null, 5000); }
      catch { await doctor.kill(child); }
    }
  });
  return { doctor, dir, rows, children, seen, assistant, deps, spool: () => [...doctor.server.sessions.values()][0].spool };
}

test('常驻复用同一进程，多个请求不串结果且只清理自己的结果', async t => {
  const f = fixture(t), progress = [];
  const results = await Promise.all(['search', 'read', 'report'].map((action, i) => f.doctor.call(action, { echo: i, delayMs: 100 }, { onProgress: value => progress.push(value) })));
  assert.deepEqual(results.map(result => result.echo), [0, 1, 2]);
  assert.equal(new Set(results.map(result => result.serverPid)).size, 1);
  assert.equal(f.rows().filter(row => row.phase === 'launch').length, 1);
  assert.ok(progress.length >= 3); assert.equal(fs.readdirSync(path.join(f.spool(), 'responses')).length, 0);
  assert.ok(f.seen.every(({ options }) => options.windowsHide && options.shell === false && options.stdio === 'ignore'));
  assert.ok(f.rows().filter(row => row.phase === 'claimed').every(row => /^[a-f\d-]{36}$/.test(row.requestId)));
});
test('能力标记没有serve时沿用单次；常驻启动失败只在入队前兜底一次', async t => {
  const old = fixture(t, { pptDoctorCapability: { capabilities: ['status'] } });
  assert.equal((await old.doctor.call('status', { echo: 'old' })).echo, 'old');
  assert.deepEqual(old.rows().filter(row => row.phase === 'launch').map(row => row.mode), ['status']);
  const f = fixture(t); f.doctor.env.PPT_DOCTOR_FIXTURE_START_FAIL = '1';
  assert.equal((await f.doctor.call('imgtext-build', { echo: 'fallback' })).echo, 'fallback');
  assert.deepEqual(f.rows().filter(row => row.phase === 'launch').map(row => row.mode), ['serve', 'imgtext-build']);
  assert.equal(fs.readdirSync(path.join(f.spool(), 'requests')).length, 0);
});

test('索引固定走独立单次进程，持续更新时搜索、读页和找原稿仍可使用常驻', async t => {
  const f = fixture(t), releaseFile = path.join(f.dir, 'release-index');
  let indexDone = false;
  const index = f.doctor.call('index', { releaseFile, echo: 'indexed' }).then(value => { indexDone = true; return value; });
  try {
    await until(() => f.rows().some(row => row.phase === 'single-start' || row.phase === 'claimed'));
    assert.ok(f.seen.some(({ args }) => args[args.indexOf('--hub') + 1] === 'index'), 'index must bypass the serial resident queue');
    for (const action of ['search', 'read', 'report', 'imgtext-seed']) assert.equal((await f.doctor.call(action, { echo: action })).echo, action);
    assert.equal(indexDone, false, 'interactive calls complete while the index writer is still blocked');
    assert.equal(f.rows().filter(row => row.phase === 'launch' && row.mode === 'serve').length, 1);
    assert.equal(f.rows().filter(row => row.phase === 'claimed' && row.action === 'index').length, 0);
  } finally { fs.writeFileSync(releaseFile, '1'); await index; }
});
test('写任务中断只恢复服务，返回部分产物提示；不得重新提交写任务', async t => {
  const f = fixture(t);
  await assert.rejects(f.doctor.call('imgtext-build', { fixture: 'crash-once' }), error => error.code === 'REQUEST_INTERRUPTED' && error.retryable === false && error.resultMayBePartial === true && error.requestQueued === true);
  assert.equal(f.rows().filter(row => row.phase === 'claimed').length, 1);
  assert.deepEqual(f.rows().filter(row => row.phase === 'launch').map(row => row.mode), ['serve', 'serve']);
});
test('只读任务中断按服务端明确许可恢复一次，保留跨请求结果关联', async t => {
  const f = fixture(t);
  assert.equal((await f.doctor.call('search', { fixture: 'crash-once', echo: 'recovered' })).echo, 'recovered');
  const claimed = f.rows().filter(row => row.phase === 'claimed'); assert.equal(claimed.length, 2);
  assert.notEqual(claimed[0].requestId, claimed[1].requestId);
  assert.equal(f.rows().filter(row => row.phase === 'launch').length, 2);
});
test('只读连续中断最多恢复一次，不进入无界重试', async t => {
  const f = fixture(t);
  await assert.rejects(f.doctor.call('read', { fixture: 'always-interrupted' }), error => error.code === 'REQUEST_INTERRUPTED');
  assert.equal(f.rows().filter(row => row.phase === 'claimed').length, 2);
  assert.equal(f.rows().filter(row => row.phase === 'launch').length, 1);
});
test('PID存在但程序身份不符时不能附着，也不向陌生实例写停止命令', async t => {
  const f = fixture(t, { pptDoctorVerifyProcess: async () => false });
  const s = f.doctor.server.session(process.execPath, f.deps.pptDoctorCapability); ensureLocalDirectory(s.spool);
  fs.writeFileSync(path.join(s.spool, 'server.json'), JSON.stringify({ apiVersion: 1, pid: process.pid, instanceId: 'b'.repeat(32), state: 'ready', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
  assert.equal(await f.doctor.server.inspect(s), null);
  f.doctor.close(); await f.doctor.server.close(); assert.equal(fs.existsSync(path.join(s.spool, 'stop.json')), false);
});
test('请求超时不终止共享进程或重放写任务，其他请求仍能完成', async t => {
  const f = fixture(t); await f.doctor.call('status');
  await assert.rejects(f.doctor.call('imgtext-build', { delayMs: 500, echo: 'slow' }, { timeoutMs: 120 }), error => error.code === 'DOCTOR_TIMEOUT' && error.resultMayBePartial === true && error.requestQueued);
  assert.equal((await f.doctor.call('search', { echo: 'next' })).echo, 'next');
  assert.equal(f.rows().filter(row => row.phase === 'claimed' && row.action === 'imgtext-build').length, 1);
  assert.equal(f.rows().filter(row => row.phase === 'launch').length, 1);
  await until(() => fs.readdirSync(path.join(f.spool(), 'responses')).length === 0);
  assert.equal(fs.readdirSync(path.join(f.spool(), 'progress')).length, 0);
});
test('超时搜索的迟到结果自动回收，产物和别的请求结果保持原样', async t => {
  const f = fixture(t); await f.doctor.call('status');
  const artifact = path.join(f.dir, 'editable.pptx'); fs.writeFileSync(artifact, 'preserve-output');
  const foreign = path.join(f.spool(), 'responses', 'f'.repeat(32) + '.json'); fs.writeFileSync(foreign, '{"foreign":true}');
  await assert.rejects(f.doctor.call('search', { delayMs: 350 }, { timeoutMs: 100 }), error => error.code === 'DOCTOR_TIMEOUT');
  await until(() => fs.readdirSync(path.join(f.spool(), 'abandoned')).length === 0);
  assert.deepEqual(fs.readdirSync(path.join(f.spool(), 'responses')), [path.basename(foreign)]);
  assert.equal(fs.readdirSync(path.join(f.spool(), 'progress')).length, 0);
  assert.equal(fs.readFileSync(artifact, 'utf8'), 'preserve-output');
  assert.equal(fs.readFileSync(foreign, 'utf8'), '{"foreign":true}');
});
test('关闭Hub前未到达的超时结果在下次连接清理，不重放原请求', async t => {
  const f = fixture(t); await f.doctor.call('status');
  await assert.rejects(f.doctor.call('search', { delayMs: 400, echo: 'abandoned' }, { timeoutMs: 100 }), error => error.code === 'DOCTOR_TIMEOUT');
  f.doctor.close(); await f.doctor.server.close(); await until(() => f.rows().some(row => row.phase === 'stopped'));
  await until(() => fs.readdirSync(path.join(f.spool(), 'responses')).length === 1);
  assert.equal(fs.readdirSync(path.join(f.spool(), 'responses')).length, 1);
  const next = fixture(t, {}, f.assistant); await next.doctor.call('status');
  await until(() => fs.readdirSync(path.join(f.spool(), 'responses')).length === 0);
  assert.equal(fs.readdirSync(path.join(f.spool(), 'abandoned')).length, 0);
  assert.equal(f.rows().filter(row => row.phase === 'claimed' && row.echo === 'abandoned').length, 1);
});
test('迟到结果的关联号不符时保留证据，不当作孤儿文件删除', async t => {
  const f = fixture(t); await f.doctor.call('status');
  await assert.rejects(f.doctor.call('search', { fixture: 'wrong-id', delayMs: 300 }, { timeoutMs: 100 }), error => error.code === 'DOCTOR_TIMEOUT');
  await until(() => fs.readdirSync(path.join(f.spool(), 'responses')).length === 1);
  await pause(120);
  assert.equal(fs.readdirSync(path.join(f.spool(), 'responses')).length, 1);
  assert.equal(fs.readdirSync(path.join(f.spool(), 'abandoned')).length, 1);
});
test('错误结果与进度关联均拒绝，不单次兜底、不删除陌生结果', async t => {
  const f = fixture(t);
  await assert.rejects(f.doctor.call('search', { fixture: 'wrong-id' }), error => error.code === 'DOCTOR_WRONG_RESPONSE');
  assert.equal(fs.readdirSync(path.join(f.spool(), 'responses')).length, 1);
  await assert.rejects(f.doctor.call('imgtext-build', { fixture: 'wrong-progress', delayMs: 200 }, { onProgress() {} }), error => error.code === 'DOCTOR_WRONG_RESPONSE' && error.resultMayBePartial);
  assert.equal(f.rows().filter(row => row.phase === 'launch').length, 1);
});
test('附着实例必须核对可执行路径，Hub退出仅按已核对instanceId优雅停止', async t => {
  const f = fixture(t); await f.doctor.call('status');
  let verified = 0;
  const attached = fixture(t, { pptDoctorVerifyProcess: async (pid, exe) => { verified++; return pid === f.children[0].pid && exe === process.execPath; } }, f.assistant);
  await attached.doctor.call('read'); assert.equal(attached.children.length, 0); assert.ok(verified > 0);
  const busy = f.doctor.call('imgtext-build', { delayMs: 500 });
  const checked = assert.rejects(busy, error => error.code === 'DOCTOR_CLOSED' && error.resultMayBePartial);
  await until(() => f.rows().some(row => row.phase === 'claimed' && row.action === 'imgtext-build'));
  f.doctor.close(); await f.doctor.server.close(); await checked;
  const stop = JSON.parse(fs.readFileSync(path.join(f.spool(), 'stop.json'), 'utf8'));
  const info = JSON.parse(fs.readFileSync(path.join(f.spool(), 'server.json'), 'utf8'));
  assert.equal(stop.instanceId, info.instanceId);
  await until(() => f.rows().some(row => row.phase === 'stopped'));
  const responses = fs.readdirSync(path.join(f.spool(), 'responses'));
  assert.equal(responses.length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(f.spool(), 'responses', responses[0]), 'utf8')).ok, true);
});
test('常驻工作目录拒绝目录链接且不会在目标目录写入队列', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ppt-spool-')), target = path.join(root, 'target'), link = path.join(root, 'link');
  fs.mkdirSync(target); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.unlinkSync(link));
  assert.throws(() => ensureLocalDirectory(path.join(link, 'requests')), error => error.code === 'DOCTOR_SPOOL_PATH');
  assert.deepEqual(fs.readdirSync(target), []);
});
