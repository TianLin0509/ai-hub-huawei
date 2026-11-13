'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const rendererFile = path.join(__dirname, '..', 'renderer', 'renderer.js');
const source = fs.readFileSync(rendererFile, 'utf8');
const rendererRequire = createRequire(rendererFile);
const aiKinds = require('../core/ai-kinds');
const runtime = require('../core/session-runtime-truth');

function aiKindsImport(code) {
  const match = code.match(/const\s*\{([^}]+)\}\s*=\s*require\(['"]\.\.\/core\/ai-kinds(?:\.js)?['"]\);/);
  assert.ok(match, 'renderer must explicitly import its ai-kinds bindings');
  return { statement: match[0], bindings: match[1].split(',').map(part => part.trim()).filter(Boolean) };
}

// V8 parses the complete renderer; the export-name check deliberately has no parser dependency.
// It covers bare ai-kinds export references, including constants; property accesses and literal text are excluded.
function checkAiKindsImports(code) {
  new vm.Script(code, { filename: 'renderer.js' });
  const { statement, bindings } = aiKindsImport(code);
  const imported = new Set();
  for (const binding of bindings) {
    const [exported, local = exported] = binding.split(':').map(part => part.trim());
    assert.ok(Object.hasOwn(aiKinds, exported), `ai-kinds does not export ${exported}`);
    imported.add(local);
  }
  const executable = code.replace(statement, '').replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' ');
  for (const exported of Object.keys(aiKinds)) {
    const reference = new RegExp(`(?<![\\w$.])${exported}\\b(?!\\s*:)`);
    if (reference.test(executable)) assert.ok(imported.has(exported), `ai-kinds export ${exported} is used without an import`);
  }
}

function functionSource(code, name, indent = '') {
  const match = code.match(new RegExp(`^${indent}function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^${indent}\\}`, 'm'));
  assert.ok(match, `missing renderer function ${name}`);
  new vm.Script(`(${match[0]})`);
  return match[0];
}

function sendFixture({ code = source, kind = 'codeagent', text = '普通消息', paneOptimistic = true, purpose, skill = null, splitPane = false, result = { ok: true }, account = '', recovery = false, commands = [] } = {}) {
  const sessionId = 'test-session';
  const session = { id: sessionId, kind, agentRuntime: 'pty', status: 'idle', createdAt: 1000, codeagentPoolAccount: account, ...(purpose ? { purpose } : {}) };
  const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const calls = { ipc: [], cards: [], waiting: [], bursts: [], working: [], observations: [], toasts: [], warnings: [], views: [], recoveries: [] };
  const inputBox = { text, skill, focus() {}, querySelector: () => inputBox.skill ? { dataset: { codeagentSkill: inputBox.skill.name, installedAt: String(inputBox.skill.installedAt || 0) } } : null };
  const bar = { dataset: { sessionId } };
  bar._codeagentSkills = { open: () => calls.views.push('hub-skills'), isCommand: text => require('../renderer/composer-codeagent-skills').commandName(text, commands) };
  bar.querySelector = () => ({ model: true });
  if (recovery) bar._codeagentInputRecovery = { show: (value, retry) => calls.recoveries.push({ value, retry }), submitted() {} };
  const mount = (cardText, cardKind, receipt, route) => {
    const card = { dataset: { optimistic: 'true', sessionId }, remove() { this.removed = true; } };
    calls.cards.push({ text: cardText, kind: cardKind, receipt, route, card });
    return card;
  };
  const context = vm.createContext({ focusAfterSend() {},
    require: name => recovery && name === './composer-codeagent-input' ? { ...rendererRequire(name), restoreRecoveredPrompt: (box, value, options) => { box.text = box.text + (box.text ? '\n\n' : '') + value.text; box.skill ||= value.skill; options.onChange(); } } : rendererRequire(name),
    localStorage: storage,
    turnCardRenderer: { markUserStopped: (_sid, card) => { if (card) card.dataset.stopped = 'true'; }, latestUserCard: () => null },
    document: { querySelectorAll: () => [bar] }, window: {}, updateFloatingPromptReceipt() {}, reportFloatingSendFailure() {},
    modelUi: { showModelPicker: () => calls.views.push('hub-model') },
    sessionId, sessions: new Map([[sessionId, session]]), inputBox, inputHistory: null,
    terminal: { scrollToBottom() {}, focus() {} }, bar, currentView: 'card',
    pane: { isCard: () => true, ...(splitPane ? { openTerminal: () => calls.views.push('split-pty') } : {}), ...(paneOptimistic ? { optimistic: (text, kind, receipt) => mount(text, kind, receipt, 'pane') } : {}) },
    activeSessionId: sessionId, selectSession: async id => calls.views.push(id), applyViewMode: mode => calls.views.push(mode),
    mountOptimisticUserCard: (_sessionId, text, kind, receipt) => mount(text, kind, receipt, 'fallback'),
    readContenteditablePlainText: box => box.text,
    replaceContenteditableText: (box, value) => { box.text = value; box.skill = null; },
    clearFloatingInputDraft() {}, saveFloatingInputDraft() {}, clearFloatingInputStuck() {},
    commandFeedbackSequence: 0, commandFeedback: { clear() {}, show() {} },
    getSessionRuntimeTruth: runtime.getSessionRuntimeTruth,
    RUNTIME_RUNNING: runtime.RUNTIME_RUNNING, RUNTIME_STARTING: runtime.RUNTIME_STARTING, CONFIDENCE_SEMANTIC: runtime.CONFIDENCE_SEMANTIC,
    clearSessionWaitingState: id => calls.waiting.push(id),
    armPtyBurstFallback: id => calls.bursts.push(id),
    markCodexCardWorking: id => calls.working.push(id), notePtyTurnBoundary() {}, scheduleSessionListRender() {},
    observeSessionRuntime: (target, observation) => { calls.observations.push(observation); return runtime.applySessionRuntimeObservation(target, observation); },
    floatingInputDrafts: new Map(), floatingPromptDeliveries: new Map(),
    beginPromptDelivery: id => ({ clientSubmissionId: id, status: 'pending' }),
    ipcRenderer: { invoke: async (channel, payload) => { calls.ipc.push({ channel, payload }); return typeof result === 'function' ? result(channel, payload) : result; } },
    showToast: (text, level) => calls.toasts.push({ text, level }),
    console: { warn: (...args) => calls.warnings.push(args) },
  });
  // Execute the actual imports and sendInput source, not a duplicate of its classification/receipt expressions.
  const helpers = ['isTranscriptCliKind', 'isDshCliSession', 'isLegacyDeepSeekSession', 'isClaudeRuntimeSession']
    .map(name => functionSource(code, name)).join('\n');
  const nativeImport = code.match(/^const \{ isNativeAgent \} = require\('\.\.\/core\/native-agent-runtime\.js'\);/m);
  assert.ok(nativeImport);
  const sendInput = vm.runInContext(`${aiKindsImport(code).statement}\n${nativeImport[0]}\n${helpers}\n${functionSource(code, 'openCodeAgentSkillsMenu')}\n${functionSource(code, 'sendInput', '  ')}\nsendInput`, context);
  return { sendInput, calls, session, inputBox, storage, context };
}

test('renderer ai-kinds exports used as bare identifiers have explicit valid imports', () => {
  checkAiKindsImports(source);
});

test('the import guard and real sendInput replay both reproduce the missing-import regression', async () => {
  const originalImport = aiKindsImport(source).statement;
  const broken = source.replace(originalImport, originalImport.replace(/,\s*isCodeAgentKind\b/, ''));
  assert.notEqual(broken, source);
  assert.throws(() => checkAiKindsImports(broken), /isCodeAgentKind is used without an import/);
  const fixture = sendFixture({ code: broken });
  fixture.sendInput();
  await new Promise(setImmediate);
  assert.equal(fixture.calls.ipc.length, 0);
  assert.match(fixture.calls.toasts[0].text, /消息未发送：isCodeAgentKind is not defined/);
  assert.equal(fixture.inputBox.text, '普通消息');
});

for (const scenario of [
  { name: 'CodeAgent ordinary message', kind: 'codeagent', text: '普通消息', tracked: true, receipt: true },
  { name: 'CodeAgent skill command', kind: 'codeagent', text: '/git-ai whoami', tracked: true, receipt: true },
  { name: 'CodeAgent resumed skill command', kind: 'codeagent-resume', text: '/git-ai', tracked: true, receipt: true },
  { name: 'CodeAgent local command', kind: 'codeagent', text: '/model', tracked: false, receipt: true },
  { name: 'Claude ordinary message', kind: 'claude', text: '普通消息', tracked: true, receipt: false },
  { name: 'Claude slash command', kind: 'claude', text: '/compact', tracked: false, receipt: false },
  { name: 'Claude skills command remains unchanged', kind: 'claude', text: '/skills', tracked: false, receipt: false },
  { name: 'Codex slash command', kind: 'codex', text: '/model', tracked: false, receipt: false },
  { name: 'company assistant Claude message', kind: 'claude', text: '普通消息', purpose: 'hub-assistant', tracked: true, receipt: true },
]) {
  test(`real renderer sendInput submits ${scenario.name} with its original optimistic receipt policy`, async () => {
    const fixture = sendFixture(scenario);
    assert.doesNotThrow(() => fixture.sendInput());
    await new Promise(setImmediate);
    assert.deepEqual(fixture.calls.toasts, []);
    assert.deepEqual(fixture.calls.warnings, []);
    assert.equal(fixture.calls.ipc.length, 1, 'preparation must reach the actual dispatch branch');
    assert.equal(fixture.calls.ipc[0].channel, 'session:send-prompt');
    const payload = fixture.calls.ipc[0].payload;
    assert.equal(payload.text, scenario.text);
    assert.equal(payload.memoryIndex, true);
    assert.equal(fixture.inputBox.text, '');
    assert.equal(fixture.calls.cards.length, 1);
    const card = fixture.calls.cards[0];
    assert.equal(card.route, 'pane');
    assert.equal(card.text, scenario.text);
    assert.equal(card.kind, scenario.kind);
    assert.equal(card.receipt.clientSubmissionId, scenario.receipt ? payload.clientSubmissionId : undefined);
    assert.equal(Object.keys(card.receipt).length, scenario.receipt ? 1 : 0);
    assert.equal(fixture.calls.waiting.length, scenario.tracked ? 1 : 0);
    assert.equal(fixture.calls.bursts.length, scenario.tracked ? 1 : 0);
    assert.equal(fixture.calls.observations.length, scenario.tracked ? 1 : 0);
    if (scenario.tracked) assert.equal(fixture.session.runtimeTruth.state, runtime.RUNTIME_STARTING);
    else assert.equal(fixture.session.runtimeTruth, undefined);
  });
}

test('the primary fallback optimistic mount also creates exactly one receipt-bearing CodeAgent card', async () => {
  const fixture = sendFixture({ text: '/git-ai whoami', paneOptimistic: false });
  fixture.sendInput();
  await new Promise(setImmediate);
  assert.deepEqual(fixture.calls.toasts, []);
  assert.equal(fixture.calls.ipc.length, 1);
  assert.equal(fixture.calls.cards.length, 1);
  assert.equal(fixture.calls.cards[0].route, 'fallback');
  assert.equal(fixture.calls.cards[0].receipt.clientSubmissionId, fixture.calls.ipc[0].payload.clientSubmissionId);
});

for (const scenario of [
  { text: '/insight-hub 写一份总结', skill: { name: 'insight-hub', installedAt: 500 }, expected: '/insight-hub 写一份总结' },
  { text: '/insight-hub ', skill: { name: 'insight-hub' }, expected: '/insight-hub' },
  { text: '标签已删除后的正文', skill: null, expected: '标签已删除后的正文' },
]) test(`real sendInput submits selected/deleted skill tag: ${scenario.expected}`, async () => {
  const fixture = sendFixture(scenario);
  fixture.sendInput(); await new Promise(setImmediate);
  assert.equal(fixture.calls.ipc[0].channel, 'session:send-prompt');
  assert.equal(fixture.calls.ipc[0].payload.text, scenario.expected);
  assert.equal(fixture.calls.cards.length, 1);
  assert.equal(fixture.calls.cards[0].text, scenario.expected);
  assert.equal(fixture.calls.cards[0].receipt.clientSubmissionId, fixture.calls.ipc[0].payload.clientSubmissionId);
  assert.equal(fixture.calls.observations[0].state, runtime.RUNTIME_STARTING);
  assert.equal(fixture.inputBox.skill, null);
});

test('real sendInput warns for a late-installed tag and still submits it', async () => {
  const fixture = sendFixture({ text: '/insight-hub test', skill: { name: 'insight-hub', installedAt: 2000 } });
  fixture.sendInput(); await new Promise(setImmediate);
  assert.equal(fixture.calls.ipc.length, 1);
  assert.equal(fixture.calls.toasts[0].text, '这个技能在本会话启动后才安装，若未生效请新开会话');
});

for (const splitPane of [false, true]) test(`real /skills opens Hub skills in the ${splitPane ? 'split' : 'primary'} pane without submitting to CLI`, async () => {
  const fixture = sendFixture({ text: '/skills', splitPane });
  fixture.sendInput(); await new Promise(setImmediate);
  assert.deepEqual(fixture.calls.views, ['hub-skills']);
  assert.equal(fixture.calls.ipc.length, 0);
  assert.equal(fixture.calls.cards.length, 0);
  assert.equal(fixture.calls.observations.length, 0);
  assert.equal(fixture.inputBox.text, '');
  assert.equal(fixture.calls.toasts.length, 0);
});

test('real /skills can open Hub inventory during an answer without writing to PTY', async () => {
  const fixture = sendFixture({ text: '/skills' }); fixture.session.status = 'running';
  runtime.applySessionRuntimeObservation(fixture.session, { state: runtime.RUNTIME_RUNNING, source: 'hook', confidence: runtime.CONFIDENCE_AUTHORITATIVE });
  fixture.sendInput(); await new Promise(setImmediate);
  assert.equal(fixture.calls.ipc.length, 0); assert.deepEqual(fixture.calls.views, ['hub-skills']);
  assert.equal(fixture.inputBox.text, ''); assert.equal(fixture.calls.toasts.length, 0);
});

test('recent skill storage failure only warns and never logs the prompt or error body', async () => {
  const f = sendFixture({ text: '/test-skill private-prompt', skill: { name: 'test-skill' } });
  f.storage.setItem = () => { throw new Error('private-error-body'); };
  f.sendInput(); await new Promise(setImmediate);
  assert.equal(f.calls.ipc.length, 1);
  assert.deepEqual(f.calls.toasts, []);
  assert.deepEqual(f.calls.warnings, [['[codeagent-skills] recent-use save failed']]);
  assert.doesNotMatch(JSON.stringify(f.calls.warnings), /private-prompt|private-error-body/);
});

test('real tagged sends record recent skills only after success, isolated to the submitted account', async () => {
  const skillApi = require('../renderer/composer-codeagent-skills');
  const fixture = sendFixture({ text: '/insight-hub test', skill: { name: 'insight-hub' }, account: 'testpool' });
  assert.deepEqual(skillApi.readRecentSkills(fixture.storage, fixture.session), []);
  fixture.sendInput();
  assert.deepEqual(skillApi.readRecentSkills(fixture.storage, fixture.session), [], 'no usage record before IPC resolves');
  await new Promise(setImmediate);
  assert.equal(skillApi.readRecentSkills(fixture.storage, fixture.session)[0].name, 'insight-hub');
  assert.deepEqual(skillApi.readRecentSkills(fixture.storage, { kind: 'codeagent' }), []);
  assert.equal(fixture.calls.ipc[0].payload.codeagentInteractiveCommand, undefined, 'ordinary skill acknowledgements must remain unchanged');
  const manual = sendFixture({ text: '/insight-hub test' }); manual.sendInput(); await new Promise(setImmediate);
  assert.deepEqual(skillApi.readRecentSkills(manual.storage, manual.session), [], 'manual text is not a tag selection');
});

for (const result of [{ ok: false, notSent: true }, { ok: true, sendStatus: 'stuck' }, { ok: false, unconfirmed: true }]) {
  test(`real tagged send does not record failed or unconfirmed result: ${JSON.stringify(result)}`, async () => {
    const fixture = sendFixture({ text: '/insight-hub test', skill: { name: 'insight-hub' }, result });
    fixture.sendInput(); await new Promise(setImmediate);
    assert.deepEqual(require('../renderer/composer-codeagent-skills').readRecentSkills(fixture.storage, fixture.session), []);
  });
}

test('real cached commands use the explicit interactive option and model maps to Hub', async () => {
  const fixture = sendFixture();
  await vm.runInContext("openCodeAgentSkillsMenu(sessionId, pane, '/unknown')", fixture.context);
  assert.equal(fixture.calls.ipc[0].payload.text, '/unknown');
  assert.equal(fixture.calls.ipc[0].payload.codeagentInteractiveCommand, true);
  fixture.calls.ipc.length = 0;
  await vm.runInContext("openCodeAgentSkillsMenu(sessionId, pane, '/model')", fixture.context);
  assert.equal(fixture.calls.ipc.length, 0); assert.equal(fixture.calls.views.at(-1), 'hub-model');
  assert.equal(fixture.calls.cards.length, 0);
  const cached = sendFixture({ text: '/assist argument', commands: [{ name: 'help', aliases: ['assist'] }] });
  cached.sendInput(); await new Promise(setImmediate);
  assert.equal(cached.calls.ipc[0].payload.text, '/assist argument'); assert.equal(cached.calls.ipc[0].payload.codeagentInteractiveCommand, true);
  assert.equal(cached.calls.cards.length, 0);
});

for (const skill of [null, { name: 'test-skill', installedAt: 1 }]) test(`failed auto-clear restores a draft without a retry route (${skill ? 'tagged' : 'ordinary'})`, async () => {
  const text = skill ? '/test-skill new requirement' : 'new requirement';
  const f = sendFixture({ text, skill, recovery: true, result: { ok: false, notSent: true, code: 'codeagent-input-residual' } });
  f.sendInput(); await new Promise(setImmediate);
  assert.equal(f.calls.ipc.length, 1); assert.equal(f.inputBox.text, text);
  assert.equal(f.inputBox.skill?.name, skill?.name);
  assert.equal(f.calls.cards[0].card.removed, true); assert.equal(f.calls.recoveries.length, 0);
  assert.notEqual(runtime.getSessionRuntimeTruth(f.session).state, runtime.RUNTIME_STARTING);
  assert.equal(f.calls.ipc[0].payload.codeagentDiscardToken, undefined);
});

test('failed auto-clear on an interactive command keeps the composer and submits only once', async () => {
  const f = sendFixture({ text: '/help', commands: [{ name: 'help' }], recovery: true, result: { ok: false, notSent: true, code: 'codeagent-input-residual' } });
  f.sendInput(); await new Promise(setImmediate);
  assert.equal(f.inputBox.text, '/help'); assert.equal(f.calls.cards.length, 0); assert.equal(f.calls.recoveries.length, 0);
  assert.equal(f.calls.ipc.length, 1); assert.equal(f.calls.ipc[0].payload.codeagentInteractiveCommand, true);
});

test('the real stop click rechecks running state and routes CodeAgent to the shared main action', async () => {
  const marker = "  stopBtn.addEventListener('click', async (e) => {";
  const at = source.indexOf(marker), end = source.indexOf('\n  });', at);
  assert.ok(at >= 0 && end > at);
  const body = source.slice(at + marker.length, end);
  const current = { kind: 'codeagent', agentRuntime: 'pty', status: 'idle' }, calls = [], toasts = [];
  const context = vm.createContext({ focusAfterSend() {}, sessionId: 'test', sessions: new Map([['test', current]]),
    turnCardRenderer: { latestUserCard: () => null, markUserStopped() {} },
    stopBtn: { dataset: {} }, bar: { _codeagentInputRecovery: { stop: async () => calls.push('shared-stop') } },
    getSessionRuntimeTruth: runtime.getSessionRuntimeTruth, RUNTIME_RUNNING: runtime.RUNTIME_RUNNING, isCodeAgentKind: aiKinds.isCodeAgentKind,
    showToast: text => toasts.push(text), ipcRenderer: { send: (...args) => calls.push(args) },
  });
  const click = vm.runInContext(`(async e => {${body}\n})`, context);
  await click({ stopPropagation() {} }); assert.deepEqual(calls, []); assert.deepEqual(toasts, ['回答已结束']);
  current.status = 'running';
  await click({ stopPropagation() {} }); assert.deepEqual(calls, ['shared-stop']);
  assert.equal(context.stopBtn.disabled, false); assert.equal(context.stopBtn.textContent, '停止');
  const oldBytes = [];
  require('../renderer/pty-interrupt').sendPtyAgentInterrupt({ kind: 'codeagent' }, { state: 'running', now: 1000, send: byte => oldBytes.push(byte) });
  assert.deepEqual(oldBytes, ['\x1b'], 'legacy PTY helper emitted one Esc; actual CodeAgent stopping effect needs a real CLI');
});

test('both phone and HubTools CodeAgent interruptions use the same guarded stop action', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const callbacks = [...main.matchAll(/interruptSession: (async id => \{[\s\S]*?^\s{4,6}\}),/gm)];
  assert.equal(callbacks.length, 2);
  for (const [, callback] of callbacks) {
    const current = { kind: 'codeagent' }, calls = [];
    const interrupt = vm.runInNewContext(`(${callback})`, {
      sessionManager: { getSession: () => current, writeToSession: (...args) => calls.push(args) },
      require: name => name === './core/ai-kinds' ? aiKinds : { codeAgentInputAction: async (...args) => { calls.push(args); return { ok: true }; } },
    });
    await interrupt('test'); assert.deepEqual(calls, [['test', 'stop']]);
    current.kind = 'claude'; calls.length = 0;
    await interrupt('test'); assert.deepEqual(calls, [['test', '\x1b']]);
  }
});

