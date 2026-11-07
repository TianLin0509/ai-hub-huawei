'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attentionQueue, nextTarget, summary } = require('../renderer/attention-jump');
const { ATTENTION_NEEDS_INPUT, ATTENTION_REPLY_READY, attentionStateOf } = require('../core/session-attention-state.js');

// 用真实的状态判断函数验证两类状态的字段写法没有猜错。
function sessionWith(state, id, at, extra = {}) {
  const s = { id, kind: 'codeagent', lastMessageTime: at, ...extra };
  if (state === 'input') { s.attentionState = ATTENTION_NEEDS_INPUT; s.status = 'waiting'; }
  if (state === 'ready') { s.attentionState = ATTENTION_REPLY_READY; s.unreadCount = 1; }
  return s;
}

test('只有未读计数（后台答完的真实情况）也算有新结果', () => {
  const queue = attentionQueue([{ id: 'u', kind: 'codeagent', unreadCount: 1, status: 'idle', attentionState: 'none', lastMessageTime: 5 }]);
  assert.deepEqual(queue.map(row => row.session.id), ['u']);
  assert.equal(queue[0].needsInput, false);
});

test('测试夹具的字段确实能被真实状态函数认出来', () => {
  assert.equal(attentionStateOf(sessionWith('input', 'a', 1)), ATTENTION_NEEDS_INPUT);
  assert.equal(attentionStateOf(sessionWith('ready', 'b', 1)), ATTENTION_REPLY_READY);
  assert.notEqual(attentionStateOf({ id: 'c', kind: 'codeagent' }), ATTENTION_NEEDS_INPUT);
});

test('要你回复的排前面，同类里等得最久的先看', () => {
  const queue = attentionQueue([
    sessionWith('ready', 'r-new', 300),
    sessionWith('ready', 'r-old', 100),
    sessionWith('input', 'i-new', 400),
    sessionWith('input', 'i-old', 200),
    { id: 'none', kind: 'codeagent', lastMessageTime: 50 },
  ]);
  assert.deepEqual(queue.map(row => row.session.id), ['i-old', 'i-new', 'r-old', 'r-new']);
  assert.equal(summary(queue), '2 个要你回复，2 个有新结果');
});

test('后台用途和隐藏的会话不算；当前打开的不用再跳', () => {
  const queue = attentionQueue([
    sessionWith('ready', 'assistant', 1, { purpose: 'company-assistant' }),
    sessionWith('ready', 'hidden', 1, { hiddenFromSidebar: true }),
    sessionWith('ready', 'a', 2),
    sessionWith('ready', 'b', 3),
  ]);
  assert.deepEqual(queue.map(row => row.session.id), ['a', 'b']);
  assert.equal(nextTarget(queue, 'a').id, 'b');
  assert.equal(nextTarget(queue, 'x').id, 'a');
  assert.equal(nextTarget([], 'x'), null);
});
