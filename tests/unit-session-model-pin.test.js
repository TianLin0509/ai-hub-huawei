'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (id, ...args) {
  if (id === 'node-pty') return { spawn() { throw Error('No real CLI in model pin tests'); } };
  return originalLoad.call(this, id, ...args);
};
const { _private, SessionManager } = require('../core/session-manager');
Module._load = originalLoad;
const models = require('../core/codeagent-models');
const store = require('../core/session-store');
const hubConfig = require('../core/hub-config');
const pool = require('../core/codeagent-pool');
const caps = require('../core/codeagent-capabilities');
const { sessionModelId, buildSessionResumeMeta } = require('../core/session-capabilities');
const { createResumeSessionHandler } = require('../main/ipc/resume-session-handlers');
const OLD = 'GLM-5.2-WX-Auto';
const NEXT = 'GLM-5.3-WX-Auto';
const NATIVE = '11111111-1111-4111-8111-111111111111';

function fixture(t, { ids = [OLD, NEXT], policy, help = '', confirmation } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-pin-'));
  const dataDir = path.join(root, 'hub'), configDir = path.join(root, 'cac'), cwd = path.join(root, 'project');
  for (const dir of [dataDir, configDir, cwd]) fs.mkdirSync(dir, { recursive: true });
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  hubConfig.clearConfigCache();
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR;
    else process.env.CLAUDE_HUB_DATA_DIR = before;
    hubConfig.clearConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(caps, 'readHelp', () => help);
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  write(path.join(configDir, 'settings.json'), { model: NEXT });
  write(pool.personalModelsFile(dataDir), { source: 'serve', models: ids, at: new Date().toISOString() });
  if (policy) write(path.join(dataDir, 'config.json'), { experiments: { sessionModelUnavailablePolicy: policy } });
  const history = path.join(configDir, 'projects', 'fixture', NATIVE + '.jsonl');
  write(history, {});
  const launch = (id, opts) => _private.buildCodeAgentPtyLaunch(id, 'codeagent', { mcpProfile: 'full', ...opts }, cwd,
    { HOME: root, USERPROFILE: root }, { command: 'never-run', configDir });
  const calls = [], events = [];
  const manager = { getSession: () => null, createSession(kind, opts) {
    const built = launch(opts.id, opts); calls.push({ opts, built });
    return { id: opts.id, kind, ...opts, fixedModel: built.fixedModel };
  } };
  const meeting = { id: 'room', groupChat: true };
  const resume = createResumeSessionHandler({ fs, os, path, getHubDataDir: () => dataDir, getHookPort: () => 0,
    isClaudeFamily: kind => /^codeagent(?:-resume)?$/.test(kind), isCodexBaseKind: () => false,
    findTranscriptByCCSessionId: () => history, sessionManager: manager, slotIds: [],
    meetingManager: { getAllMeetings: () => [meeting], getMeeting: () => meeting }, requestModelConfirmation: confirmation, registerSessionForTap() {}, sendToRenderer: (name, payload) => events.push({ name, payload }) });
  return { root, dataDir, configDir, cwd, write, launch, resume, calls, manager, events };
}

for (const mode of ['ordinary', 'group', 'team']) test(`${mode} resume pins its saved model without opening the model menu`, async t => {
  const f = fixture(t);
  store.saveSessionFile(mode, { kind: 'codeagent', cwd: f.cwd, ccSessionId: NATIVE,
    fixedModel: OLD, modelPinSource: 'user', currentModel: { id: NEXT },
    ...(mode === 'group' ? { meetingId: 'room' } : {}) });
  await f.resume({ hubId: mode });
  const { opts, built } = f.calls.at(-1);
  assert.equal(opts.model, OLD);
  assert.equal(opts.codeagentModelPick, false);
  assert.equal(built.settingsModel, OLD);
  assert.match(built.cmd, /--resume/);
  assert.match(built.cmd, /--settings/);
});

test('the selected pin and manual selection marker survive disk reload and restart metadata', t => {
  fixture(t);
  const selected = { id: 'persisted', kind: 'codeagent', fixedModel: OLD, modelPinSource: 'user',
    codeagentUserModel: OLD, currentModel: { id: NEXT } };
  store.saveSessionFile(selected.id, selected);
  const saved = store.loadSessionFile(selected.id, { strict: true });
  assert.equal(saved.fixedModel, OLD);
  assert.equal(saved.codeagentUserModel, OLD);
  const restarted = buildSessionResumeMeta(saved);
  assert.equal(restarted.fixedModel, OLD);
  assert.equal(restarted.codeagentUserModel, OLD);
  assert.equal(sessionModelId(saved), OLD);
});

test('a different actual answer never replaces the selected fixed model', () => {
  const current = { id: 'observed', kind: 'codeagent', fixedModel: OLD, currentModel: { id: OLD } };
  const observed = models.observeModel(current, 'MiniMax-M2.7');
  Object.assign(current, observed.fields);
  assert.equal(current.codeagentActualModel, 'MiniMax-M2.7');
  assert.equal(current.fixedModel, OLD);
  assert.equal(sessionModelId(current), OLD);
  assert.equal(current.currentModel.id, OLD);
  assert.match(models.mismatchNotice(observed.mismatch), /仍固定/);
});

test('default policy replaces an unavailable pin and records a visible reason', t => {
  const f = fixture(t, { ids: [NEXT] });
  const launch = f.launch('auto', { fixedModel: OLD, model: OLD, codeagentModelPick: false });
  assert.equal(launch.fixedModel, NEXT);
  assert.equal(launch.settingsModel, NEXT);
  assert.equal(launch.modelChange.from, OLD);
  assert.equal(launch.modelChange.to, NEXT);
  assert.match(launch.modelChange.reason, /清单|权限/);
});

test('stop-and-ask refuses an unavailable pin before launching', t => {
  const f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask' });
  assert.throws(() => f.launch('stop', { fixedModel: OLD, model: OLD }), error =>
    error.code === 'SESSION_MODEL_UNAVAILABLE' && error.notSent === true && /手动选择/.test(error.message));
});

test('unsupported settings obeys stop-and-ask', t => {
  const f = fixture(t, { policy: 'stop-and-ask', help: '--resume <id> --permission-mode <mode>' });
  assert.throws(() => f.launch('old-cli', { fixedModel: OLD, model: OLD }), error =>
    error.code === 'SESSION_MODEL_UNAVAILABLE' && /settings|版本/.test(error.message));
});

for (const source of ['user', 'current']) test(`legacy session migrates from ${source} with its source recorded`, async t => {
  const f = fixture(t);
  store.saveSessionFile('legacy', { kind: 'codeagent', cwd: f.cwd, ccSessionId: NATIVE,
    currentModel: { id: NEXT }, ...(source === 'user' ? { codeagentUserModel: OLD } : {}) });
  await f.resume({ hubId: 'legacy' });
  const { opts } = f.calls.at(-1);
  assert.equal(opts.fixedModel, source === 'user' ? OLD : NEXT);
  assert.equal(opts.modelPinSource, source === 'user' ? 'legacy-user' : 'legacy-current');
});

test('settings policy defaults and partial updates round-trip without clearing other experiments', t => {
  const f = fixture(t);
  const config = require('../main/ipc/config-handlers');
  assert.equal(config.toEditableConfig({}).sessionModelUnavailablePolicy, 'auto-switch-notify');
  const saved = config.buildConfigJsonUpdate({ experiments: { codeagentPrefixBranch: false } }, { sessionModelUnavailablePolicy: 'stop-and-ask' });
  assert.equal(saved.experiments.sessionModelUnavailablePolicy, 'stop-and-ask');
  assert.equal(saved.experiments.codeagentPrefixBranch, false);
  f.write(path.join(f.dataDir, 'config.json'), saved); hubConfig.clearConfigCache();
  assert.equal(hubConfig.getConfig().sessionModelUnavailablePolicy, 'stop-and-ask');
  assert.equal(config.toMaskedConfig(hubConfig.getConfig()).sessionModelUnavailablePolicy, 'stop-and-ask');
});

