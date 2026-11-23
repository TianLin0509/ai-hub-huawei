'use strict';
// r27f（2026-11-17）：待机更活、悬停快捷钮与单击只逗它、偶尔在任务栏上走动。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { allowedRange, flingPlan, flyAt, releasePlan, walkIntervals, walkPlan, FLING_SPEED } = require('../core/hub-pet/motion');
const { normalize, defaults, CLICK_MODES } = require('../core/hub-pet/settings');
const { createFullscreenWatch, buildScript } = require('../core/hub-pet/fullscreen-watch');
const M = require('../renderer/hub-pet/pet-motion');
const { NoticeBus } = require('../core/company-assistant/notice-bus');
const { createHubPetController, WIN_W, BODY, INSET } = require('../main/hub-pet-controller');

const NOON = new Date(2026, 10, 17, 12).getTime();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 与控制器一致的几何：窗口 280 宽、身体 150、底部留 6。
const SIZE = { width: WIN_W, height: 340 };
const geo = (area) => ({ area, size: SIZE, inset: INSET, body: BODY });
const floorY = area => allowedRange(area, SIZE, INSET).maxY;
const bodySpan = x => [x + INSET.left, x + SIZE.width - INSET.right];
const overlaps = ([a, b], fg) => a < fg.x + fg.width && b > fg.x;

// ---------- 甩出去 ----------
test('甩得够快才沿抛物线落到任务栏上；慢慢放下照旧原地停', () => {
  const area = { x: 0, y: 0, width: 1600, height: 1000 };
  const pos = { x: 600, y: 300 };
  const fast = [{ t: 0, x: 540, y: 330 }, { t: 60, x: 600, y: 300 }];   // ≈1118 DIP/s，斜向上
  const p = flingPlan({ samples: fast, position: pos, ...geo(area) });
  assert.ok(p && p.fling, '够快 → 甩');
  assert.equal(p.steps[0].kind, 'fly');
  assert.equal(p.final.y, floorY(area), '落在任务栏上沿');
  assert.ok(p.final.x > pos.x, '往甩的方向飞');
  // 飞行轨迹：先往上（vy<0）后落下，全程在屏幕内
  const s = p.steps[0];
  const ys = [0, 0.1, 0.2, 0.4, 0.7, 1].map(k => flyAt(s, s.durationMs * k).y);
  assert.ok(ys[1] < ys[0], '先往上');
  assert.equal(ys.at(-1), floorY(area), '最后到底');
  for (let k = 0; k <= 20; k++) { const q = flyAt(s, s.durationMs * k / 20); const r = s.range; assert.ok(q.x >= r.minX && q.x <= r.maxX && q.y >= r.minY && q.y <= r.maxY); }
  assert.ok(s.durationMs >= 160 && s.durationMs <= 1400);
  assert.ok(p.impact > 0.45 && p.impact <= 1);
  // 慢的
  const slow = [{ t: 0, x: 590, y: 300 }, { t: 100, x: 600, y: 300 }];
  assert.equal(flingPlan({ samples: slow, position: pos, ...geo(area) }), null);
  assert.ok(releasePlan({ samples: slow, position: pos, ...geo(area) }).final.y < floorY(area) - 100, '慢慢放下留在半空原处');
  // 甩向屏幕边：停在边上并贴边
  const side = [{ t: 0, x: 1100, y: 600 }, { t: 40, x: 1200, y: 600 }];
  const e = flingPlan({ samples: side, position: { x: 1200, y: 600 }, ...geo(area) });
  assert.equal(e.dock, 'right');
  assert.equal(e.final.x, allowedRange(area, SIZE, INSET).maxX);
  assert.ok(FLING_SPEED === 900);
});

