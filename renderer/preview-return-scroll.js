'use strict';
// 预览退出回原位（2026-11-27 同事反馈）：在对话里点开图片、文件或链接预览，关掉后原先一律跳到对话最底下，
// 往上翻着看的那段对话找不回来了。全屏预览会把对话区隐藏（隐藏后滚动位置丢失），关闭时又统一「回到最新」。
// 规则：从对话进入预览的那一刻记下对话的位置（按当时看到的那张卡记，卡片之后长高也对得上）；
// 回到对话时，原本就在底部跟随的照旧跟随，原本往上翻着看的停回那张卡，底部照常显示「回到最新」。
// 预览布局变化时对话区的去留：被全屏预览藏起前要记位置（leave），从藏着变成露出（全屏切分屏）要回原位（shown）。
// 切回带着预览的会话（restoring）沿用最初记的位置，不重记。
function sourceTransition({ wasHidden, hideNow, restoring = false }) {
  if (hideNow && !wasHidden) return restoring ? null : 'leave';
  if (!hideNow && wasHidden) return 'shown';
  return null;
}

function createPreviewReturnScroll() {
  const saved = new Map();
  return {
    // 预览从关闭变为打开时调用；element 是当时显示对话的卡片列表。
    leave(key, element) {
      const follow = element?._cardFollowController;
      if (!key || !follow || !element.clientHeight) { saved.delete(key); return false; }
      saved.set(key, { element, snapshot: follow.capture() });
      return true;
    },
    has: key => saved.has(key),
    forget: key => saved.delete(key),
    // 对话区重新露出（关掉全屏预览，或全屏切回分屏）时调用。返回 true 表示停回了原位置，false 表示照常跟随到最新；
    // 照常跟随时调 onFollow（用来补上「预览期间跑完的长回复停在开头」）。
    back(key, element, { onFollow } = {}) {
      const follow = element?._cardFollowController;
      const entry = saved.get(key);
      saved.delete(key);
      if (!follow) return false;
      const snapshot = entry?.snapshot;
      if (!snapshot || entry.element !== element || snapshot.following) { follow.follow(); onFollow?.(); return false; }
      const anchor = snapshot.anchorId && [...element.children].find(el => el.dataset?.turnId === snapshot.anchorId);
      const top = anchor
        ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - snapshot.anchorOffset
        : snapshot.top;
      follow.holdAt(Math.max(0, top));
      return true;
    },
  };
}

module.exports = { createPreviewReturnScroll, sourceTransition };
