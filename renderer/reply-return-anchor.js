'use strict';
// 长回复回来看（2026-11-27 同事反馈）：CodeAgent 跑得慢，人走开干别的，回来时回复已经超过一屏，
// 原先停在最底下，要自己往上翻找这条回复从哪开始。
// 规则：一轮回复结束时用户没在看这个会话（会话不在前台，或窗口失焦 / 最小化），就记下来；
// 下次真正看到这个会话（切回会话，或窗口重新获得焦点）时，若这条回复超过一屏，停在回复开头，
// 底部按钮改成「跳到最新」。用户正在看的会话不记，保持原来的跟随滚动。
// 只记会话编号，回来时现找「最后一条用户消息之后的第一张卡」，不依赖某张卡的编号是否已换成正式编号。
const JUMP_LABEL = '↓ 跳到最新';

function replyStartCard(element) {
  const cards = [...element.querySelectorAll(':scope > .turn-card')].filter(card => !card.hidden);
  let i = cards.length - 1;
  while (i >= 0 && !cards[i].classList.contains('user')) i--;
  return cards[i + 1] || null;
}

// 用户此刻是否真的看着这个会话的卡片：会话在前台、卡片视图、窗口有焦点且没最小化，
// 并且对话区没被全屏预览遮住、也没切到首页或「助理 / 团队 / 分身」等顶层页面（这些页面下 activeSessionId 仍是原会话）。
function isSessionInView(id, v) {
  return !!id && id === v.activeSessionId && v.currentView === 'card' && v.hasFocus && !v.hidden
    && !v.homeActive && v.conversationVisible && !v.appToolbarView;
}

function createReplyReturnAnchor({ element, follow, isViewing }) {
  const pending = new Set();
  return {
    // 回复结束时调用：没在看就记下，在看就清掉旧记录（人已经看到了）。
    replyFinished(sessionId) {
      if (!sessionId) return;
      if (isViewing(sessionId)) pending.delete(sessionId); else pending.add(sessionId);
    },
    has: sessionId => pending.has(sessionId),
    forget: sessionId => pending.delete(sessionId),
    // 对话区刚重新露出（如关掉全屏预览）时卡片可能晚几帧才排好版：没生效且记录还在，就在接下来几帧里再试，最多 tries 帧。
    applySoon(sessionId, requestFrame, tries = 30) {
      if (this.apply(sessionId) || !pending.has(sessionId) || tries <= 0) return;
      requestFrame(() => this.applySoon(sessionId, requestFrame, tries - 1));
    },
    // 卡片挂好、或窗口重新获得焦点时调用。只在用户此刻确实看着这个会话时生效，生效一次就清掉。
    apply(sessionId) {
      if (!pending.has(sessionId) || !isViewing(sessionId)) return false;
      const start = replyStartCard(element);
      if (!start || !element.clientHeight) return false;
      pending.delete(sessionId);
      // 用户回来前已经往上翻着看别的内容（不在跟随）：不把人拉走。切会话会先回到跟随，不受影响。
      if (typeof follow.isFollowing === 'function' && !follow.isFollowing()) return false;
      const top = start.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
      // 一屏放得下就照常停在最新，整条回复本来就都看得见。
      if (element.scrollHeight - top <= element.clientHeight) return false;
      follow.holdAt(Math.max(0, top - 8), JUMP_LABEL);
      return true;
    },
  };
}

module.exports = { createReplyReturnAnchor, replyStartCard, isSessionInView, JUMP_LABEL };
