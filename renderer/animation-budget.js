'use strict';
// 无限循环动画的预算（2026-10-30）。
// 页面里只要有一个无限循环的 CSS 动画，浏览器就得按屏幕刷新率（本机 119Hz）不停出新画面，
// 动画元素再小也一样：生产实测 4 个运行中小动画让显卡进程 40%→2%、界面进程 80%→9%（暂停前后）。
// 主要的运行中标记已改成静态样式；这里兜住其余几十处（群聊状态、会议录音、未读、更新提示……）
// 和以后新加的：无限动画先动一小会儿当「开始了」的提示，之后取消，元素回到它的静态样式。
// 短时加载转圈多给一些时间，免得刚等几秒就看起来像卡住。
// 调试可设 localStorage['hub.animationBudget'] = 'off' 关掉。

const STATUS_GRACE_MS = 2500;
const LOADER_GRACE_MS = 20000;
// 只用于短时操作（释放内存/磁盘、写作生成、恢复会话、建索引进度条）的转圈。
const LOADER_NAMES = new Set([
  'dr-spin', 'mr-spin', 'wb-spin', 'session-resume-spin', 'session-search-progress-indeterminate',
]);

function isInfinite(animation) {
  try {
    const timing = animation.effect && animation.effect.getTiming ? animation.effect.getTiming() : null;
    return !!timing && timing.iterations === Infinity;
  } catch { return false; }
}

function graceFor(name) { return LOADER_NAMES.has(String(name || '')) ? LOADER_GRACE_MS : STATUS_GRACE_MS; }

function installAnimationBudget({ doc = globalThis.document, setTimer = setTimeout, storage = globalThis.localStorage } = {}) {
  if (!doc || typeof doc.addEventListener !== 'function') return null;
  try { if (storage && storage.getItem('hub.animationBudget') === 'off') return null; } catch {}
  const scheduled = new WeakSet();
  let settled = 0;
  function settle(animation) {
    try {
      if (animation.playState === 'running' || animation.playState === 'paused') { animation.cancel(); settled++; }
    } catch {}
  }
  function onStart(event) {
    const target = event.target;
    if (!target || typeof target.getAnimations !== 'function') return;
    let list = [];
    // 伪元素（::before / ::after）上的动画事件也落在宿主元素上，要连子树一起取。
    try { list = target.getAnimations({ subtree: true }); } catch { return; }
    for (const animation of list) {
      if (animation.animationName !== event.animationName || scheduled.has(animation) || !isInfinite(animation)) continue;
      scheduled.add(animation);
      setTimer(() => settle(animation), graceFor(event.animationName));
    }
  }
  doc.addEventListener('animationstart', onStart, true);
  return { stats: () => ({ settled }), dispose: () => doc.removeEventListener('animationstart', onStart, true) };
}

module.exports = { installAnimationBudget, graceFor, isInfinite, STATUS_GRACE_MS, LOADER_GRACE_MS, LOADER_NAMES };