for (const unavailable of [false, true]) test(`late-arriving CodeAgent info lazily creates recovery or invokes stop directly (unavailable=${unavailable})`, async () => {
  const marker = "  stopBtn.addEventListener('click', async (e) => {";
  const at = source.indexOf(marker), end = source.indexOf('\n  });', at), body = source.slice(at + marker.length, end);
  const ensure = functionSource(source, 'ensureCodeAgentInputRecovery', '  ');
  const sessions = new Map(), calls = [], notices = [], bar = {};
  const context = vm.createContext({ focusAfterSend() {}, sessionId: 'test', sessions, bar, recoveryHost: {}, document: {}, window: {},
    turnCardRenderer: { latestUserCard: () => null, markUserStopped() {} },
    stopBtn: { dataset: {} }, RUNTIME_RUNNING: runtime.RUNTIME_RUNNING, isCodeAgentKind: aiKinds.isCodeAgentKind,
    getSessionRuntimeTruth: runtime.getSessionRuntimeTruth, showToast: text => notices.push(text),
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true }; } },
    require: () => ({ createCodeAgentInputRecovery: options => {
      if (unavailable) throw new Error('panel unavailable');
      return { stop: diagnostic => options.invoke('codeagent:input-stop', diagnostic) };
    } }),
  });
  vm.runInContext(ensure, context);
  assert.equal(vm.runInContext('ensureCodeAgentInputRecovery()', context), null);
  sessions.set('test', { kind: 'codeagent', agentRuntime: 'pty', status: 'running' });
  await vm.runInContext(`(async e => {${body}\n})`, context)({ stopPropagation() {} });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'codeagent:input-stop');
  assert.equal(calls[0][1].branch, unavailable ? 'direct' : 'created'); assert.equal(calls[0][1].rendererState, 'running');
  assert.equal(context.stopBtn.disabled, false);
});

