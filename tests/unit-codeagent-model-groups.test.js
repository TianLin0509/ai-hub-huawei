'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const picker = require('../core/codeagent-model-picker');
const models = require('../core/codeagent-models');
const probe = require('../core/codeagent-model-probe');
const serve = require('../core/codeagent-serve');
const ui = require('../renderer/model-ui');
const FOOTER = 'Navigate ↑ ↓ | Select enter | Back esc';
const ID = 'deepseek4.1';
function grouped(cursor = 1) {
  return ['Select model', '模型名称  Credit消耗系数  Token用量/配额', 'max',
    `${cursor === 1 ? '❯' : ' '} 1. ${ID}   0x   Day 1M/100M`, 'free',
    `${cursor === 2 ? '❯' : ' '} 2. ${ID}   0x   Day 1M/100M`, FOOTER];
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-groups-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}

test('serve keeps same model under max and free, and cache reload exposes both routes', t => {
  const dir = temp(t);
  const parsed = serve.parseProviders({ providers: ['max', 'free'].map(id => ({ id, status: 'available', models: { [ID]: { id: ID } } })) });
  assert.equal(parsed.models.length, 2);
  assert.deepEqual(parsed.models.map(row => row.provider), ['max', 'free']);
  const file = require('../core/codeagent-pool').personalModelsFile(dir);
  probe.writeProbed(file, { source: 'serve', models: [ID], details: parsed.models });
  const options = models.modelOptions(dir);
  assert.equal(options.length, 2);
  assert.deepEqual(options.map(row => row.provider), ['max', 'free']);
  assert.deepEqual(options.map(row => row.label), [`${ID} · max（高倍率分组）`, `${ID} · free（免费分组）`]);
});

test('the account page displays provider-qualified permissions instead of collapsing model names', () => {
  const view = require('../renderer/codeagent-accounts-view');
  const html = view.renderAccounts({ personal: { present: true, state: 'ready', models: [ID], modelOptions: [
    { id: ID, label: `${ID} · max` }, { id: ID, label: `${ID} · free` },
  ] }, accounts: [] });
  assert.match(html, /deepseek4\.1 · max/); assert.match(html, /deepseek4\.1 · free/);
  assert.match(html, /\+1/);
});

test('numeric DeepSeek model remains in a single-row native menu', () => {
  const parsed = picker.parsePicker(['Select model', `❯ 1. ${ID}`, FOOTER]);
  assert.ok(parsed);
  assert.deepEqual(probe.modelsFromPicker(parsed).models, [ID]);
});

test('a single built-in provider keeps the existing model-only launch path', t => {
  const dir = temp(t), id = 'GLM-5.2-WX-Auto';
  const details = serve.parseProviders({ providers: [{ id: 'w3', models: { [id]: { id } } }] }).models;
  probe.writeProbed(require('../core/codeagent-pool').personalModelsFile(dir), { source: 'serve', models: [id], details });
  const options = models.modelOptions(dir);
  assert.equal(options.length, 1); assert.equal(options[0].provider, undefined);
  assert.equal(options[0].label, models.modelLabel(id));
});

test('native menu retains group identity and refuses an ambiguous model-only request', () => {
  const parsed = picker.parsePicker(grouped());
  assert.deepEqual(parsed.rows.map(row => row.group), ['max', 'free']);
  assert.equal(picker.findTarget(parsed, ID), -1);
  assert.equal(picker.findTarget(parsed, ID, { provider: 'free' }), 1);
  assert.equal(picker.findTarget(parsed, ID, { provider: 'max' }), 0);
  assert.equal(picker.findTarget(parsed, ID, { provider: 'missing' }), -1);
});

