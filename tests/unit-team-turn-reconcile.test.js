'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TranscriptTap } = require('../core/transcript-tap');
const { selectClaudeTurn } = require('../core/claude-turn-alignment');
const { createTeamTurnReconciler } = require('../main/team/turn-reconcile');

const SID = 'member-reconcile', START = 1800000000000;
function fixture({ beforeParse, records, now } = {}) {
  const user = { type: 'user', uuid: 'user-current', timestamp: new Date(START).toISOString(), message: { content: '当前任务' } };
  const answer = { type: 'assistant', uuid: 'answer-current', parentUuid: user.uuid,
    timestamp: new Date(START + 1000).toISOString(), message: { content: [{ type: 'text', text: '任务完成' }], stop_reason: 'end_turn' } };
  const rows = records || [user, answer], calls = [], parsed = [];
  const tap = new TranscriptTap({ parserService: { async parse(kind, file, options) {
    parsed.push({ kind, file, options });
    if (beforeParse) await beforeParse();
    return { turns: [selectClaudeTurn(rows, options)] };
  } } });
  tap.registerSession(SID, 'codeagent', { transcriptPath: 'D:/fixture/current.jsonl' });
  const bound = tap._claude._bound.get(SID);
  Object.assign(bound, { currentTurnId: 'hook-current', currentUserRecordId: user.uuid,
    generation: 3, awaitingPromptHook: false, lastPromptRecordId: user.uuid });
  const entry = { info: { id: SID, kind: 'codeagent', agentRuntime: 'pty', status: 'idle', transcriptPath: bound.transcriptPath },
    pty: {}, agentTurnActive: true, agentTurnStartSeq: 2, agentTurnStartedAt: START, agentTurnId: bound.currentTurnId };
  const manager = { sessions: new Map([[SID, entry]]), noteAgentTurnFinished(sid, ev) {
    calls.push({ sid, ev }); entry.agentTurnActive = false; return true;
  } };
  return { entry, bound, tap, manager, calls, parsed, rows, answer,
    reconcile: createTeamTurnReconciler({ sessionManager: manager, transcriptTap: tap, ...(now ? { now } : {}) }) };
}

test('real TranscriptTap facade identifies a completed CodeAgent turn and reconciles once', async () => {
  const h = fixture();
  assert.equal((await h.reconcile(SID)).reconciled, true);
  assert.equal((await h.reconcile(SID)).reconciled, false);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.parsed[0].options.userRecordId, 'user-current');
  assert.equal(h.calls[0].ev.turnId, 'hook-current');
});

test('an exact hook ID can bootstrap the user UUID through the real facade', async () => {
  const h = fixture();
  h.entry.agentTurnId = h.bound.currentTurnId = 'user-current';
  h.bound.currentUserRecordId = null;
  assert.equal((await h.reconcile(SID)).reconciled, true);
  assert.equal(h.bound.currentUserRecordId, 'user-current');
  assert.equal(h.parsed[0].options.providerTurnId, 'user-current');
  assert.equal(h.parsed[0].options.prompt, '');
  assert.equal(h.calls.length, 1);
});

test('an unknown hook ID cannot guess the latest user even with matching prompt text', async () => {
  const h = fixture();
  h.bound.currentUserRecordId = null;
  h.bound.expectedPrompt = '当前任务';
  h.bound.promptNotedAt = START;
  assert.equal((await h.reconcile(SID)).reconciled, false);
  assert.equal(h.parsed[0].options.prompt, '');
  assert.equal(h.bound.currentUserRecordId, null);
  assert.equal(h.calls.length, 0);
});

test('bootstrap cannot overwrite a different user UUID that arrived during parsing', async () => {
  let h;
  h = fixture({ beforeParse: () => { h.bound.currentUserRecordId = 'next-user'; h.bound.generation++; } });
  h.entry.agentTurnId = h.bound.currentTurnId = 'user-current';
  h.bound.currentUserRecordId = null;
  assert.equal((await h.reconcile(SID)).reconciled, false);
  assert.equal(h.calls.length, 0);
});

test('completion cannot cross a restored entry, replaced PTY, new turn, or transcript binding', async t => {
  const changes = {
    restore: h => h.manager.sessions.set(SID, { ...h.entry, pty: {} }),
    pty: h => { h.entry.pty = {}; },
    sequence: h => { h.entry.agentTurnStartSeq++; },
    hook: h => { h.entry.agentTurnId = 'next-turn'; },
    directInputWithoutHook: h => { h.bound.generation++; h.bound.currentUserRecordId = 'next-user'; },
    path: h => { h.bound.transcriptPath = 'D:/fixture/resumed.jsonl'; },
    newHubDispatch: h => { h.bound.awaitingPromptHook = true; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    let h;
    h = fixture({ beforeParse: () => change(h) });
    assert.equal((await h.reconcile(SID)).reconciled, false);
    assert.equal(h.calls.length, 0);
  });
});

