'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionAutoSuspendScheduler, rankMemoryPressureCandidates, memoryTier } = require('../main/session-auto-suspend');

const MIN = 60 * 1000;
function fakeManager(items) {
  const calls = { preview: [], suspended: [] };
  return {
    calls,
    suspendIdleSessions: () => ({ ok: true, count: 0 }),
    previewIdleSuspend(opts) {
      calls.preview.push(opts);
      return { items: items.map(i => ({ ...i, eligible: i.eligible !== false && i.idleMs >= opts.idleMs })) };
    },
    suspendSession(id, opts) { calls.suspended.push({ id, reason: opts.reason }); return { ok: true }; },
  };
}
const quiet = { log() {}, warn() {} };

test('分档：85% 起步，越紧张门槛越低、每次收得越多', () => {
  assert.equal(memoryTier(0.84), null);
  assert.deepEqual([memoryTier(0.86).minIdleMs, memoryTier(0.86).perTick], [30 * MIN, 1]);
  assert.deepEqual([memoryTier(0.91).minIdleMs, memoryTier(0.91).perTick], [10 * MIN, 2]);
  assert.deepEqual([memoryTier(0.97).minIdleMs, memoryTier(0.97).perTick], [3 * MIN, 3]);
});

test('排序：助理会话优先，其次最早答完的；没停下来的不收', () => {
  const picks = rankMemoryPressureCandidates([
    { sessionId: 'new', eligible: true, settled: true, lastActivityAt: 300 },
    { sessionId: 'old', eligible: true, settled: true, lastActivityAt: 100 },
    { sessionId: 'running', eligible: true, settled: false, lastActivityAt: 1 },
    { sessionId: 'asst', eligible: true, settled: true, purpose: 'company-assistant', lastActivityAt: 900 },
    { sessionId: 'blocked', eligible: false, settled: true, lastActivityAt: 2 },
  ], 3);
  assert.deepEqual(picks.map(p => p.sessionId), ['asst', 'old', 'new']);
});

test('内存不紧张时什么都不动', () => {
  const mgr = fakeManager([{ sessionId: 'a', idleMs: 99 * MIN, settled: true }]);
  const s = createSessionAutoSuspendScheduler({ sessionManager: mgr, getMemoryUsage: () => 0.7, logger: quiet });
  const r = s.memorySweep();
  assert.equal(r.requested.length, 0);
  assert.equal(mgr.calls.preview.length, 0);
});

test('88%：只收闲置满 30 分钟的一个最早答完的会话，并通知', () => {
  const mgr = fakeManager([
    { sessionId: 'fresh', idleMs: 5 * MIN, settled: true, lastActivityAt: 900 },
    { sessionId: 'b', idleMs: 40 * MIN, settled: true, lastActivityAt: 200, title: 'B' },
    { sessionId: 'a', idleMs: 60 * MIN, settled: true, lastActivityAt: 100, title: 'A' },
  ]);
  const notes = [];
  const s = createSessionAutoSuspendScheduler({ sessionManager: mgr, getMemoryUsage: () => 0.88, logger: quiet, onMemorySuspend: n => notes.push(n) });
  s.memorySweep();
  assert.deepEqual(mgr.calls.suspended, [{ id: 'a', reason: 'memory-pressure' }]);
  assert.equal(mgr.calls.preview[0].excludePinned, true);
  assert.equal(mgr.calls.preview[0].excludeFocused, true);
  assert.equal(mgr.calls.preview[0].excludeMeeting, true);
  assert.equal(notes[0].requested[0].title, 'A');
});

test('96%：闲置 3 分钟以上的就可以收，一次最多 3 个', () => {
  const items = ['a', 'b', 'c', 'd'].map((id, i) => ({ sessionId: id, idleMs: 4 * MIN, settled: true, lastActivityAt: i }));
  const mgr = fakeManager(items);
  createSessionAutoSuspendScheduler({ sessionManager: mgr, getMemoryUsage: () => 0.96, logger: quiet }).memorySweep();
  assert.deepEqual(mgr.calls.suspended.map(c => c.id), ['a', 'b', 'c']);
});
