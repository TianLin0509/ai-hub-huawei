'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _parseGroupTargets: parse } = require('../main/groupchat/dispatcher');

const members = [
  { sid: 'a', index: 0, memberId: 'm1', displayName: 'CodeAgent 1', kind: 'codeagent', model: 'GLM-5.2-WX-Auto', aliases: ['m1'] },
  { sid: 'b', index: 1, memberId: 'm2', displayName: 'CodeAgent 2', kind: 'codeagent', model: 'DeepSeek-V4.1-Flash-1017', aliases: ['m2'] },
  { sid: 'c', index: 2, memberId: 'm12', displayName: 'CodeAgent 12', kind: 'codeagent', model: 'MiniMax-M2.7', aliases: ['m12'] },
];
const targets = text => parse(text, members, [0, 1, 2]).targets.map(x => x.sid).join(',');

test('@ 后面不留空格直接写中文，也只发给被点名的成员', () => {
  assert.equal(targets('@m1帮我看下这个方案'), 'a');
  assert.equal(targets('@m2 帮我看下'), 'b');
  assert.equal(targets('请 @m2看一下，@m1也看一下'), 'b,a');
  assert.equal(targets('@m12帮我看下'), 'c', '长名字优先，不被 m1 截胡');
});

test('可以用「成员1」和模型名点名', () => {
  assert.equal(targets('@成员1 看一下'), 'a');
  assert.equal(targets('@成员2看一下'), 'b');
  assert.equal(targets('@GLM-5.2-WX-Auto 看一下'), 'a');
  assert.equal(targets('@deepseek-v4.1-flash-1017看一下'), 'b');
});

test('@全部 和 @all 发给所有人，写法连着中文也算', () => {
  assert.equal(targets('@all 看一下'), 'a,b,c');
  assert.equal(targets('@全部看一下'), 'a,b,c');
  assert.equal(targets('@所有人看一下'), 'a,b,c');
});

test('不是成员的 @ 不算点名，按勾选的成员发', () => {
  assert.equal(targets('发邮件给 foo@example.com'), 'a,b,c');
  assert.equal(targets('@张三帮我看下'), 'a,b,c');
  assert.equal(targets('@m123 看一下'), 'a,b,c', '多一位数字不是 m12 也不是 m1');
  assert.equal(targets('@codeagent 看一下'), 'a,b,c', '三个成员同类型时分不出是谁');
});

test('句末标点不影响点名', () => {
  assert.equal(targets('这个问 @m1.'), 'a');
  assert.equal(targets('这个问 @m1，谢谢'), 'a');
});
