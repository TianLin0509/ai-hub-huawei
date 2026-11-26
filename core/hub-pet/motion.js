'use strict';
// 桌宠窗口的移动规划（主进程用）。借鉴 WorkMate 的 DragInertia / EdgeBehavior：
// 只看松手前最后 180ms 的速度；慢于 260 DIP/s 不滑；滑行距离 12+(v-260)*0.035，最多 52 DIP；
// 滑行 120–210ms，cubic-out 缓动；停下后离屏幕左右边或底边 28 DIP 以内就贴过去（190ms）。
// 「宠物身体」只占窗口中间一块，贴边按身体算，窗口两侧透明的部分可以伸出屏幕。

const SAMPLE_WINDOW_MS = 180;
const MIN_SPEED = 260;
const MAX_SLIDE = 52;
const SNAP_DISTANCE = 28;
const SNAP_MS = 190;

function cubicOut(t) { const u = 1 - Math.min(1, Math.max(0, t)); return 1 - u * u * u; }

// samples：[{ t, x, y }]（窗口左上角，DIP），按时间顺序。
function releaseVelocity(samples = []) {
  if (samples.length < 2) return { vx: 0, vy: 0, speed: 0 };
  const last = samples[samples.length - 1];
  let first = samples[samples.length - 2];
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > SAMPLE_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = Math.max(1, last.t - first.t) / 1000;
  const vx = (last.x - first.x) / dt;
  const vy = (last.y - first.y) / dt;
  return { vx, vy, speed: Math.hypot(vx, vy) };
}

// 身体在屏幕上可活动的窗口左上角范围。inset：身体相对窗口的边距 { left, right, top, bottom }。
function allowedRange(area, size, inset) {
  return {
    minX: area.x - inset.left,
    maxX: area.x + area.width - size.width + inset.right,
    minY: area.y,
    maxY: area.y + area.height - size.height + inset.bottom,
  };
}

function clampTo(range, x, y) {
  return { x: Math.round(Math.min(range.maxX, Math.max(range.minX, x))), y: Math.round(Math.min(range.maxY, Math.max(range.minY, y))) };
}

