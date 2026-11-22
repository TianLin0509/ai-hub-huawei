'use strict';
// Terminal/model tutorials never authorize metadata changes. Only the session's
// own transcript can confirm the actual model; Hub-driven picks stay separate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'node-pty') return { spawn() { throw Error('No real CLI in model observation tests'); } };
  return originalLoad.call(this, name, ...args);
};
const { SessionManager } = require('../core/session-manager');
Module._load = originalLoad;

const DS = 'DeepSeek-V4.1-Flash-1017', GLM = 'GLM-5.3-WX-Auto';
const MENU = '\x1b[2J  Select model  ✕\r\n  ❯ 1. DeepSeek-V4.1-Flash-1017 default ✓\r\n    2. GLM-5.3-WX-Auto\r\n';
const ECHO = id => `\x1b[2K  ⎿  Set model to \x1b[1m${id}\x1b[22m\r\n`;

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-terminal-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function json(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); }
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, { serveModels = [DS, GLM], providers = null } = {}) {
  const dir = temp(t), cfg = path.join(dir, 'personal'), sid = 'terminal-switch';
  json(path.join(cfg, 'settings.json'), { model: DS, ...(providers ? { enterprise: { providers } } : {}) });
  require('../core/codeagent-model-probe').writeProbed(require('../core/codeagent-pool').personalModelsFile(dir), { models: serveModels, defaultModel: DS, source: 'serve' });
  const file = path.join(dir, 'codeagent-launch', sid + '.json');
  json(file, { model: DS });
  const vars = { CLAUDE_HUB_DATA_DIR: dir, AI_HUB_CODEAGENT_CONFIG_DIR: cfg, AI_HUB_CODEAGENT_SERVE: '1' };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]])); Object.assign(process.env, vars);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const current = { id: sid, kind: 'codeagent', agentRuntime: 'pty', status: 'idle', codeagentConfigDir: cfg, fixedModel: DS, currentModel: { id: DS, displayName: DS } };
  const manager = Object.assign(new EventEmitter(), {
    sessions: new Map([[sid, { info: current, codeagentSettingsActive: true }]]),
    getSession: () => ({ ...current }), getAllSessions: () => [current], codeagentPoolActiveCounts: () => ({}),
    updateSessionMeta: (_sid, patch) => Object.assign(current, patch), writeToSession() {},
  });
  return { dir, cfg, sid, file, current, manager };
}
function register(manager, picker = null) {
  const ipcFile = path.join(__dirname, '..', 'main/ipc/session-handlers.js'), localRequire = createRequire(ipcFile);
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout, setImmediate,
    require: name => picker && name === '../../core/codeagent-model-picker' ? picker : localRequire(name) });
  vm.runInContext(fs.readFileSync(ipcFile, 'utf8'), context);
  const handlers = new Map(), events = new Map();
  context.module.exports.registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => events.set(name, fn) }, { sessionManager: manager, sendToRenderer() {} });
  handlers.type = (sessionId, data) => events.get('terminal-input')(null, { sessionId, data });
  return handlers;
}

function observer(f, extraRequire = null) {
  const file = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('async function observeCodeAgentModel('), end = source.indexOf('\n}\n', start) + 2;
  const localRequire = createRequire(file), events = [];
  const context = vm.createContext({ console, fs, path, codeAgentModelObservations: new WeakMap(),
    getHubDataDir: () => f.dir, sessionManager: f.manager, sessionStore: { markDirty() {} },
    sendToRenderer: (name, value) => events.push({ name, value }),
    require: name => extraRequire?.(name) || localRequire(name) });
  vm.runInContext(source.slice(start, end), context);
  return { refresh: (event = {}) => context.observeCodeAgentModel(f.sid, event), events };
}
function assistant(model, text = 'answer', extra = {}) {
  return { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', model,
    content: [{ type: 'text', text }] }, ...extra };
}
function transcript(f, entries) {
  f.current.transcriptPath = path.join(f.dir, 'transcript.jsonl');
  fs.writeFileSync(f.current.transcriptPath, entries.map(row => JSON.stringify(row)).join('\n') + '\n');
}

