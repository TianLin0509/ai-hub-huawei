'use strict';
// 2026-11-23 开销优化 P1 v2：低开销模式的会话与运行期节能（L1–L6）+ 保活会话数，并入主干唯一的「低开销模式」总开关。
// 覆盖：保活数与模式同存 optional-features.json；控制器只读主干真值；启动时序（Codex R2）；L1 待审批真值源（Gemini P0-4）
// 与焦点 30 分钟从聚焦起算（Codex R3 / Gemini P1-1，用真实 SessionManager）；桌宠开关往返（Codex R1 / Gemini P0-3）；
// L2/L5/L6 边界（Gemini P2）；状态条「省」徽章、内存面板横条、「资源与后台」顶行保活下拉；「常用」页不加控件。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const policy = require('../core/low-overhead-policy');
const of = require('../core/optional-features');
const { createLowOverheadController } = require('../main/low-overhead-controller');
const ui = require('../renderer/low-overhead-ui');

const MIN = 60 * 1000;
const quiet = { log() {}, warn() {} };
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lo-p1v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------- 单一真值：模式开关 + 保活数都在 optional-features.json ----------
test('保活数和模式同存 optional-features.json：默认 2、钳制 1..3、重启后保留；状态对象 on 与 enabled 两种写法都认', t => {
  const dir = tmpDir(t);
  const f = of.createOptionalFeatures({ dataDir: dir, logger: quiet });
  assert.equal(f.lowOverheadKeepAlive(), 2);
  assert.equal(f.setLowOverheadKeepAlive(9), 3);
  assert.equal(f.setLowOverheadKeepAlive('1'), 1);
  assert.equal(f.lowOverhead(), false, '改保活数不碰模式');
  f.setLowOverhead(true);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, of.FILE), 'utf8'));
  assert.equal(raw.lowOverheadKeepAlive, 1);
  assert.equal(raw.lowOverhead, true);
  const again = of.createOptionalFeatures({ dataDir: dir, logger: quiet });
  assert.deepEqual([again.lowOverhead(), again.lowOverheadKeepAlive()], [true, 1], '重启后原样');
  for (const [input, want] of [[0, 1], [-5, 1], [1, 1], [2, 2], [3, 3], [4, 3], ['2', 2], [2.6, 3], ['abc', 2], [undefined, 2]]) {
    assert.equal(policy.normalizeKeepAlive(input), want, String(input));
  }
  assert.deepEqual(policy.normalizeState({ on: true, keepAlive: 3 }), { on: true, enabled: true, keepAlive: 3 });
  assert.deepEqual(policy.normalizeState({ enabled: true }), { on: true, enabled: true, keepAlive: 2 });
  assert.deepEqual(policy.normalizeState(null), { on: false, enabled: false, keepAlive: 2 });
  assert.equal(policy.normalizeState({ on: 'true' }).on, false, '只认布尔 true');
});

test('主干合同：low-overhead:state 返回 { on, enabled, keepAlive, hintPending, installKind }；set 支持 { on?, enabled?, keepAlive? }；不再有第二套通道与 config.json 字段', () => {
  const main = read('main.js');
  assert.match(main, /return \{ on, enabled: on, keepAlive: optionalFeatures\.lowOverheadKeepAlive\(\), hintPending: optionalFeatures\.lowOverheadHintPending\(\), installKind: optionalFeatures\.installKind\(\) \};/);
  assert.match(main, /const wantOn = typeof req\.on === 'boolean' \? req\.on : typeof req\.enabled === 'boolean' \? req\.enabled : null;/);
  assert.match(main, /if \(req\.keepAlive != null\) optionalFeatures\.setLowOverheadKeepAlive\(req\.keepAlive\);/);
  // 只改保活数时不跑 switchLowOverhead（不批量开关后台功能）
  const setBody = main.slice(main.indexOf("ipcMain.handle('low-overhead:set'"), main.indexOf("ipcMain.handle('low-overhead:dismiss-hint'"));
  assert.ok(setBody.indexOf('if (wantOn === null)') < setBody.indexOf('switchLowOverhead'), '仅 keepAlive 时提前返回');
  assert.match(setBody, /on: wantOn \}\);[\s\S]*?lowOverheadController\?\.sync\(\);/, '切完模式再让 L1–L6 跟上真值');
  assert.doesNotMatch(main, /low-overhead:get|registerIpc\(\)|lowOverheadMode/, '不并存第二套通道 / config.json 开关');
  const src = read('core/low-overhead-policy.js') + read('main/low-overhead-controller.js') + read('renderer/low-overhead-ui.js');
  assert.doesNotMatch(src, /lowOverheadMode|readConfigJson|writeConfigJson|low-overhead:get/);
});

