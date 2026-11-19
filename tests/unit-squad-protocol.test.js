'use strict';
// 群聊小队模式的派工块解析与提示词（2026-11-19，反馈 1574aa0b）。
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../core/squad-protocol');

const MEMBERS = { m2: '成员 2', m3: '成员 3', '成员2': '成员 2' };
const resolve = token => {
  const key = String(token).replace(/\s+/g, '');
  const id = key === '成员2' ? 'm2' : key === '成员3' ? 'm3' : key;
  return MEMBERS[id] ? { memberId: id, label: MEMBERS[id] } : null;
};

test('依次派工块：按顺序取任务，多行任务合并', () => {
  const plan = P.parseDispatch([
    '先摸底再出方案。',
    '',
    '【派工·依次】',
    '@m2：读考勤代码，列出迟到判断',
    '  重点看早退规则',
    '@m3: 根据成员 2 的结果出方案',
  ].join('\n'), resolve);
  assert.equal(plan.mode, 'sequential');
  assert.deepEqual(plan.tasks.map(t => t.memberId), ['m2', 'm3']);
  assert.equal(plan.tasks[0].task, '读考勤代码，列出迟到判断\n重点看早退规则');
  assert.equal(plan.tasks[1].task, '根据成员 2 的结果出方案');
  assert.deepEqual(plan.skipped, []);
});

test('同时派工块、中文名点名、Markdown 修饰与代码围栏都认', () => {
  const plan = P.parseDispatch('**【派工·同时】**\n```\n- @成员2：查资料\n@m3：写提纲\n```', resolve);
  assert.equal(plan.mode, 'parallel');
  assert.deepEqual(plan.tasks.map(t => [t.memberId, t.task]), [['m2', '查资料'], ['m3', '写提纲']]);
});

test('没有派工块就是直接答复；多个派工块只认最后一个', () => {
  assert.equal(P.parseDispatch('结论：可以。依据：……', resolve), null);
  const plan = P.parseDispatch('【派工·依次】\n@m2：旧任务\n\n修改如下：\n【派工】\n@m3：新任务', resolve);
  assert.deepEqual(plan.tasks.map(t => t.memberId), ['m3']);
  assert.equal(plan.mode, 'sequential');
});

test('对不上成员或没写任务的 @ 跳过并报出来；同一成员两行合并', () => {
  const plan = P.parseDispatch('【派工·依次】\n@m9：不存在\n@m2：\n@m3：第一件\n@m3：第二件', resolve);
  assert.deepEqual(plan.tasks.map(t => [t.memberId, t.task]), [['m3', '第一件\n第二件']]);
  assert.deepEqual(plan.skipped, ['m9', 'm2']);
});

test('派工块之后的普通段落不算任务', () => {
  const plan = P.parseDispatch('【派工·依次】\n@m2：做 A\n\n以上，等成员交回后我再验收。', resolve);
  assert.deepEqual(plan.tasks.map(t => t.task), ['做 A']);
});

test('配置归一：默认 6 轮、上限 20、关闭为默认', () => {
  assert.deepEqual(P.normalizeConfig(null), { enabled: false, leaderMemberId: '', maxRounds: 6, previousParticipants: null });
  assert.equal(P.normalizeConfig({ maxRounds: 99 }).maxRounds, 20);
  assert.equal(P.normalizeConfig({ maxRounds: 0 }).maxRounds, 6);
  assert.deepEqual(P.normalizeConfig({ enabled: true, previousParticipants: [0, 'x', 2] }).previousParticipants, [0, 2]);
});

test('提示词：负责人看到成员编号与格式，交回到上限时不让再派工', () => {
  const lead = P.leaderPrompt('做个方案', { members: [{ memberId: 'm1', label: '成员 1' }, { memberId: 'm2', label: '成员 2', kind: 'codeagent' }], leaderMemberId: 'm1', maxRounds: 6 });
  assert.match(lead, /@m2：成员 2（codeagent）/);
  assert.doesNotMatch(lead, /@m1：/);
  assert.match(lead, /【派工·依次】/);
  assert.match(lead, /做个方案$/);
  const back = P.handbackPrompt([{ memberId: 'm2', label: '成员 2', ok: true }, { memberId: 'm3', label: '成员 3', ok: false, reason: '超时' }], { round: 6, maxRounds: 6 });
  assert.match(back, /第 6\/6 轮/);
  assert.match(back, /没有完成（超时）/);
  assert.match(back, /不能再派工/);
  const member = P.memberPrompt('查资料', { leaderLabel: '成员 1', mode: 'sequential', index: 1, total: 2 });
  assert.match(member, /第 2\/2 棒，前面成员的回答见上方群聊记录/);
  assert.equal(P.dispatchNote({ label: '成员 2', task: '查资料\n第二行' }), '负责人派给 @成员 2：查资料');
});

test('代码块、引用里的派工块只是举例，不触发派工（Codex 审查）', () => {
  const sample = '格式示例：\n```\n【派工·依次】\n@m2：举例任务\n```\n> 【派工·同时】\n> @m3：引用里的\n结论：不用分工。';
  assert.equal(P.parseDispatch(sample, resolve), null);
  const real = sample + '\n\n【派工·依次】\n@m3：真任务';
  assert.deepEqual(P.parseDispatch(real, resolve).tasks.map(t => t.task), ['真任务']);
});

test('与已有工作流、负责人编排互斥', () => {
  assert.equal(P.conflict({ groupChat: true }), '');
  assert.match(P.conflict({ groupChat: true, orchestration: { enabled: true } }), /负责人编排/);
  assert.match(P.conflict({ groupChat: true, scene: 'dev' }), /工作流/);
  assert.match(P.conflict({ groupChat: true, serialWorkflow: { deliveryVersion: 1 } }), /工作流/);
  assert.match(P.conflict({ groupChat: true, serialWorkflow: { enabled: true } }), /工作流/);
});