test('a bound assistant model follows GLM and updates the launch pin only after the turn ends', async t => {
  const f = fixture(t), ipc = register(f.manager), obs = observer(f);
  ipc.type(f.sid, '/model\r\x1b[B\r');
  f.manager.emit('output', { sessionId: f.sid, data: MENU + ECHO(GLM) });
  assert.equal(f.current.fixedModel, DS, 'no screen listener is registered');
  transcript(f, [assistant(DS), assistant(GLM)]);
  await obs.refresh({ modelId: DS });
  assert.equal(f.current.fixedModel, GLM, 'the file overrides stale event caches');
  assert.equal(f.current.currentModel.id, GLM);
  assert.equal(f.current.actualModel.id, GLM);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { model: GLM });
  const status = require('../core/session-actual-model').actualModelStatus(f.current);
  assert.ok(status.includes(GLM));
  assert.ok(status.includes('终端里已切到'));
  await obs.refresh();
  assert.equal(obs.events.filter(e => e.name === 'session-updated').length, 1, 'unchanged evidence is not written again');
});

test('no transcript, a missing model, synthetic entries and sidechains never infer a model from output or cached events', async t => {
  const f = fixture(t), obs = observer(f);
  await obs.refresh({ modelId: GLM });
  for (const entries of [[], [assistant(undefined)], [assistant('<synthetic>')], [assistant(GLM, 'subagent', { isSidechain: true })]]) {
    transcript(f, entries);
    await obs.refresh({ modelId: GLM });
    assert.equal(f.current.fixedModel, DS);
    assert.equal(f.current.actualModel, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { model: DS });
  }
});

test('a launch settings write failure still displays the confirmed model and leaves the old pin intact', async t => {
  const f = fixture(t);
  transcript(f, [assistant(GLM)]);
  const obs = observer(f, name => name === './core/session-manager' ? { _private: {
    writeCodeAgentLaunchSettings() { throw Error('read-only fixture'); },
  } } : null);
  await obs.refresh();
  assert.equal(f.current.actualModel.id, GLM);
  assert.equal(f.current.fixedModel, DS);
  assert.ok(obs.events.some(event => event.name === 'session-notice' && event.value.level === 'warning'));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { model: DS });
});

test('Auto aliases keep their usable launch name without claiming a terminal switch', async t => {
  const f = fixture(t), obs = observer(f);
  f.current.fixedModel = GLM; f.current.currentModel = { id: GLM };
  transcript(f, [assistant('maas-glm-5-3-260814')]);
  await obs.refresh();
  assert.equal(f.current.fixedModel, GLM);
  assert.equal(f.current.actualModel.id, 'maas-glm-5-3-260814');
  assert.equal(f.current.actualModel.terminalSwitch, undefined);
  transcript(f, [assistant('maas-glm-5-2-260617')]);
  await obs.refresh();
  assert.equal(f.current.fixedModel, GLM, 'Auto may route to another backend version');
  assert.equal(f.current.actualModel.id, 'maas-glm-5-2-260617');
  assert.equal(f.current.actualModel.terminalSwitch, undefined);
});

test('a stale answer from before a Hub Auto selection cannot undo that choice', async t => {
  const f = fixture(t), obs = observer(f);
  f.current.fixedModel = GLM; f.current.currentModel = { id: GLM };
  require('../core/codeagent-models').expectModelSwitch(f.sid, GLM);
  transcript(f, [assistant(DS, 'older answer', { timestamp: new Date(Date.now() - 60000).toISOString() })]);
  await obs.refresh();
  assert.equal(f.current.fixedModel, GLM);
  assert.equal(f.current.actualModel, undefined);
  transcript(f, [assistant('maas-glm-5-3-260814')]);
  await obs.refresh();
  assert.equal(f.current.fixedModel, GLM);
  assert.equal(f.current.actualModel.id, 'maas-glm-5-3-260814');
});

test('tutorials, fragmented menus, suffix /model questions and cancelled menus cannot change any model fields', async t => {
  const f = fixture(t), ipc = register(f.manager), obs = observer(f);
  transcript(f, [assistant(DS, 'Select model; Set model to ' + GLM)]);
  for (const input of ['Please explain /model\r', '/model\r\x1b\r', '/model\r\x03\r', '/model\r\n\r']) {
    ipc.type(f.sid, input);
    for (const data of [...(MENU + ECHO(GLM))]) f.manager.emit('output', { sessionId: f.sid, data });
    await obs.refresh();
    assert.equal(f.current.fixedModel, DS);
    assert.equal(f.current.currentModel.id, DS);
    assert.equal(f.current.actualModel.id, DS);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { model: DS });
  }
});

