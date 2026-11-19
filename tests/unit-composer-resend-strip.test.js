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

test('点「重发」：先放回失败那条原文，再交给输入框自己的发送函数，提示条收起', () => {
  const calls = [];
  const { strip, retry } = mount({ restoreText: t => calls.push(['restore', t]), resend: () => calls.push(['send']) });
  strip.show({ text: '原文', reason: 'r' });
  retry.click();
  assert.deepEqual(calls, [['restore', '原文'], ['send']]);
  assert.equal(strip.isShown(), false);
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