for (const notSent of [false, true]) test(`real sendInput treats stopped as stopped without resend/failure (notSent=${notSent})`, async () => {
  const f = sendFixture({ text: '/test-skill body', recovery: true, result: { ok: true, stopped: true, notSent, sendStatus: 'stopped' } });
  f.sendInput(); await new Promise(setImmediate);
  assert.equal(f.calls.ipc.length, 1); assert.equal(f.calls.warnings.length, 0);
  assert.equal(f.context.floatingPromptDeliveries.get('test-session').status, 'stopped');
  assert.equal(f.calls.cards[0].card.removed === true, notSent);
  assert.equal(f.inputBox.text, notSent ? '/test-skill body' : '');
  if (notSent) assert.ok(f.calls.toasts.some(toast => /已停止/.test(toast.text)));
  else assert.equal(f.calls.toasts.length, 0, 'the Stop controller owns the optional restore toast');
});

test('an unsent Stop restores after a newly typed draft instead of overwriting it', async () => {
  let finish;
  const f = sendFixture({ text: '/test-skill old body', skill: { name: 'test-skill' }, recovery: true,
    result: () => new Promise(resolve => { finish = resolve; }) });
  f.sendInput(); await new Promise(setImmediate);
  f.inputBox.text = 'new draft';
  finish({ ok: true, stopped: true, notSent: true, sendStatus: 'stopped' }); await new Promise(setImmediate);
  assert.equal(f.inputBox.text, 'new draft\n\n/test-skill old body');
  assert.equal(f.calls.cards[0].card.removed, true); assert.equal(f.calls.ipc.length, 1);
});