// ---------- 走动 ----------
test('走动只沿任务栏上沿，身体不进前台窗口在底带上的横向范围；最大化不走；放在窗口前面的不挪', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const y = floorY(area) - 8;  // 默认位置比底边高 8
  const fg = { x: 700, y: 100, width: 700, height: 935 };   // 窗口底部压到底带
  for (let i = 0; i < 200; i++) {
    let seed = i * 9301 + 49297; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const x = i % 2 ? 200 : 1500;
    const { plan, reason } = walkPlan({ position: { x, y }, ...geo(area), foreground: fg, rnd });
    assert.ok(plan, `第 ${i} 次应能走（${reason}）`);
    assert.equal(plan.to.y, y, '只横着走');
    assert.ok(!overlaps(bodySpan(plan.to.x), fg), '目的地身体不压窗口');
    // 走的路上也不压（同一段空白里）
    for (let k = 0; k <= 10; k++) assert.ok(!overlaps(bodySpan(plan.from.x + (plan.to.x - plan.from.x) * k / 10), fg));
    const r = allowedRange(area, SIZE, INSET);
    assert.ok(plan.to.x >= r.minX && plan.to.x <= r.maxX, '不出工作区');
    if (plan.sit) assert.ok(Math.abs(bodySpan(plan.to.x)[1] - fg.x) <= 7 || Math.abs(bodySpan(plan.to.x)[0] - (fg.x + fg.width)) <= 7, '坐在窗口边上');
    assert.ok(plan.durationMs >= 900 && plan.durationMs <= 6000);
  }
  // 最大化：底带整条被占 → 不走
  const max = { x: -8, y: -8, width: 1936, height: 1056 };
  assert.equal(walkPlan({ position: { x: 1500, y }, ...geo(area), foreground: max }).plan, null);
  // 用户自己放在窗口前面：不挪
  assert.equal(walkPlan({ position: { x: 900, y }, ...geo(area), foreground: fg }).reason, 'covering-window');
  // 不在地上（挂在半空）：不走
  assert.equal(walkPlan({ position: { x: 200, y: 300 }, ...geo(area), foreground: null }).reason, 'not-on-floor');
  // 窗口只在屏幕上半部（不压底带）：底带全空
  const top = { x: 0, y: 0, width: 1920, height: 500 };
  assert.deepEqual(walkIntervals({ range: allowedRange(area, SIZE, INSET), size: SIZE, inset: INSET, band: { top: 880, bottom: 1034 }, foreground: top }), [[allowedRange(area, SIZE, INSET).minX, allowedRange(area, SIZE, INSET).maxX]]);
});

test('多屏与缩放 100%/150%/225%：每块屏按自己的工作区（DIP）走，不出屏、不压窗口', () => {
  // 物理 3840×2160 的屏在不同缩放下的 DIP 工作区；第二块屏在左边（负坐标）
  const screens = [
    { scale: 1, area: { x: 0, y: 0, width: 3840, height: 2112 } },
    { scale: 1.5, area: { x: 0, y: 0, width: 2560, height: 1400 } },
    { scale: 2.25, area: { x: 0, y: 0, width: 1707, height: 912 } },
    { scale: 1.25, area: { x: -1536, y: 0, width: 1536, height: 824 } },
  ];
  for (const { scale, area } of screens) {
    const y = floorY(area) - 8;
    const fgPhys = { x: 0.4, w: 0.3 };   // 窗口占屏幕横向 40%–70%，底部压到任务栏
    const fg = { x: Math.round(area.x + area.width * fgPhys.x), y: area.y + 50, width: Math.round(area.width * fgPhys.w), height: area.height - 40 };
    const r = allowedRange(area, SIZE, INSET);
    for (const x of [r.minX + 40, r.maxX - 40]) {
      let n = 0; const rnd = () => ((n = (n * 7 + 3) % 11) / 11);
      for (let i = 0; i < 30; i++) {
        const { plan } = walkPlan({ position: { x, y }, ...geo(area), foreground: fg, rnd });
        if (!plan) continue;
        assert.ok(plan.to.x >= r.minX && plan.to.x <= r.maxX, `缩放 ${scale} 不出屏`);
        assert.ok(!overlaps(bodySpan(plan.to.x), fg), `缩放 ${scale} 不压窗口`);
      }
    }
  }
});

