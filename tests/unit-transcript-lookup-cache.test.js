'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findTranscriptByCCSessionId: find, migrateTranscriptsForCwdChange: migrate, projectSlug } = require('../core/claude-transcript-locator');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lookup-cache-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('hub-lookup-cache-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const roots = ['account-a', 'account-b'].map(name => path.join(home, name, 'projects'));
  const write = (root, bucket, id = 'session') => {
    const file = path.join(root, bucket, id + '.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    return file;
  };
  return { home, roots, write };
}

test('命中缓存不再遍历目录，文件移走后重新查找', t => {
  const { home, roots, write } = fixture(t);
  const first = write(roots[0], 'old');
  const read = t.mock.method(fs, 'readdirSync');
  assert.equal(find('session', home, roots), first);
  const scans = read.mock.callCount();
  assert.equal(find('session', home, [...roots]), first);
  assert.equal(read.mock.callCount(), scans);
  fs.unlinkSync(first);
  const next = write(roots[0], 'new');
  assert.equal(find('session', home, roots), next);
  assert.ok(read.mock.callCount() > scans);
});

test('未命中只缓存 3 秒，新文件在到期后可被发现', t => {
  const { home, roots, write } = fixture(t);
  let clock = 10000;
  t.mock.method(Date, 'now', () => clock);
  assert.equal(find('session', home, roots), null);
  const file = write(roots[0], 'new');
  const read = t.mock.method(fs, 'readdirSync');
  clock += 2999;
  assert.equal(find('session', home, roots), null);
  assert.equal(read.mock.callCount(), 0);
  clock += 1;
  assert.equal(find('session', home, roots), file);
});

test('缓存区分 home、账号根目录及根目录优先顺序', t => {
  const { home, roots, write } = fixture(t);
  const a = write(roots[0], 'cwd'), b = write(roots[1], 'cwd');
  assert.equal(find('session', home, [roots[0]]), a);
  assert.equal(find('session', home, [roots[1]]), b);
  assert.equal(find('session', home, roots), a);
  assert.equal(find('session', home, [...roots].reverse()), b);
  assert.equal(find('missing', home, roots), null);
  const other = path.join(home, 'other-home');
  const file = write(roots[0], 'cwd', 'missing');
  assert.equal(find('missing', other, roots), file);
  assert.equal(find('missing', home, roots), null);
});

test('归档后同账号各作用域立即指向新副本，另一账号缓存保持原样', t => {
  const { home, roots, write } = fixture(t);
  const a = write(roots[0], 'old'), b = write(roots[1], 'old');
  const defaultRoot = path.join(home, '.claude', 'projects');
  // 默认账号另测一次，确保没有显式根目录的调用也能改指归档副本。
  const original = write(defaultRoot, 'old', 'default-session');
  assert.equal(find('default-session', home), original);
  assert.equal(find('session', home, roots), a);
  assert.equal(find('session', home, [roots[1]]), b);
  const toCwd = path.join(home, '正式归档');
  const result = migrate({ homeDir: home, configDir: path.dirname(roots[0]), toCwd, ccSessionIds: ['session'] });
  const target = path.join(roots[0], projectSlug(toCwd), 'session.jsonl');
  assert.deepEqual(result, { copied: [target], missing: [], errors: [] });
  fs.appendFileSync(target, '{"new":true}\n');
  assert.equal(find('session', home, roots), target);
  assert.equal(find('session', home, [roots[0]]), target);
  assert.equal(find('session', home, [roots[1]]), b);
  assert.equal(fs.readFileSync(a, 'utf8'), '{}\n');
  assert.match(fs.readFileSync(find('session', home, roots), 'utf8'), /new/);
  const moved = migrate({ homeDir: home, toCwd, ccSessionIds: ['default-session'] });
  assert.equal(find('default-session', home), moved.copied[0]);
  assert.notEqual(moved.copied[0], original);
});
