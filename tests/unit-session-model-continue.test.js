'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'node-pty') return { spawn() { throw Error('No real PTY in confirmation tests'); } };
  return originalLoad.call(this, name, ...args);
};
const { SessionManager } = require('../core/session-manager');
Module._load = originalLoad;
const watcher = require('../core/group-chat-watcher');
const config = require('../core/hub-config');
const OLD = 'GLM-5.2-WX-Auto', NEXT = 'GLM-5.3-WX-Auto';
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

function fixture(t, { status = 'idle', probeModels } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-continue-'));
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = root; config.clearConfigCache();
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const configDir = path.join(root, 'cac');
  write(path.join(root, 'config.json'), { experiments: { sessionModelUnavailablePolicy: 'stop-and-ask' } });
  write(path.join(configDir, 'settings.json'), { model: NEXT });
  write(require('../core/codeagent-pool').personalModelsFile(root), { source: 'serve', models: [NEXT] });
  write(path.join(root, 'codeagent-launch', 'member-0001.json'), { model: OLD });
  t.mock.method(require('../core/codeagent-config'), 'resolveCodeAgentConfig', () => ({ command: 'never-run', configDir }));
  t.mock.method(require('../core/codeagent-capabilities'), 'readHelp', () => '');
  t.mock.method(require('../core/codeagent-capabilities'), 'prepareForKind', async () => {});
  const picks = [];
  t.mock.method(require('../core/codeagent-model-picker'), 'pickModel', async ({ modelId }) => { picks.push(modelId); return { ok: true, confirmed: true }; });
  const manager = Object.create(SessionManager.prototype); EventEmitter.call(manager);
  manager._refreshOpenIdentity = () => {};
  const info = { id: 'member-0001', kind: 'codeagent', title: '测试成员', status, cwd: root, codeagentConfigDir: configDir,
    fixedModel: OLD, currentModel: { id: OLD }, ccSessionId: '11111111-1111-4111-8111-111111111111' };
  manager.sessions = new Map([[info.id, { info, codeagentSettingsActive: true }]]);
  const sent = [], native = { send: async (text, options) => { sent.push({ text, options }); return { ok: true, sendStatus: 'ok', acknowledgementSource: 'synthetic-adapter' }; } };
  manager.getNativeSession = () => native;
  const requests = [], notices = [], handlers = new Map();
  const gate = require('../main/session-model-creation').createModelCreationConfirmation({ onWait: event => manager.emit('session-model-wait', event), sendToRenderer: (name, payload) => { if (name === 'session-model-create-confirm') requests.push(payload); } });
  const api = require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: manager, requestModelConfirmation: (payload, options) => gate.request(payload, options),
    codeagentProbeModels: probeModels,
    codeagentServeRead: probeModels ? async () => ({ ok: false, error: 'fixture fallback' }) : null,
    sendToRenderer: (name, payload) => notices.push({ name, payload }),
  });
  watcher.init({ sessionManager: manager, confirmSessionModel: (...args) => api.confirmSessionModel(...args) });
  const send = (text = '原始消息', options = {}) => watcher.sendToPty(info.id, text, 'codeagent', { requireReady: false, ...options });
  const decide = (modelId = NEXT) => gate.respond({ requestId: requests.at(-1)?.requestId, modelId });
  t.after(() => {
    gate.cancelAll();
    if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before;
    config.clearConfigCache(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, manager, info, sent, picks, requests, notices, gate, api, handlers, send, decide, write };
}

test('空清单并发确认只自动重拉一次，读到后进入原有模型确认', async t => {
  let probes = 0;
  const f = fixture(t, { probeModels: async () => { probes++; return { ok: true, models: [NEXT], source: 'menu' }; } });
  const error = require('../core/session-model-pin').unavailableError(OLD, '清单为空', []);
  const first = f.api.confirmSessionModel(f.info.id, error, { clientSubmissionId: 'empty-one' });
  const second = f.api.confirmSessionModel(f.info.id, error, { clientSubmissionId: 'empty-two' });
  await flush();
  assert.equal(probes, 1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].availableModels, [NEXT]);
  assert.match(f.requests[0].message, /清单为空/);
  f.decide();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(f.info.fixedModel, NEXT);
});

test('自动重拉仍为空时明确未发送和下一步，保持固定模型', async t => {
  let probes = 0;
  const f = fixture(t, { probeModels: async () => { probes++; return { ok: true, models: [], source: 'menu' }; } });
  const error = require('../core/session-model-pin').unavailableError(OLD, '清单为空', []);
  await assert.rejects(f.api.confirmSessionModel(f.info.id, error), failure => failure.notSent && failure.stopped);
  assert.equal(probes, 1);
  assert.equal(f.requests.length, 0);
  assert.equal(f.info.fixedModel, OLD);
  const notice = f.notices.find(item => item.name === 'session-notice');
  assert.match(notice.payload.message, /已重新读取模型清单，仍无可用模型.*账号.*重新发送/);
});

test('重新拉取清单不能把刚被拒绝的唯一模型再次推荐为替代', async t => {
  const f = fixture(t, { probeModels: async () => ({ ok: true, models: [OLD], source: 'menu' }) });
  const error = require('../core/session-model-pin').unavailableError(OLD, '模型请求已被拒绝', []);
  await assert.rejects(f.api.confirmSessionModel(f.info.id, error), failure => failure.notSent && failure.stopped);
  assert.equal(f.requests.length, 0);
  assert.equal(f.info.fixedModel, OLD);
});

test('空清单重拉期间停止任务，迟到的模型清单不能继续确认', async t => {
  let release;
  const f = fixture(t, { probeModels: () => new Promise(resolve => { release = resolve; }) });
  const controller = new AbortController();
  const error = require('../core/session-model-pin').unavailableError(OLD, '清单为空', []);
  const pending = f.api.confirmSessionModel(f.info.id, error, { signal: controller.signal });
  await flush();
  controller.abort();
  release({ ok: true, models: [NEXT], source: 'menu' });
  await assert.rejects(pending, failure => failure.notSent && failure.stopped);
  assert.equal(f.requests.length, 0);
  assert.equal(f.sent.length, 0);
});

for (const status of ['idle', 'running']) test(`a blocked send resumes the original body and receipt once after confirmation (${status})`, async t => {
  const f = fixture(t, { status });
  const pending = f.send('正文\n保持原样', { clientSubmissionId: 'original-receipt', attachments: [{ path: 'fixture.png' }], metadata: { attemptId: 'group-attempt' } }).catch(error => ({ error }));
  await flush();
  assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 0);
  assert.equal(f.requests[0].creation, false);
  assert.equal(f.requests[0].originalModel, OLD); assert.equal(f.requests[0].suggestedModel, NEXT);
  assert.equal(f.decide().ok, true); assert.equal(f.decide().ok, false);
  const result = await pending; assert.equal(result.ok, true, result.error?.message);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, '正文\n保持原样');
  assert.equal(f.sent[0].options.clientSubmissionId, 'original-receipt');
  assert.deepEqual(f.sent[0].options.attachments, [{ path: 'fixture.png' }]);
  assert.equal(f.sent[0].options.metadata.attemptId, 'group-attempt');
  assert.equal(f.info.fixedModel, NEXT);
});

test('cancelling a blocked send returns stopped and never retries the original message', async t => {
  const f = fixture(t), pending = f.send().catch(error => ({ error }));
  await flush(); assert.equal(f.requests.length, 1);
  f.gate.respond({ requestId: f.requests[0].requestId, cancel: true });
  const result = await pending;
  assert.equal(result.stopped, true); assert.equal(result.notSent, true); assert.equal(result.ok, false);
  assert.equal(f.info.fixedModel, OLD); assert.equal(f.sent.length, 0);
});

test('duplicate blocked submission IDs share one confirmation and one physical send', async t => {
  const f = fixture(t);
  const first = f.send('同一条消息', { clientSubmissionId: 'same-receipt' }).catch(error => ({ error }));
  const second = f.send('同一条消息', { clientSubmissionId: 'same-receipt' }).catch(error => ({ error }));
  await flush(); assert.equal(f.requests.length, 1); f.decide();
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal((await f.send('同一条消息', { clientSubmissionId: 'same-receipt' })).ok, true);
  assert.equal(f.sent.length, 1);
});

