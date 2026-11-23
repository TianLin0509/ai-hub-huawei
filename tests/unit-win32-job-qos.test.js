'use strict';
// Windows 分层 Job Object + EcoQoS（core/win32-job-qos.js + scripts/win32-job-qos.cs）真实内核验证（2026-11-23 P2）。
// 每个用例都用一个独立的「持有者」子进程代替 Hub 主进程持有盒子句柄：用例结束结束持有者，内核会把它名下的盒子全部清掉，
// 测试不留残余进程。所有子进程无窗口（windowsHide）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createWin32JobQos, getWin32JobQos, brokerScript } = require('../core/win32-job-qos');

const WIN = process.platform === 'win32';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'win32-job-qos.ps1');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(fn, timeoutMs = 8000, stepMs = 50) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return true; await sleep(stepMs); }
  return !!(await fn());
}
const quietLogger = { warn() {}, info() {}, log() {} };

// 「根进程」：起来先派生一个脱离父进程（detached）的孙进程，之后每收到一行 stdin 再派生一个；每个孙进程号打印一行。
const ROOT_CODE = `
const { spawn } = require('child_process');
const kid = () => { const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); process.stdout.write('kid ' + c.pid + '\\n'); };
kid();
process.stdin.on('data', () => kid());
setInterval(() => {}, 1000);`;

