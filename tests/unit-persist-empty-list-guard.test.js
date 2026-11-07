'use strict';
// 渲染层发来空清单时，主进程不得删除已落盘的会话记录。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('empty session list does not delete session files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-guard-'));
  process.env.AI_HUB_DATA_DIR = dir;
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  const store = require('../core/session-store');
  const { handlePersistSessions } = require('../main/ipc/persistence-handlers');
  const { getHubDataDir } = require('../core/data-dir');
  const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'];
  for (const id of ids) store.saveSessionFile(id, { kind: 'codeagent', title: id.slice(0, 4), updatedAt: 1 });
  const sdir = path.join(getHubDataDir(), 'sessions');
  const count = () => fs.readdirSync(sdir).filter(n => n.endsWith('.json')).length;
  assert.strictEqual(count(), 2);
  let lastIds = new Set(ids), removed = [];
  const deps = {
    sessionManager: { getSession: () => undefined, _openOwners: () => ({ owner: () => null, editClosed: (_i, f) => f(), editSessions: (_i, f) => f() }) },
    sessionStore: store,
    stateStore: { save() {}, markRemovedSession(id) { removed.push(id); }, markRemovedMeeting() {} },
    meetingStore: { markDirty() {}, deleteMeetingFile() {}, cancelDirty() {} },
    meetingManager: { getAllMeetings: () => [], getMeeting: () => null, getMeetingMemberships: () => [] },
    getImmersiveByMeeting: () => ({}), getLastPersistedMeetingIds: () => new Set(), getLastPersistedMeetings: () => [],
    getLastPersistedSessionIds: () => lastIds, getLastPersistedSessions: () => ids.map(hubId => ({ hubId })),
    setLastPersistedMeetingIds() {}, setLastPersistedMeetings() {}, setLastPersistedSessionIds: v => { lastIds = v; }, setLastPersistedSessions() {},
    getLiveSession: () => null,
  };
  const origWarn = console.warn; console.warn = () => {};
  try { assert.strictEqual(handlePersistSessions([], [], deps), false); } finally { console.warn = origWarn; }
  assert.strictEqual(count(), 2);
  assert.strictEqual(removed.length, 0);
});