test('an in-flight read cannot overwrite a newer selection, writer or execution epoch', async t => {
  for (const change of ['model', 'writer', 'epoch', 'path', 'closed', 'identity']) {
    const f = fixture(t);
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const obs = observer(f, name => name === './core/session-actual-model'
      ? { ...require('../core/session-actual-model'), readActualModel: () => pending } : null);
    const result = obs.refresh();
    if (change === 'model') { f.current.currentModel = { id: 'newer-model' }; f.current.fixedModel = 'newer-model'; }
    if (change === 'writer') f.manager.sessions.set(f.sid, { info: f.current });
    if (change === 'epoch') f.manager.sessions.get(f.sid).modelSubmissionEpoch = 1;
    if (change === 'path') f.current.transcriptPath = 'new-path';
    if (change === 'closed') f.current.status = 'closed';
    if (change === 'identity') f.current.ccSessionId = 'new-native-id';
    release({ model: GLM, ts: Date.now() }); await result;
    assert.equal(f.current.actualModel, undefined, change);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { model: DS }, change);
  }
});

test('Claude and Codex use their existing transcript formats, and a later context without an answer is not evidence', async t => {
  const f = fixture(t), obs = observer(f);
  f.current.kind = 'claude';
  transcript(f, [assistant('claude-sonnet-4-6'), assistant('claude-opus-4-6')]);
  await obs.refresh(); assert.equal(f.current.fixedModel, 'claude-opus-4-6');
  f.current.kind = 'codex';
  f.current.codexSid = '11111111-1111-4111-8111-111111111111';
  const stamp = new Date().toISOString();
  transcript(f, [
    { type: 'session_meta', payload: { id: f.current.codexSid, cwd: f.dir } },
    { timestamp: stamp, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn1' } },
    { type: 'turn_context', payload: { turn_id: 'turn1', model: 'gpt-5.2' } },
    { timestamp: stamp, type: 'event_msg', payload: { type: 'agent_message', message: 'answer', phase: 'final_answer', turn_id: 'turn1' } },
    { timestamp: stamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn1' } },
    { type: 'turn_context', payload: { turn_id: 'turn2', model: 'gpt-5.3' } },
  ]);
  await obs.refresh(); assert.equal(f.current.fixedModel, 'gpt-5.2');
  f.current.codexSid = '22222222-2222-4222-8222-222222222222';
  await obs.refresh(); assert.equal(f.current.fixedModel, 'gpt-5.2', 'wrong session identity is rejected');
});

for (const [kind, old, next] of [
  ['claude', 'claude-sonnet-4-6', 'claude-opus-4-6'],
  ['codex', 'gpt-5.2', 'gpt-5.3'],
]) test(`${kind}: a new observation after Hub confirmation cannot replay a pre-switch answer`, async t => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  Object.assign(f.current, { kind, fixedModel: old, currentModel: { id: old },
    codexSid: '11111111-1111-4111-8111-111111111111' });
  // Exercise the real metadata commit, not a test-only approximation of its barrier.
  Object.assign(f.manager, { updateSessionMeta: SessionManager.prototype.updateSessionMeta,
    _refreshOpenIdentity() {}, _toPublic: info => ({ ...info }) });
  const ipc = register(f.manager);
  const entries = [];
  let turn = 0;
  const answer = (model, at) => {
    const timestamp = at === undefined ? undefined : new Date(at).toISOString();
    const turn_id = `turn${++turn}`;
    entries.push(...(kind === 'claude' ? [assistant(model, 'answer', { timestamp })] : [
      { type: 'session_meta', payload: { id: f.current.codexSid, cwd: f.dir } },
      { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id } },
      { type: 'turn_context', payload: { turn_id, model } },
      { timestamp, type: 'event_msg', payload: { type: 'agent_message', message: 'answer', phase: 'final_answer', turn_id } },
      { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id } },
    ]));
    transcript(f, entries);
  };
  answer(old, now - 60000);
  await observer(f).refresh();
  assert.equal(f.current.actualModel.id, old);
  assert.equal((await ipc.get('confirm-session-model-switch')(null, { sessionId: f.sid, modelId: next })).ok, true);
  const selected = JSON.parse(JSON.stringify(f.current));
  // A new observer/epoch starts AFTER confirmation, so an in-flight read guard cannot help.
  f.manager.sessions.get(f.sid).modelSubmissionEpoch = 1;
  const obs = observer(f);
  await obs.refresh();
  assert.equal(f.current.fixedModel, next);
  assert.equal(f.current.currentModel.id, next);
  assert.equal(f.current.modelPinSource, 'user');
  assert.deepEqual(f.current.actualModel, selected.actualModel);
  assert.equal(obs.events.length, 0, 'stale evidence produces no metadata update');
  for (const at of [now, undefined]) {
    answer(old, at);
    await obs.refresh();
    assert.equal(f.current.fixedModel, next, 'equal or missing timestamps cannot confirm a post-switch answer');
    assert.equal(f.current.modelPinSource, 'user');
  }
  answer(next, now + 1);
  await obs.refresh();
  assert.equal(f.current.actualModel.id, next, 'a genuinely newer answer is accepted');
  answer(old, now + 2);
  await obs.refresh();
  assert.equal(f.current.fixedModel, old, 'a later terminal switch still follows actual evidence');
  assert.equal(f.current.modelPinSource, 'cli');
  // The latest confirmation replaces the floor; it is not consumed by a fresh answer.
  now += 1000;
  assert.equal((await ipc.get('confirm-session-model-switch')(null, { sessionId: f.sid, modelId: next })).ok, true);
  answer(old, now - 1);
  await obs.refresh();
  assert.equal(f.current.fixedModel, next);
  assert.equal(f.current.modelPinSource, 'user');
  answer(next, now + 1);
  await obs.refresh();
  answer(old, now - 60000);
  await obs.refresh();
  assert.equal(f.current.fixedModel, next, 'the barrier remains after a successful observation');
  assert.equal(f.current.actualModel.id, next);
  const store = require('../core/session-store');
  store.saveSessionFile(f.sid, f.current);
  const saved = store.loadSessionFile(f.sid, { strict: true });
  assert.equal(saved.modelSwitchConfirmedAt, now);
  assert.equal(require('../core/session-capabilities').buildSessionResumeMeta(saved).modelSwitchConfirmedAt, now);
  Object.assign(f.current, saved);
  await observer(f).refresh();
  assert.equal(f.current.fixedModel, next, 'a restored session retains the confirmation floor');
});

