'use strict';
// 群聊小队模式引擎（2026-11-19）：负责人派工 → 成员依次/同时 → 自动交回 → 负责人收口；轮数上限、停止、@直达、默认不变。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSquadEngine } = require('../main/groupchat/squad-engine');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function setup({ leaderReplies, memberReply = (id, input) => `${id} 完成：${input.split('\n')[1]}`, memberDelay = 0, queueDelay = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-engine-'));
  const meeting = { id: 'g1', groupChat: true, subSessions: ['s1', 's2', 's3'], participants: [0, 1, 2] };
  const members = [1, 2, 3].map(i => ({ sid: `s${i}`, index: i - 1, memberId: `m${i}`, displayName: `成员 ${i} · 群聊 · 请按小队流程完成：先让`, kind: 'codeagent', aliases: [`m${i}`, `成员 ${i}`] }));
  const calls = [];
  const cancelled = [];
  const woken = [];
  const meetingRef = meeting;
  const notes = [];
  const events = [];
  let leaderTurn = 0;
  const answer = (args) => {
    const ids = args.targetMemberIds || (args.recipientSids || []).map(sid => members.find(m => m.sid === sid).memberId);
    calls.push({ ids, args });
    return ids.map(id => {
      const sid = members.find(m => m.memberId === id).sid;
      if (id === 'm1') {
        const text = leaderReplies[Math.min(leaderTurn, leaderReplies.length - 1)];
        leaderTurn += 1;
        return { sid, status: 'completed', text };
      }
      const input = (args.perMemberInput && args.perMemberInput[id]) || args.userInput;
      return { sid, status: 'completed', text: memberReply(id, input) };
    });
  };
  const dispatcher = {
    async dispatchGroupChatTurn(_id, args) {
      const isMember = !(args.targetMemberIds || []).includes('m1');
      if (queueDelay && isMember) await sleep(queueDelay);      // 排队等前一轮
      // 与真 dispatcher 一致：排队轮到时再问一次还要不要发
      if (args.shouldDispatch && !args.shouldDispatch()) { cancelled.push(args.targetMemberIds); return { status: 'error', cancelledBeforeDispatch: true, turnNum: null }; }
      if (memberDelay && isMember) await sleep(memberDelay);    // 已发出，成员在干活
      return { status: 'completed', turnNum: calls.length + 1, results: answer(args) };
    },
  };
  const engine = createSquadEngine({
    getHubDataDir: () => dir,
    meetingManager: { getMeeting: id => (id === 'g1' ? meeting : null) },
    getDispatcher: () => dispatcher,
    getMembers: () => members,
    ensureMemberReady: async (_m, memberId) => { woken.push(memberId); },
    interruptMeetingTurn: () => { events.push('interrupt'); },
    getOrchestrator: () => ({ appendSystemNote: (_turn, text) => notes.push(text) }),
    sendToRenderer: (channel, view) => events.push([channel, view.run && view.run.status]),
    logger: { warn: () => {}, log: () => {} },
  });
  const base = (id, args) => dispatcher.dispatchGroupChatTurn(id, args);
  const waitIdle = async () => {
    for (let i = 0; i < 200; i += 1) {
      const run = engine.view('g1').run;
      if (run && ['done', 'limit', 'stopped', 'error'].includes(run.status)) return run;
      await sleep(5);
    }
    throw new Error('squad run did not settle');
  };
  return { engine, calls, notes, events, base, waitIdle, dir, cancelled, woken, meeting: meetingRef };
}

test('默认关闭：群聊消息原样走，不改收件人也不加提示', async () => {
  const t = setup({ leaderReplies: ['直接回答'] });
  await t.engine.userTurn('g1', { userInput: '你好', recipientSids: ['s1', 's2', 's3'] }, t.base);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0].ids, ['m1', 'm2', 'm3']);
  assert.equal(t.calls[0].args.userInput, '你好');
  assert.equal(t.engine.view('g1').run, null);
});