test('a cancelled group dispatch is checked again before changing model or submitting', async t => {
  const f = fixture(t); let allowed = true;
  const pending = f.send('群聊任务', { shouldSubmit: () => allowed, clientSubmissionId: 'cancelled-group' }).catch(error => ({ error }));
  await flush(); assert.equal(f.requests.length, 1); allowed = false; f.decide();
  const result = await pending;
  assert.equal(result.notSent, true); assert.equal(f.sent.length, 0); assert.equal(f.picks.length, 0);
});

test('session replacement while awaiting confirmation cannot send into the new conversation', async t => {
  const f = fixture(t), pending = f.send().catch(error => ({ error }));
  await flush(); assert.equal(f.requests.length, 1);
  f.manager.sessions.set(f.info.id, { info: { ...f.info, ccSessionId: '22222222-2222-4222-8222-222222222222' } });
  f.decide(); const result = await pending;
  assert.equal(result.notSent, true); assert.equal(f.sent.length, 0); assert.equal(f.picks.length, 0);
});

test('model confirmation is abortable and consumed exactly once', async () => {
  const events = [], controller = new AbortController();
  const gate = require('../main/session-model-creation').createModelCreationConfirmation({ sendToRenderer: (name, payload) => events.push({ name, payload }) });
  const pending = gate.request({ sessionId: 'member-0001', availableModels: [NEXT] }, { signal: controller.signal });
  controller.abort();
  assert.equal(await Promise.race([pending, Promise.resolve('still pending')]), null);
  assert.equal(gate.respond({ requestId: events[0].payload.requestId, modelId: NEXT }).ok, false);
  assert.equal(events.some(event => event.name === 'session-model-confirmation-dismissed'), true);
});

test('closing a session cancels only its pending model decisions', async () => {
  const events = [], gate = require('../main/session-model-creation').createModelCreationConfirmation({ sendToRenderer: (_name, payload) => events.push(payload) });
  const first = gate.request({ sessionId: 'one', availableModels: [NEXT] });
  const second = gate.request({ sessionId: 'two', availableModels: [NEXT] });
  assert.equal(typeof gate.cancelSession, 'function');
  gate.cancelSession('one'); assert.equal(await first, null);
  gate.respond({ requestId: events[1].requestId, modelId: NEXT }); assert.equal(await second, NEXT);
});

function ordinaryApi(t, f) {
  // The composer/input guard is a separate terminal-snapshot boundary; this
  // fixture tests the actual prompt IPC, receipts, model gate and send pipeline.
  t.mock.method(watcher, 'codeAgentInputAction', async () => ({ ok: true }));
  const api = require('../main/ipc/prompt-submit-handlers').registerPromptSubmitIpc({ handle() {} }, {
    sessionManager: f.manager, sendToRenderer() {}, logger: { warn() {} },
  });
  t.after(() => api.dispose()); return api;
}

test('the ordinary prompt IPC keeps the original request pending and submits once after confirmation', async t => {
  const f = fixture(t), api = ordinaryApi(t, f);
  const pending = api.submitPrompt(null, { sessionId: f.info.id, text: '普通会话原消息', clientSubmissionId: 'ordinary-receipt', attachments: [{ path: 'original.png' }] });
  await flush(); assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 0); f.decide();
  const result = await pending; assert.equal(result.ok, true);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, '普通会话原消息');
  assert.equal(f.sent[0].options.clientSubmissionId, 'ordinary-receipt');
  assert.equal(result.receipt.clientSubmissionId, 'ordinary-receipt');
});

for (const action of ['confirm', 'cancel']) test(`team delivery waits for model confirmation without creating a retry job (${action})`, async t => {
  const f = fixture(t), prompt = ordinaryApi(t, f);
  f.manager.sessions.set('lead-0001', { info: { id: 'lead-0001', kind: 'codeagent', title: '负责人', status: 'idle', cwd: f.root } });
  const service = require('../main/team/service').createTeamService({ getHubDataDir: () => f.root, sessionManager: f.manager,
    listAccounts: () => ({ recommendedId: 'pool-a', rows: [{ id: 'pool-a', usable: true, models: [NEXT], modelsAuthoritative: true }] }),
    // Setup an already-created member with a subsequently lost model permission.
    createSession: async () => f.manager.getSession(f.info.id), commandPath: () => 'fixture-team',
    submitPrompt: (sid, text) => sid === f.info.id ? prompt.submitPrompt(null, { sessionId: sid, text, clientSubmissionId: 'team-kickoff-receipt' }) : Promise.resolve({ ok: true }),
  });
  t.after(() => { service.freeze(); service.stop(); });
  const plan = await service.invoke('lead-0001', 'propose', { goal: '保留原任务', members: [{ role: '实现', task: '只能做一次的任务', model: OLD }] });
  await service.decide({ leadSid: 'lead-0001', planId: plan.planId, approve: true });
  const delivery = service.flush('lead-0001');
  await flush(); assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 0);
  if (action === 'confirm') f.decide(); else f.gate.respond({ requestId: f.requests[0].requestId, cancel: true });
  await delivery; await service.flush('lead-0001');
  const item = service.listTeams()[0].messages.find(message => message.to === 'm1');
  assert.equal(item.state, action === 'confirm' ? 'sent' : 'failed');
  assert.equal(item.retryAt, null); assert.equal(f.sent.length, action === 'confirm' ? 1 : 0);
  if (action === 'confirm') assert.match(f.sent[0].text, /只能做一次的任务/);
  else assert.equal(f.info.fixedModel, OLD);
});

test('distinct queued group messages share the choice and each original message is sent once', async t => {
  const f = fixture(t);
  const first = f.send('群消息一', { clientSubmissionId: 'group-one', metadata: { meetingId: 'room', attemptId: 'one' } });
  const second = f.send('群消息二', { clientSubmissionId: 'group-two', metadata: { meetingId: 'room', attemptId: 'two' } });
  await flush(); assert.equal(f.requests.length, 1); f.decide();
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.deepEqual(f.sent.map(item => item.text), ['群消息一', '群消息二']); assert.equal(f.picks.length, 1);
});

test('stopping a pending model submission dismisses its choice and cannot send on a late confirmation', async t => {
  const f = fixture(t), pending = f.send();
  await flush(); assert.equal(f.requests.length, 1);
  watcher.cancelPendingModelSubmissions(f.info.id);
  assert.equal((await pending).stopped, true); assert.equal(f.decide().ok, false);
  assert.equal(f.sent.length, 0); assert.equal(f.picks.length, 0);
});

test('a real active provider turn prevents a pending confirmation from switching its model', async t => {
  const f = fixture(t), pending = f.send();
  await flush(); f.manager.sessions.get(f.info.id).agentTurnActive = true; f.decide();
  assert.equal((await pending).notSent, true); assert.equal(f.picks.length, 0); assert.equal(f.sent.length, 0);
});

test('an in-place native identity change invalidates an awaiting task even when the entry object survives', async t => {
  const f = fixture(t), pending = f.send(); await flush();
  f.info.ccSessionId = '22222222-2222-4222-8222-222222222222'; f.decide();
  const result = await pending;
  assert.equal(result.notSent, true); assert.equal(f.sent.length, 0); assert.equal(f.picks.length, 0);
});

test('a cached old-conversation result never claims delivery in a replacement native conversation', async t => {
  const f = fixture(t), first = f.send('原消息', { clientSubmissionId: 'old-native-receipt' });
  await flush(); f.decide(); assert.equal((await first).ok, true);
  f.info.ccSessionId = '22222222-2222-4222-8222-222222222222';
  const duplicate = await f.send('原消息', { clientSubmissionId: 'old-native-receipt' });
  assert.equal(duplicate.ok, false); assert.equal(duplicate.code, 'submission-session-changed'); assert.equal(f.sent.length, 1);
});

for (const inputReady of [true, false]) test(`startup model picker failure enters confirmation only after proving the input is usable (${inputReady})`, async t => {
  const f = fixture(t); f.info.codeagentModelPick = true;
  const picker = require('../core/codeagent-model-picker');
  picker.schedulePick(f.info.id, async () => ({ ok: false, inputReady, message: '原模型菜单未选中' }));
  const pending = f.send().catch(error => ({ error })); await flush();
  if (inputReady) { assert.equal(f.requests.length, 1); f.decide(); assert.equal((await pending).ok, true); assert.equal(f.sent.length, 1); }
  else { assert.equal(f.requests.length, 0); assert.equal((await pending).error.notSent, true); assert.equal(f.sent.length, 0); }
});

