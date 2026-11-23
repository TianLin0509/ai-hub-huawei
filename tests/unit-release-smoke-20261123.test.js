'use strict';
// 发版冒烟调度（scripts/release-smoke.js）与 Electron 路径解析（tests/helpers/hub-launcher.js）的单测：
// 不起 Hub，用三个假路径脚本验证「失败自动重跑一次再判」、失败时给出日志位置、全过时清理临时数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { runSmoke, describe } = require('../scripts/release-smoke');
const { resolveElectronExe } = require('./helpers/hub-launcher');

const cleanup = summary => { for (const r of summary.results) for (const a of r.attempts) fs.rmSync(a.tmp, { recursive: true, force: true }); };
function fixture() {
  const entry = fs.mkdtempSync(path.join(os.tmpdir(), 'release-smoke-unit-'));
  fs.mkdirSync(path.join(entry, 'tests'));
  fs.writeFileSync(path.join(entry, 'tests', 'pass.js'), "require('fs').writeFileSync(require('path').join(process.env.TEMP,'x.txt'),'1');console.log('PASS ok')");
  // 第一次失败、第二次通过：用调度传进来的临时目录之外的标记文件区分次数
  fs.writeFileSync(path.join(entry, 'tests', 'flaky.js'), `const f=${JSON.stringify(path.join(entry, 'flaky.mark'))};if(!require('fs').existsSync(f)){require('fs').writeFileSync(f,'');console.error('FAIL first');process.exit(1)}console.log('PASS second')`);
  fs.writeFileSync(path.join(entry, 'tests', 'broken.js'), "console.error('FAIL 群聊回车发不出');process.exit(1)");
  fs.writeFileSync(path.join(entry, 'tests', 'hang.js'), 'setTimeout(()=>{},60000)');
  return entry;
}

test('失败路径自动重跑一次，两次都挂才判坏，并写明日志位置', async () => {
  const entry = fixture();
  const paths = [
    { id: 'pass', name: '直接通过', script: 'tests/pass.js', outEnv: 'HUB_E2E_ARTIFACT_DIR', timeoutMs: 30000 },
    { id: 'flaky', name: '偶发失败', script: 'tests/flaky.js', timeoutMs: 30000 },
    { id: 'broken', name: '群聊回车', script: 'tests/broken.js', timeoutMs: 30000 },
  ];
  const summary = await runSmoke({ entry, paths, jobs: 2, dir: path.join(entry, 'run') }).promise;
  assert.equal(summary.ok, false);
  const by = Object.fromEntries(summary.results.map(r => [r.id, r]));
  assert.equal(by.pass.ok, true); assert.equal(by.pass.attempts.length, 1);
  assert.equal(by.flaky.ok, true); assert.equal(by.flaky.flaky, true); assert.equal(by.flaky.attempts.length, 2);
  assert.equal(by.broken.ok, false); assert.equal(by.broken.attempts.length, 2);
  const text = describe(summary);
  assert.match(text, /✗ 群聊回车/);
  assert.match(text, /群聊回车发不出/);
  assert.ok(text.includes(by.broken.attempts[1].log));
  assert.ok(fs.existsSync(path.join(summary.dir, 'release-smoke-summary.json')));
  cleanup(summary);
});

test('全部通过时删掉可重建的临时数据；超时算失败', async () => {
  const entry = fixture();
  const ok = await runSmoke({ entry, paths: [{ id: 'pass', name: '直接通过', script: 'tests/pass.js', timeoutMs: 30000 }], dir: path.join(entry, 'run-ok') }).promise;
  assert.equal(ok.ok, true);
  assert.equal(fs.existsSync(ok.results[0].attempts[0].tmp), false);
  const slow = await runSmoke({ entry, paths: [{ id: 'hang', name: '卡住', script: 'tests/hang.js', timeoutMs: 1500 }], dir: path.join(entry, 'run-hang') }).promise;
  assert.equal(slow.ok, false);
  assert.equal(slow.results[0].attempts[0].timedOut, true);
  cleanup(slow);
});

test('未知路径名直接报错', () => {
  assert.throws(() => runSmoke({ only: ['nope'] }), /没有这些冒烟路径/);
});

test('工作树没有自己的 Electron 时回落到主仓库', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-wt-'));
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-main-'));
  const exe = path.join(main, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, '');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
  assert.equal(resolveElectronExe(wt, {}), exe);
  assert.equal(resolveElectronExe(wt, { HUB_TEST_ELECTRON_EXE: exe }), exe);
  // 哪都找不到时返回本工作树路径，报错信息指向它
  fs.rmSync(exe);
  assert.equal(resolveElectronExe(wt, {}), path.join(wt, 'node_modules', 'electron', 'dist', path.basename(exe)));
});

// ---- 2026-11-24 审查修复：收尾校验、启动即退不白等、跳过冒烟随登记排队 ----
test('退出码 0 但测试 Hub 没收干净：按 PID 结束残留并判失败；只有首次残留时算重跑通过', async () => {
  const entry = fixture();
  const killed = [];
  let calls = 0;
  const paths = [{ id: 'pass', name: '直接通过', script: 'tests/pass.js', timeoutMs: 30000 }];
  const dirty = await runSmoke({ entry, paths, dir: path.join(entry, 'run-dirty'), teardownPauseMs: 10,
    findLeftovers: async () => [4242], killPid: pid => killed.push(pid) }).promise;
  assert.equal(dirty.ok, false);
  assert.equal(dirty.results[0].attempts.length, 2);
  assert.deepEqual(dirty.results[0].attempts[0].teardown.leftovers, [4242]);
  assert.deepEqual(killed, [4242, 4242]);
  assert.match(describe(dirty), /测试 Hub 没收干净/);
  cleanup(dirty);
  const once = await runSmoke({ entry, paths, dir: path.join(entry, 'run-once'), teardownPauseMs: 10,
    findLeftovers: async () => (++calls <= 4 ? [7] : []), killPid: () => {} }).promise;
  assert.equal(once.ok, true);
  assert.equal(once.results[0].flaky, true);
  cleanup(once);
});

test('残留进程在宽限期内自己散掉不算失败；查询失败不拦车', async () => {
  const { checkTeardown } = require('../scripts/release-smoke');
  let n = 0;
  assert.deepEqual(await checkTeardown('x', async () => (++n < 2 ? [1] : []), () => { throw Error('不该杀'); }, 1), { checked: true, leftovers: [] });
  assert.deepEqual(await checkTeardown('x', async () => null, () => {}, 1), { checked: false, leftovers: [] });
});

test('真实扫描能按目录名找到子进程，且不误认查询自己', async () => {
  if (process.platform !== 'win32') return;
  const { findLeftovers } = require('../scripts/release-smoke');
  const needle = path.join(os.tmpdir(), 'hs-unit-probe-' + process.pid);
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)', needle], { windowsHide: true });
  try {
    await new Promise(r => setTimeout(r, 500));
    assert.ok((await findLeftovers(needle)).includes(child.pid));
    assert.deepEqual(await findLeftovers(needle + '-none'), []);
  } finally { child.kill(); }
});

test('等 CDP 时 Hub 已退出就立刻放弃，不等满超时', async () => {
  const { _waitForCDP } = require('./helpers/hub-launcher');
  const t = Date.now();
  assert.equal(await _waitForCDP(1, 90000, () => true), null);
  assert.ok(Date.now() - t < 1000);
});
