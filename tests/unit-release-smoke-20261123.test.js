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
  // 重跑通过：首次失败那份隔离数据也删掉；两次都挂的留着排查
  assert.equal(fs.existsSync(by.flaky.attempts[0].tmp), false);
  assert.equal(fs.existsSync(by.broken.attempts[1].tmp), true);
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
    // 忙机器上子进程要过几秒才出现在进程表里
    let seen = [];
    for (const end = Date.now() + 15000; Date.now() < end && !(seen || []).includes(child.pid);) { await new Promise(r => setTimeout(r, 500)); seen = await findLeftovers(needle); }
    assert.ok((seen || []).includes(child.pid), JSON.stringify(seen));
    assert.deepEqual(await findLeftovers(needle + '-none'), []);
  } finally { child.kill(); }
});

test('等 CDP 时 Hub 已退出就立刻放弃，不等满超时', async () => {
  const { _waitForCDP } = require('./helpers/hub-launcher');
  const t = Date.now();
  assert.equal(await _waitForCDP(1, 90000, () => true), null);
  assert.ok(Date.now() - t < 1000);
});

// ---- 2026-11-24 首班实测修复：预检同步阻塞时不再把已通过的路径误判超时 ----
test('发版进程被同步预检卡住时，独立调度子进程照常计时，已通过的路径不被误判超时；调度跑在低优先级', async () => {
  const entry = fixture();
  const wrapper = path.join(entry, 'sched.js');
  // 替身调度：用真 runSmoke 跑一条 8 秒超时的路径（忙机器上 node 起动也要几秒），参数格式和 release-smoke.js 命令行一致
  fs.writeFileSync(wrapper, `const s=require(${JSON.stringify(path.resolve(__dirname, '../scripts/release-smoke'))});
const dir=process.argv[process.argv.indexOf('--out')+1];
s.runSmoke({entry:${JSON.stringify(entry)},dir,paths:[{id:'pass',name:'直接通过',script:'tests/pass.js',timeoutMs:8000}],findLeftovers:async()=>[]}).promise.then(r=>process.exitCode=r.ok?0:1);`);
  const { runSmokeDetached } = require('../scripts/release-smoke');
  const run = runSmokeDetached({ entry, dir: path.join(entry, 'run-detached'), script: wrapper });
  if (process.platform === 'win32') assert.equal(os.getPriority(run.pid), os.constants.priority.PRIORITY_BELOW_NORMAL);
  const until = Date.now() + 10000; while (Date.now() < until) { /* 模拟预检同步执行 10 秒，超过路径超时 */ }
  const summary = await run.promise;
  assert.equal(summary.ok, true, JSON.stringify(summary));
  assert.equal(summary.results[0].attempts.length, 1);
  assert.equal(summary.results[0].attempts[0].timedOut, false);
});

test('调度子进程没写出汇总就退出：判失败并指明调度日志；中途打断会结束调度子进程', async () => {
  const entry = fixture();
  const { runSmokeDetached } = require('../scripts/release-smoke');
  const crash = path.join(entry, 'crash.js'); fs.writeFileSync(crash, 'process.exit(3)');
  const bad = await runSmokeDetached({ entry, dir: path.join(entry, 'run-crash'), script: crash }).promise;
  assert.equal(bad.ok, false);
  assert.match(describe(bad), /冒烟调度进程异常结束.*release-smoke-scheduler\.log/);
  const hang = path.join(entry, 'hang-sched.js'); fs.writeFileSync(hang, 'setTimeout(()=>{},600000)');
  const run = runSmokeDetached({ entry, dir: path.join(entry, 'run-abort'), script: hang });
  const t = Date.now();
  run.abort();
  assert.equal((await run.promise).ok, false);
  assert.ok(Date.now() - t < 120000, '打断后调度进程没结束'); // 忙机器上 taskkill 也要几十秒
});

