'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { SessionManager } = require('../core/session-manager');
const store = require('../core/session-store');
const pool = require('../core/codeagent-pool');
const quota = require('../core/codeagent-quota');
const { buildSessionResumeMeta } = require('../core/session-capabilities');
const { createResumeSessionHandler, registerResumeSessionIpc } = require('../main/ipc/resume-session-handlers');
const { registerSessionIpc } = require('../main/ipc/session-handlers');
const picker = require('../core/codeagent-model-picker');
const { createModelCreationConfirmation } = require('../main/session-model-creation');

const MODEL = 'GLM-5.2-WX-Auto';
const NATIVE = '11111111-1111-4111-8111-111111111111';

for (const fixedModel of [undefined, MODEL]) {
  for (const modelConfirmationRequired of [undefined, false, true]) {
    test(`startup menu migration preserves explicit confirmation state (${fixedModel || 'legacy'}, ${modelConfirmationRequired})`, () => {
      const migrated = require('../core/session-model-pin').migrateModelPin({
        kind: 'codeagent', fixedModel, currentModel: { id: MODEL },
        codeagentModelPick: true, modelConfirmationRequired,
      });
      assert.equal(migrated.fixedModel, MODEL);
      assert.equal(migrated.modelConfirmationRequired, modelConfirmationRequired);
    });
  }
}

