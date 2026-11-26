'use strict';
// 群聊「抢救」动作（main/ipc/groupchat-rescue-handlers.js，2026-11-24）：真编排器 + 假会话 / 假 watcher。
// 用例 1 是「撤掉 forceIdle 就失败」：停止本轮在发送卡在半路时不收回待命，抢救必须无条件收回。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const groupchat = require('../core/group-chat-orchestrator');
const { createGroupchatRescue, registerGroupchatRescueIpc, scrubText, failureText, workflowBusy } = require('../main/ipc/groupchat-rescue-handlers');

// 拼接写法：免得公开版泄露审计把测试里的假 Key 当成真 Key。
const FAKE_KEY = ['sk', 'should-never-leak-123456'].join('-');
// 同样拼接：本机用户目录的写法会被公开版审计当成真实路径。
const FAKE_WIN_PATH = ['C:', 'Users', 'x00123456', '.ai-hub', 'config.json'].join('\\');
const SIDS = ['sid-aaaaaaaa-1111', 'sid-bbbbbbbb-2222'];
function fakeWatcher({ settled = false, ignoresInterrupt = false } = {}) {
  const w = { settled, skips: 0, isSettled: () => w.settled, skip: () => { w.skips++; w.settled = true; },
    interrupt: () => { if (!ignoresInterrupt) w.settled = true; } };
  return w;
}
function setup(t, { meeting = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rescue-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const meetingId = 'meet-' + path.basename(dataDir);
  const m = { id: meetingId, groupChat: true, subSessions: [...SIDS], slotSpecs: [{ memberId: 'm1' }, { memberId: 'm2' }], answerSource: 'transcript', ...meeting };
  const watchers = new Map();
  const sessions = new Map(SIDS.map(sid => [sid, { id: sid, kind: 'claude', status: 'running', model: 'opus', apiKey: FAKE_KEY }]));
  const calls = { interrupt: 0, restart: [], notified: [] };
  const deps = {
    meetingManager: { getMeeting: id => (id === meetingId ? m : null) },
    groupchat, getHubDataDir: () => dataDir, getActiveWatchers: () => watchers,
    // 模拟「发送卡在半路」：中断只结算认中断的 watcher，不碰编排器状态。
    interruptMeetingTurn: () => {
      calls.interrupt++;
      const stopped = [];
      for (const [sid, w] of watchers) { if (!w.isSettled()) { w.interrupt(); if (w.isSettled()) stopped.push(sid); } }
      return { stopped, signaled: stopped, pendingDispatch: true };
    },
    restartSession: async sid => { calls.restart.push(sid); return { id: sid, kind: 'claude' }; },
    sessionManager: { getSession: sid => sessions.get(sid) || null },
    sendToRenderer: (ch, payload) => calls.notified.push([ch, payload]),
    runtimeState: s => ({ state: s.status === 'running' ? 'running' : 'idle' }),
    logger: { warn() {}, error() {} },
  };
  const orch = groupchat.getOrchestrator(dataDir, meetingId);
  return { dataDir, meetingId, meeting: m, watchers, sessions, calls, deps, orch, rescue: createGroupchatRescue(deps) };
}
function startTurn(orch, text = '本轮问题：机密正文 XYZ') {
  const { turnNum, runId } = orch.beginTurn(text, {});
  for (const [i, sid] of SIDS.entries()) orch.recordTurnPrompt(turnNum, sid, '提示词正文-不该导出', { runId, memberId: `m${i + 1}` });
  return { turnNum, runId };
}
const TERMINAL = ['interrupted', 'completed', 'failed', 'superseded', 'absent'];

test('用例 1：发送卡在半路、停止本轮收不回待命 → 强制结束本轮收回 idle，用户消息与已有回答保留，未收尾的 attempt 记为中断', t => {
  const sb = setup(t);
  const { turnNum } = startTurn(sb.orch);
  sb.orch.state.messages.push({ id: 'a-keep', role: 'assistant', turnNum, sid: SIDS[0], content: '已交的回答', status: 'completed' });
  assert.equal(sb.orch.state.currentMode, 'group');
  const r = sb.rescue.forceSettle({ meetingId: sb.meetingId });
  assert.equal(r.ok, true);
  assert.equal(r.forced, true);
  assert.equal(sb.calls.interrupt, 1, '先走停止本轮同一条中断链路');
  assert.equal(sb.orch.state.currentMode, 'idle');
  assert.ok(sb.orch.state.messages.some(m => m.id === `u${turnNum}`), '用户消息保留');
  assert.ok(sb.orch.state.messages.some(m => m.id === 'a-keep'), '已交回答保留');
  const open = Object.values(sb.orch.state.attempts).filter(a => !TERMINAL.includes(a.status));
  assert.equal(open.length, 0, '没有残留的「还在跑」attempt');
  assert.equal(r.attemptsClosed, 2);
  assert.ok(sb.calls.notified.some(([ch, p]) => ch === 'groupchat-rescued' && p.action === 'force-settle'));
  const saved = JSON.parse(fs.readFileSync(groupchat.groupChatStatePath(sb.dataDir, sb.meetingId), 'utf8'));
  assert.equal(saved.currentMode, 'idle', '落盘的状态也是待命');
});

test('用例 2：成员 watcher 不认中断 → 强制结束本轮按跳过结算它；已空闲时再点一次不报错、不改状态', t => {
  const sb = setup(t);
  startTurn(sb.orch);
  const stubborn = fakeWatcher({ ignoresInterrupt: true });
  const polite = fakeWatcher();
  sb.watchers.set(SIDS[0], stubborn); sb.watchers.set(SIDS[1], polite);
  const r = sb.rescue.forceSettle({ meetingId: sb.meetingId });
  assert.deepEqual(r.skipped, [SIDS[0]]);
  assert.equal(stubborn.skips, 1);
  assert.equal(polite.skips, 0);
  assert.equal(r.wasBusy, true);
  const again = sb.rescue.forceSettle({ meetingId: sb.meetingId });
  assert.equal(again.ok, true);
  assert.equal(again.forced, false);
  assert.equal(again.wasBusy, false, '已空闲时如实说「本来就是待命」');
});

test('用例 3：重启成员——正在答的先跳过再走 restart-session；不在群的、会话不在的、重启失败的都给人话', async t => {
  const sb = setup(t);
  const w = fakeWatcher(); sb.watchers.set(SIDS[1], w);
  const ok = await sb.rescue.restartMember({ meetingId: sb.meetingId, sid: SIDS[1] });
  assert.equal(ok.ok, true);
  assert.equal(ok.skipped, true);
  assert.deepEqual(sb.calls.restart, [SIDS[1]]);
  assert.equal((await sb.rescue.restartMember({ meetingId: sb.meetingId, sid: 'other' })).reason, 'participant_not_in_meeting');
  sb.sessions.delete(SIDS[0]);
  assert.match((await sb.rescue.restartMember({ meetingId: sb.meetingId, sid: SIDS[0] })).message, /休眠/);
  sb.sessions.set(SIDS[0], { id: SIDS[0], kind: 'codex', status: 'idle' });
  const failing = createGroupchatRescue({ ...sb.deps, restartSession: async () => ({ ok: false, error: 'native-session-id-missing', message: '当前会话尚未绑定原生会话 ID' }) });
  const failed = await failing.restartMember({ meetingId: sb.meetingId, sid: SIDS[0] });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'native-session-id-missing');
  assert.match(failed.message, /原生会话/);
});

