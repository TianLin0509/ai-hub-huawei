'use strict';
// 界面重新载入后接回在跑、未读、等待状态（core/renderer-reload-restore.js，2026-11-21）。
const assert = require('assert');
const { liveTurnSnapshot, restorePersistedAttention, liveTurnObservation, RESTORE_SOURCE, RESTORE_TTL_MS } = require('../core/renderer-reload-restore');
const { applySessionRuntimeObservation, sessionRuntimeIsActive, getSessionRuntimeTruth } = require('../core/session-runtime-truth');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (error) { failed += 1; console.log('  ✗ ' + name); console.log(error && error.stack || error); }
}

test('main: only an active PTY turn without a native backend gets a liveTurn', () => {
  const pty = { info: { agentRuntime: 'pty' }, agentTurnActive: true, agentTurnStartedAt: 1000, agentTurnId: 't1', agentTurnStartSource: 'claude-user-prompt-submit' };
  assert.deepEqual(liveTurnSnapshot(pty), { startedAt: 1000, turnId: 't1', source: 'claude-user-prompt-submit' });
  assert.equal(liveTurnSnapshot({ ...pty, agentTurnActive: false }), null, 'finished turn');
  assert.equal(liveTurnSnapshot({ ...pty, info: { agentRuntime: null, runtimeBackend: 'claude-stream-json' } }), null, 'native backend reports itself');
  assert.equal(liveTurnSnapshot({ ...pty, info: { agentRuntime: 'pty', runtimeBackend: 'x' } }), null);
  assert.equal(liveTurnSnapshot(null), null);
});

test('main: getAllSessions carries liveTurn only for running turns', () => {
  const SessionManager = require('../core/session-manager');
  const Manager = SessionManager.SessionManager || SessionManager;
  const fake = { sessions: new Map([
    ['a', { info: { id: 'a', agentRuntime: 'pty', lastMessageTime: 2 }, agentTurnActive: true, agentTurnStartedAt: 500, agentTurnId: null }],
    ['b', { info: { id: 'b', agentRuntime: 'pty', lastMessageTime: 1 }, agentTurnActive: false }],
  ]) };
  const list = Manager.prototype.getAllSessions.call(fake);
  const byId = Object.fromEntries(list.map(s => [s.id, s]));
  assert.deepEqual(byId.a.liveTurn, { startedAt: 500, turnId: null, source: null });
  assert.equal('liveTurn' in byId.b, false);
  assert.equal('liveTurn' in fake.sessions.get('a').info, false, 'main info is not mutated');
});

test('renderer: a Claude PTY session that was mid-turn comes back as running, not idle', () => {
  const now = 1_800_000_000_000;
  const session = { id: 'a', kind: 'claude', agentRuntime: 'pty', status: 'idle', liveTurn: { startedAt: now - 300000, turnId: 't9' } };
  assert.equal(sessionRuntimeIsActive(session, { now }), false, 'before the fix: shown idle (legacy-idle)');
  const observation = liveTurnObservation(session, now);
  assert.equal(observation.state, 'running');
  assert.equal(observation.source, RESTORE_SOURCE);
  assert.equal(observation.startedAt, now - 300000, 'run timer keeps the real start');
  assert.equal(observation.expiresAt, now + RESTORE_TTL_MS);
  assert.ok(applySessionRuntimeObservation(session, observation, { now }).applied);
  assert.equal(sessionRuntimeIsActive(session, { now: now + 1000 }), true);
  assert.equal(getSessionRuntimeTruth(session, { now: now + 1000 }).source, RESTORE_SOURCE);
});

test('renderer: a newer running/waiting truth (e.g. Codex kept in main) is not overwritten', () => {
  for (const state of ['running', 'starting', 'waiting']) {
    assert.equal(liveTurnObservation({ liveTurn: { startedAt: 1 }, runtimeTruth: { state } }, 10), null, state);
  }
  assert.equal(liveTurnObservation({ runtimeTruth: null }, 10), null, 'no live turn');
});

test('renderer: unread and reply/wait marks come back from state.json for live sessions', () => {
  const live = { id: 'a', unreadCount: 0, lastCompletedAt: 100 };
  const meta = { hubId: 'a', unreadCount: 2, attentionState: 'reply-ready', replyReady: true, replyReadyText: '好了', needsUserInput: false, lastCompletedAt: 900 };
  assert.equal(restorePersistedAttention(live, meta), true);
  assert.equal(live.unreadCount, 2);
  assert.equal(live.attentionState, 'reply-ready');
  assert.equal(live.replyReady, true);
  assert.equal(live.replyReadyText, '好了');
  assert.equal(live.lastCompletedAt, 900);
});

test('renderer: fresher marks already in the live session win; empty records change nothing', () => {
  const live = { unreadCount: 3, attentionState: 'needs-input', needsUserInput: true, lastCompletedAt: 900 };
  assert.equal(restorePersistedAttention(live, { unreadCount: 1, attentionState: 'reply-ready', replyReady: true, lastCompletedAt: 100 }), false);
  assert.equal(live.attentionState, 'needs-input');
  assert.equal(live.unreadCount, 3);
  const quiet = { unreadCount: 0 };
  assert.equal(restorePersistedAttention(quiet, { unreadCount: 0, attentionState: 'none', needsUserInput: false, replyReady: false }), false);
  assert.equal(quiet.attentionState, undefined, "'none' is not a mark");
  assert.equal(restorePersistedAttention(quiet, undefined), false);
});

// Codex 复审：上一轮落盘的「等你输入」不能压过主进程记下的新一轮运行。
test('renderer: an older needs-input mark does not hide a newer running turn', () => {
  const stale = { liveTurn: { startedAt: 2000 } };
  assert.equal(restorePersistedAttention(stale, { attentionState: 'needs-input', needsUserInput: true, updatedAt: 1500 }), false);
  assert.equal(stale.attentionState, undefined);
  const current = { liveTurn: { startedAt: 2000 } };
  assert.equal(restorePersistedAttention(current, { attentionState: 'needs-input', needsUserInput: true, updatedAt: 2500, waitingText: '要我继续吗' }), true);
  assert.equal(current.attentionState, 'needs-input', 'waiting inside the same live turn comes back');
  const ended = {};
  assert.equal(restorePersistedAttention(ended, { attentionState: 'needs-input', needsUserInput: true, updatedAt: 9999 }), false, 'turn already over: nothing to wait for');
});

test('renderer: a reply the user already followed up on is not marked unread-ready again', () => {
  const followed = { liveTurn: { startedAt: 3000 } };
  assert.equal(restorePersistedAttention(followed, { attentionState: 'reply-ready', replyReady: true, lastCompletedAt: 2000 }), true, 'only lastCompletedAt moves');
  assert.equal(followed.attentionState, undefined);
  const idle = {};
  restorePersistedAttention(idle, { attentionState: 'reply-ready', replyReady: true, lastCompletedAt: 2000 });
  assert.equal(idle.attentionState, 'reply-ready');
});

console.log(failed ? `${failed} failed` : `PASS ${passed}`);
if (failed) process.exitCode = 1;
