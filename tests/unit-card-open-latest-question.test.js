'use strict';
// 打开会话定位到最新提问（renderer/card-follow-scroll.js）：用假布局验证落点、退化到底、用户手动后不拉回、切换往返、开关关闭。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCardFollowScroll, landingPosition } = require('../renderer/card-follow-scroll');

function harness({ landOn = true, armOnSwitch = true } = {}) {
  const frames = [];
  const listeners = {};
  const element = {
    scrollTop: 0, scrollHeight: 3000, clientHeight: 800, offsetWidth: 800, isConnected: true,
    style: {}, dataset: {}, children: [], parentNode: null, tabIndex: 0,
    setAttribute() {}, addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener() {},
    getBoundingClientRect: () => ({ top: 0, bottom: 800, right: 800 }),
  };
  const card = (top, height) => ({ isConnected: true, offsetHeight: height, getClientRects: () => [1],
    getBoundingClientRect: () => ({ top: top - element.scrollTop }) });
  let target = null;
  let enabled = landOn;
  const win = {
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ overflowY: 'visible' }), getSelection: () => null,
    performance: { now: () => clock.t },
  };
  const clock = { t: 0 };
  const doc = { createElement: () => ({ setAttribute() {}, addEventListener() {}, remove() {}, classList: { toggle() {} } }), addEventListener() {}, removeEventListener() {} };
  const ctl = createCardFollowScroll({ element, window: win, document: doc,
    landingTarget: () => target, landOnOpen: () => enabled, armOnSwitch });
  const flush = () => { while (frames.length) frames.shift()(); };
  return { element, ctl, flush, listeners, clock,
    setTarget: (top, h) => { target = top == null ? null : card(top, h); },
    setEnabled: v => { enabled = v; } };
}

test('落点计算：提问顶到上方留 12px；剩余不足一屏退化到底；超长提问只占半屏', () => {
  assert.deepEqual(landingPosition({ cardTop: 1000, cardHeight: 80, scrollHeight: 3000, clientHeight: 800 }), { top: 988, bottom: false });
  assert.deepEqual(landingPosition({ cardTop: 2500, cardHeight: 80, scrollHeight: 3000, clientHeight: 800 }), { top: 2200, bottom: true });
  assert.deepEqual(landingPosition({ cardTop: 500, cardHeight: 1200, scrollHeight: 4000, clientHeight: 800 }), { top: 1300, bottom: false });
  assert.deepEqual(landingPosition({ cardTop: 5, cardHeight: 40, scrollHeight: 3000, clientHeight: 800 }), { top: 0, bottom: false });
});

test('长回答：打开会话后提问在最上方，不再跟随到底，「回到最新」可用', () => {
  const h = harness();
  h.ctl.activate('a');
  const snap = h.ctl.capture();
  h.setTarget(1000, 80);
  h.ctl.restore(snap); h.flush();
  assert.equal(h.element.scrollTop, 988);
  assert.equal(h.ctl.isFollowing(), false);
  // 排版稳定期内上方卡片变高（公式、图片晚渲染），重新对齐提问。
  h.setTarget(1100, 80); h.ctl.request(); h.flush();
  assert.equal(h.element.scrollTop, 1088);
  // 稳定期过后，内容变化不再改位置（交给浏览器滚动锚定）。
  h.clock.t = 5000; h.setTarget(1200, 80); h.ctl.request(); h.flush();
  assert.equal(h.element.scrollTop, 1088);
});

test('短回答、或最新提问还没回答：停在最底下并继续跟随流式输出', () => {
  const h = harness();
  h.ctl.activate('a');
  const snap = h.ctl.capture();
  h.setTarget(2600, 80);
  h.ctl.restore(snap); h.flush();
  assert.equal(h.element.scrollTop, 3000);
  assert.equal(h.ctl.isFollowing(), true);
  h.clock.t = 5000; h.element.scrollHeight = 3400; h.ctl.request(); h.flush();
  assert.equal(h.element.scrollTop, 3400, '稳定期过后仍按跟随贴底');
});

test('用户刚动滚轮就取消定位，之后不再被拉回', () => {
  const h = harness();
  h.ctl.activate('a');
  const snap = h.ctl.capture();
  h.setTarget(1000, 80);
  h.ctl.restore(snap); h.flush();
  h.listeners.wheel({ deltaY: -100, target: null });
  h.element.scrollTop = 600;
  h.setTarget(1100, 80); h.ctl.request(); h.flush();
  assert.equal(h.element.scrollTop, 600);
});