test('用例 4：回退上一轮——运行中拒绝并提示先强制结束；空闲后撤掉最近一轮，轮次号回到上一轮', t => {
  const sb = setup(t);
  const first = startTurn(sb.orch, '第一问');
  sb.orch.clearTurnInProgress(first.turnNum, first.runId);
  sb.orch.state.turns.push({ n: first.turnNum });
  const second = startTurn(sb.orch, '第二问');
  const busy = sb.rescue.rollbackLastTurn({ meetingId: sb.meetingId });
  assert.equal(busy.ok, false);
  assert.match(busy.message, /强制结束本轮/);
  sb.rescue.forceSettle({ meetingId: sb.meetingId });
  const r = sb.rescue.rollbackLastTurn({ meetingId: sb.meetingId });
  assert.equal(r.ok, true);
  assert.equal(r.turnNum, second.turnNum);
  assert.equal(sb.orch.state.currentTurn, first.turnNum);
  assert.ok(!sb.orch.state.messages.some(m => Number(m.turnNum) === second.turnNum));
  assert.ok(sb.orch.state.messages.some(m => m.id === `u${first.turnNum}`));
  const dev = setup(t, { meeting: { scene: 'dev' } });
  assert.equal(dev.rescue.rollbackLastTurn({ meetingId: dev.meetingId }).reason, 'dev_workflow');
});