test('actual residual-cleared IPC saves readable text in the same ArrowUp history and invalidates mounted cursors', () => {
  const start = source.indexOf("ipcRenderer.on('codeagent-input-cleared',");
  const end = source.indexOf('\n});', start) + 4;
  const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  let callback, invalidated = 0; const toasts = [];
  vm.runInNewContext(source.slice(start, end), {
    require: rendererRequire, window: { localStorage: storage }, showToast: text => toasts.push(text),
    ipcRenderer: { on: (_event, cb) => { callback = cb; } },
    document: { querySelectorAll: () => [{ dataset: { sessionId: 'test' }, _codeagentInputHistoryChanged: () => { invalidated += 1; } }] },
  });
  const history = require('../renderer/floating-input-history').createFloatingInputHistory({ storage });
  history.push('test', 'latest Hub send');
  callback(null, { sessionId: 'test', text: 'terminal draft' });
  assert.equal(history.createCursor('test').older('').text, 'terminal draft'); assert.equal(invalidated, 1);
  assert.equal(toasts[0], '已清掉终端里未发送的内容，按 ↑ 可找回');
  callback(null, { sessionId: 'test', text: '' });
  assert.deepEqual(history.list('test'), ['terminal draft', 'latest Hub send']);
  assert.equal(toasts[1], '已清掉终端里未发送的内容');
});