test('最新提问还没加载出来：先停在最底下并报告缺卡，找到后补定位；放弃后照旧跟随', () => {
  const h = harness();
  h.ctl.activate('a');
  h.ctl.restore(h.ctl.capture()); h.flush();
  assert.equal(h.element.scrollTop, 3000);
  assert.equal(h.ctl.landingMissing(), true);
  h.setTarget(900, 60);
  h.ctl.restore(h.ctl.capture()); h.flush();
  assert.equal(h.element.scrollTop, 888);
  assert.equal(h.ctl.landingMissing(), false);
  const g = harness();
  g.ctl.activate('b'); g.ctl.restore(g.ctl.capture()); g.flush();
  g.ctl.giveUpLanding(); g.flush();
  assert.equal(g.ctl.landingMissing(), false);
  assert.equal(g.ctl.isFollowing(), true);
});

test('切换往返：自己翻到的位置保留；停在定位处或最新处的会话重新定位', () => {
  const h = harness();
  h.ctl.activate('a'); h.setTarget(1000, 80); h.ctl.restore(h.ctl.capture()); h.flush();
  assert.equal(h.element.scrollTop, 988);
  h.ctl.activate('b'); h.setTarget(500, 80); h.ctl.restore(h.ctl.capture()); h.flush();
  assert.equal(h.element.scrollTop, 488);
  h.ctl.pause(); h.element.scrollTop = 120; // 用户在 b 里往上翻
  h.ctl.activate('a'); h.setTarget(1000, 80); h.ctl.restore(h.ctl.capture()); h.flush();
  assert.equal(h.element.scrollTop, 988, 'a 未被动过：重新定位到最新提问');
  h.ctl.activate('b'); h.setTarget(500, 80); const snap = h.ctl.capture(); h.ctl.restore(snap); h.flush();
  assert.equal(h.ctl.isFollowing(), false);
  assert.equal(h.element.scrollTop, 120, 'b 是用户自己翻到的位置：原样保留');
});

test('开关关闭：打开会话照旧滚到底；显式「看最新」也是到底', () => {
  const h = harness({ landOn: false });
  h.setTarget(1000, 80);
  h.ctl.activate('a'); h.ctl.restore(h.ctl.capture()); h.flush();
  assert.equal(h.element.scrollTop, 3000);
  assert.equal(h.ctl.isFollowing(), true);
  h.ctl.openLatest(); h.flush();
  assert.equal(h.element.scrollTop, 3000);
});

test('显式「看最新」（侧栏再次点击、通知跳转）：开关开着时定位到最新提问', () => {
  const h = harness();
  h.ctl.activate('a'); h.ctl.pause(); h.element.scrollTop = 50;
  h.setTarget(1000, 80);
  h.ctl.activate('a', { force: true }); h.flush();
  assert.equal(h.element.scrollTop, 988);
});

test('短回答退化为贴底后，1.5 秒内流式输出变长也继续跟随，不拉回提问处（审查 P1）', () => {
  const h = harness();
  h.ctl.activate('a'); h.setTarget(2600, 80); h.ctl.restore(h.ctl.capture()); h.flush();
  assert.equal(h.ctl.isFollowing(), true);
  h.clock.t = 500; h.element.scrollHeight = 5000; h.ctl.request(); h.flush();
  assert.equal(h.ctl.isFollowing(), true);
  assert.equal(h.element.scrollTop, 5000);
});

test('延后定位：卡片重新加载前不在旧卡上定位，挂好新卡（restore）后才定位', () => {
  const h = harness();
  h.ctl.activate('a'); h.ctl.restore(h.ctl.capture()); h.flush();
  h.setTarget(400, 80); // 旧卡上的提问
  h.ctl.openLatest({ defer: true }); h.ctl.request(); h.flush();
  assert.notEqual(h.element.scrollTop, 388, '加载完成前不定位');
  h.setTarget(1000, 80); // 新卡挂好后的最新提问
  h.ctl.restore(h.ctl.capture()); h.flush();
  assert.equal(h.element.scrollTop, 988);
});

test('等不到提问超过 8 秒就放弃，照常跟随', () => {
  const h = harness();
  h.ctl.activate('a'); h.ctl.restore(h.ctl.capture()); h.flush();
  assert.equal(h.ctl.landingMissing(), true);
  h.clock.t = 9000;
  assert.equal(h.ctl.landingMissing(), false);
  h.setTarget(1000, 80); h.ctl.restore(h.ctl.capture()); h.flush();
  assert.equal(h.element.scrollTop, 3000, '过期后新出现的提问不再触发定位');
});

test('群聊（armOnSwitch=false）：重绘新建控制器不定位，只有显式打开才定位', () => {
  const h = harness({ armOnSwitch: false });
  h.setTarget(1000, 80);
  h.ctl.activate('g'); h.ctl.pause(); h.element.scrollTop = 300; h.ctl.restore({ ...h.ctl.capture(), top: 300 }); h.flush();
  assert.equal(h.element.scrollTop, 300);
  h.ctl.openLatest(); h.flush();
  assert.equal(h.element.scrollTop, 988);
});
