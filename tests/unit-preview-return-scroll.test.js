'use strict';
// 预览退出回原位（2026-11-27）：对话里点开图片、文件或链接预览，关掉后停回点开前的位置，不再一律跳到最底下。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewReturnScroll } = require('../renderer/preview-return-scroll');
const { createCardFollowScroll } = require('../renderer/card-follow-scroll');

// 卡片从上往下排；scrollTop 变化时卡片屏幕位置跟着变；hide() 模拟全屏预览把对话区隐藏（滚动位置丢失）。
function conversation(heights, clientHeight = 600) {
  const listeners = {};
  const button = { hidden: true, textContent: '', classList: { toggle() {} }, setAttribute() {}, addEventListener: (n, fn) => { listeners[n] = fn; }, remove() {} };
  let shown = true;
  const element = {
    isConnected: true, scrollTop: 0, style: {}, dataset: {}, children: [],
    get clientHeight() { return shown ? clientHeight : 0; },
    get scrollHeight() { return heights.reduce((a, b) => a + b, 0); },
    setAttribute() {}, addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ top: 100, bottom: 100 + clientHeight, right: 1000 }),
  };
  const layout = () => {
    let y = 0;
    element.children = heights.map((h, i) => {
      const at = y; y += h;
      return { dataset: { turnId: 't' + i }, getBoundingClientRect: () => ({ top: 100 + at - element.scrollTop, bottom: 100 + at + h - element.scrollTop }) };
    });
  };
  layout();
  const win = {
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, getComputedStyle: () => ({}),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  const follow = createCardFollowScroll({ element, window: win, document: { addEventListener() {}, removeEventListener() {} }, button });
  follow.activate('s1', { force: true });
  return {
    element, follow, button,
    hide() { shown = false; element.scrollTop = 0; },
    show() { shown = true; },
    grow(i, h) { heights[i] = h; layout(); },
  };
}

test('往上翻着看时点开预览：关掉后停回那张卡，不跳到最底下', () => {
  const c = conversation([400, 400, 400, 400, 400]);
  c.follow.holdAt(820); // 用户往上翻，看第 3 张卡（820 = 第 3 张开头往下 20）
  const back = createPreviewReturnScroll();
  assert.equal(back.leave('session:s1', c.element), true);
  c.hide();
  c.grow(4, 1400); // 预览期间最后一张卡继续变长
  c.show();
  assert.equal(back.back('session:s1', c.element), true);
  assert.equal(c.element.scrollTop, 820);
  assert.equal(c.follow.isFollowing(), false);
  assert.equal(c.button.hidden, false, '底部仍有「回到最新」');
  assert.equal(back.has('session:s1'), false, '用过就清掉');
});

test('前面的卡长高时按当时看的那张卡对齐，而不是按旧像素位置', () => {
  const c = conversation([400, 400, 400, 400, 400]);
  c.follow.holdAt(820);
  const back = createPreviewReturnScroll();
  back.leave('session:s1', c.element);
  c.hide();
  c.grow(0, 600); // 第一张卡展开多了 200
  c.show();
  back.back('session:s1', c.element);
  assert.equal(c.element.scrollTop, 1020);
});

test('原本在底部跟随：关掉预览照旧跟随到最新', () => {
  const c = conversation([400, 400, 400]);
  const back = createPreviewReturnScroll();
  back.leave('session:s1', c.element);
  c.hide(); c.grow(2, 900); c.show();
  assert.equal(back.back('session:s1', c.element), false);
  assert.equal(c.follow.isFollowing(), true);
  assert.equal(c.element.scrollTop, c.element.scrollHeight);
});

test('没记到位置（对话区当时不可见，或回到的已不是同一个列表）时照旧回到最新', () => {
  const c = conversation([400, 400, 400, 400]);
  c.follow.holdAt(300);
  const back = createPreviewReturnScroll();
  c.hide();
  assert.equal(back.leave('session:s1', c.element), false);
  c.show();
  assert.equal(back.back('session:s1', c.element), false);
  assert.equal(c.follow.isFollowing(), true);
  const other = conversation([400, 400, 400, 400]);
  other.follow.holdAt(300);
  back.leave('session:s1', other.element);
  assert.equal(back.back('session:s1', c.element), false);
  assert.equal(back.back('session:s1', null), false, '没有列表也不报错');
});

test('审查 P2-2：关掉预览照常跟随时顺带补上「预览期间跑完的长回复停在开头」；停回原位时不补', () => {
  const back = createPreviewReturnScroll();
  const following = conversation([400, 400, 400]);
  let calls = 0;
  back.leave('session:s1', following.element);
  back.back('session:s1', following.element, { onFollow: () => calls++ });
  assert.equal(calls, 1);
  const reading = conversation([400, 400, 400, 400]);
  reading.follow.holdAt(300);
  back.leave('session:s1', reading.element);
  back.back('session:s1', reading.element, { onFollow: () => calls++ });
  assert.equal(calls, 1);
});

test('审查 P2-3：全屏预览藏起对话前记位置，全屏切分屏露出时回原位；切回带预览的会话不重记；半窗关闭用 forget 不动位置', () => {
  const { sourceTransition } = require('../renderer/preview-return-scroll');
  assert.equal(sourceTransition({ wasHidden: false, hideNow: true }), 'leave', '打开全屏预览 / 分屏切全屏');
  assert.equal(sourceTransition({ wasHidden: true, hideNow: false }), 'shown', '全屏切分屏');
  assert.equal(sourceTransition({ wasHidden: false, hideNow: false }), null, '分屏里换文件');
  assert.equal(sourceTransition({ wasHidden: true, hideNow: true }), null, '全屏里换文件');
  assert.equal(sourceTransition({ wasHidden: false, hideNow: true, restoring: true }), null, '切回带预览的会话沿用旧位置');
  const c = conversation([400, 400, 400, 400, 400]);
  c.follow.holdAt(820);
  const back = createPreviewReturnScroll();
  back.leave('session:s1', c.element);
  c.element.scrollTop = 1500; // 半窗预览时用户又滚到了别处
  back.forget('session:s1');
  assert.equal(back.has('session:s1'), false);
  assert.equal(c.element.scrollTop, 1500);
});