test('legacy model-only requests prefer the account default group rather than the menu cursor', () => {
  const lines = grouped().map(line => line.includes('2. ') ? line.replace(ID, `${ID} default ✓`) : line);
  const parsed = picker.parsePicker(lines);
  assert.equal(parsed.cursor, 0);
  assert.equal(picker.findTarget(parsed, ID), 1);
  assert.equal(picker.findTarget(parsed, ID, { provider: 'max' }), 0);
  const otherDefault = picker.parsePicker(['Select model', 'max', `❯ 1. ${ID}`, 'free',
    `  2. ${ID}`, '  3. GLM-5.2-WX-Auto default ✓', FOOTER]);
  assert.equal(picker.findTarget(otherDefault, ID), 1, 'default model may differ from the target model');
  const absent = picker.parsePicker(['Select model', 'max', `❯ 1. ${ID}`, 'free',
    `  2. ${ID}`, 'other', '  3. GLM-5.2-WX-Auto default ✓', FOOTER]);
  assert.equal(picker.findTarget(absent, ID), -1, 'default group must contain the requested model');
});

async function runGroupedPick(t, { provider = '', defaultProvider = '', ignoreMove = false } = {}) {
  let clock = 1000, cursor = 1, selected = null, closed = false;
  const file = path.join(__dirname, '../core/codeagent-model-picker.js'), localRequire = createRequire(file), writes = [];
  const lines = () => grouped(cursor).map(line => defaultProvider && line.includes(`${defaultProvider === 'free' ? 2 : 1}. `)
    ? line.replace(ID, `${ID} default ✓`) : line);
  const screen = { lines: async () => closed ? ['❯ ', '? for shortcuts'] : lines(), dispose() {} };
  const context = vm.createContext({ module: { exports: {} }, process, Buffer, screen,
    Date: class extends Date { static now() { return clock; } },
    setTimeout: fn => { clock += 400; fn(); return 1; }, clearTimeout() {},
    require: name => name === './codeagent-usage-menu' ? { readUsageMenu: async lines => ({ lines, usage: null }) } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\nopenSessionScreen = async () => screen;', context);
  const manager = { getSession: () => ({}), writeToSession: (_sid, key) => {
    writes.push(key); if (!ignoreMove && key === '\x1b[B') cursor = 2; if (!ignoreMove && key === '\x1b[A') cursor = 1;
    if (key === '\r') { selected = cursor; closed = true; }
    if (key === '\x1b') closed = true;
  } };
  const result = await context.module.exports.pickModel({ manager, sid: 'grouped', kind: 'codeagent', modelId: ID,
    provider, dataDir: temp(t), sendToPty: async () => ({ ok: true }) });
  return { result, selected, writes };
}

test('actual picker moves to the requested provider and confirms that group before Enter', async t => {
  const { result, selected, writes } = await runGroupedPick(t, { provider: 'free' });
  assert.equal(result.ok, true); assert.equal(selected, 2); assert.equal(writes.filter(key => key === '\r').length, 1);
});

test('legacy actual picker selects the default group and refuses ambiguity without a default', async t => {
  const preferred = await runGroupedPick(t, { defaultProvider: 'free' });
  assert.equal(preferred.result.ok, true);
  assert.equal(preferred.selected, 2);
  const unknown = await runGroupedPick(t);
  assert.equal(unknown.result.ok, false);
  assert.match(unknown.result.message, /重新选择带分组/);
  assert.equal(unknown.selected, null);
  assert.equal(unknown.writes.includes('\r'), false);
});

test('legacy default-group selection checks the group before Enter even when model names match', async t => {
  const { result, selected, writes } = await runGroupedPick(t, { defaultProvider: 'free', ignoreMove: true });
  assert.equal(result.ok, false);
  assert.match(result.technicalReason, /目标分组/);
  assert.equal(selected, null);
  assert.equal(writes.includes('\r'), false);
});

function dom() {
  const document = { elements: [], removeEventListener() {}, addEventListener() {}, body: { appendChild() {} } };
  document.createElement = () => {
    const el = { dataset: {}, style: {}, children: [], ownerDocument: document, events: {}, className: '',
      addEventListener(name, fn) { this.events[name] = fn; }, setAttribute() {}, remove() {},
      appendChild(child) { this.children.push(child); },
      getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, width: 200, height: 20 }) };
    el.classList = { add(name) { el.className += ' ' + name; }, contains(name) { return el.className.split(' ').includes(name); } };
    Object.defineProperty(el, 'innerHTML', { set(value) { this.html = value; this.children = []; }, get() { return this.html || ''; } });
    document.elements.push(el); return el;
  };
  return document;
}