for (const identified of [true, false]) test(`a confirmed task queued behind an earlier send cannot cross an in-place relaunch (${identified})`, async t => {
  const f = fixture(t); f.info.fixedModel = NEXT;
  let release;
  f.manager.getNativeSession = () => ({ send: async (text, options) => {
    f.sent.push({ text, native: f.info.ccSessionId });
    if (text === 'blocking') await new Promise(resolve => { release = resolve; });
    return { ok: true, acknowledgementSource: 'synthetic-adapter' };
  } });
  const first = f.send('blocking'); await flush(); f.info.fixedModel = OLD;
  const pending = f.send('original task', identified ? { clientSubmissionId: 'queued-original' } : {});
  await flush(); f.decide(); await flush(); assert.equal(f.sent.length, 1);
  f.info.ccSessionId = '22222222-2222-4222-8222-222222222222';
  f.manager.sessions.get(f.info.id).modelSubmissionEpoch = 1;
  watcher.cancelPendingModelSubmissions(f.info.id);
  release(); await first;
  const result = await pending;
  assert.equal(result.notSent, true); assert.equal(result.stopped, true); assert.equal(f.sent.length, 1);
});

test('a confirmed task handed to the old CLI before reset is uncertain and never replayed', async t => {
  const f = fixture(t); let release;
  f.manager.getNativeSession = () => ({ send: async (text, options) => {
    options.codeagentSubmission.submitted = true; f.sent.push({ text });
    await new Promise(resolve => { release = resolve; }); return { ok: true };
  } });
  const pending = f.send('原任务', { clientSubmissionId: 'handed-off' }); await flush(); f.decide(); await flush();
  f.info.ccSessionId = '22222222-2222-4222-8222-222222222222'; watcher.cancelPendingModelSubmissions(f.info.id); release();
  const result = await pending;
  assert.equal(result.unconfirmed, true); assert.equal(result.notSent, false); assert.equal(f.sent.length, 1);
  const duplicate = await f.send('原任务', { clientSubmissionId: 'handed-off' });
  assert.equal(duplicate.unconfirmed, true); assert.equal(f.sent.length, 1);
});

test('group outcomes keep explicit uncertain submissions behind reconciliation instead of retrying', () => {
  const result = require('../core/native-groupchat-outcome').nativeUnknownOutcome({ status: 'errored', promptDelivered: false, unconfirmed: true }, { submissionId: 'original-attempt' });
  assert.equal(result.finality, 'unknown'); assert.equal(result.failure.autoRetry, false); assert.equal(result.failure.retryable, false);
});

test('the real stop action cancels a model-paused send without typing an escape or a body', async t => {
  const f = fixture(t);
  t.mock.method(require('../core/codeagent-model-picker'), 'openSessionScreen', async () => ({ lines: async () => ['>'], dispose() {} }));
  const pending = f.send(); await flush();
  const stopped = await watcher.codeAgentInputAction(f.info.id, 'stop');
  assert.equal(stopped.pendingStopped, true);
  assert.equal((await pending).stopped, true); assert.equal(f.sent.length, 0); assert.equal(f.decide().ok, false);
});

test('the real stop action also cancels a confirmed model task still waiting in the send queue', async t => {
  const f = fixture(t); f.info.fixedModel = NEXT;
  t.mock.method(require('../core/codeagent-model-picker'), 'openSessionScreen', async () => ({ lines: async () => ['>'], dispose() {} }));
  let release;
  f.manager.getNativeSession = () => ({ send: async (text, options) => {
    options.codeagentSubmission.submitted = true; f.sent.push({ text });
    if (text === 'blocking') await new Promise(resolve => { release = resolve; });
    return { ok: true };
  } });
  const first = f.send('blocking'); await flush(); f.info.fixedModel = OLD;
  const pending = f.send('queued model task'); await flush(); f.decide(); await flush();
  const stopped = await watcher.codeAgentInputAction(f.info.id, 'stop');
  release(); await first; const result = await pending;
  assert.equal(stopped.pendingStopped, true); assert.equal(result.notSent, true); assert.equal(f.sent.length, 1);
});


for (const confirmed of [false, true]) test(`stopping a model queue checks a running screen with a late hook (confirmed=${confirmed})`, async t => {
  const f = fixture(t); f.info.fixedModel = NEXT; let release, interrupted = false; const keys = [];
  t.mock.method(require('../core/codeagent-model-picker'), 'openSessionScreen', async () => ({
    lines: async () => interrupted ? ['>'] : ['Running… (esc to interrupt)'], dispose() {},
  }));
  f.manager.writeToSession = (_id, key) => { keys.push(key); if (key === '\x1b') { interrupted = true; release(); } };
  f.manager.getNativeSession = () => ({ send: async (text, options) => {
    options.codeagentSubmission.submitted = true; f.sent.push({ text });
    if (text === 'blocking') await new Promise(resolve => { release = resolve; }); return { ok: true };
  } });
  const first = f.send('blocking'); await flush(); f.info.fixedModel = OLD;
  const pending = f.send('queued task'); await flush(); if (confirmed) f.decide(); await flush();
  const stopped = await watcher.codeAgentInputAction(f.info.id, 'stop');
  release(); await first; await pending;
  assert.equal(stopped.ok, true); assert.equal(keys.includes('\x1b'), true); assert.equal(f.sent.length, 1);
});

for (const action of ['confirm', 'cancel']) test(`a model-error repair retains its caller until explicit choice (${action})`, async t => {
  const f = fixture(t);
  const pending = f.api.fixCodeAgentModel(f.info.id, { avoidModel: OLD });
  await flush(); assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 0);
  if (action === 'confirm') f.decide(); else f.gate.respond({ requestId: f.requests[0].requestId, cancel: true });
  const repaired = await pending;
  assert.equal(repaired.ok, action === 'confirm');
  if (repaired.ok) await f.send('调用方保留的原任务', { clientSubmissionId: 'repair-original' });
  assert.equal(f.sent.length, action === 'confirm' ? 1 : 0);
  assert.equal(f.info.modelConfirmationRequired, action !== 'confirm');
});

// R1: each original submission owns its validity; the shared model choice
// must not let one withdrawn task cancel an unrelated valid subscriber.
for (const withdrawn of ['first', 'second']) test(`shared model choice keeps the other submission when ${withdrawn} task is withdrawn`, async t => {
  const f = fixture(t); let firstValid = true, secondValid = true;
  const first = f.send('task-one', { clientSubmissionId: 'independent-one', shouldSubmit: () => firstValid });
  const second = f.send('task-two', { clientSubmissionId: 'independent-two', shouldSubmit: () => secondValid });
  await flush(); assert.equal(f.requests.length, 1);
  if (withdrawn === 'first') firstValid = false; else secondValid = false;
  f.decide(); const results = await Promise.all([first, second]);
  assert.equal(results[withdrawn === 'first' ? 0 : 1].notSent, true);
  assert.equal(results[withdrawn === 'first' ? 1 : 0].ok, true);
  assert.deepEqual(f.sent.map(x => x.text), [withdrawn === 'first' ? 'task-two' : 'task-one']);
  assert.equal(f.picks.length, 1);
});

test('aborting one model-choice subscriber leaves the other task waiting for a valid choice', async t => {
  const f = fixture(t), controller = new AbortController();
  const error = require('../core/session-model-pin').unavailableError(OLD, 'permission lost', [NEXT], NEXT);
  const first = f.api.confirmSessionModel(f.info.id, error, { clientSubmissionId: 'abort-one', signal: controller.signal }).catch(e => e);
  const second = f.send('still-valid', { clientSubmissionId: 'keep-another' });
  await flush(); controller.abort(); await flush();
  assert.equal((await first).notSent, true); assert.equal(f.decide().ok, true);
  assert.equal((await second).ok, true); assert.deepEqual(f.sent.map(x => x.text), ['still-valid']);
});

async function teamModelFixture(t, f, { now = () => Date.now(), injectPrompt = null } = {}) {
  const prompt = ordinaryApi(t, f), leadSends = [];
  f.manager.sessions.set('lead-0001', { info: { id: 'lead-0001', kind: 'codeagent', title: '负责人', status: 'idle', cwd: f.root } });
  const service = require('../main/team/service').createTeamService({ getHubDataDir: () => f.root, now, sessionManager: f.manager,
    listAccounts: () => ({ recommendedId: 'pool-a', rows: [{ id: 'pool-a', usable: true, models: [NEXT], modelsAuthoritative: true }] }),
    createSession: async () => f.manager.getSession(f.info.id), commandPath: () => 'fixture-team', injectPrompt,
    submitPrompt: (sid, text, options) => sid === f.info.id
      ? prompt.submitPrompt(null, { sessionId: sid, text, ...options }) : (leadSends.push(text), Promise.resolve({ ok: true })),
  });
  t.after(() => { service.freeze(); service.stop(); });
  const plan = await service.invoke('lead-0001', 'propose', { goal: '确认期间的任务有效性', members: [{ role: '实现', task: '不能发给离队成员的原任务', model: OLD }] });
  await service.decide({ leadSid: 'lead-0001', planId: plan.planId, approve: true });
  await flush(); assert.equal(f.requests.length, 1); return { service, leadSends };
}

