'use strict';
// 启动时存储出错不能让 Hub 无声消失：写 state 失败不致命、协调库损坏自动隔离重建、致命异常有崩溃文件和人话提示。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('启动写 state.json 失败（磁盘满）不抛错，用内存状态继续并带回原因', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-full-'));
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, sessions: [{ hubId: 's1', updatedAt: 1 }], meetings: [], immersiveByMeeting: {}, cleanShutdown: true }));
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, ...rest) {
    if (String(file).includes('state.json.') && String(file).endsWith('.tmp')) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return realWrite.call(fs, file, ...rest);
  };
  try {
    const stateStore = require('../core/state-store.js');
    const disk = stateStore.loadAndSelfHeal({});
    assert.equal(disk.storageWriteError.code, 'ENOSPC');
    assert.equal(disk.sessions.length, 1);
  } finally { fs.writeFileSync = realWrite; }
});

test('协调库损坏时改名隔离后重建，而不是启动抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-db-'));
  fs.writeFileSync(path.join(dir, 'session-open-owners.sqlite'), Buffer.alloc(8192, 0x41));
  const { SessionOpenOwnership } = require('../core/session-open-ownership.js');
  const o = new SessionOpenOwnership({ directory: dir });
  assert.ok(o.db);
  try { o.db.close(); } catch {}
  const names = fs.readdirSync(dir);
  assert.ok(names.some(n => /^session-open-owners\.sqlite\.corrupt-/.test(n)), names.join());
  assert.ok(names.includes('session-open-owners.sqlite'));
});

test('致命异常：写崩溃文件、弹人话对话框、再退出', () => {
  const { reportFatal } = require('../core/fatal-error-report.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-fatal-'));
  const calls = [];
  const file = reportFatal(Object.assign(new Error('no space'), { code: 'ENOSPC' }), {
    dataDir: dir, showDialog: (t, c) => calls.push(['dialog', t, c]), exit: c => calls.push(['exit', c]), version: '1.0.0',
  });
  assert.ok(file && fs.readFileSync(file, 'utf8').includes('ENOSPC'));
  assert.equal(calls[0][0], 'dialog');
  assert.match(calls[0][2], /磁盘空间已满/);
  assert.deepEqual(calls[1], ['exit', 1]);
});

test('数据目录写不了时崩溃文件保存失败也照样弹框并退出', () => {
  const { reportFatal } = require('../core/fatal-error-report.js');
  const calls = [];
  const bad = { mkdirSync() { throw new Error('x'); }, writeFileSync() { throw new Error('x'); } };
  const file = reportFatal(new Error('boom'), { dataDir: 'Z:/none', fsModule: bad, showDialog: (t, c) => calls.push(c), exit: c => calls.push(c) });
  assert.equal(file, null);
  assert.match(calls[0], /没能保存/);
  assert.equal(calls[1], 1);
});