test('用例 5：跳过未交成员只动还没结算的', t => {
  const sb = setup(t);
  const done = fakeWatcher({ settled: true }), stuck = fakeWatcher();
  sb.watchers.set(SIDS[0], done); sb.watchers.set(SIDS[1], stuck);
  const r = sb.rescue.skipStuck({ meetingId: sb.meetingId });
  assert.deepEqual(r.skipped, [SIDS[1]]);
  assert.equal(done.skips, 0);
});

test('用例 6：导出诊断——真实 completeTurn 的失败原因能导出；有状态机与成员信息，不含对话正文、提示词、Key、用户目录与完整会话编号', t => {
  const sb = setup(t);
  const { turnNum } = startTurn(sb.orch);
  // 用编排器真实落盘路径写失败消息（failure / statusReason），不手工伪造字段。
  sb.orch.completeTurn(turnNum, '本轮问题：机密正文 XYZ', [
    { sid: SIDS[0], status: 'errored', text: '成员私密回答', reason: 'quota_exceeded',
      failure: { code: 'quota_exceeded', label: '额度不足', detail: '429 limit at ' + FAKE_WIN_PATH + '; Cookie: sid=secret123; session=topsecret456' } },
  ], { [SIDS[0]]: { memberId: 'm1', speaker: 'Claude' } }, {}, {});
  sb.orch.state.currentMode = 'group'; // 模拟另一位成员还在答
  sb.sessions.get(SIDS[1]).currentModel = { id: 'GLM-5.2-WX', displayName: 'GLM 5.2' };
  sb.sessions.get(SIDS[1]).model = undefined;
  sb.watchers.set(SIDS[0], fakeWatcher());
  const r = sb.rescue.exportDiagnostics({ meetingId: sb.meetingId });
  assert.equal(r.ok, true);
  assert.equal(path.dirname(r.path), path.join(sb.dataDir, 'diagnostics'));
  assert.match(path.basename(r.path), /^\d{8}-\d{6}-groupchat-[0-9a-f]{8}\.json$/);
  const text = fs.readFileSync(r.path, 'utf8');
  const snap = JSON.parse(text);
  assert.equal(snap.turn.currentMode, 'group');
  assert.equal(snap.turn.currentTurn, 1);
  assert.equal(snap.members.length, 2);
  assert.equal(snap.members[0].watcher, 'running');
  assert.equal(snap.members[1].model, 'GLM-5.2-WX', '对象形态的模型只导出名字');
  const err = snap.recentErrors.find(e => e.status === 'errored');
  assert.ok(err, '真实失败消息被收进 recentErrors');
  assert.match(err.reason, /额度不足/);
  assert.match(err.reason, /quota_exceeded/);
  for (const secret of ['机密正文', '提示词正文', '成员私密回答', FAKE_KEY, 'x00123456', 'secret123', 'topsecret456', SIDS[0], sb.meetingId]) {
    assert.ok(!text.includes(secret), `诊断里不应出现：${secret}`);
  }
});

