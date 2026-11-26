'use strict';
// 多屏吸边（2026-11-26）：两屏交界线不算边缘，只吸真正的屏幕外侧边；不等高、不对齐时只有没被隔壁盖住的那段算边缘。
const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedRange, dockOf, edgeInfo, flingPlan, flyAt, releasePlan } = require('../core/hub-pet/motion');

// 窗口 240×260，身体宽 120（左右各 60 透明边），脚下 10。身体中心 y = 窗口 y + 190。
const size = { width: 240, height: 260 };
const inset = { left: 60, right: 60, top: 0, bottom: 10 };
const D = (x, y, w, h, wa) => ({ bounds: { x, y, width: w, height: h }, workArea: wa ? { x: wa[0], y: wa[1], width: wa[2], height: wa[3] } : { x, y, width: w, height: h } });
const still = (x, y) => [{ t: 0, x, y }, { t: 200, x, y }];
const rel = (area, x, y, displays) => releasePlan({ samples: still(x, y), position: { x, y }, area, size, inset, displays });

// 左右并排、等高：主屏 1920×1080（任务栏在底），副屏在右。
const A1 = D(0, 0, 1920, 1080, [0, 0, 1920, 1040]);
const A2 = D(1920, 0, 1920, 1080, [1920, 0, 1920, 1040]);
const sideBySide = [A1, A2];

test('左右并排：靠近交界线松手不吸附，也不记作贴边', () => {
  const maxX = allowedRange(A1.workArea, size, inset).maxX; // 1740
  const old = rel(A1.workArea, maxX - 10, 400);
  assert.equal(old.dock, 'right', '单屏（旧行为）应吸右边');
  const p = rel(A1.workArea, maxX - 10, 400, sideBySide);
  assert.equal(p.dock, null);
  assert.equal(p.final.x, maxX - 10, '原地停住');
  assert.equal(p.steps.filter(s => s.kind === 'snap').length, 0);
});

test('左右并排：身体半跨交界线时不被弹回交界线', () => {
  const maxX = allowedRange(A1.workArea, size, inset).maxX;
  const old = rel(A1.workArea, maxX + 40, 400);
  assert.equal(old.final.x, maxX, '旧行为：拉回本屏并贴在交界线上');
  const p = rel(A1.workArea, maxX + 40, 400, sideBySide);
  assert.equal(p.final.x, maxX + 40);
  assert.equal(p.dock, null);
});

test('左右并排：两端真正的外侧边照常吸附；底边任务栏照常落脚', () => {
  assert.equal(rel(A1.workArea, -50, 400, sideBySide).dock, 'left');
  const maxX2 = allowedRange(A2.workArea, size, inset).maxX;
  assert.equal(rel(A2.workArea, maxX2 - 15, 400, sideBySide).dock, 'right');
  const floor = allowedRange(A1.workArea, size, inset).maxY;
  assert.equal(rel(A1.workArea, 800, floor - 10, sideBySide).final.y, floor);
  // 副屏左边（交界线）也不吸
  const minX2 = allowedRange(A2.workArea, size, inset).minX;
  assert.equal(rel(A2.workArea, minX2 + 10, 400, sideBySide).dock, null);
});

test('不等高：只有隔壁没盖住的那段外边缘算边缘', () => {
  const B2 = D(1920, 0, 1280, 720);           // 右边一块矮屏，顶对齐
  const disp = [A1, B2];
  const maxX = allowedRange(A1.workArea, size, inset).maxX;
  assert.equal(rel(A1.workArea, maxX - 10, 300, disp).dock, null, '身体中心 y=490，在矮屏旁边：交界线');
  assert.equal(rel(A1.workArea, maxX - 10, 700, disp).dock, 'right', '身体中心 y=890，矮屏下方空着：真边缘');
  // 身体一半在矮屏旁、一半在空处：不吸，但也不允许伸出去（伸出去下半身会落到没有屏幕的地方）
  const p = rel(A1.workArea, maxX + 30, 500, disp);
  assert.equal(p.dock, null);
  assert.equal(p.final.x, maxX);
});

