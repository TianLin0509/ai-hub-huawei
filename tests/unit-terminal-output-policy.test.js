'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getTerminalBatchDelay, isBackgroundMember, LIVE_BATCH_MS, BACKGROUND_BATCH_MS } = require('../main/terminal-output-policy');

const mgr = (focusedSessionId, sessions) => ({ focusedSessionId, getSession: id => sessions[id] || null });

test('独立会话：正在看的实时推，其余后台合并（2026-11-20 起）', () => {
  const m = mgr('a', { a: {}, b: {} });
  assert.equal(getTerminalBatchDelay(m, 'a'), LIVE_BATCH_MS);
  assert.equal(getTerminalBatchDelay(m, 'b'), BACKGROUND_BATCH_MS);
  assert.equal(isBackgroundMember(m, 'b'), false, '独立会话不发群聊活动指示');
});

test('还不知道焦点时一律实时；群聊成员未聚焦照旧降频', () => {
  assert.equal(getTerminalBatchDelay(mgr(null, { a: {} }), 'a'), LIVE_BATCH_MS);
  const m = mgr('x', { g: { meetingId: 'm1' } });
  assert.equal(getTerminalBatchDelay(m, 'g'), BACKGROUND_BATCH_MS);
  assert.equal(isBackgroundMember(m, 'g'), true);
});