function spawnRoot(t) {
  const proc = spawn(process.execPath, ['-e', ROOT_CODE], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const kids = [];
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = buf.slice(0, i).match(/^kid (\d+)/); buf = buf.slice(i + 1); if (m) kids.push(Number(m[1])); } });
  t.after(() => { for (const pid of [proc.pid, ...kids]) { try { process.kill(pid); } catch { /* 已结束 */ } } });
  return { proc, kids, pid: proc.pid, startedAt: Date.now(), spawnKid: () => proc.stdin.write('x\n') };
}
function spawnHolder(t) {
  const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { try { holder.kill(); } catch { /* 已结束 */ } });
  return holder;
}
function makeQos(t, holder, options = {}) {
  const qos = createWin32JobQos({ ownerPid: holder.pid, scriptPath: SCRIPT, logger: quietLogger, env: {}, ...options });
  t.after(() => qos.shutdownSync());
  return qos;
}
async function settle(qos, key) { const e = qos.get(key); assert.ok(e, 'entry exists'); await until(() => qos.get(key)?.state !== 'pending', 20000); return qos.get(key); }
function handleCount(pid) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).HandleCount`], { windowsHide: true, encoding: 'utf8' });
  return Number(String(out).trim());
}

test('分层隔离：结束 A 盒只收 A 的根与脱离的孙进程，B 盒（模拟共享 serve）根与孙进程全部存活', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder);
  const a = spawnRoot(t), b = spawnRoot(t);
  await until(() => a.kids.length >= 1 && b.kids.length >= 1);
  const keyA = qos.assign('pty:session-a', a.pid, { expectedStartMs: a.startedAt });
  const keyB = qos.assign('serve:account-b', b.pid, { expectedStartMs: b.startedAt });
  assert.match(keyA, /^pty:session-a:\d+$/);
  assert.match(keyB, /^serve:account-b:\d+$/);
  assert.equal((await settle(qos, keyA)).state, 'active');
  assert.equal((await settle(qos, keyB)).state, 'active');
  // 绑定之后再派生的孙进程自动进盒；绑定之前就有的由 assign 一并收进盒（descendants）。
  a.spawnKid(); b.spawnKid();
  await until(() => a.kids.length >= 2 && b.kids.length >= 2);
  for (const pid of [a.kids[0], a.kids[1]]) assert.equal((await qos.request('inJob', { jobHandle: qos.get(keyA).handle, pid })).inJob, true, `A 孙进程 ${pid} 在 A 盒`);
  assert.equal((await qos.request('inJob', { jobHandle: qos.get(keyA).handle, pid: b.pid })).inJob, false, 'B 根不在 A 盒');
  const res = await qos.terminate(keyA);
  assert.equal(res.ok, true);
  assert.equal(res.terminated, true);
  assert.ok(await until(() => ![a.pid, ...a.kids].some(alive)), 'A 根与全部孙进程已结束');
  assert.ok([b.pid, ...b.kids].every(alive), 'B 根与孙进程全部存活');
  assert.equal(qos.get(keyA), null);
  assert.equal(qos.get(keyB).state, 'active');
  await qos.terminate(keyB);
  assert.ok(await until(() => ![b.pid, ...b.kids].some(alive)));
});

test('Hub 硬崩：broker 空闲退出后盒子仍在（稳态 0 MB），强杀持有者后内核自动清掉盒里的根与脱离孙进程', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder, { idleExitMs: 300 });
  const b = spawnRoot(t);
  await until(() => b.kids.length >= 1);
  const key = qos.assign('serve:account', b.pid, { expectedStartMs: b.startedAt });
  assert.equal((await settle(qos, key)).state, 'active');
  b.spawnKid();
  await until(() => b.kids.length >= 2);
  const brokerPid = qos.brokerPid();
  assert.ok(brokerPid > 0);
  assert.ok(await until(() => qos.brokerPid() === 0 && !alive(brokerPid), 10000), 'broker 空闲后自己退出');
  await sleep(300);
  assert.ok([b.pid, ...b.kids].every(alive), 'broker 退出不影响盒里进程');
  holder.kill();
  assert.ok(await until(() => ![b.pid, ...b.kids].some(alive), 10000), '持有者一死，盒里进程全部被内核结束');
});

test('PID 复用防护：启动时间对不上时拒绝绑定、拒绝改 EcoQoS，进程毫发无损', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder);
  const r = spawnRoot(t);
  const key = qos.assign('pty:reused', r.pid, { expectedStartMs: Date.now() - 3600_000 });
  assert.ok(key);
  const res = await qos.get(key) && (await until(() => !qos.get(key), 20000));
  assert.ok(res, '绑定失败后条目移除');
  assert.equal(qos.stats().failed, 1);
  const eco = await qos.setPidEco('search', r.pid, { expectedStartMs: Date.now() - 3600_000, enabled: true });
  assert.equal(eco.ok, false);
  assert.equal(eco.code, 'start-mismatch');
  assert.equal(qos.pidEcoOn('search'), false);
  const described = (await qos.request('describe', { pid: r.pid })).process;
  assert.equal(described.controlMask, 0, '没有被施加 EcoQoS');
  assert.ok(alive(r.pid));
  assert.equal(qos.terminate(key) instanceof Promise, true);
  assert.equal((await qos.terminate(key)).code, 'unknown-key');
});

test('异步竞态：assign 还没回来就 terminate，拿到句柄立刻补发结束，零句柄泄漏、目标被清理', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder);
  // 先热一次 broker，持有者句柄数基线稳定后再计。
  await qos.request('ping');
  const before = handleCount(holder.pid);
  const roots = [];
  for (let i = 0; i < 6; i++) {
    const r = spawnRoot(t);
    await until(() => r.kids.length >= 1);
    const key = qos.assign('task:race-' + i, r.pid, { expectedStartMs: r.startedAt });
    assert.equal(qos.get(key).state, 'pending');
    const res = await qos.terminate(key); // 同一拍内结束
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.terminated, true);
    assert.equal(qos.get(key), null);
    roots.push(r);
  }
  assert.ok(await until(() => !roots.some(r => [r.pid, ...r.kids].some(alive))), '全部根和孙进程已结束');
  const after = handleCount(holder.pid);
  assert.ok(after - before <= 2, `持有者句柄数 ${before} → ${after}，没有泄漏 6 个盒子句柄`);
  assert.equal(qos.list().length, 0);
});

const PRIO = os.constants.priority;
async function rowsOf(qos, key) { return (await qos.request('inspect', { jobHandle: qos.get(key).handle })).processes.filter(p => p.open); }

test('EcoQoS：正常优先级的整盒开启 → 同步唤醒根进程 → 异步全量恢复；相同状态不重复唤醒 broker', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder, { idleExitMs: 400 });
  const r = spawnRoot(t);
  await until(() => r.kids.length >= 1);
  // 不依赖测试运行环境的优先级（算力账本下整棵测试进程树是低于正常）：显式设成正常再测「降了再抬回」。
  for (const pid of [r.pid, ...r.kids]) os.setPriority(pid, PRIO.PRIORITY_NORMAL);
  const key = qos.assign('pty:eco', r.pid, { expectedStartMs: r.startedAt });
  await settle(qos, key);
  const on = await qos.setJobEco(key, true);
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.ok(on.processes >= 2 && on.applied === on.processes && on.failed === 0, JSON.stringify(on));
  let rows = await rowsOf(qos, key);
  const normalAtStart = rows.filter(p => [r.pid, ...r.kids].includes(p.pid)).map(p => p.pid);
  for (const p of rows) { assert.equal(p.controlMask, 1); assert.equal(p.stateMask, 1); assert.equal(p.priorityClass, 0x4000, `pid ${p.pid} BELOW_NORMAL`); }
  assert.ok(qos.get(key).lowered.includes(`${r.pid}:${qos.get(key).startMs}`), '根进程记在「被我们降过」的清单里');
  assert.equal((await qos.setJobEco(key, true)).unchanged, true, '重复开启短路');
  const t0 = process.hrtime.bigint();
  assert.equal(qos.wake(key), true);
  const wakeUs = Number(process.hrtime.bigint() - t0) / 1000;
  assert.equal(os.getPriority(r.pid), PRIO.PRIORITY_NORMAL, '唤醒返回时根进程已回到正常优先级');
  const raiseUs = qos.stats().lastRaiseUs;
  assert.ok(raiseUs < 2000, `抬回优先级耗时 ${raiseUs}µs`);
  t.diagnostic(`同步唤醒：抬回根进程优先级 ${raiseUs.toFixed(1)}µs，整个 wake() 调用 ${wakeUs.toFixed(1)}µs`);
  assert.ok(await until(async () => {
    rows = await rowsOf(qos, key);
    return rows.every(p => p.controlMask === 0 && p.stateMask === 0) && rows.filter(p => normalAtStart.includes(p.pid)).every(p => p.priorityClass === 0x20);
  }), '整盒 EcoQoS 清除、被降过的进程回到正常');
  assert.equal(qos.get(key).dirty, false);
  assert.deepEqual(qos.get(key).lowered, []);
  assert.ok(await until(() => qos.brokerPid() === 0, 8000));
  const spawns = qos.stats().spawns;
  assert.equal((await qos.setJobEco(key, false)).unchanged, true);
  assert.equal(qos.wake(key), false, '没在降速时唤醒是空操作');
  assert.equal(qos.restoreAllEco(), 0);
  assert.equal(qos.stats().spawns, spawns, '没有为相同状态重新启动 broker');
  await qos.terminate(key);
});

test('EcoQoS 基线保护：本来就是低于正常的进程（算力账本长任务、手动降权的仿真），开关一轮后仍是低于正常', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder);
  const r = spawnRoot(t);
  await until(() => r.kids.length >= 1);
  for (const pid of [r.pid, ...r.kids]) os.setPriority(pid, PRIO.PRIORITY_BELOW_NORMAL);
  const key = qos.assign('pty:baseline', r.pid, { expectedStartMs: r.startedAt });
  await settle(qos, key);
  const on = await qos.setJobEco(key, true);
  assert.equal(on.ok, true);
  const loweredPids = on.lowered.split(',').filter(Boolean).map(x => Number(x.split(':')[0]));
  assert.ok(![r.pid, ...r.kids].some(pid => loweredPids.includes(pid)), `根与孙进程都不是我们降的（${on.lowered}）`);
  assert.equal(qos.wake(key), true);
  assert.equal(os.getPriority(r.pid), PRIO.PRIORITY_BELOW_NORMAL, '同步唤醒不抬不是我们降的根');
  let rows;
  assert.ok(await until(async () => { rows = await rowsOf(qos, key); return rows.every(p => p.controlMask === 0); }));
  for (const pid of [r.pid, ...r.kids]) assert.equal(rows.find(p => p.pid === pid).priorityClass, 0x4000, `pid ${pid} 保持 BELOW_NORMAL`);
  await qos.terminate(key);
});

test('EcoQoS 后台高 CPU 保护：盒里有进程在满负荷算（>20% 单核）时这轮不降速，10 分钟内不再试', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder);
  const busy = spawn(process.execPath, ['-e', 'for(;;){}'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { try { busy.kill(); } catch { /* 已结束 */ } });
  const key = qos.assign('pty:busy', busy.pid, { expectedStartMs: Date.now() });
  await settle(qos, key);
  const res = await qos.setJobEco(key, true);
  assert.equal(res.ok, true);
  assert.equal(res.skipped, 'cpu-busy', JSON.stringify(res));
  t.diagnostic(`盒内 CPU ${res.cpuPercent}% 单核`);
  assert.equal(qos.isEco(key), false);
  assert.equal((await rowsOf(qos, key))[0].controlMask, 0, '没有施加 EcoQoS');
  assert.equal((await qos.setJobEco(key, true)).skipped, 'cpu-busy', '冷却期内直接跳过，不再测');
  assert.equal(qos.stats().cpuSkips, 1);
  await qos.terminate(key);
});

test('EcoQoS 恢复失败不丢账：broker 起不来时保持「未落实」，熔断解除后 restoreAllEco 重试成功', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  let failSpawn = false;
  const spawnImpl = (...args) => { if (failSpawn) throw new Error('simulated spawn block'); return spawn(...args); };
  const qos = makeQos(t, holder, { idleExitMs: 200, brokerRetryMs: 300, dirtyRetryMs: 60_000, spawnImpl });
  const r = spawnRoot(t);
  await until(() => r.kids.length >= 1);
  const key = qos.assign('pty:dirty', r.pid, { expectedStartMs: r.startedAt });
  await settle(qos, key);
  assert.equal((await qos.setJobEco(key, true)).ok, true);
  assert.ok(await until(() => qos.brokerPid() === 0, 8000), 'broker 空闲退出');
  failSpawn = true;
  assert.equal(qos.wake(key), true);
  await until(() => qos.get(key).dirty === true && qos.get(key).eco === false);
  await sleep(50);
  assert.equal(qos.get(key).dirty, true, '恢复没落实：记为 dirty');
  assert.equal(qos.wake(key), false, '限速：不会每次输入都去拉 broker');
  failSpawn = false;
  await sleep(350); // 熔断解除
  assert.equal(qos.restoreAllEco(), 1, '关模式时强制重试');
  assert.ok(await until(async () => qos.get(key).dirty === false && (await rowsOf(qos, key)).every(p => p.controlMask === 0)), '重试后整盒恢复');
  await qos.terminate(key);
});

test('setPidEco 开关重叠：开、关、开连发不等回包，代次保护下最终状态与最后一次一致', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder);
  const r = spawnRoot(t);
  const opts = { expectedStartMs: r.startedAt, priority: false };
  const p1 = qos.setPidEco('s', r.pid, { ...opts, enabled: true });
  const p2 = qos.setPidEco('s', r.pid, { ...opts, enabled: false });
  const p3 = qos.setPidEco('s', r.pid, { ...opts, enabled: true });
  await Promise.all([p1, p2, p3]);
  assert.equal(qos.pidEcoOn('s'), true, '记录没被前两次的回包删掉');
  assert.equal((await qos.request('describe', { pid: r.pid })).process.controlMask, 1);
  const q1 = qos.setPidEco('s', r.pid, { ...opts, enabled: false });
  const q2 = qos.setPidEco('s', r.pid, { ...opts, enabled: true });
  const q3 = qos.setPidEco('s', r.pid, { ...opts, enabled: false });
  await Promise.all([q1, q2, q3]);
  assert.equal(qos.pidEcoRecord('s'), null);
  assert.equal((await qos.request('describe', { pid: r.pid })).process.controlMask, 0);
});

test('出生时间上界：晚于观察时刻出生的进程（号码复用）拒绝绑定；出生时间窗外也拒绝', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder);
  const r = spawnRoot(t);
  await sleep(300);
  const k1 = qos.assign('pty:late', r.pid, { maxStartMs: r.startedAt - 2000 });
  assert.ok(await until(() => !qos.get(k1), 20000), '比上界晚 2 秒出生：拒绝');
  const k2 = qos.assign('serve:early', r.pid, { minStartMs: r.startedAt + 5000, maxStartMs: r.startedAt + 8000 });
  assert.ok(await until(() => !qos.get(k2), 20000), '早于窗口：拒绝');
  const k3 = qos.assign('pty:ok', r.pid, { maxStartMs: Date.now() });
  assert.equal((await settle(qos, k3)).state, 'active', '上界之前出生：接受');
  assert.equal(qos.stats().failed, 2);
  await qos.terminate(k3);
});

// 盒内进程用 CREATE_BREAKAWAY_FROM_JOB 起子进程：默认（无 BREAKAWAY_OK）被拒绝访问；应急开关打开时允许。
const BREAKAWAY_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class P2Breakaway {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI { public int cb; public string r; public string d; public string t; public int x, y, w, h, cx, cy, fa, f; public short sw, r2; public IntPtr r3, i, o, e; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hp, ht; public int pid, tid; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  public static string Run(string exe) {
    SI si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); PI pi;
    bool ok = CreateProcessW(exe, new System.Text.StringBuilder("\\"" + exe + "\\" -e \\"setTimeout(()=>{},30000)\\""), IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000, IntPtr.Zero, null, ref si, out pi);
    return ok ? ("ok " + pi.pid) : ("err " + Marshal.GetLastWin32Error());
  }
}
'@
[Console]::Out.WriteLine([P2Breakaway]::Run($args[0]))
`;
async function breakawayAttempt(t, env) {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder, { env });
  const file = path.join(os.tmpdir(), `p2-breakaway-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(file, BREAKAWAY_PS, 'utf8');
  t.after(() => { try { fs.unlinkSync(file); } catch { /* 已删 */ } });
  // 启动器先进盒，收到信号再跑 PowerShell（它在盒里创建）。
  const launcher = spawn(process.execPath, ['-e', `process.stdin.once('data',()=>{const r=require('child_process').spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${JSON.stringify(file)},${JSON.stringify(process.execPath)}],{windowsHide:true,encoding:'utf8'});process.stdout.write(String(r.stdout||'').trim()+'\\n');});setInterval(()=>{},1000);`],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => { try { launcher.kill(); } catch { /* 已结束 */ } });
  const key = qos.assign('task:breakaway', launcher.pid, { expectedStartMs: Date.now() });
  assert.equal((await settle(qos, key)).state, 'active');
  let out = '';
  launcher.stdout.setEncoding('utf8');
  launcher.stdout.on('data', d => { out += d; });
  launcher.stdin.write('go\n');
  assert.ok(await until(() => /^(ok|err) \d+/m.test(out), 60000), out);
  const line = out.trim().split(/\r?\n/).pop();
  const m = line.match(/^ok (\d+)/);
  const child = m ? Number(m[1]) : 0;
  if (child) t.after(() => { try { process.kill(child); } catch { /* 已结束 */ } });
  const inJob = child ? (await qos.request('inJob', { jobHandle: qos.get(key).handle, pid: child })).inJob : null;
  await qos.terminate(key);
  await sleep(500);
  return { line, child, inJob, aliveAfter: child ? alive(child) : false };
}
// 实测：盒内 node 起的子进程还会被 libuv 再套一层允许脱离的盒子，CreateProcess 能成功，但只脱离 libuv 那层、仍留在我们的盒里；
// 没有 libuv 那层时直接拒绝访问（错误 5）。两种结果都等于「逃不出去」。
test('BREAKAWAY 收紧：默认盒内进程用 CREATE_BREAKAWAY_FROM_JOB 也逃不出我们的盒子，结束盒子时一起结束', { skip: !WIN }, async t => {
  const r = await breakawayAttempt(t, {});
  t.diagnostic(`默认：${r.line}，仍在盒内=${r.inJob}，结束盒子后存活=${r.aliveAfter}`);
  if (r.line === 'err 5') return;
  assert.equal(r.inJob, true, '仍在我们的盒里');
  assert.equal(r.aliveAfter, false, '随盒子结束');
});
test('BREAKAWAY 应急开关：AI_HUB_WIN32_JOB_BREAKAWAY=1 时允许显式脱盒（兼容个别必须脱盒的程序）', { skip: !WIN }, async t => {
  const r = await breakawayAttempt(t, { AI_HUB_WIN32_JOB_BREAKAWAY: '1' });
  t.diagnostic(`应急开关：${r.line}，仍在盒内=${r.inJob}，结束盒子后存活=${r.aliveAfter}`);
  assert.ok(r.child > 0, r.line);
  assert.equal(r.inJob, false, '已脱离我们的盒子');
  assert.equal(r.aliveAfter, true, '脱盒的进程没被结束盒子带走');
});

test('broker 生命周期：空闲关闭临界窗口的新请求发给新 broker；超时晚到的 assign 被认领或回收；早退熔断；shutdownSync 终态屏障', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  // 1) 空闲关闭临界窗口
  const idle = makeQos(t, holder, { idleExitMs: 120 });
  for (let i = 0; i < 6; i++) {
    assert.equal((await idle.request('ping')).ok, true, `第 ${i + 1} 轮`);
    await sleep(120 + (i % 3) * 5);
  }
  assert.ok(idle.stats().spawns >= 2, `空闲后重建了 broker（${idle.stats().spawns} 次）`);
  // 2) 超时晚到：认领
  const late = makeQos(t, holder, { requestTimeoutMs: 1 });
  const r1 = spawnRoot(t);
  const k1 = late.assign('pty:late-claim', r1.pid, { expectedStartMs: r1.startedAt });
  assert.ok(await until(() => late.get(k1)?.state === 'lost', 5000), '先超时');
  assert.ok(await until(() => late.get(k1)?.state === 'active', 20000), '晚到的句柄被认领回来');
  assert.ok(late.stats().lateAssigns >= 1);
  await late.terminate(k1);
  assert.ok(await until(() => !alive(r1.pid), 10000), '认领后照常能结束');
  // 3) 超时晚到：期间已被要求结束 → 拿到就回收（新的冷 broker，保证先超时）
  const late2 = makeQos(t, holder, { requestTimeoutMs: 1 });
  const r2 = spawnRoot(t);
  const k2 = late2.assign('pty:late-cancel', r2.pid, { expectedStartMs: r2.startedAt });
  assert.ok(await until(() => late2.get(k2)?.state === 'lost', 5000));
  assert.equal((await late2.terminate(k2)).code, 'pending-late');
  assert.ok(await until(() => !alive(r2.pid), 20000), '晚到后立刻补发结束');
  assert.ok(await until(() => !late2.get(k2), 10000), '不留账');
  // 4) 早退熔断：脚本缺失只拉起一次 PowerShell
  const broken = makeQos(t, holder, { scriptPath: path.join(os.tmpdir(), 'no-such-dir-p2', 'win32-job-qos.ps1') });
  assert.equal((await broken.request('ping')).ok, false);
  assert.equal(broken.stats().breakerOpen, true, '早退触发熔断');
  assert.equal((await broken.request('ping')).code, 'broker-unavailable');
  assert.equal(broken.stats().spawns, 1, '熔断期间不再拉起');
  // 5) 终态屏障
  const fin = makeQos(t, holder);
  const r3 = spawnRoot(t);
  const k3 = fin.assign('pty:fin', r3.pid, { expectedStartMs: r3.startedAt });
  await settle(fin, k3);
  fin.shutdownSync();
  const spawns = fin.stats().spawns;
  assert.equal(fin.assign('pty:after', r3.pid), '');
  assert.equal((await fin.setJobEco(k3, true)).skipped, 'shutting-down');
  assert.equal((await fin.setPidEco('s', r3.pid, { enabled: true })).skipped, 'shutting-down');
  assert.equal((await fin.request('ping')).code, 'shutting-down');
  assert.equal(fin.stats().spawns, spawns, '退出后不再拉起 broker');
});

test('setJobEco 在途被唤醒覆盖（1 秒 CPU 采样期间切回会话）：最终整盒全部回到正常、EcoQoS 清除、不留未落实', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder);
  const r = spawnRoot(t);
  await until(() => r.kids.length >= 1);
  for (const pid of [r.pid, ...r.kids]) os.setPriority(pid, PRIO.PRIORITY_NORMAL);
  const key = qos.assign('pty:inflight', r.pid, { expectedStartMs: r.startedAt });
  await settle(qos, key);
  const pending = qos.setJobEco(key, true); // broker 先量 1 秒 CPU 再降
  await sleep(150);
  assert.equal(qos.wake(key), true, '采样期间用户切回');
  const res = await pending;
  assert.equal(res.ok, true);
  assert.ok(res.lowered, `broker 已经降了一批：${res.lowered}`);
  let rows;
  assert.ok(await until(async () => {
    rows = await rowsOf(qos, key);
    const e = qos.get(key);
    return e.dirty === false && rows.every(p => p.controlMask === 0) && [r.pid, ...r.kids].every(pid => rows.find(p => p.pid === pid)?.priorityClass === 0x20);
  }, 15000), `最终全部回到正常：${JSON.stringify(rows)} ${JSON.stringify(qos.get(key))}`);
  assert.equal(os.getPriority(r.pid), PRIO.PRIORITY_NORMAL);
  assert.equal(qos.isEco(key), false);
  await qos.terminate(key);
});

test('setPidEco 并发开/关（带优先级）：开启回包晚于关闭发出，最终回到正常优先级、EcoQoS 清除、记录不留', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder);
  const r = spawnRoot(t);
  os.setPriority(r.pid, PRIO.PRIORITY_NORMAL);
  const opts = { expectedStartMs: r.startedAt, priority: true };
  const on = qos.setPidEco('p', r.pid, { ...opts, enabled: true });
  const off = qos.setPidEco('p', r.pid, { ...opts, enabled: false });
  await Promise.all([on, off]);
  let d;
  assert.ok(await until(async () => {
    d = (await qos.request('describe', { pid: r.pid })).process;
    return d.controlMask === 0 && d.priorityClass === 0x20 && qos.pidEcoRecord('p') === null;
  }, 15000), `最终回到正常：${JSON.stringify(d)} ${JSON.stringify(qos.pidEcoRecord('p'))}`);
  assert.equal(os.getPriority(r.pid), PRIO.PRIORITY_NORMAL);
});

test('出生时间上界严格：比观察时刻晚 250 毫秒出生的进程拒绝绑定（与 _forceTerminatePty 一致），恰好等于上界接受', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder);
  const r = spawnRoot(t);
  const birth = (await qos.request('describe', { pid: r.pid })).process.startMs;
  assert.ok(birth > 0);
  const late = qos.assign('pty:late250', r.pid, { maxStartMs: birth - 250 });
  assert.ok(await until(() => !qos.get(late), 20000), '晚 250 毫秒：拒绝');
  const early = qos.assign('pty:late1', r.pid, { maxStartMs: birth - 1 });
  assert.ok(await until(() => !qos.get(early), 20000), '晚 1 毫秒：拒绝');
  const exact = qos.assign('pty:exact', r.pid, { maxStartMs: birth });
  assert.equal((await settle(qos, exact)).state, 'active', '等于上界：接受');
  assert.equal(qos.stats().failed, 2);
  await qos.terminate(exact);
});

test('历史搜索类独立进程：setPidEco 只动 EcoQoS、不碰调用方设好的低于正常优先级', { skip: !WIN }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder);
  const r = spawnRoot(t);
  os.setPriority(r.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  const on = await qos.setPidEco('search-child', r.pid, { expectedStartMs: r.startedAt, enabled: true, priority: false });
  assert.equal(on.ok, true, JSON.stringify(on));
  let d = (await qos.request('describe', { pid: r.pid })).process;
  assert.equal(d.controlMask, 1);
  assert.equal(qos.wakePid('search-child'), true);
  assert.ok(await until(async () => { d = (await qos.request('describe', { pid: r.pid })).process; return d.controlMask === 0; }));
  assert.equal(d.priorityClass, 0x4000, '原本的低于正常优先级保持不变');
  assert.equal(qos.pidEcoOn('search-child'), false);
});

test('降级与开关：AI_HUB_WIN32_JOB_OBJECT=0 / AI_HUB_WIN32_ECOQOS=0 / 非 Windows / 非法句柄 / 脚本缺失都安静退回', async t => {
  const off = createWin32JobQos({ env: { AI_HUB_WIN32_JOB_OBJECT: '0' }, logger: quietLogger });
  assert.equal(off.enabled(), false);
  assert.equal(off.assign('pty:x', process.pid + 1), '');
  const linux = createWin32JobQos({ platform: 'linux', env: {}, logger: quietLogger });
  assert.equal(linux.enabled(), false);
  assert.equal(linux.ecoAvailable(), false);
  assert.equal(linux.assign('pty:x', 1234), '');
  assert.equal((await linux.request('ping')).code, 'not-windows');
  assert.equal(linux.stats().spawns, 0);
  // 主进程没装之前，全局实例是空壳：不起 broker、不绑定。
  assert.equal(getWin32JobQos().enabled(), false);
  assert.equal(getWin32JobQos().assign('pty:x', 1234), '');
  assert.equal(getWin32JobQos().wake('pty:x:1'), false);
  // 打包后的脚本路径：asar 里优先 app.asar.unpacked。
  assert.equal(brokerScript('C:\\App\\resources\\app.asar\\core', 'C:\\App\\resources', () => true), path.join('C:\\App\\resources', 'app.asar.unpacked', 'scripts', 'win32-job-qos.ps1'));
  assert.equal(brokerScript(path.join(__dirname, '..', 'core'), undefined), path.join(__dirname, '..', 'core', '..', 'scripts', 'win32-job-qos.ps1'));
  if (!WIN) return;
  const holder = spawnHolder(t);
  const noEco = makeQos(t, holder, { env: { AI_HUB_WIN32_ECOQOS: '0' } });
  assert.equal(noEco.ecoAvailable(), false);
  assert.equal(noEco.enabled(), true);
  const r = spawnRoot(t);
  const key = noEco.assign('pty:noeco', r.pid, { expectedStartMs: r.startedAt });
  await settle(noEco, key);
  assert.equal((await noEco.setJobEco(key, true)).code, 'eco-disabled');
  assert.equal((await noEco.setPidEco('s', r.pid, { enabled: true })).code, 'eco-disabled');
  const bad = await noEco.request('terminate', { jobHandle: 0x7ffff0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'duplicate-handle');
  assert.equal((await noEco.request('terminate', { jobHandle: 0 })).code, 'bad-handle');
  assert.equal((await noEco.request('nope')).code, 'unknown-command');
  await noEco.terminate(key);
  const missing = makeQos(t, holder, { scriptPath: path.join(os.tmpdir(), 'no-such-dir-p2', 'win32-job-qos.ps1') });
  const r2 = spawnRoot(t);
  const k2 = missing.assign('pty:missing', r2.pid, { expectedStartMs: r2.startedAt });
  assert.ok(await until(() => !missing.get(k2), 20000), '脚本缺失：绑定失败、条目移除');
  assert.ok(alive(r2.pid), '会话进程不受影响');
});

// 依据：child-lifecycle 是否把无头 Edge 放进收纳盒，取决于 Chromium 沙箱在嵌套 KILL_ON_JOB_CLOSE 盒里能否正常工作。
function findEdge() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) { const file = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'); if (fs.existsSync(file)) return file; }
  return '';
}
const EDGE = WIN ? findEdge() : '';
test('无头 Edge（同 main/edge-headless.js 的启动参数）在嵌套 KILL_ON_JOB_CLOSE 盒内能起调试端口并应答，结束盒子后整组进程不留', { skip: !EDGE && '本机没有 msedge.exe' }, async t => {
  const holder = spawnHolder(t);
  const qos = makeQos(t, holder);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-edge-'));
  t.after(async () => { await sleep(500); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Edge 刚退出时可能还占着 */ } });
  // 启动器先进盒，再由它拉起 Edge：Edge 的启动进程、接手的浏览器进程和沙箱渲染进程全部在嵌套盒里创建。
  const launcherCode = `
    process.stdin.once('data', () => {
      const { spawn } = require('child_process');
      const edge = spawn(${JSON.stringify(EDGE)}, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + ${JSON.stringify(profile)},
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-mode', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
      process.stdout.write('edge ' + edge.pid + '\\n');
    });
    setInterval(() => {}, 1000);`;
  const launcher = spawn(process.execPath, ['-e', launcherCode], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => { try { launcher.kill(); } catch { /* 已结束 */ } });
  const key = qos.assign('task:edge', launcher.pid, { expectedStartMs: Date.now() });
  assert.equal((await settle(qos, key)).state, 'active');
  launcher.stdin.write('go\n');
  const portFile = path.join(profile, 'DevToolsActivePort');
  assert.ok(await until(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim().length > 0, 30000), 'Edge 写出调试端口');
  const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  const version = await new Promise(resolve => require('node:http').get({ host: '127.0.0.1', port, path: '/json/version', timeout: 5000 }, res => {
    let body = ''; res.on('data', d => { body += d; }); res.on('end', () => resolve(body));
  }).on('error', () => resolve('')));
  assert.match(version, /Browser/, '调试协议正常应答');
  // 打开一个页面，确认沙箱渲染进程能在嵌套盒里起来。
  const opened = await new Promise(resolve => {
    const req = require('node:http').request({ host: '127.0.0.1', port, path: '/json/new?data:text/html,ok', method: 'PUT', timeout: 5000 }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve(b)); });
    req.on('error', () => resolve('')); req.end();
  });
  assert.match(opened, /"id"/, '新标签页已创建');
  await sleep(1500);
  const rows = (await qos.request('inspect', { jobHandle: qos.get(key).handle })).processes.filter(p => p.open);
  t.diagnostic(`嵌套盒内无头 Edge：调试端口 ${port} 应答正常，盒内 ${rows.length} 个进程（含启动器）`);
  assert.ok(rows.length >= 4, `Edge 浏览器、GPU/网络、渲染进程都在盒里（${rows.length} 个）`);
  const pids = rows.map(p => p.pid);
  const res = await qos.terminate(key);
  assert.equal(res.ok, true);
  assert.ok(await until(() => !pids.some(alive), 10000), '结束盒子后 Edge 整组进程全部退出');
});