function editClickFixture({ draft = '', kind = 'claude', cardSid = 'test', activeSid = 'test', group = false } = {}) {
  const marker = "  if (action === 'edit-resend') {", start = source.indexOf(marker);
  const ending = /\r?\n    return;\r?\n  }\r?\n}\);/.exec(source.slice(start));
  const end = ending ? start + ending.index : -1;
  assert.ok(start >= 0 && end > start);
  const values = new Map(), notices = [], saved = [], events = [], storage = {
    getItem: key => values.get(key), setItem: (key, value) => values.set(key, value),
  };
  const history = require('../renderer/floating-input-history').createFloatingInputHistory({ storage }), cursor = history.createCursor(cardSid);
  const input = { text: draft, isConnected: true, querySelector: () => null, focus() { this.focused = true; },
    dispatchEvent: event => events.push(event.type), closest: () => ({ _codeagentInputHistoryChanged: () => cursor.invalidate() }) };
  const card = { closest: selector => selector === '[data-group-member]' && group ? { dataset: { groupMember: cardSid } }
    : selector === '.terminal-panel' && !group ? { querySelector: () => input } : null };
  let collapsed;
  const context = vm.createContext({ focusAfterSend() {}, require: rendererRequire, card, turn: { text: 'original' }, sessions: new Map([[cardSid, { kind }]]),
    getCardSessionId: () => cardSid, activeSessionId: activeSid, showToast: text => notices.push(text), localStorage: storage,
    document: { getElementById: () => input, createRange: () => ({ selectNodeContents() {}, collapse: value => { collapsed = value; } }) },
    window: { Event: class { constructor(type) { this.type = type; } }, getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    MeetingRoom: { getActiveMeetingId: () => 'room', getMeetingData: () => ({ subSessions: [cardSid], slotSpecs: [{ memberId: 'reviewer' }] }) },
    readContenteditablePlainText: box => box.text, replaceContenteditableText: (box, text) => { box.text = text; },
    saveFloatingInputDraft: (sid, box) => saved.push({ sid, text: box.text }), ipcRenderer: { invoke: async () => ({ skills: [] }) },
  });
  const click = vm.runInContext(`(async () => {${source.slice(start + marker.length, end)}\n})`, context);
  return { click, input, saved, notices, cursor, history, events, caretAtEnd: () => collapsed === false };
}

