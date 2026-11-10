'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

test('confirmed renaming rejects real storage failures and same-name retries durably save both copies', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-persistence-'));
  const previousDir = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  const stateStore = require('../core/state-store'), sessionStore = require('../core/session-store'), meetingStore = require('../core/meeting-store');
  const { MeetingRoomManager } = require('../core/meeting-room');
  const { registerPersistenceIpc } = require('../main/ipc/persistence-handlers');
  const { createSessionRenamer } = require('../renderer/session-renaming');
  const rename = fs.promises.rename, renameSync = fs.renameSync;
  t.after(async () => { fs.promises.rename = rename; fs.renameSync = renameSync; await stateStore.flushPending(); sessionStore.flushAll(); await meetingStore.flushAll(); if (previousDir === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = previousDir; fs.rmSync(dataDir, { recursive: true, force: true }); });
  for (const [kind, failingCopy] of [['dormant', 'all'], ['dormant', 'state'], ['live', 'session'], ['meeting', 'meeting']]) await t.test(`${kind}: EIO in ${failingCopy} cannot acknowledge success`, async () => {
    const isMeeting = kind === 'meeting', id = 'rename-' + kind + '-' + failingCopy;
    const local = { id, kind: 'codeagent', status: kind === 'dormant' ? 'dormant' : 'idle', title: '旧名字', userRenamed: false, lastMessageTime: Date.now() };
    const manager = new MeetingRoomManager();
    let sessions = isMeeting ? [] : [{ ...local, hubId: id, updatedAt: Date.now() }], meetings = isMeeting ? [{ ...local, subSessions: [], autoTitlePending: false }] : [];
    if (isMeeting) { manager.restoreMeeting(meetings[0]); meetingStore.saveMeetingFile(id, meetings[0]); }
    else sessionStore.saveSessionFile(id, sessions[0]);
    await stateStore.saveForRestart({ version: 1, sessions, meetings });
    let sessionIds = new Set(sessions.map(s => s.hubId)), meetingIds = new Set(meetings.map(m => m.id));
    const live = kind === 'live' ? { ...local } : null, handlers = new Map();
    registerPersistenceIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
      stateStore, sessionStore, meetingStore, meetingManager: manager,
      sessionManager: { getSession: sid => sid === id ? live : null }, getLiveSession: () => live,
      getImmersiveByMeeting: () => ({}), getLastPersistedSessions: () => sessions, setLastPersistedSessions: value => { sessions = value; },
      getLastPersistedSessionIds: () => sessionIds, setLastPersistedSessionIds: value => { sessionIds = value; },
      getLastPersistedMeetings: () => meetings, setLastPersistedMeetings: value => { meetings = value; },
      getLastPersistedMeetingIds: () => meetingIds, setLastPersistedMeetingIds: value => { meetingIds = value; },
    });
    const failedTarget = target => String(target).startsWith(dataDir + path.sep) && (failingCopy === 'all'
      || failingCopy === 'state' && target === stateStore.STATE_FILE
      || failingCopy === 'session' && String(target).includes(path.sep + 'sessions' + path.sep)
      || failingCopy === 'meeting' && String(target).includes(path.sep + 'meetings' + path.sep));
    fs.promises.rename = async (source, target) => { if (failedTarget(target)) throw Object.assign(new Error('injected EIO'), { code: 'EIO' }); return rename(source, target); };
    fs.renameSync = (source, target) => { if (failedTarget(target)) throw Object.assign(new Error('injected EIO'), { code: 'EIO' }); return renameSync(source, target); };
    const responses = [];
    const deps = { stateStore, sessionStore, meetingStore, meetingManager: manager,
      sessionManager: { getSession: sid => sid === id ? live : null, updateSessionMeta: (_id,patch) => Object.assign(live,patch) },
      getLastPersistedSessions: () => sessions, setLastPersistedSessions: value => { sessions=value; },
      getLastPersistedMeetings: () => meetings, setLastPersistedMeetings: value => { meetings=value; } };
    const service = require('../main/session-title-service').createTitleService(deps);
    const renamer = createSessionRenamer({ getSession: () => isMeeting ? null : local, getMeeting: () => isMeeting ? local : null, render() {},
      ipcRenderer: { invoke: async (_channel,args) => { const result=await service.rename(args);responses.push(result);return result; } },
    });
    try {
      await assert.rejects(renamer.rename(id, '新名字'), /EIO|保存失败/);
      assert.deepEqual(responses, [], 'a failed write must never produce ok:true');
      const failedFile = failingCopy === 'state' || failingCopy === 'all' ? stateStore.STATE_FILE : path.join(dataDir, isMeeting ? 'meetings' : 'sessions', id + '.json');
      const disk = JSON.parse(fs.readFileSync(failedFile, 'utf8'));
      assert.equal(failingCopy === 'state' || failingCopy === 'all' ? disk.sessions.find(s => s.hubId === id).title : disk.title, '旧名字');
    } finally { fs.promises.rename = rename; fs.renameSync = renameSync; }
    assert.equal(await renamer.rename(id, '新名字'), true);
    assert.equal(responses.length,1); assert.equal(responses[0].ok,true);
    const state = JSON.parse(fs.readFileSync(stateStore.STATE_FILE, 'utf8'));
    const persisted = isMeeting ? state.meetings.find(m => m.id === id) : state.sessions.find(s => s.hubId === id);
    const backup = isMeeting ? meetingStore.loadMeetingFile(id) : sessionStore.loadSessionFile(id);
    assert.equal(persisted.title, '新名字'); assert.equal(backup.title, '新名字'); assert.equal(backup.userRenamed, true);
  });
});