test('late old answers cannot complete the current long tool turn', async () => {
  const h = fixture();
  h.answer.message.stop_reason = 'tool_use';
  h.rows.push({ type: 'user', uuid: 'old-user', timestamp: new Date(START - 10000).toISOString(), message: { content: '旧任务' } },
    { type: 'assistant', uuid: 'old-answer', parentUuid: 'old-user', timestamp: new Date(START + 5000).toISOString(),
      message: { content: [{ type: 'text', text: '迟到的旧回答' }], stop_reason: 'end_turn' } });
  assert.equal((await h.reconcile(SID)).reconciled, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.entry.agentTurnActive, true);
});

test('missing identities, dormant restores, and unsupported backends remain untouched', async t => {
  for (const [name, change] of Object.entries({
    turnId: h => { h.entry.agentTurnId = null; },
    generation: h => { delete h.bound.generation; },
    sequence: h => { h.entry.agentTurnStartSeq = 0; },
    path: h => { h.entry.info.transcriptPath = null; },
    dormant: h => { h.entry.info.status = 'dormant'; },
    native: h => { h.entry.info.runtimeBackend = 'claude-stream-json'; },
    otherKind: h => { h.entry.info.kind = 'claude'; },
  })) await t.test(name, async () => {
    const h = fixture(); change(h);
    assert.equal((await h.reconcile(SID)).reconciled, false);
    assert.equal(h.parsed.length, 0);
    assert.equal(h.calls.length, 0);
  });
});

test('read failures and pre-start completion timestamps never clear the busy flag', async () => {
  const failed = fixture({ beforeParse: () => { throw Error('fixture read failed'); } });
  assert.equal((await failed.reconcile(SID)).reconciled, false);
  assert.equal(failed.calls.length, 0);
  const old = fixture(); old.answer.timestamp = new Date(START - 1).toISOString();
  assert.equal((await old.reconcile(SID)).reconciled, false);
  assert.equal(old.calls.length, 0);
});

test('a rejected finish receipt is reported without claiming recovery', async () => {
  const h = fixture(); h.manager.noteAgentTurnFinished = () => false;
  assert.equal((await h.reconcile(SID)).reconciled, false);
  assert.equal(h.entry.agentTurnActive, true);
});

test('a queued long turn is parsed at most once every 30 seconds', async () => {
  let clock = 0;
  const h = fixture({ now: () => clock });
  h.answer.message.stop_reason = 'tool_use';
  await h.reconcile(SID);
  for (clock = 3000; clock < 30000; clock += 3000) {
    assert.equal((await h.reconcile(SID)).reconciled, false);
  }
  clock = 29999;
  await h.reconcile(SID);
  assert.equal(h.parsed.length, 1);
  assert.equal(h.entry.agentTurnActive, true);
  clock = 30000;
  h.answer.message.stop_reason = 'end_turn';
  assert.equal((await h.reconcile(SID)).reconciled, true);
  assert.equal(h.parsed.length, 2);
});

test('a new turn or another member does not inherit a prior turn cooldown', async () => {
  let clock = 0;
  const h = fixture({ now: () => clock });
  h.answer.message.stop_reason = 'tool_use';
  await h.reconcile(SID);
  clock = 1000;
  h.entry.agentTurnId = h.bound.currentTurnId = 'hook-next';
  h.entry.agentTurnStartSeq++;
  h.entry.agentTurnStartedAt++;
  h.bound.generation++;
  await h.reconcile(SID);
  assert.equal(h.parsed.length, 2);
  const other = 'other-member';
  h.tap.registerSession(other, 'codeagent', { transcriptPath: h.bound.transcriptPath });
  Object.assign(h.tap._claude._bound.get(other), h.bound);
  h.manager.sessions.set(other, { ...h.entry, info: { ...h.entry.info, id: other }, pty: {} });
  await h.reconcile(other);
  assert.equal(h.parsed.length, 3);
});

test('read failures are throttled and in-flight reads cannot overlap after 30 seconds', async () => {
  let clock = 0;
  const failed = fixture({ now: () => clock, beforeParse: () => { throw Error('read failed'); } });
  await failed.reconcile(SID);
  clock = 3000;
  await failed.reconcile(SID);
  assert.equal(failed.parsed.length, 1);
  clock = 30000;
  await failed.reconcile(SID);
  assert.equal(failed.parsed.length, 2);

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const busy = fixture({ now: () => clock, beforeParse: () => gate });
  const first = busy.reconcile(SID);
  clock += 60000;
  assert.equal((await busy.reconcile(SID)).reconciled, false);
  assert.equal(busy.parsed.length, 1);
  release();
  assert.equal((await first).reconciled, true);
});