test('a team member dismissed during model confirmation never receives its old kickoff', async t => {
  const f = fixture(t), { service } = await teamModelFixture(t, f);
  assert.equal((await service.invoke('lead-0001', 'dismiss', { memberId: 'm1' })).ok, true);
  f.decide(); await flush();
  const item = service.listTeams()[0].messages.find(x => x.to === 'm1');
  assert.equal(f.sent.length, 0); assert.equal(item.state, 'failed');
  assert.equal(item.stage, 'failed');
});

test('withdrawing a team task during model confirmation prevents its physical send', async t => {
  const f = fixture(t), { service } = await teamModelFixture(t, f);
  const item = service.teamOfLead('lead-0001').messages.find(x => x.to === 'm1');
  item.state = 'failed'; item.error = '工作已撤销';
  f.decide(); await flush(); assert.equal(f.sent.length, 0); assert.equal(item.state, 'failed');
  assert.equal(service.listTeams()[0].messages.find(x => x.to === 'm1').stage, 'failed');
});

for (const policy of ['stop-and-ask', 'auto-switch-notify']) for (const action of ['confirm', 'cancel']) test(`team status and lead notification show model waiting as known not sent (${policy}, ${action})`, async t => {
  const f = fixture(t); let clock = Date.now();
  const suggested = policy === 'auto-switch-notify' ? 'MiniMax-M2.7' : NEXT;
  if (policy === 'auto-switch-notify') {
    f.write(path.join(f.root, 'config.json'), { experiments: { sessionModelUnavailablePolicy: policy } }); config.clearConfigCache();
    f.write(path.join(f.root, 'cac/settings.json'), { model: suggested });
    f.write(require('../core/codeagent-pool').personalModelsFile(f.root), { source: 'serve', models: [suggested], at: new Date().toISOString() });
  }
  const { service, leadSends } = await teamModelFixture(t, f, { now: () => clock });
  clock += 11 * 60000; service.watch(); await service.flush('lead-0001');
  const status = await service.invoke('lead-0001', 'status', {}), message = status.messages.find(x => x.to === 'm1');
  assert.equal(message.stage, 'waiting-model'); assert.match(message.reason, /等待模型确认/);
  assert.match(message.reason, /GLM-5.2-WX-Auto/); assert.ok(message.reason.includes(suggested));
  assert.equal(status.members.find(x => x.memberId === 'm1').state, 'waiting-model');
  assert.equal(f.sent.length, 0); assert.equal(leadSends.filter(x => /等待模型确认/.test(x)).length, 1);
  service.watch(); await service.flush('lead-0001'); assert.equal(leadSends.filter(x => /等待模型确认/.test(x)).length, 1);
  if (action === 'confirm') f.decide(suggested); else f.gate.respond({ requestId: f.requests[0].requestId, cancel: true });
  await flush(); const result = service.listTeams()[0].messages.find(x => x.to === 'm1');
  assert.equal(result.state, action === 'confirm' ? 'sent' : 'failed');
  assert.equal(f.sent.length, action === 'confirm' ? 1 : 0);
});

function groupModelFixture(t, f) {
  f.info.meetingId = 'room';
  const room = { id: 'room', title: '内部编排群', groupChat: true, subSessions: [f.info.id], participants: [0],
    slotSpecs: [{ memberId: 'm1', kind: 'codeagent', model: OLD }] };
  const tap = new EventEmitter(); tap.clearStreamingBuf = () => {};
  const dispatcher = require('../main/groupchat/dispatcher').createGroupChatDispatcher({ getHubDataDir: () => f.root,
    groupchat: require('../core/group-chat-orchestrator'), isCodexBaseKind: () => false, kindLabels: { codeagent: 'CodeAgent' },
    logger: { warn() {}, log() {} }, maybeAutoTitleMeetingFromPrompt() {}, meetingManager: { getMeeting: () => room },
    sendToRenderer() {}, sessionManager: f.manager, transcriptTap: tap, confirmSessionModel: (...args) => f.api.confirmSessionModel(...args),
  });
  t.after(() => dispatcher.interruptMeetingTurn('room'));
  return { room, dispatcher };
}

for (const invalidation of ['task', 'member']) test(`silent group dispatch does not resume after its ${invalidation} is withdrawn`, async t => {
  const f = fixture(t), { room, dispatcher } = groupModelFixture(t, f); let allowed = true;
  const pending = dispatcher.dispatchGroupChatTurn('room', { silent: true, userInput: 'cancelled internal work', shouldDispatch: () => allowed, turnTimeoutMs: 5 });
  await flush(); assert.equal(f.requests.length, 1);
  if (invalidation === 'task') allowed = false; else room.subSessions = [];
  f.decide(); await pending; assert.equal(f.sent.length, 0);
});

test('saving while a new group waits for model confirmation never persists an empty pending group', async t => {
  const f = fixture(t), handlers = new Map();
  t.mock.method(require('../core/community-provider'), 'assertProviderAvailable', () => {});
  const groups = new (require('../core/meeting-room').MeetingRoomManager)();
  require('../main/ipc/meeting-create-handlers').registerMeetingCreateIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    fs, path, getHubDataDir: () => f.root, getHookPort: () => 0, getMeetingWorkspaceDir: () => f.root,
    getSlotPromptName: () => 'member', groupchat: {}, isClaudeFamily: () => true, isCodexBaseKind: () => false,
    isIsolatedHub: () => true, kindLabels: { codeagent: 'CodeAgent' }, meetingManager: groups,
    registerSessionForTap() {}, scenes: {}, slotIds: [], requestModelConfirmation: f.gate.request,
    sessionManager: { createSession() { throw require('../core/session-model-pin').unavailableError(OLD, 'permission', [NEXT], NEXT); } },
    sendToRenderer() {}, logger: { warn() {} },
  });
  const pending = handlers.get('create-meeting')(null, { title: '待确认新群', workspace: f.root, slots: [{ kind: 'codeagent', model: OLD, codeagentModelPick: true }] }).catch(e => e);
  await flush(); assert.equal(groups.getAllMeetings().length, 1);
  delete require.cache[require.resolve('../core/state-store')]; const state = require('../core/state-store');
  const save = () => state.save({ version: 1, cleanShutdown: true, sessions: [], meetings: groups.getAllMeetings(), immersiveByMeeting: {} }, { sync: true });
  save(); assert.equal(state.load().meetings.length, 0);
  const store = require('../core/meeting-store');
  const raw = groups.getAllMeetings();
  const fromRenderer = raw.map(({ creationPending, ...fields }) => fields);
  const persistence = require('../main/ipc/persistence-handlers');
  for (const item of persistence.buildMeetingsForState(fromRenderer, groups)) store.markDirty(item.id, item);
  await store.flushAll();
  assert.equal(store.listMeetingFilesWithData().some(item => item.id === raw[0].id), false);
  store.markDirty(raw[0].id, raw[0]); await store.flushAll();
  assert.equal(state.loadAndSelfHeal({ meetingStore: store }).meetings.length, 0);
  f.gate.cancelAll(); await pending; save(); assert.equal(state.load().meetings.length, 0);
  groups.createMeeting({ title: '用户有意建的空群' }); save(); assert.equal(state.load().meetings.length, 1);
});

