'use strict';
// 低开销模式（2026-11-23）：新装 / 升级判定、模式开关不收起入口、底栏读数关掉后主进程不再起读网卡进程、
// 「资源与后台」页的进程归类。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const of = require('../core/optional-features');
const { createOptionalFeatures, FILE, BACKGROUND_IDS, registerActive, backgroundOn } = of;

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'low-overhead-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));

test('新装：低开销模式开，后台功能全关（含会议室和三项新开关），判定写进文件只做一次', t => {
  const dir = tmp(t);
  const f = createOptionalFeatures({ dataDir: dir, logger: {}, detectFreshInstall: true });
  assert.equal(f.installKind(), 'fresh');
  assert.equal(f.lowOverhead(), true);
  for (const id of BACKGROUND_IDS.filter(id => id !== 'pet')) assert.equal(f.get(id), false, id);
  assert.equal(f.lowOverheadHintPending(), false, '新装不提示');
  for (const id of ['assistant', 'rooms', 'liveMeter']) assert.equal(f.navHidden(id), false, '默认关不收起入口：' + id);
  assert.equal(read(dir).lowOverheadVersion, of.LOW_OVERHEAD_VERSION);
  // 用户之后按需开了会议室：重启不再重新判定，不会又被关掉。
  f.set('rooms', true);
  fs.writeFileSync(path.join(dir, 'state.json'), '{}');
  const again = createOptionalFeatures({ dataDir: dir, logger: {}, detectFreshInstall: true });
  assert.equal(again.installKind(), 'legacy');
  assert.equal(again.get('rooms'), true);
  assert.equal(again.lowOverhead(), true);
});

test('老用户升级（有 state.json、没有开关文件）：一个开关都不改，三项新开关按老行为记为开，提示一次', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'state.json'), '{"version":1}');
  const f = createOptionalFeatures({ dataDir: dir, logger: {}, detectFreshInstall: true });
  assert.equal(f.installKind(), 'upgrade');
  assert.equal(f.lowOverhead(), false);
  assert.equal(f.get('rooms'), true, '会议室老默认开，保持');
  for (const id of ['liveMeter', 'searchIndex', 'quotaRefresh']) assert.equal(f.get(id), true, id);
  assert.equal(f.lowOverheadHintPending(), true);
  f.dismissLowOverheadHint();
  assert.equal(createOptionalFeatures({ dataDir: dir, logger: {}, detectFreshInstall: true }).lowOverheadHintPending(), false, '看过就不再提示');
});

test('老用户升级（已有开关文件、开着助理、关了会议室）：原样保留', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ assistant: true, rooms: false, navHidden: ['rooms'] }));
  const f = createOptionalFeatures({ dataDir: dir, logger: {}, detectFreshInstall: true });
  assert.equal(f.installKind(), 'upgrade');
  assert.equal(f.get('assistant'), true);
  assert.equal(f.get('rooms'), false);
  assert.equal(f.navHidden('rooms'), true);
  assert.equal(f.get('liveMeter'), true);
});

test('老用户 state.json 丢了：sessions/ 或 meetings/ 里有东西、或有 config.json 等用过的痕迹，都按老用户处理、不动已有功能', t => {
  for (const seed of [
    dir => { fs.mkdirSync(path.join(dir, 'sessions', 'old'), { recursive: true }); },
    dir => { fs.mkdirSync(path.join(dir, 'meetings'), { recursive: true }); fs.writeFileSync(path.join(dir, 'meetings', 'm1.json'), '{}'); },
    dir => { fs.writeFileSync(path.join(dir, 'config.json'), '{}'); },
    dir => { fs.writeFileSync(path.join(dir, 'hub-pet.json'), '{}'); },
  ]) {
    const dir = tmp(t);
    seed(dir);
    const f = createOptionalFeatures({ dataDir: dir, logger: {}, detectFreshInstall: true });
    assert.equal(f.installKind(), 'upgrade');
    assert.equal(f.lowOverhead(), false);
    for (const id of ['rooms', 'liveMeter', 'searchIndex', 'quotaRefresh']) assert.equal(f.get(id), true, id);
  }
  // 空的 sessions/ 目录不算用过（目录可能是启动时顺手建的）。
  const empty = tmp(t);
  fs.mkdirSync(path.join(empty, 'sessions'));
  assert.equal(createOptionalFeatures({ dataDir: empty, logger: {}, detectFreshInstall: true }).installKind(), 'fresh');
});

