'use strict';
// 没有 D 盘、读不到或卡住的盘跳过；非 Windows 只看当前盘。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSystemTelemetry, localDiskRoots } = require('../core/system-telemetry');

const stats = { 'C:\\': { bsize: 10, blocks: 100, bavail: 50 }, 'D:\\': { bsize: 10, blocks: 100, bavail: 0 } };

test('Windows 采样 C、D 两块盘，Hub 所在盘作主盘', async () => {
  const telemetry = createSystemTelemetry({ platform: 'win32', cwd: () => 'C:\\repo', statfs: async root => stats[root], offMain: false });
  const both = await telemetry.sampleDisk();
  assert.deepEqual(both.volumes.map(v => [v.root, v.usagePct, v.freeBytes]), [['C:\\', 50, 500], ['D:\\', 100, 0]]);
  assert.equal(both.root, 'C:\\');
  assert.equal(both.usagePct, 50, '顶层字段仍是 Hub 所在盘，老读者不变');
  const fromD = await createSystemTelemetry({ platform: 'win32', cwd: () => 'D:\\work', statfs: async root => stats[root], offMain: false }).sampleDisk();
  assert.equal(fromD.root, 'D:\\');
});

test('没有 D 盘、读不到或卡住的盘跳过，底栏不被拖住', async () => {
  const noD = createSystemTelemetry({ platform: 'win32', cwd: () => 'C:\\repo', offMain: false,
    statfs: async root => { if (root === 'D:\\') throw new Error('ENOENT'); return stats[root]; } });
  assert.deepEqual((await noD.sampleDisk()).volumes.map(v => v.root), ['C:\\']);
  const empty = createSystemTelemetry({ platform: 'win32', cwd: () => 'C:\\repo', offMain: false,
    statfs: async root => (root === 'D:\\' ? { bsize: 0, blocks: 0, bavail: 0 } : stats[root]) });
  assert.deepEqual((await empty.sampleDisk()).volumes.map(v => v.root), ['C:\\'], '光驱没盘（容量 0）不显示');
  const hung = createSystemTelemetry({ platform: 'win32', cwd: () => 'C:\\repo', diskTimeoutMs: 100, offMain: false,
    statfs: root => (root === 'D:\\' ? new Promise(() => {}) : Promise.resolve(stats[root])) });
  const started = Date.now();
  assert.deepEqual((await hung.sampleDisk()).volumes.map(v => v.root), ['C:\\'], '卡住的盘不挡底栏');
  assert.ok(Date.now() - started < 2000);
});

test('盘符清单：Windows 固定看 C、D 加上 Hub 所在盘；其他系统只看当前盘', () => {
  assert.deepEqual(localDiskRoots('E:\\work', 'win32'), ['C:\\', 'D:\\', 'E:\\']);
  assert.deepEqual(localDiskRoots('C:\\x', 'win32'), ['C:\\', 'D:\\']);
  assert.equal(localDiskRoots('/home/u', 'linux').length, 1, '非 Windows 只看当前盘');
});