// Keep the real creation wrapper, model-info initializer, projection and disk
// writes; only process creation, provider probes and identity leases are stubbed.
function resumeFixture(t, f) {
  const managerFile = path.join(__dirname, '../core/session-manager.js');
  const source = fs.readFileSync(managerFile, 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('    const info = {', source.indexOf('  _createSession('));
  const end = source.indexOf('\n      kind,', start) + '\n      kind,'.length;
  assert.ok(start > 0 && end > start);
  const initialize = new Function('require', 'id', 'kind', 'opts', 'currentModel',
    source.slice(start, end) + '\n currentModel }; return info;');
  const localRequire = createRequire(managerFile);
  t.mock.method(require('../core/cli-capabilities'), 'providerForKind', () => false);
  t.mock.method(require('../core/company-ai-policy'), 'assertKind', () => {});
  t.mock.method(require('../core/community-provider'), 'assertProviderAvailable', () => {});
  t.mock.method(require('../core/company-api-config'), 'assertLaunchConfigured', () => {});
  const launches = [];
  Object.assign(f.manager, {
    sessions: new Map(), openLeases: new Map(), reserveSessionOpen() {}, cancelReservedOpen() {},
    _releaseOpenSession() {}, _refreshOpenIdentity() {},
    createSession: SessionManager.prototype.createSession,
    updateSessionMeta: SessionManager.prototype.updateSessionMeta,
    _toPublic: SessionManager.prototype._toPublic,
    _withExtraMcp: (_kind, opts) => opts,
    _createSession(kind, opts) {
      launches.push(opts);
      const info = initialize(localRequire, opts.id, kind, opts, { id: opts.model, displayName: opts.model });
      Object.assign(info, { status: 'idle', agentRuntime: 'pty', cwd: opts.cwd,
        transcriptPath: opts.resumeTranscriptPath,
        ccSessionId: opts.resumeCCSessionId, codexSid: opts.codexSid });
      f.current = info;
      this.sessions.set(opts.id, { info });
      return this._toPublic(info);
    },
    getSession(id) { const info = this.sessions.get(id)?.info; return info ? { ...info } : null; },
  });
  const resume = require('../main/ipc/resume-session-handlers').createResumeSessionHandler({
    fs, os, path, getHubDataDir: () => f.dir, getHookPort: () => 0, sessionManager: f.manager,
    meetingManager: { getAllMeetings: () => [], getMeeting: () => null }, slotIds: [],
    isClaudeFamily: kind => /^claude(?:-resume)?$/.test(kind),
    isCodexBaseKind: kind => /^codex(?:-resume)?$/.test(kind),
    findTranscriptByCCSessionId: () => f.current.transcriptPath,
    findCodexRolloutBySid: () => f.current.transcriptPath, defaultCodexSessionsRoot: f.dir,
    registerSessionForTap() {}, sendToRenderer() {},
  });
  return { resume, launches };
}

for (const [kind, old, next] of [
  ['claude', 'claude-sonnet-4-6', 'claude-opus-4-6'],
  ['codex', 'gpt-5.2', 'gpt-5.3'],
]) for (const floor of ['absent', 'older', 'fresh']) for (const override of floor === 'fresh' ? [false] : [true, false]) {
  test(`${kind}: ${override ? 'explicit model resume renews' : 'ordinary resume preserves'} an ${floor} confirmation floor`, async t => {
    const f = fixture(t), now = Date.now(), native = '11111111-1111-4111-8111-111111111111';
    t.mock.method(Date, 'now', () => now);
    const savedFloor = floor === 'absent' ? undefined : now - (floor === 'older' ? 120000 : 1000);
    Object.assign(f.current, { kind, fixedModel: old, currentModel: { id: old }, modelPinSource: 'user',
      actualModel: { id: old, launchModel: old }, ccSessionId: kind === 'claude' ? native : undefined,
      codexSid: kind === 'codex' ? native : undefined, cwd: f.dir,
      ...(savedFloor ? { modelSwitchConfirmedAt: savedFloor } : {}) });
    const rows = [];
    let turn = 0;
    const answer = (model, at) => {
      const timestamp = new Date(at).toISOString(), turn_id = `resume-turn-${++turn}`;
      rows.push(...(kind === 'claude' ? [assistant(model, 'answer', { timestamp })] : [
        { type: 'session_meta', payload: { id: native, cwd: f.dir } },
        { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id } },
        { type: 'turn_context', payload: { turn_id, model } },
        { timestamp, type: 'event_msg', payload: { type: 'agent_message', message: 'answer', phase: 'final_answer', turn_id } },
        { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id } },
      ]));
      transcript(f, rows);
    };
    answer(old, now - 60000);
    const store = require('../core/session-store'), history = f.current.transcriptPath;
    store.saveSessionFile(f.sid, { ...f.current, status: 'dormant' });
    const { resume, launches } = resumeFixture(t, f);
    const created = await resume({ hubId: f.sid, ...(override ? { launchOverrides: { model: next } } : {}) });
    const expected = override ? next : old, expectedFloor = override ? now : savedFloor;
    assert.equal(created.fixedModel, expected);
    assert.equal(created.modelSwitchConfirmedAt, expectedFloor);
    assert.equal(launches[0].modelSwitchConfirmedAt, expectedFloor, 'floor is present before tap registration');
    assert.equal(created.transcriptPath, history);
    assert.equal(kind === 'claude' ? created.ccSessionId : created.codexSid, native);
    const persisted = store.loadSessionFile(f.sid, { strict: true });
    assert.equal(persisted.modelSwitchConfirmedAt, expectedFloor);
    assert.equal(require('../core/session-capabilities').buildSessionResumeMeta(persisted).modelSwitchConfirmedAt, expectedFloor);
    const obs = observer(f);
    await obs.refresh();
    assert.equal(f.current.fixedModel, expected, 'a newly started read of the old answer must preserve the selection');
    assert.equal(f.current.currentModel.id, expected);
    assert.equal(f.current.modelPinSource, 'user');
    if (override) assert.equal(obs.events.length, 0);
    // Ordinary resume must not introduce a floor that hides legitimate evidence.
    answer(next, now + 1);
    await obs.refresh();
    assert.equal(f.current.fixedModel, next);
    assert.equal(f.current.actualModel.id, next);
    answer(old, now + 2);
    await obs.refresh();
    assert.equal(f.current.fixedModel, old, 'a genuinely later terminal switch is still followed');
  });
}