test('error-card recovery reopens automatic session choices and failed switches stay selectable', async () => {
  const document = dom(), session = { kind: 'codeagent', status: 'idle', currentModel: { id: 'glm-4.7-w8a8' } }, calls = [];
  const option = { id: ID, label: `${ID} · free`, provider: 'free', providerLabel: 'free', menuLabel: ID };
  const controller = ui.createModelUiController({ document, sessions: new Map([['s', session]]), terminalPanelEl: { querySelector: () => null },
    getActiveSessionId: () => 's', escapeHtml: String, setTimeoutFn() {},
    ipcRenderer: { invoke: async (channel, payload) => {
      calls.push([channel, payload]);
      if (channel === 'codeagent:session-models') return { options: [option], automatic: true, catalog: { state: 'ready' } };
      return { ok: false, message: 'synthetic failure' };
    } },
  });
  const anchor = document.createElement('span');
  anchor.click = () => {};
  require('../renderer/turn-error-help').runAction('model', { card: { closest: () => ({ querySelector: () => anchor }) }, document });
  assert.equal(anchor.dataset.modelRecovery, 'true');
  await controller.showModelPicker(anchor, 's');
  let rows = document.elements.filter(el => el.dataset.modelId);
  assert.ok(!rows.at(-1).classList.contains('disabled'));
  const menu = document.elements.find(el => el.className === 'model-picker-menu');
  const result = await controller.switchModel('s', option, menu, anchor);
  assert.equal(result.ok, false); assert.equal(session._modelSwitchPending, undefined);
  rows = document.elements.filter(el => el.dataset.modelId);
  assert.ok(!rows.at(-1).classList.contains('disabled'));
  const request = calls.find(([channel]) => channel === 'codeagent:switch-model')[1];
  assert.equal(request.provider, 'free'); assert.equal(request.recovery, true);
  controller.closeModelPicker(); assert.equal(session._codeagentModelRecovery, undefined);
});

test('launch choices separate identical IDs without passing encoded UI values to the CLI', () => {
  const choice = require('../core/codeagent-model-choice');
  const max = choice.choiceValue({ id: ID, provider: 'max' }), free = choice.choiceValue({ id: ID, provider: 'free' });
  assert.notEqual(max, free);
  assert.equal(choice.decodeChoice(free).id, ID);
  assert.equal(choice.decodeChoice(free).codeagentModelProvider, 'free');
  assert.equal(choice.choiceValue({ id: 'legacy' }), 'legacy');
});