for (const policy of ['auto-switch-notify', 'stop-and-ask']) test(`a live session checks model permission again before sending (${policy})`, async t => {
  const f = fixture(t, { policy });
  f.launch('live', { fixedModel: OLD, model: OLD });
  f.write(pool.personalModelsFile(f.dataDir), { source: 'serve', models: [NEXT] });
  const manager = Object.create(SessionManager.prototype);
  require('node:events').EventEmitter.call(manager);
  manager._refreshOpenIdentity = () => {};
  const info = { id: 'live', kind: 'codeagent', fixedModel: OLD, currentModel: { id: OLD },
    cwd: f.cwd, codeagentConfigDir: f.configDir };
  manager.sessions = new Map([['live', { info, codeagentSettingsActive: true }]]);
  const notices = [];
  manager.on('session-notice', notice => notices.push(notice));
  assert.equal(typeof manager.ensureSessionModelReady, 'function');
  if (policy === 'stop-and-ask') {
    await assert.rejects(manager.ensureSessionModelReady('live'), { code: 'SESSION_MODEL_UNAVAILABLE', notSent: true });
    assert.equal(info.fixedModel, OLD);
    assert.equal(notices.at(-1).originalModel, OLD);
    assert.equal(notices.at(-1).suggestedModel, NEXT);
  } else {
    await manager.ensureSessionModelReady('live');
    assert.equal(info.fixedModel, NEXT);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'codeagent-launch', 'live.json'))).model, NEXT);
    assert.equal(store.loadSessionFile('live', { strict: true }).fixedModel, NEXT);
    assert.equal(notices.at(-1).persistent, true);
    assert.match(notices.at(-1).message, /原模型.*已换成/);
  }
});

test('a successful manual model change replaces the fixed model through the real IPC', async t => {
  const f = fixture(t);
  const current = { id: 'manual', kind: 'codeagent', status: 'idle', codeagentConfigDir: f.configDir,
    fixedModel: OLD, currentModel: { id: OLD } };
  const manager = { getSession: () => current, updateSessionMeta: (_id, fields) => Object.assign(current, fields) };
  const picker = require('../core/codeagent-model-picker');
  t.mock.method(picker, 'pickModel', async () => ({ ok: true, confirmed: true }));
  const handlers = new Map();
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} },
    { sessionManager: manager, sendToRenderer() {} });
  const result = await handlers.get('codeagent:switch-model')(null, { sessionId: 'manual', modelId: NEXT });
  assert.equal(result.ok, true);
  assert.equal(current.fixedModel, NEXT);
  assert.equal(current.modelPinSource, 'user');
});

test('native Codex configure records the user-selected model as its new pin', async t => {
  fixture(t);
  const current = { id: 'native', kind: 'codex', fixedModel: 'gpt-5.5', currentModel: { id: 'gpt-5.5' } };
  const manager = { getSession: () => current, getNativeSession: () => ({ configure: async () => ({ modelId: 'gpt-5.4' }) }),
    updateSessionMeta: (_id, fields) => Object.assign(current, fields) };
  const handlers = new Map();
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} },
    { sessionManager: manager, sendToRenderer() {} });
  const result = await handlers.get('codex:native-action')(null, { sessionId: 'native', action: 'configure', model: 'gpt-5.4' });
  assert.equal(result.ok, true);
  assert.equal(current.fixedModel, 'gpt-5.4');
});

test('starting another session does not delete an old but still active model settings file', t => {
  const f = fixture(t);
  f.launch('long-lived', { fixedModel: OLD });
  const file = path.join(f.dataDir, 'codeagent-launch', 'long-lived.json');
  const past = new Date(Date.now() - 10 * 86400000);
  fs.utimesSync(file, past, past);
  f.launch('new', { fixedModel: NEXT });
  assert.equal(fs.existsSync(file), true);
});

test('original relaunch uses the pinned model even if the latest observed model differs', t => {
  const f = fixture(t), writes = [], events = [];
  const manager = Object.create(SessionManager.prototype);
  const info = { id: 'relaunch', kind: 'codeagent', fixedModel: OLD, currentModel: { id: NEXT }, cwd: f.cwd,
    codeagentConfigDir: f.configDir, mcpProfile: 'full' };
  manager.sessions = new Map([['relaunch', { info, pty: { options: { env: { USERPROFILE: f.root, HOME: f.root } }, write: cmd => writes.push(cmd) } }]]);
  manager.hubRulesSystemPrompt = () => null;
  manager.emit = (...args) => events.push(args);
  assert.equal(manager.relaunchCli('relaunch'), true);
  assert.match(writes[0], /--settings/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'codeagent-launch', 'relaunch.json'))).model, OLD);
  assert.equal(events.some(event => event[0] === 'codeagent-model-pick'), false);
});

test('an untouched default selection resolves the account default when creating its pin', t => {
  const f = fixture(t);
  assert.equal(f.launch('default', { model: OLD, codeagentModelPick: false }).fixedModel, NEXT);
});

test('the stop notice can recover a dormant session after the user selects an available model', async t => {
  const f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask' });
  store.saveSessionFile('sleeping', { kind: 'codeagent', cwd: f.cwd, ccSessionId: NATIVE,
    fixedModel: OLD, codeagentUserModel: OLD, currentModel: { id: OLD } });
  const handlers = new Map();
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} },
    { sessionManager: { getSession: () => null }, resumeSession: f.resume, sendToRenderer() {} });
  const result = await handlers.get('codeagent:switch-model')(null, { sessionId: 'sleeping', modelId: NEXT });
  assert.equal(result.ok, true);
  assert.equal(result.model.id, NEXT);
  assert.equal(f.calls.at(-1).built.settingsModel, NEXT);
  assert.equal(f.calls.at(-1).opts.codeagentUserModel, NEXT);
});

function fakeDocument() {
  const byId = new Map();
  const make = tag => ({ tagName: tag, style: {}, dataset: {}, children: [], listeners: {}, value: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(child) { child.parent = this; this.children.push(child); if (child.id) byId.set(child.id, child); return child; },
    append(...children) { children.forEach(child => this.appendChild(child)); },
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); },
    querySelectorAll() { return []; },
  });
  return { body: make('body'), readyState: 'loading', createElement: make,
    getElementById: id => byId.get(id) || null, querySelectorAll: () => [], addEventListener() {}, dispatchEvent() {},
    element(id) { const element = make('div'); element.id = id; byId.set(id, element); return element; } };
}

test('the persistent unavailable notice lets the user select and retry', async () => {
  const notices = require('../renderer/sticky-notice');
  assert.equal(typeof notices.showUnavailableModelNotice, 'function');
  const document = fakeDocument(), selected = [];
  const notice = notices.showUnavailableModelNotice(document, { sessionId: 'sleeping', message: '原模型不可用', availableModels: [NEXT] },
    async model => { selected.push(model); return { ok: true }; });
  const { select, confirm: button } = notice.modelParts;
  select.value = NEXT;
  await button.listeners.click();
  assert.deepEqual(selected, [NEXT]);
  assert.equal(document.body.children[0].children.length, 0);
});

