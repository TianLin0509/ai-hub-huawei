'use strict';
// P2 分层 Job Object 三层接入 + 低开销模式 EcoQoS 联动（2026-11-23）。
// 前两条是真实 Windows 端到端：真 SessionManager + 真 node-pty 终端（第 1 层）与真 ServeHost（第 2 层，假 serve 进程）共用一个 broker，
// 验证关会话时先 pty.kill、根进程退出后才结束第 1 层盒子，且绝不碰第 2 层；其余用替身验证各层生命周期与 EcoQoS 策略。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const WIN = process.platform === 'win32';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(fn, timeoutMs = 10000, stepMs = 50) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return true; await sleep(stepMs); }
  return !!(await fn());
}
const quiet = { warn() {}, info() {}, log() {} };
const tmp = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 进程刚退出时可能还占着 */ } }); return d; };

// 假 serve：在给定端口应答健康检查，并派生一个脱离父进程的孙进程（模拟 bun 打包的 serve 和它的 MCP），孙进程号写进文件。
const FAKE_SERVE = `
const http = require('http'); const fs = require('fs'); const { spawn } = require('child_process');
const port = Number(process.argv[1]), pidFile = process.argv[2];
const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', windowsHide: true }); kid.unref();
fs.writeFileSync(pidFile, String(kid.pid));
http.createServer((req, res) => { res.writeHead(200); res.end('{}'); }).listen(port, '127.0.0.1');`;
function fakeServeSpawner(dir, t) {
  const spawned = [];
  const impl = ({ port }) => {
    const pidFile = path.join(dir, `serve-kid-${port}.txt`);
    const proc = spawn(process.execPath, ['-e', FAKE_SERVE, String(port), pidFile], { windowsHide: true, stdio: 'ignore' });
    const rec = { proc, pidFile, kid: () => { try { return Number(fs.readFileSync(pidFile, 'utf8')); } catch { return 0; } } };
    spawned.push(rec);
    t.after(() => { for (const pid of [proc.pid, rec.kid()]) if (pid) { try { process.kill(pid); } catch { /* 已结束 */ } } });
    return proc;
  };
  return { impl, spawned };
}