test('模式总开关：有一项关不上就不把模式记成已开，返回部分成功和一行原因；全部关上才记成开', async t => {
  const { switchLowOverhead } = of;
  const f = createOptionalFeatures({ dataDir: tmp(t), logger: {} });
  f.set('forum', true);
  const list = () => [
    { id: 'forum', name: '帖子', on: f.get('forum') }, { id: 'rooms', name: '会议室', on: f.get('rooms') },
    { id: 'liveMeter', name: '底栏读数', on: f.get('liveMeter') }, { id: 'tray', name: '托盘', on: true },
  ];
  let roomsStuck = true;
  const calls = [];
  const apply = async (id, on) => {
    calls.push(id);
    if (id === 'rooms' && !on && roomsStuck) throw new Error('会议室组件进程没有结束');
    f.set(id, on);
  };
  const r1 = await switchLowOverhead({ features: f, list: list(), apply, on: true });
  assert.equal(r1.partial, true);
  assert.equal(f.lowOverhead(), false, '没全关上：模式不落盘');
  assert.match(r1.message, /会议室没关上（会议室组件进程没有结束），低开销模式保持关/);
  assert.equal(f.get('forum'), false, '关上了的保持关');
  assert.equal(f.get('rooms'), true);
  assert.equal(f.navHidden('forum'), false, '模式替用户关的不收起入口');
  roomsStuck = false;
  const r2 = await switchLowOverhead({ features: f, list: list(), apply, on: true });
  assert.equal(r2.partial, false);
  assert.equal(f.lowOverhead(), true);
  assert.ok(!calls.includes('tray'), '托盘不在后台功能里，不碰');
  const r3 = await switchLowOverhead({ features: f, list: list(), apply, on: false });
  assert.equal(r3.partial, false);
  assert.equal(f.lowOverhead(), false);
  assert.equal(f.get('liveMeter'), true, '关模式恢复三项老行为');
  assert.equal(f.get('rooms'), false, '会议室是可选功能，关模式时不自动打开');
});

test('不判定（单测、隔离实例默认）：老行为，会议室开、三项新开关开、不提示', t => {
  const f = createOptionalFeatures({ dataDir: tmp(t), logger: {} });
  assert.equal(f.installKind(), 'legacy');
  assert.equal(f.get('rooms'), true);
  assert.equal(f.get('searchIndex'), true);
  assert.equal(f.lowOverheadHintPending(), false);
});

test('模式替用户批量关（sweep）不收起左侧入口；用户亲手关才收起；打开模式清掉提示', async t => {
  const dir = tmp(t);
  const f = createOptionalFeatures({ dataDir: dir, logger: {} });
  f.set('forum', true); f.set('attendance', true);
  await f.sweep(async () => { f.set('forum', false); await new Promise(r => setTimeout(r, 5)); f.set('attendance', false); });
  assert.equal(f.navHidden('forum'), false);
  assert.equal(f.navHidden('attendance'), false, '异步 sweep 期间同样不收起');
  f.set('w3', true); f.set('w3', false);
  assert.equal(f.navHidden('w3'), true);
  f.setLowOverhead(true);
  assert.equal(read(dir).lowOverhead, true);
});

test('其他模块经登记的实例问开关；没登记时一律当开着（老行为）', t => {
  registerActive(null);
  assert.equal(backgroundOn('liveMeter'), true);
  const f = createOptionalFeatures({ dataDir: tmp(t), logger: {} });
  f.set('liveMeter', false);
  registerActive(f);
  t.after(() => registerActive(null));
  assert.equal(backgroundOn('liveMeter'), false);
  assert.equal(backgroundOn('quotaRefresh'), true);
});

test('底栏读数关掉：网速不起读网卡进程，只回 IP；显卡读数跳过 nvidia-smi', async t => {
  const f = createOptionalFeatures({ dataDir: tmp(t), logger: {} });
  registerActive(f);
  t.after(() => registerActive(null));
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on() {} };
  let networkCalls = 0, gpuCalls = 0, disposed = 0;
  require('../main/ipc/app-utility-handlers.js').registerAppUtilityIpc(ipcMain, {
    clipboard: {}, getMainWindow: () => null, getHookPort: () => null,
    liveTelemetry: { sampleNetwork: async () => { networkCalls++; return { status: 'ok' }; }, sampleProcesses: async () => ({}), dispose: () => { disposed++; } },
    systemTelemetry: { sampleGpu: async () => { gpuCalls++; return { usagePct: 5 }; }, sampleDisk: async () => ({ usedPct: 10 }), sample: async () => ({}) },
    clashDelay: { sample: async () => ({}) },
    vpnTraffic: { report: () => ({}) },
  });
  const net = handlers.get('get-network-transfer-usage');
  const sys = handlers.get('get-system-resource-usage');
  assert.equal((await net()).status, 'ok');
  assert.equal((await sys(null, { extended: false })).gpu.usagePct, 5);
  f.set('liveMeter', false);
  const off = await net();
  assert.equal(off.status, 'off');
  assert.ok(Array.isArray(off.ips));
  assert.equal(disposed, 1, '关掉后停掉常驻的读网卡进程');
  const usage = await sys(null, { extended: false });
  assert.deepEqual(usage.gpu, { off: true });
  assert.equal(usage.disk.usedPct, 10, '硬盘读数照旧');
  assert.equal(networkCalls, 1);
  assert.equal(gpuCalls, 1);
});