// ---------- 控制器：只读真值，落到各模块 ----------
function fakeFeatures(on = false, keepAlive = 2) {
  const box = { on, keepAlive };
  return { box, getMode: () => ({ on: box.on, keepAlive: box.keepAlive }) };
}
function makeController(features, options = {}) {
  const calls = { save: [], search: [], pet: 0 };
  const timers = [];
  const ctrl = createLowOverheadController({
    getMode: features.getMode,
    stateStore: { setSaveMinInterval: ms => calls.save.push(ms) },
    getSearchService: () => ({ setIdleExitMs: ms => calls.search.push(ms) }),
    getPetController: () => ({ refreshLowOverhead: () => { calls.pet += 1; } }),
    setIntervalFn: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearIntervalFn: timer => { timer.cleared = true; },
    logger: quiet,
    ...options,
  });
  return { ctrl, calls, timers };
}

test('控制器：默认关闭启动一个模块都不碰；开启后免重启作用到存盘/搜索/桌宠并挂巡检；关闭恢复原值', () => {
  const f = fakeFeatures(false);
  const h = makeController(f);
  assert.deepEqual(h.ctrl.start(), { on: false, enabled: false, keepAlive: 2 });
  assert.deepEqual(h.calls, { save: [], search: [], pet: 0 }, '老用户默认路径零变化');
  assert.equal(h.timers.length, 0);
  f.box.on = true;
  h.ctrl.sync();
  assert.deepEqual(h.calls.save, [30000], 'L6 state.json 节流 15→30 秒（2026-11-28 默认 2→15 秒）');
  assert.deepEqual(h.calls.search, [10 * MIN], 'L4 搜索进程空闲 10 分钟退出');
  assert.equal(h.calls.pet, 1, 'L3 桌宠立即重发状态');
  assert.equal(h.timers[0].ms, policy.SOFT_CAP_CHECK_MS);
  f.box.on = false;
  h.ctrl.sync();
  assert.equal(h.calls.save.at(-1), 15000);
  assert.equal(h.calls.search.at(-1), null, '关闭恢复原策略（常驻）');
  assert.equal(h.timers[0].cleared, true);
  assert.equal(h.ctrl.isCapTimerRunning(), false);
});

// Codex R2：两种交错时序。renderer store 经 low-overhead:state 读主进程真值（main.js lowOverheadState 同一口径）。
function rendererStoreFor(ctrl) {
  const pushes = [];
  const store = ui.createLowOverheadStore({
    invoke: async channel => {
      assert.equal(channel, 'low-overhead:state');
      return { ok: true, ...ctrl.get(), hintPending: false, installKind: 'legacy' };
    },
    subscribe: fn => pushes.push(fn),
  });
  return { store, push: payload => pushes.forEach(fn => fn(payload)) };
}

test('启动时序 R2-a：持久化已开、renderer 先读、main 后 start → 界面读到的就是「开」，不再停在默认关', async t => {
  const dir = tmpDir(t);
  const seed = of.createOptionalFeatures({ dataDir: dir, logger: quiet });
  seed.setLowOverhead(true); seed.setLowOverheadKeepAlive(1);
  const features = of.createOptionalFeatures({ dataDir: dir, logger: quiet });   // 模拟重启
  const h = makeController({ getMode: () => ({ on: features.lowOverhead(), keepAlive: features.lowOverheadKeepAlive() }) });
  const r = rendererStoreFor(h.ctrl);
  await r.store.refresh();                       // renderer 抢在 start 之前
  assert.deepEqual(r.store.get(), { on: true, enabled: true, keepAlive: 1 });
  h.ctrl.start();
  assert.deepEqual(h.ctrl.get(), r.store.get(), '主进程与界面一致');
  assert.deepEqual(h.calls.save, [30000]);
  assert.equal(h.ctrl.isCapTimerRunning(), true);
});

