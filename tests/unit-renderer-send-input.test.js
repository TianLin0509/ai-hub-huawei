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

function sendFixture({ code = source, kind = 'codeagent', text = '普通消息', paneOptimistic = true, purpose, skill = null, splitPane = false, result = { ok: true }, account = '', recovery = false } = {}) {
  const sessionId = 'test-session';
  const session = { id: sessionId, kind, agentRuntime: 'pty', status: 'idle', createdAt: 1000, codeagentPoolAccount: account, ...(purpose ? { purpose } : {}) };
  const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const calls = { ipc: [], cards: [], waiting: [], bursts: [], working: [], observations: [], toasts: [], warnings: [], views: [], recoveries: [] };
  const inputBox = { text, skill, focus() {}, querySelector: () => inputBox.skill ? { dataset: { codeagentSkill: inputBox.skill.name, installedAt: String(inputBox.skill.installedAt || 0) } } : null };
  const bar = { dataset: { sessionId } };
  if (recovery) bar._codeagentInputRecovery = { show: (value, retry) => calls.recoveries.push({ value, retry }), submitted() {} };
  const mount = (cardText, cardKind, receipt, route) => {
    const card = { dataset: { optimistic: 'true', sessionId }, remove() { this.removed = true; } };
    calls.cards.push({ text: cardText, kind: cardKind, receipt, route, card });
    return card;
  };
  const context = vm.createContext({
    require: name => recovery && name === './composer-codeagent-input' ? { ...rendererRequire(name), restoreRecoveredPrompt: (box, value, options) => { box.text = value.text; box.skill = value.skill; options.onChange(); } } : rendererRequire(name),
    localStorage: storage,
    document: { querySelectorAll: () => recovery ? [bar] : [] }, window: {}, updateFloatingPromptReceipt() {}, reportFloatingSendFailure() {},
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

for (const splitPane of [false, true]) test(`real /skills send switches the ${splitPane ? 'split' : 'primary'} pane to terminal before dispatch, with no card`, async () => {
  const fixture = sendFixture({ text: '/skills', splitPane });
  fixture.sendInput(); await new Promise(setImmediate);
  assert.deepEqual(fixture.calls.views, [splitPane ? 'split-pty' : 'pty']);
  assert.equal(fixture.calls.ipc[0].payload.text, '/skills');
  assert.equal(fixture.calls.ipc[0].payload.waitForCliReady, true);
  assert.equal(fixture.calls.cards.length, 0);
  assert.equal(fixture.calls.observations.length, 0);
  assert.equal(fixture.inputBox.text, '');
  assert.match(fixture.calls.toasts[0].text, /Add from AgentCenter/);
});

test('real /skills send while running keeps the draft and never writes to PTY', async () => {
  const fixture = sendFixture({ text: '/skills' }); fixture.session.status = 'running';
  runtime.applySessionRuntimeObservation(fixture.session, { state: runtime.RUNTIME_RUNNING, source: 'hook', confidence: runtime.CONFIDENCE_AUTHORITATIVE });
  fixture.sendInput(); await new Promise(setImmediate);
  assert.equal(fixture.calls.ipc.length, 0); assert.equal(fixture.calls.views.length, 0);
  assert.equal(fixture.inputBox.text, '/skills');
  assert.match(fixture.calls.toasts[0].text, /等当前回答结束/);
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

test('real terminal fallback uses the explicit interactive option; builtin entry invokes only the prefix IPC', async () => {
  const fixture = sendFixture();
  await vm.runInContext("openCodeAgentSkillsMenu(sessionId, pane, '/unknown')", fixture.context);
  assert.equal(fixture.calls.ipc[0].payload.text, '/unknown');
  assert.equal(fixture.calls.ipc[0].payload.codeagentInteractiveCommand, true);
  fixture.calls.ipc.length = 0;
  await vm.runInContext("openCodeAgentSkillsMenu(sessionId, pane, '/')", fixture.context);
  assert.equal(fixture.calls.ipc[0].channel, 'codeagent:commands-open');
  assert.equal(fixture.calls.ipc[0].payload.text, undefined);
  assert.equal(fixture.calls.cards.length, 0);
});

for (const skill of [null, { name: 'test-skill', installedAt: 1 }]) test(`residual interception restores the draft and retries the actual sendInput with the same id (${skill ? 'tagged' : 'ordinary'})`, async () => {
  let attempt = 0;
  const text = skill ? '/test-skill new requirement' : 'new requirement';
  const f = sendFixture({ text, skill, recovery: true, result: () => ++attempt === 1 ? { ok: false, notSent: true, code: 'codeagent-input-residual', input: { token: 'residual', text: 'old requirement' } } : { ok: true, enterAttempts: 1 } });
  f.sendInput(); await new Promise(setImmediate);
  assert.equal(f.calls.ipc.length, 1); assert.equal(f.inputBox.text, text);
  assert.equal(f.inputBox.skill?.name, skill?.name);
  assert.equal(f.calls.cards[0].card.removed, true); assert.equal(f.calls.recoveries.length, 1);
  assert.notEqual(runtime.getSessionRuntimeTruth(f.session).state, runtime.RUNTIME_STARTING);
  await f.calls.recoveries[0].retry('residual'); await new Promise(setImmediate);
  assert.equal(f.calls.ipc.length, 2);
  assert.equal(f.calls.ipc[1].payload.clientSubmissionId, f.calls.ipc[0].payload.clientSubmissionId);
  assert.equal(f.calls.ipc[1].payload.codeagentDiscardToken, 'residual'); assert.equal(f.calls.ipc[1].payload.text, text);
  assert.equal(f.calls.ipc[1].payload.codeagentInteractiveCommand, undefined);
  assert.equal(f.inputBox.text, ''); assert.equal(f.calls.cards.length, 2);
  assert.equal(f.calls.cards[1].receipt.clientSubmissionId, f.calls.ipc[0].payload.clientSubmissionId);
});

test('residual on an interactive command keeps the command once and uses the same interactive submit when discarded', async () => {
  let attempt = 0;
  const f = sendFixture({ text: '/skills', recovery: true, result: () => ++attempt === 1 ? { ok: false, notSent: true, code: 'codeagent-input-residual', input: { token: 'residual', text: 'old' } } : { ok: true, mode: 'interactive-command', enterAttempts: 1 } });
  f.sendInput(); await new Promise(setImmediate);
  assert.equal(f.inputBox.text, '/skills'); assert.equal(f.calls.cards.length, 0); assert.equal(f.calls.recoveries.length, 1);
  await f.calls.recoveries[0].retry('residual');
  assert.equal(f.calls.ipc.length, 2);
  assert.equal(f.calls.ipc[1].payload.clientSubmissionId, f.calls.ipc[0].payload.clientSubmissionId);
  assert.equal(f.calls.ipc[1].payload.codeagentInteractiveCommand, true);
  assert.equal(f.calls.ipc[1].payload.codeagentDiscardToken, 'residual');
});

test('the real stop click rechecks running state and routes CodeAgent to the shared main action', async () => {
  const marker = "  stopBtn.addEventListener('click', async (e) => {";
  const at = source.indexOf(marker), end = source.indexOf('\n  });', at);
  assert.ok(at >= 0 && end > at);
  const body = source.slice(at + marker.length, end);
  const current = { kind: 'codeagent', agentRuntime: 'pty', status: 'idle' }, calls = [], toasts = [];
  const context = vm.createContext({ sessionId: 'test', sessions: new Map([['test', current]]),
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
  const context = vm.createContext({ sessionId: 'test', sessions, bar, recoveryHost: {}, document: {}, window: {},
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
  assert.ok(f.calls.toasts.some(toast => /已停止/.test(toast.text)));
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