// ---------- 设置 ----------
test('设置：默认单击只逗它、会走动；旧数据与非法值兜底', () => {
  const d = defaults();
  assert.equal(d.clickMode, 'play');
  assert.equal(d.walk, true);
  assert.equal(d.clickHinted, false);
  assert.deepEqual(CLICK_MODES, ['play', 'open']);
  assert.equal(normalize({ clickMode: 'open', walk: false, clickHinted: true }, d).clickMode, 'open');
  assert.equal(normalize({ clickMode: 'bogus', walk: 'yes' }, d).clickMode, 'play');
  assert.equal(normalize({ walk: 'yes' }, d).walk, true);
  assert.equal(normalize({}, d).clickHinted, false);
});

// ---------- 前台窗口读数 ----------
test('全屏检测进程顺带读前台窗口：W win / W desk 行解析，坏数据当不知道', () => {
  const w = createFullscreenWatch({ platform: 'linux', foreground: true });
  assert.equal(w.foreground(), null);
  w._handleLine('W win 100 50 900 700');
  assert.deepEqual(w.foreground().rect, { x: 100, y: 50, width: 800, height: 650 });
  w._handleLine('W desk');
  assert.equal(w.foreground().kind, 'desk');
  w._handleLine('W win 5 5 5 5');
  assert.equal(w.foreground().kind, 'unknown');
  w._handleLine('F win 0 0 1920 1080 0 0 1920 1080');
  assert.equal(w.isFullscreen(), true);
  assert.match(buildScript(1, 1, { foreground: true }), /GetForegroundWindow/);
  assert.match(buildScript(1, 1), /GetForegroundWindow/, '全屏始终核对前台窗口，foreground 只控制窗口避让读数');
});

// ---------- 渲染端动作 ----------
test('6 种新小动作两端都回到原样；起跳下蹲；钟摆被推起来后会停下', () => {
  assert.equal(M.IDLE_MOVES.length, 6);
  const id = { x: 0, y: 0, rot: 0, sx: 1, sy: 1 };
  for (const m of M.IDLE_MOVES) {
    for (const dir of [-1, 1]) for (const s of [0, 1]) {
      const v = m.fn(s, dir);
      for (const k of Object.keys(id)) assert.ok(Math.abs(v[k] - id[k]) < 1e-6, `${m.name} s=${s} ${k}`);
    }
    // 中间确实在动（hops 由跳跃列表演）
    if (m.name !== 'hops') { const mid = m.fn(0.3, 1); assert.ok(Object.keys(id).some(k => Math.abs(mid[k] - id[k]) > 1e-3), m.name); }
    else assert.equal(m.hops.length, 2);
  }
  assert.equal(M.crouchAt(0), 0);
  assert.ok(Math.abs(M.crouchAt(0.7) - 1) < 1e-9);
  assert.ok(Math.abs(M.crouchAt(1) - 0.35) < 1e-9);
  let p = { a: 0, w: 0 }, peak = 0;
  for (let i = 0; i < 15; i++) { p = M.pendulumStep(p, 10000, 1 / 60); peak = Math.max(peak, Math.abs(p.a)); }
  for (let i = 0; i < 60; i++) { p = M.pendulumStep(p, 0, 1 / 60); peak = Math.max(peak, Math.abs(p.a)); }
  assert.ok(peak > 5 && peak <= 25, `摆起来 ${peak.toFixed(1)}°`);
  for (let i = 0; i < 600; i++) p = M.pendulumStep(p, 0, 1 / 60);
  assert.ok(Math.abs(p.a) < 0.5, '10 秒后基本停下');
  // 低帧率（一帧 100ms）也稳
  let q = { a: 20, w: 0 };
  for (let i = 0; i < 100; i++) q = M.pendulumStep(q, 0, 0.1);
  assert.ok(Math.abs(q.a) < 0.5);
  const o = M.pivotOffset(0, 100); assert.ok(Math.abs(o.x) < 1e-9 && Math.abs(o.y) < 1e-9);
});

