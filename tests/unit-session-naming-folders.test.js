'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const guards = require('../core/session-title-guards');
const { meetingMemberTitlePatch } = require('../core/meeting-member-titles');
function load(file, mocks) {
  const filename = path.join(__dirname, '..', file), realRequire = createRequire(filename);
  const context = { module: { exports: {} }, process, Date, Math, console, require: name => Object.hasOwn(mocks, name) ? mocks[name] : realRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}
test('new AI placeholder names trigger auto title while legacy names stay compatible', () => {
  for (const title of ['新会话 1', '新会话 22', 'CodeAgent 1', 'Claude Resume 2', 'Codex 3']) assert.equal(guards.isGenericAutoSessionTitle(title), true, title);
  assert.equal(guards.isStableSessionTitle('新会话 1'), false);
  assert.equal(guards.isGenericAutoSessionTitle('新会话功能评审'), false);
  assert.equal(guards.isGenericAutoSessionTitle('GLM 模型调研'), false);
});
test('AI defaults use one neutral counter; explicit restored titles and terminal names survive', () => {
  const { defaultSessionTitle } = require('../core/session-default-title');
  const counters = {};
  for (const [index, kind] of ['codeagent', 'claude', 'codex-resume', 'deepseek-acp', 'qwen', 'kimi'].entries()) assert.equal(defaultSessionTitle(counters, kind, {}), `新会话 ${index + 1}`);
  assert.equal(defaultSessionTitle(counters, 'codeagent', { title: 'MiniMax 专题' }), 'MiniMax 专题');
  assert.equal(defaultSessionTitle(counters, 'powershell', {}), 'PowerShell 1');
});
test('group member name uses stable member number and topic across model changes and dormant display', () => {
  const meeting = { id: 'group-1', title: '接口调研', subSessions: ['sid-first', 'sid-next'], slotSpecs: [{ memberId: 'm2' }, { memberId: 'm7' }] };
  const s = { id: 'sid-next', kind: 'codeagent', meetingId: meeting.id, currentModel: { displayName: 'GLM-5.2' }, title: 'GLM-5.2 · 接口调研' };
  assert.equal(meetingMemberTitlePatch(s, meeting).title, '成员 7 · 接口调研');
  const named = { ...s, title: '成员 7 · 接口调研', autoTitleGenerated: true, currentModel: { id: 'MiniMax-M2.7' } };
  assert.equal(meetingMemberTitlePatch(named, meeting), null);
  assert.equal(guards.sessionDisplayTitle({ ...s, hubId: s.id, id: undefined, status: 'dormant' }, undefined, meeting), '成员 7 · 接口调研');
  assert.equal(meetingMemberTitlePatch({ ...s, userRenamed: true, title: '接口专家' }, meeting), null);
  assert.equal(meetingMemberTitlePatch(s, { ...meeting, title: '新主题' }).title, '成员 7 · 新主题');
});
test('meeting title-only changes persist complete rename metadata into the independent backup', () => {
  const files = new Map();
  const store = load('core/meeting-store.js', { './title-backup-write': { withTitleBackupWrite: (_file,_revision,write) => write() }, fs: {
    mkdirSync() {}, writeFileSync(file, body) { files.set(file, body); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    readFileSync(file) { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file); }, existsSync(file) { return files.has(file); }, unlinkSync(file) { files.delete(file); },
  }, './data-dir': { getHubDataDir: () => '/virtual/hub' } });
  // Keep storage real; force its debounce boundary immediately for deterministic disk verification.
  const { MeetingRoomManager } = load('core/meeting-room.js', { uuid: { v4: () => 'group-1' }, './meeting-store': { ...store, markDirty: (id, data) => store.saveMeetingFile(id, data) } });
  const manager = new MeetingRoomManager(); manager.createMeeting();
  manager.updateMeeting('group-1', { title: 'AI 群聊 #99', userRenamed: true, autoTitlePending: false, autoTitleGenerated: false });
  const saved = store.loadMeetingFile('group-1');
  assert.ok(saved, 'title-only rename must produce an independent backup');
  assert.equal(saved.title, 'AI 群聊 #99'); assert.equal(saved.userRenamed, true);
  assert.equal(saved.autoTitlePending, false); assert.equal(saved.autoTitleGenerated, false);
  const restored = new MeetingRoomManager(); restored.restoreMeeting(saved);
  assert.equal(restored.getMeeting('group-1').userRenamed, true);
  assert.equal(restored.getMeeting('group-1').autoTitlePending, false);
});
test('a stale renderer snapshot cannot undo acknowledged meeting renames or their protection flags', () => {
  const { buildMeetingsForState } = require('../main/ipc/persistence-handlers');
  const authoritative = { id: 'group-1', title: '用户群名', userRenamed: true, autoTitlePending: false, autoTitleGenerated: true };
  const stale = { id: 'group-1', title: 'AI 群聊 #1', userRenamed: false, autoTitlePending: true, autoTitleGenerated: false };
  const [saved] = buildMeetingsForState([stale], { getMeeting: () => authoritative });
  assert.equal(saved.title, '用户群名'); assert.equal(saved.userRenamed, true);
  assert.equal(saved.autoTitlePending, false); assert.equal(saved.autoTitleGenerated, true);
});