// ---------- 多屏：哪些边是真正的屏幕外侧边（2026-11-26） ----------
// 多屏时，本屏某条边如果被隔壁屏贴着（两屏在这条线上有重叠的一段），这一段只是交界线，不是边缘：
// 不在这里吸附，也不把半跨交界的身体弹回本屏。两屏不等高、不对齐时，只有没被隔壁盖住的那段才算边缘。
// displays：screen.getAllDisplays() 的结果（各屏 bounds、workArea，DIP）；不传或只有一块屏时和以前完全一样。
// 混合缩放下 Electron 换算出的 DIP 坐标会差一两个像素，相邻判断留 EDGE_TOL 的容差。
const EDGE_TOL = 4;
const sameRect = (a, b) => !!(a && b) && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
function homeOf(area, displays) {
  if (!Array.isArray(displays) || displays.length < 2) return null;
  return displays.find(d => d && sameRect(d.workArea, area)) || null;
}
// 本屏 side 边上被别的屏盖住的线段（沿这条边的坐标：左右边是 y，上下边是 x）。
// 隔壁屏朝向本屏的那一侧是任务栏的，不算盖住（交界处隔着任务栏，两边都按外侧边算，两屏判定对称）；
// 沿边的线段按隔壁屏工作区算（隔壁的竖/横任务栏占掉的那段也不算盖住）。
function coveredSpans(home, displays, side) {
  const b = home.bounds, out = [];
  for (const d of displays) {
    if (!d || d === home || !d.bounds || sameRect(d.bounds, b)) continue;
    const o = d.bounds, w = d.workArea || d.bounds;
    let touch = false, lo = 0, hi = 0;
    if (side === 'left' || side === 'right') {
      touch = side === 'left'
        ? Math.abs(o.x + o.width - b.x) <= EDGE_TOL && Math.abs(w.x + w.width - (o.x + o.width)) <= 1
        : Math.abs(o.x - (b.x + b.width)) <= EDGE_TOL && Math.abs(w.x - o.x) <= 1;
      lo = Math.max(b.y, w.y); hi = Math.min(b.y + b.height, w.y + w.height);
    } else {
      touch = side === 'top'
        ? Math.abs(o.y + o.height - b.y) <= EDGE_TOL && Math.abs(w.y + w.height - (o.y + o.height)) <= 1
        : Math.abs(o.y - (b.y + b.height)) <= EDGE_TOL && Math.abs(w.y - o.y) <= 1;
      lo = Math.max(b.x, w.x); hi = Math.min(b.x + b.width, w.x + w.width);
    }
    if (touch && hi > lo) out.push([lo, hi]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}
function spansCover(spans, lo, hi) {
  let at = lo;
  for (const [a, b] of spans) { if (a > at + 1) break; if (b > at) at = b; if (at >= hi) return true; }
  return at >= hi;
}
// 身体在窗口里的位置。body：身体方块边长（控制器传 geom().body）；不传按可见宽度估。
// 中心和控制器「按身体中心认屏」用同一个点：横向取窗口正中，纵向取身体方块正中。
function bodyFrame(size, inset, body) {
  const B = Math.max(1, Number(body) > 0 ? Number(body) : size.width - inset.left - inset.right);
  return { B, cxOff: size.width / 2, cyOff: size.height - inset.bottom - B / 2 };
}
// 窗口停在 position 时，本屏四条边各是什么：open＝真正的外侧边（可吸附）；passable＝隔壁屏盖住了身体整段，身体可以伸过去。
// 工作区边不等于屏幕边的那一侧是任务栏，照旧算外侧边。
function edgeInfo({ position, area, size, inset, displays, body }) {
  const all = { left: { open: true, passable: false }, right: { open: true, passable: false }, top: { open: true, passable: false }, bottom: { open: true, passable: false } };
  const home = homeOf(area, displays);
  if (!home || !home.bounds || !position) return all;
  const b = home.bounds;
  const f = bodyFrame(size, inset, body);
  const x1 = position.x + inset.left, x2 = position.x + size.width - inset.right;
  const y2 = position.y + size.height - inset.bottom, y1 = y2 - f.B;
  const cx = position.x + f.cxOff, cy = position.y + f.cyOff;
  const flush = { left: Math.abs(area.x - b.x) <= 1, right: Math.abs(area.x + area.width - (b.x + b.width)) <= 1, top: Math.abs(area.y - b.y) <= 1, bottom: Math.abs(area.y + area.height - (b.y + b.height)) <= 1 };
  for (const side of ['left', 'right', 'top', 'bottom']) {
    if (!flush[side]) continue;
    const spans = coveredSpans(home, displays, side);
    if (!spans.length) continue;
    const vertical = side === 'left' || side === 'right';
    const c = vertical ? cy : cx;
    const inner = spans.some(([lo, hi]) => c >= lo && c <= hi);
    all[side] = { open: !inner, passable: inner && (vertical ? spansCover(spans, y1, y2) : spansCover(spans, x1, x2)) };
  }
  return all;
}
// 限位：隔壁屏盖住身体整段的那一边，身体可以伸过交界线，直到身体中心到交界线为止（中心仍在本屏，
// 和控制器「按身体中心认屏」一致；上下方向按身体中心算，不按窗口顶，窗口上方大片留白不影响）。取整数，取整后中心也不越界。
function relaxedRange(range, edges, { area, size, inset, body }) {
  const f = bodyFrame(size, inset, body);
  return {
    minX: edges.left.passable ? Math.min(range.minX, Math.ceil(area.x - f.cxOff)) : range.minX,
    maxX: edges.right.passable ? Math.max(range.maxX, Math.floor(area.x + area.width - 1 - f.cxOff)) : range.maxX,
    minY: edges.top.passable ? Math.min(range.minY, Math.ceil(area.y - f.cyOff)) : range.minY,
    maxY: edges.bottom.passable ? Math.max(range.maxY, Math.floor(area.y + area.height - 1 - f.cyOff)) : range.maxY,
  };
}
// 把位置收进「可以停的地方」：单屏就是本屏工作区限位（和以前一样）；多屏时按停下那一刻的覆盖情况放宽。
// 收一次后覆盖情况可能变（比如顺着交界线挪了），再按新位置收一次。启动恢复、调大小、松手、甩出去都用它。
function restRange(position, ctx) {
  return relaxedRange(allowedRange(ctx.area, ctx.size, ctx.inset), edgeInfo({ ...ctx, position }), ctx);
}
function clampRest(position, ctx) {
  const base = allowedRange(ctx.area, ctx.size, ctx.inset);
  let at = clampTo(relaxedRange(base, edgeInfo({ ...ctx, position }), ctx), position.x, position.y);
  at = clampTo(relaxedRange(base, edgeInfo({ ...ctx, position: at }), ctx), at.x, at.y);
  return at;
}
// 停在 at 时往哪条边吸（releasePlan、flingPlan 共用）：只吸真正的外侧边；伸过交界线的不吸。
function snapAt(at, base, ctx, { bottom = true } = {}) {
  const e = edgeInfo({ ...ctx, position: at });
  let dock = null;
  const snap = { x: at.x, y: at.y };
  if (e.left.open && at.x - base.minX <= SNAP_DISTANCE) { snap.x = base.minX; dock = 'left'; }
  else if (e.right.open && base.maxX - at.x <= SNAP_DISTANCE) { snap.x = base.maxX; dock = 'right'; }
  if (bottom && e.bottom.open && base.maxY - at.y <= SNAP_DISTANCE) snap.y = base.maxY;
  return { snap, dock };
}

// 松手后的完整计划：先惯性滑行（可能为空），再贴边（可能为空）。
function releasePlan({ samples, position, area, size, inset, displays, body }) {
  const base = allowedRange(area, size, inset);
  const ctx = { area, size, inset, displays, body };
  const { vx, vy, speed } = releaseVelocity(samples);
  const steps = [];
  let at = clampRest(position, ctx);
  if (speed >= MIN_SPEED) {
    const dist = Math.min(MAX_SLIDE, 12 + (speed - MIN_SPEED) * 0.035);
    // 滑到的地方按那里的覆盖情况再收一次（滑出隔壁屏覆盖的那段就不能再伸过去）。
    const to = clampRest({ x: at.x + (vx / speed) * dist, y: at.y + (vy / speed) * dist }, ctx);
    const durationMs = Math.round(Math.min(210, Math.max(120, 120 + (speed - MIN_SPEED) * 0.05)));
    if (to.x !== at.x || to.y !== at.y) { steps.push({ kind: 'slide', from: at, to, durationMs }); at = to; }
  }
  const { snap, dock } = snapAt(at, base, ctx);
  if (snap.x !== at.x || snap.y !== at.y) { steps.push({ kind: 'snap', from: at, to: snap, durationMs: SNAP_MS }); at = snap; }
  return { steps, final: at, dock, speed, vx, vy };
}

// ---------- 甩出去（2026-11-17 r27f）：沿抛物线落到任务栏上 ----------
// 松手速度 ≥ FLING_SPEED 才算「甩」：横向带空气阻力（e^(−k·t)）、碰到屏幕左右边就停在边上，竖向受重力，落到工作区底边（任务栏上沿）为止；
// 慢慢放下的照旧停在原地（只滑一小段）。往上甩的速度封顶，免得先撞到屏幕顶。
const FLING_SPEED = 900;
const FLING_VMAX = 2600;
const FLING_UP_MAX = 1500;
const GRAVITY = 2600;     // DIP/s²
const AIR_DRAG = 1.6;     // 1/s
const FLY_MAX_MS = 1400;

// 飞行中 tMs 时刻窗口左上角的位置。
function flyAt(step, tMs) {
  const t = Math.min(step.durationMs, Math.max(0, tMs)) / 1000;
  let r = step.range;
  // 多屏：飞到隔壁屏盖不住身体的地方之前，把伸过交界线的那部分在 tBlend 内匀速收回本屏（不在半空突然横跳，也不伸进没有屏幕的地方）。
  if (step.range2) {
    const k = Math.min(1, (t * 1000) / step.tBlend), mix = (a, b) => a + (b - a) * k;
    r = { minX: mix(step.range.minX, step.range2.minX), maxX: mix(step.range.maxX, step.range2.maxX), minY: mix(step.range.minY, step.range2.minY), maxY: mix(step.range.maxY, step.range2.maxY) };
  }
  const x = step.from.x + step.vx * (1 - Math.exp(-AIR_DRAG * t)) / AIR_DRAG;
  const y = step.from.y + step.vy * t + 0.5 * (step.gravity || GRAVITY) * t * t;
  return { x: Math.round(Math.min(r.maxX, Math.max(r.minX, x))), y: Math.round(Math.min(r.maxY, Math.max(r.minY, y))) };
}

// 甩出去的完整计划；速度不够返回 null（交给 releasePlan）。
function flingPlan({ samples, position, area, size, inset, displays, body }) {
  const { vx: rawVx, vy: rawVy, speed: rawSpeed } = releaseVelocity(samples);
  if (rawSpeed < FLING_SPEED) return null;
  const base = allowedRange(area, size, inset);
  const ctx = { area, size, inset, displays, body };
  // 甩出去只放宽左右（交界线不当墙），落地仍落在本屏任务栏上沿。
  // 多屏：从松手的真实位置起飞（半跨上下交界的也不先挪回本屏范围）；途中飞出隔壁屏的覆盖段时匀速收回本屏（range2/tBlend）。
  const multi = !!homeOf(area, displays);
  let range, from;
  if (!multi) {
    range = base;
    from = clampTo(range, position.x, position.y);
  } else {
    from = clampRest(position, ctx);
    const re = restRange(from, ctx);
    range = { minX: Math.min(re.minX, from.x), maxX: Math.max(re.maxX, from.x), minY: Math.min(base.minY, from.y), maxY: Math.max(base.maxY, from.y) };
  }
  const k = Math.min(1, FLING_VMAX / rawSpeed);
  const vx = rawVx * k;
  const vy = Math.max(-FLING_UP_MAX, rawVy * k);
  const drop = Math.max(0, range.maxY - from.y);
  // ½g·t² + vy·t − drop = 0 的正根：落到底边的时刻
  const tLand = (-vy + Math.sqrt(vy * vy + 2 * GRAVITY * drop)) / GRAVITY;
  const durationMs = Math.round(Math.min(FLY_MAX_MS, Math.max(160, tLand * 1000)));
  // 高屏（4K、竖屏）或往上甩时真实落地要 1.4 秒以上：飞行时间仍封顶，但把这段的「重力」加大到正好在结束时刻落到底边，
  // 保证最后一帧就在任务栏上沿、和保存的位置一致（r27f 审查第 3 项：以前截时间后停在半空，4K 下差 1130 DIP）。
  const T = durationMs / 1000;
  // 没封顶时也按取整后的时长微调一点（差不到 1%），免得最后一帧差 1px。落差极小（不到 160ms 就落地）的照旧，靠范围截住。
  const gravity = tLand * 1000 >= 160 ? 2 * (drop - vy * T) / (T * T) : GRAVITY;
  const step = { kind: 'fly', from, vx, vy, gravity, range, durationMs };
  if (multi) {
    // 逐毫秒找第一帧落到「不能停」的地方：从起飞到它前一刻，把范围（左右、上下）匀速收成本屏工作区范围。
    for (let tMs = 1; tMs <= durationMs; tMs++) {
      const p = flyAt(step, tMs);
      const ok = clampRest(p, ctx);
      if (ok.x !== p.x || ok.y !== p.y) {
        step.range2 = { ...base };
        step.tBlend = Math.max(1, tMs - 1);
        break;
      }
    }
  }
  let at = flyAt(step, durationMs);
  at = { x: at.x, y: (step.range2 || range).maxY };
  const steps = [step];
  if (homeOf(area, displays)) {
    const ok = clampRest(at, ctx);
    if (ok.x !== at.x || ok.y !== at.y) { steps.push({ kind: 'snap', from: at, to: ok, durationMs: SNAP_MS }); at = ok; }
  }
  const { snap, dock } = snapAt(at, base, ctx, { bottom: false });
  if (snap.x !== at.x) { steps.push({ kind: 'snap', from: at, to: snap, durationMs: SNAP_MS }); at = snap; }
  return { steps, final: at, dock, speed: rawSpeed, vx, vy, fling: true, impact: Math.min(1, 0.45 + Math.hypot(vx, vy + gravity * T) / 3200) };
}

// ---------- 在任务栏上走动（2026-11-17 r27f） ----------
// 只沿工作区底边（任务栏上沿）横着走，不往屏幕中间去；身体不进前台窗口在这条底带上占的横向范围（窗口底部常是输入框、状态栏），
// 前台窗口铺满底带（最大化）就不走。走的目标在当前所在的那段空白里：随便踱几步，或者走到前台窗口边上坐一会儿。
// 前台窗口坐标先由调用方换成 DIP（多屏、缩放各不同，见 hub-pet-controller 的 foregroundDip）。
const WALK_SPEED = 70;     // DIP/s，慢慢踱
const WALK_MAX = 360;      // 一次最多走这么远
const WALK_MIN = 60;
const SIT_GAP = 6;         // 坐在窗口边上时离窗口的距离

// 窗口左上角 x 的可走区间（已去掉会让身体压到前台窗口的那一段）。
function walkIntervals({ range, size, inset, band, foreground }) {
  let free = [[range.minX, range.maxX]];
  const fg = foreground;
  if (fg && fg.width > 0 && fg.height > 0 && fg.y < band.bottom && fg.y + fg.height > band.top) {
    // 身体 [x+inL, x+W−inR] 与窗口 [fx1, fx2] 相交 ⇔ x ∈ (fx1 − W + inR, fx2 − inL)
    const lo = fg.x - size.width + inset.right, hi = fg.x + fg.width - inset.left;
    free = free.flatMap(([a, b]) => {
      const out = [];
      if (a < lo) out.push([a, Math.min(b, lo)]);
      if (b > hi) out.push([Math.max(a, hi), b]);
      return out;
    });
  }
  return free.filter(([a, b]) => b - a >= 0);
}

// rnd：返回 [0,1) 的随机数（单测可固定）。返回 null 表示这次不走（附 reason）。
function walkPlan({ position, area, size, inset, body, foreground, rnd = Math.random }) {
  const range = allowedRange(area, size, inset);
  if (Math.abs(position.y - range.maxY) > 12) return { plan: null, reason: 'not-on-floor' };
  const floorBottom = position.y + size.height - inset.bottom;
  const band = { top: floorBottom - body, bottom: floorBottom };
  const free = walkIntervals({ range, size, inset, band, foreground });
  const x = position.x;
  const home = free.find(([a, b]) => x >= a - 0.5 && x <= b + 0.5);
  if (!home) return { plan: null, reason: 'covering-window' };   // 用户自己把它放在了窗口前面：不挪
  const [a, b] = home;
  const near = v => Math.abs(v - x) >= WALK_MIN && Math.abs(v - x) <= WALK_MAX;
  const options = [];
  // 坐到前台窗口边上：空白段的端点正好贴着窗口（不是屏幕边）
  const fg = foreground;
  if (fg && fg.width > 0) {
    const leftEdge = fg.x - size.width + inset.right - SIT_GAP;      // 坐在窗口左边
    const rightEdge = fg.x + fg.width - inset.left + SIT_GAP;        // 坐在窗口右边
    if (leftEdge >= a && leftEdge <= b && Math.abs(b - (leftEdge + SIT_GAP)) <= 1 && near(leftEdge)) options.push({ to: leftEdge, sit: 'left-of-window' });
    if (rightEdge >= a && rightEdge <= b && Math.abs(a - (rightEdge - SIT_GAP)) <= 1 && near(rightEdge)) options.push({ to: rightEdge, sit: 'right-of-window' });
  }
  if (options.length && rnd() < 0.6) {
    const o = options[Math.floor(rnd() * options.length)];
    return { plan: makeWalk(position, Math.round(o.to), o.sit, rnd), reason: '' };
  }
  // 随便踱几步：往还有空的那一边
  const dist = WALK_MIN + rnd() * (Math.min(WALK_MAX, 220) - WALK_MIN);
  const dirs = [];
  if (x - a >= WALK_MIN) dirs.push(-1);
  if (b - x >= WALK_MIN) dirs.push(1);
  if (!dirs.length) return { plan: null, reason: 'no-room' };
  const dir = dirs[Math.floor(rnd() * dirs.length)];
  const to = Math.round(Math.min(b, Math.max(a, x + dir * dist)));
  if (Math.abs(to - x) < WALK_MIN) return { plan: null, reason: 'no-room' };
  return { plan: makeWalk(position, to, '', rnd), reason: '' };
}
function makeWalk(position, toX, sit, rnd) {
  const dist = Math.abs(toX - position.x);
  return {
    from: { x: position.x, y: position.y }, to: { x: toX, y: position.y }, dir: toX > position.x ? 1 : -1, sit,
    durationMs: Math.round(Math.min(6000, Math.max(900, dist / WALK_SPEED * 1000))),
    dwellMs: Math.round(sit ? 20000 + rnd() * 20000 : 5000 + rnd() * 5000),
  };
}

// 判断某个位置贴在哪条边（启动恢复位置、躲边后回来时用）。
// 多屏时交界线不算边：传了 displays、那条边在身体这一段被隔壁屏盖住，就不算贴边。
function dockOf({ position, area, size, inset, displays, body }) {
  const range = allowedRange(area, size, inset);
  const e = edgeInfo({ position, area, size, inset, displays, body });
  if (e.left.open && position.x - range.minX <= 2) return 'left';
  if (e.right.open && range.maxX - position.x <= 2) return 'right';
  return null;
}

module.exports = { EDGE_TOL, edgeInfo, relaxedRange, restRange, clampRest, FLING_SPEED, GRAVITY, MIN_SPEED, MAX_SLIDE, SNAP_DISTANCE, SNAP_MS, WALK_MAX, WALK_MIN, WALK_SPEED, allowedRange, clampTo, cubicOut, dockOf, flingPlan, flyAt, releasePlan, releaseVelocity, walkIntervals, walkPlan };
