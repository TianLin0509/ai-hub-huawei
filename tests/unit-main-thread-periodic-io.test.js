'use strict';
// 开很多会话时主进程一阵阵卡住（2026-11-23）：几处定时任务原来在主线程上同步读写文件、同步枚举网卡，
// 磁盘忙或杀毒扫描时单次卡住几百毫秒到一秒多。这里锁住修复后的行为：定时路径不再走同步读写，结果与原来一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'main-io-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('网卡清单：30 秒内复用同一份，invalidate 后重新读', () => {
  const { createNetworkInterfacesCache } = require('../core/network-interfaces-cache');
  let reads = 0, now = 1000;
  const get = createNetworkInterfacesCache({ read: () => ({ eth: [{ n: ++reads }] }), now: () => now, ttlMs: 30000 });
  assert.equal(get().eth[0].n, 1);
  now += 29000; assert.equal(get().eth[0].n, 1);
  now += 2000; assert.equal(get().eth[0].n, 2);
  get.invalidate(); assert.equal(get().eth[0].n, 3);
  assert.equal(reads, 3);
});

test('会话异步保存：不在主线程同步读旧记录，标题与活动时间照常保留', async t => {
  const dir = tmp(t);
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; });
  for (const id of Object.keys(require.cache)) if (/core[\\/](session-store|data-dir)\.js$/.test(id)) delete require.cache[id];
  const store = require('../core/session-store');
  const hubId = 'io-test-1';
  store.saveSessionFile(hubId, { kind: 'codeagent', title: '调度重构', titleRevision: 3, userRenamed: true, lastMessageTime: 5000 });
  const original = fs.readFileSync;
  const syncReads = [];
  fs.readFileSync = function spy(file, ...rest) { if (String(file).includes(hubId)) syncReads.push(String(file)); return original.call(this, file, ...rest); };
  try {
    // 渲染进程常带着旧标题版本或不带标题来更新状态；磁盘上较新的标题不能被冲掉。
    await store.markDirtyImmediate(hubId, { kind: 'codeagent', title: null, contextPct: 42, lastMessageTime: 4000 });
  } finally { fs.readFileSync = original; }
  assert.deepEqual(syncReads, []);
  const saved = store.loadSessionFile(hubId);
  assert.equal(saved.title, '调度重构');
  assert.equal(saved.contextPct, 42);
  assert.equal(saved.titleRevision, 3);
});

