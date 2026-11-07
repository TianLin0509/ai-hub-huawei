'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadHistory, entriesSince, appendRelease, toPublicHistory, FILE } = require('../core/app-update/release-history');

const sample = [
  { version: '5.5.15', date: '2026-11-07', notes: ['c'] },
  { version: '5.5.13', date: '2026-11-06', notes: ['b'] },
  { version: '5.5.11', date: '2026-11-05', notes: ['a'] },
];

test('升级跨了几个版本时，中间每个版本的改动都算进来', () => {
  assert.deepEqual(entriesSince(sample, '5.5.11', '5.5.15').map(e => e.version), ['5.5.15', '5.5.13']);
});

test('没升级、新装、降级都不算有更新', () => {
  assert.deepEqual(entriesSince(sample, '5.5.15', '5.5.15'), []);
  assert.deepEqual(entriesSince(sample, '', '5.5.15'), []);
  assert.deepEqual(entriesSince(sample, '5.5.15', '5.5.13'), []);
});

test('比当前版本新的日志不显示（日志文件和程序版本对不上时）', () => {
  assert.deepEqual(entriesSince(sample, '5.5.11', '5.5.13').map(e => e.version), ['5.5.13']);
});

test('日志文件写坏或不存在时只当没有日志，不影响启动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whats-new-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  assert.deepEqual(loadHistory({ file: bad }), []);
  assert.deepEqual(loadHistory({ file: path.join(dir, 'missing.json') }), []);
  const partial = path.join(dir, 'partial.json');
  fs.writeFileSync(partial, JSON.stringify({ entries: [{ version: 'x', notes: ['a'] }, { version: '1.0.0', notes: [] }, { version: '1.0.1', notes: ['ok'] }, null] }));
  assert.deepEqual(loadHistory({ file: partial }).map(e => e.version), ['1.0.1']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('发版时新版本放最前，重发同一版本不留两条', () => {
  let h = appendRelease({ schema: 1, entries: sample }, { version: '5.5.16', date: '2026-11-08', notes: ['d'], publicNotes: ['pd'] });
  assert.equal(h.entries[0].version, '5.5.16');
  assert.deepEqual(h.entries[0].publicNotes, ['pd']);
  h = appendRelease(h, { version: '5.5.16', date: '2026-11-08', notes: ['d2'] });
  assert.equal(h.entries.filter(e => e.version === '5.5.16').length, 1);
  assert.deepEqual(h.entries[0].notes, ['d2']);
});

test('公开版用公开说明；没有公开说明的按规则过滤，滤空的版本不留', () => {
  const history = { entries: [
    { version: '2.0.0', date: 'd', notes: ['成员专属'], publicNotes: ['公开写法'] },
    { version: '1.1.0', date: 'd', notes: ['可以公开', '不能公开'] },
    { version: '1.0.0', date: 'd', notes: ['不能公开'] },
  ] };
  const out = toPublicHistory(history, line => line !== '不能公开');
  assert.deepEqual(out.entries.map(e => e.version), ['2.0.0', '1.1.0']);
  assert.deepEqual(out.entries[0].notes, ['公开写法']);
  assert.deepEqual(out.entries[1].notes, ['可以公开']);
  assert.ok(!JSON.stringify(out).includes('publicNotes'));
});

test('随程序发的日志文件格式正确，且包含当前版本', () => {
  const entries = loadHistory({ file: FILE });
  assert.ok(entries.length > 0);
  const { version } = require('../package.json');
  assert.ok(entries.some(e => e.version === version), `更新日志里没有当前版本 ${version}`);
});
