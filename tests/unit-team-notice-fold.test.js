'use strict';
// 卡片视图里团队消息折成一行（2026-11-03 用户）：摘要 = 条数 + 第一条正文首行；组队开工单独识别；普通消息不折。
const test = require('node:test'), assert = require('node:assert/strict');
const { teamNoticeSummary } = require('../renderer/team-notice-identity');

test('team batches summarise to count plus the first body line', () => {
  const text = '【团队消息 · 2 条】\n- [m1 A 测量 · 留言] msg-a · 2026-11-03T00:00:00Z\nA 已跑完，结果见 D:/x.md\n第二行\n- [m2] msg-b · t\nB 卡住\n\n普通告知无需回执';
  assert.deepEqual(teamNoticeSummary(text), { kind: 'notice', summary: '2 条 · A 已跑完，结果见 D:/x.md' });
  assert.equal(teamNoticeSummary('【团队消息 · 1 条】\n- [Hub] msg-c · t\n计划已批准').summary, '计划已批准');
});

test('kickoff is folded too, long summaries are clipped, ordinary prompts are not folded', () => {
  assert.deepEqual(teamNoticeSummary('【组队开工 · 来自负责人】你是成员 m1，分工：测量。\n团队目标：x'), { kind: 'kickoff', summary: '组队开工：你是成员 m1，分工：测量。' });
  const long = teamNoticeSummary('【团队消息 · 1 条】\n- [m1] msg · t\n' + '字'.repeat(300));
  assert.equal(long.summary.length, 161);
  assert.equal(teamNoticeSummary('帮我看下这段代码'), null);
  assert.equal(teamNoticeSummary(''), null);
});

test('legacy inline bodies remain visible; a missing body does not use another sender', () => {
  assert.equal(teamNoticeSummary('【团队消息 · 1 条】\n- [m1 实现] 已完成。\n\n回复：…').summary, '已完成。');
  assert.equal(teamNoticeSummary('【团队消息 · 2 条】\n- [m1] msg-a · t\n\n- [m2] msg-b · t\n第二条').summary, '2 条 · 团队消息');
});