test('a failed explicit resume does not persist the new selection or its confirmation floor', async t => {
  const f = fixture(t), store = require('../core/session-store');
  Object.assign(f.current, { kind: 'claude', fixedModel: 'claude-sonnet-4-6',
    currentModel: { id: 'claude-sonnet-4-6' }, modelPinSource: 'user',
    modelSwitchConfirmedAt: Date.now() - 120000, cwd: f.dir,
    ccSessionId: '11111111-1111-4111-8111-111111111111' });
  transcript(f, []);
  store.saveSessionFile(f.sid, { ...f.current, status: 'dormant' });
  const before = store.loadSessionFile(f.sid, { strict: true });
  const { resume } = resumeFixture(t, f);
  t.mock.method(f.manager, '_createSession', () => { throw Error('synthetic creation failure'); });
  await assert.rejects(resume({ hubId: f.sid, launchOverrides: { model: 'claude-opus-4-6' } }), /synthetic creation failure/);
  assert.deepEqual(store.loadSessionFile(f.sid, { strict: true }), before);
  assert.equal(f.manager.sessions.size, 0);
});

test('actual model evidence survives disk and public metadata projection', t => {
  const f = fixture(t), actualModel = { id: GLM, launchModel: DS };
  const store = require('../core/session-store');
  store.saveSessionFile(f.sid, { ...f.current, actualModel });
  const saved = store.loadSessionFile(f.sid, { strict: true });
  assert.deepEqual(saved.actualModel, actualModel);
  assert.deepEqual(require('../core/session-model-pin').modelPinFields(saved).actualModel, actualModel);
});