test('子 Agent 进度：异步读取记录，结果与内容一致、文件没变就走缓存', async t => {
  const dir = tmp(t);
  const file = path.join(dir, 'main.jsonl');
  const row = o => JSON.stringify(o) + '\n';
  fs.writeFileSync(file, row({ type: 'user', timestamp: '2026-11-23T01:00:00Z', message: { role: 'user', content: '开始' } })
    + row({ type: 'assistant', timestamp: '2026-11-23T01:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { description: '查调度器', subagent_type: 'general' } }] } }));
  const { createSubagentProgressReader } = require('../core/subagent-progress');
  const original = fs.openSync; let syncReads = 0;
  fs.openSync = function spy(file, ...args) { if (String(file).startsWith(dir)) syncReads++; return original.call(this, file, ...args); };
  let first, second;
  try {
    const reader = createSubagentProgressReader({ now: () => Date.parse('2026-11-23T01:00:05Z') });
    first = await reader.read(file);
    second = await reader.read(file);
  } finally { fs.openSync = original; }
  assert.equal(syncReads, 0);
  assert.deepEqual(second, first);
});

test('会议室断网补抢：巡检没有变化时不写状态文件', async t => {
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const root = tmp(t);
  const now = new Date(2026, 10, 16, 12, 1).getTime();
  const a = new CompanyAssistant({ dataDir: root, noTimer: true, noTools: true, powerSaveBlocker: {}, roomHome: root, roomDownloader: null, now: () => now, roomNetworkProbe: async () => true });
  t.after(() => a.close());
  fs.mkdirSync(path.join(root, 'hub-control'));
  fs.writeFileSync(path.join(root, 'hub-control/status.json'), JSON.stringify({ protocol: 1, at: now, running: false, history: [], rules: {}, preferences: { 抢订设置: { 开放时间: '12:00:00' } } }));
  fs.writeFileSync(path.join(root, 'booking_history.json'), '[]');
  a.rooms.command = async () => ({});
  a.saveState({ roomSeen: [] });
  const saves = [];
  const original = a.saveState.bind(a);
  a.saveState = patch => { saves.push(Object.keys(patch)); return original(patch); };
  await a.rooms.tick(); await a.rooms.tick(); await a.rooms.tick();
  assert.equal(saves.filter(keys => keys.includes('roomOfflineRetries')).length, 0);
});

test('流量记录：定时续租约走异步读写，不用同步读写', async t => {
  const { createVpnTrafficRecorder } = require('../core/vpn-traffic-recorder');
  const dir = tmp(t);
  const sync = [];
  const spyFs = new Proxy(fs, { get(target, key) {
    const v = target[key];
    if (typeof v === 'function' && /Sync$/.test(String(key))) return (...args) => { if (String(args[0]).includes('recorder.lock')) sync.push(String(key)); return v.apply(target, args); };
    return typeof v === 'function' ? v.bind(target) : v;
  } });
  const recorder = createVpnTrafficRecorder({ dir, fs: spyFs, intervalMs: 500, listPipes: () => [], configPath: path.join(dir, 'none.yaml') });
  recorder.start();
  await new Promise(r => setTimeout(r, 1300));
  assert.ok(fs.existsSync(path.join(dir, 'recorder.lock')), '已经拿到租约');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'recorder.lock'), 'utf8')).pid, process.pid);
  assert.deepEqual(sync, []);
  recorder.stop();
  assert.equal(fs.existsSync(path.join(dir, 'recorder.lock')), false, '停止时同步释放租约');
});

// ---- 竞态（2026-11-23 审查）：用「闸门」把在途的异步改名卡住，再触发退出 / 停止，放开后看最终落盘的是谁 ----
function gate() { let open; const p = new Promise(r => { open = r; }); return { wait: () => p, open }; }

test('会话退出落盘：等在途的旧异步写结束后再写最新快照，旧内容不会盖回去', async t => {
  const dir = tmp(t);
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; });
  for (const id of Object.keys(require.cache)) if (/core[\/](session-store|data-dir)\.js$/.test(id)) delete require.cache[id];
  const store = require('../core/session-store');
  const hubId = 'race-quit-1';
  store.saveSessionFile(hubId, { kind: 'codeagent', contextPct: 0 });
  const rename = fs.promises.rename, g = gate();
  let held = 0;
  fs.promises.rename = async (from, to) => { if (String(to).includes(hubId)) { held++; await g.wait(); } return rename(from, to); };
  try {
    const inflight = store.markDirtyImmediate(hubId, { kind: 'codeagent', contextPct: 1 });
    while (!held) await new Promise(r => setImmediate(r));       // 旧快照的改名已经卡在闸门上
    store.markDirty(hubId, { kind: 'codeagent', contextPct: 2 }); // 退出前最新的状态
    const quit = store.flushAll();
    setTimeout(g.open, 50);
    await quit; await inflight;
  } finally { fs.promises.rename = rename; }
  assert.equal(store.loadSessionFile(hubId).contextPct, 2);
});

test('会话退出落盘：写失败的条目保留，下一次落盘照样写出', async t => {
  const dir = tmp(t);
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; });
  for (const id of Object.keys(require.cache)) if (/core[\/](session-store|data-dir)\.js$/.test(id)) delete require.cache[id];
  const store = require('../core/session-store');
  const hubId = 'race-quit-2';
  store.markDirty(hubId, { kind: 'codeagent', contextPct: 7 });
  const renameSync = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to).includes(hubId)) throw Object.assign(new Error('磁盘满'), { code: 'ENOSPC' }); return renameSync(from, to); };
  const warn = console.warn; console.warn = () => {};
  try { await store.flushAll(); } finally { fs.renameSync = renameSync; console.warn = warn; }
  assert.equal(store.loadSessionFile(hubId), null);
  await store.flushAll();
  assert.equal(store.loadSessionFile(hubId).contextPct, 7);
});