test('saved route survives restart metadata and grouped launches require the actual native menu', async t => {
  const root = temp(t), dataDir = path.join(root, 'hub'), configDir = path.join(root, '.cac'), cwd = path.join(root, 'project');
  [dataDir, configDir, cwd].forEach(dir => fs.mkdirSync(dir, { recursive: true }));
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  t.after(() => { if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before; });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: ID }));
  probe.writeProbed(require('../core/codeagent-pool').personalModelsFile(dataDir), { models: [ID], source: 'serve' });
  const Module = require('node:module'), original = Module._load;
  Module._load = function(name, ...args) { return name === 'node-pty' ? { spawn() { throw Error('no CLI'); } } : original.call(this, name, ...args); };
  let sessionModule;
  try { sessionModule = require('../core/session-manager'); } finally { Module._load = original; }
  t.mock.method(require('../core/codeagent-capabilities'), 'readHelp', () => '--settings <path>');
  const route = { codeagentModelProvider: 'free', codeagentModelProviderLabel: 'free', codeagentModelMenuLabel: ID };
  const store = require('../core/session-store'), native = '11111111-1111-4111-8111-111111111111';
  const history = path.join(configDir, native + '.jsonl'); fs.writeFileSync(history, '{}');
  store.saveSessionFile('route', { id: 'route', kind: 'codeagent', cwd, ccSessionId: native, fixedModel: ID, ...route });
  const saved = store.loadSessionFile('route', { strict: true });
  assert.equal(saved.codeagentModelProvider, 'free');
  const restart = require('../core/session-capabilities').buildSessionResumeMeta(saved);
  assert.equal(restart.codeagentModelProvider, 'free');
  assert.equal(sessionModule.SessionManager.prototype._toPublic.call({}, saved).codeagentModelProvider, 'free');
  const launched = [];
  const resume = require('../main/ipc/resume-session-handlers').createResumeSessionHandler({ fs, os, path, getHubDataDir: () => dataDir, getHookPort: () => 0,
    isClaudeFamily: kind => kind === 'codeagent', isCodexBaseKind: () => false, findTranscriptByCCSessionId: () => history,
    sessionManager: { getSession: () => null, createSession(kind, opts) { launched.push(opts); return { ...opts, id: opts.id, kind }; } },
    slotIds: [], meetingManager: { getAllMeetings: () => [], getMeeting: () => null }, registerSessionForTap() {}, sendToRenderer() {} });
  await resume({ hubId: 'route' });
  assert.equal(launched[0].codeagentModelProvider, 'free');
  const build = opts => sessionModule._private.buildCodeAgentPtyLaunch('route', 'codeagent', opts, cwd,
    { HOME: root, USERPROFILE: root }, { command: 'never-run', configDir });
  const groupedLaunch = build({ model: ID, fixedModel: ID, codeagentModelPick: true, ...route });
  assert.equal(groupedLaunch.settingsModel, '');
  assert.equal(groupedLaunch.requiresMenu, true);
  assert.doesNotMatch(groupedLaunch.cmd, /--settings/);
  const legacy = build({ model: ID, fixedModel: ID, codeagentModelPick: true });
  assert.equal(legacy.settingsModel, ID); assert.equal(legacy.requiresMenu, false);
});

test('main switch forwards the chosen provider and recovery intent but refuses an active turn', async () => {
  const file = path.join(__dirname, '../main/ipc/session-handlers.js'), source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('  async function switchCodeAgentModel('), end = source.indexOf("  ipcMain.handle('codeagent:switch-model'", start);
  let active = true, routed, overlays = 0;
  const session = { kind: 'codeagent', status: 'running', fixedModel: 'glm-4.7-w8a8' };
  const context = vm.createContext({ console,
    sessionManager: { getSession: () => session, isAgentTurnActive: () => active, updateSessionMeta: (_id, fields) => Object.assign(session, fields) },
    codeagentPicker: { isPicking: () => false, schedulePick: (_sid, fn) => fn() }, pendingModelSelections: new Map(),
    updateCodeAgentModelSettings: () => { overlays++; return {}; },
    runCodeAgentPick: async (_sid, _model, _reason, selection) => { routed = selection; return { ok: true }; },
    require: name => name === '../../core/codeagent-models' ? models : name === '../../core/data-dir' ? { getHubDataDir: () => '' }
      : name === '../../core/codeagent-launch-model' ? { rememberModel() {} }
      : name === '../../core/codeagent-model-replacements' ? { recordReplacement() {} }
      : name === '../../core/session-store' ? { saveSessionFile() {} } : createRequire(file)(name),
  });
  vm.runInContext(source.slice(start, end), context);
  const request = { sessionId: 's', modelId: ID, provider: 'free', providerLabel: 'free', recovery: true };
  assert.equal((await context.switchCodeAgentModel(request)).error, 'busy');
  assert.equal(routed, undefined);
  active = false;
  assert.equal((await context.switchCodeAgentModel(request)).ok, true);
  assert.equal(routed.provider, 'free'); assert.equal(routed.recovery, true);
  assert.equal(session.codeagentModelProvider, 'free'); assert.equal(overlays, 1);
});
