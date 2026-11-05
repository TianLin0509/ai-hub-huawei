'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCardContentSkip, KEEP_NEWEST } = require('../renderer/card-content-skip');

function makeCard(height = 300.25) {
  const card = { height, dataset: { turnId: 'x' }, style: {}, getBoundingClientRect: () => ({ height: card.height }) };
  return card;
}
function fixture(cards, { connected = true, clientHeight = 800 } = {}) {
  const reads = { order: [] };
  const overlay = { isConnected: connected, clientHeight, querySelectorAll: () => cards };
  const win = { getComputedStyle: () => ({ paddingTop: '10px', paddingBottom: '10px', borderTopWidth: '1px', borderBottomWidth: '1.5px' }) };
  return { skip: createCardContentSkip({ overlay, window: win }), reads };
}

test('最新的卡不跳过，其余按内容区高度写入（减去内边距和边框）', () => {
  const cards = Array.from({ length: KEEP_NEWEST + 3 }, () => makeCard());
  const { skip } = fixture(cards);
  assert.equal(skip.sweep(), 3);
  for (const card of cards.slice(0, 3)) {
    assert.equal(card.style.contentVisibility, 'auto');
    assert.equal(card.style.containIntrinsicSize, '277.75px');
  }
  for (const card of cards.slice(3)) assert.equal(card.style.contentVisibility, undefined);
});

test('已量过的不重量；新卡进来后，退出最新区的卡才进入跳过', () => {
  const cards = Array.from({ length: KEEP_NEWEST + 1 }, () => makeCard());
  const { skip } = fixture(cards);
  assert.equal(skip.sweep(), 1);
  assert.equal(skip.sweep(), 0);
  cards.push(makeCard());
  assert.equal(skip.sweep(), 1);
  assert.equal(cards[1].style.contentVisibility, 'auto');
  assert.equal(cards[2].style.contentVisibility, undefined);
});

test('高度为 0（未显示）不写入，等下一轮重新量', () => {
  const cards = Array.from({ length: KEEP_NEWEST + 1 }, () => makeCard());
  cards[0].height = 0;
  const { skip } = fixture(cards);
  assert.equal(skip.sweep(), 0);
  assert.equal(cards[0].style.contentVisibility, undefined);
  cards[0].height = 200;
  assert.equal(skip.sweep(), 1);
});

test('卡片区隐藏或不在页面上时什么都不做', () => {
  const cards = Array.from({ length: KEEP_NEWEST + 2 }, () => makeCard());
  assert.equal(fixture(cards, { clientHeight: 0 }).skip.sweep(), 0);
  assert.equal(fixture(cards, { connected: false }).skip.sweep(), 0);
  assert.equal(cards[0].style.contentVisibility, undefined);
});

test('读正文时临时取消跳过，读完恢复；回调抛错也恢复；没跳过的卡不被改', () => {
  const skipped = makeCard(), plain = makeCard();
  skipped.style.contentVisibility = 'auto';
  const { skip } = fixture([]);
  const seen = skip.withCardsRendered([skipped, plain, null], () => [skipped.style.contentVisibility, plain.style.contentVisibility]);
  assert.deepEqual(seen, ['visible', undefined]);
  assert.equal(skipped.style.contentVisibility, 'auto');
  assert.equal(plain.style.contentVisibility, undefined);
  assert.throws(() => skip.withCardsRendered([skipped], () => { throw new Error('boom'); }), /boom/);
  assert.equal(skipped.style.contentVisibility, 'auto');
});

test('视口附近的卡完全不用跳过，离开后才用；卡片离开页面后不再跟踪', () => {
  const observers = [];
  class FakeObserver {
    constructor(callback, options) { this.callback = callback; this.options = options; this.seen = new Set(); this.gone = new Set(); observers.push(this); }
    observe(target) { this.seen.add(target); }
    unobserve(target) { this.gone.add(target); this.seen.delete(target); }
  }
  const cards = Array.from({ length: KEEP_NEWEST + 2 }, () => makeCard());
  const overlay = { isConnected: true, clientHeight: 800, querySelectorAll: () => cards };
  const win = { IntersectionObserver: FakeObserver, getComputedStyle: () => ({}) };
  const skip = createCardContentSkip({ overlay, window: win });
  skip.sweep();
  const io = observers[0];
  assert.equal(io.options.root, overlay);
  assert.equal(io.seen.size, 2, '最新的卡不观察');
  cards[0].isConnected = true;
  io.callback([{ target: cards[0], isIntersecting: true }]);
  assert.equal(cards[0].style.contentVisibility, 'visible');
  assert.equal(cards[1].style.contentVisibility, 'auto');
  // 临时取消跳过不影响附近的卡，结束后仍是 visible。
  skip.withCardsRendered([cards[0], cards[1]], () => {});
  assert.equal(cards[0].style.contentVisibility, 'visible');
  assert.equal(cards[1].style.contentVisibility, 'auto');
  // 看着的时候被撑高，离开那一刻量到新高度；一直没靠近过的卡不用重量。
  cards[0].height = 500;
  cards[1].isConnected = true;
  cards[1].height = 999;
  io.callback([{ target: cards[0], isIntersecting: false }, { target: cards[1], isIntersecting: false }]);
  assert.equal(cards[0].style.contentVisibility, 'auto');
  assert.equal(cards[0].style.containIntrinsicSize, '500px');
  assert.equal(cards[1].style.containIntrinsicSize, '300.25px');
  cards[1].isConnected = false;
  io.callback([{ target: cards[1], isIntersecting: false }]);
  assert.ok(io.gone.has(cards[1]));
});