test('上下错位：只吸错开的那一段', () => {
  const C2 = D(1920, 400, 1920, 1080);         // 右屏往下错 400
  const disp = [A1, C2];
  const maxX = allowedRange(A1.workArea, size, inset).maxX;
  assert.equal(rel(A1.workArea, maxX - 10, 50, disp).dock, 'right', '中心 y=240 < 400：右侧空着');
  assert.equal(rel(A1.workArea, maxX - 10, 600, disp).dock, null, '中心 y=790：右屏贴着');
});

test('上下叠放：上屏底边是交界线，不往下吸', () => {
  const top = D(0, 0, 1920, 1080);                         // 上屏没有任务栏
  const bottom = D(0, 1080, 1920, 1080, [0, 1080, 1920, 1040]);
  const disp = [top, bottom];
  const floor = allowedRange(top.workArea, size, inset).maxY;  // 830
  assert.equal(rel(top.workArea, 800, floor - 10).final.y, floor, '旧行为会吸到交界线');
  assert.equal(rel(top.workArea, 800, floor - 10, disp).final.y, floor - 10);
  // 下屏的任务栏照常落脚
  const floor2 = allowedRange(bottom.workArea, size, inset).maxY;
  assert.equal(rel(bottom.workArea, 800, floor2 - 10, disp).final.y, floor2);
  // 上屏只盖住下屏左半边：右半段的底边仍是边缘
  const halfTop = D(0, 0, 960, 1080);
  const disp2 = [halfTop, D(-960, 1080, 1920, 1080, [-960, 1080, 1920, 1040])];
  assert.equal(edgeInfo({ position: { x: 300, y: 800 }, area: halfTop.workArea, size, inset, displays: disp2 }).bottom.open, false);
});

test('混合缩放：DIP 换算差 1px 的缝也算相邻', () => {
  const S1 = D(0, 0, 1280, 720, [0, 0, 1280, 688]);   // 150% 缩放的 1920×1080
  const S2 = D(1281, 0, 1920, 1080);                  // 100% 缩放，换算后差 1px
  const maxX = allowedRange(S1.workArea, size, inset).maxX;
  assert.equal(rel(S1.workArea, maxX - 5, 200, [S1, S2]).dock, null);
  const S3 = D(1278, 0, 1920, 1080);                  // 反过来重叠 2px
  assert.equal(rel(S1.workArea, maxX - 5, 200, [S1, S3]).dock, null);
});

test('任务栏在交界那一侧：任务栏边照常算边缘', () => {
  const T1 = D(0, 0, 1920, 1080, [0, 0, 1872, 1080]); // 竖任务栏在右
  const maxX = allowedRange(T1.workArea, size, inset).maxX;
  assert.equal(rel(T1.workArea, maxX - 10, 400, [T1, A2]).dock, 'right');
});

test('单屏、拔掉副屏、屏幕列表过期：和以前完全一样', () => {
  const cases = [[-40, 400], [30, 400], [1730, 400], [800, 760], [900, 300]];
  for (const [x, y] of cases) {
    const old = rel(A1.workArea, x, y);
    assert.deepEqual(rel(A1.workArea, x, y, [A1]), old, `单屏 ${x},${y}`);
    assert.deepEqual(rel(A1.workArea, x, y, []), old);
    // 工作区和列表里任何屏都对不上（刚热插拔、列表还没更新）：按单屏算，不报错
    assert.deepEqual(rel(A1.workArea, x, y, [D(5000, 0, 100, 100), D(6000, 0, 100, 100)]), old);
  }
});

test('交界处反复松手不抖：结果是不动点', () => {
  const maxX = allowedRange(A1.workArea, size, inset).maxX;
  for (const x0 of [maxX - 27, maxX - 10, maxX, maxX + 20, maxX + 60]) {
    const a = rel(A1.workArea, x0, 400, sideBySide).final;
    const b = rel(A1.workArea, a.x, a.y, sideBySide).final;
    assert.deepEqual(b, a, `x0=${x0}`);
  }
});

