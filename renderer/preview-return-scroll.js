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

const SETTLE_FRAMES = 20;

function createPreviewReturnScroll() {
  const saved = new Map();
  const placing = new Map(); // key → 本次回原位的编号；等布局期间被新的进入 / 回来取代就放弃
  return {
    // 预览从关闭变为打开时调用；element 是当时显示对话的卡片列表。
    leave(key, element) {
      const follow = element?._cardFollowController;
      placing.delete(key); // 还在等布局的上一次回原位作废
      if (!key || !follow || !element.clientHeight) { saved.delete(key); return false; }
      saved.set(key, { element, snapshot: follow.capture() });
      return true;
    },
    has: key => saved.has(key),
    forget: key => { placing.delete(key); saved.delete(key); },
    // 对话区重新露出（关掉全屏预览，或全屏切回分屏）时调用。返回 true 表示会停回原位置，false 表示照常跟随到最新；
    // 照常跟随时调 onFollow（用来补上「预览期间跑完的长回复停在开头」）。
    // 关预览的那一拍对话区往往还藏着（赋值会被忽略）、露出后还要一两帧才排好版（输入框后出，高度 790→622）。
    // 给了 requestFrame 就等到对话区可见、且高度连续两帧不变再按锚点卡片对齐；最多等 SETTLE_FRAMES 帧，不持续轮询。
    back(key, element, { onFollow, requestFrame } = {}) {
      const follow = element?._cardFollowController;
      const entry = saved.get(key);
      saved.delete(key);
      const token = (placing.get(key) || 0) + 1;
      placing.set(key, token);
      const snapshot = entry?.snapshot;
      if (!follow || !snapshot || entry.element !== element || snapshot.following) {
        placing.delete(key);
        if (!follow) return false;
        follow.follow(); onFollow?.(); return false;
      }
      const place = () => {
        const anchor = snapshot.anchorId && [...element.children].find(el => el.dataset?.turnId === snapshot.anchorId);
        const top = anchor
          ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - snapshot.anchorOffset
          : snapshot.top;
        follow.holdAt(Math.max(0, top));
      };
      if (!requestFrame) { placing.delete(key); place(); return true; }
      // 等待期间用户切了会话（同一个卡片列表换成别的会话）、滚动 / 翻页 / 点「回到最新」/ 发消息置底（epoch 变了），
      // 就以用户为准放弃。取 back() 当刻的 epoch：预览期间切走再切回后 epoch 已比 leave() 时大，属正常。
      const start = follow.capture();
      if (snapshot.sessionId && start.sessionId !== snapshot.sessionId) { placing.delete(key); return false; }
      let last = -1, frames = 0;
      const tick = () => {
        if (placing.get(key) !== token) return; // 又开了预览、又回来了一次或被 forget，以新的为准
        const now = follow.capture();
        if (now.sessionId !== start.sessionId || now.epoch !== start.epoch) { placing.delete(key); return; }
        const height = element.clientHeight;
        if (height > 0 && (height === last || frames >= SETTLE_FRAMES)) { placing.delete(key); place(); return; }
        if (frames >= SETTLE_FRAMES) { placing.delete(key); return; } // 一直没露出：不动
        last = height; frames++;
        requestFrame(tick);
      };
      requestFrame(tick);
      return true;
    },
  };
}

module.exports = { createPreviewReturnScroll, sourceTransition, SETTLE_FRAMES };