test('the settings form loads, changes and saves the model failure policy', async () => {
  const document = fakeDocument();
  // The actual controller expects the existing settings form's elements.
  const source = fs.readFileSync(path.join(__dirname, '../renderer/config-modal.js'), 'utf8');
  for (const match of source.matchAll(/(?:configEl|getElementById)\('([^']+)'\)/g)) document.element(match[1]);
  document.element('cfg-model-unavailable-policy');
  const saves = [];
  const controller = require('../renderer/config-modal').createConfigModalController({ document, providerModes: {}, renderAccountUsage() {},
    ipcRenderer: { async invoke(name, value) {
      if (name === 'get-hub-config-raw') return { sessionModelUnavailablePolicy: 'stop-and-ask' };
      if (name === 'save-hub-config') { saves.push(value); return { success: true }; }
      return {};
    } } });
  controller.init();
  await controller.open();
  assert.equal(document.getElementById('cfg-model-unavailable-policy').value, 'stop-and-ask');
  document.getElementById('cfg-model-unavailable-policy').value = 'auto-switch-notify';
  await document.getElementById('config-save').listeners.click();
  assert.equal(saves[0].sessionModelUnavailablePolicy, 'auto-switch-notify');
});

for (const policy of ['auto-switch-notify', 'stop-and-ask']) test(`a failed startup menu obeys the policy for pinned sessions (${policy})`, async t => {
  const f = fixture(t, { policy });
  const picker = require('../core/codeagent-model-picker');
  t.mock.method(picker, 'pickModel', async () => ({ ok: false, inputReady: true, message: 'menu target missing' }));
  const current = { id: 'menu-failure', kind: 'codeagent', fixedModel: OLD, currentModel: { id: OLD }, codeagentConfigDir: f.configDir };
  const listeners = new Map(), notices = [];
  const manager = { getSession: () => current, on: (name, fn) => listeners.set(name, fn), updateSessionMeta: (_id, fields) => Object.assign(current, fields) };
  require('../main/ipc/session-handlers').registerSessionIpc({ handle() {}, on() {} }, { sessionManager: manager,
    sendToRenderer: (name, payload) => { if (name === 'session-notice') notices.push(payload); } });
  listeners.get('codeagent-model-pick')({ sessionId: current.id, modelId: OLD, reason: 'launch' });
  if (policy === 'stop-and-ask') {
    await assert.rejects(picker.waitForPick(current.id), error => error.notSent === true);
    assert.equal(current.codeagentModelPick, true);
    assert.equal(current.fixedModel, OLD);
  } else {
    const result = await picker.waitForPick(current.id);
    assert.equal(result.ok, true);
    assert.equal(current.fixedModel, NEXT);
    assert.equal(current.modelChange.from, OLD);
    assert.equal(notices.some(notice => notice.persistent && /原模型/.test(notice.message)), true);
  }
});


for (const policy of ['auto-switch-notify', 'stop-and-ask']) test(`a pool relaunch uses that account's catalog, not the personal catalog (${policy})`, t => {
  const f = fixture(t, { policy });
  const poolDir = path.join(f.root, 'pool'), poolModel = 'deepseek-pool-only';
  f.write(path.join(poolDir, 'settings.json'), { model: poolModel });
  f.write(path.join(poolDir, 'hub-models.json'), { source: 'serve', models: [poolModel] });
  const manager = Object.create(SessionManager.prototype), commands = [];
  const info = { id: 'pool-relaunch', kind: 'codeagent', cwd: f.cwd, codeagentConfigDir: poolDir,
    codeagentPoolAccount: 'pool001', fixedModel: poolModel, currentModel: { id: poolModel }, mcpProfile: 'full' };
  manager.sessions = new Map([[info.id, { info, pty: { options: { env: { USERPROFILE: f.root, HOME: f.root } }, write: cmd => commands.push(cmd) } }]]);
  manager.hubRulesSystemPrompt = () => null; manager.emit = () => {};
  assert.equal(manager.relaunchCli(info.id), true);
  assert.equal(info.fixedModel, poolModel);
  assert.match(commands[0], /--settings/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'codeagent-launch', info.id + '.json'))).model, poolModel);
});


test('relaunch auto-switch persists and publishes the new pin before any hook or renderer save', t => {
  const f = fixture(t, { ids: [NEXT] });
  const manager = Object.create(SessionManager.prototype);
  require('node:events').EventEmitter.call(manager);
  manager._refreshOpenIdentity = () => {}; manager.hubRulesSystemPrompt = () => null;
  const info = { id: 'relaunch-change', kind: 'codeagent', cwd: f.cwd, codeagentConfigDir: f.configDir,
    fixedModel: OLD, currentModel: { id: OLD }, mcpProfile: 'full' };
  manager.sessions = new Map([[info.id, { info, pty: { options: { env: { USERPROFILE: f.root, HOME: f.root } }, write() {} } }]]);
  const updates = []; manager.on('session-updated', updated => updates.push(updated));
  assert.equal(manager.relaunchCli(info.id), true);
  assert.equal(info.currentModel.id, NEXT);
  assert.equal(store.loadSessionFile(info.id, { strict: true }).fixedModel, NEXT);
  assert.equal(updates.at(-1).fixedModel, NEXT);
});

test('a healthy restore retains the previous change reason without reporting another switch', t => {
  const f = fixture(t);
  const change = { from: OLD, to: NEXT, reason: 'permission changed', at: 1700000000000 };
  const built = f.launch('remember-reason', { fixedModel: NEXT, modelPinSource: 'auto-switch', modelChange: change });
  assert.deepEqual(built.modelChange, change);
  assert.equal(built.modelChanged, false);
});

test('legacy relaunch migrates the current model before resolving account defaults', t => {
  const f = fixture(t);
  const manager = Object.create(SessionManager.prototype);
  require('node:events').EventEmitter.call(manager);
  manager._refreshOpenIdentity = () => {}; manager.hubRulesSystemPrompt = () => null;
  const info = { id: 'legacy-relaunch', kind: 'codeagent', currentModel: { id: OLD }, cwd: f.cwd,
    codeagentConfigDir: f.configDir, mcpProfile: 'full' };
  manager.sessions = new Map([[info.id, { info, pty: { options: { env: { USERPROFILE: f.root, HOME: f.root } }, write() {} } }]]);
  assert.equal(manager.relaunchCli(info.id), true);
  assert.equal(info.fixedModel, OLD);
  assert.equal(info.modelPinSource, 'legacy-current');
  assert.equal(store.loadSessionFile(info.id, { strict: true }).fixedModel, OLD);
});



test('manual confirmation suggests the same account default the automatic policy would choose', t => {
  const f = fixture(t, { ids: ['deepseek-other', NEXT], policy: 'stop-and-ask' });
  assert.throws(() => f.launch('confirm-default', { fixedModel: OLD }), error => {
    assert.equal(error.code, 'SESSION_MODEL_UNAVAILABLE');
    assert.equal(error.model, OLD);
    assert.equal(error.suggestedModel, NEXT);
    return true;
  });
});

test('confirmation notice preselects the suggested model and waits for explicit confirmation', async () => {
  const document = fakeDocument(), selected = [];
  const notice = require('../renderer/sticky-notice').showUnavailableModelNotice(document,
    { sessionId: 'confirm', originalModel: OLD, suggestedModel: NEXT, message: `原模型 ${OLD} 不可用`, availableModels: ['deepseek-other', NEXT] },
    async model => { selected.push(model); return { ok: true }; });
  assert.match(notice.dataset.text, new RegExp(NEXT));
  const { select, confirm } = notice.modelParts;
  assert.equal(select.value, NEXT);
  assert.deepEqual(selected, []);
  assert.equal(confirm.textContent, '切换并继续');
  select.value = 'deepseek-other';
  await confirm.listeners.click();
  assert.deepEqual(selected, ['deepseek-other']);
});

test('cancelling the model confirmation keeps the stopped session untouched', () => {
  const document = fakeDocument(), selected = [];
  const notice = require('../renderer/sticky-notice').showUnavailableModelNotice(document,
    { sessionId: 'cancel', originalModel: OLD, suggestedModel: NEXT, message: `原模型 ${OLD} 不可用`, availableModels: [NEXT] },
    model => { selected.push(model); return { ok: true }; });
  const cancel = notice.modelParts.cancel;
  assert.equal(cancel.textContent, '保持暂停');
  cancel.listeners.click();
  assert.deepEqual(selected, []);
  assert.equal(document.body.children[0].children.length, 0);
});

test('the second policy label requires explicit manual confirmation', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.match(html, /<option value="stop-and-ask">切换前必须手动确认<\/option>/);
});