test('dockOf：交界线上不算贴边，外侧边照旧', () => {
  const maxX = allowedRange(A1.workArea, size, inset).maxX;
  assert.equal(dockOf({ position: { x: maxX, y: 400 }, area: A1.workArea, size, inset }), 'right');
  assert.equal(dockOf({ position: { x: maxX, y: 400 }, area: A1.workArea, size, inset, displays: sideBySide }), null);
  assert.equal(dockOf({ position: { x: -60, y: 400 }, area: A1.workArea, size, inset, displays: sideBySide }), 'left');
});

test('甩出去：交界线不当墙，不在交界线上吸附', () => {
  const samples = [{ t: 0, x: 1000, y: 300 }, { t: 100, x: 1300, y: 300 }];
  const args = { samples, position: { x: 1300, y: 300 }, area: A1.workArea, size, inset };
  const old = flingPlan(args);
  assert.equal(old.dock, 'right');
  const p = flingPlan({ ...args, displays: sideBySide });
  assert.ok(p.fling);
  assert.equal(p.dock, null);
  assert.equal(p.final.y, allowedRange(A1.workArea, size, inset).maxY, '仍落到本屏任务栏上');
  // 往外侧甩照旧贴外侧边
  const left = flingPlan({ samples: [{ t: 0, x: 600, y: 300 }, { t: 100, x: 300, y: 300 }], position: { x: 300, y: 300 }, area: A1.workArea, size, inset, displays: sideBySide });
  assert.equal(left.dock, 'left');
});

// ---------- 交叉审查补的反例（真实窗口 280×340、身体 150、脚下 6） ----------
const W = { width: 280, height: 340 };
const IN = { left: 65, right: 65, top: 0, bottom: 6 };
const relB = (area, x, y, displays, o = {}) => releasePlan({ samples: still(x, y), position: { x, y }, area, size: o.size || W, inset: o.inset || IN, body: o.body || 150, displays });

test('甩向矮屏、落到矮屏下方：落地后收回本屏，再松手结果不变', () => {
  const L = D(0, 0, 1920, 1080), R = D(1920, 0, 1280, 720);
  const args = { samples: [{ t: 0, x: 1640, y: 300 }, { t: 100, x: 1760, y: 300 }], position: { x: 1760, y: 300 }, area: L.workArea, size: W, inset: IN, body: 150, displays: [L, R] };
  const p = flingPlan(args);
  assert.ok(p.fling);
  const baseMax = allowedRange(L.workArea, W, IN).maxX;
  assert.ok(p.final.x <= baseMax, `落地后身体不伸进无屏区：${p.final.x}`);
  const again = relB(L.workArea, p.final.x, p.final.y, [L, R]);
  assert.deepEqual(again.final, p.final);
  assert.equal(again.dock, p.dock);
});

test('上下叠放：身体中心跨过交界 1 DIP，落点也只差 1 DIP', () => {
  const T = D(0, 0, 1920, 1080), B = D(0, 1080, 1920, 1080), disp = [T, B];
  const a = relB(T.workArea, 800, 820, disp).final;   // 中心 y=1079，归上屏
  const b = relB(B.workArea, 800, 821, disp).final;   // 中心 y=1080，归下屏
  assert.deepEqual(a, { x: 800, y: 820 });
  assert.deepEqual(b, { x: 800, y: 821 });
});

test('带透明边的形象：按真实身体高度判断隔壁屏有没有盖住', () => {
  const L = D(0, 0, 1920, 1080), R = D(1920, 400, 1280, 680);   // 右屏往下错 400
  const peng = { left: 100, right: 90, top: 0, bottom: 6 };      // 企鹅：左右透明边不对称
  const p = relB(L.workArea, 1775, 190, [L, R], { inset: peng });  // 身体纵向 374–524，上面一截在右屏之上
  assert.equal(p.final.x, allowedRange(L.workArea, W, peng).maxX, '不能伸过去');
  assert.equal(p.dock, null, '中心旁边有屏，也不吸');
});

