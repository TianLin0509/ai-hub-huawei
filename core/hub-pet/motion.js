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

// 松手后的完整计划：先惯性滑行（可能为空），再贴边（可能为空）。
function releasePlan({ samples, position, area, size, inset }) {
  const range = allowedRange(area, size, inset);
  const { vx, vy, speed } = releaseVelocity(samples);
  const steps = [];
  let at = clampTo(range, position.x, position.y);
  if (speed >= MIN_SPEED) {
    const dist = Math.min(MAX_SLIDE, 12 + (speed - MIN_SPEED) * 0.035);
    const to = clampTo(range, at.x + (vx / speed) * dist, at.y + (vy / speed) * dist);
    const durationMs = Math.round(Math.min(210, Math.max(120, 120 + (speed - MIN_SPEED) * 0.05)));
    if (to.x !== at.x || to.y !== at.y) { steps.push({ kind: 'slide', from: at, to, durationMs }); at = to; }
  }
  let dock = null;
  const snap = { x: at.x, y: at.y };
  if (at.x - range.minX <= SNAP_DISTANCE) { snap.x = range.minX; dock = 'left'; }
  else if (range.maxX - at.x <= SNAP_DISTANCE) { snap.x = range.maxX; dock = 'right'; }
  if (range.maxY - at.y <= SNAP_DISTANCE) snap.y = range.maxY;
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
  const r = step.range;
  const x = step.from.x + step.vx * (1 - Math.exp(-AIR_DRAG * t)) / AIR_DRAG;
  const y = step.from.y + step.vy * t + 0.5 * (step.gravity || GRAVITY) * t * t;
  return { x: Math.round(Math.min(r.maxX, Math.max(r.minX, x))), y: Math.round(Math.min(r.maxY, Math.max(r.minY, y))) };
}

// 甩出去的完整计划；速度不够返回 null（交给 releasePlan）。
function flingPlan({ samples, position, area, size, inset }) {
  const { vx: rawVx, vy: rawVy, speed: rawSpeed } = releaseVelocity(samples);
  if (rawSpeed < FLING_SPEED) return null;
  const range = allowedRange(area, size, inset);
  const k = Math.min(1, FLING_VMAX / rawSpeed);
  const vx = rawVx * k;
  const vy = Math.max(-FLING_UP_MAX, rawVy * k);
  const from = clampTo(range, position.x, position.y);
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
  let at = flyAt(step, durationMs);
  at = { x: at.x, y: range.maxY };
  const steps = [step];
  let dock = null;
  const snap = { x: at.x, y: at.y };
  if (at.x - range.minX <= SNAP_DISTANCE) { snap.x = range.minX; dock = 'left'; }
  else if (range.maxX - at.x <= SNAP_DISTANCE) { snap.x = range.maxX; dock = 'right'; }
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
function dockOf({ position, area, size, inset }) {
  const range = allowedRange(area, size, inset);
  if (position.x - range.minX <= 2) return 'left';
  if (range.maxX - position.x <= 2) return 'right';
  return null;
}

module.exports = { FLING_SPEED, GRAVITY, MIN_SPEED, MAX_SLIDE, SNAP_DISTANCE, SNAP_MS, WALK_MAX, WALK_MIN, WALK_SPEED, allowedRange, clampTo, cubicOut, dockOf, flingPlan, flyAt, releasePlan, releaseVelocity, walkIntervals, walkPlan };
