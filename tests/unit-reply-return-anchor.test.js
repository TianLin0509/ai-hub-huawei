'use strict';
// 长回复回来看（2026-11-27）：没在看时跑完的长回复，切回来停在回复开头；正在看的会话照常跟随。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReplyReturnAnchor, replyStartCard, JUMP_LABEL } = require('../renderer/reply-return-anchor');
const { createCardFollowScroll } = require('../renderer/card-follow-scroll');

// 卡片按高度从上往下排；scrollTop 改变时卡片的屏幕位置跟着变。
function overlay(cards, clientHeight = 600) {
  const el = {
    clientHeight, scrollTop: 0, children: [],
    get scrollHeight() { return cards.reduce((sum, c) => sum + c.h, 0); },
    getBoundingClientRect: () => ({ top: 100, bottom: 100 + clientHeight, right: 1000 }),
    querySelectorAll: () => el.children,
  };
  let y = 0;
  el.children = cards.map(({ role, h }) => {
    const at = y; y += h;
    return { hidden: false, dataset: {}, classList: { contains: c => c === role }, getBoundingClientRect: () => ({ top: 100 + at - el.scrollTop, bottom: 100 + at + h - el.scrollTop }) };
  });
  return el;
}
function followStub() {
  const calls = [];
  return { calls, holdAt: (top, label) => calls.push({ top, label }) };
}
const longReply = [{ role: 'user', h: 300 }, { role: 'user', h: 80 }, { role: 'assistant', h: 500 }, { role: 'assistant', h: 900 }];

test('回复开头 = 最后一条用户消息之后的第一张卡；没有用户消息时取第一张', () => {
  const el = overlay(longReply);
  assert.equal(replyStartCard(el), el.children[2]);
  const noUser = overlay([{ role: 'assistant', h: 100 }, { role: 'assistant', h: 100 }]);
  assert.equal(replyStartCard(noUser), noUser.children[0]);
  assert.equal(replyStartCard(overlay([{ role: 'user', h: 100 }])), null, '用户消息还没回复时没有开头');
});

test('没在看时跑完的长回复：切回来停在回复开头，按钮写「跳到最新」，只生效一次', () => {
  const el = overlay(longReply), follow = followStub();
  let viewing = false;
  const anchor = createReplyReturnAnchor({ element: el, follow, isViewing: () => viewing });
  anchor.replyFinished('s1');
  assert.equal(anchor.apply('s1'), false, '用户还没回来，不动');
  viewing = true;
  el.scrollTop = el.scrollHeight - el.clientHeight; // 原先跟随在底部
  assert.equal(anchor.apply('s1'), true);
  assert.deepEqual(follow.calls, [{ top: 380 - 8, label: JUMP_LABEL }]);
  assert.equal(anchor.apply('s1'), false, '只在回来的那一次定位');
  assert.equal(follow.calls.length, 1);
});

test('正在看的会话跑完不记，保持跟随；一屏放得下的回复照常停在最新', () => {
  const el = overlay(longReply), follow = followStub();
  const anchor = createReplyReturnAnchor({ element: el, follow, isViewing: () => true });
  anchor.replyFinished('s1');
  assert.equal(anchor.has('s1'), false);
  assert.equal(anchor.apply('s1'), false);
  let viewing = false;
  const short = overlay([{ role: 'user', h: 900 }, { role: 'assistant', h: 400 }]);
  const a2 = createReplyReturnAnchor({ element: short, follow, isViewing: () => viewing });
  a2.replyFinished('s2'); viewing = true;
  assert.equal(a2.apply('s2'), false);
  assert.equal(a2.has('s2'), false, '短回复看过就清掉');
  assert.equal(follow.calls.length, 0);
});

test('卡片还没挂好（视图隐藏或没卡）时保留记录，等挂好再定位；别的会话的记录互不影响', () => {
  const el = overlay([], 0), follow = followStub();
  let viewing = false;
  const anchor = createReplyReturnAnchor({ element: el, follow, isViewing: () => viewing });
  anchor.replyFinished('s1'); anchor.replyFinished('s2'); viewing = true;
  assert.equal(anchor.apply('s1'), false);
  assert.equal(anchor.has('s1'), true);
  assert.equal(anchor.has('s2'), true);
});

