'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { fork, execFileSync } = require('node:child_process');

if (process.argv[2] === 'writer') {
  const type = process.argv[3], mode = process.argv[4], id = 'shared-' + type;
  const store = require('../core/' + type + '-store');
  const file = path.join(process.env.CLAUDE_HUB_DATA_DIR, type === 'meeting' ? 'meetings' : 'sessions', id + '.json');
  const write = fs.promises.writeFile, rename = fs.promises.rename; let release;
  const pause = async source => {
    process.send({ stage: 'ready', prepared: JSON.parse(fs.readFileSync(source, 'utf8')) });
    await new Promise(resolve => { release = resolve; });
  };
  fs.promises.writeFile = async (target, ...args) => { const result = await write(target, ...args); if (mode === 'prepared' && String(target).startsWith(file + '.') && String(target).endsWith('.tmp')) await pause(target); return result; };
  fs.promises.rename = async (source, target) => { if (mode.startsWith('rename') && String(target) === file) await pause(source); return rename(source, target); };
  process.on('message', message => { if (message === 'release') release(); });
  const load = type === 'meeting' ? store.loadMeetingFile : store.loadSessionFile;
  store.markDirty(id, { ...load(id), status: 'running', updatedAt: Date.now() + 10000 });
  store.flushPending().then(() => process.send({ stage: 'done' }, () => process.disconnect()), error => { process.send({ stage: 'error', error: error.stack }, () => process.disconnect()); process.exitCode = 1; });
} else {
  const test = require('node:test'), assert = require('node:assert/strict');
  test('versioned backups keep confirmed titles across delayed writers in real processes', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-backup-races-'));
    const previous = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = dir;
    const stateStore = require('../core/state-store'), sessionStore = require('../core/session-store'), meetingStore = require('../core/meeting-store');
    t.after(async () => { await stateStore.flushPending(); await sessionStore.flushPending(); await meetingStore.flushPending(); if (previous === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
    const rows = { session: { id: 'shared-session', hubId: 'shared-session', title: '旧会话名', titleRevision: 1, kind: 'codeagent' }, meeting: { id: 'shared-meeting', title: '旧群名', titleRevision: 1, subSessions: [] } };
    let saved = [rows.session], groups = [rows.meeting];
    const service = require('../main/session-title-service').createTitleService({ stateStore, sessionStore, meetingStore,
      sessionManager: { getSession: id => id === rows.session.id ? rows.session : null, updateSessionMeta: (_id, patch) => Object.assign(rows.session, patch) },
      meetingManager: { getMeeting: id => id === rows.meeting.id ? rows.meeting : null, updateMeeting: (_id, patch) => Object.assign(rows.meeting, patch) },
      getLastPersistedSessions: () => saved, setLastPersistedSessions: value => { saved = value; }, getLastPersistedMeetings: () => groups, setLastPersistedMeetings: value => { groups = value; },
    });
    sessionStore.saveSessionFile(rows.session.id, rows.session); meetingStore.saveMeetingFile(rows.meeting.id, rows.meeting);
    await stateStore.saveForRestart({ version: 1, sessions: saved, meetings: groups });
    for (const type of ['meeting', 'session']) for (const mode of ['prepared', 'rename', 'rename-aged', 'rename-crashed']) await t.test(`${type}: delayed ${mode} cannot overwrite the confirmed newer title`, async () => {
      const child = fork(__filename, ['writer', type, mode], { env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const messages = new Map(), waiting = new Map(); let errorText = '';
      child.stderr.on('data', chunk => { errorText += chunk; });
      const exited = new Promise((resolve, reject) => { child.on('exit', code => code ? reject(Error(errorText || 'writer exit ' + code)) : resolve()); child.on('error', reject); });
      child.on('message', message => { messages.set(message.stage, message); waiting.get(message.stage)?.(message); });
      const next = stage => messages.has(stage) ? Promise.resolve(messages.get(stage)) : new Promise(resolve => waiting.set(stage, resolve));
      const title = '已确认新名-' + type + '-' + mode, id = rows[type].id;
      try {
        const prepared = await next('ready'); assert.ok(prepared.prepared.titleRevision >= 1);
        if (mode === 'rename-aged' || mode === 'rename-crashed') { const lock = path.join(dir, type === 'meeting' ? 'meetings' : 'sessions', id + '.json.title.lock'); const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old); }
        if (mode === 'rename-crashed') { child.kill(); await exited; }
        let result, conflict;
        try { result = await service.rename({ type, id, title }); } catch (error) { conflict = error; }
        if (mode !== 'rename-crashed') { child.send('release'); await next('done'); await exited; }
        else assert.equal(conflict, undefined, 'a dead writer lock must be reclaimed');
        if (conflict) { assert.match(conflict.message, /锁|占用|版本/); result = await service.rename({ type, id, title }); }
        assert.equal(result.ok, true);
        const backup = type === 'meeting' ? meetingStore.loadMeetingFile(id) : sessionStore.loadSessionFile(id);
        assert.equal(backup.title, title); assert.equal(backup.titleRevision, result.record.titleRevision);
        const state = JSON.parse(fs.readFileSync(stateStore.STATE_FILE, 'utf8'));
        assert.equal((type === 'meeting' ? state.meetings.find(row => row.id === id) : state.sessions.find(row => row.hubId === id)).title, title);
        fs.renameSync(stateStore.STATE_FILE, stateStore.STATE_FILE + '.held');
        try {
          const core = name => JSON.stringify(path.resolve(__dirname, '..', 'core', name));
          const code = `const s=require(${core('state-store')}),a=require(${core('session-store')}),b=require(${core('meeting-store')});const v=s.loadAndSelfHeal({sessionStore:a,meetingStore:b});console.log(JSON.stringify(v));`;
          const boot = JSON.parse(execFileSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), env: { ...process.env }, encoding: 'utf8' }).trim().split('\n').at(-1));
          assert.equal((type === 'meeting' ? boot.meetings.find(row => row.id === id) : boot.sessions.find(row => row.hubId === id)).title, title);
        } finally { fs.renameSync(stateStore.STATE_FILE + '.held', stateStore.STATE_FILE); }
      } finally { if (child.connected) { child.kill(); await exited.catch(() => {}); } }
    });
  });
}
