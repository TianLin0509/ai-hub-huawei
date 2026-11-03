'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { readJson } = require('../core/company-assistant/ppt-doctor-protocol');
test('Windows结果发布后的短暂读占用有限重试，永久拒绝仍失败', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-protocol-read-')), file = path.join(dir, 'result.json'); fs.writeFileSync(file, '{"ok":true}');
  const read = fs.readFileSync, stat = fs.statSync; let reads = 0, stats = 0;
  try {
    fs.statSync = function (target, ...args) { if (target === file && ++stats <= 2) throw Object.assign(new Error('busy stat'), { code: 'EPERM' }); return stat.call(this, target, ...args); };
    fs.readFileSync = function (target, ...args) { if (target === file && ++reads <= 2) throw Object.assign(new Error('busy read'), { code: 'EBUSY' }); return read.call(this, target, ...args); };
    assert.deepEqual(readJson(file), { ok: true }); assert.equal(reads, 3); assert.equal(stats, 3);
    reads = 0; fs.readFileSync = function (target, ...args) { if (target === file) { reads++; throw Object.assign(new Error('permanent'), { code: 'EPERM' }); } return read.call(this, target, ...args); };
    assert.throws(() => readJson(file), error => error.code === 'EPERM'); assert.equal(reads, 21, '首次+20次有限重试');
  } finally { fs.readFileSync = read; fs.statSync = stat; fs.unlinkSync(file); fs.rmdirSync(dir); }
});
