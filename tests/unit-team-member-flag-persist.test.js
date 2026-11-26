'use strict';
// R47 审查 P1-1：团队成员标记 hubTeamMember 的全链持久化。
// 主进程公开形状 → 渲染层自动保存行 → handlePersistSessions（渲染层漏带时主进程回填）→ 会话文件 → 恢复元数据 → 恢复参数。
// 任何一环丢了，恢复出来的成员就会重新带上组队指路（core/team-guide.js）。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-member-flag-'));
process.env.CLAUDE_HUB_DATA_DIR = root;
process.env.AI_HUB_DATA_DIR = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const HUB = 'cccccccc-3333-4333-8333-000000000003';

test('全链：成员标记经自动保存、落盘、恢复元数据和恢复参数都不丢；普通会话不出现', async () => {
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd, { recursive: true });
  const { SessionManager } = require('../core/session-manager');
  const info = { id: HUB, kind: 'codeagent', cwd, title: '成员', status: 'idle', hubTeamMember: true, ccSessionId: 'dddddddd-4444-4444-8444-000000000004' };
  const pub = SessionManager.prototype._toPublic.call(Object.create(SessionManager.prototype), info);
  assert.equal(pub.hubTeamMember, true, '公开形状带标记');
  const plain = SessionManager.prototype._toPublic.call(Object.create(SessionManager.prototype), { ...info, hubTeamMember: undefined });
  assert.equal('hubTeamMember' in plain, false);

  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(renderer.includes('...(s.hubTeamMember ? { hubTeamMember: true } : {}),'), '渲染层自动保存行带标记');

  // 渲染层这一行漏带标记：主进程以权威会话回填
  const persistence = require('../main/ipc/persistence-handlers');
  let saved = null, lastSessions = [];
  const list = [{ hubId: HUB, kind: 'codeagent', cwd, title: '成员', ccSessionId: info.ccSessionId }];
  persistence.handlePersistSessions(list, [], {
    sessionManager: { getSession: id => (id === HUB ? pub : undefined), _openOwners: () => ({ owner: () => null, editClosed: (_i, f) => f(), editSessions: (_i, f) => f() }) },
    getLiveSession: () => null,
    getLastPersistedSessions: () => lastSessions, setLastPersistedSessions: v => { lastSessions = v; },
    getLastPersistedSessionIds: () => new Set(), setLastPersistedSessionIds() {},
    getLastPersistedMeetingIds: () => new Set(), setLastPersistedMeetingIds() {},
    getImmersiveByMeeting: () => ({}), meetingManager: { getAllMeetings: () => [] }, meetingStore: {},
    sessionStore: { markDirty: (_id, value) => { saved = value; } }, stateStore: { save() {} },
  });
  assert.equal(saved && saved.hubTeamMember, true, '自动保存不洗掉标记');

  const store = require('../core/session-store');
  store.saveSessionFile(HUB, { ...saved, updatedAt: Date.now() });
  const loaded = store.loadSessionFile(HUB, { strict: true });
  assert.equal(loaded.hubTeamMember, true, '会话文件里有标记');

  const meta = require('../core/session-capabilities').buildSessionResumeMeta(loaded);
  assert.equal(meta.hubTeamMember, true, '恢复元数据（重启、唤醒、工作区迁移共用）带标记');
  assert.equal('hubTeamMember' in require('../core/session-capabilities').buildSessionResumeMeta({ id: 'x', kind: 'codeagent' }), false);

  const calls = [];
  const manager = { sessions: new Map(), getSession: () => null, getAllSessions: () => [], getNativeSession: () => null,
    createSession(kind, opts) { calls.push({ kind, opts }); return { id: opts.id || HUB, kind, cwd: opts.cwd, status: 'idle' }; } };
  const resume = require('../main/ipc/resume-session-handlers').createResumeSessionHandler({
    fs, os, path, getHookPort: () => 0, getHubDataDir: () => root, sessionManager: manager,
    isClaudeFamily: kind => /^codeagent(?:-resume)?$/.test(kind), isCodexBaseKind: () => false,
    findTranscriptByCCSessionId: () => null, meetingManager: { getAllMeetings: () => [] }, registerSessionForTap() {}, sendToRenderer() {}, slotIds: [],
  });
  await resume({ hubId: HUB }, { skipLaunchAuth: true });
  assert.equal(calls.at(-1)?.opts.hubTeamMember, true, '恢复参数带标记，启动时系统提示不带组队指路');
});
