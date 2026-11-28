'use strict';
// 蒸馏自己 › 应用到社区场景（2026-11-28）：没应用时我的桌宠照旧不自己串门、名牌照旧；应用后串门多少按每天发多少条、
// 搬的小道具按关心的领域、气泡用（主进程已过原话闸门的）仿写例句，本机再过一道闸门的假实现。
const test = require('node:test');
const assert = require('node:assert/strict');
const scene = require('../renderer/community-scene');

// 极简假 DOM：够 createScene / createSquare 跑起来，记录气泡文字、搬的东西、名牌和右侧动态。
function fakeDocument() {
  const mk = tag => {
    const kids = new Map();
    const node = { tagName: String(tag).toUpperCase(), style: { setProperty() {} }, dataset: {}, textContent: '', className: '', attrs: {}, children: [], listeners: {}, value: '', defaultValue: '',
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, toggle(c, on) { if (on === undefined ? !this.set.has(c) : on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      setAttribute(k, v) { node.attrs[k] = v; }, getAttribute(k) { return node.attrs[k]; }, addEventListener(t, fn) { (node.listeners[t] ||= []).push(fn); }, removeEventListener() {},
      append(...c) { node.children.push(...c); }, remove() {}, contains: () => false, getBoundingClientRect: () => ({ width: 1000, height: 600 }), get offsetHeight() { return 0; },
      querySelector(sel) { if (!kids.has(sel)) kids.set(sel, mk('div')); return kids.get(sel); }, querySelectorAll: () => [], html: '' };
    Object.defineProperty(node, 'innerHTML', { get: () => node.html, set: v => { node.html = v; } });
    Object.defineProperty(node, 'src', { get: () => node.attrs.src, set: v => { node.attrs.src = v; } });
    node.ownerDocument = { activeElement: null };
    return node;
  };
  return { createElement: mk, activeElement: null };
}

// forTarget(community) 的真实形状：字符串数组；tags 只含勾选的。真实产出的端到端见 unit-self-distill-contract。
const VIEW = { toneText: '短句直给', examples: ['先把结论放前面', '这个我晚上看下'], habits: { dailyMsgs: 105, topics: ['仿真', 'PPT'] }, tags: ['话少直给'] };

function harness(forTarget, t) {
  global.document = fakeDocument();
  global.requestAnimationFrame = fn => fn();
  const host = document.createElement('div');
  const calls = [];
  const on = {};
  const ipcRenderer = { on(n, fn) { (on[n] ||= []).push(fn); }, removeListener(n, fn) { on[n] = (on[n] || []).filter(f => f !== fn); }, invoke: async (name, payload) => { calls.push([name, payload]); if (name === 'self-distill:for-target') return forTarget(payload); return { ok: true }; } };
  const board = { boards: { level: [{ nick: '甲', pet: '01-cat', lv: 3, on: true }, { nick: '乙', pet: '03-penguin', lv: 5, on: true }] }, me: { nick: '测试昵称' } };
  const sq = require('../renderer/community-square').createSquare({ host, ipcRenderer, getBoard: () => board, getCrew: () => ({ nick: '测试昵称', me: { status: 'on', sig: '' } }), toast() {}, goCrew() {} });
  const sceneEl = sq.el.querySelector('[data-slot="scene"]'), panel = sq.el.querySelector('[data-slot="panel"]');
  const pets = () => sceneEl.children.filter(c => c.className === 'cc-pet');
  const mine = () => pets().find(p => p.classList.contains('me'));
  const emit = async n => { for (const fn of on[n] || []) fn({}); for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { sq, calls, panel, mine, emit, on, run: async ms => { for (let i = 0; i < ms / 100; i++) { t.mock.timers.tick(100); await Promise.resolve(); } } };
}

test('纯函数：道具按领域、串门概率按话多话少、气泡原样用主进程检查过的文本、标签取第一个', () => {
  assert.equal(scene.propFor(['仿真']), '🖥');
  assert.equal(scene.propFor(['生活', 'PPT']), '📊');
  assert.equal(scene.propFor([{ text: '仿真' }]), '', '旧的对象形状不读');
  assert.equal(scene.propFor([]), '');
  assert.ok(scene.visitChance(5) < scene.visitChance(100));
  assert.equal(scene.visitChance(100000), 0.12);
  assert.equal(scene.selfPlan(null), null);
  // 主进程给什么就显示什么（它检查的就是这段最终文本）；渲染侧不截短、不去标签（气泡用 textContent，不会变成标签）。
  const plan = scene.selfPlan({ ...VIEW, examples: ['<b>好</b>', 'x'.repeat(80), '', { text: '对象不读' }], tags: ['话少直给', '夜猫子'] });
  assert.deepEqual(plan.bubbles, ['<b>好</b>', 'x'.repeat(80)]);
  assert.equal(plan.tag, '话少直给');
  assert.equal(plan.prop, '🖥');
});

test('读画像：旧主进程没有接口、返回 null 或出错时都当作没应用；兼容直接返回 view 与 { ok, view }', async () => {
  assert.equal(await scene.loadSelfPlan({ invoke: async () => { throw new Error("No handler registered for 'self-distill:for-target'"); } }), null);
  assert.equal(await scene.loadSelfPlan({ invoke: async () => null }), null);
  assert.equal(await scene.loadSelfPlan(null), null);
  assert.equal((await scene.loadSelfPlan({ invoke: async () => VIEW })).prop, '🖥');
  assert.equal((await scene.loadSelfPlan({ invoke: async () => ({ ok: true, view: VIEW }) })).tag, '话少直给');
  assert.equal(await scene.loadSelfPlan({ invoke: async () => ({ ok: true, view: null }) }), null);
});

test('没应用到社区：我的桌宠 5 分钟里一次也不自己串门，名牌只写「我」', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const h = harness(() => null, t);
  h.sq.show(); await h.run(300);
  assert.deepEqual(h.calls.find(c => c[0] === 'self-distill:for-target')[1], { target: 'community' });
  await h.run(5 * 60000);
  assert.doesNotMatch(h.panel.innerHTML, /我的桌宠去找/);
  assert.equal(h.mine().querySelector('small').textContent, '我');
  h.sq.hide();
});

test('应用到社区：我的桌宠按习性出门串门，搬着领域道具，气泡是仿写例句；名牌带勾选的性格标签', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const h = harness(() => VIEW, t);
  const bubbles = new Set(), carried = new Set();
  h.sq.show(); await h.run(300);
  assert.equal(h.mine().querySelector('small').textContent, '我 · 话少直给');
  for (let i = 0; i < 1500; i++) {
    await h.run(200);
    const me = h.mine();
    if (me.querySelector('.cc-bub').textContent) bubbles.add(me.querySelector('.cc-bub').textContent);
    if (me.querySelector('.cc-carry').textContent) carried.add(me.querySelector('.cc-carry').textContent);
  }
  assert.match(h.panel.innerHTML, /我的桌宠去找/);
  assert.ok([...bubbles].some(b => VIEW.examples.includes(b)), '气泡里出现仿写例句：' + [...bubbles].join('|'));
  assert.ok(carried.has('🖥'), '搬着仿真的小服务器');
  h.sq.hide();
});

test('画像改了（self-distill:changed）立刻重读：关掉应用后名牌马上恢复「我」，不等 5 分钟；隐藏时不再监听', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let view = VIEW;
  const h = harness(() => view, t);
  h.sq.show(); await h.run(300);
  assert.equal(h.mine().querySelector('small').textContent, '我 · 话少直给');
  const before = h.calls.filter(c => c[0] === 'self-distill:for-target').length;
  view = null;
  await h.emit('self-distill:changed'); await h.run(100);
  assert.equal(h.calls.filter(c => c[0] === 'self-distill:for-target').length, before + 1);
  assert.equal(h.mine().querySelector('small').textContent, '我');
  h.sq.hide();
  assert.equal((h.on['self-distill:changed'] || []).length, 0);
});