test('the real edit-resend handler replaces drafts for every CLI and persists the replaced draft for ArrowUp', async () => {
  for (const kind of ['codeagent', 'claude', 'codex']) for (const draft of ['', 'new draft']) {
    const f = editClickFixture({ draft, kind }); await f.click();
    assert.equal(f.input.text, 'original'); assert.equal(f.input.focused, true); assert.equal(f.caretAtEnd(), true);
    assert.equal(f.saved.at(-1).sid, 'test'); assert.equal(f.saved.at(-1).text, 'original'); assert.deepEqual(f.events, ['input']);
    assert.deepEqual(f.history.list('test'), draft ? [draft] : []);
    if (draft) { assert.equal(f.cursor.older('original').text, draft); assert.equal(f.notices[0], '原草稿已存入历史，按 ↑ 找回'); }
  }
});

test('the real edit-resend handler refuses cross-session cards with a notice and replaces group drafts with the member prefix', async () => {
  const wrong = editClickFixture({ draft: 'keep', activeSid: 'other' }); await wrong.click();
  assert.equal(wrong.input.text, 'keep'); assert.deepEqual(wrong.saved, []);
  assert.deepEqual(wrong.notices, ['这条消息不属于当前会话']); assert.deepEqual(wrong.history.list('test'), []);
  const group = editClickFixture({ draft: 'group draft', group: true }); await group.click();
  assert.equal(group.input.text, '@reviewer original'); assert.equal(group.cursor.older('').text, 'group draft');
  assert.equal(group.caretAtEnd(), true); assert.equal(group.saved.at(-1).text, '@reviewer original');
});