test('group orchestrator sees the original and suggested model and receives one pause notice', async t => {
  const f = fixture(t), groups = new (require('../core/meeting-room').MeetingRoomManager)();
  f.manager.sessions.set('orch-0001', { info: { id: 'orch-0001', kind: 'codeagent', purpose: 'hub-orchestrator', title: '编排员', status: 'idle' } });
  const room = groups.createMeeting({ title: '模型等待编排群', workspace: f.root });
  groups.addSubSession(room.id, 'orch-0001'); groups.addSubSession(room.id, f.info.id); f.info.meetingId = room.id;
  groups.updateMeeting(room.id, { orchestration: { enabled: true, memberId: 'm0', sessionId: 'orch-0001' } });
  const notices = [], service = require('../main/orchestration/service').createOrchestrationService({
    meetingManager: groups, sessionManager: f.manager, getHubDataDir: () => f.root, noticeMergeMs: 0,
    getMembers: () => [{ memberId: 'm0', sid: 'orch-0001', kind: 'codeagent', displayName: '编排员' }, { memberId: 'm1', sid: f.info.id, kind: 'codeagent', displayName: '成员' }],
    getDispatcher: () => ({ dispatchGroupChatTurn: async (_id, args) => { notices.push(args.userInput); return { status: 'completed', results: [] }; } }),
    getDeliveryEngine: () => ({}), logger: { warn() {} },
  });
  t.after(() => { service.freeze(); service.stop(); for (const m of groups.getAllMeetings()) groups.closeMeeting(m.id); });
  const ledger = service.ledgerFor(room.id);
  ledger.channel = { messages: [{ id: 'orch-message', from: 'm0', to: 'm1', state: 'sending', text: '原任务', at: Date.now() }], requests: [], grants: [] };
  const pending = f.send('编排成员原任务', { clientSubmissionId: 'orch-message' }); await flush();
  const status = service.statusResult(room.id), member = status.members.find(x => x.memberId === 'm1');
  assert.equal(member.state, 'waiting-model'); assert.match(member.reason, /GLM-5.2-WX-Auto/); assert.match(member.reason, /GLM-5.3-WX-Auto/);
  assert.equal(status.communication.open[0].stage, 'waiting-model'); assert.match(status.communication.open[0].reason, /未发送/);
  await service.deliver(room.id); assert.equal(notices.filter(x => /等待模型确认/.test(x)).length, 1);
  await service.deliver(room.id); assert.equal(notices.filter(x => /等待模型确认/.test(x)).length, 1);
  f.decide(); assert.equal((await pending).ok, true); assert.equal(service.members(room.id).find(x => x.memberId === 'm1').state, 'idle');
});

for (const action of ['dismiss', 'withdraw']) test(`team urgent injection cannot resume after ${action} during model confirmation`, async t => {
  const f = fixture(t); f.info.fixedModel = NEXT;
  const inject = require('../main/ipc/groupchat-supplement-handlers').createRunningInjector({ sessionManager: f.manager, groupChatWatcher: watcher });
  // The normal kickoff was already delivered before the later urgent message.
  const prompt = ordinaryApi(t, f);
  f.manager.sessions.set('lead-0001', { info: { id: 'lead-0001', kind: 'codeagent', title: '负责人', status: 'idle', cwd: f.root } });
  const service = require('../main/team/service').createTeamService({ getHubDataDir: () => f.root, sessionManager: f.manager,
    listAccounts: () => ({ recommendedId: 'pool-a', rows: [{ id: 'pool-a', usable: true, models: [NEXT], modelsAuthoritative: true }] }),
    createSession: async () => f.manager.getSession(f.info.id), commandPath: () => 'fixture-team', injectPrompt: inject,
    submitPrompt: (sid, text, options) => sid === f.info.id ? prompt.submitPrompt(null, { sessionId: sid, text, ...options }) : Promise.resolve({ ok: true }),
  });
  t.after(() => { service.freeze(); service.stop(); });
  const plan = await service.invoke('lead-0001', 'propose', { goal: '紧急插话取消', members: [{ role: '实现', task: '已完成的开工', model: NEXT }] });
  await service.decide({ leadSid: 'lead-0001', planId: plan.planId, approve: true }); await flush();
  assert.equal(f.sent.length, 1); f.sent.length = 0; f.info.fixedModel = OLD;
  f.manager.sessions.get(f.info.id).agentTurnActive = true;
  const sent = await service.invoke('lead-0001', 'send', { to: 'm1', message: '已撤销的紧急插话', interrupt: true });
  await flush(); assert.equal(f.requests.length, 1);
  if (action === 'dismiss') await service.invoke('lead-0001', 'dismiss', { memberId: 'm1' });
  else service.teamOfLead('lead-0001').messages.find(x => x.id === sent.messageId).state = 'failed';
  f.manager.sessions.get(f.info.id).agentTurnActive = false;
  f.decide(); await flush();
  const item = service.listTeams()[0].messages.find(x => x.id === sent.messageId);
  assert.equal(f.sent.length, 0); assert.equal(item.stage, 'failed');
});

test('a new conversation cannot subscribe to the previous conversation model consent', async t => {
  const f = fixture(t);
  const first = f.send('old-dialog-task', { clientSubmissionId: 'old-choice' }); await flush();
  const oldRequest = f.requests[0].requestId;
  f.manager.sessions.set(f.info.id, { info: { ...f.info, ccSessionId: '22222222-2222-4222-8222-222222222222' }, codeagentSettingsActive: true });
  const second = f.send('new-dialog-task', { clientSubmissionId: 'new-choice' }); await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.gate.respond({ requestId: oldRequest, modelId: NEXT }).ok, false);
  f.decide(); assert.equal((await first).notSent, true); assert.equal((await second).ok, true);
  assert.deepEqual(f.sent.map(x => x.text), ['new-dialog-task']);
});

test('model-wait observers cannot strand the original confirmation if status persistence fails', async t => {
  const requests = []; t.mock.method(console, 'warn', () => {});
  const gate = require('../main/session-model-creation').createModelCreationConfirmation({
    sendToRenderer: (name, payload) => { if (name === 'session-model-create-confirm') requests.push(payload); },
    onWait: () => { throw Error('status storage unavailable'); },
  });
  t.after(() => gate.cancelAll());
  const pending = gate.request({ sessionId: 'member-0001', originalModel: OLD, suggestedModel: NEXT, availableModels: [NEXT] }).catch(e => e);
  await flush(); assert.equal(requests.length, 1);
  assert.equal(gate.respond({ requestId: requests[0].requestId, modelId: NEXT }).ok, true);
  assert.equal(await pending, NEXT);
});

test('withdrawing a confirmed task in the physical send queue is a final stop, never an automatic retry', async t => {
  const f = fixture(t); f.info.fixedModel = NEXT; let release, allowed = true;
  f.manager.getNativeSession = () => ({ send: async text => {
    f.sent.push({ text }); if (text === 'earlier') await new Promise(resolve => { release = resolve; }); return { ok: true };
  } });
  const earlier = f.send('earlier'); await flush(); f.info.fixedModel = OLD;
  const pending = f.send('withdrawn-after-confirm', { clientSubmissionId: 'queue-withdraw', shouldSubmit: () => allowed });
  await flush(); f.decide(); await flush(); allowed = false; release(); await earlier;
  const result = await pending; assert.equal(result.notSent, true); assert.equal(result.stopped, true);
  assert.deepEqual(f.sent.map(x => x.text), ['earlier']);
});