test('单屏奇数身体（缩放 0.63，透明边 92.5）：贴右边和以前一样', () => {
  const inset = { left: 92.5, right: 92.5, top: 0, bottom: 6 };
  const S = D(0, 0, 1920, 1080);
  for (const disp of [undefined, [], [S]]) {
    const p = relB(S.workArea, 1740, 400, disp, { inset, body: 95 });
    assert.equal(p.dock, 'right');
    assert.equal(p.final.x, 1732.5);
  }
});

// ---------- 控制器：半跨交界的位置，重新打开、调大小都不被拉回 ----------
function rigTwoScreens(t, saved, list = [D(0, 0, 1920, 1080), D(1920, 0, 1920, 1080)]) {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { EventEmitter } = require('node:events');
  const { createHubPetController } = require('../main/hub-pet-controller');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-ms-'));
  if (saved) fs.writeFileSync(path.join(root, 'hub-pet.json'), JSON.stringify(saved));
  class FakeWindow extends EventEmitter {
    constructor(o) { super(); this.bounds = { x: 0, y: 0, width: o.width, height: o.height }; this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.send = () => {}; this.webContents.getOSProcessId = () => 0; }
    isDestroyed() { return this.destroyed; }
    getBounds() { return this.bounds; }
    setBounds(b) { this.bounds = { ...b }; }
    setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; }
    setIgnoreMouseEvents() {} setAlwaysOnTop() {} loadFile() { return Promise.resolve(); } showInactive() {} focus() {} hide() {} show() {}
    isVisible() { return true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  let cur = { x: 0, y: 0 };
  const inside = (p, b) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  const near = p => list.find(d => inside(p, d.bounds)) || list[0];
  const c = createHubPetController({ BrowserWindow: FakeWindow, ipcMain, dataDir: root,
    assetsDir: path.join(__dirname, '../renderer/assets/hub-pet'), htmlPath: 'fixture.html', preloadPath: 'fixture-preload.js',
    screen: { getPrimaryDisplay: () => list[0], getDisplayNearestPoint: near, getDisplayMatching: () => list[0], getAllDisplays: () => list, getCursorScreenPoint: () => cur },
    powerMonitor: { getSystemIdleTime: () => 0 }, watchFullscreen: false, logger: { warn() {}, info() {} },
    sendToRenderer: () => {}, focusPrimaryWindow: () => {}, getSessionActivity: () => ({ running: 0 }), getMainWindow: () => null });
  t.after(() => { c.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  c.ipc = ipcMain;
  c.setCursor = p => { cur = p; };
  c.pet = () => ({ sender: c.getWindow().webContents });
  return c;
}

test('控制器：半跨交界保存的位置，打开时原样放回；调大小也不被拉回交界线内', t => {
  const c = rigTwoScreens(t, { enabled: false, position: { x: 1760, y: 400 } });
  c.setSettings({ enabled: true });
  const b = c.getWindow().getBounds();
  assert.deepEqual({ x: b.x, y: b.y }, { x: 1760, y: 400 });
  c.setSettings({ scale: 1.02 });
  const b2 = c.getWindow().getBounds();
  assert.ok(b2.x >= 1755, `调大小后没被拉回：${b2.x}`);
  assert.ok(c.getSettings().position.x >= 1755);
});

test('上下叠放：停在半跨交界处的桌宠，按住横拖 10 DIP 不会竖向弹走', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_800_000_000_000 });
  const advance = ms => { for (let i = 0; i < ms; i++) t.mock.timers.tick(1); };
  const c = rigTwoScreens(t, { enabled: false, position: { x: 800, y: 821 } }, [D(0, 0, 1920, 1080), D(0, 1080, 1920, 1080)]);
  c.setSettings({ enabled: true });
  assert.deepEqual((({ x, y }) => ({ x, y }))(c.getWindow().getBounds()), { x: 800, y: 821 }, '原样恢复');
  c.setCursor({ x: 940, y: 1080 });
  c.ipc.emit('hub-pet:press', c.pet(), { target: 'pet' });
  for (let x = 942; x <= 950; x += 2) { c.setCursor({ x, y: 1080 }); advance(30); }
  const b = c.getWindow().getBounds();
  assert.deepEqual({ x: b.x, y: b.y }, { x: 810, y: 821 }, '横向跟手、竖向不动');
  c.ipc.emit('hub-pet:release', c.pet());
  advance(600);
  const e = c.getWindow().getBounds();
  assert.deepEqual({ x: e.x, y: e.y }, c.getSettings().position, '窗口位置＝保存位置');
  assert.equal(e.y, 821);
});

