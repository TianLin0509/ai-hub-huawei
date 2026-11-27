'use strict';
// 断开标记、进程退出、休眠即清除；认不出文案时不保护。
// 审查 2026-11-27：回车提交了 /welink 且屏幕进了 WeLink 连接页才认；只认带 WeLink 字样的状态行（反例见下）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWelinkLinkDetector, classifyScreen } = require('../core/welink-native/link-detector');
const { loadMarkers } = require('../core/welink-native/markers');
const { renderScreenLines } = require('../core/welink-native/screen');
const { collectProtectedSessionIds, createSessionAutoSuspendScheduler } = require('../main/session-auto-suspend');

const MIN = 60 * 1000;
const quiet = { log() {}, warn() {} };

function detector(extra = {}) {
  const changes = [];
  const d = createWelinkLinkDetector({ onChange: c => changes.push(c), dataDir: null, ...extra });
  return { d, changes };
}
const typeLine = (d, id, text) => { for (const ch of text) d.noteInput(id, ch); d.noteInput(id, '\r'); };
// 进了 WeLink 连接流程的样子：/welink 菜单（实测原文的关键几行）
const MENU = '\n  Connect to Welink\n  ❯ Scan QR code to create a new bot automatically (recommended)\n Navigate ↑↓ | Select 1/2 | Confirm enter | Back esc\n';
const enter = (d, id) => { typeLine(d, id, '/welink'); d.noteOutput(id, MENU); };

// 与真实 sessionManager.suspendSession / previewIdleSuspend 同一规则：excludeSessionIds 里的会话不收。
function fakeManager(items) {
  const calls = { idle: [], suspended: [] };
  const excluded = (opts, id) => opts.excludeSessionIds instanceof Set && opts.excludeSessionIds.has(id);
  return {
    calls,
    suspendIdleSessions(opts) {
      const requested = items.filter(i => i.idleMs >= opts.idleMs && !excluded(opts, i.sessionId)).map(i => i.sessionId);
      calls.idle.push(...requested);
      return { ok: true, count: requested.length, requested };
    },
    previewIdleSuspend(opts) {
      return { items: items.map(i => ({ ...i, settled: true, eligible: i.idleMs >= opts.idleMs && !excluded(opts, i.sessionId) })) };
    },
    suspendSession(id, opts) {
      if (excluded(opts, id)) return { ok: false, error: 'active-task' };
      calls.suspended.push(id); return { ok: true };
    },
  };
}

test('回车提交 /welink、屏幕进了 WeLink 连接页、再出现 WeLink 已连接，才算连上', () => {
  const { d, changes } = detector();
  d.noteOutput('a', 'WeLink connected\n');            // 没敲过命令：不读屏
  assert.equal(d.isLinked('a'), false);
  typeLine(d, 'a', 'hello');                          // 普通输入不触发
  d.noteOutput('a', 'WeLink connected\n');
  assert.equal(d.isLinked('a'), false);
  typeLine(d, 'a', '/welink');
  d.noteOutput('a', 'Database connected\n');
  assert.equal(d.isLinked('a'), false, '不带 WeLink 的状态不认');
  d.noteOutput('a', MENU);
  d.noteOutput('a', '\x1b[32m● WeLink 已连接\x1b[0m\n');
  assert.equal(d.isLinked('a'), true);
  assert.deepEqual([...d.linkedIds()], ['a']);
  assert.deepEqual(changes.map(c => [c.sessionId, c.linked]), [['a', true]]);
});

test('快连：选已有助手 2 秒内就连上、菜单一闪而过没被读到，也要保护；超过窗口期才出现的不认', async () => {
  let t = 0; const timers = [];
  const screens = { a: ['│ > Anything I can assist you with?', '● WeLink connected'] };
  const { d } = detector({ now: () => t, readScreen: async id => screens[id], setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} });
  typeLine(d, 'a', '/welink');
  d.noteOutput('a', 'frames…');
  t += 2000; await timers.at(-1)(); await new Promise(r => setImmediate(r));
  assert.equal(d.isLinked('a'), true, '读屏时已经是连上后的主界面');
  const late = detector({ now: () => t });
  typeLine(late.d, 'b', '/welink');
  t += 3 * MIN;
  late.d.noteOutput('b', 'WeLink connected');
  assert.equal(late.d.isLinked('b'), false, '窗口期外才出现，不认');
});

test('反例：敲了 /wel 又删掉、Esc 清空、Ctrl+U 清空，都不算提交', () => {
  for (const cancel of ['\x7f\x7f\x7f\x7f', '\x1b', '\x15']) {
    const { d } = detector();
    for (const ch of '/wel') d.noteInput('a', ch);
    d.noteInput('a', cancel);
    for (const ch of 'hi') d.noteInput('a', ch);
    d.noteInput('a', '\r');
    d.noteOutput('a', MENU + 'WeLink connected');
    assert.equal(d.isLinked('a'), false, JSON.stringify(cancel));
  }
});

