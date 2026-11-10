'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

test('main title transactions reject disk errors, ignore stale autosaves and commit only the submitted name', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-transaction-'));
  const priorDir = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  const stateStore = require('../core/state-store'), sessionStore = require('../core/session-store'), meetingStore = require('../core/meeting-store');
  const { createTitleService } = require('../main/session-title-service');
  const { registerPersistenceIpc } = require('../main/ipc/persistence-handlers');
  const initial = { id: 'target-0001', hubId: 'target-0001', kind: 'codeagent', title: '原名', userRenamed: false, updatedAt: 1, codexSid: 'old-native', cwd: '/old-workspace' };
  const live = { ...initial }, group = { id: 'group-0001', title: '原群', subSessions: [], userRenamed: false, updatedAt: 1 };
  let saved = [{ ...initial }], savedGroups = [{ ...group }], ids = new Set([initial.id]), groupIds = new Set([group.id]);
  const manager = { getMeeting: id => id === group.id ? { ...group } : null, getAllMeetings: () => [{ ...group }], getMeetingMemberships: () => [], updateMeeting: (_id, patch) => Object.assign(group, patch) };
  const sessions = { getSession: id => id === live.id ? { ...live } : null, updateSessionMeta: (_id, patch) => Object.assign(live, patch) };
  const deps = { sessionManager: sessions, meetingManager: manager, stateStore, sessionStore, meetingStore,
    getLiveSession: id => sessions.getSession(id), getImmersiveByMeeting: () => ({}),
    getLastPersistedSessions: () => saved, setLastPersistedSessions: rows => { saved = rows; }, getLastPersistedSessionIds: () => ids, setLastPersistedSessionIds: next => { ids = next; },
    getLastPersistedMeetings: () => savedGroups, setLastPersistedMeetings: rows => { savedGroups = rows; }, getLastPersistedMeetingIds: () => groupIds, setLastPersistedMeetingIds: next => { groupIds = next; }, sendToRenderer() {},
  };
  sessionStore.saveSessionFile(live.id, initial); meetingStore.saveMeetingFile(group.id, group);
  await stateStore.saveForRestart({ version: 1, sessions: saved, meetings: savedGroups });
  const service = createTitleService(deps), handlers = new Map();
  registerPersistenceIpc({ handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) }, deps);
  const rename = fs.promises.rename, renameSync = fs.renameSync;
  t.after(async () => { fs.promises.rename = rename; fs.renameSync = renameSync; await stateStore.flushPending(); sessionStore.flushAll(); await meetingStore.flushAll(); if (priorDir === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = priorDir; fs.rmSync(dataDir, { recursive: true, force: true }); });
  const readTitle = () => JSON.parse(fs.readFileSync(stateStore.STATE_FILE, 'utf8')).sessions.find(s => s.hubId === live.id).title;
  await t.test('queued stale autosave while main transaction waits cannot become a false success', async () => {
    let release, entered; const started = new Promise(resolve => { entered = resolve; });
    fs.promises.rename = async (from, to) => { if (to === stateStore.STATE_FILE && !release) { entered(); await new Promise(resolve => { release = resolve; }); } return rename(from, to); };
    stateStore.save({ version: 1, sessions: saved, meetings: savedGroups });
    const blocker = stateStore.flushPending(); await started;
    const confirming = service.rename({ type: 'session', id: live.id, title: '确认的新名' });
    handlers.get('persist-sessions')(null, [{ ...initial, updatedAt: Date.now() + 10000 }], savedGroups);
    release(); await blocker; const result = await confirming;
    fs.promises.rename = rename;
    assert.equal(result.record.title, '确认的新名'); assert.equal(live.title, '确认的新名');
    handlers.get('persist-sessions')(null, [{ ...initial, updatedAt: Date.now() + 20000 }], savedGroups);
    await stateStore.flushPending(); await sessionStore.flushPending();
    assert.equal(readTitle(), '确认的新名'); assert.equal(sessionStore.loadSessionFile(live.id).title, '确认的新名');
    assert.ok(result.record.titleRevision > 0);
  });
  await t.test('backup EIO is a failed main transaction and does not leave failed renderer name guards', async () => {
    const old = live.title; fs.renameSync = (from, to) => { if (String(to).endsWith(path.sep + live.id + '.json')) throw Object.assign(new Error('injected EIO'), { code: 'EIO' }); return renameSync(from, to); };
    await assert.rejects(service.rename({ type: 'session', id: live.id, title: '不能假成功' }), /EIO/);
    fs.renameSync = renameSync;
    assert.equal(live.title, old); assert.equal(readTitle(), old); assert.equal(sessionStore.loadSessionFile(live.id).title, old);
    const retry = await service.rename({ type: 'session', id: live.id, title: '不能假成功' }); assert.equal(readTitle(), retry.record.title);
  });
  await t.test('a backup advanced after the transaction read must reject instead of acknowledging a skipped write', async () => {
    const old = live.title, file = path.join(dataDir, 'sessions', live.id + '.json'); let advanced = false;
    fs.renameSync = (from, to) => {
      if (to === stateStore.STATE_FILE && !advanced) {
        advanced = true;
        const external = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...external, title: '另一进程更高版本名', titleRevision: external.titleRevision + 100 }));
      }
      return renameSync(from, to);
    };
    try { await assert.rejects(service.rename({ type: 'session', id: live.id, title: '必须确认两份的新名' }), /版本/); }
    finally { fs.renameSync = renameSync; }
    assert.equal(live.title, old); assert.equal(readTitle(), old);
    assert.equal(sessionStore.loadSessionFile(live.id).title, '另一进程更高版本名');
    const retry = await service.rename({ type: 'session', id: live.id, title: '必须确认两份的新名' });
    assert.equal(sessionStore.loadSessionFile(live.id).title, retry.record.title);
  });
  await t.test('rename keeps the latest native identity and working directory while state autosave is still old', async () => {
    live.codexSid = 'new-native'; live.cwd = '/new-workspace';
    sessionStore.saveSessionFile(live.id, { ...live, codexSid: 'new-native', cwd: '/new-workspace' });
    await service.rename({ type: 'session', id: live.id, title: '保持最新身份' });
    const backup = sessionStore.loadSessionFile(live.id);
    assert.equal(backup.codexSid, 'new-native'); assert.equal(backup.cwd, '/new-workspace');
    const disk = JSON.parse(fs.readFileSync(stateStore.STATE_FILE)).sessions.find(row => row.hubId === live.id);
    assert.equal(disk.codexSid, 'new-native'); assert.equal(disk.cwd, '/new-workspace');
  });
  await t.test('a newer backup title revision cannot silently replace the newly submitted title', async () => {
    sessionStore.saveSessionFile(live.id, { ...live, title: '备份里较新的已保存名', titleRevision: 50, userRenamed: true });
    const result = await service.rename({ type: 'session', id: live.id, title: '从旧窗口确认的新名' });
    assert.equal(sessionStore.loadSessionFile(live.id).title, '从旧窗口确认的新名');
    assert.equal(readTitle(), '从旧窗口确认的新名'); assert.ok(result.record.titleRevision > 50);
  });
  await t.test('a title transaction refuses unreadable, corrupt or unsupported state without replacing any file', async () => {
    const read = fs.readFileSync, oldTitle = live.title;
    for (const failure of ['EIO', 'json', 'version']) {
      let writes = 0;
      fs.readFileSync = (file, ...args) => {
        if (String(file) === stateStore.STATE_FILE) {
          if (failure === 'EIO') throw Object.assign(new Error('injected read EIO'), { code: 'EIO' });
          return failure === 'json' ? '{bad' : JSON.stringify({ version: 999, sessions: [], meetings: [] });
        }
        return read(file, ...args);
      };
      fs.renameSync = (from, to) => { writes++; return renameSync(from, to); };
      try {
        await assert.rejects(service.rename({ type: 'session', id: live.id, title: '不得覆盖不可读状态' }), /EIO|JSON|版本/);
        assert.equal(writes, 0); assert.equal(live.title, oldTitle);
      } finally { fs.readFileSync = read; fs.renameSync = renameSync; }
    }
  });
  await t.test('unreadable or corrupt session and group backups reject the whole transaction without writes', async () => {
    const read = fs.readFileSync;
    for (const type of ['session', 'meeting']) for (const failure of ['EIO', 'json', 'version']) {
      const id = type === 'session' ? live.id : group.id;
      const file = path.join(dataDir, type === 'session' ? 'sessions' : 'meetings', id + '.json');
      const original = read(file, 'utf8'), beforeState = read(stateStore.STATE_FILE, 'utf8'); let writes = 0;
      fs.readFileSync = (target, ...args) => {
        if (String(target) === file) {
          if (failure === 'EIO') throw Object.assign(new Error('backup read EIO'), { code: 'EIO' });
          return failure === 'json' ? '{bad' : JSON.stringify({ schemaVersion: 999 });
        }
        return read(target, ...args);
      };
      fs.renameSync = (from, to) => { writes++; return renameSync(from, to); };
      try {
        await assert.rejects(service.rename({ type, id, title: '不得覆盖不可读备份' }), /EIO|JSON|版本/);
        assert.equal(writes, 0);
      } finally { fs.readFileSync = read; fs.renameSync = renameSync; }
      assert.equal(read(file, 'utf8'), original); assert.equal(read(stateStore.STATE_FILE, 'utf8'), beforeState);
    }
  });
  await t.test('the legacy group title IPC also awaits the main transaction and propagates failure', async () => {
    const ipc = new Map(), failures = [];
    const { registerMeetingIpc } = require('../main/ipc/meeting-handlers');
    let fail = true;
    registerMeetingIpc({ handle: (name,fn) => ipc.set(name,fn), on: (name,fn) => ipc.set(name,fn) }, {
      ...deps, sendToRenderer: (channel,body) => failures.push([channel,body]),
      getTitleService: () => ({ rename: async request => { if (fail) throw new Error('legacy EIO'); return service.rename(request); } }),
    });
    await assert.rejects(Promise.resolve().then(() => ipc.get('update-meeting-sync')(null,{meetingId:group.id,fields:{title:'兼容入口新名'}})), /EIO/);
    assert.notEqual(group.title, '兼容入口新名');
    await ipc.get('update-meeting')(null,{meetingId:group.id,fields:{title:'事件入口失败'}});
    assert.equal(failures.at(-1)?.[0], 'session-persistence-error');
    fail = false;
    assert.equal(await ipc.get('update-meeting-sync')(null,{meetingId:group.id,fields:{title:'兼容入口新名'}}),true);
    assert.equal(meetingStore.loadMeetingFile(group.id).title,'兼容入口新名');
  });
  await t.test('group title uses the same transaction and survives a delayed old meeting snapshot', async () => {
    const old = { ...group }; const result = await service.rename({ type: 'meeting', id: group.id, title: '确认群名' });
    handlers.get('persist-sessions')(null, saved, [{ ...old, updatedAt: Date.now() + 20000 }]);
    await stateStore.flushPending(); await meetingStore.flushPending();
    assert.equal(meetingStore.loadMeetingFile(group.id).title, '确认群名');
    assert.equal(JSON.parse(fs.readFileSync(stateStore.STATE_FILE)).meetings.find(m => m.id === group.id).title, '确认群名');
    assert.equal(group.title, result.record.title);
  });
  await t.test('main queues native renames per entity while an unrelated group remains usable', async () => {
    const calls = [], releases = new Map();
    sessions.getNativeClaude = id => id === live.id ? { rename: title => new Promise(resolve => { calls.push(title); releases.set(title, resolve); }) } : null;
    try {
      const first = service.rename({ type: 'session', id: live.id, title: '原生第一次' });
      while (!releases.has('原生第一次')) await new Promise(resolve => setImmediate(resolve));
      const second = service.rename({ type: 'session', id: live.id, title: '原生第二次' });
      await service.rename({ type: 'meeting', id: group.id, title: '独立群聊改名' });
      assert.deepEqual(calls, ['原生第一次']); assert.equal(readTitle(), '原生第一次');
      releases.get('原生第一次')(); await first;
      while (!releases.has('原生第二次')) await new Promise(resolve => setImmediate(resolve));
      releases.get('原生第二次')(); await second;
      assert.equal(readTitle(), '原生第二次'); assert.equal(sessionStore.loadSessionFile(live.id).title, '原生第二次');
      assert.deepEqual(calls, ['原生第一次', '原生第二次']);
    } finally { delete sessions.getNativeClaude; }
  });

  await t.test('boot recovery takes the newest title revision even when its general metadata timestamp is older', () => {
    meetingStore.saveMeetingFile(group.id, { ...group, title: '备份里的最新群名', titleRevision: 50, updatedAt: 1 });
    const boot = stateStore.loadAndSelfHeal({ sessionStore, meetingStore });
    assert.equal(boot.meetings.find(row => row.id === group.id).title, '备份里的最新群名');
    assert.equal(boot.meetings.find(row => row.id === group.id).titleRevision, 50);
  });

});