for (const policy of ['auto-switch-notify', 'stop-and-ask']) test(`a rejected only model is never suggested as an alternative (${policy})`, async t => {
  const f = fixture(t, { ids: [OLD], policy });
  const current = { id: 'no-alternative', kind: 'codeagent', fixedModel: OLD, codeagentConfigDir: f.configDir };
  const notices = [];
  const api = require('../main/ipc/session-handlers').registerSessionIpc({ handle() {}, on() {} }, {
    sessionManager: { getSession: () => current, updateSessionMeta: (_id, fields) => Object.assign(current, fields) },
    sendToRenderer: (name, payload) => { if (name === 'session-notice') notices.push(payload); },
  });
  const result = await api.fixCodeAgentModel(current.id, { avoidModel: OLD });
  assert.equal(result.ok, false);
  if (policy === 'stop-and-ask') {
    assert.equal(notices.at(-1).suggestedModel, '');
    assert.deepEqual(notices.at(-1).availableModels, []);
    const notice = require('../renderer/sticky-notice').showUnavailableModelNotice(fakeDocument(), notices.at(-1), () => assert.fail('must remain stopped'));
    assert.match(notice.dataset.text, /暂无可用替代模型/);
    assert.equal(notice.modelParts.select, undefined);
    assert.equal(notice.modelParts.confirm, undefined);
  } else assert.equal(result.error, 'SESSION_MODEL_UNAVAILABLE');
  assert.equal(current.fixedModel, OLD);
});

function creationApi(t, f, decide) {
  t.mock.method(require('../core/community-provider'), 'assertProviderAvailable', () => {});
  t.mock.method(require('../core/company-api-config'), 'assertLaunchConfigured', () => {});
  const handlers = new Map(), notices = [], sessions = new Map(), created = [];
  sessions.set('lead-0001', { id: 'lead-0001', kind: 'codeagent', cwd: f.cwd, title: '负责人' });
  const manager = { getSession: id => sessions.get(id), isAgentTurnActive: () => false, createSession(kind, opts) {
    const id = opts.id || `created-${created.length + 1}`;
    const built = f.launch(id, opts);
    const session = { ...opts, id, kind, fixedModel: built.fixedModel, currentModel: { id: built.fixedModel }, modelChange: built.modelChange, status: 'idle' };
    created.push(session); sessions.set(id, session); return session;
  } };
  const api = require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: manager, requestModelConfirmation: decide,
    sendToRenderer: (name, payload) => { if (name === 'session-notice') notices.push(payload); },
  });
  return { ...api, manager, created, notices, handlers };
}

for (const policy of ['auto-switch-notify', 'stop-and-ask']) test(`ordinary creation resolves an unavailable selection before creating (${policy})`, async t => {
  const f = fixture(t, { ids: [NEXT, 'deepseek-other'], policy });
  let confirm, asked;
  const api = creationApi(t, f, payload => { asked = payload; return new Promise(resolve => { confirm = resolve; }); });
  const pending = api.createSession({ kind: 'codeagent', opts: { cwd: f.cwd, model: OLD, codeagentModelPick: true, title: 'new ordinary' } });
  if (policy === 'stop-and-ask') {
    await Promise.resolve();
    assert.equal(api.created.length, 0);
    assert.equal(asked.originalModel, OLD);
    assert.equal(asked.suggestedModel, NEXT);
    confirm('deepseek-other');
  }
  const session = await pending;
  assert.equal(session.fixedModel, policy === 'stop-and-ask' ? 'deepseek-other' : NEXT);
  assert.equal(api.created.length, 1);
  if (policy === 'auto-switch-notify') assert.match(api.notices.at(-1).message, new RegExp(`原模型 ${OLD} 不可用，已换成 ${NEXT}`));
});

test('ordinary creation cancellation creates no session and explains why', async t => {
  const f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask' });
  const api = creationApi(t, f, async () => null);
  await assert.rejects(Promise.resolve().then(() => api.createSession({ kind: 'codeagent', opts: { model: OLD, codeagentModelPick: true } })), { code: 'SESSION_CREATION_CANCELLED' });
  assert.equal(api.created.length, 0);
  assert.match(api.notices.at(-1).message, /取消.*未创建/);
});

function groupCreation(t, f, decide) {
  const api = creationApi(t, f, decide), groups = new Map(), events = [], handlers = new Map();
  const meetingManager = {
    createMeeting: safe => { const m = { ...safe, id: 'new-room', subSessions: [] }; groups.set(m.id, m); return m; },
    updateMeeting: (id, fields) => Object.assign(groups.get(id), fields),
    getMeeting: id => groups.get(id), closeMeeting: id => groups.delete(id),
    addSubSession: (id, sid) => { const m = groups.get(id); m.subSessions.push(sid); return m; },
    setSlotSpecs: (id, slots) => { groups.get(id).slotSpecs = slots; },
    setParticipants: (id, indices) => { groups.get(id).participants = indices; },
  };
  const file = path.join(__dirname, '../main/ipc/meeting-create-handlers.js');
  const realRequire = require('node:module').createRequire(file), module = { exports: {} };
  require('node:vm').runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, console,
    require: name => name === '../../core/distribution' ? { target: 'company', featureEnabled: () => true } : realRequire(name) });
  const orchestrator = { launchOptions: () => ({ purpose: 'hub-orchestrator' }), onMeetingCreated() {} };
  const internal = module.exports.registerMeetingCreateIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    fs, path, getHubDataDir: () => f.dataDir, getHookPort: () => 0, getMeetingWorkspaceDir: () => f.cwd,
    getSlotPromptName: () => 'member', groupchat: {}, isClaudeFamily: () => true, isCodexBaseKind: () => false,
    isIsolatedHub: () => true, kindLabels: { codeagent: 'CodeAgent' }, meetingManager,
    registerSessionForTap() {}, scenes: {}, slotIds: [], sessionManager: api.manager,
    requestModelConfirmation: decide, getOrchestrationService: () => orchestrator,
    sendToRenderer: (name, payload) => { events.push({ name, payload }); if (name === 'session-notice') api.notices.push(payload); },
  });
  return { ...api, groups, handlers, internal, events };
}

for (const role of ['member', 'orchestrator']) for (const policy of ['auto-switch-notify', 'stop-and-ask']) test(`new group ${role} handles an unavailable model (${policy})`, async t => {
  const f = fixture(t, { ids: [NEXT], policy }), requests = [];
  const h = groupCreation(t, f, async payload => { requests.push(payload); assert.equal(h.created.length, 0); return NEXT; });
  const group = await h.handlers.get('create-meeting')(null, { title: '测试群聊', workspace: f.cwd,
    slots: [{ kind: 'codeagent', model: OLD, codeagentModelPick: true }], ...(role === 'orchestrator' ? { orchestration: { enabled: true } } : {}) });
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].fixedModel, NEXT);
  assert.equal(group.slotSpecs[0].model, NEXT);
  if (policy === 'stop-and-ask') { assert.equal(requests.length, 1); assert.match(requests[0].contextLabel, /测试群聊/); }
  else assert.match(h.notices.at(-1).message, /测试群聊.*原模型.*已换成/);
});

test('cancelling new group creation leaves no empty group or member', async t => {
  const f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask' });
  const h = groupCreation(t, f, async () => null);
  await assert.rejects(h.handlers.get('create-meeting')(null, { workspace: f.cwd, slots: [{ kind: 'codeagent', model: OLD, codeagentModelPick: true }] }), /取消.*未创建/);
  assert.equal(h.created.length, 0); assert.equal(h.groups.size, 0);
});

