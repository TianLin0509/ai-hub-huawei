'use strict';
// 2026-11-23 开销优化 P0-B（HUB-H 本体，默认模式零回归）：桌宠降帧、会议室/额度/分身空闲不空转、
// 卡片会话内存记录上限、tap 增量读、状态条网络区少重写、隐藏终端保护诊断计数。
// 每条都钉住「修复撤掉就会失败」的行为。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ---------- 1. 桌宠：软件渲染降帧、静止档不呼吸 ----------
const M = require('../renderer/hub-pet/pet-motion');
const CALM_FPS = { idle: 20, tired: 20, peek: 15, sleep: 12, typing: 30, happy: 30 };

test('桌宠：正常显卡帧率一行不变；软件渲染空闲 6 帧/秒、打盹静止；静止档只在下一个小动作时醒', () => {
  const base = { calmFps: CALM_FPS, t: 1000, nextGestureAt: 9000, nextYawnAt: 15000 };
  // 正常显卡：与原来的 1000 / CALM_FPS 完全一致
  for (const pose of Object.keys(CALM_FPS)) assert.equal(M.calmDelay({ ...base, pose }), 1000 / CALM_FPS[pose], pose);
  // 软件渲染
  assert.equal(M.SOFT_GPU_FPS, 6);
  for (const pose of ['idle', 'tired', 'peek']) assert.equal(M.calmDelay({ ...base, pose, soft: true }), 1000 / 6, pose);
  assert.equal(M.calmDelay({ ...base, pose: 'sleep', soft: true }), null, '打盹停在静止帧');
  assert.equal(M.calmDelay({ ...base, pose: 'typing', soft: true }), 1000 / 30, '打字爪子循环照旧');
  assert.equal(M.calmDelay({ ...base, pose: 'happy', soft: true }), 1000 / 30);
  // 安静档 / 减少动态效果：不再按 20 帧空转
  assert.equal(M.calmDelay({ ...base, pose: 'idle', still: true }), 8000, '待机等到下一个小动作');
  assert.equal(M.calmDelay({ ...base, pose: 'tired', still: true }), 14000, '犯困等到下一个哈欠');
  assert.equal(M.calmDelay({ ...base, pose: 'idle', still: true, nextGestureAt: 1100 }), 250, '最短 250ms');
  assert.equal(M.calmDelay({ ...base, pose: 'peek', still: true }), null);
  assert.equal(M.calmDelay({ ...base, pose: 'sleep', still: true }), null);
  assert.equal(M.calmDelay({ ...base, pose: 'typing', still: true }), 1000 / 30, '打字照旧');
});

