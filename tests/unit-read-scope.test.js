'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withReadScope, readTextInScope } = require('../core/read-scope');
const pool = require('../core/codeagent-pool');
const models = require('../core/codeagent-models');
const quota = require('../core/codeagent-quota');

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-scope-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = pool.addAccount(dataDir, { note: 'acct' + i });
    ids.push(id);
    const dir = pool.accountDir(dataDir, id);
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'fixture', accountId: 'user' + i, expiresAt: Date.now() + 3600e3 } }));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'model-' + i }));
    models.recordMenu(dataDir, ['model-' + i, 'shared-model'], { key: id, complete: true });
  }
  quota.markAvoid(dataDir, ids[1], { source: 'manual', reason: 'x', until: null });
  return { dataDir, ids };
}
// 记录每个文件被 readFileSync 的次数。
function countReads(t) {
  const original = fs.readFileSync;
  const counts = new Map();
  fs.readFileSync = function (file, ...rest) {
    const key = path.basename(String(file));
    counts.set(key, (counts.get(key) || 0) + 1);
    return original.call(this, file, ...rest);
  };
  t.after(() => { fs.readFileSync = original; });
  return { counts, reset: () => counts.clear() };
}
const snapshot = dataDir => {
  const accounts = pool.withPauseStatus(dataDir, pool.listAccounts(dataDir));
  return { accounts, avoid: quota.activeAvoid(dataDir, Date.now()), credit: quota.creditReadings(dataDir), modelAvoid: quota.modelAvoidAll(dataDir) };
};

test('一次快照内共享文件只读一次，凭据仍按账号各读各的，输出逐字段不变', t => {
  const { dataDir } = fixture(t);
  const plain = snapshot(dataDir);
  const reads = countReads(t);
  snapshot(dataDir);
  assert.equal(reads.counts.get('codeagent-account-menu-models.json'), 5, '对照：作用域外每个号读一次');
  const before = reads.counts.get('quota-avoid.json');
  assert.ok(before >= 3, `对照：作用域外暂停状态重复读 ${before} 次`);
  reads.reset();
  const scoped = withReadScope(() => snapshot(dataDir));
  assert.equal(reads.counts.get('codeagent-account-menu-models.json'), 1);
  assert.equal(reads.counts.get('quota-avoid.json'), 1);
  assert.ok(reads.counts.get('.credentials.json') >= 5, '凭据不进作用域');
  assert.deepEqual(scoped, plain);
});

test('作用域结束即失效：外部改了菜单、暂停，下一次快照立刻看到', t => {
  const { dataDir, ids } = fixture(t);
  const first = withReadScope(() => snapshot(dataDir));
  assert.ok(first.accounts[1].avoid);
  assert.ok(!first.accounts[0].models.includes('newly-granted'));
  quota.clearAvoid(dataDir, ids[1], { by: 'test' });
  models.recordMenu(dataDir, ['model-0', 'newly-granted'], { key: ids[0], complete: true });
  const second = withReadScope(() => snapshot(dataDir));
  assert.equal(second.accounts[1].avoid, null);
  assert.ok(second.accounts[0].models.includes('newly-granted'));
});

test('各账号拿到独立对象，模型权限不串号', t => {
  const { dataDir, ids } = fixture(t);
  withReadScope(() => {
    const a = models.readMenuEntry(dataDir, ids[0]), b = models.readMenuEntry(dataDir, ids[1]);
    assert.ok(a.models.includes('model-0') && !a.models.includes('model-1'));
    assert.ok(b.models.includes('model-1') && !b.models.includes('model-0'));
    a.models.push('polluted');
    assert.ok(!models.readMenuEntry(dataDir, ids[0]).models.includes('polluted'));
    const all = quota.modelAvoidAll(dataDir);
    all.polluted = {};
    assert.equal(quota.modelAvoidAll(dataDir).polluted, undefined);
  });
});

test('读失败和坏文件与不开作用域时一样，失败也不重复读', t => {
  const { dataDir, ids } = fixture(t);
  const menu = path.join(dataDir, 'codeagent-account-menu-models.json');
  fs.rmSync(menu);
  const missingPlain = models.readMenuEntry(dataDir, ids[0]);
  const reads = countReads(t);
  const missingScoped = withReadScope(() => [models.readMenuEntry(dataDir, ids[0]), models.readMenuEntry(dataDir, ids[1])]);
  assert.deepEqual(missingScoped, [missingPlain, null]);
  assert.equal(reads.counts.get('codeagent-account-menu-models.json'), 1);
  fs.writeFileSync(menu, '{broken');
  assert.equal(withReadScope(() => models.readMenuEntry(dataDir, ids[0])), null);
  assert.throws(() => withReadScope(() => readTextInScope(path.join(dataDir, 'absent.json'))), { code: 'ENOENT' });
});

test('传入替身 fs 时不进作用域；计算抛错后作用域也会清掉', t => {
  const { dataDir } = fixture(t);
  const file = path.join(dataDir, 'pool-note.txt');
  fs.writeFileSync(file, 'one');
  let calls = 0;
  const stub = { readFileSync: () => { calls++; return 'stub'; } };
  withReadScope(() => {
    assert.equal(readTextInScope(file, stub), 'stub');
    assert.equal(readTextInScope(file, stub), 'stub');
  });
  assert.equal(calls, 2);
  assert.throws(() => withReadScope(() => { throw new Error('boom'); }), /boom/);
  assert.equal(readTextInScope(file), 'one');
  fs.writeFileSync(file, 'two');
  assert.equal(readTextInScope(file), 'two', '作用域外不缓存');
});
