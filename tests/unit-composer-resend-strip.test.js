'use strict';
// 发送失败「重发」条（renderer/composer-resend-strip.js，体验 6）。用最小的假 DOM 验证行为。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResendStrip } = require('../renderer/composer-resend-strip');

function fakeDoc() {
  const make = (tag) => ({
    tagName: tag, children: [], dataset: {}, hidden: false, textContent: '', attrs: {}, listeners: {},
    append(...kids) { this.children.push(...kids); },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    click() { for (const fn of this.listeners.click || []) fn({}); },
  });
  return { createElement: make };
}

function mount(opts) {
  const doc = fakeDoc();
  const host = doc.createElement('div');
  const strip = createResendStrip(doc, host, opts);
  const [msg, retry, close] = strip.element.children;
  return { host, strip, msg, retry, close };
}

test('明确没发出：显示原因和「重发」，默认隐藏', () => {
  const { strip, msg, retry, host } = mount({});
  assert.equal(host.children[0], strip.element);
  assert.equal(strip.isShown(), false);
  strip.show({ text: '帮我看看日志', reason: 'CLI 暂时不能接收输入' });
  assert.equal(strip.isShown(), true);
  assert.match(msg.textContent, /消息没发出去：CLI 暂时不能接收输入/);
  assert.equal(retry.textContent, '重发');
  assert.equal(strip.element.dataset.kind, 'not-sent');
});

test('送达未知：先提醒核对终端，按钮写「确认没收到，重发」', () => {
  const { strip, msg, retry } = mount({});
  strip.show({ text: 'x', reason: '发送通道异常', uncertain: true });
  assert.match(msg.textContent, /可能没送到/);
  assert.match(msg.textContent, /终端/);
  assert.equal(retry.textContent, '确认没收到，重发');
  assert.equal(strip.element.dataset.kind, 'uncertain');
});

test('点「重发」：把失败那条原文交给输入框的发送函数（由它决定放回还是直接发），提示条收起', () => {
  const calls = [];
  const { strip, retry } = mount({ resend: (t) => calls.push(['send', t]) });
  strip.show({ text: '原文', reason: 'r' });
  retry.click();
  assert.deepEqual(calls, [['send', '原文']]);
  assert.equal(strip.isShown(), false);
});

// rsi-q 返工 1：输入框里是用户新写的草稿时，提示不能说「已放回输入框」，重发也不能先把草稿换掉。
test('原文不在输入框里（用户在写新内容）：提示说原文在提示条里、点按钮直接发；在输入框里才说已放回', () => {
  let draft = '我在写别的';
  const calls = [];
  const { strip, msg, retry } = mount({ inputHas: t => draft === t, resend: t => calls.push(t) });
  strip.show({ text: '排队那条', reason: 'r', uncertain: true });
  assert.match(msg.textContent, /原文保存在这条提示里/);
  assert.doesNotMatch(msg.textContent, /已放回输入框/);
  draft = '排队那条';
  strip.refresh();
  assert.match(msg.textContent, /原文已放回输入框/);
  draft = '我在写别的';
  retry.click();
  assert.deepEqual(calls, ['排队那条']);
  assert.equal(draft, '我在写别的', '草稿没被动过');
});

// rsi-q 返工 2：同一会话先后两条没发出，后一条不能顶掉前一条。
test('同会话连着两条：都留着，先显示早的一条并注明还有几条，逐条重发；关掉一条不影响另一条', () => {
  const store = new Map();
  const sent = [];
  const first = mount({ store, key: 's1', resend: t => sent.push(t) });
  first.strip.show({ text: 'A', reason: 'r', submissionId: 'a' });
  first.strip.show({ text: 'B', reason: 'r', submissionId: 'b' });
  assert.equal(first.strip.count(), 2);
  assert.match(first.msg.textContent, /还有 1 条待处理/);
  assert.equal(store.get('s1').length, 2);
  // 输入框重建后两条都在
  const again = mount({ store, key: 's1', resend: t => sent.push(t) });
  assert.equal(again.strip.count(), 2);
  again.retry.click();
  assert.deepEqual(sent, ['A']);
  assert.equal(again.strip.count(), 1);
  assert.equal(again.strip.isShown(), true);
  again.close.click();
  assert.equal(again.strip.isShown(), false);
  assert.equal(store.has('s1'), false);
});

test('后台会话追加待重发、回执只撤对应那条', () => {
  const { rememberPending, forgetConfirmed } = require('../renderer/composer-resend-strip');
  const store = new Map();
  rememberPending(store, 's1', { text: 'A', submissionId: 'a' });
  rememberPending(store, 's1', { text: 'B', submissionId: 'b' });
  assert.deepEqual(store.get('s1').map(e => e.text), ['A', 'B']);
  forgetConfirmed(store, 's1', 'a');
  assert.deepEqual(store.get('s1').map(e => e.text), ['B']);
});

test('同文不同提交 ID：手动发送只撤一条；重发按钮走发送闭环也不能误撤下一条', () => {
  const store = new Map();
  let strip;
  const mounted = mount({ store, key: 's1', resend: text => strip.forgetText(text) });
  strip = mounted.strip;
  for (const id of ['a', 'b', 'c']) strip.show({ text: 'same', submissionId: id });
  strip.forgetText('same');
  assert.deepEqual(store.get('s1').map(x => x.submissionId), ['b', 'c']);
  mounted.retry.click();
  assert.deepEqual(store.get('s1').map(x => x.submissionId), ['c']);
  assert.equal(mount({ store, key: 's1' }).strip.count(), 1);
});

test('关闭只收起提示，不发送', () => {
  let sent = 0;
  const { strip, close } = mount({ resend: () => { sent += 1; } });
  strip.show({ text: '原文', reason: 'r' });
  close.click();
  assert.equal(strip.isShown(), false);
  assert.equal(sent, 0);
});

test('空原文不显示（没有可重发的内容）', () => {
  const { strip } = mount({});
  strip.show({ text: '   ', reason: 'r' });
  assert.equal(strip.isShown(), false);
});

test('按会话记住：输入框重建（切换会话再回来）后提示条照样在；关掉后不再恢复', () => {
  const store = new Map();
  const first = mount({ store, key: 's1' });
  first.strip.show({ text: '原文', reason: 'r', submissionId: 'a1' });
  const again = mount({ store, key: 's1' });
  assert.equal(again.strip.isShown(), true);
  assert.match(again.msg.textContent, /消息没发出去/);
  assert.equal(mount({ store, key: 's2' }).strip.isShown(), false);
  again.close.click();
  assert.equal(mount({ store, key: 's1' }).strip.isShown(), false);
});

test('送达未知的那条后来收到确认回执：提示条收起；别的回执不影响', () => {
  const store = new Map();
  const { strip } = mount({ store, key: 's1' });
  strip.show({ text: '原文', reason: 'r', uncertain: true, submissionId: 'a1' });
  strip.clearIfSubmission('other');
  assert.equal(strip.isShown(), true);
  strip.clearIfSubmission('a1');
  assert.equal(strip.isShown(), false);
  assert.equal(store.has('s1'), false);
});

test('会话在后台时收到确认回执：记住的那条也清掉', () => {
  const { forgetConfirmed } = require('../renderer/composer-resend-strip');
  const store = new Map([['s1', { text: 't', submissionId: 'a1' }]]);
  forgetConfirmed(store, 's1', 'zz');
  assert.equal(store.has('s1'), true);
  forgetConfirmed(store, 's1', 'a1');
  assert.equal(store.has('s1'), false);
});