test('反例：正文里的「Database connected」「not connected」、没带 WeLink 的 connected 都不算', () => {
  const { d } = detector();
  enter(d, 'a');
  for (const text of ['\nDatabase connected', '\nstatus: connected', '\nThe server is not connected', '\nconnected']) {
    d.noteOutput('a', text);
    assert.equal(d.isLinked('a'), false, text);
  }
  assert.equal(classifyScreen('WeLink not connected').link, 'disconnected');
  assert.equal(classifyScreen('Database connected').link, 'unknown');
  assert.equal(classifyScreen('WeLink 未连接').link, 'disconnected');
  assert.equal(classifyScreen('WeLink 不在线').link, 'disconnected', '「不在线」不能被当成「在线」');
});

test('反例：提交了 /welink 但 2 分钟都没进 WeLink 连接页（比如被同名 skill 接走），不再读这个会话', () => {
  let t = 0;
  const { d } = detector({ now: () => t });
  typeLine(d, 'a', '/welink');
  d.noteOutput('a', 'skill 正在执行…');
  t += 3 * MIN;
  d.noteOutput('a', 'WeLink connected');
  assert.equal(d.isLinked('a'), false);
  assert.equal(d._sessions.has('a'), false);
});

test('退格改正、旧版 /welink-access、整段粘贴都能认出命令', () => {
  const { d } = detector();
  for (const ch of '/wex\x7flink') d.noteInput('b', ch);
  d.noteInput('b', '\r');
  d.noteOutput('b', MENU + 'WeLink: connected');
  assert.equal(d.isLinked('b'), true);
  d.noteInput('c', '\x1b[200~/welink-access\x1b[201~\r');
  d.noteOutput('c', MENU + 'WeLink connected');
  assert.equal(d.isLinked('c'), true);
});

test('断开标记出现即清除，敲空格恢复后再次连上；disconnected 不会被误认成 connected', () => {
  const { d, changes } = detector();
  enter(d, 'a');
  d.noteOutput('a', 'WeLink connected');
  d.noteOutput('a', '\nWeLink: disconnected');
  assert.equal(d.isLinked('a'), false);
  d.noteOutput('a', '\nWeLink: connected');
  assert.equal(d.isLinked('a'), true);
  assert.deepEqual(changes.map(c => c.linked), [true, false, true]);
  assert.equal(classifyScreen('WeLink disconnected').link, 'disconnected');
  assert.equal(classifyScreen('WeLink connecting...\nWeLink connected').link, 'connected');
  assert.equal(classifyScreen('没有任何标记').link, 'unknown');
});

test('进程退出或休眠即清除，并通知一次', () => {
  const { d, changes } = detector();
  enter(d, 'a'); d.noteOutput('a', 'WeLink connected');
  d.noteExit('a', 'exit');
  assert.equal(d.isLinked('a'), false);
  assert.equal(d.linkedIds().size, 0);
  d.noteExit('a', 'exit');
  assert.deepEqual(changes.map(c => [c.linked, c.reason]), [[true, 'marker'], [false, 'exit']]);
});

test('非 CodeAgent 终端会话不跟踪；没敲过命令的会话不留状态', () => {
  const { d } = detector({ isEligible: id => id !== 'claude' });
  enter(d, 'claude'); d.noteOutput('claude', 'WeLink connected');
  assert.equal(d.isLinked('claude'), false);
  typeLine(d, 'x', 'ls');
  assert.equal(d._sessions.has('x'), false);
});

test('文案对不上时只是认不出：不保护', () => {
  const markers = loadMarkers({ override: { link: { connected: ['完全不会出现的标记XYZ'] } } });
  const { d } = detector({ markers });
  enter(d, 'a'); d.noteOutput('a', 'WeLink connected');
  assert.equal(d.isLinked('a'), false);
});

test('写错的覆盖正则被跳过，整类为空时回落默认值', () => {
  const m = loadMarkers({ override: { link: { connected: ['(', '[unclosed'] }, pages: { idle: [['(', 'x']] } } });
  assert.ok(m.link.connected.length > 0);
  assert.equal(classifyScreen('WeLink connected', m).link, 'connected');
  assert.equal(classifyScreen('Anything I can assist you with?', m).page, 'idle', '整组写错就回落默认');
});

test('休眠保护名单带上已连 WeLink 的会话；取名单出错不影响其余保护', () => {
  assert.ok(collectProtectedSessionIds({ getWelinkLinkedIds: () => new Set(['w1']) }).has('w1'));
  assert.equal(collectProtectedSessionIds({ getWelinkLinkedIds: () => { throw new Error('x'); } }).size, 0);
});

test('闲置巡检与内存压力档（95% 最激进一档）都跳过已连 WeLink 的会话；断开后照常收', () => {
  const { d } = detector();
  enter(d, 'w'); d.noteOutput('w', 'WeLink connected');
  const items = [
    { sessionId: 'w', idleMs: 8 * 60 * MIN, lastActivityAt: 1, purpose: null },
    { sessionId: 'o', idleMs: 8 * 60 * MIN, lastActivityAt: 2, purpose: null },
  ];
  const mgr = fakeManager(items);
  const s = createSessionAutoSuspendScheduler({
    sessionManager: mgr, logger: quiet, getMemoryUsage: () => 0.97,
    getProtectedSessionIds: () => collectProtectedSessionIds({ getWelinkLinkedIds: () => d.linkedIds() }),
  });
  s.sweep();
  assert.deepEqual(mgr.calls.idle, ['o']);
  s.memorySweep();
  assert.deepEqual(mgr.calls.suspended, ['o']);
  d.noteOutput('w', '\nWeLink disconnected');
  mgr.calls.suspended.length = 0;
  s.memorySweep();
  assert.ok(mgr.calls.suspended.includes('w'), '断开后不再保护');
});