test('桌宠渲染端：空闲排帧走 calmDelay，静止档跳过呼吸，软件渲染挂 soft-gpu 停无限循环动画', () => {
  const js = read('renderer/hub-pet/pet.js');
  assert.match(js, /M\.calmDelay\(\{ pose, calmFps: CALM_FPS, soft: softGpu\(\), still: stillMode\(\)/);
  assert.match(js, /if \(delay == null\) return;/);
  assert.match(js, /breathStill\(\) \? \{ phase, sx: 1, sy: 1 \} : M\.breathStep/);
  assert.match(js, /function stillMode\(\) \{ return state\.mode === 'quiet' \|\| reducedMotion\.matches(?: \|\| lowPower\(\))?; \}/); // P1 低开销模式追加 lowPower
  // P1 v2：soft-gpu 类改由 M.decorStill 合成（软件渲染或低开销）。
  assert.match(js, /classList\.toggle\('soft-gpu', (?:softGpu\(\)|M\.decorStill\(\{ softGpu: softGpu\(\), lowPower: lowPower\(\) \}\))\)/);
  assert.doesNotMatch(js, /const fps = CALM_FPS\[pose\] \|\| 20;/, '不再无条件按 CALM_FPS 排帧');
  const css = read('renderer/hub-pet/pet.css');
  assert.match(css, /body\.soft-gpu #evolve-wings, body\.soft-gpu #sparks i, body\.soft-gpu #halo \{ animation: none !important; \}/);
});

function petRig(t, opts = {}) {
  const { createHubPetController } = require('../main/hub-pet-controller');
  const { NoticeBus } = require('../core/company-assistant/notice-bus');
  const root = tmp('pet-p0b-');
  const sent = [];
  class FakeWindow extends EventEmitter {
    constructor(o) { super(); this.bounds = { x: 0, y: 0, width: o.width, height: o.height }; this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.send = (channel, payload) => sent.push({ channel, payload }); }
    isDestroyed() { return this.destroyed; } getBounds() { return this.bounds; } setBounds(b) { this.bounds = { ...b }; }
    setIgnoreMouseEvents() {} setAlwaysOnTop() {} loadFile() { return Promise.resolve(); } showInactive() {} focus() {} hide() {} show() {}
    isVisible() { return true; } destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const display = { workArea: { x: 0, y: 0, width: 1600, height: 1000 } };
  const NOON = new Date(2026, 10, 23, 12).getTime();
  const c = createHubPetController({ BrowserWindow: FakeWindow, ipcMain, noticeBus: new NoticeBus({ now: () => NOON }), dataDir: root,
    assetsDir: path.join(ROOT, 'renderer/assets/hub-pet'), htmlPath: 'fixture.html', preloadPath: 'fixture-preload.js',
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    powerMonitor: { getSystemIdleTime: () => 0 }, now: () => NOON, watchFullscreen: false, logger: { warn() {}, info() {}, log() {} },
    sendToRenderer: () => {}, focusPrimaryWindow: () => {}, ...opts });
  t.after(() => { c.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { c, state: () => sent.filter(x => x.channel === 'hub-pet:state').map(x => x.payload).pop() };
}

test('桌宠主进程：把「本次关了硬件加速」透传给渲染端；默认读 main-bootstrap 记下的兼容渲染原因', t => {
  const soft = petRig(t, { softGpu: () => true });
  soft.c.setSettings({ enabled: true });
  assert.equal(soft.state().softGpu, true);
  const hw = petRig(t, { softGpu: () => false });
  hw.c.setSettings({ enabled: true });
  assert.equal(hw.state().softGpu, false);
  const saved = process.__hubGpuDisabledReason;
  t.after(() => { process.__hubGpuDisabledReason = saved; });
  process.__hubGpuDisabledReason = 'marker';
  const auto = petRig(t);
  auto.c.setSettings({ enabled: true });
  assert.equal(auto.state().softGpu, true, '默认跟随 gpu-disabled.json 等兼容渲染开关');
});

// ---------- 2. 会议室：没装组件、没开抢时不跑 15 秒巡检 ----------
const { RoomBooking } = require('../core/company-assistant/rooms');
function roomRig(t, settings = {}) {
  const home = tmp('rooms-p0b-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = { save: 0, changed: 0 };
  const a = { dir: home, now: () => Date.now(), settings: () => ({ rooms: settings }), state: () => ({}),
    saveState() { calls.save++; }, setSettings() {}, changed() { calls.changed++; } };
  return { home, calls, booking: new RoomBooking(a, { roomHome: home, roomDownloader: null }) };
}

test('会议室：从没用过时 start() 不建 15 秒定时器，tick 不读写状态、不刷新界面', async t => {
  let intervals = 0, cleared = 0;
  t.mock.method(global, 'setInterval', () => ++intervals);
  t.mock.method(global, 'clearInterval', () => { cleared++; });
  const { booking, calls } = roomRig(t);
  booking.start();
  assert.equal(intervals, 0, '没组件、没开抢：不建定时器');
  await booking.tick();
  assert.equal(calls.save, 0, '不写状态');
  assert.equal(calls.changed, 0, '不通知界面');
  booking.close();
});

test('会议室：有抢订历史、或自动抢订开着时照旧每 15 秒巡检；装上组件后按需拉起', async t => {
  let intervals = 0;
  t.mock.method(global, 'setInterval', () => ++intervals);
  t.mock.method(global, 'clearInterval', () => {});
  const on = roomRig(t, { enabled: true });
  on.booking.start();
  assert.equal(intervals, 1, '自动抢订开着：照旧建');
  on.booking.close();
  const r = roomRig(t);
  r.booking.start();
  assert.equal(intervals, 1);
  fs.writeFileSync(path.join(r.home, 'booking_history.json'), '[]');
  r.booking.wakeTimer();
  assert.equal(intervals, 2, '出现抢订历史后拉起');
  r.booking.wakeTimer();
  assert.equal(intervals, 2, '不重复建');
  r.booking.close();
});

test('会议室：close() 只停 Hub 自己的定时器，不结束抢订组件进程', () => {
  const src = read('core/company-assistant/rooms.js');
  const close = src.match(/\n {2}close\(\) \{[^\n]*\}/)[0];
  assert.doesNotMatch(close, /kill|stopManagedHelper/);
  assert.match(src, /关 Hub 时只停 Hub 自己的定时器，不结束会议室组件进程/);
});

// ---------- 3. 额度扫描、分身巡检 ----------

const { FleetService } = require('../core/avatar/fleet');
test('分身：一个分身都没有时 30 秒巡检自己停下；新建分身写回配置时重新拉起', async t => {
  let intervals = 0, cleared = 0;
  t.mock.method(global, 'setInterval', () => ({ id: ++intervals, unref() {} }));
  t.mock.method(global, 'clearInterval', () => { cleared++; });
  let avatars = [];
  const writes = [];
  const svc = Object.create(FleetService.prototype);
  Object.assign(svc, { d: {}, timer: null, ticking: false, owner: () => 'm1', fleet: () => ({ avatars, paused: false }),
    legacy: { write: (o, f, v) => writes.push(v) }, closeIdle: async () => {} });
  svc.start();
  assert.equal(intervals, 1);
  await svc.tick();
  assert.equal(svc.timer, null, '没有分身：巡检停下');
  assert.ok(cleared >= 1);
  svc.saveFleet('m1', { avatars: [] });
  assert.equal(intervals, 1, '还是没有分身：不拉起');
  avatars = [{ id: 'v1', enabled: true, kind: 'pick', targets: [] }];
  svc.saveFleet('m1', { avatars });
  assert.equal(intervals, 2, '新建分身：拉起');
  svc.saveFleet('m1', { avatars });
  assert.equal(intervals, 2, '不重复建');
  svc.close();
  svc.saveFleet('m1', { avatars });
  assert.equal(intervals, 2, '关闭后不再拉起');
});

// ---------- 4. 卡片会话内存记录上限 ----------
const cap = require('../core/native-history-cap');

test('记录上限：超出 KEEP+SLACK 才一次裁回 KEEP，最新一轮（含插话）一条不丢', () => {
  const mk = n => Array.from({ length: n }, (_, i) => ({ turnId: 't' + i, status: i % 7 ? 'completed' : 'running' }));
  const small = mk(cap.KEEP + cap.SLACK);
  assert.equal(cap.trimRecords(small), 0, '没超出余量：不动');
  const big = mk(cap.KEEP + cap.SLACK + 1);
  const lastId = big.at(-1).turnId;
  assert.equal(cap.trimRecords(big), cap.SLACK + 1);
  assert.equal(big.length, cap.KEEP);
  assert.equal(big.at(-1).turnId, lastId, '最新一轮还在');
  // 最新一轮占了很多条（开场 + 插话）：属于它的记录全部保留
  const steer = [...mk(10), ...Array.from({ length: cap.KEEP + cap.SLACK }, () => ({ turnId: 'live', status: 'running' }))];
  cap.trimRecords(steer);
  assert.equal(steer.filter(r => r.turnId === 'live').length, cap.KEEP + cap.SLACK);
  assert.equal(steer.length, cap.KEEP + cap.SLACK);
});

test('ACP 轮次表：只丢最老的已结束轮次，进行中和当前轮跳过；GLM 分叉序号把丢掉的轮数补回', () => {
  const { AcpSession } = require('../core/acp-session');
  const history = new Map();
  for (let i = 0; i < cap.KEEP + cap.SLACK + 5; i++) history.set('t' + i, { id: 't' + i, status: i === 0 ? 'inProgress' : 'completed' });
  const self = Object.assign(Object.create(AcpSession.prototype), { history, completed: new Map(), active: null, runtime: { turnId: 't1' } });
  const n = self.trimHistory();
  assert.equal(n, cap.SLACK + 5);
  assert.equal(history.size, cap.KEEP);
  assert.ok(history.has('t0'), '进行中的轮次不丢');
  assert.ok(history.has('t1'), '当前轮不丢');
  assert.equal(self.trimmedTurns, n);
  assert.match(read('core/acp-session.js'), /turnIndex:Math\.max\(0,this\.history\.size\+\(this\.trimmedTurns\|\|0\)-1\)/);
  assert.match(read('core/acp-session.js'), /history:this\.fullHistory\(\)/, '分叉带全量历史');
});

test('DSH/千问/pi：新一轮写入时裁内存记录，但离线回放与超窗全量历史读取不截断；DSH 事件去重表用低水位封顶', t => {
  const { capturePiMessage, readPiCliTranscript } = require('../core/pi-cli-session');
  const { DshCliSession, readDshCliTranscript } = require('../core/dsh-cli-session');
  const { AcpSession } = require('../core/acp-session');
  const { QwenCliSession } = require('../core/qwen-cli-session');
  const total = cap.KEEP + cap.SLACK + 5;
  // 1) 运行时热状态裁剪，但全量离线回放不裁
  const view = { records: [] };
  for (let i = 0; i < cap.KEEP + cap.SLACK + 1; i++) capturePiMessage(view, { role: 'user', content: 'q' + i, timestamp: i + 1 }, 'u' + i);
  assert.equal(view.records.length, cap.KEEP, 'pi 运行时内存记录被裁');
  assert.equal(view.records.at(-1).text, 'q' + (cap.KEEP + cap.SLACK));
  assert.match(read('core/dsh-cli-session.js'), /this\.records\.push\(\{[\s\S]{0,300}\}\);\r?\n\s*if \(!replay && !this\._noTrim && require\('\.\/native-history-cap'\)\.trimRecords\(this\.records\)\)/);
  assert.match(read('core/qwen-cli-session.js'), /trimRecords\(records\)/);
  assert.match(read('core/qwen-cli-session.js'), /trimTail\(this\.hookTurns\)/);

  // 2) 复审 P0-1：四类会话超 330 轮后的全量历史读取与搜索均不丢旧轮次
  const dir = tmp('hist-p0b-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // DSH 离线回放 + 运行中全量读
  const dshFile = path.join(dir, 'dsh.jsonl');
  const dshRows = [{ type: 'bound', sessionId: 's1', events: [] }];
  for (let i = 0; i < total; i++) {
    dshRows.push({ type: 'event', sessionId: 's1', event: { seq: i + 1, type: 'user/message', time: i + 1, data: { id: 'm' + i, source: { kind: 'user' }, content: [{ type: 'text', text: 'dsh-' + i }] } } });
  }
  fs.writeFileSync(dshFile, dshRows.map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(readDshCliTranscript(dshFile).filter(c => c.role === 'user').length, total, 'DSH 离线回放不截断');
  // Pi 离线回放不裁（pi 会话文件按 parentId 链起当前分支）
  const piFile = path.join(dir, 'pi.jsonl');
  const piLines = [{ type: 'session', id: 'p1' }];
  for (let i = 0; i < total; i++) piLines.push({ type: 'message', id: 'u' + i, parentId: i ? 'u' + (i - 1) : null, message: { role: 'user', content: 'pi-' + i, timestamp: i + 1 } });
  fs.writeFileSync(piFile, piLines.map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(readPiCliTranscript(piFile).filter(c => c.role === 'user').length, total, 'Pi 离线回放不截断');
  // ACP 运行中裁剪后全量 readTranscript 走 fullHistory()
  const acpFull = Array.from({ length: total }, (_, i) => ({ id: 't' + i, status: 'completed', items: [{ type: 'userMessage', id: 'u' + i, content: [{ type: 'text', text: 'acp-' + i }] }] }));
  const acp = Object.assign(Object.create(AcpSession.prototype), {
    options: { id: 'h', kind: 'codeagent' }, threadId: 'th', items: new Map(), active: null, runtime: {},
    history: new Map(acpFull.slice(-cap.KEEP).map(x => [x.id, x])), trimmedTurns: total - cap.KEEP,
    fullHistory: () => acpFull,
  });
  assert.equal(acp.readTranscript().filter(c => c.role === 'user').length, total, 'ACP 全量读取从历史库补齐');
  assert.equal(acp.readTranscript({ limit: 5 }).length, 5, 'ACP 尾部小窗口直接走内存');
  // Qwen 运行中裁剪后全量 readTranscript 补读文件
  const qwenFile = path.join(dir, 'qwen.jsonl');
  const qLines = Array.from({ length: total }, (_, i) => JSON.stringify({ sessionId: 'q1', type: 'user', provenance: 'real_user', uuid: 'qu' + i, timestamp: new Date(i + 1000).toISOString(), message: { parts: [{ text: 'qw-' + i }] } }));
  fs.writeFileSync(qwenFile, qLines.join('\n') + '\n');
  const qw = Object.assign(Object.create(QwenCliSession.prototype), {
    threadId: 'q1', records: [], hookTurns: [], _trimmedRecords: true, transcriptPath: qwenFile,
  });
  assert.equal(qw.readTranscript().filter(c => c.role === 'user').length, total, 'Qwen 全量读取不截断');

  const s = Object.assign(Object.create(DshCliSession.prototype), { seen: new Set(), seenFloor: 0 });
  for (let i = 0; i <= 20000; i++) s.seen.add(i);
  s.trimSeen();
  assert.ok(s.seen.size <= 10001, '序号表封顶');
  assert.equal(s.seenFloor, 10001);
  assert.ok(!s.seen.has(5) && s.seen.has(20000));
});

// ---------- 4b. tap 增量读 ----------
test('Antigravity：事件记录只读新增字节，不再整份重读；多字节字符与半行都正确', t => {
  const { AntigravityTap } = require('../core/antigravity-tap');
  const dir = tmp('ag-p0b-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, JSON.stringify({ n: 1, text: '中文' }) + '\n');
  const tap = new AntigravityTap();
  const events = [];
  tap._event = (_s, e) => events.push(e.n);
  const whole = t.mock.method(fs, 'readFileSync');
  t.mock.method(global, 'setInterval', () => ({ unref() {} }));
  tap.registerSession('h1', { antigravityEventsFile: file });
  assert.deepEqual(events, [1]);
  fs.appendFileSync(file, JSON.stringify({ n: 2, text: '续写' }) + '\n' + '{"n":3');   // 第 3 行还没写完
  tap._poll(tap._bound.get('h1'));
  assert.deepEqual(events, [1, 2]);
  fs.appendFileSync(file, '}\n');
  tap._poll(tap._bound.get('h1'));
  tap._poll(tap._bound.get('h1'));   // 没新内容：不重复
  assert.deepEqual(events, [1, 2, 3]);
  assert.equal(whole.mock.calls.filter(c => c.arguments[0] === file).length, 0, '没有整份重读事件记录');
  assert.equal(tap._bound.get('h1').bytes, fs.statSync(file).size);
  // 复审 P1-1：文件被截断后游标归零恢复，不再永久卡死；同尺寸覆写也能重新读出
  fs.writeFileSync(file, JSON.stringify({ n: 4 }) + '\n');
  tap._poll(tap._bound.get('h1'));
  assert.deepEqual(events, [1, 2, 3, 4], '截断后自动重置游标继续读');
  const sameSizeNext = JSON.stringify({ n: 5 }) + '\n';
  assert.equal(Buffer.byteLength(sameSizeNext), fs.statSync(file).size);
  // 推进 mtime 模拟轮转/同尺寸替换
  fs.writeFileSync(file, sameSizeNext);
  const fut = new Date(Date.now() + 2000);
  fs.utimesSync(file, fut, fut);
  tap._poll(tap._bound.get('h1'));
  assert.deepEqual(events, [1, 2, 3, 4, 5], '同尺寸轮转不漏读');
  tap.unregisterSession('h1');
});

test('JsonlTail（Kimi 等共用）：同尺寸替换/轮转时重置游标不漏读', async t => {
  const { JsonlTail } = require('../core/jsonl-tail');
  const dir = tmp('tail-p0b-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'wire.jsonl');
  const line1 = JSON.stringify({ seq: 1, v: 'aaaa' }) + '\n';
  const line2 = JSON.stringify({ seq: 2, v: 'bbbb' }) + '\n';
  assert.equal(Buffer.byteLength(line1), Buffer.byteLength(line2));
  fs.writeFileSync(file, line1);
  const seen = [];
  const tail = new JsonlTail(file, row => seen.push(row.seq), { pollMs: 50 });
  t.after(() => tail.close());
  await tail.start();
  assert.deepEqual(seen, [1]);
  fs.writeFileSync(file, line2);
  const fut = new Date(Date.now() + 2000);
  fs.utimesSync(file, fut, fut);
  await tail._drain();
  assert.deepEqual(seen, [1, 2], '同尺寸轮转后重新读到新事件');
});

test('Kimi：会话索引大小与修改时间没变就复用上次解析，不再每 350ms 整份重读', async t => {
  const { KimiTap } = require('../core/kimi-transcript-tap');
  const home = tmp('kimi-p0b-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const idx = path.join(home, 'session_index.jsonl');
  fs.writeFileSync(idx, JSON.stringify({ sessionId: 'a', sessionDir: 'sa', workDir: home }) + '\n');
  const tap = new KimiTap({ homeDir: home });
  const reads = t.mock.method(fs.promises, 'readFile');
  const first = await tap._readIndex();
  const second = await tap._readIndex();
  assert.equal(reads.mock.callCount(), 1, '没变：只读一次');
  assert.deepEqual(second, first);
  second[0].sessionId = 'changed';
  assert.equal((await tap._readIndex())[0].sessionId, 'a', '返回的是副本，调用方改了不污染缓存');
  await new Promise(r => setTimeout(r, 20));
  fs.appendFileSync(idx, JSON.stringify({ sessionId: 'b', sessionDir: 'sb', workDir: home }) + '\n');
  const third = await tap._readIndex();
  assert.equal(reads.mock.callCount(), 2, '变了：重读');
  assert.deepEqual(third.map(e => e.sessionId), ['a', 'b']);

  // Gemini 急补 #2：瞬时 readFile 报错不得把空表写进缓存导致永久失明
  const tap2 = new KimiTap({ homeDir: home });
  let failOnce = true;
  const origRead = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', async (...a) => {
    if (failOnce) { failOnce = false; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }
    return origRead.apply(fs.promises, a);
  });
  assert.deepEqual(await tap2._readIndex(), [], '首次瞬时读错返回空但不缓存');
  assert.deepEqual((await tap2._readIndex()).map(e => e.sessionId), ['a', 'b'], '同 sig 再次轮询立刻恢复读出');
});

test('Gemini 急补 #1/#2：DSH 跨 bound 重置 seenFloor、Pi/DSH 全量回读保留实时流式、headSig 随文件增长补齐 64 字节', async t => {
  const { DshCliSession, readDshCliTranscript } = require('../core/dsh-cli-session');
  const { PiCliSession } = require('../core/pi-cli-session');
  const { JsonlTail } = require('../core/jsonl-tail');
  const dir = tmp('gem-p0-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 1) DSH 跨 bound 重置 seenFloor：前会话 seq > 20000 切到新会话 seq=1 不丢卡片
  const dshFile = path.join(dir, 'dsh-rebind.jsonl');
  const rows = [
    { type: 'bound', sessionId: 'old', events: [{ seq: 25000, type: 'user/message', time: 1, data: { id: 'o1', source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }] } }] },
    { type: 'bound', sessionId: 'fresh', events: [{ seq: 1, type: 'user/message', time: 2, data: { id: 'n1', source: { kind: 'user' }, content: [{ type: 'text', text: 'fresh-msg' }] } }] },
  ];
  fs.writeFileSync(dshFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const dshCards = readDshCliTranscript(dshFile);
  assert.ok(dshCards.some(c => c.text === 'fresh-msg'), '跨 bound 重置 seenFloor，新会话低 seq 不被吞');

  // 2) Pi 运行中裁剪后全量回读合并磁盘旧轮与内存活跃流式 partial，且 blocks() 不触发读盘
  const piFile = path.join(dir, 'pi-merge.jsonl');
  fs.writeFileSync(piFile, [
    JSON.stringify({ type: 'session', id: 'p1' }),
    JSON.stringify({ type: 'message', id: 'old1', parentId: null, message: { role: 'user', content: 'old-q', timestamp: 100 } }),
  ].join('\n') + '\n');
  const pi = Object.assign(Object.create(PiCliSession.prototype), {
    options: {}, runtime: {}, pendingSteers: [], currentModel: 'm', _trimmedRecords: true, sessionFile: piFile,
    records: [{ userMessageId: 'live1', turnId: 'live1', text: 'live-q', createdAt: 200, accepted: true, status: 'running', partial: '流式进行中' }],
  });
  const fullPi = pi.readTranscript();
  assert.ok(fullPi.some(c => c.text === 'old-q'), '合并磁盘旧轮');
  assert.ok(fullPi.some(c => c.role === 'assistant' && String(c.text || '').includes('流式进行中')), '保留内存流式 partial');
  const reads = t.mock.method(fs, 'readFileSync');
  assert.equal(pi.blocks()[0].text, '流式进行中');
  assert.equal(reads.mock.calls.filter(c => c.arguments[0] === piFile).length, 0, 'blocks() 不触发读盘');

  // 3) JsonlTail 短首行增长后 headSig 升级至 64 字节（128 hex）
  const tailFile = path.join(dir, 'short-head.jsonl');
  fs.writeFileSync(tailFile, '{"a":1}\n');
  const got = [];
  const tail = new JsonlTail(tailFile, row => got.push(row.a), { pollMs: 50 });
  t.after(() => tail.close());
  await tail.start();
  assert.ok(tail._headSig.length < 128);
  fs.appendFileSync(tailFile, JSON.stringify({ a: 2, pad: 'x'.repeat(100) }) + '\n');
  await tail._drain();
  assert.equal(tail._headSig.length, 128, '文件增长后 headSig 补齐至 64 字节');
  assert.deepEqual(got, [1, 2]);
});

// ---------- 5. 状态条、隐藏终端保护 ----------
test('状态条网络区：一字未变不动，只有网速变了只换网速，别的变了才整段重写', () => {
  const { stripNetworkPlan } = require('../renderer/sidebar-strip-diff');
  const T1 = '<span class="strip-transfer">1K</span>', T2 = '<span class="strip-transfer">2K</span>';
  const parts = (head, tr) => ({ inner: head + tr, transfer: tr });
  assert.equal(stripNetworkPlan(null, parts('<button>VPN</button>', T1)), 'all');
  assert.equal(stripNetworkPlan(parts('<button>VPN</button>', T1), parts('<button>VPN</button>', T1)), 'skip');
  assert.equal(stripNetworkPlan(parts('<button>VPN</button>', T1), parts('<button>VPN</button>', T2)), 'transfer');
  assert.equal(stripNetworkPlan(parts('<button>VPN 日本</button>', T1), parts('<button>VPN 美国</button>', T2)), 'all');
  const src = read('renderer/session-list-renderer.js');
  assert.match(src, /stripNetworkPlan\(stripEl\._networkParts, \{ inner: networkInner, transfer \}\)/);
  assert.doesNotMatch(src, /stripEl\.querySelector\('\.strip-network'\)\.innerHTML = template/, '不再每次整段重写网络区');
});

test('隐藏终端保护：装上、退回（带原因）、跳过与补画都有计数，第一次退回警告一次', () => {
  delete require.cache[require.resolve('../renderer/xterm-hidden-render-guard')];
  const { installHiddenRenderGuard, hiddenRenderGuardStats } = require('../renderer/xterm-hidden-render-guard');
  const warns = [];
  const logger = { warn: m => warns.push(m) };
  assert.equal(installHiddenRenderGuard({ _core: { _renderService: { handleSelectionChanged() {} } } }, {}, logger), false);
  assert.equal(installHiddenRenderGuard({ _core: {} }, {}, logger), false);
  let st = hiddenRenderGuardStats();
  assert.equal(st.fallback, 2);
  assert.equal(st.reasons['no-_handleIntersectionChange'], 1);
  assert.equal(st.reasons['no-render-service'], 1);
  assert.equal(warns.length, 1, '只警告一次');
  assert.equal(installHiddenRenderGuard({}, { HUB_DISABLE_HIDDEN_RENDER_GUARD: '1' }, logger), false);
  const rs = { _isPaused: true, _selectionState: {}, handleSelectionChanged() {}, _handleIntersectionChange() { this._isPaused = false; } };
  const term = { _core: { _renderService: rs } };
  assert.equal(installHiddenRenderGuard(term, {}, logger), true);
  assert.equal(installHiddenRenderGuard(term, {}, logger), false, '重复调用');
  rs.handleSelectionChanged(1, 2, false);
  rs._handleIntersectionChange({});
  st = hiddenRenderGuardStats();
  assert.equal(st.installed, 1);
  assert.equal(st.fallback, 2, '重复调用不算退回');
  assert.equal(st.disabled, 1);
  assert.equal(st.skipped, 1);
  assert.equal(st.replayed, 1);
});