test('超时时区分「步骤都过了只是不退出」与「卡在某一步」，两种都判失败', () => {
  const { looksPassed } = require('../scripts/release-smoke');
  assert.equal(looksPassed('PASS 1 首页\nPASS 4 问问 Hub\n{"ok":true}'), true);
  assert.equal(looksPassed('E2E group-enter-send: PASS'), true);
  assert.equal(looksPassed('PASS 1 首页\nFAIL 3 新建普通会话'), false);
  assert.equal(looksPassed('等待 CDP…'), false);
  const mk = exitStuck => ({ dir: 'x', seconds: 1, ok: false, results: [{ name: '核心', ok: false, attempts: [{ ok: false, timedOut: true, exitStuck, seconds: 420, log: 'l', out: 'o', tmp: 't', tail: '' }] }] });
  assert.match(describe(mk(true)), /步骤都过了，但 420 秒内进程没退出/);
  assert.match(describe(mk(false)), /✗ 核心（420s，超时/);
});

// ---- 2026-11-24 机器忙时误拦：失败项最后逐条独占重跑，首轮并发 2 ----
test('失败项不在并行里当场重跑：等首轮全部结束后逐条独占重跑；真坏的独占重跑仍判失败', async () => {
  const entry = fixture();
  const trace = path.join(entry, 'trace.log');
  // 每个脚本记录起止时间；flaky 类第一次失败（标记文件区分次数）
  const mk = (id, { failFirst = false, alwaysFail = false, ms = 300 }) => fs.writeFileSync(path.join(entry, 'tests', id + '.js'), `
const fs=require('fs'),T=${JSON.stringify(trace)},m=${JSON.stringify(path.join(entry, id + '.mark'))};
fs.appendFileSync(T,'start ${id} '+Date.now()+require('os').EOL);
setTimeout(()=>{fs.appendFileSync(T,'end ${id} '+Date.now()+require('os').EOL);
let bad=${alwaysFail};if(${failFirst}&&!fs.existsSync(m)){fs.writeFileSync(m,'');bad=true}
if(bad){console.error('FAIL ${id}');process.exit(1)}console.log('PASS ${id}')},${ms});`);
  mk('a', { failFirst: true }); mk('b', { alwaysFail: true }); mk('c', { ms: 1500 });
  const paths = ['a', 'b', 'c'].map(id => ({ id, name: id, script: `tests/${id}.js`, timeoutMs: 30000 }));
  const summary = await runSmoke({ entry, paths, dir: path.join(entry, 'run-serial'), findLeftovers: async () => [] }).promise;
  const by = Object.fromEntries(summary.results.map(r => [r.id, r]));
  assert.equal(by.a.ok, true); assert.equal(by.a.flaky, true); assert.equal(by.a.attempts[1].exclusive, true);
  assert.equal(by.b.ok, false); assert.equal(by.b.attempts.length, 2);
  assert.equal(by.c.attempts.length, 1);
  assert.equal(summary.ok, false);
  // 按时间重放：同一时刻在跑的个数首轮 ≤2，重跑期间只有 1 个，且重跑都在首轮全部结束之后
  const ev = fs.readFileSync(trace, 'utf8').trim().split('\n').map(l => l.split(' ')).map(([k, id, t]) => ({ k, id, t: +t })).sort((x, y) => x.t - y.t);
  let running = 0, max = 0;
  const firstRoundEnd = Math.max(...ev.filter(e => e.k === 'end').slice(0, 3).map(e => e.t));
  const starts = { a: [], b: [] };
  for (const e of ev) { if (e.k === 'start') { running++; max = Math.max(max, running); if (starts[e.id]) starts[e.id].push(e.t); } else running--; }
  assert.ok(max <= 2, '首轮并发超过 2：' + max);
  assert.ok(starts.a[1] >= firstRoundEnd && starts.b[1] >= firstRoundEnd, '重跑早于首轮结束');
  const retryEv = ev.filter(e => e.t >= firstRoundEnd && !(e.k === 'end' && e.t === firstRoundEnd));
  let r2 = 0; for (const e of retryEv) { r2 += e.k === 'start' ? 1 : -1; assert.ok(r2 <= 1, '重跑不是独占'); }
  assert.match(describe(summary), /✓ a（.*独占重跑通过/);
  assert.match(describe(summary), /✗ b（.*独占重跑仍失败/);
  cleanup(summary);
});