for (const action of ['auto-switch-notify', 'stop-and-ask', 'cancel']) test(`team propose and approved creation use the shared model policy (${action})`, async t => {
  const f = fixture(t, { ids: [NEXT], policy: action === 'cancel' ? 'stop-and-ask' : action });
  const requests = [];
  const api = creationApi(t, f, async payload => { requests.push(payload); assert.equal(api.created.length, 0); return action === 'cancel' ? null : NEXT; });
  const service = require('../main/team/service').createTeamService({
    getHubDataDir: () => f.dataDir, sessionManager: api.manager, createSession: request => api.createSession(request),
    listAccounts: () => ({ recommendedId: 'pool-a', rows: [{ id: 'pool-a', usable: true, models: [NEXT], modelsAuthoritative: true }] }),
    commandPath: () => 'fixture-team', submitPrompt: async () => ({ ok: true }),
  });
  t.after(() => { service.freeze(); service.stop(); });
  const plan = await service.invoke('lead-0001', 'propose', { goal: 'model policy', members: [{ role: '实现', task: '测试', account: 'pool-a', model: OLD }] });
  assert.equal(api.created.length, 0);
  const result = await service.decide({ leadSid: 'lead-0001', planId: plan.planId, approve: true });
  if (action === 'cancel') { assert.equal(result.created.length, 0); assert.match(result.failed[0], /取消.*未创建/); }
  else {
    assert.equal(api.created[0].fixedModel, NEXT);
    assert.equal(service.listTeams()[0].members[0].model, NEXT);
    if (action === 'stop-and-ask') assert.match(requests[0].contextLabel, /负责人.*实现/);
    else assert.match(api.notices.at(-1).message, /负责人.*实现.*原模型.*已换成/);
  }
});

test('creation confirmation IPC waits, validates alternatives, and consumes each decision once', async () => {
  const { createModelCreationConfirmation } = require('../main/session-model-creation');
  const notices = [];
  const gate = createModelCreationConfirmation({ sendToRenderer: (name, payload) => notices.push({ name, payload }) });
  const result = gate.request({ originalModel: OLD, suggestedModel: NEXT, availableModels: [NEXT], contextLabel: '后台成员' });
  const payload = notices[0].payload;
  assert.equal(notices[0].name, 'session-model-create-confirm');
  assert.equal(gate.respond({ requestId: payload.requestId, modelId: OLD }).ok, false);
  assert.equal(gate.respond({ requestId: payload.requestId, modelId: NEXT }).ok, true);
  assert.equal(await result, NEXT);
  assert.equal(gate.respond({ requestId: payload.requestId, modelId: NEXT }).ok, false);
});

for (const action of ['confirm', 'cancel']) test(`new creation confirmation travels through main broker and renderer controls (${action})`, async t => {
  const f = fixture(t, { ids: [NEXT, 'deepseek-other'], policy: 'stop-and-ask' });
  const document = fakeDocument(), listeners = new Map();
  const { createModelCreationConfirmation } = require('../main/session-model-creation');
  const gate = createModelCreationConfirmation({ sendToRenderer: (channel, payload) => listeners.get(channel)(null, payload) });
  const ipc = { on: (channel, fn) => listeners.set(channel, fn), invoke: async (_name, payload) => gate.respond(payload) };
  require('../renderer/sticky-notice').registerModelCreationConfirmation(ipc, document);
  const api = creationApi(t, f, gate.request);
  const pending = Promise.resolve().then(() => api.createSession({ kind: 'codeagent', opts: { model: OLD, codeagentModelPick: true, cwd: f.cwd } }));
  await Promise.resolve();
  assert.equal(api.created.length, 0);
  const notice = document.body.children[0].children[0], { select, confirm, cancel } = notice.modelParts;
  assert.equal(select.value, NEXT);
  assert.match(notice.dataset.text, new RegExp(OLD));
  if (action === 'cancel') {
    cancel.listeners.click();
    await assert.rejects(pending, { code: 'SESSION_CREATION_CANCELLED' });
    assert.equal(api.created.length, 0);
  } else {
    select.value = 'deepseek-other';
    await confirm.listeners.click();
    assert.equal((await pending).fixedModel, 'deepseek-other');
    assert.equal(api.created.length, 1);
  }
});

test('concurrent background creations have separate confirmations and shutdown cancels both', async () => {
  const document = fakeDocument(), listeners = new Map();
  const gate = require('../main/session-model-creation').createModelCreationConfirmation({ sendToRenderer: (channel, payload) => listeners.get(channel)(null, payload) });
  require('../renderer/sticky-notice').registerModelCreationConfirmation({ on: (channel, fn) => listeners.set(channel, fn),
    invoke: async (_name, payload) => gate.respond(payload) }, document);
  const payload = { originalModel: OLD, suggestedModel: NEXT, availableModels: [NEXT], message: '相同的后台成员', contextLabel: '成员' };
  const first = gate.request(payload), second = gate.request(payload);
  assert.equal(document.body.children[0].children.length, 2);
  gate.cancelAll();
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
});

test('a cancelled first group slot never replaces the next successful member mapping', async t => {
  const f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask' });
  const h = groupCreation(t, f, async () => null);
  const group = await h.handlers.get('create-meeting')(null, { workspace: f.cwd, slots: [
    { kind: 'codeagent', model: OLD, codeagentModelPick: true },
    { kind: 'codeagent', model: NEXT, codeagentModelPick: true },
  ] });
  assert.equal(group.subSessions.length, 1);
  assert.equal(group.slotSpecs.length, 1);
  assert.equal(group.slotSpecs[0].model, NEXT);
  assert.equal(group.slotSpecs[0].memberId, 'm2');
});

test('a cancelled orchestrator does not silently promote a later ordinary member', async t => {
  const f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask' });
  const h = groupCreation(t, f, async () => null);
  await assert.rejects(h.handlers.get('create-meeting')(null, { workspace: f.cwd, orchestration: { enabled: true }, slots: [
    { kind: 'codeagent', model: OLD, codeagentModelPick: true }, { kind: 'codeagent', model: NEXT, codeagentModelPick: true },
  ] }), /取消.*未创建/);
  assert.equal(h.created.length, 0); assert.equal(h.groups.size, 0);
});

for (const event of ['navigation', 'render-process-gone', 'destroyed']) test(`losing the renderer cancels pending creation instead of locking team approval (${event})`, async () => {
  const contents = new (require('node:events').EventEmitter)();
  const gate = require('../main/session-model-creation').createModelCreationConfirmation({ sendToRenderer() {} });
  gate.attachRenderer(contents);
  contents.emit('did-finish-load');
  const pending = gate.request({ originalModel: OLD, suggestedModel: NEXT, availableModels: [NEXT] });
  if (event === 'navigation') contents.emit('did-start-navigation', {}, 'file:///reload', false, true);
  else contents.emit(event);
  assert.equal(await pending, null);
  await assert.rejects(gate.request({ availableModels: [NEXT] }), /界面.*不可用|重载/);
});

test('a CLI capability failure cannot loop through model selection during creation', async t => {
  const f = fixture(t, { policy: 'stop-and-ask', help: '--resume <id> --permission-mode <mode>' });
  let requests = 0;
  const api = creationApi(t, f, async payload => { requests++; if (requests > 2) throw Error('confirmation loop'); return payload.suggestedModel; });
  await assert.rejects(Promise.resolve().then(() => api.createSession({ kind: 'codeagent', opts: { model: OLD, codeagentModelPick: true } })), { code: 'SESSION_MODEL_UNAVAILABLE' });
  assert.equal(requests, 0); assert.equal(api.created.length, 0);
  assert.match(api.notices.at(-1).message, /升级|修复/);
});