test('after edit-resend the actual ArrowUp path recalls the replaced draft even with the caret at the end', () => {
  const historyApi = require('../renderer/floating-input-history'), values = new Map();
  const history = historyApi.createFloatingInputHistory({ storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) } });
  const input = { text: 'original prompt' }, bar = {};
  history.push('test', 'saved draft');
  const context = vm.createContext({ focusAfterSend() {}, bar, inputBox: input, inputHistory: history, historyCursor: history.createCursor('test'), historyApi,
    editResendHistoryReady: false, contenteditableHasText: box => !!box.text, isCaretAtContenteditableStart: () => false,
    readContenteditablePlainText: box => box.text, applyHistoryText: text => { input.text = text; } });
  const ready = source.match(/bar\._editResendHistoryChanged = \(\) => \{[^\n]+\};/)[0];
  vm.runInContext(ready, context);
  const start = /    if \(inputHistory\) \{\r?\n      const hasModifier/.exec(source)?.index ?? -1;
  const end = source.indexOf("    if (e.key === 'Escape')", start);
  assert.ok(start >= 0 && end > start);
  const onKey = vm.runInContext(`(e => {${source.slice(start, end)}\n})`, context);
  let prevented = 0;
  const up = { key: 'ArrowUp', preventDefault: () => { prevented++; } };
  onKey(up); assert.equal(input.text, 'original prompt'); assert.equal(prevented, 0, 'ordinary caret-at-end navigation stays unchanged');
  bar._editResendHistoryChanged(); onKey(up);
  assert.equal(input.text, 'saved draft'); assert.equal(prevented, 1); assert.equal(context.editResendHistoryReady, false);
});