test('用例 6b：脱敏——用户目录、多段 Cookie、JWT、URL 内嵌账号、Bearer、key=value 都抹掉，普通报错保留', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
  const cases = [
    ['ENOENT open ' + FAKE_WIN_PATH, ['x00123456'], /<USER_HOME>/],
    ['open /home/alice/.config/x', ['alice'], /<USER_HOME>/],
    ['Cookie: sid=secret123; session=topsecret456; path=/', ['secret123', 'topsecret456'], /\[已隐藏\]/],
    ['failed: ' + jwt, ['eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3'], /failed: \[已隐藏\]/],
    ['GET https://bob:hunter2@gw.example/v1', ['bob', 'hunter2'], /https:\/\/\[已隐藏\]@gw\.example/],
    ['Authorization: Bearer abcdefghijklmnop', ['abcdefghijklmnop'], /\[已隐藏\]/],
    ['token=abc123 ok', ['abc123'], /\[已隐藏\] ok/],
  ];
  for (const [input, gone, kept] of cases) {
    const out = scrubText(input);
    for (const g of gone) assert.ok(!out.includes(g), `${input} → ${out} 仍含 ${g}`);
    assert.match(out, kept, out);
  }
  assert.equal(scrubText('上游 502：网关超时，已重试 2 次'), '上游 502：网关超时，已重试 2 次');
});

test('用例 6f：JSON 形式的凭据、Cookie、提示词与请求正文都抹掉；盘符绝对路径换成 <PATH>', () => {
  const D = ['D:', 'proj', 'zhangsan', 'a.js'].join('\\');
  const cases = [
    ['{"api_key":"DEMO-NOT-A-REAL-KEY"}', ['DEMO-NOT-A-REAL-KEY']],
    ['{"Cookie":"sid=DEMO; session=DEMO2"}', ['DEMO', 'DEMO2']],
    ['request body={"prompt":"PRIVATE-FIXTURE-BODY"}', ['PRIVATE-FIXTURE-BODY']],
    ['upstream 400 {"error":{"message":"bad","token" : "tok-SECRET-1"},"messages":[{"role":"user","content":"PRIVATE-Q"}]}', ['tok-SECRET-1', 'PRIVATE-Q']],
    ["{'password': 'p@ss w0rd'}", ['p@ss', 'w0rd']],
    ['{"x-api-key":"KEY-VALUE-1","model":"glm-5"}', ['KEY-VALUE-1']],
    ['ENOENT open ' + D, ['zhangsan', 'proj']],
  ];
  for (const [input, gone] of cases) {
    const out = scrubText(input);
    for (const g of gone) assert.ok(!out.includes(g), `${input} → ${out} 仍含 ${g}`);
  }
  assert.match(scrubText('upstream 400 {"error":{"token":"x1"}}'), /^upstream 400 /, '原因前缀保留');
  assert.match(scrubText('ENOENT open ' + D), /<PATH>/);
});

test('用例 6g：failureText 不导出 summary / detail / 系统提示正文这类可能夹带请求正文的自由文本', () => {
  const body = 'request body={"prompt":"PRIVATE-FIXTURE-BODY"}';
  const out = failureText({ failure: { code: 'provider_error', label: '上游出错', summary: body, detail: body }, statusReason: 'provider_error', error: body, content: 'PRIVATE-ANSWER' });
  assert.equal(out, '上游出错 · provider_error');
  assert.equal(failureText({ systemNote: true, noteKind: 'error', content: '发送失败：' + body }), '系统提示：出错');
  assert.equal(failureText({ failure: { code: '{"a":1}', label: '{"prompt":"PRIVATE"}' } }), '');
});

test('用例 6c：failureText 按编排器真实字段拼原因；workflowBusy 认出四套引擎', () => {
  assert.equal(failureText({ failure: { code: 'quota', label: '额度不足', summary: '429' }, statusReason: 'quota' }), '额度不足 · quota');
  assert.equal(failureText({ failureReason: '补充消息没送到' }), '补充消息没送到');
  assert.equal(failureText({ systemNote: true, noteKind: 'info', content: '普通提示' }), '');
  assert.equal(workflowBusy({}, 'm'), '');
  assert.equal(workflowBusy({ loopEngine: { isRunning: () => true } }, 'm'), 'loop');
  assert.equal(workflowBusy({ deliveryEngine: { isBusy: () => true } }, 'm'), 'delivery');
  assert.equal(workflowBusy({ devFileEngine: { status: () => ({ running: true }) } }, 'm'), 'dev-file');
  assert.equal(workflowBusy({ squadEngine: { view: () => ({ run: { status: 'handback' } }) } }, 'm'), 'squad');
  assert.equal(workflowBusy({ squadEngine: { view: () => ({ run: { status: 'done' } }) } }, 'm'), '');
  assert.equal(workflowBusy({ squadEngine: { view: () => { throw new Error('x'); } } }, 'm'), '', '引擎查询出错不拖垮回退判断');
});