test('automatic account choice keeps a confirmed available model instead of rotating into another permission failure', async t => {
  const f = fixture(t, { policy: 'stop-and-ask' });
  const accounts = ['a', 'b'].map(id => ({ id, dir: path.join(f.root, id), state: 'ready', models: [id + '-only'], modelsAuthoritative: true, activeSessions: 0, lastAssignedAt: 0 }));
  for (const a of accounts) f.write(path.join(a.dir, 'settings.json'), { model: a.models[0] });
  t.mock.method(pool, 'readCredentials', () => ({}));
  t.mock.method(pool, 'listAccounts', () => accounts);
  t.mock.method(pool, 'withPauseStatus', (_dir, values) => values);
  t.mock.method(pool, 'projectCredentialsOverride', () => null);
  t.mock.method(pool, 'syncSharedConfig', (_source, dir) => ({ errors: [], model: accounts.find(a => a.dir === dir).models[0] }));
  let assigned = 0;
  t.mock.method(pool, 'markAssigned', (_dir, id) => { accounts.find(a => a.id === id).lastAssignedAt = ++assigned; });
  const manager = Object.create(SessionManager.prototype); manager.sessions = new Map(); manager._personalAutoCandidate = () => null;
  const attempts = [];
  const session = await require('../main/session-model-creation').createSessionWithModelPolicy({
    kind: 'codeagent', opts: { codeagentAccount: 'pool', model: OLD, codeagentModelPick: true },
    create: (_kind, opts) => {
      const selected = manager._resolveCodeAgentPool(opts, { configDir: f.configDir });
      attempts.push([selected.account.id, opts.fixedModel]);
      return require('../core/session-model-pin').resolveCodeAgentPin(opts, { dataDir: f.dataDir, configDir: selected.account.dir, command: 'never-run', pool: selected });
    },
    requestConfirmation: async payload => { if (attempts.length > 2) throw Error('account confirmation loop'); return payload.suggestedModel; }, sendToRenderer() {},
  });
  assert.equal(session.fixedModel, 'a-only');
  assert.deepEqual(attempts, [['a', OLD], ['a', 'a-only']]);
});

for (const action of ['auto-switch-notify', 'stop-and-ask', 'cancel']) test(`adding a member to an existing group uses the creation policy (${action})`, async t => {
  const f = fixture(t, { ids: [NEXT], policy: action === 'cancel' ? 'stop-and-ask' : action });
  const h = groupCreation(t, f, async () => action === 'cancel' ? null : NEXT);
  h.groups.set('existing-room', { id: 'existing-room', title: '现有群聊', groupChat: true, workspace: f.cwd, subSessions: [], slotSpecs: [] });
  const pending = h.internal.addMeetingSubInternal('existing-room', 'codeagent', { model: OLD, codeagentModelPick: true });
  if (action === 'cancel') {
    await assert.rejects(pending, { code: 'SESSION_CREATION_CANCELLED' });
    assert.equal(h.created.length, 0); assert.equal(h.groups.get('existing-room').subSessions.length, 0);
  } else {
    const added = await pending;
    assert.equal(added.session.fixedModel, NEXT);
    assert.equal(added.meeting.slotSpecs[0].model, NEXT);
  }
});

test('renderer loss releases the team approval queue and the next approval can create a member', async t => {
  const f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask' });
  const gate = require('../main/session-model-creation').createModelCreationConfirmation({ sendToRenderer() {} });
  const contents = new (require('node:events').EventEmitter)(); gate.attachRenderer(contents); contents.emit('did-finish-load');
  const api = creationApi(t, f, gate.request);
  const service = require('../main/team/service').createTeamService({ getHubDataDir: () => f.dataDir, sessionManager: api.manager,
    createSession: request => api.createSession(request), submitPrompt: async () => ({ ok: true }), commandPath: () => 'fixture-team',
    listAccounts: () => ({ recommendedId: 'pool-a', rows: [{ id: 'pool-a', usable: true, models: [NEXT], modelsAuthoritative: true }] }),
  });
  t.after(() => { gate.cancelAll(); service.freeze(); service.stop(); });
  const propose = model => service.invoke('lead-0001', 'propose', { goal: 'queue', members: [{ role: '实现', task: '测试', model }] });
  const first = await propose(OLD), firstDecision = service.decide({ leadSid: 'lead-0001', planId: first.planId, approve: true });
  contents.emit('render-process-gone');
  assert.equal((await firstDecision).created.length, 0);
  contents.emit('did-finish-load');
  const next = await propose(NEXT), nextDecision = await service.decide({ leadSid: 'lead-0001', planId: next.planId, approve: true });
  assert.equal(nextDecision.created.length, 1); assert.equal(api.created.length, 1);
});


for (const mode of ['ordinary', 'group', 'team']) test(`${mode} resume waits for confirmation then resumes the original native conversation`, async t => {
  const requests = []; let confirm;
  const f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask', confirmation: payload => { requests.push(payload); return new Promise(resolve => { confirm = resolve; }); } });
  store.saveSessionFile('waiting-resume', { kind: 'codeagent', cwd: f.cwd, ccSessionId: NATIVE, fixedModel: OLD,
    currentModel: { id: OLD }, ...(mode === 'group' ? { meetingId: 'room' } : {}) });
  const pending = f.resume({ hubId: 'waiting-resume' }).catch(error => ({ error }));
  await new Promise(setImmediate);
  assert.equal(requests.length, 1); assert.equal(f.calls.length, 0);
  assert.equal(requests[0].creation, false); confirm(NEXT);
  const session = await pending;
  assert.equal(session.fixedModel, NEXT, session.error?.message);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].opts.resumeCCSessionId, NATIVE);
  assert.equal(f.calls[0].built.settingsModel, NEXT);
});

test('resume confirmation retries acquire a fresh real session-open lease', async t => {
  let confirm;
  const f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask', confirmation: () => new Promise(resolve => { confirm = resolve; }) });
  t.mock.method(require('../core/community-provider'), 'assertProviderAvailable', () => {});
  t.mock.method(require('../core/company-api-config'), 'assertLaunchConfigured', () => {});
  const manager = f.manager; Object.setPrototypeOf(manager, SessionManager.prototype);
  require('node:events').EventEmitter.call(manager);
  manager.sessions = new Map(); manager.openLeases = new Map(); let leases = 0;
  manager.openOwners = { claim: id => ({ id, nonce: `lease-${++leases}` }), release() {} };
  manager._openOwners = () => manager.openOwners;
  manager._withExtraMcp = (_kind, opts) => opts;
  manager.getSession = id => manager.sessions.get(id)?.info;
  manager._createSession = (kind, opts) => {
    const built = f.launch(opts.id, opts), info = { ...opts, kind, fixedModel: built.fixedModel, currentModel: { id: built.fixedModel } };
    manager.sessions.set(opts.id, { info }); return info;
  };
  manager.createSession = SessionManager.prototype.createSession;
  store.saveSessionFile('leased-resume', { kind: 'codeagent', cwd: f.cwd, ccSessionId: NATIVE, fixedModel: OLD, currentModel: { id: OLD } });
  const pending = f.resume({ hubId: 'leased-resume' }).catch(error => ({ error }));
  await new Promise(setImmediate);
  assert.equal(typeof confirm, 'function'); confirm(NEXT);
  const result = await pending;
  assert.equal(result.fixedModel, NEXT, result.error?.message); assert.equal(leases, 2);
});


test('a healthy restored model does not report a historical automatic switch as new', async t => {
  const f = fixture(t);
  store.saveSessionFile('healthy-resume', { kind: 'codeagent', cwd: f.cwd, ccSessionId: NATIVE, fixedModel: NEXT,
    currentModel: { id: NEXT }, modelChange: { from: OLD, to: NEXT, reason: 'previous change', at: 1700000000000 } });
  await f.resume({ hubId: 'healthy-resume' });
  assert.equal(f.events.filter(event => event.name === 'session-notice' && /已换成/.test(event.payload.message)).length, 0);
});