test('甩动全程：身体任何时刻都在屏幕上，起飞不跳，途中不横跳', () => {
  const { clampRest } = require('../core/hub-pet/motion');
  const cases = [
    { disp: [D(0, 0, 1920, 1080), D(1920, 0, 1280, 720)], pos: { x: 1760, y: 300 }, vx: 1200, vy: 0 },   // 甩向矮屏、落到矮屏下方
    { disp: [D(0, 0, 1920, 1080), D(1920, 0, 1280, 720)], pos: { x: 1760, y: 300 }, vx: 600, vy: -900 },
    { disp: [D(0, 0, 1920, 1080), D(0, 1080, 1920, 1080)], pos: { x: 800, y: 820 }, vx: 1200, vy: 0 },  // 上下叠放，归上屏
    { disp: [D(0, 0, 1920, 1080), D(0, 1080, 1920, 1080)], pos: { x: 800, y: 821 }, vx: 1200, vy: 0 },  // 上下叠放，归下屏
    { disp: [D(0, 0, 1920, 1080), D(0, 1080, 1920, 1080)], pos: { x: 800, y: 821 }, vx: 300, vy: -1200 },
    { disp: [D(0, 0, 1920, 1080), D(1920, 0, 1920, 1080)], pos: { x: 1760, y: 400 }, vx: 1500, vy: 200 }, // 左右等高，半跨
    { disp: [D(0, 0, 960, 1080), D(0, 1080, 1920, 1080)], pos: { x: 700, y: 821 }, vx: 1200, vy: 0 },   // 上屏只盖下屏左半，往右甩出覆盖段
    { disp: [D(0, 0, 960, 1080), D(0, 1080, 1920, 1080)], pos: { x: 700, y: 821 }, vx: -1200, vy: -600 },
  ];
  for (const k of cases) {
    const cy = k.pos.y + 340 - 6 - 75, cx = k.pos.x + 140;
    const home = k.disp.find(d => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height);
    const ctx = { area: home.workArea, size: W, inset: IN, body: 150, displays: k.disp };
    const samples = [{ t: 0, x: k.pos.x - k.vx / 10, y: k.pos.y - k.vy / 10 }, { t: 100, ...k.pos }];
    const p = flingPlan({ samples, position: k.pos, ...ctx });
    assert.ok(p && p.fling, JSON.stringify(k));
    const fly = p.steps[0];
    assert.deepEqual(flyAt(fly, 0), k.pos, `起飞点就是松手点 ${JSON.stringify(k)}`);
    let prev = flyAt(fly, 0);
    for (let tm = 1; tm <= fly.durationMs; tm++) {
      const q = flyAt(fly, tm);
      assert.deepEqual(clampRest(q, ctx), q, `t=${tm} 身体不出屏 ${JSON.stringify(k)} ${JSON.stringify(q)}`);
      assert.ok(Math.abs(q.x - prev.x) <= 12, `t=${tm} 不横跳 ${prev.x}→${q.x}`);
      prev = q;
    }
    assert.ok(p.steps.slice(1).every(s => s.kind === 'snap' && p.dock), '落地后不再横向回收（只有吸外侧边才有后续一步）');
  }
});

