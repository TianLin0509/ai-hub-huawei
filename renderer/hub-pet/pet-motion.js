'use strict';
// 桌宠动画用到的数学（渲染端与单测共用）。参数借鉴 WorkMate 的 PetMotion，按 Hub 的帧调度重新整理：
// 呼吸频率 0.18+0.6·兴奋度 Hz，幅度 1.1%+1.0%·兴奋度，横向反向收缩一半多（体积守恒的感觉）；
// 落地回弹是衰减正弦 −p·e^(−3.5t)·sin(2π·2.2t)，1.2 秒内收完。
// 帧序列（2026-10-17 改）：按「播放单」逐帧硬切，不再把相邻两帧按小数部分叠加淡入——两张不同的画半透明叠在一起
// 就是用户说的「残影」。片段的选法借鉴 WorkMate 的 AnimationPolicy：小动作只播 5 帧、停一下再倒放回来，
// 打字只循环第一行身体不动的 5 帧，伸懒腰播到峰值停 420ms 再收势；被裁切的帧（manifest.clipped）不进播放单。
(function (root) {
  const TAU = Math.PI * 2;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function easeInOut(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function easeOutCubic(t) { t = clamp(t, 0, 1); const u = 1 - t; return 1 - u * u * u; }
  function easeOutBack(t) { t = clamp(t, 0, 1); const c = 1.6; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; }

  // 呼吸：返回 { sx, sy, phase }。phase 连续累积，兴奋度变化时频率平滑过渡、不会跳相位。
  function breathStep(phase, dtSec, arousal) {
    const a = clamp(arousal, 0, 1);
    const hz = 0.18 + 0.6 * a;
    const amp = 0.011 + 0.010 * a;
    const next = (phase + TAU * hz * dtSec) % (TAU * 1000);
    const sy = 1 + amp * Math.sin(next);
    return { phase: next, sy, sx: 1 - 0.55 * (sy - 1) };
  }

  // 落地挤压：t 秒后的竖向形变量（正数是拉高，负数是压扁）。
  function squashAt(t, power) {
    if (!(t >= 0) || t > 1.2) return 0;
    return -power * Math.exp(-3.5 * t) * Math.sin(TAU * 2.2 * t);
  }

  // 跳一下：t∈[0,dur] 的高度（向上为正）与落地瞬间标记。
  function hopAt(t, dur, height) {
    if (!(t >= 0) || t > dur) return 0;
    return height * Math.sin(Math.PI * t / dur);
  }

  // 指数逼近：半衰期 halfLifeMs 内走完剩余距离的一半，帧率高低都一样快。
  function approach(current, target, dtMs, halfLifeMs) {
    if (halfLifeMs <= 0) return target;
    return target + (current - target) * Math.pow(0.5, dtMs / halfLifeMs);
  }

  // 播放单：[{ f: 帧号, ms: 停留毫秒 }]。返回 elapsed 时刻该显示哪一帧；loop 时循环，否则停在最后一帧并标 done。
  function playlistFrame(elapsedMs, list, loop) {
    if (!list || !list.length) return { f: 0, index: 0, done: true };
    const total = list.reduce((n, x) => n + x.ms, 0);
    let t = Math.max(0, elapsedMs);
    if (loop && total > 0) t %= total;
    else if (t >= total) return { f: list[list.length - 1].f, index: list.length - 1, done: true };
    for (let i = 0; i < list.length; i++) {
      if (t < list[i].ms) return { f: list[i].f, index: i, done: false };
      t -= list[i].ms;
    }
    return { f: list[list.length - 1].f, index: list.length - 1, done: !loop };
  }

  // 从 from 到 to（含两端，可倒序）的帧号，跳过被裁切的帧。
  function frameRange(from, to, clipped = []) {
    const out = [];
    const dir = to >= from ? 1 : -1;
    for (let f = from; dir > 0 ? f <= to : f >= to; f += dir) if (clipped.indexOf(f) < 0) out.push(f);
    return out;
  }

  // 小动作：start 起往后 len 帧，最后一帧停 holdMs，再倒放回 start（WorkMate：175ms/帧，停 220ms）。
  // 片段里有被裁切的帧就整段不用，返回 null。
  function gesturePlaylist(start, len, clipped = [], msPerFrame = 175, holdMs = 220) {
    const fwd = frameRange(start, start + len - 1, []);
    if (fwd.some(f => clipped.indexOf(f) >= 0)) return null;
    const list = fwd.map(f => ({ f, ms: msPerFrame }));
    list[list.length - 1] = { f: fwd[fwd.length - 1], ms: msPerFrame + holdMs };
    for (let i = fwd.length - 2; i >= 0; i--) list.push({ f: fwd[i], ms: msPerFrame });
    return list;
  }

  // 来回循环：0,1,2,3,4,3,2,1（打字时只有爪子动，身体不跳）。
  function pingPong(frames, msPerFrame) {
    const list = frames.map(f => ({ f, ms: msPerFrame }));
    for (let i = frames.length - 2; i >= 1; i--) list.push({ f: frames[i], ms: msPerFrame });
    return list;
  }

  // 5×5 序列图里第 n 帧的 background-position（百分比）。
  function sheetPosition(n) {
    const col = n % 5;
    const row = Math.floor(n / 5);
    return (col * 25) + '% ' + (row * 25) + '%';
  }

  // ---------- 2026-11-17 r27f：待机更活 ----------
  // 起跳前下蹲：k∈[0,1] 是下蹲阶段的进度，返回压下去的深度（0→1→回到 0.35 时起跳，带一点「蓄力还没完全放开」的感觉）。
  function crouchAt(k) {
    k = clamp(k, 0, 1);
    return k < 0.7 ? easeOutCubic(k / 0.7) : 1 - 0.65 * easeInOut((k - 0.7) / 0.3);
  }

  // 不用画图的 6 种小动作（6 个形象通用，只动 transform）：s∈[0,1] → { x, y, rot, sx, sy }，两端都回到原样，接缝不跳。
  // dir 是 ±1（往哪边）。'hops' 这一种是「原地小跳两下」，由调用方按 hops 列表演（带下蹲），这里只给节奏。
  const hold = (s, a, b) => (s < a ? easeInOut(s / a) : s > b ? easeInOut((1 - s) / (1 - b)) : 1);
  const IDLE_MOVES = [
    { name: 'look', label: '左右张望', dur: 2600, fn: (s, dir) => { const k = Math.sin(TAU * s) * Math.sin(Math.PI * s); return { x: 2.5 * dir * k, y: 0, rot: 5 * dir * k, sx: 1 - 0.03 * Math.abs(k), sy: 1 }; } },
    { name: 'nod', label: '点点头', dur: 1300, fn: s => { const k = Math.pow(Math.sin(TAU * s), 2); return { x: 0, y: 2.4 * k, rot: 1.5 * k, sx: 1 + 0.01 * k, sy: 1 - 0.025 * k }; } },
    { name: 'hops', label: '原地小跳两下', dur: 1100, hops: [{ at: 0, dur: 300, height: 8 }, { at: 520, dur: 280, height: 6 }], fn: () => ({ x: 0, y: 0, rot: 0, sx: 1, sy: 1 }) },
    { name: 'shake', label: '抖一抖', dur: 900, fn: s => { const env = Math.sin(Math.PI * s); const w = Math.sin(TAU * 6 * s); return { x: 2.6 * w * env, y: 0, rot: 2.2 * w * env, sx: 1 + 0.02 * env, sy: 1 - 0.02 * env }; } },
    { name: 'tilt', label: '歪头想一想', dur: 2400, fn: (s, dir) => { const k = hold(s, 0.22, 0.72); return { x: 1.5 * dir * k, y: 0, rot: 7 * dir * k, sx: 1, sy: 1 }; } },
    { name: 'tiptoe', label: '踮脚伸一伸', dur: 1900, fn: s => { const k = hold(s, 0.35, 0.65); return { x: 0, y: -3 * k, rot: 0, sx: 1 - 0.03 * k, sy: 1 + 0.06 * k }; } },
  ];

  // 拎起来的钟摆：角度 a（度）、角速度 w（度/秒），被横向加速度 ax（DIP/s²）推着摆；约 1.3 Hz、阻尼比 0.12，±25° 封顶。
  // 分步积分，帧率高低都稳。往右加速时身体下半截落在后面（顺时针为正）。
  function pendulumStep(p, ax, dtSec) {
    const K = Math.pow(TAU * 1.3, 2), C = 2 * 0.12 * TAU * 1.3, D = 0.1;
    let a = p.a, w = p.w;
    const n = Math.max(1, Math.ceil(dtSec / 0.008));
    const h = dtSec / n;
    const drive = clamp(ax, -12000, 12000) * D;
    for (let i = 0; i < n; i++) {
      w += (-K * a - C * w + drive) * h;
      a += w * h;
      if (a > 25) { a = 25; w = Math.min(0, w); } else if (a < -25) { a = -25; w = Math.max(0, w); }
    }
    return { a, w };
  }
  // 绕身体上方的抓握点转（不改 CSS 的 transform-origin，免得松手时跳一下）：绕原点转 θ 再平移这么多，等价于绕抓握点转。
  // h 是抓握点在原点上方多少像素。
  function pivotOffset(deg, h) {
    const r = deg * Math.PI / 180;
    return { x: -h * Math.sin(r), y: -h * (1 - Math.cos(r)) };
  }

  // 走路的步态：t 秒，每秒 2.4 步，身体一颠一颠、左右轻摆，往前倾一点。
  function walkGait(t, dir) {
    const step = Math.sin(Math.PI * 2.4 * t);
    return { x: 0, y: -2.2 * Math.abs(step), rot: 2.4 * step + 2 * dir, sx: 1, sy: 1 + 0.015 * Math.abs(step) };
  }

  // 空闲时下一帧隔多久（毫秒）；返回 null 表示不再排下一帧，等状态或动作事件叫醒（2026-11-23 开销优化）。
  // - 正常显卡：照旧按 calmFps（呼吸 20 帧/秒、打盹 12 帧/秒、打字 30 帧/秒）；
  // - 软件渲染（关了硬件加速）：透明窗每帧都由 CPU 合成，空闲、犯困、躲边降到 6 帧/秒，打盹停在静止帧；
  // - 安静档或系统「减少动态效果」：不再呼吸。待机只在下一次小动作、犯困只在下一次哈欠时醒一次，躲边、打盹直接停下。
  // 打字、开心等姿态不受影响（打字的爪子循环靠这个定时器推进）。
  const SOFT_GPU_FPS = 6;
  function calmDelay({ pose, calmFps = {}, soft = false, still = false, t = 0, nextGestureAt = 0, nextYawnAt = 0 }) {
    const resting = pose === 'idle' || pose === 'tired' || pose === 'peek' || pose === 'sleep';
    if (still && resting) {
      const due = pose === 'idle' ? nextGestureAt : pose === 'tired' ? nextYawnAt : 0;
      return due ? Math.max(250, due - t) : null;
    }
    if (soft && resting) return pose === 'sleep' ? null : 1000 / SOFT_GPU_FPS;
    return 1000 / (calmFps[pose] || 20);
  }

  // 合并主进程发来的完整状态（2026-11-23 低开销模式 L3，Codex R1 / Gemini P0-3）：
  // 主进程只在低开销开着时带 lowPower:true，关掉时省略这个字段（默认关闭时消息逐字节不变）；
  // 所以这里每次都按本条消息归一化，省略＝关，同一窗口开→关→开→关都能当场恢复。
  function mergeMainState(prev, next) {
    const incoming = next && typeof next === 'object' ? next : {};
    return { ...(prev || {}), ...incoming, lowPower: incoming.lowPower === true };
  }
  // 低开销与软件渲染一样停掉无限循环的装饰动画（pet.css 的 body.soft-gpu）。
  const decorStill = ({ softGpu = false, lowPower = false } = {}) => softGpu === true || lowPower === true;

  const api = { IDLE_MOVES, SOFT_GPU_FPS, approach, breathStep, calmDelay, decorStill, mergeMainState, clamp, crouchAt, easeInOut, easeOutBack, easeOutCubic, frameRange, gesturePlaylist, hopAt, pendulumStep, pingPong, pivotOffset, playlistFrame, sheetPosition, squashAt, walkGait };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HubPetMotion = api;
})(typeof window !== 'undefined' ? window : globalThis);