for (const confirmRequired of [false, true]) test(`verified child identity repair remains resumable without mistaking its own normalization for an external edit (${confirmRequired})`, async t => {
  let confirmations = 0;
  const f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask', confirmation: async () => { confirmations++; return NEXT; } });
  const child = '22222222-2222-4222-8222-222222222222', childPath = path.join(f.configDir, 'projects', 'fixture', child + '.jsonl');
  f.write(childPath, {});
  t.mock.method(require('../core/codeagent-fork-identity'), 'recoverCodeAgentFork', meta => ({ meta: { ...meta, ccSessionId: child, transcriptPath: childPath }, forkCCSessionId: null }));
  store.saveSessionFile('repaired-resume', { kind: 'codeagent', cwd: f.cwd, ccSessionId: NATIVE, transcriptPath: childPath,
    fixedModel: confirmRequired ? OLD : NEXT, currentModel: { id: confirmRequired ? OLD : NEXT } });
  const resumed = await f.resume({ hubId: 'repaired-resume' }).catch(error => ({ error }));
  assert.equal(resumed.fixedModel, NEXT, resumed.error?.message);
  assert.equal(f.calls[0].opts.resumeCCSessionId, child); assert.equal(confirmations, confirmRequired ? 1 : 0);
});

test('team wake cancellation stops its original queued task and never asks again on a later tick', async t => {
  let confirmations = 0, clock = 100000, wakes = 0;
  const f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask', confirmation: async () => { confirmations++; return null; } });
  const lead = { id: 'lead-0001', kind: 'codeagent', cwd: f.cwd, status: 'idle' };
  f.manager.getSession = id => id === lead.id ? lead : null; f.manager.isAgentTurnActive = () => false;
  store.saveSessionFile('sleeping-member', { kind: 'codeagent', cwd: f.cwd, ccSessionId: NATIVE, fixedModel: OLD, currentModel: { id: OLD } });
  const service = require('../main/team/service').createTeamService({ getHubDataDir: () => f.dataDir, sessionManager: f.manager,
    listAccounts: () => ({ recommendedId: 'pool-a', rows: [{ id: 'pool-a', usable: true, models: [NEXT], modelsAuthoritative: true }] }),
    createSession: async () => ({ id: 'sleeping-member', kind: 'codeagent', fixedModel: OLD }),
    submitPrompt: async () => ({ ok: true }), commandPath: () => 'fixture-team', now: () => clock, logger: { warn() {} },
    wakeSession: async id => { wakes++; return f.resume({ hubId: id }); },
  });
  t.after(() => { service.freeze(); service.stop(); });
  const plan = await service.invoke(lead.id, 'propose', { goal: 'wake', members: [{ role: '实现', task: '原任务', model: OLD }] });
  await service.decide({ leadSid: lead.id, planId: plan.planId, approve: true });
  await service.flush(lead.id); clock += 61000; await service.flush(lead.id);
  assert.equal(confirmations, 1); assert.equal(wakes, 1);
  assert.equal(service.listTeams()[0].messages.find(message => message.to === 'm1').state, 'failed');
});

test('an original-task confirmation replaces the obsolete switch-only notice for that session', () => {
  const document = fakeDocument(), listeners = new Map(), notices = require('../renderer/sticky-notice');
  notices.showUnavailableModelNotice(document, { sessionId: 'live', message: '旧的只切模型提示', availableModels: [NEXT] }, async () => ({ ok: true }));
  notices.registerModelCreationConfirmation({ on: (name, fn) => listeners.set(name, fn), invoke: async () => ({ ok: true }) }, document);
  const request = { requestId: 'resume-original', sessionId: 'live', creation: false, originalModel: OLD,
    suggestedModel: NEXT, availableModels: [NEXT], message: '确认后继续原消息' };
  listeners.get('session-model-create-confirm')(null, request);
  assert.equal(document.body.children[0].children.length, 1);
  assert.equal(document.body.children[0].children[0].dataset.noticeKey, request.requestId);
  listeners.get('session-model-create-confirm')(null, { ...request, requestId: 'another-original' });
  assert.equal(document.body.children[0].children.length, 2);
  listeners.get('session-model-confirmation-dismissed')(null, { requestId: 'resume-original' });
  assert.equal(document.body.children[0].children.length, 1);
});

test('team wake confirmation resumes the saved member and submits its original kickoff only once', async t => {
  let confirmations = 0;
  const f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask', confirmation: async () => { confirmations++; return NEXT; } });
  const lead = { id: 'lead-0001', kind: 'codeagent', cwd: f.cwd, status: 'idle' }, active = new Map([[lead.id, lead]]), sent = [];
  const originalCreate = f.manager.createSession;
  f.manager.getSession = id => active.get(id); f.manager.isAgentTurnActive = () => false;
  f.manager.createSession = (kind, opts) => { const session = originalCreate(kind, opts); session.status = 'idle'; active.set(session.id, session); return session; };
  store.saveSessionFile('sleeping-member', { kind: 'codeagent', cwd: f.cwd, ccSessionId: NATIVE, fixedModel: OLD, currentModel: { id: OLD } });
  const service = require('../main/team/service').createTeamService({ getHubDataDir: () => f.dataDir, sessionManager: f.manager,
    listAccounts: () => ({ recommendedId: 'pool-a', rows: [{ id: 'pool-a', usable: true, models: [NEXT], modelsAuthoritative: true }] }),
    createSession: async () => ({ id: 'sleeping-member', kind: 'codeagent', fixedModel: OLD }),
    submitPrompt: async (id, text) => { if (id === 'sleeping-member') sent.push(text); return { ok: true }; },
    commandPath: () => 'fixture-team', wakeSession: id => f.resume({ hubId: id }),
  });
  t.after(() => { service.freeze(); service.stop(); });
  const plan = await service.invoke(lead.id, 'propose', { goal: 'wake once', members: [{ role: '实现', task: '唯一的原开工任务', model: OLD }] });
  await service.decide({ leadSid: lead.id, planId: plan.planId, approve: true });
  await service.flush(lead.id); await service.flush(lead.id); await service.flush(lead.id);
  assert.equal(confirmations, 1); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].opts.resumeCCSessionId, NATIVE);
  assert.equal(active.get('sleeping-member').fixedModel, NEXT); assert.equal(sent.length, 1); assert.match(sent[0], /唯一的原开工任务/);
});

for (const policy of ['auto-switch-notify', 'stop-and-ask']) for (const source of ['current', 'manual']) test(`known legacy GLM alias resolves before permission checks (${policy}, ${source})`, t => {
  const f = fixture(t, { ids: [OLD, 'MiniMax-M2.7'], policy });
  f.write(path.join(f.configDir, 'settings.json'), { model: 'MiniMax-M2.7' });
  const migrated = require('../core/session-model-pin').migrateModelPin({ kind: 'codeagent', currentModel: { id: 'GLM-5.2-WX' }, ...(source === 'manual' ? { codeagentUserModel: 'GLM-5.2-WX' } : {}) });
  const built = f.launch('legacy-canonical', migrated);
  assert.equal(built.fixedModel, OLD); assert.equal(built.modelChanged, false); assert.equal(built.modelChange, null);
});

test('automatic replacement never crosses model families without explicit confirmation', t => {
  const f = fixture(t, { ids: ['MiniMax-M2.7'] });
  assert.throws(() => f.launch('no-cross-family', { fixedModel: OLD }), { code: 'SESSION_MODEL_UNAVAILABLE' });
});

test('a persisted model pause survives resume until the user confirms a model', async t => {
  let confirmations = 0;
  const f = fixture(t, { policy: 'stop-and-ask', confirmation: async () => { confirmations++; return NEXT; } });
  store.saveSessionFile('persistent-pause', { kind: 'codeagent', cwd: f.cwd, ccSessionId: NATIVE,
    fixedModel: OLD, currentModel: { id: OLD }, modelConfirmationRequired: true, modelUnavailableReason: '模型请求已被拒绝' });
  assert.equal(store.loadSessionFile('persistent-pause', { strict: true }).modelConfirmationRequired, true);
  const resumed = await f.resume({ hubId: 'persistent-pause' });
  assert.equal(confirmations, 1); assert.equal(resumed.fixedModel, NEXT); assert.equal(resumed.modelConfirmationRequired, false);
});