test('启动时序 R2-b：main 先 start、renderer 后读；以及页面加载完主进程推送能纠正读失败的界面', async () => {
  const f = fakeFeatures(true, 3);
  const h = makeController(f);
  h.ctrl.start();
  const r = rendererStoreFor(h.ctrl);
  await r.store.refresh();
  assert.deepEqual(r.store.get(), { on: true, enabled: true, keepAlive: 3 });
  // 读失败的界面（invoke 抛错）收到 did-finish-load 推送后纠正
  const pushes = [];
  const broken = ui.createLowOverheadStore({ invoke: async () => { throw new Error('not ready'); }, subscribe: fn => pushes.push(fn) });
  await broken.refresh();
  assert.equal(broken.isEnabled(), false);
  pushes[0]({ on: true, enabled: true, keepAlive: 3, hintPending: false });
  assert.equal(broken.isEnabled(), true);
  const main = read('main.js');
  const created = main.indexOf('low-overhead-controller.js\x27).createLowOverheadController(');
  const started = main.indexOf('try { lowOverheadController.start(); }');
  const firstWindow = main.indexOf('\n  createWindow();');
  assert.ok(created > 0 && started > created, '控制器创建并 start');
  assert.ok(started < firstWindow, 'start 在 app.whenReady 里第一次 createWindow 之前（模块顶层）');
  assert.match(main, /did-finish-load', \(\) => \{\s*traceStartup\('did-finish-load'\);\s*\/\/[^\n]*\n\s*try \{ sendToRenderer\('low-overhead:changed', lowOverheadState\(\)\); \}/, '页面每次加载完主动推真值');
});

// ---------- L1 纯策略 ----------
const NOW = 10_000 * MIN;
const item = (id, lastActivityAt, extra = {}) => ({ sessionId: id, title: id, eligible: true, reason: null, settled: true,
  status: 'idle', idleMs: NOW - lastActivityAt, lastActivityAt, ...extra });

test('L1：保活最近 keepAlive 个，其余按最后活动从早到晚收；调到 1 个多收一个', () => {
  const items = [item('a', NOW - 90 * MIN), item('b', NOW - 20 * MIN), item('c', NOW - 70 * MIN), item('d', NOW - 40 * MIN)];
  const plan = policy.pickSoftCapVictims(items, { keepAlive: 2, now: NOW });
  assert.deepEqual(plan.kept.map(i => i.sessionId), ['b', 'd']);
  assert.deepEqual(plan.victims.map(i => i.sessionId), ['a', 'c'], '最早的先收');
  assert.deepEqual(policy.pickSoftCapVictims(items, { keepAlive: 1, now: NOW }).victims.map(i => i.sessionId), ['a', 'c', 'd']);
  assert.deepEqual(policy.pickSoftCapVictims(items.slice(0, 2), { keepAlive: 2, now: NOW }).victims, [], '没超上限不动');
});

test('L1：运行中 / 等待 / 待审批 / 置顶 / 组队 / 助理 / 未绑定原生 ID / 时间全空一律豁免，不占名额', () => {
  const items = [
    item('run', NOW - 99 * MIN, { settled: false, status: 'running' }),
    item('wait', NOW - 98 * MIN, { status: 'waiting' }),
    item('perm', NOW - 97 * MIN, { pendingApproval: true }),
    item('pin', NOW - 96 * MIN, { pinned: true }),
    item('team', NOW - 95 * MIN, { exempt: true }),
    item('asst', NOW - 94 * MIN, { purpose: 'company-assistant' }),
    item('nativeid', NOW - 93 * MIN, { eligible: false, reason: 'native-session-id-missing', lastActivityAt: 0 }),
    item('notime', 0, { idleMs: undefined, lastActivityAt: undefined }),
    item('old', NOW - 60 * MIN), item('mid', NOW - 30 * MIN), item('new', NOW - 20 * MIN),
  ];
  const plan = policy.pickSoftCapVictims(items, { keepAlive: 2, now: NOW });
  assert.deepEqual(plan.victims.map(i => i.sessionId), ['old'], '时间全空不按 0 排最旧先收');
  const exempt = Object.fromEntries(plan.exempt.map(e => [e.sessionId, e.why]));
  assert.deepEqual(exempt, { run: 'busy', wait: 'busy', perm: 'pending-approval', pin: 'pinned', team: 'external',
    nativeid: 'native-session-id-missing', notime: 'no-activity-time' });
  assert.equal(plan.reclaimableCount, 3, '未绑定原生 ID 不计入可回收数');
});

test('L1 焦点：30 分钟从「上次输入输出」与「这次聚焦」较晚者算起；刚点开的旧会话受保护，挂满 30 分钟才回收', () => {
  const old = { idleMs: 60 * MIN, lastActivityAt: NOW - 60 * MIN, focused: true };
  assert.equal(policy.exemptReason({ ...item('f', NOW - 60 * MIN), ...old, focusedAt: NOW - 1000 }, { now: NOW }), 'focused', '刚聚焦');
  assert.equal(policy.exemptReason({ ...item('f', NOW - 60 * MIN), ...old, focusedAt: NOW - 29 * MIN }, { now: NOW }), 'focused');
  assert.equal(policy.exemptReason({ ...item('f', NOW - 60 * MIN), ...old, focusedAt: NOW - 31 * MIN }, { now: NOW }), null, '挂满 30 分钟解除');
  assert.equal(policy.exemptReason({ ...item('f', NOW - 60 * MIN), ...old, focusedAt: 0 }, { now: NOW }), null, '无聚焦时刻按输入输出算');
  assert.equal(policy.exemptReason({ ...item('f', NOW - 5 * MIN), focused: true, focusedAt: NOW - 50 * MIN }, { now: NOW }), 'focused', '最近还在输出也保护');
  assert.equal(policy.FOCUS_IDLE_EXEMPT_MS, 30 * MIN);
});

// ---------- L1 端到端：真实 SessionManager → collectItems → softCapSweep ----------
function realManager(rows, t0) {
  const { SessionManager } = require('../core/session-manager');
  const sm = new SessionManager();
  for (const r of rows) {
    sm.sessions.set(r.id, { info: { id: r.id, kind: 'claude', status: 'idle', title: r.id, ccSessionId: 'cc-' + r.id, ...r.info },
      startedAt: t0 - r.idleMin * MIN, lastInputAt: t0 - r.idleMin * MIN, lastOutputAt: t0 - r.idleMin * MIN });
  }
  const suspended = [];
  const realSuspend = sm.suspendSession.bind(sm);
  // 资格判断走真实闸门，只把最后「结束 PTY」换成记录（不起任何进程）。
  sm.suspendSession = (id, opts) => {
    const verdict = sm._evaluateSuspendEligibility(id, opts);
    if (verdict.ok) { suspended.push({ id, reason: opts.reason }); sm.sessions.delete(id); }   // 休眠后不再是活会话
    return verdict.ok ? { ok: true } : verdict;
  };
  void realSuspend;
  return { sm, suspended };
}

test('L1 待审批真值源（Gemini P0-4）：PTY 停在审批（status=idle + attentionState=needs-input）与 native waiting 都不被休眠', () => {
  const t0 = Date.now();
  const { sm, suspended } = realManager([
    { id: 'perm-pty', idleMin: 90, info: { status: 'idle', attentionState: 'needs-input', needsUserInput: true, isWaiting: true } },
    { id: 'perm-native', idleMin: 85, info: { kind: 'codex', runtimeBackend: 'codex-app-server', codexSid: 'sid-n', nativeRuntime: { state: 'waiting' } } },
    { id: 'old', idleMin: 80 }, { id: 'mid', idleMin: 30 }, { id: 'new', idleMin: 20 },
  ], t0);
  const h = makeController(fakeFeatures(true, 2), { sessionManager: sm, now: () => t0 });
  const items = h.ctrl.collectItems();
  assert.equal(items.find(i => i.sessionId === 'perm-pty').pendingApproval, true, '真实 info 字段识别为待审批');
  h.ctrl.start();
  const r = h.ctrl.softCapSweep();
  assert.deepEqual(suspended.map(s => s.id), ['old'], '只收最旧的普通会话');
  assert.ok(!r.requested.some(x => x.sessionId.startsWith('perm')));
  assert.equal(suspended[0].reason, policy.SOFT_CAP_REASON);
});

test('L1 焦点（Codex R3 / Gemini P1-1，真实 SessionManager）：1 小时前完成的旧会话刚被点开，巡检立刻保护；聚焦挂机满 30 分钟才回收', () => {
  const t0 = Date.now();
  const { sm, suspended } = realManager([{ id: 'read-old', idleMin: 60 }, { id: 'b', idleMin: 20 }, { id: 'c', idleMin: 15 }], t0);
  sm.setFocusedSession('read-old');            // 用户此刻点开阅读
  assert.ok(Math.abs(sm.getFocusedSessionState().focusedAt - t0) < 5000);
  let offset = 0;
  const h = makeController(fakeFeatures(true, 2), { sessionManager: sm, now: () => t0 + offset });
  h.ctrl.start();
  h.ctrl.softCapSweep();
  assert.deepEqual(suspended, [], '刚聚焦受保护');
  offset = 29 * MIN; h.ctrl.softCapSweep();
  assert.deepEqual(suspended, [], '29 分钟仍保护');
  offset = 31 * MIN; h.ctrl.softCapSweep();
  assert.deepEqual(suspended.map(s => s.id), ['read-old'], '挂满 30 分钟后才回收');
});

test('L1 巡检时机：开启或调小保活数立即巡检一次，调大不巡检；关闭不收', () => {
  const t0 = Date.now();
  const { sm, suspended } = realManager([{ id: 'a', idleMin: 90 }, { id: 'b', idleMin: 60 }, { id: 'c', idleMin: 30 }, { id: 'd', idleMin: 15 }], t0);
  const f = fakeFeatures(false, 3);
  const h = makeController(f, { sessionManager: sm, now: () => t0 });
  h.ctrl.start();
  assert.equal(h.ctrl.softCapSweep().skipped, true);
  f.box.on = true; h.ctrl.sync();
  assert.deepEqual(suspended.map(s => s.id), ['a'], '开启即巡检（保活 3）');
  f.box.keepAlive = 1; h.ctrl.sync();
  assert.deepEqual(suspended.map(s => s.id), ['a', 'b', 'c'], '调小立即收');
});

// ---------- L2 ----------
test('L2：关闭时运行方式就是保存的值；开启默认 serve、亲手选 PTY 听他的；保存失败一并回滚「亲手选过」；低开销变化时重画', () => {
  assert.equal(policy.codeagentRunModeFor('pty', { on: false }), 'pty');
  assert.equal(policy.codeagentRunModeFor('serve', { on: false }), 'serve');
  assert.equal(policy.codeagentRunModeFor(undefined, null), 'pty');
  assert.equal(policy.codeagentRunModeFor('pty', { on: true }), 'serve');
  assert.equal(policy.codeagentRunModeFor('pty', { on: true }, { explicit: true }), 'pty');
  const js = read('renderer/workspace-controller.js');
  assert.match(js, /effectiveCodeagentRunMode\(\) === 'serve'\) opts\.codeagentRunMode = 'serve'/);
  assert.match(js, /const previousExplicit = codeagentRunModeExplicit;/);
  assert.match(js, /if \(!result\?\.ok\) \{ codeagentRunMode = previous; codeagentRunModeExplicit = previousExplicit;/, 'Gemini P2-1 ①');
  assert.match(js, /window\.__hubLowOverhead\?\.onChange\?\.\(\(\) => \{ try \{ paintRunMode\(\);[^}]*\}/, 'Gemini P2-1 ②');   // R34 起回调里还会重画工作目录限制
  assert.match(js, /document\.addEventListener\('DOMContentLoaded', subscribeLowOverhead, \{ once: true \}\)/, '本文件先于 renderer.js 加载，等共享状态建好再订阅');
  const policySrc = read('core/low-overhead-policy.js') + read('main/low-overhead-controller.js') + read('renderer/low-overhead-ui.js');
  assert.doesNotMatch(policySrc, /USERPROFILE|HOMEDRIVE|shadow.?home/i, '低开销模式不碰 HOME');
});

// ---------- L3（Codex R1 / Gemini P0-3）----------
test('L3 桌宠：同一窗口 开→省略→开→显式关 状态往返，lowPower / 静止档 / soft-gpu 当场恢复，气泡照常', () => {
  const M = require('../renderer/hub-pet/pet-motion');
  const base = { pose: 'idle', mode: 'normal', softGpu: false, bubble: null };
  let state = { pose: 'idle' };
  const look = () => ({ lowPower: state.lowPower === true, soft: M.decorStill({ softGpu: state.softGpu === true, lowPower: state.lowPower === true }) });
  state = M.mergeMainState(state, { ...base, lowPower: true, bubble: { text: '答完了' } });
  assert.deepEqual(look(), { lowPower: true, soft: true });
  assert.equal(state.bubble.text, '答完了', '低开销时气泡照常');
  state = M.mergeMainState(state, { ...base });            // 主进程关闭态省略字段
  assert.deepEqual(look(), { lowPower: false, soft: false }, '省略＝关，当场恢复');
  state = M.mergeMainState(state, { ...base, lowPower: true });
  assert.deepEqual(look(), { lowPower: true, soft: true });
  state = M.mergeMainState(state, { ...base, lowPower: false });
  assert.deepEqual(look(), { lowPower: false, soft: false });
  state = M.mergeMainState(state, { ...base, softGpu: true });
  assert.deepEqual(look(), { lowPower: false, soft: true }, '兼容渲染机原本的 soft-gpu 保留');
  const pet = read('renderer/hub-pet/pet.js');
  assert.match(pet, /state = M\.mergeMainState\(state, next\);/);
  assert.doesNotMatch(pet, /state = \{ \.\.\.state, \.\.\.next \};/);
  assert.match(pet, /classList\.toggle\('soft-gpu', M\.decorStill\(\{ softGpu: softGpu\(\), lowPower: lowPower\(\) \}\)\)/);
  assert.match(pet, /function stillMode\(\) \{ return state\.mode === 'quiet' \|\| reducedMotion\.matches \|\| lowPower\(\); \}/);
  const ctrl = read('main/hub-pet-controller.js');
  assert.match(ctrl, /\.\.\.\(lowOverhead\(\) === true \? \{ lowPower: true \} : \{\}\)/, '关闭态消息逐字节不变');
  assert.equal(M.calmDelay({ pose: 'typing', calmFps: { typing: 30 }, still: true }), 1000 / 30, '打字照常');
  assert.match(read('main.js'), /lowOverhead: \(\) => lowOverheadController\?\.isEnabled\(\) === true/);
});

// ---------- L4 ----------
test('L4：搜索子进程开启时空闲 10 分钟退出，关闭恢复常驻', () => {
  const { SessionSearchService } = require('../core/session-search-service');
  const previous = process.env.HUB_SESSION_SEARCH_IDLE_MS;
  delete process.env.HUB_SESSION_SEARCH_IDLE_MS;
  try {
    const svc = new SessionSearchService({ fork: () => { throw new Error('not started'); } });
    assert.equal(svc._idleMs, 0, '默认常驻');
    svc._child = {};
    assert.equal(svc.setIdleExitMs(policy.searchIdleExitMs({ on: true })), 10 * MIN);
    assert.ok(svc._idleTimer);
    assert.equal(svc.setIdleExitMs(policy.searchIdleExitMs({ on: false })), 0);
    assert.equal(svc._idleTimer, null);
    svc._child = null;
  } finally {
    if (previous !== undefined) process.env.HUB_SESSION_SEARCH_IDLE_MS = previous;
  }
});

// ---------- L5 ----------
test('L5：关闭时 10000 行、闪光标且从没开过不碰终端；开启收敛；分屏切回单屏、换焦点时重算（Gemini P2-2）', () => {
  assert.deepEqual(ui.initialTerminalOptions({ on: false }), { scrollback: 10000, cursorBlink: true });
  assert.deepEqual(ui.initialTerminalOptions({ on: true }), { scrollback: 3000, cursorBlink: true });
  const mk = () => ({ terminal: { options: { scrollback: 10000, cursorBlink: true } } });
  const cache = new Map([['a', mk()], ['b', mk()]]);
  const tuner = ui.createTerminalTuner();
  assert.equal(tuner.apply(cache, { on: false }, id => id === 'a'), 0, '默认路径零改动');
  tuner.apply(cache, { on: true }, id => id === 'a' || id === 'b');   // 双屏：两边都可见
  assert.equal(cache.get('b').terminal.options.cursorBlink, true);
  tuner.apply(cache, { on: true }, id => id === 'a');                 // 切回单屏
  assert.equal(cache.get('b').terminal.options.cursorBlink, false, '原副屏停闪');
  tuner.apply(cache, { on: false }, () => false);
  assert.deepEqual(cache.get('b').terminal.options, { scrollback: 10000, cursorBlink: true });
  const js = read('renderer/renderer.js');
  assert.match(js, /\.\.\.lowOverheadUi\.initialTerminalOptions\(lowOverheadStore\.get\(\)\)/);
  assert.match(js, /onFocus: id => \{\s*ipcRenderer\.send\('focus-session', \{ sessionId: id \}\);\s*applyLowOverheadTerminals\(\);/);
  assert.match(js, /scheduleFitAndResizeTerminal\(activeSessionId, cached\);\s*applyLowOverheadTerminals\(\);/);
  assert.doesNotMatch(js, /cursorBlink: true,\s*scrollback: 10000,\s*allowProposedApi/);
});

// ---------- L6 ----------
test('L6：后台刷新正常不变、开启放慢 4 倍；state.json 节流按设定间隔切换（本条用 2↔5 秒验机制；默认值见 L6 控制器测试的 15↔30 秒），切回短间隔时已挂的保存提前（不推后）', async t => {
  assert.equal(policy.backgroundIntervalMs(5000, { on: false }), 5000);
  assert.equal(policy.backgroundIntervalMs(5000, { on: true }), 20000);
  let state = { on: false };
  const made = [];
  const tick = ui.createAdaptiveInterval(() => {}, 5000, () => state, {
    setIntervalFn: (fn, ms) => { const timer = { ms }; made.push(timer); return timer; }, clearIntervalFn: timer => { timer.cleared = true; } });
  assert.equal(tick.start(), 5000);
  assert.equal(tick.reset(), 5000);
  assert.equal(made.length, 1, '间隔没变不重排');
  state = { on: true };
  assert.equal(tick.reset(), 20000);
  // 真实 state-store 跑在隔离数据目录的子进程里（模块加载时就定好数据目录，不能碰本机 Hub）。
  const dir = tmpDir(t);
  const script = `
    const store = require(${JSON.stringify(path.join(ROOT, 'core', 'state-store.js'))});
    store.setSaveMinInterval(5000);
    store.save({ sessions: [] });                  // 第一次：500ms 后落盘，记下开始时间
    setTimeout(() => {
      store.save({ sessions: [] });                // 第二次：按 5 秒节流挂起
      const slow = store._pendingSaveDueAt() - Date.now();
      store.setSaveMinInterval(2000);              // 关掉低开销
      const fast = store._pendingSaveDueAt() - Date.now();
      store.setSaveMinInterval(5000);              // 再开：不推后
      const again = store._pendingSaveDueAt() - Date.now();
      process.stdout.write(JSON.stringify({ slow, fast, again }));
      process.exit(0);
    }, 800);`;
  const { execFileSync } = require('node:child_process');
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, CLAUDE_HUB_DATA_DIR: dir }, windowsHide: true, encoding: 'utf8', timeout: 20000 }));
  assert.ok(out.slow > 3500 && out.slow <= 5000, `5 秒节流 ${out.slow}`);
  assert.ok(out.fast > 0 && out.fast <= 2000 && out.fast < out.slow - 2500, `切回 2 秒后提前 ${out.fast}`);
  assert.ok(Math.abs(out.again - out.fast) < 100, '切到更长间隔不推后');
  const js = read('renderer/renderer.js');
  assert.match(js, /createAdaptiveInterval\(refreshSystemResourceUsage, 5000/);
  assert.match(js, /createAdaptiveInterval\(refreshHubProxyInfo, 15000/);
});

// ---------- 界面：徽章、内存面板、资源与后台 ----------
test('状态条「省」徽章：只在开启时出现；点击与回车/空格都打开内存面板（Gemini P2-3）', () => {
  assert.equal(ui.stripBadgeHtml({ on: false }), '');
  assert.equal(ui.stripBadgeHtml(null), '');
  const badge = ui.stripBadgeHtml({ on: true });
  assert.match(badge, /class="strip-low-overhead" role="button" tabindex="0"/);
  assert.match(badge, />省</);
  const js = read('renderer/session-list-renderer.js');
  assert.match(js, /metric\('内存', memoryPct\) \+ lowBadge \+ diskMetric/);
  assert.match(js, /if \(!!currentBadge !== !!lowBadge\)/);
  const panel = read('renderer/memory-release-panel.js');
  assert.match(panel, /strip\.addEventListener\('keydown', event => \{\s*if \(event\.key !== 'Enter' && event\.key !== ' '\) return;\s*if \(!event\.target\.closest\?\.\('\.strip-low-overhead'\)\) return;/);
});

test('内存面板顶部横条：开关 + ⓘ（后台可选功能 + 六项会话节能）；保活下拉只在开启时出现；不重复重画、失败按真值回滚', () => {
  const off = ui.panelRowHtml({ on: false, keepAlive: 2 });
  assert.match(off, /data-mr-lo-toggle="true">/);
  assert.doesNotMatch(off, /checked|data-mr-lo-keep/);
  const hint = policy.strategyHint();
  for (const word of ['后台可选功能全部关掉', '恢复老版本的行为', '自动休眠', '共用一个后台进程', '桌宠静默', '空闲 10 分钟退出', '3000 行', '放慢 4 倍', '老用户升级不改任何开关']) {
    assert.ok(hint.includes(word), word);
  }
  const on = ui.panelRowHtml({ on: true, keepAlive: 3 });
  assert.match(on, /checked/);
  assert.match(on, /<option value="3" selected>3 个<\/option>/);
  const panel = read('renderer/memory-release-panel.js');
  assert.match(panel, /void setLowOverhead\(\{ on: event\.target\.checked \}\)/);
  assert.match(panel, /if \(!result \|\| !result\.ok \|\| result\.partial\) repaintLowRow\(\);/, '成功时只由变化通知重画一次');
  assert.match(panel, /else if \(result\.partial\) onLowOverheadError/, 'partial 如实提示');
  assert.match(panel, /\.focus\?\.\(\)/, '重画后焦点回到原控件');
});

test('共享 store：set 只带 keepAlive 不切模式；partial 时状态不变；主进程推送双向同步', async () => {
  let server = { on: false, keepAlive: 2 };
  let partial = false;
  const pushes = [];
  const store = ui.createLowOverheadStore({
    invoke: async (channel, patch) => {
      if (channel === 'low-overhead:state') return { ok: true, ...server, enabled: server.on };
      if (patch.keepAlive != null) server = { ...server, keepAlive: policy.normalizeKeepAlive(patch.keepAlive) };
      if (typeof patch.on === 'boolean' && !partial) server = { ...server, on: patch.on };
      const lo = { ...server, enabled: server.on };
      return { ok: true, partial, message: partial ? '会议室没关上，低开销模式保持关' : '', ...lo, lowOverhead: lo };
    },
    subscribe: fn => pushes.push(fn),
  });
  const seen = [];
  store.onChange(s => seen.push(s));
  await store.refresh();
  await store.set({ keepAlive: 1 });
  assert.deepEqual(store.get(), { on: false, enabled: false, keepAlive: 1 }, '只改保活数');
  partial = true;
  const r = await store.set({ on: true });
  assert.equal(r.partial, true);
  assert.equal(store.isEnabled(), false, 'partial 时模式没切');
  partial = false;
  await store.set({ on: true });
  assert.equal(store.isEnabled(), true);
  pushes[0]({ on: false, enabled: false, keepAlive: 1 });          // 「资源与后台」那边关了
  assert.equal(store.isEnabled(), false);
  assert.equal(seen.length, 3, '每次真变化通知一次，不重复');
});

test('设置「资源与后台」顶行：开启时同行显示保活下拉（只改保活数）、ⓘ 合入六项会话节能；「常用」页一个控件都不加', () => {
  const bg = read('renderer/background-features.js');
  assert.match(bg, /\$\{mode\.on \? `<span class="bg-keep"[^`]*>保活会话数\$\{require\('\.\/low-overhead-ui'\)\.keepAliveSelectHtml\(mode, `data-bg="keep"/);
  assert.match(bg, /iconHintHtml\(lowOverheadPolicy\.strategyHint\(\)\)/);
  assert.match(bg, /ipcRenderer\.invoke\('low-overhead:set', \{ keepAlive: Number\(keep\.value\) \}\)/);
  assert.match(bg, /\.bg-head \.bg-keep \{[^}]*white-space: nowrap;/, '同行、不换行');
  const tabs = read('renderer/config-settings-tabs.js');
  assert.doesNotMatch(tabs, /cfg-low-overhead-field/);
  assert.doesNotMatch(read('renderer/renderer.js'), /attachSettingsField/);
  assert.doesNotMatch(read('renderer/low-overhead-ui.js'), /config-main-view|attachSettingsField/);
});