test('用例 6d：小队两棒之间（轮次空闲、没有在答的成员）点回退 → 拒绝并说明是小队在跑', t => {
  const sb = setup(t);
  const first = startTurn(sb.orch, '第一问');
  sb.orch.clearTurnInProgress(first.turnNum, first.runId);
  const squadBusy = createGroupchatRescue({ ...sb.deps, isWorkflowRunning: () => workflowBusy({ squadEngine: { view: () => ({ run: { status: 'members' } }) } }, sb.meetingId) });
  const r = squadBusy.rollbackLastTurn({ meetingId: sb.meetingId });
  assert.equal(r.ok, false);
  assert.equal(r.engine, 'squad');
  assert.match(r.message, /小队还在跑/);
  assert.ok(sb.orch.state.messages.some(m => m.id === `u${first.turnNum}`), '轮次没有被撤');
});

test('R47 审查 P2：回退上一轮成功后，作废小队负责人掉线停下的任务；回退被拒时不动', t => {
  const sb = setup(t);
  const first = startTurn(sb.orch, '第一问');
  sb.orch.clearTurnInProgress(first.turnNum, first.runId);
  const discarded = [];
  const rescue = createGroupchatRescue({ ...sb.deps, discardSquadRecovery: (id, turn) => { discarded.push([id, turn]); return true; } });
  const r = rescue.rollbackLastTurn({ meetingId: sb.meetingId });
  assert.equal(r.ok, true);
  assert.equal(r.squadDiscarded, true);
  assert.deepEqual(discarded, [[sb.meetingId, first.turnNum]]);
  const none = rescue.rollbackLastTurn({ meetingId: sb.meetingId });
  assert.equal(none.ok, false);
  assert.equal(discarded.length, 1);
});

test('用例 6e：休眠成员点重启 → 直接提示唤醒，不走 restart-session', async t => {
  const sb = setup(t);
  sb.sessions.get(SIDS[0]).status = 'dormant';
  const r = await sb.rescue.restartMember({ meetingId: sb.meetingId, sid: SIDS[0] });
  assert.equal(r.reason, 'session_dormant');
  assert.match(r.message, /唤醒/);
  assert.deepEqual(sb.calls.restart, []);
});

test('用例 7：五个 IPC 通道都注册，抛错时回人话而不是让界面卡住', async t => {
  const sb = setup(t);
  const handlers = new Map();
  registerGroupchatRescueIpc({ handle: (name, fn) => handlers.set(name, fn) }, { ...sb.deps, meetingManager: { getMeeting: () => { throw new Error('坏了'); } } });
  assert.deepEqual([...handlers.keys()].sort(), ['groupchat:export-diagnostics', 'groupchat:force-settle', 'groupchat:restart-member', 'groupchat:rollback-last-turn', 'groupchat:skip-stuck']);
  const r = await handlers.get('groupchat:force-settle')({}, { meetingId: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.message, '坏了');
  assert.equal((await handlers.get('groupchat:skip-stuck')({}, undefined)).reason, 'invalid_args');
});

test('用例 8：原生 Claude 成员（watcher 没有 skip、interrupt 是空的）→ 按「被取代」结算，派发队列不再挂着', t => {
  const sb = setup(t);
  startTurn(sb.orch);
  let settled = false, superseded = 0;
  sb.watchers.set(SIDS[0], { isSettled: () => settled, interrupt() {}, supersede() { superseded++; settled = true; } });
  const r = sb.rescue.skipStuck({ meetingId: sb.meetingId });
  assert.deepEqual(r.skipped, [SIDS[0]]);
  assert.equal(superseded, 1);
  settled = false;
  const f = sb.rescue.forceSettle({ meetingId: sb.meetingId });
  assert.deepEqual(f.skipped, [SIDS[0]]);
  assert.equal(sb.orch.state.currentMode, 'idle');
});