test('依次派工：成员 2 做完再叫成员 3，各收各的任务，最后交回负责人收口', async () => {
  const t = setup({ leaderReplies: [
    '拆两步。\n【派工·依次】\n@m2：摸底代码\n@m3：出方案',
    '验收通过。结论：方案可行。',
  ] });
  const cfg = t.engine.configure('g1', { enabled: true, maxRounds: 6 });
  assert.equal(cfg.config.leaderMemberId, 'm1');
  assert.equal(cfg.leaderIndex, 0);
  const first = await t.engine.userTurn('g1', { userInput: '给考勤加弹性制', recipientSids: ['s1', 's2', 's3'] }, t.base);
  assert.equal(first.status, 'completed');
  const run = await t.waitIdle();
  assert.equal(run.status, 'done');
  assert.deepEqual(t.calls.map(c => c.ids.join('+')), ['m1', 'm2', 'm3', 'm1']);
  assert.deepEqual(t.calls[0].args.targetMemberIds, ['m1'], '用户消息只发负责人');
  assert.equal(t.calls[0].args.recipientSids, undefined, '不再按头像与句中 @ 路由（提示词里有 @m2 示例）');
  assert.equal(t.calls[0].args.displayUserInput, '给考勤加弹性制', '群里显示用户原话');
  assert.match(t.calls[0].args.userInput, /小队模式 · 你是负责人/);
  assert.match(t.calls[1].args.perMemberInput.m2, /摸底代码/);
  assert.match(t.calls[2].args.perMemberInput.m3, /第 2\/2 棒/);
  assert.equal(t.calls[1].args.workflowRun.kind, 'squad');
  assert.equal(t.calls[3].args.workflowRun.kind, 'squad-notice');
  assert.match(t.calls[3].args.userInput, /@m2 成员 2：已交回/);
  assert.deepEqual(t.notes, [], '派工只靠卡片显示，不重复系统提示');
  assert.equal(t.calls[1].args.userInput, '负责人派给 @成员 2：摸底代码', '派工卡片第一行');
  assert.deepEqual(run.steps.map(s => s.state), ['done', 'done']);
});

test('同时派工：一轮里两位成员一起开工，各自只收到自己的任务', async () => {
  const t = setup({ leaderReplies: ['【派工·同时】\n@m2：查资料\n@m3：写提纲', '汇总完毕'] });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: '调研 X' }, t.base);
  await t.waitIdle();
  assert.deepEqual(t.calls.map(c => c.ids.join('+')), ['m1', 'm2+m3', 'm1']);
  const inputs = t.calls[1].args.perMemberInput;
  assert.match(inputs.m2, /查资料/); assert.doesNotMatch(inputs.m2, /写提纲/);
  assert.match(inputs.m3, /同时开工的还有：@成员 2/);
});

test('连续派工到上限就停下等用户，交回时明确说不能再派', async () => {
  const t = setup({ leaderReplies: ['【派工·依次】\n@m2：再做一次'] });
  t.engine.configure('g1', { enabled: true, maxRounds: 2 });
  await t.engine.userTurn('g1', { userInput: '一直做' }, t.base);
  const run = await t.waitIdle();
  assert.equal(run.status, 'limit');
  assert.deepEqual(t.calls.map(c => c.ids.join('+')), ['m1', 'm2', 'm1', 'm2', 'm1']);
  assert.match(t.calls[4].args.userInput, /第 2\/2 轮[\s\S]*不能再派工/);
  assert.match(t.notes.at(-1), /已连续派工 2 轮，小队先停下等你/);
  // 用户回话：重新计数，继续
  await t.engine.userTurn('g1', { userInput: '继续' }, t.base);
  await sleep(20);
  assert.ok(t.calls.length > 5);
});

test('停止小队：正在做的成员被中断，不再派下一棒、不再交回', async () => {
  const t = setup({ leaderReplies: ['【派工·依次】\n@m2：A\n@m3：B'], memberDelay: 60 });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: '做 A 和 B' }, t.base);
  await sleep(20);
  assert.equal(t.engine.stop('g1'), true);
  await sleep(120);
  assert.deepEqual(t.calls.map(c => c.ids.join('+')), ['m1', 'm2']);
  assert.ok(t.events.includes('interrupt'));
  assert.equal(t.engine.view('g1').run.status, 'stopped');
  assert.match(t.notes.at(-1), /你已停止小队/);
});