test('a persisted model pause blocks in-place relaunch even while the catalog still lists the model', t => {
  const f = fixture(t, { policy: 'stop-and-ask' }), manager = Object.create(SessionManager.prototype), writes = [];
  require('node:events').EventEmitter.call(manager); manager.hubRulesSystemPrompt = () => null;
  const info = { id: 'paused-relaunch', kind: 'codeagent', cwd: f.cwd, fixedModel: OLD, currentModel: { id: OLD },
    codeagentConfigDir: f.configDir, modelConfirmationRequired: true, modelUnavailableReason: '模型请求已被拒绝' };
  manager.sessions = new Map([[info.id, { info, pty: { options: { env: { HOME: f.root, USERPROFILE: f.root } }, write: command => writes.push(command) } }]]);
  assert.throws(() => manager.relaunchCli(info.id), { code: 'SESSION_MODEL_UNAVAILABLE' });
  assert.equal(writes.length, 0); assert.equal(info.modelConfirmationRequired, true);
});

test('identically named model notices remain separate for two sessions', async () => {
  const document = fakeDocument(), selected = [], notices = require('../renderer/sticky-notice');
  for (const sessionId of ['member-a', 'member-b']) notices.showUnavailableModelNotice(document,
    { sessionId, message: '同名成员原模型不可用', availableModels: [NEXT] }, async () => { selected.push(sessionId); return { ok: true }; });
  const root = document.body.children[0]; assert.equal(root.children.length, 2);
  await root.children[0].modelParts.confirm.listeners.click();
  assert.equal(root.children.length, 1); await root.children[0].modelParts.confirm.listeners.click();
  assert.deepEqual(selected, ['member-a', 'member-b']);
});


test('automatic replacement prefers a same-family model over an unrelated account default', t => {
  const f = fixture(t, { ids: [NEXT, 'MiniMax-M2.7'] });
  f.write(path.join(f.configDir, 'settings.json'), { model: 'MiniMax-M2.7' });
  assert.equal(f.launch('same-family', { fixedModel: OLD }).fixedModel, NEXT);
});

for (const action of ['confirm', 'cancel']) test(`sleeping team member model confirmation is visible to the lead (${action})`, async t => {
  let f, clock = 100000; const notices = [], requests = [];
  const gate = require('../main/session-model-creation').createModelCreationConfirmation({
    sendToRenderer: (name, payload) => { if (name === 'session-model-create-confirm') requests.push(payload); },
    onWait: event => f.manager.emit('session-model-wait', event),
  });
  f = fixture(t, { ids: [NEXT], policy: 'stop-and-ask', confirmation: gate.request });
  Object.assign(f.manager, new (require('node:events').EventEmitter)());
  for (const key of ['on', 'off', 'emit']) f.manager[key] = require('node:events').EventEmitter.prototype[key];
  const lead = { id: 'lead-0001', kind: 'codeagent', cwd: f.cwd, status: 'idle' };
  f.manager.getSession = id => id === lead.id ? lead : null; f.manager.isAgentTurnActive = () => false;
  store.saveSessionFile('sleeping-member', { kind: 'codeagent', cwd: f.cwd, ccSessionId: NATIVE, fixedModel: OLD, currentModel: { id: OLD } });
  const service = require('../main/team/service').createTeamService({ getHubDataDir: () => f.dataDir, sessionManager: f.manager,
    listAccounts: () => ({ recommendedId: 'pool-a', rows: [{ id: 'pool-a', usable: true, models: [NEXT], modelsAuthoritative: true }] }),
    createSession: async () => ({ id: 'sleeping-member', kind: 'codeagent', fixedModel: OLD }),
    submitPrompt: async (sid, text) => { if (sid === lead.id) notices.push(text); return { ok: true }; },
    commandPath: () => 'fixture-team', now: () => clock, logger: { warn() {} }, wakeSession: id => f.resume({ hubId: id }),
  });
  t.after(() => { gate.cancelAll(); service.freeze(); service.stop(); });
  const plan = await service.invoke(lead.id, 'propose', { goal: 'wake', members: [{ role: '实现', task: '原任务', model: OLD }] });
  await service.decide({ leadSid: lead.id, planId: plan.planId, approve: true });
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
  assert.equal(requests.length, 1); clock += 11 * 60000; service.watch(); await service.flush(lead.id);
  const status = await service.invoke(lead.id, 'status', {}), message = status.messages.find(x => x.to === 'm1');
  assert.equal(status.members.find(x => x.memberId === 'm1').state, 'waiting-model');
  assert.equal(message.stage, 'waiting-model'); assert.match(message.reason, /GLM-5.2-WX-Auto/); assert.match(message.reason, /GLM-5.3-WX-Auto/);
  assert.equal(notices.filter(x => /等待模型确认/.test(x)).length, 1);
  gate.respond({ requestId: requests[0].requestId, ...(action === 'cancel' ? { cancel: true } : { modelId: NEXT }) });
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
  assert.notEqual(service.listTeams()[0].messages.find(x => x.to === 'm1').stage, 'waiting-model');
});

// 2026-11-12 同事反馈：助理问答每问一个新会话，都固定在 CodeAgent 默认的那个用不了的模型上，每问都弹框。
test('a confirmed replacement is used by later sessions whose model only came from the CLI default', t => {
  const f = fixture(t, { ids: [OLD, NEXT] });
  f.write(path.join(f.configDir, 'settings.json'), { model: OLD });
  const replacements = require('../core/codeagent-model-replacements');
  assert.equal(f.launch('before', {}).fixedModel, OLD);
  assert.equal(replacements.recordReplacement(f.dataDir, OLD, NEXT), true);
  assert.equal(f.launch('after', {}).fixedModel, NEXT);
  // 用户明确指定的模型不被替代。
  assert.equal(f.launch('explicit', { fixedModel: OLD, modelPinSource: 'user' }).fixedModel, OLD);
  // 替代模型不在可靠清单里时不用它。
  f.write(pool.personalModelsFile(f.dataDir), { source: 'serve', models: [OLD], at: new Date().toISOString() });
  assert.equal(f.launch('gone', {}).fixedModel, OLD);
});

test('replacement records chain and never point to themselves', t => {
  const f = fixture(t);
  const r = require('../core/codeagent-model-replacements');
  r.recordReplacement(f.dataDir, 'model-a', 'model-b');
  r.recordReplacement(f.dataDir, 'model-b', 'model-c');
  assert.equal(r.replacementFor(f.dataDir, 'MODEL-A'), 'model-c');
  assert.equal(r.replacementFor(f.dataDir, 'model-b'), 'model-c');
  r.recordReplacement(f.dataDir, 'model-c', 'model-a');
  assert.equal(r.replacementFor(f.dataDir, 'model-a'), '');
  assert.equal(r.replacementFor(f.dataDir, 'model-c'), 'model-a');
  assert.equal(r.recordReplacement(f.dataDir, 'same', 'SAME'), false);
});

test('the model notice shows the original model, reason and context in separate parts', () => {
  const document = fakeDocument();
  const notice = require('../renderer/sticky-notice').showUnavailableModelNotice(document,
    { sessionId: 'layout', requestId: 'r1', creation: false, contextLabel: '会话 助理问答 · 总结周报', originalModel: OLD, suggestedModel: NEXT,
      availableModels: [NEXT], message: `会话 助理问答 · 总结周报：原模型 ${OLD} 不可用（启动时没能选中这个模型），请手动选择可用模型后继续。` },
    async () => ({ ok: true }));
  const flat = node => [node.textContent, ...(node.children || []).map(flat)].join(' ');
  const shown = flat(notice);
  assert.match(shown, /需要换个模型才能继续/);
  assert.match(shown, /助理问答 · 总结周报/);
  assert.doesNotMatch(shown, /会话 助理问答/);
  assert.match(shown, /原因：启动时没能选中这个模型/);
  assert.match(shown, new RegExp(`${NEXT}（推荐）`));
  assert.equal(notice.modelParts.confirm.textContent, '切换并继续');
});
