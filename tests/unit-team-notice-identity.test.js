'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { teamNoticeSender } = require('../renderer/team-notice-identity');

test('single member notice shows that member', () => {
  const r = teamNoticeSender('【团队消息 · 1 条】\n- [m1 burst-A-AV机理] 读完了。\n\n回复成员：…');
  assert.equal(r.label, 'm1 burst-A-AV机理');
  assert.equal(r.onlyHub, false);
});

test('multiple senders list ids, drop the 留言 marker, dedupe', () => {
  const r = teamNoticeSender('【团队消息 · 3 条】\n- [m1 甲] a\n- [m2 乙 · 留言] b\n- [m1 甲] c\n');
  assert.deepEqual(r.names, ['m1 甲', 'm2 乙']);
  assert.equal(r.label, 'm1、m2');
});

test('lead and hub senders', () => {
  assert.equal(teamNoticeSender('【团队消息 · 1 条】\n- [负责人] 开工\n').label, '负责人');
  assert.equal(teamNoticeSender('【团队消息 · 1 条】\n- [Hub] 没送达\n').onlyHub, true);
});

test('ordinary prompts are not team notices', () => {
  assert.equal(teamNoticeSender('继续'), null);
  assert.equal(teamNoticeSender('请看：【团队消息 · 1 条】\n- [m1] x'), null);
  assert.equal(teamNoticeSender('【团队消息 · 1 条】\n没有发送方行'), null);
  assert.equal(teamNoticeSender(null), null);
});

test('isTeamMessage: team notices and kickoff are not the user own questions', () => {
  const { isTeamMessage } = require('../renderer/team-notice-identity');
  assert.equal(isTeamMessage('【团队消息 · 2 条】\n- [m1 甲] a\n- [Hub] b\n'), true);
  assert.equal(isTeamMessage('  【组队开工 · 来自负责人】你是成员 m1，分工：测试。'), true);
  assert.equal(isTeamMessage('帮我看下团队消息为什么没显示'), false);
  assert.equal(isTeamMessage('引用：【团队消息 · 1 条】'), false);
  assert.equal(isTeamMessage(''), false);
});
