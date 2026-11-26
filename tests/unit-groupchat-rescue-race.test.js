'use strict';
// 抢救「强制结束 → 立即回退」与在途派发的竞态（2026-11-24 并发复审 P1-2）：真实 dispatcher + 真实编排器 + 延迟的假发送。
// 发送卡在 sendToPty 时用户强制结束并回退；旧发送随后以「提交前已取消」返回，dispatcher 走无送达成员分支调用 completeTurn。
// 撤掉 rollbackTurn 记下的已撤 run（core/group-chat-orchestrator.js isRetiredRun）后，两条用例都会失败：撤掉的轮次被写回。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const gc = require('../core/group-chat-orchestrator');
const watcher = require('../core/group-chat-watcher');
const answers = require('../core/group-answer-files');
const { createGroupChatDispatcher } = require('../main/groupchat/dispatcher');
const { createGroupchatRescue } = require('../main/ipc/groupchat-rescue-handlers');

answers.enabled = () => false;
watcher.init = () => {};

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rescue-race-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const meeting = { id: 'meet-race-' + path.basename(dataDir), title: 'fixture', groupChat: true,
    subSessions: ['sid-fixture-1'], participants: [0], slotSpecs: [{ memberId: 'm1' }] };
  let releaseSend;
  let enterSend;
  const atSend = new Promise(resolve => { enterSend = resolve; });
  const original = watcher.sendToPty;
  watcher.sendToPty = async () => { enterSend(); return new Promise(resolve => { releaseSend = resolve; }); };
  t.after(() => { watcher.sendToPty = original; });
  const session = { id: 'sid-fixture-1', kind: 'claude', status: 'idle' };
  const events = [];
  const common = {
    meetingManager: { getMeeting: id => (id === meeting.id ? meeting : null) },
    groupchat: { ...gc, buildSystemPromptText: () => '' },
    getHubDataDir: () => dataDir,
    sessionManager: { getSession: () => session, getGroupChatReady: () => true, writeToSession() {}, getNativeClaude: () => null, getNativeCodex: () => null },
    logger: { warn() {}, log() {} },
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
  };
  const tap = new EventEmitter();
  tap.clearStreamingBuf = () => {};
  const dispatcher = createGroupChatDispatcher({ ...common, transcriptTap: tap, isCodexBaseKind: () => false, maybeAutoTitleMeetingFromPrompt() {} });
  const rescue = createGroupchatRescue({ ...common, getActiveWatchers: () => dispatcher.getActiveWatchers(),
    interruptMeetingTurn: (...args) => dispatcher.interruptMeetingTurn(...args) });
  const orch = gc.getOrchestrator(dataDir, meeting.id);
  return { meeting, dispatcher, rescue, orch, events, atSend, release: v => releaseSend(v) };
}
const CANCELLED = { ok: false, stopped: true, notSent: true, reason: 'cancelled_before_submit' };

test('强制结束后立即回退：在途发送晚到的失败不再把已撤轮次写回，也不广播「本轮完成」', async t => {
  const { meeting, dispatcher, rescue, orch, events, atSend, release } = setup(t);
  const pending = dispatcher.dispatchGroupChatTurn(meeting.id, { userInput: 'old fixture question' });
  await atSend;
  assert.equal(rescue.forceSettle({ meetingId: meeting.id }).ok, true);
  const rb = rescue.rollbackLastTurn({ meetingId: meeting.id });
  assert.equal(rb.ok, true, JSON.stringify(rb));
  release(CANCELLED);
  const returned = await pending;
  assert.equal(returned.status, 'discarded');
  assert.deepEqual(orch.state.turns.map(x => x.n), []);
  assert.equal(orch.state.currentTurn, 0);
  assert.deepEqual(orch.state.messages.filter(m => Number(m.turnNum) === 1), [], '撤掉的轮次没有消息回来');
  assert.ok(!events.some(e => e.channel === 'groupchat-turn-complete'));
  // 已撤 run 随状态落盘：重新加载后仍认得，Hub 重启后的回执恢复也补不回来。
  const reloaded = new gc._private.GroupChatOrchestrator(orch.hubDataDir, meeting.id);
  assert.ok(reloaded.state.retiredRunIds && reloaded.state.retiredRunIds.length >= 1);
});

test('回退后新一轮复用了同一轮号：旧轮晚到的结果不串进新轮', async t => {
  const { meeting, dispatcher, rescue, orch, atSend, release } = setup(t);
  const pending = dispatcher.dispatchGroupChatTurn(meeting.id, { userInput: 'old fixture question' });
  await atSend;
  rescue.forceSettle({ meetingId: meeting.id });
  assert.equal(rescue.rollbackLastTurn({ meetingId: meeting.id }).ok, true);
  const fresh = orch.beginTurn('new fixture question');
  assert.equal(fresh.turnNum, 1, '新一轮复用轮号 1');
  release(CANCELLED);
  await pending;
  const turn1 = orch.state.messages.filter(m => Number(m.turnNum) === 1);
  assert.deepEqual(turn1.map(m => [m.role, m.content]), [['user', 'new fixture question']]);
  assert.equal(orch.state.turns.length, 0, '旧轮没有替新轮提前落 turn 记录');
  assert.equal(orch.state.activeRun && orch.state.activeRun.runId, fresh.runId, '新轮仍在进行');
  // 旧 run 的单成员补丁同样拒收。
  const oldRunId = orch.state.retiredRunIds[0];
  assert.equal(orch.patchTurnResult(1, 'sid-fixture-1', { text: 'LATE', status: 'completed', runId: oldRunId }), null);
});