test('real orchestration channel correlates its logical message with the dispatcher attempt while waiting for a model', async t => {
  const f = fixture(t), groups = new (require('../core/meeting-room').MeetingRoomManager)();
  const room = groups.createMeeting({ title: '真实通信派工群', workspace: f.root });
  f.manager.sessions.set('orch-0001', { info: { id: 'orch-0001', kind: 'codeagent', purpose: 'hub-orchestrator', title: '编排员', status: 'idle' } });
  groups.addSubSession(room.id, 'orch-0001'); groups.addSubSession(room.id, f.info.id); f.info.meetingId = room.id;
  groups.setSlotSpecs(room.id, [{ memberId: 'm0', kind: 'codeagent', model: NEXT }, { memberId: 'm1', kind: 'codeagent', model: OLD }]);
  groups.updateMeeting(room.id, { orchestration: { enabled: true, memberId: 'm0', sessionId: 'orch-0001' } });
  const tap = new EventEmitter(); tap.clearStreamingBuf = () => {};
  const dispatcher = require('../main/groupchat/dispatcher').createGroupChatDispatcher({ getHubDataDir: () => f.root,
    groupchat: require('../core/group-chat-orchestrator'), isCodexBaseKind: () => false, kindLabels: { codeagent: 'CodeAgent' },
    logger: { warn() {}, log() {} }, maybeAutoTitleMeetingFromPrompt() {}, meetingManager: groups,
    sendToRenderer() {}, sessionManager: f.manager, transcriptTap: tap, confirmSessionModel: (...args) => f.api.confirmSessionModel(...args),
  });
  const notices = [], service = require('../main/orchestration/service').createOrchestrationService({ meetingManager: groups,
    sessionManager: f.manager, getHubDataDir: () => f.root, noticeMergeMs: 0, getDeliveryEngine: () => ({}), logger: { warn() {} },
    getMembers: () => [{ memberId: 'm0', sid: 'orch-0001', kind: 'codeagent', displayName: '编排员' }, { memberId: 'm1', sid: f.info.id, kind: 'codeagent', displayName: '成员' }],
    getDispatcher: () => ({ dispatchGroupChatTurn: (id, args) => args.targetMemberIds?.includes('m0')
      ? (notices.push(args.userInput), Promise.resolve({ status: 'completed', results: [] })) : dispatcher.dispatchGroupChatTurn(id, args) }),
  });
  t.after(() => { f.gate.cancelAll(); dispatcher.interruptMeetingTurn(room.id); service.freeze(); service.stop(); groups.closeMeeting(room.id); });
  const result = await service.invokeTool({ callerSessionId: 'orch-0001', name: 'orch_send_message', arguments: { to: 'm1', message: '实际通信原任务' } });
  await flush(); assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 0);
  const status = service.statusResult(room.id), item = status.communication.open.find(x => x.id === result.messageId);
  assert.equal(item.stage, 'waiting-model'); assert.equal(item.notSent, true); assert.match(item.reason, /GLM-5.2-WX-Auto/);
  await service.deliver(room.id); assert.equal(notices.filter(x => /等待模型确认/.test(x)).length, 1);
  f.gate.cancelAll(); await flush();
  assert.equal(service.statusResult(room.id).communication.open.find(x => x.id === result.messageId).state, 'failed');
});

async function lateSubscriberTeam(t, f, extra = {}) {
  const prompt = ordinaryApi(t, f);
  f.manager.sessions.set('lead-0001', { info: { id: 'lead-0001', kind: 'codeagent', title: '负责人', status: 'idle', cwd: f.root } });
  const deps = { getHubDataDir: () => f.root, sessionManager: f.manager,
    listAccounts: () => ({ recommendedId: 'pool-a', rows: [{ id: 'pool-a', usable: true, models: [NEXT], modelsAuthoritative: true }] }),
    createSession: async () => f.manager.getSession(f.info.id), commandPath: () => 'fixture-team',
    submitPrompt: (sid, text, options = {}) => sid === f.info.id ? prompt.submitPrompt(null, { sessionId: sid, text, ...options }) : Promise.resolve({ ok: true }),
    ...extra,
  };
  const service = require('../main/team/service').createTeamService(deps); t.after(() => { service.freeze(); service.stop(); });
  const plan = await service.invoke('lead-0001', 'propose', { goal: '后来订阅的任务', members: [{ role: '实现', task: '已完成的开工', model: NEXT }] });
  await service.decide({ leadSid: 'lead-0001', planId: plan.planId, approve: true }); await flush();
  return { service, deps };
}

for (const action of ['confirm', 'cancel']) test(`a late team subscriber is durably waiting with one notification (${action})`, async t => {
  const f = fixture(t); f.info.fixedModel = NEXT;
  const { service } = await lateSubscriberTeam(t, f); assert.equal(f.sent.length, 1); f.sent.length = 0; f.info.fixedModel = OLD;
  const earlier = f.send('先来的普通群聊消息', { clientSubmissionId: 'earlier-choice-owner' }); await flush();
  const added = await service.invoke('lead-0001', 'send', { to: 'm1', message: '后来加入同一个确认的团队任务' }); await flush();
  const disk = JSON.parse(fs.readFileSync(path.join(f.root, 'teams/lead-0001.json'))), item = disk.messages.find(x => x.id === added.messageId);
  assert.equal(f.requests.length, 1); assert.equal(item.state, 'waiting-model'); assert.ok(item.modelWait);
  assert.ok(item.modelWait.clientSubmissionIds.includes(item.submissionId));
  assert.equal(disk.messages.filter(x => x.to === 'lead' && /等待模型确认/.test(x.text)).length, 1);
  if (action === 'confirm') f.decide(); else f.gate.respond({ requestId: f.requests[0].requestId, cancel: true });
  await earlier; await flush();
  assert.equal(service.listTeams()[0].messages.find(x => x.id === added.messageId).state, action === 'confirm' ? 'sent' : 'failed');
  assert.equal(f.sent.length, action === 'confirm' ? 2 : 0);
});

test('reloading TeamService retains a late subscriber as waiting for model confirmation and known not sent', async t => {
  const f = fixture(t); f.info.fixedModel = NEXT;
  const { service, deps } = await lateSubscriberTeam(t, f); f.sent.length = 0; f.info.fixedModel = OLD;
  const earlier = f.send('仍等确认的普通任务', { clientSubmissionId: 'initial-choice' }); await flush();
  const added = await service.invoke('lead-0001', 'send', { to: 'm1', message: '重启时不丢的团队任务' }); await flush();
  service.freeze(); service.stop();
  const restarted = require('../main/team/service').createTeamService(deps); t.after(() => { restarted.freeze(); restarted.stop(); });
  const status = await restarted.invoke('lead-0001', 'status'), item = status.messages.find(x => x.id === added.messageId);
  assert.equal(item.state, 'waiting-model'); assert.equal(item.stage, 'waiting-model'); assert.equal(item.notSent, true);
  assert.match(item.reason, /GLM-5.2-WX-Auto/); assert.match(item.reason, /GLM-5.3-WX-Auto/);
  assert.equal(status.members.find(x => x.memberId === 'm1').state, 'waiting-model'); assert.equal(f.sent.length, 0);
  restarted.freeze(); f.gate.cancelAll(); await earlier; await flush();
});

function interruptOrchestration(t, f) {
  const groups = new (require('../core/meeting-room').MeetingRoomManager)();
  const room = groups.createMeeting({ title: '紧急指示确认', workspace: f.root });
  f.manager.sessions.set('orch-0001', { info: { id: 'orch-0001', kind: 'codeagent', purpose: 'hub-orchestrator', title: '编排员', status: 'idle' } });
  groups.addSubSession(room.id, 'orch-0001'); groups.addSubSession(room.id, f.info.id); f.info.meetingId = room.id;
  groups.setSlotSpecs(room.id, [{ memberId: 'm0', kind: 'codeagent', model: NEXT }, { memberId: 'm1', kind: 'codeagent', model: OLD }]);
  groups.updateMeeting(room.id, { orchestration: { enabled: true, memberId: 'm0', sessionId: 'orch-0001' } });
  const tap = new EventEmitter(); tap.clearStreamingBuf = () => {};
  const dispatcher = require('../main/groupchat/dispatcher').createGroupChatDispatcher({ getHubDataDir: () => f.root,
    groupchat: require('../core/group-chat-orchestrator'), isCodexBaseKind: () => false, kindLabels: { codeagent: 'CodeAgent' },
    logger: { warn() {}, log() {} }, maybeAutoTitleMeetingFromPrompt() {}, meetingManager: groups,
    sendToRenderer() {}, sessionManager: f.manager, transcriptTap: tap, confirmSessionModel: (...args) => f.api.confirmSessionModel(...args) });
  const inject = require('../main/ipc/groupchat-supplement-handlers').createRunningInjector({ sessionManager: f.manager, groupChatWatcher: watcher });
  const service = require('../main/orchestration/service').createOrchestrationService({ meetingManager: groups, sessionManager: f.manager,
    getHubDataDir: () => f.root, noticeMergeMs: 0, getDeliveryEngine: () => ({}), logger: { warn() {} }, injectPrompt: inject,
    getMembers: () => [{ memberId: 'm0', sid: 'orch-0001', kind: 'codeagent', displayName: '编排员' }, { memberId: 'm1', sid: f.info.id, kind: 'codeagent', displayName: '成员' }]
      .filter(x => groups.getMeeting(room.id)?.subSessions.includes(x.sid)),
    getDispatcher: () => ({ dispatchGroupChatTurn: (id, args) => args.targetMemberIds?.includes('m0')
      ? Promise.resolve({ status: 'completed', results: [] }) : dispatcher.dispatchGroupChatTurn(id, args) }) });
  t.after(() => { service.freeze(); f.gate.cancelAll(); dispatcher.interruptMeetingTurn(room.id); service.stop(); groups.closeMeeting(room.id); });
  return { service, groups, room };
}

