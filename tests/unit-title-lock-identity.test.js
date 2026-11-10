'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { spawn } = require('node:child_process'), { createRequire } = require('node:module');
const owned = require('../core/owned-process');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-lock-identity-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  t.after(async () => { await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'record.json'), lock = file + '.title.lock';
  fs.writeFileSync(file, JSON.stringify({ title: '旧名', titleRevision: 1 }));
  return { file, lock, child, recordLock(recordedAt) {
    fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, mtime: recordedAt }));
    const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
  } };
}
function helperWithBirthProbe(readStartedAt) {
  const filename = path.join(__dirname, '../core/title-backup-write.js'), realRequire = createRequire(filename);
  const context = { module: { exports: {} }, process, require: name => name === './owned-process'
    ? { matches: (pid, recordedAt) => owned.matches(pid, recordedAt, readStartedAt) } : realRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

test('sync and async title locks recover a reused PID while its unrelated replacement process is alive', async t => {
  const f = await fixture(t), helper = require('../core/title-backup-write');
  const beforeBirth = Date.now() - 3600000;
  assert.equal(owned.matches(f.child.pid, beforeBirth), false);
  for (const mode of ['sync', 'async']) {
    f.recordLock(beforeBirth);
    const write = () => { fs.writeFileSync(f.file, JSON.stringify({ title: '恢复-' + mode, titleRevision: 2 })); return true; };
    const result = mode === 'sync' ? helper.withTitleBackupWrite(f.file, 2, write) : await helper.withTitleBackupWriteAsync(f.file, 2, write);
    assert.equal(result, true); assert.equal(JSON.parse(fs.readFileSync(f.file)).title, '恢复-' + mode);
    assert.equal(fs.existsSync(f.lock), false); assert.doesNotThrow(() => process.kill(f.child.pid, 0));
  }
});
test('an old lock held by its actual live writer is retained until that writer releases it', async t => {
  const f = await fixture(t), helper = require('../core/title-backup-write');
  f.recordLock(Date.now()); let written = false;
  assert.throws(() => helper.withTitleBackupWrite(f.file, 2, () => { written = true; }), /锁被占用/);
  assert.equal(written, false); assert.equal(fs.existsSync(f.lock), true);
  const pending = helper.withTitleBackupWriteAsync(f.file, 2, () => { written = true; });
  try { await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(written, false); assert.equal(fs.existsSync(f.lock), true); }
  finally { if (fs.existsSync(f.lock)) fs.unlinkSync(f.lock); await pending; }
});
for (const unavailable of ['throws', 'unknown']) test('unavailable process birth (' + unavailable + ') keeps title ownership conservative without repeated probes', async t => {
  const f = await fixture(t); let probes = 0, written = false;
  const helper = helperWithBirthProbe(() => { probes++; if (unavailable === 'throws') throw Error('birth unavailable'); return NaN; });
  f.recordLock(Date.now() - 3600000);
  assert.throws(() => helper.withTitleBackupWrite(f.file, 2, () => { written = true; }), /锁被占用/);
  assert.equal(written, false); assert.equal(fs.existsSync(f.lock), true); assert.ok(probes <= 1);
  const before = probes, pending = helper.withTitleBackupWriteAsync(f.file, 2, () => { written = true; });
  try { await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(written, false); assert.equal(fs.existsSync(f.lock), true); assert.ok(probes - before <= 1); }
  finally { if (fs.existsSync(f.lock)) fs.unlinkSync(f.lock); await pending; }
});