test('an idle Stop click records the renderer decision without sending stop keys', async () => {
  const marker = "  stopBtn.addEventListener('click', async (e) => {";
  const at = source.indexOf(marker), end = source.indexOf('\n  });', at), calls = [];
  const click = vm.runInNewContext(`(async e => {${source.slice(at + marker.length, end)}\n})`, {
    sessionId: 'test', sessions: new Map([['test', { kind: 'codeagent', agentRuntime: 'pty', status: 'idle' }]]),
    bar: {}, stopBtn: { dataset: {} }, isCodeAgentKind: aiKinds.isCodeAgentKind,
    getSessionRuntimeTruth: runtime.getSessionRuntimeTruth, RUNTIME_RUNNING: runtime.RUNTIME_RUNNING, showToast() {},
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true }; } },
  });
  await click({ stopPropagation() {} });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'codeagent:stop-diagnostic'); assert.equal(calls[0][1].rendererState, 'idle');
});

// ---------- 卡住消息的重发按钮（2026-11-12） ----------
{
// 2026-11-12：发送卡住时挂着的临时气泡卡（pending-user-*）不进轮次表，
// 「重发这条消息」「编辑重发」曾在 getTurnFromCard 处静默 return，用户只能手动复制重发。
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const CARD = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'turn-card-renderer.js'), 'utf8');

test('临时气泡卡查不到轮次时用卡上原文兜底，且不再静默 return', () => {
  const start = RENDERER.indexOf("const btn = e.target.closest('.ta-btn');");
  assert.ok(start > 0, '找不到卡片操作 click handler');
  const head = RENDERER.slice(start, start + 900);
  assert.ok(head.includes('card.dataset.optimisticText'));
  assert.ok(!/if \(!turn\) return;/.test(head));
  assert.ok(CARD.includes('cardEl.dataset.optimisticText = text'));
});
}