test('独占重跑用普通优先级（首轮测试 Hub 低优先级，机器被占满时会被饿死）', async () => {
  const entry = fixture();
  const rec = path.join(entry, 'prio.log');
  fs.writeFileSync(path.join(entry, 'tests', 'prio.js'), `const fs=require('fs'),os=require('os'),m=${JSON.stringify(path.join(entry, 'prio.mark'))};
fs.appendFileSync(${JSON.stringify(rec)},JSON.stringify({env:process.env.HUB_TEST_PRIORITY||null,prio:os.getPriority()})+os.EOL);
if(!fs.existsSync(m)){fs.writeFileSync(m,'');process.exit(1)}console.log('PASS')`);
  const summary = await runSmoke({ entry, paths: [{ id: 'prio', name: 'prio', script: 'tests/prio.js', timeoutMs: 30000 }], dir: path.join(entry, 'run-prio'), findLeftovers: async () => [] }).promise;
  assert.equal(summary.ok, true);
  const [first, second] = fs.readFileSync(rec, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(first.env, null);
  assert.equal(second.env, 'normal');
  if (process.platform === 'win32') assert.equal(second.prio, os.constants.priority.PRIORITY_NORMAL);
  cleanup(summary);
});

// ---- 2026-11-24 开跑前看负载：持续 >90% 先等（最多约 10 分钟），结果写明当时负载 ----
test('机器忙时先等负载降下来再跑，结果里写明开跑时和期间的负载', async () => {
  const entry = fixture();
  const seq = [{ total: 99, others: 97, excluded: true }, { total: 96, others: 93, excluded: true }, { total: 70, others: 40, excluded: true }];
  const waits = [];
  const summary = await runSmoke({ entry, paths: [{ id: 'pass', name: '直接通过', script: 'tests/pass.js', timeoutMs: 30000 }], dir: path.join(entry, 'run-load'),
    findLeftovers: async () => [], onProgress: e => { if (e.event === 'load-wait') waits.push(e.load.others); },
    loadGate: { sample: async () => seq.shift(), pauseMs: 10, maxWaitMs: 60000, tickMs: 50 } }).promise;
  assert.equal(summary.ok, true);
  assert.deepEqual(waits, [97, 93]);
  assert.equal(summary.load.gaveUp, false);
  assert.equal(summary.load.atStart.others, 40);
  assert.ok('during' in summary.load); // 跑得太快时可能一次都没采到，记 null
  assert.match(describe(summary), /机器负载：开跑时全机 CPU 70%，扣除发版自身后 40%/);
  cleanup(summary);
});

test('一直满载：等满上限照常跑，失败时提示可能是环境原因', async () => {
  const entry = fixture();
  const t = Date.now();
  const summary = await runSmoke({ entry, paths: [{ id: 'broken', name: '群聊回车', script: 'tests/broken.js', timeoutMs: 30000 }], dir: path.join(entry, 'run-busy'),
    findLeftovers: async () => [], loadGate: { sample: async () => ({ total: 100, others: 99, excluded: false }), pauseMs: 100, maxWaitMs: 500 } }).promise;
  assert.ok(Date.now() - t < 20000);
  assert.equal(summary.load.gaveUp, true);
  assert.equal(summary.results[0].attempts.length, 2, '等满仍照常跑完（含重跑）');
  const text = describe(summary);
  assert.match(text, /高于 90%，等了 \d+ 秒仍忙，照常跑/);
  assert.match(text, /失败可能是环境原因/);
  cleanup(summary);
});

test('真实采样：返回全机与扣除自身后的 CPU 百分比', async () => {
  const { sampleLoad } = require('../scripts/release-smoke');
  const s = await sampleLoad({ excludePid: process.pid, windowMs: 1000 });
  assert.ok(s.total >= 0 && s.total <= 100, JSON.stringify(s));
  assert.ok(s.others >= 0 && s.others <= s.total, JSON.stringify(s));
  if (process.platform === 'win32') assert.equal(s.excluded, true, JSON.stringify(s));
});