test('team member can restart, suspend, and resume through the sidebar IPC', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-resume-'));
  const dataDir = path.join(root, 'data');
  const personal = path.join(root, 'personal');
  const cwd = path.join(root, 'work');
  for (const dir of [dataDir, personal, cwd]) fs.mkdirSync(dir, { recursive: true });
  const env = { CLAUDE_HUB_DATA_DIR: dataDir, AI_HUB_CODEAGENT_CONFIG_DIR: personal,
    AI_HUB_CODEAGENT_COMMAND: 'member-resume-fixture', CLAUDE_HUB_HOME_DIR: path.join(root, 'home') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  require('../core/hub-config').clearConfigCache();
  const manager = new SessionManager();
  let finishRestartPick;
  t.after(() => {
    for (const entry of manager.sessions.values()) {
      for (const timer of entry.pendingTimers || []) clearTimeout(timer);
      entry.terminalSnapshot?.dispose();
    }
    for (const id of manager.openLeases?.keys() || []) manager._releaseOpenSession(id);
    manager.openOwners?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    require('../core/hub-config').clearConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(require('../core/codeagent-capabilities'), 'readHelp', () => '');
  t.mock.method(require('../core/codeagent-capabilities'), 'prepareForKind', async () => {});
  t.mock.method(require('../core/community-provider'), 'assertProviderAvailable', () => {});
  let picks = 0;
  t.mock.method(picker, 'pickModel', async () => {
    picks++;
    if (picks === 2) await new Promise(resolve => { finishRestartPick = resolve; });
    return { ok: true, confirmed: true };
  });
  t.mock.method(require('../core/pty-host'), 'spawnPty', () => {
    let exit;
    return { onData: () => ({ dispose() {} }), onExit: fn => { exit = fn; },
      write() {}, resize() {}, kill() { queueMicrotask(() => exit({ exitCode: 0 })); } };
  });
  const seed = (dir, accountId) => {
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: {
      accountId, xAuthToken: 'fixture-only', expiresAt: Date.now() + 3600000 } }));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: MODEL }));
    fs.writeFileSync(path.join(dir, '.cac.json'), '{}');
    require('../core/codeagent-model-probe').writeProbed(path.join(dir, 'hub-models.json'), {
      models: [MODEL], defaultModel: MODEL, source: 'test-fixture' });
  };
  seed(personal, 'personal');
  const account = pool.addAccount(dataDir);
  const accountDir = pool.accountDir(dataDir, account);
  seed(accountDir, 'member');
  const historyDir = path.join(accountDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(historyDir, { recursive: true });
  const history = path.join(historyDir, `${NATIVE}.jsonl`);
  fs.writeFileSync(history, '{}\n');
  const handlers = new Map(), events = [];
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), on() {} };
  const sendToRenderer = (name, payload) => events.push({ name, payload });
  const confirmation = createModelCreationConfirmation({ sendToRenderer });
  t.after(() => confirmation.cancelAll());
  const meetingManager = { getAllMeetings: () => [], getMeeting: () => null };
  const resumeSession = createResumeSessionHandler({ fs, os, path,
    getHubDataDir: () => dataDir, getHookPort: () => 0,
    isClaudeFamily: kind => /^codeagent(?:-resume)?$/.test(kind), isCodexBaseKind: () => false,
    findTranscriptByCCSessionId: () => history, sessionManager: manager, slotIds: [],
    meetingManager, registerSessionForTap() {}, sendToRenderer,
    requestModelConfirmation: confirmation.request });
  registerResumeSessionIpc(ipcMain, { resumeSession });
  registerSessionIpc(ipcMain, { sessionManager: manager, meetingManager, resumeSession, sendToRenderer });
  manager.onSessionSuspended = (sessionId, _meetingId, session) => sendToRenderer('session-suspended', { sessionId, session });
  const invoke = (name, arg) => handlers.get(name)(null, arg);
  quota.markModelAvoid(dataDir, account, { model: MODEL });
  quota.clearModelAvoid(dataDir, account);
  const created = await invoke('create-session', { kind: 'codeagent', opts: {
    id: 'member-0001', cwd, title: 'team member', codeagentAccount: 'pool',
    codeagentPoolPick: account, model: MODEL, codeagentModelPick: true, openInBackground: true } });
  await picker.waitForPick(created.id);
  manager.updateSessionMeta(created.id, { ccSessionId: NATIVE, transcriptPath: history, codeagentIdentityPending: false });
  const restarted = await invoke('restart-session', created.id);
  assert.notEqual(restarted.ok, false, restarted.message);
  await new Promise(setImmediate);
  assert.equal(typeof finishRestartPick, 'function');
  assert.equal(manager.getSession(created.id).codeagentModelPick, true);
  assert.equal(invoke('suspend-session', created.id).ok, true);
  await new Promise(setImmediate);
  const dormant = events.filter(event => event.name === 'session-suspended').at(-1).payload.session;
  assert.equal(dormant.status, 'dormant');
  assert.equal(invoke('session:open-status', created.id).available, true);
  const saved = store.loadSessionFile(created.id, { strict: true });
  assert.equal(saved.codeagentModelPick, true);
  assert.equal(saved.modelConfirmationRequired, undefined);
  // Let the old menu operation finish while the member is absent. It cannot
  // clear the marker in the snapshot already saved by suspend.
  finishRestartPick();
  await picker.waitForPick(created.id);
  events.length = 0;
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const createdStart = renderer.indexOf("ipcRenderer.on('session-created', async (_e, { session }) => {");
  const createdEnd = renderer.indexOf('  const activatedSession = sessions.get(session.id);', createdStart);
  const resumeStart = renderer.indexOf('async function resumeDormantSession(');
  const resumeEnd = renderer.indexOf('window.resumeDormantSession =', resumeStart);
  assert.ok(createdStart >= 0 && createdEnd > createdStart && resumeStart >= 0 && resumeEnd > resumeStart);
  const listeners = new Map();
  const context = { sessions: new Map([[created.id, dormant]]), activeSessionId: created.id,
    sessionOpenIntent: 1, _pendingDormantResumes: new Map(), buildSessionResumeMeta,
    ipcRenderer: { on: (name, handler) => listeners.set(name, handler), invoke },
    require: id => require(path.join(__dirname, '../renderer', id)),
    nativeSessionBootstrap: { record() {} }, codexAccountUi: { resumeCodexAccountRestart: () => false },
    paintSidebarResumePending() {}, scheduleSessionListRender() {}, schedulePersist() {},
    observeSessionRuntime() {}, RUNTIME_IDLE: 'idle', CONFIDENCE_AUTHORITATIVE: 'authoritative',
    sessionSplit: null, assistantPanel: { isOpen: () => false },
    document: { body: { classList: { contains: () => false } } } };
  vm.runInNewContext(renderer.slice(createdStart, createdEnd) + ' });\n' + renderer.slice(resumeStart, resumeEnd), context);
  const pending = context.resumeDormantSession(created.id, { selectIntent: 1 });
  pending.catch(() => {});
  await new Promise(setImmediate);
  const requests = events.filter(event => event.name === 'session-model-create-confirm');
  console.log('MEMBER_RESUME_BEFORE_EVENT', JSON.stringify({ savedPick: saved.codeagentModelPick,
    savedConfirmation: saved.modelConfirmationRequired ?? null, confirmations: requests.length,
    confirmationMessage: requests[0]?.payload.message,
    status: context.sessions.get(created.id).status, pending: context._pendingDormantResumes.has(created.id),
    events: events.map(event => event.name) }));
  assert.equal(requests.length, 0, 'a suspended startup menu must not require manual model confirmation');
  const resumed = await pending;
  await listeners.get('session-created')(null, events.find(event => event.name === 'session-created').payload);
  assert.equal(resumed.id, created.id);
  assert.equal(resumed.fixedModel, MODEL);
  assert.equal(resumed.ccSessionId, NATIVE);
  assert.equal(events.filter(event => event.name === 'session-created').length, 1);
  assert.equal(context.sessions.get(created.id).status, 'idle');
  assert.equal(context._pendingDormantResumes.has(created.id), false);
  await picker.waitForPick(created.id);
  console.log('MEMBER_RESUME', JSON.stringify({ returned: resumed.id, model: resumed.fixedModel,
    status: context.sessions.get(created.id).status, pending: context._pendingDormantResumes.has(created.id),
    events: events.map(event => event.name) }));
});