test('会话清单：停止时在途的异步写不会把清单文件复活', async t => {
  const { createSessionManifestExchange } = require('../core/session-manifest-exchange');
  const dir = tmp(t), g = gate();
  let held = 0;
  const spyFs = { ...fs, promises: { ...fs.promises, rename: async (a, b) => { held++; await g.wait(); return fs.promises.rename(a, b); } } };
  const ex = createSessionManifestExchange({ diagnosticsDir: dir, fs: spyFs, manifestMs: 60000, inboxMs: 60000 });
  ex.start();
  while (!held) await new Promise(r => setImmediate(r));
  ex.stop();
  g.open();
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(fs.readdirSync(dir).filter(n => /^session-manifest-\d+\.json$/.test(n)), []);
});

test('进程心跳：定时心跳的旧内容不会盖掉随后的退出事件心跳', async t => {
  const { installProcessLifecycleJournal } = require('../core/process-lifecycle-journal');
  const { EventEmitter } = require('node:events');
  const dir = tmp(t), g = gate(), app = new EventEmitter();
  app.getVersion = () => 'test';
  let tick = null, held = 0;
  const fsRef = { ...fs, promises: { ...fs.promises, rename: async (a, b) => { held++; await g.wait(); return fs.promises.rename(a, b); } } };
  const proc = new EventEmitter(); Object.assign(proc, { pid: 424242, ppid: 1, env: {}, versions: {}, execPath: 'x', cwd: () => dir });
  const journal = installProcessLifecycleJournal({ app, dataDir: dir, fsRef, processRef: proc, setIntervalFn: fn => { tick = fn; return 1; }, clearIntervalFn: () => {} });
  t.after(() => journal.dispose({ recordEvent: false }));
  tick();                                              // 定时心跳：改名卡在闸门上
  while (!held) await new Promise(r => setImmediate(r));
  app.emit('before-quit');                             // 退出事件同步写心跳
  g.open();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(JSON.parse(fs.readFileSync(journal.paths.heartbeatPath, 'utf8')).event, 'app-before-quit');
});

test('流量记录：停止时在途的租约续写不会留下占着的租约文件', async t => {
  const { createVpnTrafficRecorder } = require('../core/vpn-traffic-recorder');
  const dir = tmp(t), g = gate();
  let held = 0;
  const spyFs = { ...fs, promises: { ...fs.promises, rename: async (a, b) => { if (String(b).endsWith('recorder.lock')) { held++; await g.wait(); } return fs.promises.rename(a, b); } } };
  const recorder = createVpnTrafficRecorder({ dir, fs: spyFs, intervalMs: 500, listPipes: () => [], configPath: path.join(dir, 'none.yaml') });
  recorder.start();
  while (!held) await new Promise(r => setTimeout(r, 20));
  recorder.stop();
  g.open();
  await new Promise(r => setTimeout(r, 150));
  assert.equal(fs.existsSync(path.join(dir, 'recorder.lock')), false);
});

test('进展卡代写：读记录尾部不走同步读', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'progress-card-service.js'), 'utf8');
  const ghost = src.slice(src.indexOf('async function ghostWrite'), src.indexOf('function snapshot()'));
  assert.doesNotMatch(ghost, /\b(statSync|openSync|readSync|readFileSync)\b/);
});

