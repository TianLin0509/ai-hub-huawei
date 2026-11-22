'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attentionQueue, leadMapFrom, nextTarget, summary } = require('../renderer/attention-jump');
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

test('负责人的成员新回复不进待你看，独立会话照算', () => {
  const leads = new Map([['m1', 'lead'], ['m2', 'lead']]);
  const queue = attentionQueue([
    { id: 'lead', title: '负责人', kind: 'codeagent', lastMessageTime: 1 },
    sessionWith('ready', 'm1', 2, { title: 'm1' }),
    sessionWith('ready', 'solo', 3, { title: '零碎' }),
  ], { leadOf: id => leads.get(id) || null });
  assert.deepEqual(queue.map(row => row.session.id), ['solo']);
});

test('成员等你拍板或出错卡住汇总到负责人一条，不漏也不重复', () => {
  const leads = new Map([['m1', 'lead'], ['m2', 'lead'], ['m3', 'lead'], ['m4', 'lead']]);
  const queue = attentionQueue([
    { id: 'lead', title: '负责人', kind: 'codeagent', lastMessageTime: 1 },
    sessionWith('input', 'm1', 2, { title: 'm1' }),
    { id: 'm2', title: 'm2', kind: 'codeagent', lastMessageTime: 3, status: 'idle', connectionIssue: { type: 'stream-disconnected', message: '连接中断' } },
    sessionWith('ready', 'm3', 4, { title: 'm3' }),
    { id: 'm4', title: 'm4', kind: 'codeagent', lastMessageTime: 5, status: 'dormant', connectionIssue: { type: 'stream-disconnected' } },
  ], { leadOf: id => leads.get(id) || null });
  assert.equal(queue.length, 1, JSON.stringify(queue.map(r => r.session.id)));
  assert.equal(queue[0].session.id, 'lead');
  assert.equal(queue[0].needsInput, true);
  assert.ok(queue[0].memberAlerts.some(a => a.session.id === 'm1' && a.reason === '等你拍板'));
  assert.ok(queue[0].memberAlerts.some(a => a.session.id === 'm2' && a.reason === '连接异常'), JSON.stringify(queue[0].memberAlerts.map(a => a.reason)));
  assert.equal(queue[0].memberAlerts.length, 2, '成员 m3 只是有新回复、m4 已休眠，都不进汇总');
  assert.match(summary(queue), /负责人：m1等你拍板、m2连接异常/);
});

test('负责人自己有新回复时只占一条；负责人不在侧栏时成员的拍板退回成员自己', () => {
  const leads = new Map([['m1', 'lead'], ['x1', 'gone']]);
  const queue = attentionQueue([
    sessionWith('ready', 'lead', 1, { title: '负责人' }),
    sessionWith('input', 'm1', 2, { title: 'm1' }),
    sessionWith('input', 'x1', 3, { title: 'x1' }),
  ], { leadOf: id => leads.get(id) || null });
  assert.deepEqual(queue.map(row => row.session.id).sort(), ['lead', 'x1']);
  assert.equal(queue.find(r => r.session.id === 'lead').needsInput, true);
});

test('leadMapFrom：按组队界面算出成员→负责人，没有组队界面时为空', () => {
  const sessions = new Map([['lead', {}], ['m1', {}], ['solo', {}]]);
  const teamUi = { isLead: id => id === 'lead', membersOf: id => (id === 'lead' ? ['m1'] : []) };
  assert.deepEqual([...leadMapFrom(teamUi, sessions, {})], [['m1', 'lead']]);
  assert.equal(leadMapFrom(undefined, sessions, {}).size, 0);
});
