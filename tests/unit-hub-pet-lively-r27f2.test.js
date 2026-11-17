'use strict';
// r27f2（2026-11-17）：r27f 审查返工的回归。
// 1. 走动途中前台窗口变了（最大化、挪到底带上）、工作区变了：当场停下回原处；
// 2. 途中切安静档 / 临时安静 / 开会 / 减少动态效果 / 关掉走动 / 全屏 / 锁屏 / 睡眠：当场停下回原处；锁屏期间不排下一次，解锁后再排；
// 3. 往上甩、高屏（4K）：最后一帧就落在任务栏上沿，和保存的位置一致；
// 4. 快捷钮不压状态灯（大小 0.6–1.6、贴边、灯 1–12 盏、小圆点和头饰的组合）；
// 5. 安静档、开会时悬停不冒快捷钮。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { allowedRange, flingPlan, flyAt } = require('../core/hub-pet/motion');
const { NoticeBus } = require('../core/company-assistant/notice-bus');
const { createHubPetController, WIN_W, WIN_H, BODY, INSET } = require('../main/hub-pet-controller');

const NOON = new Date(2026, 10, 17, 12).getTime();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function rig(t, { area = { x: 0, y: 0, width: 1600, height: 1000 } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-r27f2-'));
  const sent = [];
  class FakeWindow extends EventEmitter {
    constructor(o) { super(); this.bounds = { x: 0, y: 0, width: o.width, height: o.height }; this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.send = (channel, payload) => sent.push({ channel, payload }); this.webContents.getOSProcessId = () => 0; }
    isDestroyed() { return this.destroyed; }
    getBounds() { return this.bounds; }
    setBounds(b) { this.bounds = { ...b }; }
    setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    loadFile() { return Promise.resolve(); }
    showInactive() {}
    focus() {}
    hide() {}
    show() {}
    isVisible() { return true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const handles = {};
  const ipcMain = new EventEmitter(); ipcMain.handle = (ch, fn) => { handles[ch] = fn; }; ipcMain.removeHandler = () => {};
  const display = { workArea: { ...area }, scaleFactor: 1 };
  const power = new EventEmitter(); power.getSystemIdleTime = () => 0;
  const main = { webContents: {}, isDestroyed: () => false };
  const c = createHubPetController({ BrowserWindow: FakeWindow, ipcMain, noticeBus: new NoticeBus({ now: () => NOON }), dataDir: root,
    assetsDir: path.join(__dirname, '../renderer/assets/hub-pet'), htmlPath: 'fixture.html', preloadPath: 'fixture-preload.js',
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getDisplayMatching: () => display, getAllDisplays: () => [display], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    powerMonitor: power, now: () => NOON, watchFullscreen: false, logger: { warn() {}, info() {} },
    sendToRenderer: () => {}, focusPrimaryWindow: () => {}, getSessionActivity: () => ({ running: 0 }), debug: true, getMainWindow: () => main });
  t.after(() => { c.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const pet = () => ({ sender: c.getWindow().webContents });
  const dbg = req => handles['hub-pet:debug']({ sender: main.webContents }, req);
  const state = () => sent.filter(x => x.channel === 'hub-pet:state').map(x => x.payload).pop();
  const motions = phase => sent.filter(x => x.channel === 'hub-pet:motion' && x.payload.phase === phase).map(x => x.payload);
  c.setSettings({ enabled: true, introduced: true });
  return { c, ipcMain, pet, dbg, state, motions, power, display };
}
const bx = r => r.c.getWindow().getBounds().x;
// 从桌面空白处出发（前台是桌面），rnd 0.9 → 随便踱几步（默认位置在右下角，往左走）。
function startWalk(r) {
  r.dbg({ op: 'override', foreground: { kind: 'desk' } });
  const res = r.dbg({ op: 'walk', rnd: 0.9 });
  assert.ok(res.plan, '能出发：' + JSON.stringify(res));
  return res.plan;
}
// 停下的判定：50ms 内回到原处、不在外面、没有在挪；再等 150ms 位置不变。
async function assertStoppedHome(r, home, label) {
  await sleep(50);
  const s1 = r.dbg({ op: 'state' });
  assert.equal(bx(r), home.x, label + '：回到原处');
  assert.equal(r.c.getWindow().getBounds().y, home.y, label + '：原来的高度');
  assert.equal(s1.excursion, null, label + '：不在外面');
  assert.equal(s1.moving, false, label + '：没有在挪');
  await sleep(150);
  assert.equal(bx(r), home.x, label + '：之后也不再挪');
  assert.equal(r.motions('walk').at(-1).on, false, label + '：告诉渲染端停下');
}

test('审查第 1 项：走出去、坐着、往回走时前台窗口最大化或挪到底带上，当场停下放回原处', async t => {
  for (const phase of ['out', 'dwell', 'back']) {
    const r = rig(t);
    const plan = startWalk(r);
    const home = plan.from;
    if (phase !== 'out') { await sleep(plan.durationMs + 120); assert.equal(r.dbg({ op: 'state' }).excursion.phase, 'dwell'); }
    if (phase === 'back') { r.dbg({ op: 'walk-home' }); await sleep(150); assert.equal(r.dbg({ op: 'state' }).excursion.phase, 'back'); }
    else await sleep(150);
    assert.notEqual(bx(r), home.x, phase + '：已经离开原处');
    // 最大化（不进全屏）：前台窗口铺满工作区
    r.dbg({ op: 'override', foreground: { kind: 'win', rect: { x: -8, y: -8, width: 1616, height: 1016 } } });
    await assertStoppedHome(r, home, phase + ' 最大化');
    assert.equal(r.dbg({ op: 'state' }).lastWalk.aborted, 'foreground');
    assert.equal(r.dbg({ op: 'state' }).walkScheduled, true, phase + '：过一会儿再试');
  }
  // 前台窗口挪到要走的那段路上（没最大化）：也停
  const r = rig(t);
  const plan = startWalk(r);
  await sleep(150);
  const mid = Math.round((plan.from.x + plan.to.x) / 2) + INSET.left;
  r.dbg({ op: 'override', foreground: { kind: 'win', rect: { x: mid, y: 600, width: 40, height: 400 } } });
  await assertStoppedHome(r, plan.from, '窗口挪到路上');
});

test('审查第 1 项：前台窗口变了但不碍事（在屏幕上半截、在另一侧）照常走完；拿不到前台窗口时沿用之前的判断', async t => {
  const r = rig(t);
  const plan = startWalk(r);
  await sleep(120);
  r.dbg({ op: 'override', foreground: { kind: 'win', rect: { x: 100, y: 50, width: 900, height: 400 } } });   // 底带上没东西
  await sleep(150);
  r.dbg({ op: 'override', foreground: null });
  await sleep(150);
  const st = r.dbg({ op: 'state' });
  assert.ok(st.excursion, '还在走');
  assert.ok(Math.abs(bx(r) - plan.from.x) > 10, '确实在挪');
});

test('审查第 1 项：走动途中屏幕工作区变了（任务栏挪位、分辨率改了）当场停下', async t => {
  const r = rig(t);
  const plan = startWalk(r);
  await sleep(150);
  r.display.workArea = { x: 0, y: 0, width: 1600, height: 960 };
  await sleep(60);
  const st = r.dbg({ op: 'state' });
  assert.equal(st.excursion, null);
  assert.equal(st.lastWalk.aborted, 'work-area');
  assert.equal(st.moving, false);
  assert.ok(plan);
});

test('审查第 2 项：途中切安静档、临时安静、开会、减少动态效果、关掉走动、全屏、锁屏、睡眠，当场停下放回原处', async t => {
  const cases = [
    ['quiet', r => r.c.setSettings({ mode: 'quiet' })],
    ['quiet', r => r.c.setSettings({ quietHour: true })],
    ['quiet', r => r.c.setSettings({ silentToday: true })],
    ['meeting', r => { r.dbg({ op: 'override', meeting: true }); r.c._evaluate(); }],
    ['reduced-motion', r => r.ipcMain.emit('hub-pet:prefs', r.pet(), { reducedMotion: true })],
    ['off', r => r.c.setSettings({ walk: false })],
    ['fullscreen', r => { r.c.setSettings({ peekOnFullscreen: false }); r.dbg({ op: 'override', fullscreen: true }); }],
    ['locked', r => r.power.emit('lock-screen')],
    ['locked', r => r.power.emit('suspend')],
  ];
  for (const [why, fire] of cases) {
    for (const phase of ['out', 'dwell']) {
      const r = rig(t);
      const plan = startWalk(r);
      if (phase === 'dwell') await sleep(plan.durationMs + 120); else await sleep(120);
      fire(r);
      await assertStoppedHome(r, plan.from, `${why}/${phase}`);
      assert.equal(r.dbg({ op: 'state' }).lastWalk.aborted, why, `${why}/${phase} 的原因`);
    }
  }
});

test('审查第 2 项：锁屏、睡眠期间不排下一次、也不能强行走；解锁、醒来后重新排期', t => {
  for (const [lock, unlock] of [['lock-screen', 'unlock-screen'], ['suspend', 'resume']]) {
    const r = rig(t);
    assert.equal(r.dbg({ op: 'state' }).walkScheduled, true);
    r.power.emit(lock);
    assert.equal(r.dbg({ op: 'state' }).walkScheduled, false, lock + ' 后不排');
    r.dbg({ op: 'override', foreground: { kind: 'desk' } });
    assert.equal(r.dbg({ op: 'walk', rnd: 0.9 }).skipped, 'locked', lock + ' 期间强行走也不走');
    assert.equal(r.dbg({ op: 'state' }).excursion, null);
    r.power.emit(unlock);
    assert.equal(r.dbg({ op: 'state' }).walkScheduled, true, unlock + ' 后重新排');
    assert.ok(r.dbg({ op: 'walk', rnd: 0.9 }).plan, unlock + ' 后能走');
  }
  // 关掉桌宠后不再收锁屏事件
  const r = rig(t);
  r.c.setSettings({ enabled: false });
  assert.equal(r.power.listenerCount('lock-screen'), 0);
  assert.equal(r.power.listenerCount('resume'), 0);
});

test('审查第 3 项：往上甩、高屏（4K 150%/200%、竖屏）最后一帧就在任务栏上沿，和保存的位置一致', () => {
  const size = h => ({ width: WIN_W, height: h });
  for (const height of [700, 1000, 1040, 1392, 2112, 2560, 3792]) {
    for (const vy of [-1500, -900, 0, 1200]) {
      for (const vx of [0, 600, -1400]) {
        const area = { x: 0, y: 0, width: 3840, height };
        const sz = size(WIN_H);
        const range = allowedRange(area, sz, INSET);
        const y0 = Math.min(range.maxY - 50, 200);
        const pos = { x: 1500, y: y0 };
        const samples = [{ t: 0, x: pos.x - vx * 0.1, y: pos.y - vy * 0.1 }, { t: 100, x: pos.x, y: pos.y }];
        const p = flingPlan({ samples, position: pos, area, size: sz, inset: INSET });
        if (!p) continue;   // 不够快：交给慢放
        const st = p.steps[0];
        assert.ok(st.durationMs <= 1400, '飞行时间封顶');
        const last = flyAt(st, st.durationMs);
        const landed = p.steps.length > 1 ? p.steps.at(-1).to : last;
        assert.equal(last.y, range.maxY, `高 ${height} vy ${vy}：最后一帧落在底边（差 ${range.maxY - last.y}）`);
        assert.deepEqual(landed, p.final, '最后一帧（含贴边）＝保存的位置');
        for (let k = 0; k <= 40; k++) { const q = flyAt(st, st.durationMs * k / 40); assert.ok(q.y >= range.minY && q.y <= range.maxY && q.x >= range.minX && q.x <= range.maxX, '全程在屏内'); }
        // 越往后越低（过了最高点后单调落下）
        const ys = Array.from({ length: 21 }, (_, k) => flyAt(st, st.durationMs * k / 20).y);
        const top = ys.indexOf(Math.min(...ys));
        for (let k = top + 1; k < ys.length; k++) assert.ok(ys[k] >= ys[k - 1]);
      }
    }
  }
  // 审查原例：y=200、向上 1500 DIP/s、工作区高 2112、窗口高 340 → 以前停在 648、保存 1778
  const area = { x: 0, y: 0, width: 3840, height: 2112 };
  const p = flingPlan({ area, size: size(340), inset: INSET, position: { x: 600, y: 200 }, samples: [{ t: 0, x: 600, y: 350 }, { t: 100, x: 600, y: 200 }] });
  assert.equal(flyAt(p.steps[0], p.steps[0].durationMs).y, p.final.y);
});

test('审查第 3 项：真实控制器向上甩到高屏，窗口最后停的位置＝存下的位置', t => {
  // r40：拖动采样和落地动画都按 Date.now() 计时、由 setInterval 驱动。以前用真实 sleep 推光标，
  // Windows 计时器 15.6ms 一格、负载一高 sleep(20) 就被拉长，光标实际变慢（实测 882 < 900 DIP/s），单跑 3 次挂 2 次。
  // 改成模拟时钟：时间只按这里写的毫秒数走，每 1ms 推一步，计时器按各自到点的时刻触发，结果和机器快慢无关。
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: NOON });
  const advance = ms => { for (let i = 0; i < ms; i++) t.mock.timers.tick(1); };
  const r = rig(t, { area: { x: 0, y: 0, width: 2560, height: 2112 } });
  const home = r.c.getWindow().getBounds();
  r.dbg({ op: 'cursor', pos: { x: home.x + 140, y: 900 } });
  r.ipcMain.emit('hub-pet:press', r.pet(), { target: 'pet' });
  // 慢慢拖到 y≈760（窗口，500 DIP/s），再快速往上一甩（1500 DIP/s）
  for (let y = 900; y >= 760; y -= 20) { r.dbg({ op: 'cursor', pos: { x: home.x + 140, y } }); advance(40); }
  for (let y = 740; y >= 560; y -= 30) { r.dbg({ op: 'cursor', pos: { x: home.x + 140, y } }); advance(20); }
  r.ipcMain.emit('hub-pet:release', r.pet());
  const rel = r.dbg({ op: 'state' }).lastRelease;
  assert.equal(rel && rel.fling, true, '算甩：' + JSON.stringify(rel));
  advance(1700);
  const b = r.c.getWindow().getBounds();
  assert.deepEqual({ x: b.x, y: b.y }, r.c.getSettings().position, '窗口停的位置就是存的位置');
});

// ---------- 渲染端：快捷钮与状态灯 ----------
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/hub-pet/pet.js'), 'utf8');
function layoutWith({ scale, edge = {}, lamps, dot = false, head = null, box }) {
  const styleOf = () => { const st = {}; st.setProperty = () => {}; return st; };
  const hidden = () => ({ hidden: true, style: styleOf(), offsetWidth: 0, offsetHeight: 0, getBoundingClientRect: () => ({ top: 0, height: 0 }) });
  const cls = new Set();
  const lampsEl = { hidden: !lamps, childElementCount: lamps || 0, style: styleOf(),
    classList: { contains: k => cls.has(k), add: k => cls.add(k), remove: k => cls.delete(k) },
    // 和 pet.css 一致：12px 灯、5px 间距、四周 5px 内边距
    get offsetWidth() { const n = this.childElementCount; const cols = cls.has('row') ? +(/repeat\((\d+)/.exec(this.style.gridTemplateColumns || '') || [0, n])[1] : Math.ceil(n / +(/repeat\((\d+)/.exec(this.style.gridTemplateRows || '') || [0, n])[1]); return cols * 17 + 5; },
    get offsetHeight() { const n = this.childElementCount; const rows = cls.has('row') ? Math.ceil(n / +(/repeat\((\d+)/.exec(this.style.gridTemplateColumns || '') || [0, n])[1]) : +(/repeat\((\d+)/.exec(this.style.gridTemplateRows || '') || [0, n])[1]; return rows * 17 + 5; } };
  const qcls = new Set();
  const quickEl = { hidden: false, offsetWidth: 106, offsetHeight: 30, style: styleOf(), classList: { contains: k => qcls.has(k), remove: k => qcls.delete(k), toggle: (k, on) => { if (on) qcls.add(k); else qcls.delete(k); } } };
  const headEl = head ? { hidden: false, getBoundingClientRect: () => head } : hidden();
  const dotEl = dot ? { hidden: false, offsetWidth: 24, offsetHeight: 20, style: styleOf() } : hidden();
  const body = Math.round(BODY * scale);
  const H = Math.max(WIN_H, WIN_H - BODY + body);
  const ctx = { state: { scale, edge }, WIN_W: 280, EDGE_PAD: 6, BUBBLE_MAX: 236, box, clampNum: (v, lo, hi) => Math.max(lo, Math.min(hi, v)), window: { innerHeight: H },
    getComputedStyle: () => ({ bottom: '0' }), dotEl, bubbleEl: hidden(), card: { el: hidden() }, busyEl: hidden(), lampsEl, quickEl, headEl, panelEl: hidden(), askEl: hidden() };
  const begin = renderer.indexOf('  function placeQuick(');   // r27f3：快捷钮落位拆成独立函数，紧挨在 layoutOverlays 前面
  const end = renderer.indexOf('\n  function ', renderer.indexOf('  function layoutOverlays()') + 10);
  vm.runInNewContext(renderer.slice(begin, end) + '\nlayoutOverlays();', ctx);
  const rect = (el, w, h) => { const b = parseFloat(el.style.bottom); const l = parseFloat(el.style.left); return { left: l, right: l + w, top: H - b - h, bottom: H - b }; };
  return { H, lamps: lamps ? rect(lampsEl, lampsEl.offsetWidth, lampsEl.offsetHeight) : null, quick: quickEl.style.visibility === 'hidden' ? null : qcls.has('col') ? rect(quickEl, 30, 106) : rect(quickEl, 106, 30), col: qcls.has('col'), row: cls.has('row') };
}
const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

test('审查第 4 项：快捷钮不压状态灯——审查原例（企鹅 1.6 倍、6 盏灯横排）', () => {
  const penguin = { left: 0.23125, right: 0.165625, top: 0.059375, bottom: 0.096875 };   // 企鹅 idle.webp 的透明边（alpha>24）
  const o = layoutWith({ scale: 1.6, lamps: 6, box: penguin });
  assert.equal(o.row, true, '大企鹅时灯横到身体上方');
  assert.equal(overlapArea(o.lamps, o.quick), 0, JSON.stringify(o));
  assert.ok(o.quick.bottom <= o.lamps.top - 3.9, '快捷钮在灯条上方');
});

test('审查第 4 项：大小 0.6–1.6 × 贴左/贴右/不贴 × 灯 1–12 盏 × 小圆点/头饰，快捷钮都不压灯、不出窗口', () => {
  const boxes = [{ left: 0, right: 0, top: 0, bottom: 0 }, { left: 0.23125, right: 0.165625, top: 0.059375, bottom: 0.096875 }, { left: 0.1, right: 0.3, top: 0.2, bottom: 0.05 }];
  let n = 0;
  for (const scale of [0.6, 1, 1.3, 1.6]) for (const edge of [{}, { left: 60 }, { right: 60 }, { left: 120 }]) for (const lamps of [1, 3, 6, 12]) for (const dot of [false, true]) for (const withHead of [false, true]) for (const box of boxes) {
    const body = Math.round(BODY * scale);
    const H = Math.max(WIN_H, WIN_H - BODY + body);
    const head = withHead ? { top: H - 6 - body - 18, height: 30 } : null;
    const o = layoutWith({ scale, edge, lamps, dot, head, box });
    const label = JSON.stringify({ scale, edge, lamps, dot, withHead, box });
    assert.equal(overlapArea(o.lamps, o.quick), 0, '不压灯 ' + label + ' ' + JSON.stringify(o));
    assert.ok(o.quick.top >= 0 && o.quick.bottom <= o.H, '不出窗口 ' + label);
    n++;
  }
  assert.ok(n >= 700);
});

test('审查第 5 项：安静档（含临时安静、今天静音）、开会时悬停不冒快捷钮；平常照冒', async t => {
  const allowedCode = renderer.match(/const quickAllowed = \(\) => ([^;]+);/)[1];
  const allowed = st => vm.runInNewContext(allowedCode, { pressing: false, lifted: false, state: { peeking: false, ...st }, pose: 'idle',
    bubbleEl: { hidden: true }, card: { el: { hidden: true } }, panelEl: { hidden: true }, askEl: { hidden: true } });
  assert.equal(allowed({ mode: 'gentle', meeting: false, hush: false }), true, '平常冒');
  assert.equal(allowed({ mode: 'quiet', meeting: false, hush: true }), false, '安静档不冒');
  assert.equal(allowed({ mode: 'gentle', meeting: false, hush: true }), false, '临时安静/今天静音不冒');
  assert.equal(allowed({ mode: 'gentle', meeting: true, hush: false }), false, '开会不冒');
  // 主进程把这三种安静都告诉渲染端
  const r = rig(t);
  assert.equal(r.state().hush, false);
  r.c.setSettings({ quietHour: true }); assert.equal(r.state().hush, true, '临时安静一小时');
  r.c.setSettings({ quietHour: false, silentToday: true }); assert.equal(r.state().hush, true, '今天静音');
  r.c.setSettings({ silentToday: false, mode: 'quiet' }); assert.equal(r.state().hush, true, '安静档');
  r.c.setSettings({ mode: 'gentle' }); assert.equal(r.state().hush, false);
  // 切安静档、开会时已冒出的快捷钮收起（onState 里按 quickAllowed 收）
  assert.match(renderer, /if \(!quickEl\.hidden && !quickAllowed\(\)\) hideQuick\(\);/);
});

// r27f3 返工：m96 复审反例（企鹅 0.6 倍、贴左、展开 20 盏）——以前头顶被钳回窗口顶边、左右也放不下，仍压住第 1、19 盏灯中心。
test('审查第 4 项返工：展开 20/30 盏、贴左贴右任意贴边深度、0.6–1.6 倍，快捷钮都不压灯条；放得下的都露面', t => {
  const boxes = [{ left: 0, right: 0, top: 0, bottom: 0 }, { left: 0.23125, right: 0.165625, top: 0.059375, bottom: 0.096875 }, { left: 0.1, right: 0.3, top: 0.2, bottom: 0.05 }];
  let n = 0, shown = 0, col = 0;
  for (const scale of [0.6, 0.8, 1, 1.3, 1.6]) {
    const body = Math.round(BODY * scale);
    const side = (280 - body) / 2;
    for (let depth = 0; depth <= side + body * 0.6; depth += 8) for (const which of ['left', 'right']) for (const lamps of [1, 7, 12, 20, 30]) for (const dot of [false, true]) for (const box of boxes) {
      const o = layoutWith({ scale, edge: { [which]: depth }, lamps, dot, box });
      const label = JSON.stringify({ scale, which, depth, lamps, dot, box });
      n++;
      if (!o.quick) continue;
      shown++; if (o.col) col++;
      assert.equal(overlapArea(o.lamps, o.quick), 0, '不压灯 ' + label + ' ' + JSON.stringify(o));
      assert.ok(o.quick.top >= 0 && o.quick.bottom <= o.H && o.quick.left >= 0 && o.quick.right <= 280, '不出窗口 ' + label);
    }
  }
  // 原反例必须露面且不压灯
  const penguin = { left: 0.23125, right: 0.165625, top: 0.059375, bottom: 0.096875 };
  const m96 = layoutWith({ scale: 0.6, edge: { left: 116 }, lamps: 20, box: penguin });
  assert.ok(m96.quick, '原反例快捷钮仍露面');
  assert.equal(overlapArea(m96.lamps, m96.quick), 0, JSON.stringify(m96));
  t.diagnostic('组合 ' + n + '，露面 ' + shown + '，其中竖排 ' + col);
  assert.ok(n > 2000 && shown / n > 0.97, '绝大多数组合快捷钮照常露面：' + shown + '/' + n + '，竖排 ' + col);
});