test('@ 别的成员直达，不经过负责人；没写派工块就是直接答复', async () => {
  const t = setup({ leaderReplies: ['结论：不用分工，答案是 42。'] });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: '@m3 你看下这个' , recipientSids: ['s1'] }, t.base);
  assert.deepEqual(t.calls[0].args.recipientSids, ['s1'], '原样交给普通路由（由普通路由按 @ 发给成员 3）');
  assert.equal(t.calls[0].args.userInput, '@m3 你看下这个');
  // 句中的 @ 是在给负责人交代分工，仍发负责人（真机验收 2026-11-19 发现）
  await t.engine.userTurn('g1', { userInput: '先让 @m2 列水果，再让 @m3 翻译', recipientSids: ['s1'] }, t.base);
  assert.deepEqual(t.calls[1].args.targetMemberIds, ['m1']);
  await t.waitIdle();
  await t.engine.userTurn('g1', { userInput: '简单问题' }, t.base);
  const run = await t.waitIdle();
  assert.equal(run.status, 'done');
  assert.equal(t.calls.length, 3);
});

test('派工里对不上的成员留一行提示；负责人没答出来时停下说明', async () => {
  const t = setup({ leaderReplies: ['【派工·依次】\n@m9：不存在的人\n@m2：做 A', '好了'] });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: 'x' }, t.base);
  await t.waitIdle();
  assert.match(t.notes[0], /@m9 没对上群成员/);

  const t2 = setup({ leaderReplies: [''] });
  t2.engine.configure('g1', { enabled: true });
  await t2.engine.userTurn('g1', { userInput: 'x' }, t2.base);
  const run = await t2.waitIdle();
  assert.equal(run.status, 'error');
  assert.match(run.note, /负责人没有给出回答/);
});

test('设置落盘：换负责人、关掉后恢复默认；非群聊不能开', () => {
  const t = setup({ leaderReplies: ['x'] });
  t.engine.configure('g1', { enabled: true, leaderMemberId: 'm2', maxRounds: 3 });
  const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'squad', 'g1.json'), 'utf8'));
  assert.deepEqual([saved.enabled, saved.leaderMemberId, saved.maxRounds, saved.previousParticipants], [true, 'm2', 3, [0, 1, 2]]);
  assert.equal(t.engine.configure('g1', { enabled: false }).config.enabled, false);
  assert.throws(() => t.engine.configure('nope', { enabled: true }), /只有群聊/);
});

test('排队中点停止：已排队的成员派发被取消，不会再发出（Codex 审查 P1）', async () => {
  const t = setup({ leaderReplies: ['【派工·同时】\n@m2：A\n@m3：B'], queueDelay: 60 });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: '做 A B' }, t.base);
  await sleep(20);
  t.engine.stop('g1', { quiet: true });
  await sleep(120);
  assert.deepEqual(t.cancelled, [['m2', 'm3']]);
  assert.deepEqual(t.calls.map(c => c.ids.join('+')), ['m1']);
});

test('Hub 退出排空：小队就地停下，新消息照普通群聊走', async () => {
  const t = setup({ leaderReplies: ['【派工·依次】\n@m2：A'], memberDelay: 60 });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: 'x' }, t.base);
  await sleep(20);
  t.engine.freeze();
  await sleep(120);
  assert.equal(t.engine.view('g1').run.status, 'stopped');
  assert.equal(t.calls.filter(c => c.ids.includes('m1')).length, 1, '没有交回负责人');
  await t.engine.userTurn('g1', { userInput: '再问', recipientSids: ['s1', 's2'] }, t.base);
  assert.equal(t.calls.at(-1).args.userInput, '再问');
});

test('负责人先被唤醒再收消息；开了工作流的群不能开小队，已开的也照工作流走', async () => {
  const t = setup({ leaderReplies: ['直接答'] });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: 'x' }, t.base);
  assert.equal(t.woken[0], 'm1');
  t.meeting.serialWorkflow = { enabled: true, deliveryVersion: 1 };
  await t.engine.userTurn('g1', { userInput: '工作流消息', recipientSids: ['s2'] }, t.base);
  assert.equal(t.calls.at(-1).args.userInput, '工作流消息');
  t.engine.configure('g1', { enabled: false });
  assert.throws(() => t.engine.configure('g1', { enabled: true }), /工作流/);
});