test('cancelling an orchestration urgent model choice finally stops that message without asking again', async t => {
  const f = fixture(t), { service, room } = interruptOrchestration(t, f);
  f.manager.sessions.get(f.info.id).agentTurnActive = true;
  const added = await service.invokeTool({ callerSessionId: 'orch-0001', name: 'orch_send_message', arguments: { to: 'm1', message: '取消后不应重排', interrupt: true } });
  await flush(); assert.equal(f.requests.length, 1);
  const before = service.statusResult(room.id).communication.open.find(x => x.id === added.messageId);
  f.gate.respond({ requestId: f.requests[0].requestId, cancel: true }); f.manager.sessions.get(f.info.id).agentTurnActive = false;
  await flush(); await new Promise(resolve => setTimeout(resolve, 30)); await flush();
  assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 0);
  assert.equal(before.stage, 'waiting-model'); assert.equal(before.notSent, true);
  assert.equal(service.ledgerFor(room.id).channel.messages.find(x => x.id === added.messageId).state, 'failed');
});

for (const invalidation of ['end', 'remove', 'withdraw']) test(`an orchestration urgent message cannot resume after ${invalidation} during model confirmation`, async t => {
  const f = fixture(t), { service, groups, room } = interruptOrchestration(t, f);
  f.manager.sessions.get(f.info.id).agentTurnActive = true;
  const added = await service.invokeTool({ callerSessionId: 'orch-0001', name: 'orch_send_message', arguments: { to: 'm1', message: '结束或撤销后不得发送的旧指示', interrupt: true } });
  await flush(); assert.equal(f.requests.length, 1);
  if (invalidation === 'end') await service.userAction(room.id, 'end');
  else if (invalidation === 'remove') groups.removeSubSession(room.id, f.info.id);
  else service.ledgerFor(room.id).channel.messages.find(x => x.id === added.messageId).state = 'failed';
  f.manager.sessions.get(f.info.id).agentTurnActive = false; f.decide(); await flush();
  const item = service.ledgerFor(room.id).channel.messages.find(x => x.id === added.messageId);
  assert.equal(f.sent.length, 0); assert.equal(item.state, 'failed'); assert.equal(f.requests.length, 1);
});

for (const action of ['confirm', 'cancel']) test(`a restarted team retains its original task and asks again before any physical send (${action})`, async t => {
  const f = fixture(t); f.info.fixedModel = NEXT;
  const { service, deps } = await lateSubscriberTeam(t, f); f.sent.length = 0; f.info.fixedModel = OLD;
  const earlier = f.send('不可跨进程恢复的普通消息', { clientSubmissionId: 'lost-main-memory' }); await flush();
  const added = await service.invoke('lead-0001', 'send', { to: 'm1', message: '重启后确认才续发的原团队任务' }); await flush();
  const file = path.join(f.root, 'teams/lead-0001.json'), savedBeforeExit = fs.readFileSync(file);
  // Emulate process loss: retain the already-persisted ledger and discard the
  // old invocation/broker/manager. No old in-memory receipt is reused.
  service.freeze(); service.stop(); f.gate.cancelAll(); await earlier; await flush(); fs.writeFileSync(file, savedBeforeExit);
  const manager = Object.create(SessionManager.prototype); EventEmitter.call(manager); manager._refreshOpenIdentity = () => {};
  manager.sessions = new Map([...f.manager.sessions].map(([id, entry]) => [id, { info: { ...entry.info }, codeagentSettingsActive: entry.codeagentSettingsActive }]));
  manager.getNativeSession = f.manager.getNativeSession;
  const requests = [], gate = require('../main/session-model-creation').createModelCreationConfirmation({
    onWait: event => manager.emit('session-model-wait', event), sendToRenderer: (name, payload) => { if (name === 'session-model-create-confirm') requests.push(payload); },
  });
  const api = require('../main/ipc/session-handlers').registerSessionIpc({ handle() {}, on() {} }, { sessionManager: manager,
    requestModelConfirmation: (payload, options) => gate.request(payload, options), sendToRenderer() {} });
  watcher.init({ sessionManager: manager, confirmSessionModel: (...args) => api.confirmSessionModel(...args) });
  const prompt = ordinaryApi(t, { manager });
  const restarted = require('../main/team/service').createTeamService({ ...deps, sessionManager: manager,
    submitPrompt: (sid, text, options) => sid === f.info.id ? prompt.submitPrompt(null, { sessionId: sid, text, ...options }) : Promise.resolve({ ok: true }),
  });
  t.after(() => { restarted.freeze(); restarted.stop(); gate.cancelAll(); });
  const restored = (await restarted.invoke('lead-0001', 'status')).messages.find(x => x.id === added.messageId);
  assert.equal(restored.stage, 'waiting-model'); assert.equal(restored.notSent, true);
  const delivery = restarted.flush('lead-0001'); await flush();
  assert.equal(requests.length, 1); assert.equal(f.sent.length, 0);
  gate.respond({ requestId: requests[0].requestId, ...(action === 'confirm' ? { modelId: NEXT } : { cancel: true }) });
  await delivery; await flush();
  const item = restarted.listTeams()[0].messages.find(x => x.id === added.messageId);
  assert.equal(item.state, action === 'confirm' ? 'sent' : 'failed'); assert.equal(f.sent.length, action === 'confirm' ? 1 : 0);
  if (action === 'confirm') assert.ok(f.sent[0].text.includes('重启后确认才续发的原团队任务'));
});

test('a chosen model still leaves a durable not-sent task while its model menu is switching', async t => {
  const f = fixture(t); f.info.fixedModel = NEXT;
  const { service, deps } = await lateSubscriberTeam(t, f); f.sent.length = 0; f.info.fixedModel = OLD;
  const earlier = f.send('普通消息先等模型', { clientSubmissionId: 'switch-in-progress' }); await flush();
  const added = await service.invoke('lead-0001', 'send', { to: 'm1', message: '换型没完成前不能丢的团队原任务' }); await flush();
  let completePick; t.after(() => completePick?.({ ok: false, message: 'test cleanup' }));
  t.mock.method(require('../core/codeagent-model-picker'), 'pickModel', async () => new Promise(resolve => { completePick = resolve; }));
  f.decide(); await flush(); assert.equal(typeof completePick, 'function'); assert.equal(f.sent.length, 0);
  const disk = JSON.parse(fs.readFileSync(path.join(f.root, 'teams/lead-0001.json'))), saved = disk.messages.find(x => x.id === added.messageId);
  assert.equal(saved.notSent, true); assert.ok(saved.modelWait);
  const restarted = require('../main/team/service').createTeamService(deps);
  const item = (await restarted.invoke('lead-0001', 'status')).messages.find(x => x.id === added.messageId);
  restarted.freeze(); restarted.stop();
  assert.equal(item.stage, 'waiting-model'); assert.equal(item.notSent, true);
  completePick({ ok: true, confirmed: true }); await earlier; await flush();
  assert.equal(service.listTeams()[0].messages.find(x => x.id === added.messageId).state, 'sent');
});

test('a team task handed to the adapter is uncertain across restart and never restored as not sent', async t => {
  const f = fixture(t); f.info.fixedModel = NEXT;
  const { service, deps } = await lateSubscriberTeam(t, f); f.sent.length = 0; f.info.fixedModel = OLD;
  const earlier = f.send('先确认后立即完成的普通消息', { clientSubmissionId: 'choice-before-team-handoff' }); await flush();
  const added = await service.invoke('lead-0001', 'send', { to: 'm1', message: '物理写入后不得误当未发送' }); await flush();
  let release; t.after(() => release?.());
  f.manager.getNativeSession = () => ({ send: async (text, options) => {
    f.sent.push({ text, options }); if (text.includes('物理写入后不得误当未发送')) await new Promise(resolve => { release = resolve; }); return { ok: true };
  } });
  f.decide(); await earlier; await flush(); assert.equal(typeof release, 'function');
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'teams/lead-0001.json'))).messages.find(x => x.id === added.messageId);
  assert.equal(saved.notSent, false); assert.equal(saved.modelWait, undefined);
  const restarted = require('../main/team/service').createTeamService(deps);
  const item = (await restarted.invoke('lead-0001', 'status')).messages.find(x => x.id === added.messageId);
  restarted.freeze(); restarted.stop(); assert.equal(item.state, 'unconfirmed');
  release(); await flush();
});