test('a Hub switch confirmed by the menu but not spellable for --settings releases the old pinned model', async t => {
  const f = fixture(t, { serveModels: [DS], providers: { axon: { mainModel: 'glm-5.3' } } });
  const real = require('../core/codeagent-model-picker');
  const picker = { ...real, pickModel: async () => ({ ok: true, mode: 'session', confirmed: true }) };
  const handlers = register(f.manager, picker);
  const result = await handlers.get('codeagent:switch-model')(null, { sessionId: f.sid, modelId: 'glm-5.3' });
  assert.equal(result.ok, true);
  assert.notEqual(result.mode, 'settings-only');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), {}, 'before the fix the file still said DeepSeek and every request used it');
  assert.match(fs.readFileSync(path.join(f.dir, 'logs/codeagent-model.log'), 'utf8'), /event=launch-settings-released/);
});

test('answer text containing a model-menu tutorial never changes the pinned model or the settings file (R-04)', async t => {
  const f = fixture(t);
  register(f.manager);
  f.manager.emit('output', { sessionId: f.sid, data: '换模型的方法：在终端输入 /model，弹出\r\n' + MENU + '回车后会显示\r\n' + ECHO(GLM) });
  await tick(700);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { model: DS });
  assert.equal(f.current.fixedModel, DS);
  assert.equal(f.current.currentModel.id, DS);
});

// 审核 R-04 第二轮（04bdd503c）：取消菜单后监听没清，两分钟内任意回车都被当成菜单确认；CRLF 的 LF 又被算成第二次回车。
// The five original cancel probes still traverse terminal-input IPC; no output
// watcher remains, so neither keys nor menu-shaped output can change metadata.
const PROMPT = '\x1b[2J\x1b[H> Anything I can assist you with?\r\n';
const TUTORIAL = 'To change models, open Select model. The confirmation message is Set model to ' + GLM + '. This is documentation only.\r\n';
for (const c of [
  { name: 'Esc closes the menu, then a normal question + tutorial answer', open: '/model\r', cancel: '\x1b', question: 'Please explain model switching\r' },
  { name: 'Ctrl+C closes the menu, then a normal question + tutorial answer', open: '/model\r', cancel: '\x03', question: 'Please explain model switching\r' },
  { name: 'Esc closes the menu and nothing else is typed', open: '/model\r', cancel: '\x1b', question: '' },
  { name: 'a single CRLF submit of /model, then Esc + tutorial', open: '/model\r\n', cancel: '\x1b', question: '' },
  { name: 'a single CRLF submit of /model with no selection + tutorial', open: '/model\r\n', cancel: '', question: '' },
]) {
  test(`R-04 cancel: ${c.name} keeps the pinned model`, async t => {
    const f = fixture(t);
    const ipc = register(f.manager);
    ipc.type(f.sid, c.open); f.manager.emit('output', { sessionId: f.sid, data: MENU });
    if (c.cancel) { ipc.type(f.sid, c.cancel); f.manager.emit('output', { sessionId: f.sid, data: PROMPT }); }
    if (c.question) ipc.type(f.sid, c.question);
    f.manager.emit('output', { sessionId: f.sid, data: TUTORIAL });
    await tick(650);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { model: DS });
    assert.equal(f.current.fixedModel, DS);
    assert.equal(f.current.currentModel.id, DS);
  });
}