// ---------- 控制器：单击、双击、抱抱、提示、快捷钮、走动 ----------
function rig(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-lively-'));
  const sent = [], toHub = [];
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
  const display = { workArea: { x: 0, y: 0, width: 1600, height: 1000 }, scaleFactor: 1 };
  const bus = new NoticeBus({ now: () => NOON });
  const main = { webContents: {}, isDestroyed: () => false };
  const c = createHubPetController({ BrowserWindow: FakeWindow, ipcMain, noticeBus: bus, dataDir: root,
    assetsDir: path.join(__dirname, '../renderer/assets/hub-pet'), htmlPath: 'fixture.html', preloadPath: 'fixture-preload.js',
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getDisplayMatching: () => display, getAllDisplays: () => [display], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    powerMonitor: { getSystemIdleTime: () => 0 }, now: () => NOON, watchFullscreen: false, logger: { warn() {}, info() {} },
    sendToRenderer: (channel, payload) => toHub.push({ channel, payload }), focusPrimaryWindow: () => {},
    getSessionActivity: () => ({ running: 0 }), debug: true, getMainWindow: () => main, ...opts });
  t.after(() => { c.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const pet = () => ({ sender: c.getWindow().webContents });
  const press = target => ipcMain.emit('hub-pet:press', pet(), { target });
  const release = () => ipcMain.emit('hub-pet:release', pet());
  const click = target => { press(target); release(); };
  const dbg = req => handles['hub-pet:debug']({ sender: main.webContents }, req);
  const motions = phase => sent.filter(x => x.channel === 'hub-pet:motion' && x.payload.phase === phase).map(x => x.payload);
  const state = () => sent.filter(x => x.channel === 'hub-pet:state').map(x => x.payload).pop();
  return { c, sent, toHub, ipcMain, pet, press, release, click, dbg, motions, state };
}

test('单击只逗它（第一次说一句新玩法）、400ms 内连点两下打开助理；设置可改回单击打开', async t => {
  const r = rig(t);
  r.c.setSettings({ enabled: true });
  r.click('pet');
  assert.equal(r.toHub.filter(x => x.channel === 'hub-pet:open-assistant').length, 0, '单击不打开');
  assert.equal(r.motions('poke').at(-1).play, true, '逗一下');
  assert.equal(r.state().bubble && r.state().bubble.id, 'click-hint', '第一次单击说新玩法');
  assert.equal(r.c.getSettings().clickHinted, true);
  await sleep(450);
  r.click('pet');                     // 隔了 >400ms：还是单击
  assert.equal(r.toHub.filter(x => x.channel === 'hub-pet:open-assistant').length, 0);
  r.click('pet');                     // 紧接着第二下：双击
  assert.equal(r.toHub.filter(x => x.channel === 'hub-pet:open-assistant').length, 1, '双击打开助理');
  // 提示只说一次
  const hints = () => r.sent.filter(x => x.channel === 'hub-pet:state' && x.payload.bubble && x.payload.bubble.id === 'click-hint').length;
  const before = hints();
  await sleep(450);
  r.c._speech.takeCurrent(); r.c._evaluate();
  r.click('pet');
  assert.equal(!!(r.state().bubble && r.state().bubble.id === 'click-hint'), false, '第二次单击不再提示');
  assert.ok(hints() >= before);
  // 改回旧习惯
  r.c.setSettings({ clickPlay: false });
  assert.equal(r.c.getSettings().clickMode, 'open');
  await sleep(450);
  r.click('pet');
  assert.equal(r.toHub.filter(x => x.channel === 'hub-pet:open-assistant').length, 2, '旧习惯单击就打开');
});

test('按住 0.6 秒是抱抱：冒爱心、记一次亲密度，松手不算单击；旧习惯下按住不抱', async t => {
  const r = rig(t);
  r.c.setSettings({ enabled: true });
  r.press('pet');
  await sleep(750);
  assert.equal(r.motions('hug').at(-1)?.on, true, '按住变抱抱');
  r.release();
  assert.equal(r.motions('hug').at(-1).on, false);
  assert.equal(r.motions('poke').length, 0, '抱完松手不算单击');
  assert.equal(r.toHub.filter(x => x.channel === 'hub-pet:open-assistant').length, 0);
  r.c.setSettings({ clickPlay: false });
  const hugs = r.motions('hug').length;
  r.press('pet');
  await sleep(750);
  r.release();
  assert.equal(r.motions('hug').length, hugs, '旧习惯下按住还是单击');
  assert.equal(r.toHub.filter(x => x.channel === 'hub-pet:open-assistant').length, 1);
});

test('快捷钮：问＝问助理（没接助理时打开助理页）、信＝翻没看的消息、摸＝摸摸它', t => {
  const r = rig(t);
  r.c.setSettings({ enabled: true });
  assert.equal(r.dbg({ op: 'quick', type: 'ask' }), true);
  assert.equal(r.toHub.at(-1).channel, 'hub-pet:open-assistant', '没接助理 → 打开助理页');
  r.c.notify({ sessionId: 'a', title: '会话 A', completedAt: 1 });
  r.ipcMain.emit('hub-pet:dismiss', r.pet());
  assert.equal(r.state().dots, 1);
  r.dbg({ op: 'quick', type: 'inbox' });
  assert.ok(r.sent.some(x => x.channel === 'hub-pet:panel'), '翻出消息');
  const before = r.sent.length;
  assert.equal(r.dbg({ op: 'quick', type: 'pet' }), true);
  assert.ok(r.sent.length > before);
  assert.equal(r.dbg({ op: 'quick', type: 'nope' }), false);
});

test('走动：安静、开会、全屏、关掉、减少动态效果时不走；拿不到前台窗口不走；能走时走完回原处、不改存的位置', async t => {
  const r = rig(t);
  r.c.setSettings({ enabled: true });
  const home = { ...r.c.getWindow().getBounds() };
  const area = { x: 0, y: 0, width: 1600, height: 1000 };
  assert.ok(Math.abs(home.y - floorY(area)) <= 12, `默认站在任务栏上（${home.y} vs ${floorY(area)}）`);
  const fg = { kind: 'win', rect: { x: 300, y: 80, width: 700, height: 900 } };   // 默认位置在右下角，窗口在它左边
  r.dbg({ op: 'override', foreground: null });
  assert.equal(r.dbg({ op: 'walk' }).skipped, 'no-foreground');
  r.dbg({ op: 'override', foreground: fg });
  for (const [set, unset, why] of [
    [() => r.c.setSettings({ mode: 'quiet' }), () => r.c.setSettings({ mode: 'gentle' }), 'quiet'],
    [() => r.dbg({ op: 'override', meeting: true }), () => r.dbg({ op: 'override', meeting: null }), 'meeting'],
    [() => r.dbg({ op: 'override', fullscreen: true }), () => r.dbg({ op: 'override', fullscreen: null }), 'fullscreen'],
    [() => r.c.setSettings({ walk: false }), () => r.c.setSettings({ walk: true }), 'off'],
    [() => r.ipcMain.emit('hub-pet:prefs', r.pet(), { reducedMotion: true }), () => r.ipcMain.emit('hub-pet:prefs', r.pet(), { reducedMotion: false }), 'reduced-motion'],
  ]) {
    set();
    const res = r.dbg({ op: 'walk' });
    assert.equal(res.skipped, why, why);
    unset();
  }
  await sleep(600);   // 全屏躲边回来的 420ms 动画走完
  const saved = r.c.getSettings().position;
  const res = r.dbg({ op: 'walk' });
  assert.ok(res.plan, '能走：' + JSON.stringify(res));
  const st = r.dbg({ op: 'state' });
  assert.ok(st.excursion, '在外面');
  assert.ok(r.motions('walk').some(m => m.on), '告诉渲染端在走');
  await sleep(res.plan.durationMs + 300);
  const out = r.c.getWindow().getBounds();
  assert.equal(out.x, res.plan.to.x, '走到目的地');
  assert.ok(!overlaps(bodySpan(out.x), fg.rect), '不压前台窗口');
  r.dbg({ op: 'walk-home' });
  await sleep(6300);
  assert.equal(r.c.getWindow().getBounds().x, home.x, '走回原处');
  assert.deepEqual(r.c.getSettings().position, saved, '不改存的位置');
  assert.equal(r.dbg({ op: 'state' }).excursion, null);
});