test('normal shutdown freezes and cancels the UI without losing a not-sent late team task', async t => {
  const f = fixture(t); f.info.fixedModel = NEXT;
  const { service, deps } = await lateSubscriberTeam(t, f); f.sent.length = 0; f.info.fixedModel = OLD;
  const earlier = f.send('退出时普通待发正文不另落盘', { clientSubmissionId: 'shutdown-ui-owner' }); await flush();
  const added = await service.invoke('lead-0001', 'send', { to: 'm1', message: '正常退出也要保留的原团队任务' }); await flush();
  service.freeze(); f.gate.cancelAll(); await earlier; await flush(); service.stop();
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'teams/lead-0001.json'))).messages.find(x => x.id === added.messageId);
  assert.equal(saved.state, 'waiting-model'); assert.equal(saved.notSent, true); assert.ok(saved.modelWait); assert.equal(f.sent.length, 0);
  const restarted = require('../main/team/service').createTeamService(deps);
  const restored = (await restarted.invoke('lead-0001', 'status')).messages.find(x => x.id === added.messageId);
  restarted.freeze(); restarted.stop(); assert.equal(restored.stage, 'waiting-model'); assert.equal(restored.notSent, true);
});

test('an ordinary non-final orchestration injection failure still queues the message for normal delivery', async () => {
  const ledger = { status: 'running', channel: { messages: [], requests: [], grants: [] } };
  const roster = [{ memberId: 'm0', sid: 'orch', name: '负责人', orchestrator: true }, { memberId: 'm1', sid: 'worker', name: '成员' }];
  let busy = true; const dispatched = [];
  const channel = require('../main/orchestration/channel').createChannel({ ledgerFor: () => ledger, members: () => roster,
    persist() {}, notify() {}, ensureReady: async () => {}, busy: sid => sid === 'worker' && busy, now: () => Date.now(), isFrozen: () => false,
    logger: { warn() {} }, inject: async () => ({ accepted: false, notSent: true, reason: '当前终端不接受插话' }),
    dispatch: async (_id, args) => { dispatched.push(args); return { status: 'completed', results: [] }; },
  });
  const added = channel.send('room', roster[0], { to: 'm1', message: '应该保留的普通回退', interrupt: true }); await flush();
  const item = ledger.channel.messages.find(x => x.id === added.messageId);
  assert.equal(item.state, 'queued'); assert.equal(item.interrupt, false);
  busy = false; await channel.flush('room');
  assert.equal(item.state, 'sent'); assert.equal(dispatched.length, 1); assert.ok(dispatched[0].userInput.includes('应该保留的普通回退'));
});

for (const action of ['shutdown', 'user-cancel']) test(`a model-paused urgent team task preserves shutdown intent separately from explicit cancellation (${action})`, async t => {
  const f = fixture(t); f.info.fixedModel = NEXT;
  const inject = require('../main/ipc/groupchat-supplement-handlers').createRunningInjector({ sessionManager: f.manager, groupChatWatcher: watcher });
  const { service } = await lateSubscriberTeam(t, f, { injectPrompt: inject }); f.sent.length = 0; f.info.fixedModel = OLD;
  f.manager.sessions.get(f.info.id).agentTurnActive = true;
  const added = await service.invoke('lead-0001', 'send', { to: 'm1', message: '退出时保留，手动取消时停止的紧急任务', interrupt: true });
  await flush(); assert.equal(f.requests.length, 1); service.freeze();
  if (action === 'shutdown') f.gate.cancelAll(); else f.gate.respond({ requestId: f.requests[0].requestId, cancel: true });
  await flush();
  const item = JSON.parse(fs.readFileSync(path.join(f.root, 'teams/lead-0001.json'))).messages.find(x => x.id === added.messageId);
  assert.equal(item.state, action === 'shutdown' ? 'waiting-model' : 'failed'); assert.equal(item.notSent, true); assert.equal(f.sent.length, 0);
});

function failHandoffSaveOnce(t, f) {
  const originalEmit = f.manager.emit, originalRename = fs.renameSync;
  const observed = { armed: false, faults: 0, handoffs: 0 }; let inHandoff = false;
  t.mock.method(f.manager, 'emit', function (name, ...args) {
    if (name !== 'session-submission-handoff') return originalEmit.call(this, name, ...args);
    observed.handoffs++; inHandoff = true;
    try { return originalEmit.call(this, name, ...args); } finally { inHandoff = false; }
  });
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (inHandoff && observed.armed && String(to).startsWith(path.join(f.root, 'teams') + path.sep)) {
      observed.armed = false; observed.faults++;
      throw Object.assign(new Error('synthetic single handoff write failure'), { code: 'EACCES' });
    }
    return originalRename.call(this, from, to);
  });
  return observed;
}

test('one handoff save failure really retries after backoff and sends the original team task exactly once', async t => {
  const f = fixture(t); f.info.fixedModel = NEXT; let clock = Date.now();
  const { service } = await lateSubscriberTeam(t, f, { now: () => clock }); f.sent.length = 0; f.info.fixedModel = OLD;
  const observed = failHandoffSaveOnce(t, f);
  const added = await service.invoke('lead-0001', 'send', { to: 'm1', message: '写盘恢复后必须真正重试的原任务' });
  await flush(); observed.armed = true; f.decide(); await flush();
  const first = service.listTeams()[0].messages.find(x => x.id === added.messageId);
  assert.equal(first.state, 'queued'); assert.equal(observed.faults, 1); assert.equal(observed.handoffs, 1); assert.equal(f.sent.length, 0);
  clock += 61000; await service.flush('lead-0001'); await flush();
  assert.equal(observed.handoffs, 2); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].options.clientSubmissionId, added.messageId); assert.ok(f.sent[0].text.includes('写盘恢复后必须真正重试的原任务'));
  assert.equal(service.listTeams()[0].messages.find(x => x.id === added.messageId).state, 'sent');
  for (const delay of [181000, 601000]) { clock += delay; await service.flush('lead-0001'); await flush(); }
  assert.equal(observed.handoffs, 2); assert.equal(f.sent.length, 1); assert.equal(f.requests.length, 1);
});

test('an explicitly not-handed-off rejected attempt can retry the same receipt but preserves body identity and success deduplication', async t => {
  const f = fixture(t), originalEmit = f.manager.emit; let fail = true, handoffs = 0;
  t.mock.method(f.manager, 'emit', function (name, ...args) {
    if (name === 'session-submission-handoff') {
      handoffs++;
      if (fail) { fail = false; throw Object.assign(new Error('transient pre-handoff persistence failure'), { code: 'EACCES', retryableBeforeHandoff: true }); }
    }
    return originalEmit.call(this, name, ...args);
  });
  const options = { clientSubmissionId: 'retry-original-receipt', attachments: [{ path: 'same.png' }] };
  const first = f.send('原正文与附件保持不变', options); await flush(); f.decide();
  const failure = await first.catch(error => error); assert.equal(failure.notSent, true); assert.equal(f.sent.length, 0);
  const changed = await f.send('改变正文不得复用原编号', options);
  assert.equal(changed.code, 'submission-id-conflict'); assert.equal(handoffs, 1);
  const second = await f.send('原正文与附件保持不变', options).catch(error => ({ error }));
  assert.equal(second.ok, true, second.error?.message); assert.equal(handoffs, 2); assert.equal(f.sent.length, 1);
  assert.equal((await f.send('原正文与附件保持不变', options)).ok, true);
  assert.equal(handoffs, 2); assert.equal(f.sent.length, 1);
});

test('a cancelled original receipt remains final even when the same receipt is submitted again', async t => {
  const f = fixture(t), options = { clientSubmissionId: 'final-user-cancel' };
  const first = f.send('明确取消后不可重放', options); await flush();
  f.gate.respond({ requestId: f.requests[0].requestId, cancel: true });
  assert.equal((await first).stopped, true);
  assert.equal((await f.send('明确取消后不可重放', options)).stopped, true);
  assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 0);
});

test('an uncertain handed-off receipt stays cached and never retries its body', async t => {
  const f = fixture(t), options = { clientSubmissionId: 'unknown-after-handoff' };
  f.manager.getNativeSession = () => ({ send: async text => {
    f.sent.push({ text }); return { ok: false, unconfirmed: true, notSent: false, message: 'ACK unavailable after handoff' };
  } });
  const first = f.send('已交接结果未知不可重放', options); await flush(); f.decide();
  const result = await first; assert.equal(result.unconfirmed, true); assert.equal(f.sent.length, 1);
  const second = await f.send('已交接结果未知不可重放', options);
  assert.equal(second.unconfirmed, true); assert.equal(f.sent.length, 1);
});