// ---- 按实测屏幕（CodeAgent 1.2615.02.05，渲染后整屏，已脱敏）认页面 ----
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'welink-native', name), 'utf8');

test('实测三屏：首次菜单、二维码页、填 AppKey 页各自认得出，且都不是「已连接 / 断开」', () => {
  const cases = { 'screen-menu-first.txt': 'welinkMenu', 'screen-qr.txt': 'needScan', 'screen-appid-form.txt': 'appIdForm' };
  for (const [file, page] of Object.entries(cases)) {
    const r = classifyScreen(fixture(file));
    assert.equal(r.page, page, file);
    assert.notEqual(r.link, 'connected', file + '：Connect to Welink / Connect enter 不能误认成已连接');
    assert.notEqual(r.link, 'disconnected', file);
  }
  assert.equal(classifyScreen('   连接WeLink\n   Connect to Welink\n   Enter existing App ID and App Secret\n Navigate ↑↓ | Select 1/2 | Confirm enter | Back esc').page, 'notWhitelisted',
    '菜单里没有扫码新建这一项 = 白名单未开');
  assert.equal(classifyScreen('│ > Anything I can assist you with? (Ctrl+J 换行)\n│ Bypass (Cycle shift+tab) |').page, 'idle');
  assert.equal(classifyScreen(' Accessing workspace:\n > Yes, I trust this folder\n   No, exit').page, 'trustFolder');
});

test('有渲染器时：输出停下后读一次整屏判断；整屏用完不留', async () => {
  const timers = [];
  const screens = { a: ['┃ /welink', ...MENU.split('\n'), 'WeLink connected'] };
  const { d } = detector({ readScreen: async id => screens[id], setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} });
  typeLine(d, 'a', '/welink');
  d.noteOutput('a', '\x1b[2J\x1b[Hwhatever');
  d.noteOutput('a', 'more');
  assert.equal(d.isLinked('a'), false, '还没读屏');
  await timers.at(-1)();
  await new Promise(r => setImmediate(r));
  assert.equal(d.isLinked('a'), true);
  assert.equal(JSON.stringify([...d._sessions.values()]).includes('WeLink connected'), false, '整屏文字不保存');
});

test('渲染器：全屏重绘的字节流还原成整屏文字', async () => {
  const raw = '\x1b[2J\x1b[H\x1b[1;1HConnect to Welink\x1b[3;1H❯ Scan QR code to create a new bot\x1b[10;1HNavigate ↑↓ | Select 1/2 | Confirm enter | Back esc';
  const lines = await renderScreenLines({ text: raw, cols: 120, rows: 12 });
  assert.equal(classifyScreen(lines).page, 'welinkMenu');
});

test('界面一直在刷新时读屏最多顺延 10 秒，不会永远等不到', () => {
  let t = 0; const timers = [];
  const { d } = detector({ now: () => t, readScreen: async () => [], setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: id => { timers[id - 1] = null; } });
  typeLine(d, 'a', '/welink');
  for (let i = 0; i < 30; i += 1) { d.noteOutput('a', 'frame'); t += 500; }
  assert.ok(timers.filter(Boolean).length === 1, '同一时刻只挂一个读屏');
  assert.ok(timers.findIndex(Boolean) < 25, '超过 10 秒后不再顺延');
});

test('只认完整命令：/welcome、/wel 回车不算；方向键序列被剥掉；Tab 提交完整命令也算', () => {
  for (const [input, armed] of [['/welcome\r', false], ['/wel\r', false], ['\x1b[A/welink\r', true], ['\x1bOA/welink\r', true], ['/welink\t', true], ['/welink-access\r', true]]) {
    const { d } = detector();
    d.noteInput('a', input);
    d.noteOutput('a', MENU + 'WeLink connected');
    assert.equal(d.isLinked('a'), armed, JSON.stringify(input));
  }
});

test('读屏节流：两次整屏回放至少隔 2 秒', () => {
  let t = 0; const delays = [];
  const { d } = detector({ now: () => t, readScreen: async () => [], setTimeout: (fn, ms) => { delays.push(ms); return { fn }; }, clearTimeout: () => {} });
  typeLine(d, 'a', '/welink');
  d.noteOutput('a', 'x');
  assert.equal(delays.at(-1), 2000);
  const e = d._sessions.get('a'); e.timer.fn();       // 第一次读屏在 t=0
  t += 100; d.noteOutput('a', 'y');
  assert.ok(delays.at(-1) >= 1900, '离上次读屏不到 2 秒：至少等够 2 秒');
});
