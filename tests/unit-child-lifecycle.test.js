'use strict';
// 后台子进程生命周期登记（core/child-lifecycle.js）与分身会话关闭兜底（2026-11-19，后台 Edge 越开越多）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChildLifecycle } = require('../core/child-lifecycle');

const tmpDir = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'child-lc-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const plenty = { freeMem: () => 8 * 1024 ** 3, totalMem: () => 16 * 1024 ** 3 };

test('edge 名额默认同时 1 个：第二个排队，前一个交还后才拿到', async () => {
  const lc = createChildLifecycle({ watchMs: 0, ...plenty, env: {} });
  const r1 = await lc.acquire('edge', { purpose: 'a' });
  let got2 = false;
  const p2 = lc.acquire('edge', { purpose: 'b' }).then(r => { got2 = true; return r; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(got2, false);
  assert.equal(lc.status().queued.edge, 1);
  r1();
  const r2 = await p2;
  assert.equal(got2, true);
  assert.equal(lc.status().used.edge, 1);
  r2(); r2(); // 重复交还不多算
  assert.equal(lc.status().used.edge, 0);
});

test('环境变量 CLAUDE_HUB_EDGE_MAX 可调上限；排队超时报错', async () => {
  const lc = createChildLifecycle({ watchMs: 0, ...plenty, env: { CLAUDE_HUB_EDGE_MAX: '2' } });
  const a = await lc.acquire('edge'); const b = await lc.acquire('edge');
  await assert.rejects(lc.acquire('edge', { waitMs: 30 }), e => e.code === 'CHILD_QUEUE_TIMEOUT');
  a(); b();
});

test('排队时先请闲着的实例收掉（帖子页的复用 Edge）', async () => {
  const lc = createChildLifecycle({ watchMs: 0, ...plenty, env: {} });
  const r1 = await lc.acquire('edge');
  let asked = 0;
  lc.onIdleClose(() => { asked += 1; r1(); });
  const r2 = await lc.acquire('edge');
  assert.equal(asked, 1);
  r2();
});

test('内存紧张：等不到就这次不开，名额交还', async () => {
  const lc = createChildLifecycle({ watchMs: 0, env: {}, freeMem: () => 0.5 * 1024 ** 3, totalMem: () => 16 * 1024 ** 3 });
  await assert.rejects(lc.acquire('edge', { memWaitMs: 0 }), e => e.code === 'CHILD_LOW_MEMORY');
  assert.equal(lc.status().used.edge, 0);
  assert.equal(lc.status().memory.low, true);
  assert.match(lc.status().recent[0].reason, /内存紧张/);
});

test('超过最长运行时间：按 PID 结束整棵树并删临时目录', t => {
  const dir = tmpDir(t), ud = path.join(dir, 'hub-posts-x'); fs.mkdirSync(ud);
  let clock = 1000; const killed = [];
  const lc = createChildLifecycle({ watchMs: 0, ...plenty, now: () => clock, killTree: pid => { killed.push(pid); return true; } });
  lc.register({ pid: process.pid, kind: 'edge', purpose: '帖子取数', userDataDir: ud, maxLifeMs: 5000 });
  lc.watchTick();
  assert.deepEqual(killed, []);
  clock += 6000;
  lc.watchTick();
  assert.deepEqual(killed, [process.pid]);
  assert.equal(fs.existsSync(ud), false);
  assert.equal(lc.status().active.length, 0);
  assert.match(lc.status().recent[0].reason, /超过最长运行时间/);
});

test('启动清理遗留：只结束「登记它的 Hub 已不在、PID 和启动时间都对得上」的条目；别的 Hub 还活着的原样保留', async t => {
  const dataDir = tmpDir(t);
  const file = path.join(dataDir, 'runtime', 'child-registry.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadHub = 2147480000; // 不存在的进程号
  const ud1 = path.join(dataDir, 'hub-posts-1'), ud2 = path.join(dataDir, 'hub-w3-2'); fs.mkdirSync(ud1); fs.mkdirSync(ud2);
  fs.writeFileSync(file, JSON.stringify({ entries: [
    { id: 'a', hubPid: deadHub, pid: process.pid, startedAt: 50000, kind: 'edge', purpose: '帖子取数', userDataDir: ud1 },        // 启动时间对得上 → 结束
    { id: 'b', hubPid: deadHub, pid: process.ppid, startedAt: 1, kind: 'edge', purpose: '门户待办取数', userDataDir: ud2 },        // 对不上（PID 被复用）→ 只清目录
    { id: 'c', hubPid: process.ppid, pid: 4242, startedAt: 1, kind: 'edge', purpose: '别的 Hub', userDataDir: '' },               // 别的 Hub 还活着 → 保留
  ] }));
  const killed = [];
  const lc = createChildLifecycle({ dataDir, watchMs: 0, ...plenty, hubPid: 999999,
    killTree: pid => { killed.push(pid); return true; },
    probeStarts: async pids => new Map(pids.map(p => [p, p === process.pid ? 52000 : 99999999])) });
  const r = await lc.reclaimOrphans();
  assert.deepEqual(killed, [process.pid]);
  assert.equal(r.checked, 2); assert.equal(r.killed, 1); assert.equal(r.cleaned, 2);
  assert.equal(fs.existsSync(ud1) || fs.existsSync(ud2), false);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
  assert.deepEqual(saved.map(e => e.id), ['c']);
});

test('登记写进数据目录、用完注销；Hub 退出时同步收掉自己登记的', t => {
  const dataDir = tmpDir(t); const killed = [];
  const lc = createChildLifecycle({ dataDir, watchMs: 0, ...plenty, killTree: pid => { killed.push(pid); return true; } });
  const id1 = lc.register({ pid: process.pid, kind: 'edge', purpose: 'x' });
  lc.register({ pid: process.pid, kind: 'edge', purpose: 'y' });
  const saved = () => JSON.parse(fs.readFileSync(lc.file, 'utf8')).entries;
  assert.equal(saved().length, 2);
  lc.unregister(id1);
  assert.equal(saved().length, 1);
  lc.shutdownSync();
  assert.deepEqual(killed, [process.pid]);
  assert.equal(saved().length, 0);
});

test('分身：旧会话关不掉时不另开新会话', async () => {
  const { AgentSessions } = require('../core/avatar/agent-session');
  const live = new Set(['old']); let created = 0;
  const s = new AgentSessions({ getSession: id => (live.has(id) ? { status: 'running' } : null), closeSession: async () => { throw new Error('busy'); },
    createSession: async () => { created += 1; return { ok: true }; } });
  await assert.rejects(s.ensure({ id: 'av1' }, { id: 'old', questions: 999 }, os.tmpdir()), /还没关掉/);
  assert.equal(created, 0);
  live.clear();
  const fresh = await s.ensure({ id: 'av1' }, { id: 'old', questions: 999 }, os.tmpdir());
  assert.equal(created, 1);
  assert.ok(fresh.id);
});

test('后台 CodeAgent 会话关闭补杀：只对 CodeAgent 会话、快照里有整棵树时才安排', async () => {
  const { prepareCloseSweep } = require('../core/session-close-sweep');
  const procs = [{ pid: 100, ppid: 1, startedAt: 10, name: 'cmd.exe' }, { pid: 101, ppid: 100, startedAt: 11, name: 'node.exe' }, { pid: 102, ppid: 101, startedAt: 12, name: 'msedge.exe' }];
  const inspect = () => ({ snapshot: async () => ({ processes: procs }), getCached: () => null });
  const mgr = kind => ({ sessions: new Map([['s1', { info: { kind }, pty: { pid: 100 } }]]), listLivePtyPids: () => [100] });
  assert.equal(await prepareCloseSweep(mgr('powershell'), 's1', { inspect, platform: 'win32' }), null);
  assert.equal(await prepareCloseSweep(mgr('codeagent'), 's1', { inspect, platform: 'linux' }), null);
  const r = await prepareCloseSweep(mgr('codeagent'), 's1', { inspect, platform: 'win32', log: () => {} });
  assert.deepEqual(r.before.map(p => p.pid).sort(), [100, 101, 102]);
  assert.equal(typeof r.schedule, 'function');
});

test('审查 #3：启动清理之前先有新登记，也不会冲掉上次遗留的条目', async t => {
  const dataDir = tmpDir(t);
  const file = path.join(dataDir, 'runtime', 'child-registry.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ entries: [{ id: 'old', hubPid: 2147480000, pid: process.pid, startedAt: 50000, kind: 'edge', userDataDir: '' }] }));
  const killed = [];
  const lc = createChildLifecycle({ dataDir, watchMs: 0, ...plenty, hubPid: 999999, killTree: pid => { killed.push(pid); return true; }, probeStarts: async () => new Map([[process.pid, 50000]]) });
  lc.register({ pid: process.pid, kind: 'edge', purpose: '新的' });
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).entries.some(e => e.id === 'old'));
  const r = await lc.reclaimOrphans();
  assert.equal(r.killed, 1);
  assert.deepEqual(killed, [process.pid]);
});

test('审查 #2：结束失败时保留登记；查不到启动时间时遗留条目留到下次', async t => {
  const dataDir = tmpDir(t);
  const lc = createChildLifecycle({ dataDir, watchMs: 0, ...plenty, killTree: () => false });
  const id = lc.register({ pid: process.pid, kind: 'edge', purpose: 'x' });
  assert.equal(lc.reclaim(id, '用完已关'), false);
  assert.equal(lc.status().active.length, 1);
  assert.match(lc.status().recent[0].reason, /结束失败/);
  const file = path.join(dataDir, 'runtime', 'child-registry.json');
  fs.writeFileSync(file, JSON.stringify({ entries: [{ id: 'old', hubPid: 2147480000, pid: process.pid, startedAt: 50000, kind: 'edge', userDataDir: '' }] }));
  const lc2 = createChildLifecycle({ dataDir, watchMs: 0, ...plenty, hubPid: 999998, killTree: () => true, probeStarts: async () => new Map() });
  const r = await lc2.reclaimOrphans();
  assert.equal(r.killed, 0);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).entries.some(e => e.id === 'old'));
});