test('进程归类：已知进程号优先；Edge、读网卡脚本、桌宠脚本按身份认；子孙跟着父进程；CPU 按整机换算', () => {
  const { attribute, classifyProcess } = require('../core/resource-attribution');
  const enc = s => Buffer.from(s, 'utf16le').toString('base64');
  const rows = [
    { pid: 1, ppid: 0, name: 'electron.exe', cmd: 'electron.exe .', wsBytes: 200 * 1048576, cpuDeltaMs: 100 },
    { pid: 2, ppid: 1, name: 'electron.exe', cmd: 'electron.exe --type=renderer', wsBytes: 150 * 1048576, cpuDeltaMs: 50 },
    { pid: 3, ppid: 1, name: 'electron.exe', cmd: 'electron.exe --type=renderer', wsBytes: 80 * 1048576, cpuDeltaMs: 10 },
    { pid: 4, ppid: 1, name: 'powershell.exe', cmd: 'powershell.exe -NoProfile -EncodedCommand ' + enc('$s=$_.GetIPv4Statistics()'), wsBytes: 146 * 1048576, cpuDeltaMs: 20 },
    { pid: 5, ppid: 4, name: 'conhost.exe', cmd: 'conhost.exe 0x4', wsBytes: 8 * 1048576, cpuDeltaMs: 0 },
    { pid: 6, ppid: 1, name: 'powershell.exe', cmd: 'powershell.exe -EncodedCommand ' + enc('Add-Type -Namespace HubPet -Name Fg'), wsBytes: 60 * 1048576, cpuDeltaMs: 5 },
    { pid: 7, ppid: 1, name: 'msedge.exe', cmd: 'msedge.exe --headless', wsBytes: 170 * 1048576, cpuDeltaMs: 30 },
    { pid: 8, ppid: 7, name: 'msedge.exe', cmd: 'msedge.exe --type=renderer', wsBytes: 100 * 1048576, cpuDeltaMs: 10 },
    { pid: 9, ppid: 1, name: 'OpenConsole.exe', cmd: 'OpenConsole.exe', wsBytes: 10 * 1048576, cpuDeltaMs: 0 },
    { pid: 10, ppid: 9, name: 'node.exe', cmd: 'node codeagent', wsBytes: 300 * 1048576, cpuDeltaMs: 40 },
    { pid: 11, ppid: 1, name: 'electron.exe', cmd: 'electron.exe search-child.js', wsBytes: 90 * 1048576, cpuDeltaMs: 0 },
  ];
  const known = { byPid: new Map([[3, 'pet'], [11, 'searchIndex']]) };
  const r = attribute(rows, { rootPid: 1, known, cpuWindowMs: 1000, cpuCount: 4 });
  const g = Object.fromEntries(r.groups.map(x => [x.id, x]));
  assert.deepEqual([g.core.procs, g.core.memMB], [2, 350]);
  assert.deepEqual([g.pet.procs, g.pet.memMB], [2, 140], '桌宠窗口 + 全屏检测脚本');
  assert.deepEqual([g.liveMeter.procs, g.liveMeter.memMB], [2, 154], '读网卡脚本连同它的 conhost');
  assert.deepEqual([g.companyWeb.procs, g.companyWeb.memMB], [2, 270]);
  assert.deepEqual([g.sessions.procs, g.sessions.memMB], [2, 310]);
  assert.equal(g.searchIndex.procs, 1);
  assert.equal(r.total.procs, 11);
  assert.equal(g.companyWeb.cpuPct, 1, '40 ms / 1000 ms / 4 核 = 1%');
  assert.equal(attribute(rows, { rootPid: 1, known }).total.cpuPct, null, '只有一份采样时算不出 CPU');
  assert.equal(classifyProcess({ pid: 99, name: 'nvidia-smi.exe' }), 'liveMeter');
  // 读占用时起的采集脚本和它的 conhost 不算进任何一项（否则「本体」凭空多出 150 MB）。
  const withMeasure = rows.concat([
    { pid: 20, ppid: 1, name: 'powershell.exe', cmd: 'powershell.exe -EncodedCommand ' + enc('foreach ($c in (Get-CimInstance Win32_Process)) {}'), wsBytes: 150 * 1048576, cpuDeltaMs: 300 },
    { pid: 21, ppid: 20, name: 'conhost.exe', cmd: 'conhost.exe', wsBytes: 8 * 1048576, cpuDeltaMs: 0 },
  ]);
  const r2 = attribute(withMeasure, { rootPid: 1, known, cpuWindowMs: 1000, cpuCount: 4 });
  assert.equal(r2.total.procs, 11);
  assert.equal(r2.total.memMB, r.total.memMB);
});
