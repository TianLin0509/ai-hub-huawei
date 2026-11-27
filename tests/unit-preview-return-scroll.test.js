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

// 像浏览器一样：对话区藏着时（高度 0）写 scrollTop 被忽略，原值保留；露出后高度要过一两帧才稳定。
function browserLike(c) {
  let height = 600, top = c.element.scrollTop;
  Object.defineProperty(c.element, 'clientHeight', { get: () => height, configurable: true });
  Object.defineProperty(c.element, 'scrollTop', { get: () => top, set: v => { if (height > 0) top = v; }, configurable: true });
  return { setHeight: h => { height = h; } };
}

test('R54 后续：关预览那一拍对话区还藏着，等露出且高度稳定后再按锚点对齐；预览期间前面卡片长高也对得上', () => {
  const c = conversation([400, 400, 400, 400, 400]);
  const view = browserLike(c);
  c.follow.holdAt(820); // 看第 3 张卡（开头往下 20）
  const back = createPreviewReturnScroll();
  back.leave('session:s1', c.element);
  view.setHeight(0); // 全屏预览把对话区藏起
  c.grow(0, 700); // 预览期间第一张卡长高 300
  const frames = [];
  assert.equal(back.back('session:s1', c.element, { requestFrame: fn => frames.push(fn) }), true);
  assert.equal(c.element.scrollTop, 820, '这一拍还藏着，不动');
  view.setHeight(790); frames.shift()(); // 揭开，输入框还没出
  view.setHeight(622); frames.shift()(); // 输入框出来，高度变了
  assert.equal(frames.length, 1, '高度还在变，继续等');
  frames.shift()(); // 连续两帧 622：稳定
  assert.equal(frames.length, 0);
  assert.equal(c.element.scrollTop, 1120, '按当时看的那张卡对齐（820 + 前面长高的 300）');
  assert.equal(c.follow.isFollowing(), false);
});

test('R54 后续：等布局期间又打开预览，上一次回原位作废；一直没露出最多等 SETTLE_FRAMES 帧、不动位置', () => {
  const { SETTLE_FRAMES } = require('../renderer/preview-return-scroll');
  const c = conversation([400, 400, 400, 400, 400]);
  const view = browserLike(c);
  c.follow.holdAt(820);
  const back = createPreviewReturnScroll();
  back.leave('session:s1', c.element);
  view.setHeight(0);
  const frames = [];
  back.back('session:s1', c.element, { requestFrame: fn => frames.push(fn) });
  view.setHeight(600);
  back.leave('session:s1', c.element); // 又点开了预览
  c.element.scrollTop = 50;
  while (frames.length) frames.shift()();
  assert.equal(c.element.scrollTop, 50, '作废的回原位不再改位置');
  view.setHeight(0);
  back.back('session:s1', c.element, { requestFrame: fn => frames.push(fn) });
  let count = 0;
  while (frames.length) { count++; frames.shift()(); }
  assert.equal(count, SETTLE_FRAMES + 1);
  assert.equal(c.element.scrollTop, 50);
});

test('审查 P2：等布局期间用户滚动 / 点回到最新、切到别的会话、或 forget，到期都不再抢位置', () => {
  const run = interrupt => {
    const c = conversation([400, 400, 400, 400, 400]);
    const view = browserLike(c);
    c.follow.holdAt(820);
    const back = createPreviewReturnScroll();
    back.leave('session:s1', c.element);
    view.setHeight(0);
    c.grow(0, 700);
    const frames = [];
    back.back('session:s1', c.element, { requestFrame: fn => frames.push(fn) });
    view.setHeight(622);
    frames.shift()(); // 露出第一帧，还在等稳定
    interrupt(c, back);
    const at = c.element.scrollTop;
    while (frames.length) frames.shift()();
    return { at, now: c.element.scrollTop };
  };
  const scrolled = run(c => { c.follow.pause(); c.element.scrollTop = 300; }); // 用户往上翻
  assert.equal(scrolled.now, 300, '用户滚动后不再改位置');
  const latest = run(c => c.follow.follow()); // 点「回到最新」/ 发消息置底
  assert.equal(latest.now, latest.at, '回到最新后不被拉回旧位置');
  const switched = run(c => { c.follow.activate('s2'); c.element.scrollTop = 0; }); // 切到会话 B
  assert.equal(switched.now, 0, '不把会话 A 的位置套到会话 B 上');
  const forgot = run((c, back) => back.forget('session:s1')); // 全屏切分屏后立刻关掉
  assert.equal(forgot.now, forgot.at, 'forget 后不再对齐');
});