async function ptyScenario(t, { jobs }) {
  const dir = tmp(t, 'p2-l1-');
  const saved = { data: process.env.CLAUDE_HUB_DATA_DIR, scope: process.env.AI_HUB_WIN32_JOB_PTY };
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  process.env.AI_HUB_WIN32_JOB_PTY = 'all'; // 用 PowerShell 终端代替 CodeAgent 终端（同一条启动与关闭路径）
  t.after(() => {
    for (const [k, v] of [['CLAUDE_HUB_DATA_DIR', saved.data], ['AI_HUB_WIN32_JOB_PTY', saved.scope]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const jq = require('../core/win32-job-qos');
  const qos = jq.initWin32JobQos({ logger: quiet, env: jobs ? {} : { AI_HUB_WIN32_JOB_OBJECT: '0' } });
  t.after(() => jq.resetWin32JobQosForTest());
  const order = [];
  const realTerminate = qos.terminate;
  qos.terminate = key => { order.push({ step: 'terminate', key }); return realTerminate(key); };

  // 第 2 层：共享 serve（假进程）
  const { ServeHost } = require('../core/codeagent-serve-host');
  const fake = fakeServeSpawner(dir, t);
  const host = new ServeHost({ command: 'fake', configDir: path.join(dir, 'acct'), cwd: dir, env: process.env, spawnImpl: fake.impl, idleCloseMs: 60_000 });
  t.after(() => host.stop());
  await host.ensure();
  const serve = fake.spawned[0];
  assert.ok(await until(() => serve.kid() > 0));
  if (jobs) assert.ok(await until(() => qos.get(host.jobKey)?.state === 'active', 45000), '共享 serve 进了第 2 层盒子');

  // 第 1 层：真 node-pty 终端
  const { SessionManager } = require('../core/session-manager');
  const sm = new SessionManager();
  const closed = new Promise(resolve => { sm.onSessionClosed = id => resolve(id); });
  const created = await sm.createSession('powershell', { cwd: dir, cols: 100, rows: 30 });
  const id = created.id;
  const entry = sm.sessions.get(id);
  const rootPid = entry.pty.pid;
  if (jobs) assert.ok(await until(() => qos.get(sm.ptyJobKey(id))?.state === 'active', 45000), '终端进了第 1 层盒子');
  else { await sleep(1500); assert.equal(sm.ptyJobKey(id), ''); }
  const ptyKey = sm.ptyJobKey(id);
  // 在终端里用 Start-Process 拉起一个进程：它不挂在伪终端上，node-pty 关会话收不到它（就是要根治的孤儿）。
  const kidFile = path.join(dir, 'pty-kid.txt');
  sm.writeToSession(id, `$p = Start-Process -PassThru -WindowStyle Hidden -FilePath '${process.execPath}' -ArgumentList '-e','setInterval(()=>{},1000)'; $p.Id | Out-File -Encoding ascii '${kidFile}'\r`);
  assert.ok(await until(() => fs.existsSync(kidFile) && Number(fs.readFileSync(kidFile, 'utf8')) > 0, 20000), '终端里拉起了孙进程');
  const kid = Number(fs.readFileSync(kidFile, 'utf8'));
  t.after(() => { try { process.kill(kid); } catch { /* 已结束 */ } });
  const realKill = entry.pty.kill.bind(entry.pty);
  entry.pty.kill = (...args) => { order.push({ step: 'kill', rootAlive: alive(rootPid) }); return realKill(...args); };
  const realRelease = sm._releasePtyJob.bind(sm);
  sm._releasePtyJob = pty => { order.push({ step: 'exit', rootAlive: alive(rootPid) }); return realRelease(pty); };
  sm.closeSession(id);
  assert.equal(await Promise.race([closed, sleep(15000).then(() => null)]), id, '会话已关闭');
  return { qos, host, serve, sm, id, kid, rootPid, order, ptyKey };
}

test('第 1 层真实端到端：关会话先 pty.kill，根进程退出后才结束盒子，Start-Process 拉起的孙进程被收掉；共享 serve 的第 2 层盒子毫发无损', { skip: !WIN }, async t => {
  const r = await ptyScenario(t, { jobs: true });
  assert.ok(await until(() => !alive(r.kid), 10000), '终端里拉起的孙进程已被盒子结束');
  const steps = r.order.map(o => o.step);
  assert.deepEqual(steps.slice(0, 2), ['kill', 'exit'], `顺序：${JSON.stringify(r.order)}`);
  const term = r.order.findIndex(o => o.step === 'terminate');
  assert.ok(term > steps.indexOf('exit'), '盒子在根进程退出回调之后才结束');
  assert.equal(r.order[term].key, r.ptyKey);
  assert.ok(r.order.filter(o => o.step === 'terminate').every(o => o.key === r.ptyKey), '只结束了第 1 层这一个盒子');
  assert.ok(alive(r.serve.proc.pid) && alive(r.serve.kid()), '共享 serve 与它的孙进程都还在');
  assert.equal(r.qos.get(r.host.jobKey).state, 'active');
  // 第 2 层：serve 停止时整盒结束，脱离的孙进程一起收。
  const serveKid = r.serve.kid();
  await r.host.stop();
  assert.ok(await until(() => !alive(serveKid) && !alive(r.serve.proc.pid), 10000), '共享 serve 停止后孙进程一并结束');
  assert.equal(r.qos.list().length, 0, '没有残留盒子');
});

test('对照：AI_HUB_WIN32_JOB_OBJECT=0 时同样操作孙进程留存（证明是盒子收掉的），会话照常关闭', { skip: !WIN }, async t => {
  const r = await ptyScenario(t, { jobs: false });
  await sleep(1500);
  assert.equal(alive(r.kid), true, '没有盒子时 node-pty 收不到这个孙进程');
  assert.equal(r.order.filter(o => o.step === 'terminate').length, 0);
  process.kill(r.kid);
});

test('第 3 层真实：临时 serve 用完整盒结束（含脱离的孙进程），之后不留盒子', { skip: !WIN }, async t => {
  const dir = tmp(t, 'p2-l3-');
  const jq = require('../core/win32-job-qos');
  const qos = jq.initWin32JobQos({ logger: quiet, env: {} });
  t.after(() => jq.resetWin32JobQosForTest());
  const serveMod = require('../core/codeagent-serve');
  serveMod.resetTempServeShutdownForTest();
  const fake = fakeServeSpawner(dir, t);
  let inside = null;
  const result = await serveMod.withTempServe({ command: 'fake', configDir: dir, cwd: dir, spawnImpl: fake.impl, shadowHome: null, readyTimeoutMs: 15000 }, async () => {
    const keys = serveMod.tempServeJobKeys();
    await until(() => keys.every(k => qos.get(k)?.state === 'active'), 45000);
    inside = { keys, states: keys.map(k => qos.get(k)?.state), kid: fake.spawned[0].kid() };
    return { ok: true };
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(inside.keys.length, 1);
  assert.match(inside.keys[0], /^temp-serve:\d+:\d+$/);
  assert.deepEqual(inside.states, ['active']);
  assert.ok(await until(() => !alive(inside.kid), 10000), '临时 serve 的孙进程已结束');
  assert.deepEqual(serveMod.tempServeJobKeys(), []);
  assert.equal(qos.list().length, 0);
});

// ── 替身：各层生命周期 ─────────────────────────────────────────────────
function fakeQos({ eco = true } = {}) {
  const calls = [];
  const entries = new Map();
  let gen = 0;
  return {
    calls, entries,
    enabled: () => true, ecoAvailable: () => eco,
    assign(base, pid, opts) { const key = `${base}:${++gen}`; calls.push(['assign', key, pid, opts]); entries.set(key, { eco: false }); return key; },
    terminate(key) { calls.push(['terminate', key]); entries.delete(key); return Promise.resolve({ ok: true }); },
    // 同真实实现：状态没变就短路，不记调用（真实实现里也不会发命令、不会起 broker）。
    setJobEco(key, on) { const e = entries.get(key); if (e && e.eco === on) return Promise.resolve({ ok: true, unchanged: true }); calls.push(['setJobEco', key, on]); if (e) e.eco = on; return Promise.resolve({ ok: true }); },
    wake(key) { const e = entries.get(key); if (!e || !e.eco) return false; calls.push(['wake', key]); e.eco = false; return true; },
    isEco: key => entries.get(key)?.eco === true,
    setPidEco(key, pid, opts) { if (entries.get('pid:' + key)?.eco === opts.enabled) return Promise.resolve({ ok: true, unchanged: true }); calls.push(['setPidEco', key, pid, opts]); entries.set('pid:' + key, { eco: opts.enabled }); return Promise.resolve({ ok: true }); },
    wakePid(key) { const e = entries.get('pid:' + key); if (!e || !e.eco) return false; calls.push(['wakePid', key]); e.eco = false; return true; },
    pidEcoOn: key => entries.get('pid:' + key)?.eco === true,
    restoreAllEco() { calls.push(['restoreAllEco']); let n = 0; for (const e of entries.values()) if (e.eco) { e.eco = false; n += 1; } return n; },
  };
}

test('第 2 层生命周期：ServeHost 起来绑 serve:<账号>，退出/重启/停止都结束这一代盒子；有请求或读额度时唤醒', async () => {
  const hostMod = require('../core/codeagent-serve-host');
  const serveMod = require('../core/codeagent-serve');
  const q = fakeQos();
  const procs = [];
  const spawnImpl = () => { const p = new EventEmitter(); p.pid = 40000 + procs.length; procs.push(p); return p; };
  const origRequest = serveMod.request, origKill = serveMod.killTree, origOwner = serveMod.portOwner;
  serveMod.request = async () => ({ status: 200 });
  serveMod.killTree = async () => {};
  serveMod.portOwner = async () => null;
  try {
    const dir = path.join(os.tmpdir(), 'p2-host-unit');
    const host = new hostMod.ServeHost({ command: 'x', configDir: dir, cwd: os.tmpdir(), spawnImpl, jobQos: () => q });
    await host.ensure();
    const first = host.jobKey;
    assert.match(first, /^serve:.+:1$/);
    assert.equal(q.calls[0][2], 40000);
    assert.equal(q.calls[0][3].layer, 'serve');
    // 低开销模式降速中：有请求立刻唤醒。
    q.entries.get(first).eco = true;
    host.noteActivity();
    assert.deepEqual(q.calls.at(-1), ['wake', first]);
    await host.restart();
    assert.ok(q.calls.some(c => c[0] === 'terminate' && c[1] === first), '重启先结束旧一代盒子');
    const second = host.jobKey;
    assert.notEqual(second, first);
    procs[1].emit('exit', 0);
    assert.ok(q.calls.some(c => c[0] === 'terminate' && c[1] === second), '进程退出结束这一代');
    assert.equal(host.jobKey, '');
    await host.ensure();
    const third = host.jobKey;
    const thirdProc = procs[procs.length - 1];
    host.stopSync();
    const afterStopSync = q.calls.filter(c => c[0] === 'terminate' && c[1] === third).length;
    assert.equal(afterStopSync, 1, 'stopSync 结束盒子一次');
    // 进程异步晚到 exit 时不再重复结束同一代盒子（避免串扰后续测试或重复调用）。
    thirdProc.emit('exit', 0);
    assert.equal(q.calls.filter(c => c[0] === 'terminate' && c[1] === third).length, 1, 'stopSync 后晚到 exit 不重复结束盒子');
    // acquireHost / runningHost / listHosts
    const h2 = hostMod.acquireHost({ command: 'x', configDir: dir + '-2', cwd: os.tmpdir(), spawnImpl, jobQos: () => q });
    await h2.ensure();
    q.entries.get(h2.jobKey).eco = true;
    assert.equal(hostMod.runningHost(dir + '-2'), h2);
    assert.deepEqual(q.calls.at(-1), ['wake', h2.jobKey], '读额度借用 serve 时唤醒');
    const meta = hostMod.listHosts().find(h => h.host === h2);
    assert.equal(meta.jobKey, h2.jobKey);
    assert.equal(meta.running, true);
    await h2.stop();
    assert.ok(q.calls.some(c => c[0] === 'terminate' && c[1] === meta.jobKey));
  } finally { serveMod.request = origRequest; serveMod.killTree = origKill; serveMod.portOwner = origOwner; }
});

test('第 3 层生命周期：child-lifecycle 只给 codeagent-print 装盒（Edge 不装）；退出后注销、回收、Hub 退出都结束盒子', async () => {
  const { createChildLifecycle } = require('../core/child-lifecycle');
  const q = fakeQos();
  const killed = [];
  const lc = createChildLifecycle({ watchMs: 0, env: {}, freeMem: () => 8e9, totalMem: () => 16e9, killTree: pid => { killed.push(pid); return true; }, jobQos: () => q, logger: quiet });
  const dead = 2 ** 22 + 12345; // 不存在的进程号：pidAlive 为 false
  const a = lc.register({ pid: dead, kind: 'codeagent-print', purpose: 'auto-title', startedAt: 1000 });
  const e = lc.register({ pid: dead + 1, kind: 'edge', purpose: 'forum' });
  const assigns = q.calls.filter(c => c[0] === 'assign');
  assert.equal(assigns.length, 1, 'Edge 不进盒');
  assert.match(assigns[0][1], new RegExp(`^task:${a}:\\d+$`));
  assert.equal(assigns[0][3].expectedStartMs, 1000);
  assert.equal(lc.status().active.find(x => x.purpose === 'auto-title').jobKey, assigns[0][1]);
  lc.unregister(a);
  assert.deepEqual(q.calls.at(-1), ['terminate', assigns[0][1]], '根已退出：注销立刻结束盒子');
  const b = lc.register({ pid: dead + 2, kind: 'codeagent-print' });
  const bKey = q.calls.at(-1)[1];
  lc.reclaim(b, '超时');
  assert.ok(q.calls.some(c => c[0] === 'terminate' && c[1] === bKey), '回收结束盒子');
  const c = lc.register({ pid: dead + 3, kind: 'codeagent-print' });
  const cKey = q.calls.at(-1)[1];
  lc.shutdownSync();
  assert.ok(q.calls.some(x => x[0] === 'terminate' && x[1] === cKey), 'Hub 退出结束盒子');
  assert.ok(c && e);
  // 根还活着时注销：等它退出再结束（不打断刚交完结果、正在收尾的进程）。
  const self = lc.register({ pid: process.pid, kind: 'codeagent-print' });
  const selfKey = q.calls.at(-1)[1];
  lc.unregister(self);
  assert.ok(!q.calls.some(x => x[0] === 'terminate' && x[1] === selfKey), '根还在：暂不结束');
});

// ── EcoQoS 策略与控制器 ────────────────────────────────────────────────
test('EcoQoS 策略：只挑答完、非焦点、非忙碌、非待审批、空闲满 2 分钟的会话；serve 要全体会话空闲；搜索子进程空闲 1 分钟', () => {
  const policy = require('../core/low-overhead-policy');
  const now = 10_000_000;
  const idle = policy.ECO_QOS_IDLE_MS;
  assert.equal(idle, 120000);
  assert.equal(policy.ECO_QOS_SEARCH_IDLE_MS, 60000);
  const base = { status: 'idle', settled: true, idleMs: idle + 1 };
  const items = [
    { sessionId: 'ok', ...base },
    { sessionId: 'focused', ...base, focused: true },
    { sessionId: 'busy', ...base, status: 'running' },
    { sessionId: 'waiting', ...base, status: 'waiting' },
    { sessionId: 'starting', ...base, status: 'starting' },
    { sessionId: 'suspending', ...base, status: 'suspending' },
    { sessionId: 'approval', ...base, pendingApproval: true },
    { sessionId: 'unsettled', ...base, settled: false },
    { sessionId: 'exempt', ...base, exempt: true },
    { sessionId: 'recent', ...base, idleMs: idle - 1 },
    { sessionId: 'unknown', status: 'idle', settled: true, idleMs: NaN },
  ];
  const plan = policy.pickEcoQosTargets(items, { now });
  assert.deepEqual(plan.targets.map(i => i.sessionId), ['ok']);
  const why = Object.fromEntries(plan.skipped.map(s => [s.sessionId, s.why]));
  assert.deepEqual(why, { focused: 'focused', busy: 'busy', waiting: 'busy', starting: 'busy', suspending: 'busy', approval: 'pending-approval',
    unsettled: 'busy', exempt: 'external', recent: 'recent', unknown: 'no-activity-time' });
  const targets = new Set(['ok']);
  const host = { jobKey: 'serve:a:1', running: true, lastActivityAt: now - idle - 1 };
  assert.equal(policy.ecoQosServeTarget({ ...host, sessionIds: ['ok'] }, targets, { now }), true);
  assert.equal(policy.ecoQosServeTarget({ ...host, sessionIds: ['ok', 'focused'] }, targets, { now }), false, '有一个会话不空闲就不降');
  assert.equal(policy.ecoQosServeTarget({ ...host, sessionIds: [], lastActivityAt: now - 1000 }, targets, { now }), false, '刚有请求');
  assert.equal(policy.ecoQosSearchTarget({ pid: 5, lastRequestAt: now - 60001 }, { now }), true);
  assert.equal(policy.ecoQosSearchTarget({ pid: 5, lastRequestAt: now - 59000 }, { now }), false);
  assert.equal(policy.ecoQosSearchTarget({ pid: 5, lastRequestAt: now - 90000, busy: true }, { now }), false);
  assert.equal(policy.STRATEGY_LINES.length, 7);
  assert.match(policy.strategyHint(), /会话节能 7：.*节能调度/);
});

function controllerFixture({ on = false, eco = true } = {}) {
  const { createLowOverheadController } = require('../main/low-overhead-controller');
  const q = fakeQos({ eco });
  const mode = { on, keepAlive: 2 };
  const now = 50_000_000;
  const sm = new EventEmitter();
  const hostObj = { jobKey: 'serve:acct:1' };
  const old = now - 10 * 60_000;
  const mk = (id, extra = {}, info = {}) => [id, { startedAt: old, lastInputAt: old, lastOutputAt: old, info: { id, status: 'idle', ...info }, pty: {}, ...extra }];
  sm.sessions = new Map([
    mk('idle-a'), mk('idle-b'), mk('focused'), mk('busy', {}, { status: 'running' }), mk('recent', { lastOutputAt: now - 5000 }),
    mk('card-1', { pty: { host: hostObj } }), mk('card-2', { pty: { host: hostObj } }),
  ]);
  const keys = { 'idle-a': 'pty:idle-a:1', 'idle-b': 'pty:idle-b:2', focused: 'pty:focused:3', busy: 'pty:busy:4', recent: 'pty:recent:5' };
  for (const k of Object.values(keys)) q.entries.set(k, { eco: false });
  q.entries.set(hostObj.jobKey, { eco: false });
  sm.ptyJobKey = id => keys[id] || '';
  sm.focusedSessionId = 'focused';
  sm.getFocusedSessionState = () => ({ id: sm.focusedSessionId, focusedAt: now });
  let wakeHook = null;
  sm.setEcoWake = fn => { wakeHook = fn; };
  const search = { pid: 777, hook: null, ecoInfo: () => ({ pid: 777, startedAt: old, lastRequestAt: old, busy: false }), setRequestHook(fn) { this.hook = fn; } };
  let intervals = 0;
  const ctl = createLowOverheadController({
    getMode: () => mode, sessionManager: sm, getJobQos: () => q, getSearchService: () => search, now: () => now, logger: quiet,
    listServeHosts: () => [{ key: 'acct', host: hostObj, jobKey: hostObj.jobKey, running: true, lastActivityAt: old }],
    setIntervalFn: () => { intervals += 1; return { unref() {} }; }, clearIntervalFn: () => {},
  });
  return { ctl, q, mode, sm, search, hostObj, keys, getWake: () => wakeHook, intervals: () => intervals };
}

test('EcoQoS 控制器：默认关闭零调用（不挂钩子、不调 broker、不起定时器）', () => {
  const f = controllerFixture({ on: false });
  f.ctl.start();
  f.ctl.sync();
  assert.deepEqual(f.ctl.ecoSweep().skipped, true);
  assert.equal(f.q.calls.length, 0, '零调用');
  assert.equal(f.getWake(), null, '没有装唤醒钩子');
  assert.equal(f.sm.listenerCount('session-updated'), 0);
  assert.equal(f.search.hook, null);
  assert.equal(f.intervals(), 0);
});

test('EcoQoS 控制器：开启后只节流空闲非焦点非忙碌会话与全空闲 serve；聚焦、输入、转忙碌、读额度、关掉低开销模式立即恢复', () => {
  const f = controllerFixture({ on: true });
  f.ctl.start();
  assert.equal(f.intervals(), 1, '复用 L1 的 60 秒巡检定时器，不新加');
  assert.equal(typeof f.getWake(), 'function');
  const r = f.ctl.ecoSweep();
  const onKeys = f.q.calls.filter(c => c[0] === 'setJobEco' && c[2] === true).map(c => c[1]).sort();
  assert.deepEqual(onKeys, ['pty:idle-a:1', 'pty:idle-b:2', 'serve:acct:1'].sort(), JSON.stringify(r.on));
  assert.ok(f.q.calls.some(c => c[0] === 'setPidEco' && c[1] === 'search-child' && c[3].enabled === true && c[3].priority === false), '搜索子进程只动 EcoQoS');
  // 再巡检一次：状态没变不重复下发。
  const before = f.q.calls.length;
  f.ctl.ecoSweep();
  assert.equal(f.q.calls.length, before, '相同状态不重复调用');
  // 聚焦 / 输入：session-manager 同步调钩子。
  f.getWake()('idle-a');
  assert.deepEqual(f.q.calls.at(-1), ['wake', 'pty:idle-a:1']);
  // 卡片会话被聚焦：它用的共享 serve 立即唤醒。
  f.getWake()('card-1');
  assert.deepEqual(f.q.calls.at(-1), ['wake', 'serve:acct:1']);
  // 转忙碌：session-updated。
  f.sm.emit('session-updated', { id: 'idle-b', status: 'running' });
  assert.deepEqual(f.q.calls.at(-1), ['wake', 'pty:idle-b:2']);
  // 搜索请求
  f.search.hook();
  assert.deepEqual(f.q.calls.at(-1), ['wakePid', 'search-child']);
  // 读额度 / 显式唤醒 serve
  f.q.entries.get('serve:acct:1').eco = true;
  assert.equal(f.ctl.wakeServe('acct'), false, 'key 按 hostKey 规整（真实路径）');
  // 关闭低开销模式：钩子卸掉、全部恢复
  f.q.entries.get('pty:idle-a:1').eco = true;
  f.mode.on = false;
  f.ctl.sync();
  assert.ok(f.q.calls.some(c => c[0] === 'restoreAllEco'));
  assert.equal(f.q.isEco('pty:idle-a:1'), false);
  assert.equal(f.getWake(), null);
  assert.equal(f.sm.listenerCount('session-updated'), 0);
  assert.equal(f.search.hook, null);
  const n = f.q.calls.length;
  f.ctl.ecoSweep();
  assert.equal(f.q.calls.length, n, '关闭后巡检零调用');
});

test('EcoQoS 控制器：AI_HUB_WIN32_ECOQOS=0（ecoAvailable=false）时开启低开销模式也零调用', () => {
  const f = controllerFixture({ on: true, eco: false });
  f.ctl.start();
  f.ctl.ecoSweep();
  assert.equal(f.q.calls.length, 0);
  assert.equal(f.getWake(), null);
});

test('SessionManager：setFocusedSession / writeToSession 同步调唤醒钩子；_bindPtyJob 只绑一次，退出后结束且只结束这一代', () => {
  const jq = require('../core/win32-job-qos');
  const { SessionManager } = require('../core/session-manager');
  const q = fakeQos();
  const orig = jq.getWin32JobQos;
  jq.getWin32JobQos = () => q;
  try {
    const sm = new SessionManager();
    const woke = [];
    sm.setEcoWake(id => woke.push(id));
    const pty = { pid: 4321, write() {}, kill() {} };
    sm.sessions.set('s1', { info: { id: 's1', kind: 'codeagent', status: 'idle' }, pty, pendingTimers: [] });
    sm.setFocusedSession('s1');
    sm.writeToSession('s1', 'a');
    assert.deepEqual(woke, ['s1', 's1']);
    const key = sm._bindPtyJob('s1', pty, { pid: 4321, observedAt: 777 });
    assert.match(key, /^pty:s1:\d+$/);
    assert.equal(sm._bindPtyJob('s1', pty, { pid: 4321, observedAt: 777 }), '', '同一 PTY 不重复绑定');
    assert.deepEqual(q.calls[0].slice(2), [4321, { maxStartMs: 777, layer: 'pty' }], 'observedAt 作为出生时间上界');
    assert.equal(sm.ptyJobKey('s1'), key);
    assert.equal(sm._releasePtyJob(pty), true);
    assert.deepEqual(q.calls.at(-1), ['terminate', key]);
    assert.equal(sm._releasePtyJob(pty), false, '只结束一次');
    sm.setEcoWake(null);
    sm.setFocusedSession('s1');
    assert.equal(woke.length, 2);
    // 共享 serve 的进程号绝不进第 1 层（ACP 会话的 pid 就是共享 serve）。
    const hostMod = require('../core/codeagent-serve-host');
    const origLive = hostMod.livePids;
    hostMod.livePids = () => [9999];
    try {
      const n = q.calls.length;
      assert.equal(sm._bindPtyJob('s2', { pid: 9999 }, { pid: 9999, observedAt: 1 }), '');
      assert.equal(q.calls.length, n);
    } finally { hostMod.livePids = origLive; }
  } finally { jq.getWin32JobQos = orig; }
});

test('结构约束：PTY 盒子只在根进程退出回调里结束（kill 之前不结束）；main.js 退出时最后关 broker；asarUnpack 带上脚本', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
  const sm = read('core/session-manager.js');
  const calls = [...sm.matchAll(/this\._releasePtyJob\(/g)].length;
  assert.equal(calls, 1, '只有一处结束 PTY 盒子');
  const exitIdx = sm.indexOf('ptyProcess.onExit((exitInfo) => {');
  assert.ok(exitIdx > 0 && sm.indexOf('this._releasePtyJob(ptyProcess)', exitIdx) - exitIdx < 400, '在 onExit 回调里');
  for (const fn of ['_terminatePty(session) {', 'disposeGracefully(', '_forceTerminatePty(sessionId, session) {']) {
    const start = sm.indexOf(fn);
    const body = sm.slice(start, sm.indexOf('\n  }\n', start));
    assert.doesNotMatch(body, /win32-job-qos|_releasePtyJob/, `${fn} 不碰盒子`);
  }
  const main = read('main.js');
  const childQuit = main.indexOf("app.on('will-quit', () => { try { childLifecycle.shutdownSync(); } catch (_) {} });");
  const qosQuit = main.indexOf("app.on('quit', () => { try { win32JobQos.shutdownSync(); } catch (_) {} });");
  assert.ok(childQuit > 0 && qosQuit > childQuit, 'broker 在子进程登记收尾之后关');
  assert.equal(main.slice(qosQuit).trim().split('\n').length, 1, '注册在 main.js 最末尾（quit 晚于所有 will-quit）');
  assert.doesNotMatch(main, /will-quit[^\n]*win32JobQos/, '不再挂在 will-quit 中间');
  const pkg = JSON.parse(read('package.json'));
  for (const f of ['scripts/win32-job-qos.ps1', 'scripts/win32-job-qos.cs']) assert.ok(pkg.build.asarUnpack.includes(f), f);
  // C# 5.0：PowerShell 5.1 的 Add-Type 不认这些写法。
  const cs = read('scripts/win32-job-qos.cs');
  assert.doesNotMatch(cs, /\$"|\?\.|nameof\(|=>\s*[^;{]*;\s*$/m, 'C# 5.0 语法');
});

// ── 返工 R2（三审汇总第 4、6 条）──────────────────────────────────────
test('L7 跨模块监听：agent-turn-started（终端开工 status 仍是 idle）与 codex-session-updated（卡片会话转忙碌/待审批）都立即唤醒；关模式后摘掉', () => {
  const f = controllerFixture({ on: true });
  f.ctl.start();
  f.ctl.ecoSweep();
  assert.equal(f.q.isEco('pty:idle-a:1'), true);
  f.sm.emit('agent-turn-started', { sessionId: 'idle-a', seq: 1 });
  assert.deepEqual(f.q.calls.at(-1), ['wake', 'pty:idle-a:1']);
  assert.equal(f.q.isEco('serve:acct:1'), true);
  f.sm.emit('codex-session-updated', { id: 'card-1', status: 'running' });
  assert.deepEqual(f.q.calls.at(-1), ['wake', 'serve:acct:1'], '卡片会话转忙碌：共享 serve 唤醒');
  f.ctl.ecoSweep();
  assert.equal(f.q.isEco('serve:acct:1'), true, '再次空闲后重新降速');
  // 卡片（ACP）会话状态仍是 idle、但在等用户审批/回答（needs-input）：同样立即唤醒共享 serve。
  f.sm.emit('codex-session-updated', { id: 'card-2', status: 'idle', attentionState: 'needs-input' });
  assert.deepEqual(f.q.calls.at(-1), ['wake', 'serve:acct:1'], '卡片会话待审批：共享 serve 唤醒');
  assert.equal(f.q.isEco('serve:acct:1'), false);
  f.ctl.ecoSweep();
  assert.equal(f.q.isEco('serve:acct:1'), true);
  f.sm.emit('codex-session-updated', { id: 'card-1', status: 'waiting' });
  assert.deepEqual(f.q.calls.at(-1), ['wake', 'serve:acct:1'], '卡片会话 waiting：共享 serve 唤醒');
  f.ctl.ecoSweep();
  const n = f.q.calls.length;
  f.sm.emit('codex-session-updated', { id: 'card-1', status: 'idle' });
  assert.equal(f.q.calls.length, n, '普通 idle 更新不唤醒');
  f.mode.on = false;
  f.ctl.sync();
  assert.equal(f.sm.listenerCount('agent-turn-started'), 0);
  assert.equal(f.sm.listenerCount('codex-session-updated'), 0);
});

test('L7 活跃时间口径：卡片会话答完 1 秒（lastOutputAt=0，只有 lastCompletedAt）不降速；有后台任务的会话不降速', () => {
  const f = controllerFixture({ on: true });
  const card = f.sm.sessions.get('card-1');
  card.lastOutputAt = 0; card.lastInputAt = 0; card.startedAt = 1;
  card.info.lastCompletedAt = 50_000_000 - 1000;
  const bg = f.sm.sessions.get('idle-b');
  bg.info.nativeRuntime = { backgroundTasks: [{ id: 'sim' }] };
  f.ctl.start();
  const r = f.ctl.ecoSweep();
  const on = f.q.calls.filter(c => c[0] === 'setJobEco' && c[2] === true).map(c => c[1]);
  assert.ok(!on.includes('serve:acct:1'), '共享 serve 上有刚答完的会话：不降');
  assert.ok(!on.includes('pty:idle-b:2'), '有后台任务：不降');
  assert.ok(on.includes('pty:idle-a:1'));
  assert.equal(r.plan.skipped.find(s => s.sessionId === 'card-1').why, 'recent');
  assert.equal(r.plan.skipped.find(s => s.sessionId === 'idle-b').why, 'external');
});

test('ServeHost 加固：等端口期间被停掉不再起进程；健康检查失败先结束盒子；serve 客户端事件刷新活动时间与唤醒', async () => {
  const hostMod = require('../core/codeagent-serve-host');
  const serveMod = require('../core/codeagent-serve');
  const q = fakeQos();
  const procs = [];
  const spawnImpl = () => { const p = new EventEmitter(); p.pid = 50000 + procs.length; procs.push(p); return p; };
  const orig = { request: serveMod.request, killTree: serveMod.killTree, freePort: serveMod.freePort };
  try {
    let host;
    serveMod.freePort = async () => { host.stopped = true; return 1; };
    host = new hostMod.ServeHost({ command: 'x', configDir: path.join(os.tmpdir(), 'p2-host-stop'), cwd: os.tmpdir(), spawnImpl, jobQos: () => q });
    await host._start();
    assert.equal(procs.length, 0, '停掉后不再起进程');
    serveMod.freePort = orig.freePort;
    serveMod.request = async () => ({ status: 0 });
    serveMod.killTree = async () => {};
    const h2 = new hostMod.ServeHost({ command: 'x', configDir: path.join(os.tmpdir(), 'p2-host-fail'), cwd: os.tmpdir(), spawnImpl, jobQos: () => q, readyTimeoutMs: 50 });
    await assert.rejects(h2._start(), /未能就绪/);
    const key = q.calls.find(c => c[0] === 'assign')[1];
    assert.ok(q.calls.some(c => c[0] === 'terminate' && c[1] === key), '健康检查失败先结束盒子');
    assert.equal(typeof h2.touchActivity, 'function');
    const t0 = h2.lastActivityAt;
    await sleep(5);
    h2.touchActivity();
    assert.ok(h2.lastActivityAt > t0);
  } finally { Object.assign(serveMod, orig); }
  const client = fs.readFileSync(path.join(__dirname, '..', 'core', 'codeagent-serve-client.js'), 'utf8');
  assert.match(client, /p\.status\?\.type === 'busy'\) \|\| event\.type === 'permission\.asked' \|\| event\.type === 'question\.asked'\) this\.host\?\.noteActivity\?\.\(\)/);
  assert.match(client, /else this\.host\?\.touchActivity\?\.\(\)/);
});

test('child-lifecycle：根还活着时注销的等待定时器登记在册，Hub 退出时统一清掉', () => {
  const { createChildLifecycle } = require('../core/child-lifecycle');
  const q = fakeQos();
  const lc = createChildLifecycle({ watchMs: 0, env: {}, freeMem: () => 8e9, totalMem: () => 16e9, killTree: () => true, jobQos: () => q, logger: quiet });
  const id = lc.register({ pid: process.pid, kind: 'codeagent-print' });
  const assign = q.calls.find(c => c[0] === 'assign');
  assert.ok(assign[3].maxStartMs > 0, '带出生时间上界');
  const orig = global.clearInterval;
  let cleared = 0;
  global.clearInterval = t => { cleared += 1; return orig(t); };
  try {
    lc.unregister(id);
    lc.shutdownSync();
  } finally { global.clearInterval = orig; }
  assert.ok(cleared >= 1, '等待定时器被清掉');
});
