'use strict';
// 间歇流光（2026-11-05，5.5.9）：「问一下」思考中、卡片视图「工作中」的底边流光每 8 秒扫一遍。
// 为什么不用 infinite：页面里只要有无限动画，整窗就按刷新率（本机 120Hz）不停出帧，实测流光一直开着
// 界面进程约 35% + 显卡进程约 35% 单核，且会被 animation-budget.js 在 2.5 秒后取消（用户看到的「约 5 秒停住」）。
// 为什么用脚本动画（element.animate）而不是 CSS 动画：卡片区每来一张卡都会把「工作中」挪到最新卡片下面，
// 浏览器会让被挪动元素的 CSS 动画从头播——来卡越快越接近一直扫（s6 一审 P2：每秒 1 卡 = 120 帧/秒）。
// 脚本动画挂在一个真实子元素 <i class="hw-sweep-light"> 上（第一次扫时补进去）：挪动既不重播也不打断；
// 不挂在 ::before 上，是因为元素被挪动时浏览器会重建伪元素，动画留在旧伪元素上，光会在半路消失。平时没有任何动画，只有每拍那 2.2 秒。
// 全窗口同一个节拍，几张卡一起扫也只多出同一段帧。系统「减少动效」打开、窗口隐藏时不扫。

const SWEEP_PERIOD_MS = 8000;
const SWEEP_MS = 2200;
const SWEEP_SELECTOR = '.hw-sweep';
const SWEEP_ID = 'hw-sweep';
const SWEEP_FRAMES = [{ transform: 'translateX(-100%)' }, { transform: 'translateX(170%)' }];

const LIGHT = 'hw-sweep-light';
function lightOf(node) {
  let light = node.querySelector(`:scope > .${LIGHT}`);
  if (!light) { light = node.ownerDocument.createElement('i'); light.className = LIGHT; light.setAttribute('aria-hidden', 'true'); node.append(light); }
  return light;
}
function sweeping(node) {
  try { return node.getAnimations({ subtree: true }).some(a => a.id === SWEEP_ID && a.playState === 'running'); } catch { return false; }
}

function installSweepPulse({ doc = globalThis.document, win = globalThis.window, period = SWEEP_PERIOD_MS, setTimer = setInterval } = {}) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;
  const reduce = win && typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let beats = 0;
  function beat() {
    if (doc.hidden || (reduce && reduce.matches)) return;
    const nodes = [...doc.querySelectorAll(SWEEP_SELECTOR)].filter(node => node.isConnected && node.getClientRects().length && typeof node.animate === 'function' && !sweeping(node));
    if (!nodes.length) return;
    beats++;
    for (const node of nodes) {
      try { const a = lightOf(node).animate(SWEEP_FRAMES, { duration: SWEEP_MS, easing: 'linear', iterations: 1 }); a.id = SWEEP_ID; } catch { /* 动画不可用：保持静态底线 */ }
    }
  }
  const timer = setTimer(beat, period);
  return { beat, beats: () => beats, dispose: () => clearInterval(timer) };
}

module.exports = { installSweepPulse, SWEEP_PERIOD_MS, SWEEP_MS, SWEEP_SELECTOR, SWEEP_ID, SWEEP_FRAMES, LIGHT };