test('跟随控制器 holdAt：停止跟随、停在指定位置、按钮显示说明；点按钮回到最新后说明还原', () => {
  const listeners = {};
  const button = { hidden: true, textContent: '', classList: { toggle() {} }, setAttribute() {}, addEventListener: (n, fn) => { listeners[n] = fn; }, remove() {} };
  const element = {
    isConnected: true, clientHeight: 600, scrollHeight: 3000, scrollTop: 0, style: {}, children: [], dataset: {},
    setAttribute() {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ top: 0, right: 1000 }),
  };
  const win = {
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, getComputedStyle: () => ({}),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  const doc = { addEventListener() {}, removeEventListener() {}, createElement: () => button };
  const follow = createCardFollowScroll({ element, window: win, document: doc, button });
  follow.activate('s1', { force: true });
  assert.equal(follow.isFollowing(), true);
  follow.holdAt(372, JUMP_LABEL);
  assert.equal(follow.isFollowing(), false);
  assert.equal(element.scrollTop, 372);
  assert.equal(button.textContent, JUMP_LABEL);
  assert.equal(button.hidden, false, '底部提示可见');
  listeners.click();
  assert.equal(follow.isFollowing(), true);
  assert.equal(element.scrollTop, 3000);
  assert.equal(button.textContent, '↓ 回到最新');
});

test('审查 P2-1：回来前用户已往上翻着看别的内容（不在跟随），不把人拉到回复开头，记录清掉', () => {
  const el = overlay(longReply), follow = { ...followStub(), isFollowing: () => false };
  follow.calls = [];
  follow.holdAt = (top, label) => follow.calls.push({ top, label });
  let viewing = false;
  const anchor = createReplyReturnAnchor({ element: el, follow, isViewing: () => viewing });
  anchor.replyFinished('s1');
  viewing = true;
  el.scrollTop = 120; // 用户停在上面的旧卡片
  assert.equal(anchor.apply('s1'), false);
  assert.equal(el.scrollTop, 120);
  assert.equal(follow.calls.length, 0);
  assert.equal(anchor.has('s1'), false);
});

test('审查 P2-2：对话区被全屏预览遮住、或切到助理 / 团队 / 分身等页面时，不算在看这个会话', () => {
  const { isSessionInView } = require('../renderer/reply-return-anchor');
  const seen = { activeSessionId: 's1', currentView: 'card', hasFocus: true, hidden: false, homeActive: false, conversationVisible: true, appToolbarView: null };
  assert.equal(isSessionInView('s1', seen), true);
  assert.equal(isSessionInView('s1', { ...seen, conversationVisible: false }), false, '全屏预览盖住了对话区');
  assert.equal(isSessionInView('s1', { ...seen, appToolbarView: '助理' }), false, '切到了助理页');
  assert.equal(isSessionInView('s1', { ...seen, homeActive: true }), false);
  assert.equal(isSessionInView('s1', { ...seen, hasFocus: false }), false);
  assert.equal(isSessionInView('s2', seen), false);
});

test('审查 P2-2：关掉全屏预览时卡片晚几帧才排好版，applySoon 在后续帧里补上停在开头；一直没排好最多试 tries 帧', () => {
  const el = overlay(longReply);
  let ch = 0;
  Object.defineProperty(el, 'clientHeight', { get: () => ch });
  const follow = followStub();
  let viewing = false;
  const anchor = createReplyReturnAnchor({ element: el, follow, isViewing: () => viewing });
  anchor.replyFinished('s1');
  viewing = true;
  const frames = [];
  anchor.applySoon('s1', fn => frames.push(fn));
  assert.equal(follow.calls.length, 0, '这一刻对话区还没排好版');
  assert.equal(frames.length, 1, '排到下一帧再试');
  frames.shift()();
  ch = 600; // 第二帧排好
  frames.shift()();
  assert.equal(follow.calls.length, 1);
  assert.equal(anchor.has('s1'), false);
  assert.equal(frames.length, 0, '生效后不再排帧');
  let away = true;
  const never = createReplyReturnAnchor({ element: overlay([], 0), follow, isViewing: () => !away });
  never.replyFinished('s9'); away = false;
  const queue = [];
  never.applySoon('s9', fn => queue.push(fn), 3);
  while (queue.length) queue.shift()();
  assert.equal(never.has('s9'), true, '一直不可见：最多试 3 帧，记录保留给下次');
});
