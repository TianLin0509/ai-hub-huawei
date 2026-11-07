'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createStopPendingSettle } = require('../core/stop-pending-settle');
const { SessionManager } = require('../core/session-manager');

function setup() {
  const sm = new SessionManager();
  const sid = 's1';
  sm.sessions.set(sid, { info: { id: sid, kind: 'codeagent', agentRuntime: 'pty' }, pty: {}, pendingTimers: [] });
  sm.noteAgentTurnStarted(sid, { startedAt: Date.now() - 1000, signalSource: 'claude-user-prompt-submit', prompt: 'x', turnId: 'p1' });
  const jobs = [];
  const settle = createStopPendingSettle({
    manager: sm, getTurnSeq: id => sm.sessions.get(id)?.agentTurnStartSeq || 0,
    setTimer: fn => { const j = { fn, cleared: false }; jobs.push(j); return j; },
    clearTimer: j => { j.cleared = true; },
  });
  return { sm, sid, jobs, settle };
}
const fire = jobs => jobs.filter(j => !j.cleared).forEach(j => j.fn());

test('stop_hook pending finishes the turn after the delay', () => {
  const { sm, sid, jobs, settle } = setup();
  assert.strictEqual(sm.isAgentTurnActive(sid), true);
  assert.strictEqual(settle.onPending({ hubSessionId: sid, signalSource: 'stop_hook', reason: 'x' }), true);
  assert.strictEqual(sm.isAgentTurnActive(sid), true);
  fire(jobs);
  assert.strictEqual(sm.isAgentTurnActive(sid), false);
});

test('a new turn started before the delay keeps the session busy', () => {
  const { sm, sid, jobs, settle } = setup();
  settle.onPending({ hubSessionId: sid, signalSource: 'stop_hook' });
  sm.noteAgentTurnStarted(sid, { startedAt: Date.now(), signalSource: 'claude-user-prompt-submit', prompt: 'y', turnId: 'p2' });
  fire(jobs);
  assert.strictEqual(sm.isAgentTurnActive(sid), true);
});

test('pending from other sources is ignored', () => {
  const { sid, jobs, settle } = setup();
  assert.strictEqual(settle.onPending({ hubSessionId: sid, signalSource: 'fs-watch' }), false);
  assert.strictEqual(jobs.length, 0);
});