test('不等高：按住往矮屏下方拖，每一帧身体都在屏幕上，鼠标不动时不再横跳', t => {
  const { clampRest } = require('../core/hub-pet/motion');
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_800_000_000_000 });
  const advance = ms => { for (let i = 0; i < ms; i++) t.mock.timers.tick(1); };
  const list = [D(0, 0, 1920, 1080), D(1920, 0, 1280, 720)];
  const c = rigTwoScreens(t, { enabled: false, position: { x: 1770, y: 386 } }, list);
  c.setSettings({ enabled: true });
  assert.deepEqual((({ x, y }) => ({ x, y }))(c.getWindow().getBounds()), { x: 1770, y: 386 });
  const ctxAt = p => ({ area: list[0].workArea, size: W, inset: IN, body: 150, displays: list });
  c.setCursor({ x: 1870, y: 686 });
  c.ipc.emit('hub-pet:press', c.pet(), { target: 'pet' });
  const seen = [];
  for (let y = 688; y <= 720; y += 2) { c.setCursor({ x: 1870, y }); for (let i = 0; i < 30; i++) { advance(1); const b = c.getWindow().getBounds(); seen.push({ x: b.x, y: b.y }); } }
  for (const q of seen) assert.equal(clampRest(q, ctxAt(q)).x, q.x, `身体不伸进无屏区 ${JSON.stringify(q)}`);
  const still = c.getWindow().getBounds();
  advance(200);
  const after = c.getWindow().getBounds();
  assert.deepEqual({ x: after.x, y: after.y }, { x: still.x, y: still.y }, '鼠标不动，窗口不动');
  c.ipc.emit('hub-pet:release', c.pet());
  advance(600);
});

test('交界处隔着任务栏：两屏都按外侧边算，判定对称，跨中线不出现一边放行一边不放行', () => {
  const { edgeInfo } = require('../core/hub-pet/motion');
  // 上下叠放，两屏各自带底部任务栏（Windows 多屏默认）
  const T = D(0, 0, 1920, 1080, [0, 0, 1920, 1040]);
  const B = D(0, 1080, 1920, 1080, [0, 1080, 1920, 1040]);
  const list = [T, B];
  const eT = edgeInfo({ position: { x: 800, y: 700 }, area: T.workArea, size: W, inset: IN, displays: list, body: 150 });
  const eB = edgeInfo({ position: { x: 800, y: 1080 }, area: B.workArea, size: W, inset: IN, displays: list, body: 150 });
  assert.equal(eT.bottom.open, true, '上屏底边是任务栏，照旧吸');
  assert.equal(eB.top.passable, false, '下屏顶边隔着上屏任务栏，身体不能伸上去盖住任务栏');
  assert.equal(eB.top.open, true);
  // 左右并排，左屏任务栏竖在交界一侧
  const L = D(0, 0, 1920, 1080, [0, 0, 1872, 1080]);
  const R = D(1920, 0, 1920, 1080);
  const eR = edgeInfo({ position: { x: 1920, y: 400 }, area: R.workArea, size: W, inset: IN, displays: [L, R], body: 150 });
  assert.equal(eR.left.passable, false, '右屏左边隔着左屏竖任务栏，不放行');
  // 隔壁屏没有任务栏挡着时照旧放行（不影响原来的修复）
  const eR2 = edgeInfo({ position: { x: 1920, y: 400 }, area: R.workArea, size: W, inset: IN, displays: [D(0, 0, 1920, 1080), R], body: 150 });
  assert.equal(eR2.left.open, false);
  assert.equal(eR2.left.passable, true);
});

test('慢慢拖过不等高屏的拐角后立刻松手：限位收的那一下不算甩，不会被甩飞', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_800_000_000_000 });
  const advance = ms => { for (let i = 0; i < ms; i++) t.mock.timers.tick(1); };
  const list = [D(0, 0, 1920, 1080), D(1920, 0, 1280, 720)];
  const c = rigTwoScreens(t, { enabled: false, position: { x: 1770, y: 386 } }, list);
  c.setSettings({ enabled: true });
  c.setCursor({ x: 1870, y: 686 });
  c.ipc.emit('hub-pet:press', c.pet(), { target: 'pet' });
  for (let y = 686; y <= 694; y++) { c.setCursor({ x: 1870, y }); advance(5); }
  const before = c.getWindow().getBounds();
  c.ipc.emit('hub-pet:release', c.pet());
  advance(1500);
  const after = c.getWindow().getBounds();
  assert.ok(Math.abs(after.x - before.x) < 60, `没有横向甩飞：${before.x} → ${after.x}`);
});