// 复审（2026-11-23）：退出落盘等满 3 秒超时后，旧异步写仍不能盖掉退出快照。
async function quitTimeoutCase(t, hubId, gateOn) {
  const dir = tmp(t);
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; });
  for (const id of Object.keys(require.cache)) if (/core[\/](session-store|data-dir)\.js$/.test(id)) delete require.cache[id];
  const store = require('../core/session-store');
  store.saveSessionFile(hubId, { kind: 'codeagent', contextPct: 0 });
  const original = fs.promises[gateOn], g = gate();
  let held = 0;
  fs.promises[gateOn] = async (a, ...rest) => {
    const target = gateOn === 'rename' ? rest[0] : a;
    if (String(target).includes(hubId) && !held++) await g.wait();
    return original(a, ...rest);
  };
  try {
    const inflight = store.markDirtyImmediate(hubId, { kind: 'codeagent', contextPct: 1 });
    while (!held) await new Promise(r => setImmediate(r));
    store.markDirty(hubId, { kind: 'codeagent', contextPct: 2 });
    const started = Date.now();
    await store.flushAll();                                   // 旧写一直卡着：等满超时后写退出快照
    assert.ok(Date.now() - started >= 2900, '等满了超时');
    assert.equal(store.loadSessionFile(hubId).contextPct, 2);
    g.open(); await inflight;                                 // 超时之后旧写才继续
  } finally { fs.promises[gateOn] = original; }
  assert.equal(store.loadSessionFile(hubId).contextPct, 2);
}
test('会话退出落盘超时：旧写卡在改名之前，超时后不再发布', t => quitTimeoutCase(t, 'race-timeout-1', 'writeFile'));
test('会话退出落盘超时：旧写的改名已经发出，落地后用退出快照补写回去', t => quitTimeoutCase(t, 'race-timeout-2', 'rename'));

test('会话清单：即时同步写的清单不会被更早开始的定时异步写盖掉', async t => {
  const { createSessionManifestExchange } = require('../core/session-manifest-exchange');
  const dir = tmp(t), g = gate();
  let held = 0, n = 0;
  const spyFs = { ...fs, promises: { ...fs.promises, rename: async (a, b) => { if (!held++) await g.wait(); return fs.promises.rename(a, b); } } };
  const ex = createSessionManifestExchange({ diagnosticsDir: dir, fs: spyFs, manifestMs: 60000, inboxMs: 60000, describeSessions: () => [{ id: 'v' + (++n) }] });
  t.after(() => ex.stop());
  ex.start();                                     // 定时写（v1）卡在改名上
  while (!held) await new Promise(r => setImmediate(r));
  ex.writeManifest();                             // 点按钮：即时写 v2
  g.open();
  await new Promise(r => setTimeout(r, 100));
  const file = fs.readdirSync(dir).find(f => /^session-manifest-\d+\.json$/.test(f));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).sessions, [{ id: 'v2' }]);
});

// 第三轮复审：before-quit 与 will-quit 可能连着落盘两次；第二次没有新内容时，旧写落地后仍要补写回第一次的退出快照。
test('会话退出落盘连着调用两次：旧写的改名晚到，仍补写回退出快照', async t => {
  const dir = tmp(t);
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; });
  for (const id of Object.keys(require.cache)) if (/core[\/](session-store|data-dir)\.js$/.test(id)) delete require.cache[id];
  const store = require('../core/session-store');
  const hubId = 'race-double-quit';
  store.saveSessionFile(hubId, { kind: 'codeagent', contextPct: 0 });
  const rename = fs.promises.rename, g = gate();
  let held = 0;
  fs.promises.rename = async (a, b) => { if (String(b).includes(hubId) && !held++) await g.wait(); return rename(a, b); };
  try {
    const inflight = store.markDirtyImmediate(hubId, { kind: 'codeagent', contextPct: 1 });
    while (!held) await new Promise(r => setImmediate(r));
    store.markDirty(hubId, { kind: 'codeagent', contextPct: 2 });
    await store.flushAll();                                   // before-quit：等满超时，写下退出快照 2
    await store.flushAll();                                   // will-quit：没有新内容
    assert.equal(store.loadSessionFile(hubId).contextPct, 2);
    g.open(); await inflight;                                 // 旧写（1）的改名这时才落地
  } finally { fs.promises.rename = rename; }
  assert.equal(store.loadSessionFile(hubId).contextPct, 2);
});
