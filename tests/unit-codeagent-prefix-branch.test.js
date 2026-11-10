'use strict';
// Synthetic transcripts and a mocked launcher; no real CLI is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { registerPrefixForkIpc } = require('../main/ipc/codeagent-prefix-fork-handlers');
const { projectSlug } = require('../core/claude-prefix-fork');
const { parseClaudeTranscriptToNativeTurns } = require('../core/claude-disk-transcript');
const { parseSessionTranscript } = require('../main/ipc/transcript-handlers');
const { recoverCodeAgentFork } = require('../core/codeagent-fork-identity');
const { setEnabled, branchAction, forkBeforeTurn, patchCardActions, FORK_TITLE } = require('../renderer/card-prefix-fork');
setEnabled(true);
const SOURCE = '11111111-1111-4111-8111-111111111111';
const U1 = '22222222-2222-4222-8222-222222222222';
const U2 = '33333333-3333-4333-8333-333333333333';
const U3 = '44444444-4444-4444-8444-444444444444';
const A1 = '55555555-5555-4555-8555-555555555555';
const A2 = '66666666-6666-4666-8666-666666666666';
const A3 = '77777777-7777-4777-8777-777777777777';
const HUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const stamp = n => new Date(1700000000000 + n * 1000).toISOString();

function fixture(t, { pool = false, skill = false, deps = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-branch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'hub'), cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const configDir = pool ? require('../core/codeagent-pool').accountDir(dataDir, 'acct001') : path.join(root, 'personal');
  const file = path.join(configDir, 'projects', projectSlug(cwd), SOURCE + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const user = (uuid, text, parentUuid, n, extra = {}) => ({ type: 'user', uuid, parentUuid, isSidechain: false,
    cwd, sessionId: SOURCE, timestamp: stamp(n), message: { role: 'user', content: text }, ...extra });
  const answer = (uuid, parentUuid, n) => ({ type: 'assistant', uuid, parentUuid, isSidechain: false,
    cwd, sessionId: SOURCE, timestamp: stamp(n), message: { role: 'assistant', id: 'msg-' + uuid,
      content: [{ type: 'text', text: '合成回答' }], stop_reason: 'end_turn' } });
  const rows = [user(U1, '记住甲=123', null, 1), answer(A1, U1, 2), user(U2, skill
    ? '<command-message>fake-skill</command-message>\n<command-name>/fake-skill</command-name>\n<command-args>合成\n参数</command-args>' : '把甲改成456', A1, 3,
  skill ? { isMeta: true, promptId: 'skill-one' } : {}), answer(A2, U2, 4), user(U3, '第三轮', A2, 5), answer(A3, U3, 6)];
  const write = () => fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n'); write();
  const source = { id: HUB, kind: 'codeagent', status: 'idle', agentRuntime: 'pty', ccSessionId: SOURCE, transcriptPath: file,
    title: '合成会话', cwd, currentModel: { id: 'GLM-5.2' }, effort: 'low', ...(pool ? { codeagentPoolAccount: 'acct001' } : {}) };
  const live = new Map([[HUB, source]]), calls = [], events = [], handlers = new Map();
  const manager = { sessions: new Map([[HUB, { info: { ...source, codeagentConfigDir: configDir } }]]),
    getSession: id => live.get(id), getAllSessions: () => [...live.values()], getNativeSession: () => null,
    createSession(kind, opts) {
      calls.push({ kind, opts });
      const child = { id: opts.id || randomUUID(), kind, cwd: opts.cwd, title: opts.title, status: 'idle', agentRuntime: 'pty',
        currentModel: { id: opts.model }, effort: opts.effort, branchSourceSessionId: opts.branchSourceSessionId,
        branchIndex: opts.branchIndex, branchAutoTitlePending: opts.branchAutoTitlePending, autoTitleGenerated: opts.autoTitleGenerated,
        codeagentPrefixFork: opts.codeagentPrefixFork, codeagentForkSourceSessionId: opts.codeagentForkSourceSessionId,
        ...(opts.resumeCCSessionId ? { ccSessionId: opts.resumeCCSessionId, transcriptPath: opts.resumeTranscriptPath } : {}),
        ...(opts.codeagentPoolAccount ? { codeagentPoolAccount: opts.codeagentPoolAccount } : {}) };
      live.set(child.id, child); return child;
    } };
  registerPrefixForkIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, { sessionManager: manager, dataDir,
    prefixEnabled: () => true, forkSession: () => ({ ok: true, session: manager.createSession('codeagent', { forkCCSessionId: SOURCE, cwd }) }),
    forkSiblingPool: () => [...live.values()], sendToRenderer: (name, value) => events.push({ name, value }), ...deps });
  const invoke = (cutUserUuid = U2, sourceSessionId = HUB) => handlers.get('session:fork-before-turn')(null, { replyId: ({ [U2]: U1, [U3]: U2 }[cutUserUuid] || cutUserUuid) + ':assistant', sourceSessionId });
  const parserDeps = { sessionManager: manager, dataDir, parseClaudeTranscriptToNativeTurns, isCodexCliKind: () => false,
    findTranscriptByCCSessionId: () => null, updateSessionTranscriptBinding: () => {}, getPersistedSessions: () => [] };
  return { root, dataDir, configDir, cwd, file, rows, write, source, live, manager, handlers, calls, events, invoke, parserDeps };
}

function sleepingFixture(t) {
  const saved = [];
  const f = fixture(t, { deps: { getPersistedSessions: () => saved } });
  const mapping = new Map(f.rows.map((row, index) => [row.uuid, 'msg_' + String(index + 1).repeat(48)]));
  for (const row of f.rows) { row.uuid = mapping.get(row.uuid); row.parentUuid = mapping.get(row.parentUuid) || null; }
  f.write();
  saved.push({ ...f.source, hubId: HUB, codeagentConfigDir: f.configDir });
  f.live.delete(HUB); f.manager.sessions.delete(HUB);
  let held = null, occupied = false;
  const owners = { owner() { return occupied ? { pid: 999 } : held; },
    claim(id, keys) { if (occupied) throw Object.assign(new Error('occupied'), { code: 'SESSION_OCCUPIED' });
      assert.equal(id, HUB); assert.ok(keys[0].endsWith(SOURCE)); held = { nonce: 'test-lease' }; return held; },
    release(lease) { assert.equal(lease, held); held = null; } };
  f.manager._openOwners = () => owners;
  const request = index => ({ sourceSessionId: HUB, replyId: mapping.get([U1, U2, U3][index]) + ':assistant' });
  return { ...f, saved, owners, request, occupied: value => { occupied = value; }, held: () => held,
    status: () => f.handlers.get('session:prefix-fork-status')(null, { sourceSessionId: HUB }),
    fork: (index = 0) => f.handlers.get('session:fork-before-turn')(null, request(index)) };
}

test('restarted dormant history branches from persisted msg_ records without waking or mutating its source', async t => {
  const f = sleepingFixture(t), saved = JSON.stringify(f.saved), raw = fs.readFileSync(f.file), stamp = fs.statSync(f.file).mtimeMs;
  assert.equal(f.status().ok, true); assert.equal(f.held(), null); assert.equal(f.calls.length, 0);
  const result = await f.fork(); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.calls.length, 1); assert.notEqual(result.session.id, HUB);
  assert.equal(result.session.codeagentPrefixFork.cutUserUuid, 'msg_' + '3'.repeat(48));
  assert.equal(f.manager.getSession(HUB), undefined); assert.equal(f.held(), null);
  assert.equal(JSON.stringify(f.saved), saved); assert.deepEqual(fs.readFileSync(f.file), raw);
  assert.equal(fs.statSync(f.file).mtimeMs, stamp);
});

test('dormant status and execution both refuse occupied, unknown, locally running and unstable sources', async t => {
  const f = sleepingFixture(t);
  f.occupied(true);
  assert.equal(f.status().reason, 'session-occupied'); assert.equal((await f.fork()).reason, 'session-occupied');
  f.occupied(false); f.manager._openOwners = () => { throw new Error('unavailable'); };
  assert.equal(f.status().reason, 'state-unknown'); assert.equal((await f.fork()).reason, 'state-unknown');
  f.manager._openOwners = () => f.owners; f.manager.sessions.set(HUB, { pty: { pid: 123 } });
  assert.equal(f.status().reason, 'session-busy'); assert.equal((await f.fork()).reason, 'session-busy');
  f.manager.sessions.delete(HUB);
  fs.appendFileSync(f.file, '{unfinished');
  assert.equal(f.status().reason, 'incomplete-json'); assert.equal((await f.fork()).reason, 'incomplete-json');
  assert.equal(f.calls.length, 0); assert.equal(f.held(), null);
});

test('dormant last round seeds its own record; explicit ordinary fallback still creates only a child', async t => {
  const f = sleepingFixture(t), saved = JSON.stringify(f.saved), raw = fs.readFileSync(f.file);
  const previous = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = f.dataDir;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = previous; });
  const handlers = new Map();
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: f.manager, dataDir: f.dataDir, prefixEnabled: () => true,
    getPersistedSessions: () => f.saved, sendToRenderer() {},
  });
  const result = await handlers.get('session:fork-before-turn')(null, f.request(2));
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.forkCCSessionId, undefined); assert.notEqual(f.calls[0].opts.id, HUB);
  assert.equal(f.calls[0].opts.resumeCCSessionId, result.session.ccSessionId); assert.equal(f.manager.getSession(HUB), undefined);
  assert.equal(result.session.codeagentPrefixFork.cutUserUuid, null);
  assert.equal(fs.readFileSync(result.session.transcriptPath, 'utf8').trim().split('\n').length, f.rows.length);
  assert.equal(JSON.stringify(f.saved), saved); assert.deepEqual(fs.readFileSync(f.file), raw); assert.equal(f.held(), null);
  // A rejected historical cut still offers a working explicit full-history
  // alternative; it receives the same no-wake and ownership checks.
  fs.mkdirSync(f.file.slice(0, -6)); fs.writeFileSync(path.join(f.file.slice(0, -6), 'unknown.txt'), 'synthetic');
  assert.equal((await handlers.get('session:fork-before-turn')(null, f.request(0))).reason, 'sidecar-unknown-content');
  const fallback = handlers.get('session:prefix-fork-ordinary');
  assert.equal((await fallback(null, { sourceSessionId: HUB })).ok, true);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].opts.forkCCSessionId, SOURCE);
  f.occupied(true);
  assert.equal((await fallback(null, { sourceSessionId: HUB })).reason, 'session-occupied');
  assert.equal(f.calls.length, 2); assert.equal(f.manager.getSession(HUB), undefined);
  assert.equal(JSON.stringify(f.saved), saved); assert.deepEqual(fs.readFileSync(f.file), raw);
});

test('dormant buttons stay visible while checking, enable only on Main proof, and show occupied/unknown reasons', async t => {
  const { configureStatus, invalidateStatus } = require('../renderer/card-prefix-fork');
  const session = { id: 'dormant-ui', kind: 'codeagent', status: 'dormant' };
  const turn = { id: 'msg_body', logicalTurnId: 'msg_user:assistant', deliveryContext: {}, role: 'assistant',
    text: 'synthetic', userMessageId: 'msg_user', source: 'claude-transcript' };
  t.after(() => { configureStatus(null); setEnabled(true); });
  for (const result of [{ ok: true }, { ok: false, message: 'occupied' }, { ok: false, message: 'unknown' }]) {
    configureStatus(async () => result); invalidateStatus(session.id);
    assert.equal(branchAction(turn, session).disabled, true);
    await new Promise(resolve => setImmediate(resolve));
    const action = branchAction(turn, session); assert.ok(action); assert.equal(action.disabled, !result.ok);
    if (!result.ok) assert.match(action.title, new RegExp(result.message));
  }
  assert.equal(branchAction(turn, { ...session, status: 'idle', runtimeTruth: { state: 'unknown' } }).disabled, true);
});

test('record IDs accept UUID or bounded safe msg_ identifiers, while session IDs remain UUID-only', async t => {
  const { isNativeRecordId, isNativeSessionId } = require('../core/codeagent-record-id');
  const { nativeUserRecordId } = require('../renderer/card-prefix-fork');
  for (const id of [U1, U1.toUpperCase(), 'msg_' + 'a'.repeat(48), 'msg_A-z_09', 'msg_' + 'b'.repeat(124)]) {
    assert.equal(isNativeRecordId(id), true);
    assert.equal(nativeUserRecordId({ role: 'assistant', source: 'claude-transcript', userMessageId: id }), id);
  }
  for (const id of [null, 123, '', 'msg_', 'MSG_abc', 'plain-id', 'msg_' + 'a'.repeat(125),
    'msg_../escape', 'msg_a/b', 'msg_a\\b', 'msg_a:b', 'msg_a b', 'msg_a\n', 'msg_a\0', 'msg_中文', 'msg_"quote', U1 + '\n']) {
    assert.equal(isNativeRecordId(id), false, String(id));
    assert.equal(nativeUserRecordId({ role: 'assistant', source: 'claude-transcript', userMessageId: id }), null);
  }
  const f = fixture(t), { forkClaudePrefix } = require('../core/claude-prefix-fork');
  for (const id of ['msg_' + 'a'.repeat(48), U1 + '\n']) {
    assert.equal(isNativeSessionId(id), false);
    assert.equal(forkClaudePrefix({ sourceFile: f.file, configDir: f.configDir, cwd: f.cwd,
      cutUserUuid: U2, newSessionId: id }).reason, 'invalid-options');
    f.source.ccSessionId = id;
    assert.equal((await f.invoke()).reason, 'native-identity-missing');
  }
  assert.equal(f.calls.length, 0);
});

test('msg_ native records reach renderer, Main, prefix writer and recovery without rewriting references', async t => {
  const f = fixture(t), { displayChatTurns } = require('../renderer/simple-chat-display');
  const { isNativeSessionId } = require('../core/codeagent-record-id');
  const { forkClaudePrefix } = require('../core/claude-prefix-fork');
  const ids = new Map([U1, A1, U2, A2, U3, A3].map((id, i) => [id, 'msg_' + String(i + 1).repeat(48)]));
  for (const row of f.rows) { row.uuid = ids.get(row.uuid); row.parentUuid = ids.get(row.parentUuid) || null; }
  f.rows[1].message.content.push({ type: 'tool_use', id: 'call_safe-01', name: 'Read', input: {} });
  const toolResult = { ...f.rows[0], uuid: 'msg_' + '7'.repeat(48), parentUuid: ids.get(A1),
    message: { content: [{ type: 'tool_result', tool_use_id: 'call_safe-01', content: 'synthetic' }] } };
  f.rows.splice(2, 0, toolResult); f.rows[3].parentUuid = toolResult.uuid; f.write();
  const before = fs.readFileSync(f.file), beforeStat = fs.statSync(f.file);
  const cards = displayChatTurns(parseClaudeTranscriptToNativeTurns(f.file, { codeagent: true }));
  const invokeReply = async userId => {
    const card = cards.find(card => card.logicalTurnId === userId + ':assistant');
    const action = branchAction(card, f.source); assert.ok(action);
    assert.match(renderer(f.source).renderTurnCard(card, { mainCard: true, sessionId: HUB }), /fork-before-turn/);
    return f.handlers.get('session:fork-before-turn')(null, { sourceSessionId: HUB, replyId: action.replyId });
  };
  for (const [opener, cut, count] of [[U1, U2, 3], [U2, U3, 5]]) {
    const result = await invokeReply(ids.get(opener)); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.session.codeagentPrefixFork.cutUserUuid, ids.get(cut));
    assert.equal(isNativeSessionId(result.session.ccSessionId), true);
    const kept = fs.readFileSync(result.session.transcriptPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(kept, f.rows.slice(0, count).map(row => ({ ...row, sessionId: result.session.ccSessionId })));
    assert.equal(recoverCodeAgentFork(result.session, { dataDir: f.dataDir }).meta.ccSessionId, result.session.ccSessionId);
    const parsed = await parseSessionTranscript({ hubSessionId: result.session.id, opts: { limit: 100 } }, f.parserDeps);
    assert.equal(parsed.error, null); assert.ok(parsed.turns.every(turn => !turn.inherited));
  }
  const last = await invokeReply(ids.get(U3)); assert.equal(last.ok, true);
  assert.equal(f.calls.at(-1).opts.forkCCSessionId, undefined);
  assert.equal(f.calls.at(-1).opts.resumeCCSessionId, last.session.ccSessionId);
  const direct = forkClaudePrefix({ sourceFile: f.file, configDir: f.configDir, cwd: f.cwd, cutUserUuid: ids.get(U2) });
  assert.equal(direct.ok, true); // Legacy manual path already treats record IDs as opaque.
  const logs = fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logs[0].cutUserUuid, ids.get(U2));
  assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(fs.statSync(f.file).mtimeMs, beforeStat.mtimeMs);
  f.rows[2].message.content[0].tool_use_id = 'call_missing'; f.write();
  assert.equal((await invokeReply(ids.get(U1))).reason, 'unpaired-tool');
});

test('unsafe or duplicate msg_ cuts refuse without falling back to the entire session', async t => {
  for (const id of ['msg_', 'msg_bad/path', 'msg_bad\\path', 'msg_bad\n', 'msg_' + 'x'.repeat(125)]) {
    const f = fixture(t); f.rows[2].uuid = id; f.write();
    assert.equal((await f.invoke()).reason, 'ambiguous-cut'); assert.equal(f.calls.length, 0);
  }
  const f = fixture(t); f.rows[2].uuid = f.rows[4].uuid = 'msg_duplicate'; f.write();
  assert.equal((await f.invoke()).reason, 'ambiguous-cut'); assert.equal(f.calls.length, 0);
});

test('real IPC registration creates an independent prefix and inherits settings without resending', async t => {
  const f = fixture(t), raw = fs.readFileSync(f.file), result = await f.invoke();
  assert.equal(result.ok, true);
  const { kind, opts } = f.calls[0];
  assert.equal(kind, 'codeagent'); assert.equal(opts.forkCCSessionId, undefined);
  assert.notEqual(opts.resumeCCSessionId, SOURCE);
  assert.equal(opts.resumeCCSessionId, result.session.ccSessionId);
  assert.equal(opts.model, 'GLM-5.2'); assert.equal(opts.effort, 'low'); assert.equal(opts.cwd, f.cwd);
  assert.equal(opts.codeagentPrefixFork.cutUserUuid, U2);
  assert.deepEqual(opts.codeagentPrefixFork.prefixUserUuids, [U1]);
  assert.equal(opts.codeagentPrefixFork.sourceSessionId, HUB);
  assert.equal(opts.codeagentPrefixFork.sourceNativeSessionId, SOURCE);
  assert.equal(opts.prompt, undefined); assert.equal(opts.initialPrompt, undefined);
  assert.deepEqual(fs.readFileSync(f.file), raw);
  assert.equal(f.events[0].name, 'session-created');
  const log = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8'));
  assert.equal(log.source, HUB.slice(0, 8)); assert.equal(log.cutUserUuid, U2);
  assert.equal(log.keptLines, 2); assert.equal(log.droppedLines, 4); assert.equal(log.result, 'created');
  assert.equal(JSON.stringify(log).includes('把甲'), false);
});

test('IPC rejects invalid payloads, wrong kinds, group members and active sessions without launching', async t => {
  const f = fixture(t), handler = f.handlers.get('session:fork-before-turn');
  assert.equal((await handler(null, null)).reason, 'session-not-found');
  assert.equal((await f.invoke(U2, 'missing')).reason, 'session-not-found');
  f.source.kind = 'claude'; assert.equal((await f.invoke()).reason, 'unsupported-kind'); f.source.kind = 'codeagent';
  f.source.meetingId = 'meeting'; assert.equal((await f.invoke()).reason, 'group-session'); delete f.source.meetingId;
  f.source.status = 'running'; assert.equal((await f.invoke()).reason, 'session-busy'); f.source.status = 'idle';
  assert.equal((await f.invoke('not-a-uuid')).reason, 'reply-not-found');
  f.source.ccSessionId = null; assert.equal((await f.invoke()).reason, 'native-identity-missing');
  assert.equal(f.calls.length, 0);
});

test('IPC rejects a record belonging to another identity and reports core compact failures', async t => {
  const f = fixture(t);
  f.rows[0].sessionId = randomUUID(); f.write();
  assert.equal((await f.invoke()).reason, 'source-identity-mismatch');
  f.rows[0].sessionId = SOURCE;
  f.rows.splice(2, 0, { type: 'system', subtype: 'compact_boundary', uuid: 'compact', sessionId: SOURCE,
    compactMetadata: { preservedMessages: { anchorUuid: U2 } } }); f.write();
  const result = await f.invoke();
  assert.equal(result.reason, 'compact-reference-outside-prefix');
  assert.equal(result.message, '压缩记录引用了被截掉的内容');
  assert.equal(f.calls.length, 0);
});

test('pool directory is used for the seed and for exact child recovery', async t => {
  const f = fixture(t, { pool: true }), result = await f.invoke(); assert.equal(result.ok, true);
  assert.equal(f.calls[0].opts.codeagentPoolAccount, 'acct001');
  assert.equal(result.session.transcriptPath.startsWith(f.configDir + path.sep), true);
  const recovered = recoverCodeAgentFork(result.session, { dataDir: f.dataDir });
  assert.equal(recovered.meta.ccSessionId, result.session.ccSessionId);
  assert.equal(recovered.forkCCSessionId, null);
  fs.unlinkSync(result.session.transcriptPath);
  assert.throws(() => recoverCodeAgentFork(result.session, { dataDir: f.dataDir }), /独立会话记录/);
});

test('ordinary single-account and pool forks keep the mainline global history lookup on every recovery path', t => {
  const f = fixture(t), history = require('../core/claude-native-history');
  const find = history.findNativeClaudeHistory, observed = [];
  t.mock.method(history, 'findNativeClaudeHistory', (id, opts) => { observed.push(opts.env.CLAUDE_CONFIG_DIR); return find(id, opts); });
  const env = { ...process.env, AI_HUB_CODEAGENT_CONFIG_DIR: f.configDir };
  const expected = require('../core/codeagent-config').resolveCodeAgentConfig(env).configDir;
  for (const account of [{}, { codeagentPoolAccount: 'acct001', codeagentConfigDir: path.join(f.root, 'wrong-account') }]) {
    // SOURCE is the independent child's native ID in these ordinary fixtures.
    const base = { ...f.source, ...account, codeagentForkSourceSessionId: U1 };
    for (const meta of [base, { ...base, ccSessionId: null }]) {
      assert.equal(recoverCodeAgentFork(meta, { env, dataDir: f.dataDir }).meta.ccSessionId, SOURCE);
      assert.equal(observed.at(-1), expected);
    }
    const pending = { ...base, ccSessionId: null, transcriptPath: null, codeagentForkSourceSessionId: SOURCE };
    assert.equal(recoverCodeAgentFork(pending, { env, dataDir: f.dataDir }).forkCCSessionId, SOURCE);
    assert.equal(observed.at(-1), expected);
  }
  assert.equal(observed.length, 6);
});

test('persisted single-account and pool prefixes use the recorded directory even after account metadata changes', async t => {
  const history = require('../core/claude-native-history'), find = history.findNativeClaudeHistory, observed = [];
  t.mock.method(history, 'findNativeClaudeHistory', (id, opts) => { observed.push(opts.env.CLAUDE_CONFIG_DIR); return find(id, opts); });
  for (const pool of [false, true]) {
    const f = fixture(t, { pool }), result = await f.invoke(); assert.equal(result.ok, true);
    const saved = path.join(f.root, 'saved-child.json'); fs.writeFileSync(saved, JSON.stringify(result.session));
    f.live.clear();
    const loaded = JSON.parse(fs.readFileSync(saved, 'utf8'));
    loaded.codeagentPoolAccount = 'different-account'; loaded.codeagentConfigDir = path.join(f.root, 'different-directory');
    const env = { ...process.env, AI_HUB_CODEAGENT_CONFIG_DIR: path.join(f.root, 'different-global') };
    const recovered = recoverCodeAgentFork(loaded, { env, dataDir: f.dataDir });
    assert.equal(observed.at(-1), loaded.codeagentPrefixFork.configDir);
    assert.equal(observed.at(-1), f.configDir);
    assert.equal(recovered.meta.transcriptPath, result.session.transcriptPath);
    assert.equal(recovered.meta.ccSessionId, result.session.ccSessionId);
    assert.equal(recovered.forkCCSessionId, null);
  }
});

test('persisted prefix reopens through the real resume handler with its own ID after the source is gone', async t => {
  const f = fixture(t, { pool: true }), result = await f.invoke();
  const previous = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = f.dataDir;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = previous; });
  const store = require('../core/session-store');
  const resumeMeta = require('../core/session-capabilities').buildSessionResumeMeta(result.session);
  assert.deepEqual(resumeMeta.codeagentPrefixFork, result.session.codeagentPrefixFork);
  store.saveSessionFile(result.session.id, result.session);
  f.live.clear();
  const loaded = store.loadSessionFile(result.session.id, { strict: true });
  assert.deepEqual(loaded.codeagentPrefixFork, result.session.codeagentPrefixFork);
  const recovered = recoverCodeAgentFork(loaded, { dataDir: f.dataDir });
  assert.equal(recovered.meta.ccSessionId, result.session.ccSessionId);
  assert.equal(recovered.meta.transcriptPath, result.session.transcriptPath);
  assert.equal(recovered.forkCCSessionId, null);
  let globalDiscovery = 0;
  const resume = require('../main/ipc/resume-session-handlers').createResumeSessionHandler({
    fs, os, path, getHookPort: () => 0, getHubDataDir: () => f.dataDir, sessionManager: f.manager,
    isClaudeFamily: kind => /^codeagent(?:-resume)?$/.test(kind), isCodexBaseKind: () => false,
    findTranscriptByCCSessionId: () => { globalDiscovery++; return f.file; },
    meetingManager: { getAllMeetings: () => [] }, registerSessionForTap() {}, sendToRenderer() {}, slotIds: [],
  });
  const restored = await resume({ hubId: result.session.id }, { skipLaunchAuth: true });
  const opts = f.calls.at(-1).opts;
  assert.equal(restored.id, result.session.id);
  assert.equal(opts.resumeCCSessionId, result.session.ccSessionId);
  assert.equal(opts.resumeTranscriptPath, result.session.transcriptPath);
  assert.equal(opts.forkCCSessionId, undefined);
  assert.equal(opts.codeagentPoolAccount, 'acct001');
  assert.equal(opts.model, 'GLM-5.2'); assert.equal(opts.effort, 'low');
  assert.deepEqual(opts.codeagentPrefixFork, loaded.codeagentPrefixFork);
  assert.equal(globalDiscovery, 0);
});

test('persistence rounds retain the authoritative prefix boundary and survive an older renderer snapshot', async t => {
  const f = fixture(t), child = (await f.invoke()).session;
  const persistence = require('../main/ipc/persistence-handlers');
  let saved, lastSessions = [];
  const list = [{ hubId: child.id, kind: child.kind }];
  persistence.handlePersistSessions(list, [], {
    sessionManager: f.manager, getLiveSession: id => f.live.get(id),
    getLastPersistedSessions: () => lastSessions, setLastPersistedSessions: value => { lastSessions = value; },
    getLastPersistedSessionIds: () => new Set(), setLastPersistedSessionIds() {},
    getLastPersistedMeetingIds: () => new Set(), setLastPersistedMeetingIds() {},
    getImmersiveByMeeting: () => ({}), meetingManager: { getAllMeetings: () => [] }, meetingStore: {},
    sessionStore: { markDirty: (_id, value) => { saved = value; } }, stateStore: { save() {} },
  });
  assert.deepEqual(saved.codeagentPrefixFork, child.codeagentPrefixFork);
  const dormant = [{ hubId: child.id, kind: child.kind }];
  persistence.mergeResumeMetaFields(dormant, lastSessions);
  assert.deepEqual(dormant[0].codeagentPrefixFork, child.codeagentPrefixFork);
});

test('launcher refuses a missing seeded prefix rather than silently creating or forking another conversation', async t => {
  const f = fixture(t), result = await f.invoke();
  const previous = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = f.dataDir;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = previous; });
  const build = require('../core/session-manager')._private.buildCodeAgentPtyLaunch;
  const opts = { ...f.calls[0].opts, mcpProfile: 'full' };
  const capabilities = require('../core/codeagent-capabilities'), original = capabilities.readHelp;
  capabilities.readHelp = () => ''; t.after(() => { capabilities.readHelp = original; });
  const launch = build('test-prefix', 'codeagent', opts, f.cwd, {}, { configDir: f.configDir, command: 'not-executed' });
  assert.ok(launch.cmd.includes('--resume ' + result.session.ccSessionId));
  assert.equal(launch.cmd.includes('--fork-session'), false); assert.equal(launch.cmd.includes(SOURCE), false);
  capabilities.readHelp = () => '--model <model>';
  assert.throws(() => build('test-prefix', 'codeagent', opts, f.cwd, {}, { configDir: f.configDir, command: 'not-executed' }),
    { code: 'CODEAGENT_PREFIX_RESUME_UNSUPPORTED' });
  fs.unlinkSync(result.session.transcriptPath);
  assert.throws(() => build('test-prefix', 'codeagent', opts, f.cwd, {}, { configDir: f.configDir, command: 'not-executed' }),
    { code: 'CODEAGENT_PREFIX_HISTORY_MISSING' });
});

test('prefix child parses only its own file without inherited flags even on a parser-cache hit', async t => {
  const f = fixture(t), result = await f.invoke(); const files = [];
  const deps = { ...f.parserDeps, transcriptParserService: { parse(_kind, file, opts) {
    files.push(file); return { turns: parseClaudeTranscriptToNativeTurns(file, opts), meta: { cacheHit: true } };
  } } };
  const lineage = require('../core/claude-transcript-lineage'), original = lineage.ancestorTranscripts;
  lineage.ancestorTranscripts = () => { throw new Error('ancestor must not be read'); };
  t.after(() => { lineage.ancestorTranscripts = original; });
  const parsed = await parseSessionTranscript({ hubSessionId: result.session.id, opts: { limit: 100, fromTail: true } }, deps);
  assert.equal(parsed.error, null); assert.equal(parsed.parseCacheHit, true);
  assert.deepEqual(files, [result.session.transcriptPath]);
  assert.deepEqual(parsed.turns.map(turn => turn.role), ['user', 'assistant']);
  assert.ok(parsed.turns.every(turn => !turn.inherited && !turn.inheritedFrom));
  assert.equal(parsed.turns.some(turn => turn.text.includes('456')), false);
});

test('selected first/middle reply retains that entire round; last reply seeds the complete record', async t => {
  const f = fixture(t), original = fs.readFileSync(f.file);
  const first = await f.invoke(U2);
  assert.deepEqual(first.session.codeagentPrefixFork.prefixUserUuids, [U1]);
  const middle = await f.invoke(U3);
  assert.deepEqual(middle.session.codeagentPrefixFork.prefixUserUuids, [U1, U2]);
  const rows = JSON.parse('[' + fs.readFileSync(middle.session.transcriptPath, 'utf8').trim().split('\n').join(',') + ']');
  assert.deepEqual(rows.map(row => row.uuid), [U1, A1, U2, A2]);
  const last = await f.handlers.get('session:fork-before-turn')(null, { sourceSessionId: HUB, replyId: U3 + ':assistant' });
  assert.equal(last.ok, true); assert.equal(f.calls.at(-1).opts.forkCCSessionId, undefined);
  assert.equal(last.session.codeagentPrefixFork.cutUserUuid, null);
  assert.deepEqual(fs.readFileSync(last.session.transcriptPath, 'utf8').trim().split('\n').map(JSON.parse),
    f.rows.map(row => ({ ...row, sessionId: last.session.ccSessionId })));
  assert.deepEqual(fs.readFileSync(f.file), original);
});

test('msg_ child histories remain single and branchable after a new reply, restart, and branching again', async t => {
  const { displayChatTurns } = require('../renderer/simple-chat-display');
  for (const selected of [0, 2]) {
    const f = sleepingFixture(t), original = fs.readFileSync(f.file), reads = [];
    const created = await f.fork(selected); assert.equal(created.ok, true);
    const child = created.session, retained = selected + 1;
    const deps = { ...f.parserDeps, getPersistedSessions: () => f.saved, transcriptParserService: { parse(_kind, file, opts) {
      reads.push(file); return { turns: parseClaudeTranscriptToNativeTurns(file, opts), meta: { cacheHit: true } };
    } } };
    const check = async rounds => {
      reads.length = 0;
      // Even a stale parent path from the renderer cannot override the child.
      const parsed = await parseSessionTranscript({ hubSessionId: child.id, kind: 'codeagent',
        transcriptPath: f.file, ccSessionId: SOURCE, opts: { limit: 100 } }, deps);
      assert.equal(parsed.error, null); assert.deepEqual(reads, [child.transcriptPath]);
      assert.equal(parsed.turns.length, rounds * 2);
      assert.equal(new Set(parsed.turns.map(turn => turn.id)).size, rounds * 2);
      assert.ok(parsed.turns.every(turn => !turn.inherited && !turn.inheritedFrom && turn.source === 'claude-transcript'));
      const replies = displayChatTurns(parsed.turns).filter(turn => turn.role === 'assistant' && turn.deliveryContext);
      assert.equal(replies.length, rounds);
      assert.ok(replies.every(turn => branchAction(turn, { ...child, status: 'idle' })));
    };
    await check(retained);
    const userId = 'msg_' + 'a'.repeat(48), replyId = 'msg_' + 'b'.repeat(48);
    const existing = fs.readFileSync(child.transcriptPath, 'utf8').trim().split('\n').map(JSON.parse);
    fs.appendFileSync(child.transcriptPath, [
      { type: 'user', uuid: userId, parentUuid: existing.at(-1).uuid, sessionId: child.ccSessionId, cwd: f.cwd,
        timestamp: stamp(20), message: { role: 'user', content: 'synthetic new input' } },
      { type: 'assistant', uuid: replyId, parentUuid: userId, sessionId: child.ccSessionId, cwd: f.cwd,
        timestamp: stamp(21), message: { role: 'assistant', id: replyId, content: [{ type: 'text', text: 'synthetic new reply' }], stop_reason: 'end_turn' } },
    ].map(JSON.stringify).join('\n') + '\n');
    await check(retained + 1);
    f.saved.push(JSON.parse(JSON.stringify({ ...child, hubId: child.id, status: 'dormant' })));
    f.live.delete(child.id); await check(retained + 1);
    f.manager._openOwners = () => ({ owner: () => null, claim: () => ({}), release() {} });
    const again = await f.handlers.get('session:fork-before-turn')(null, { sourceSessionId: child.id,
      replyId: f.rows[0].uuid + ':assistant' });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.session.codeagentPrefixFork.sourceSessionId, child.id);
    assert.equal(again.session.codeagentPrefixFork.sourceNativeSessionId, child.ccSessionId);
    assert.equal(fs.readFileSync(again.session.transcriptPath, 'utf8').trim().split('\n').length, 2);
    assert.deepEqual(fs.readFileSync(f.file), original);
  }
});

test('full-record reply branches retain validation and cleanup; a null cut cannot bypass reply resolution', async t => {
  for (const reason of ['unpaired-tool', 'sidecar-unknown-content', 'ambiguous-reply', 'create-failed']) {
    const f = fixture(t), original = fs.readFileSync(f.file);
    if (reason === 'unpaired-tool') f.rows.at(-1).message.content.push({ type: 'tool_use', id: 'unanswered', name: 'Read' });
    if (reason === 'ambiguous-reply') f.rows.at(-1).uuid = A1;
    if (reason === 'sidecar-unknown-content') fs.mkdirSync(f.file.slice(0, -6) + '/unknown', { recursive: true });
    if (reason === 'create-failed') f.manager.createSession = () => { throw Error('synthetic create failure'); };
    f.write();
    const result = await f.handlers.get('session:fork-before-turn')(null, { sourceSessionId: HUB, replyId: U3 + ':assistant' });
    assert.equal(result.reason, reason === 'create-failed' ? 'prefix-fork-failed' : reason);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)).filter(name => name.endsWith('.jsonl')), [SOURCE + '.jsonl']);
    if (reason === 'create-failed') assert.deepEqual(fs.readFileSync(f.file), original);
  }
  const f = fixture(t), { forkClaudePrefix } = require('../core/claude-prefix-fork');
  const options = { sourceFile: f.file, configDir: f.configDir, cwd: f.cwd, cutUserUuid: null };
  assert.equal(forkClaudePrefix(options).reason, 'invalid-options');
  assert.equal(forkClaudePrefix({ ...options, replyId: U1 + ':assistant' }).reason, 'ambiguous-cut');
});

test('ordinary tools fork retains its native fork and inherited history presentation', async t => {
  const f = fixture(t), handlers = new Map();
  f.rows.forEach((row, index) => { if (row.type === 'assistant') row.message.content[0].text = 'distinct answer ' + index; }); f.write();
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: f.manager, dataDir: f.dataDir, prefixEnabled: () => true, sendToRenderer() {}, getPersistedSessions: () => [] });
  const result = await handlers.get('fork-session')(null, { sourceSessionId: HUB });
  assert.equal(result.ok, true); assert.equal(f.calls[0].opts.forkCCSessionId, SOURCE);
  assert.equal(result.session.codeagentPrefixFork, undefined); assert.equal(f.calls[0].opts.resumeCCSessionId, undefined);
  const parsed = await parseSessionTranscript({ hubSessionId: result.session.id, opts: { limit: 100 } }, f.parserDeps);
  assert.equal(parsed.error, null); assert.equal(parsed.turns.length, 6);
  assert.ok(parsed.turns.every(turn => turn.inherited && turn.id.startsWith('branch-inherited:')));
});

test('card branch titles retain the entire current parent title and sibling numbers survive restart', async t => {
  const f = fixture(t), saved = [], handlers = new Map(); f.source.title = '你好';
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: f.manager, dataDir: f.dataDir, prefixEnabled: () => true, sendToRenderer() {}, getPersistedSessions: () => saved });
  const create = parent => handlers.get('session:fork-before-turn')(null, { sourceSessionId: parent.id, replyId: U3 + ':assistant' });
  const parent = (await create(f.source)).session;
  assert.equal(parent.title, '分支1: 你好'); assert.equal(parent.branchIndex, 1);
  const nested = (await create(parent)).session;
  assert.equal(nested.title, '分支1: 分支1: 你好'); assert.equal(nested.branchIndex, 1);
  saved.push(...[parent, nested].map(s => ({ ...s, hubId: s.id })));
  f.live.delete(nested.id);
  require('../core/branch-session-titles').healPersistedBranchSessionTitles({ sessions: saved });
  assert.equal(saved[1].title, '分支1: 分支1: 你好');
  const next = (await create(parent)).session;
  assert.equal(next.title, '分支2: 分支1: 你好'); assert.equal(next.branchIndex, 2);
  parent.title = '分支1: 已改标题';
  assert.equal((await create(parent)).session.title, '分支3: 分支1: 已改标题');
  const ordinary = await handlers.get('fork-session')(null, { sourceSessionId: parent.id });
  assert.equal(ordinary.session.title, '分支4: 已改标题'); // Existing tools fork still strips its source prefix.
});

test('Main rejects user/partial reply IDs and ignores fabricated frontend cut/pagination', async t => {
  const f = fixture(t), handler = f.handlers.get('session:fork-before-turn');
  for (const replyId of [U1, A1, U1 + ':message:invented']) {
    assert.equal((await handler(null, { sourceSessionId: HUB, replyId })).reason, 'reply-not-found');
  }
  const result = await handler(null, { sourceSessionId: HUB, replyId: U1 + ':assistant', cutUserUuid: U3, isLast: true, turns: [] });
  assert.equal(result.session.codeagentPrefixFork.cutUserUuid, U2);
});

test('unknown sidecar contents block prefix with entry-name diagnostics, never copied or modified', async t => {
  const f = fixture(t), directory = f.file.replace(/\.jsonl$/, '');
  fs.mkdirSync(path.join(directory, 'model-io'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'observability'));
  const extra = path.join(directory, 'unknown.json'); fs.writeFileSync(extra, 'private sentinel');
  const result = await f.invoke(); assert.equal(result.reason, 'sidecar-unknown-content');
  assert.equal(f.calls.length, 0); assert.equal(fs.readFileSync(extra, 'utf8'), 'private sentinel');
  const raw = fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8');
  const log = JSON.parse(raw); assert.equal(log.recordLines, 6);
  assert.deepEqual(log.recordTypes, { user: 3, assistant: 3 });
  assert.equal(log.hasSubtasks, false); assert.equal(log.hasQueuedMessages, false); assert.equal(log.hasCompaction, false);
  assert.equal(raw.includes('private sentinel'), false); assert.equal(raw.includes('记住甲'), false);
  assert.deepEqual(log.sidecar.entries, ['model-io', 'observability', 'unknown.json']);
  assert.equal(log.sidecar.copied, false);
});

test('known model-io and observability directories permit JSONL-only prefix without changing source bytes or mtime', async t => {
  const f = fixture(t), directory = f.file.replace(/\.jsonl$/, '');
  const files = ['model-io/model-io-0.jsonl', 'model-io/model-io-1.jsonl', 'observability/obs.jsonl'];
  for (const name of files) {
    const filename = path.join(directory, name); fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, 'private payload sentinel');
  }
  const paths = [f.file, directory, path.join(directory, 'model-io'), path.join(directory, 'observability'), ...files.map(name => path.join(directory, name))];
  const before = paths.map(filename => ({ filename, mtime: fs.statSync(filename).mtimeMs,
    hash: fs.statSync(filename).isFile() ? require('crypto').createHash('sha256').update(fs.readFileSync(filename)).digest('hex') : null }));
  const result = await f.invoke(); assert.equal(result.ok, true);
  assert.equal(fs.existsSync(result.session.transcriptPath.replace(/\.jsonl$/, '')), false);
  for (const entry of before) {
    assert.equal(fs.statSync(entry.filename).mtimeMs, entry.mtime);
    if (entry.hash) assert.equal(require('crypto').createHash('sha256').update(fs.readFileSync(entry.filename)).digest('hex'), entry.hash);
  }
  const raw = fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8');
  const log = JSON.parse(raw);
  assert.deepEqual(log.sidecar.entries, ['model-io', 'observability', ...files]);
  assert.equal(log.sidecar.ok, true); assert.equal(log.sidecar.inspected, true); assert.equal(log.sidecar.copied, false);
  assert.equal(raw.includes('private payload sentinel'), false);
});

test('unknown root entries are refused with names and one unknown-content reason', async t => {
  for (const [name, reason] of [['unknown.jsonl', 'sidecar-unknown-content'], ['subagents', 'sidecar-unknown-content']]) {
    const f = fixture(t), directory = f.file.replace(/\.jsonl$/, ''), filename = path.join(directory, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, 'secret body');
    const result = await f.invoke(); assert.equal(result.reason, reason, name); assert.equal(f.calls.length, 0);
    const log = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8'));
    assert.ok(log.sidecar.entries.includes(name)); assert.equal(log.sidecar.copied, false);
    assert.equal(JSON.stringify(log).includes('secret body'), false);
  }
});

test('subagents directories allow cuts before and after paired Task/Agent calls without copying details', async t => {
  for (const toolName of ['Task', 'Agent']) {
    const f = sleepingFixture(t), directory = f.file.slice(0, -6);
    const userId = f.rows[2].uuid, answerId = f.rows[3].uuid;
    f.rows[3].message.content.push({ type: 'tool_use', id: 'agent-call', name: toolName, input: {} });
    f.rows[3].message.stop_reason = 'tool_use';
    const resultId = 'msg_' + 'a'.repeat(48), finalId = 'msg_' + 'b'.repeat(48);
    f.rows.splice(4, 0,
      { ...f.rows[2], uuid: resultId, parentUuid: answerId, agentId: 'synthetic-agent',
        message: { content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'synthetic tool result' }] } },
      { ...f.rows[3], uuid: finalId, parentUuid: resultId,
        message: { id: 'agent-final', content: [{ type: 'text', text: '工具完成后的正文' }], stop_reason: 'end_turn' } });
    f.rows[6].parentUuid = finalId; f.write();
    const files = ['model-io/model-io-0.jsonl', 'observability/obs.jsonl',
      'SuBaGeNtS/agent-one.jsonl', 'SuBaGeNtS/nested/deeper/metadata.bin'];
    for (const name of files) {
      fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
      fs.writeFileSync(path.join(directory, name), 'private subagent payload');
    }
    const sourcePaths = [f.file, ...files.map(name => path.join(directory, name))];
    const before = sourcePaths.map(file => ({ file, bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs }));
    for (const index of [0, 1, 2]) {
      const result = await f.fork(index); assert.equal(result.ok, true, JSON.stringify(result));
      const kept = fs.readFileSync(result.session.transcriptPath, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(kept.length, [2, 6, 8][index]);
      assert.equal(kept.some(row => row.uuid === userId), index !== 0);
      assert.equal(fs.existsSync(result.session.transcriptPath.slice(0, -6)), false);
      const raw = fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8');
      const log = JSON.parse(raw.trim().split('\n').at(-1));
      assert.equal(log.prefixHasTaskToolUse, index !== 0); assert.equal(log.hasSidechain, false);
      assert.equal(log.sidecar.hasSubagents, true); assert.equal(log.sidecar.copied, false);
      assert.ok(log.sidecar.entries.includes('SuBaGeNtS/nested/deeper/metadata.bin'));
      assert.equal(raw.includes('private subagent payload'), false);
    }
    for (const entry of before) {
      assert.deepEqual(fs.readFileSync(entry.file), entry.bytes); assert.equal(fs.statSync(entry.file).mtimeMs, entry.mtime);
    }
    f.rows[4].message.content[0].tool_use_id = 'missing-call'; f.write();
    assert.equal((await f.fork(1)).reason, 'unpaired-tool');
  }
});

test('subagents inspection never opens payloads or follows nested directory links', t => {
  const f = fixture(t), directory = f.file.slice(0, -6), nested = path.join(directory, 'subagents', 'nested');
  fs.mkdirSync(nested, { recursive: true }); fs.writeFileSync(path.join(nested, 'anything.tmp'), 'secret');
  const { inspectSiblingDirectory } = require('../core/claude-prefix-fork');
  const noRead = { ...fs, openSync() { throw Error('must not open'); }, readFileSync() { throw Error('must not read'); } };
  assert.equal(inspectSiblingDirectory(f.file, { fsModule: noRead }).ok, true);
  let followed = false;
  const linked = inspectSiblingDirectory(f.file, { fsModule: { ...noRead,
    lstatSync: file => file === nested ? { isSymbolicLink: () => true } : fs.lstatSync(file),
    readdirSync: file => { if (file === nested) { followed = true; throw Error('followed'); } return fs.readdirSync(file); },
  } });
  assert.equal(linked.reason, 'sidecar-unknown-content'); assert.equal(followed, false);
});

test('sidecar inspection checks directories and files without reading payloads, refuses unreadable and linked entries', async t => {
  const f = fixture(t), directory = f.file.replace(/\.jsonl$/, ''), filename = path.join(directory, 'model-io/model-io-0.jsonl');
  fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, 'secret');
  const { inspectSiblingDirectory } = require('../core/claude-prefix-fork');
  const deny = () => { throw Object.assign(new Error('private account detail'), { code: 'EACCES' }); };
  const noRead = { ...fs, openSync: deny, readFileSync() { throw new Error('must never read sidecar payload'); } };
  assert.equal(inspectSiblingDirectory(f.file, { fsModule: noRead }).ok, true);
  for (const fsModule of [{ ...noRead, readdirSync: deny },
    { ...noRead, readdirSync: value => value === directory ? ['model-io'] : deny() }]) {
    const result = inspectSiblingDirectory(f.file, { fsModule });
    assert.equal(result.reason, 'sidecar-unreadable'); assert.equal(result.inspected, false);
    assert.equal(JSON.stringify(result).includes('private account'), false);
  }
  const linked = inspectSiblingDirectory(f.file, { fsModule: { ...noRead, lstatSync: value => value === filename
    ? { isFile: () => true, isSymbolicLink: () => true } : fs.lstatSync(value) } });
  assert.equal(linked.reason, 'sidecar-unknown-content');
});

test('subtask records block both historical and full-record prefixes even with known-only sidecars', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.file.replace(/\.jsonl$/, '') + '/observability', { recursive: true });
  f.rows.splice(2, 0, { type: 'assistant', uuid: randomUUID(), sessionId: SOURCE, isSidechain: true,
    message: { content: [{ type: 'text', text: 'private subtask' }] } }); f.write();
  assert.equal((await f.invoke()).reason, 'unsupported-sidechain'); assert.equal(f.calls.length, 0);
  const log = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8'));
  assert.equal(log.hasSubtasks, true); assert.equal(log.sidecar.copied, false);
  const last = await f.handlers.get('session:fork-before-turn')(null, { sourceSessionId: HUB, replyId: U3 + ':assistant' });
  assert.equal(last.reason, 'unsupported-sidechain'); assert.equal(f.calls.length, 0);
});

test('diagnostics count invalid lines and task/queue/compact flags without payloads', () => {
  const { transcriptStats } = require('../core/claude-prefix-fork');
  const stats = transcriptStats([{ type: 'assistant', agentId: 'secret', message: { content: [{ type: 'tool_use', name: 'Task' }] } },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: 'secret' } },
    { type: 'system', subtype: 'compact_boundary' }, { type: 'private-secret' }]);
  assert.equal(stats.hasSubtasks, true); assert.equal(stats.hasQueuedMessages, true); assert.equal(stats.hasCompaction, true);
  assert.equal(JSON.stringify(stats).includes('secret'), false); assert.equal(stats.recordTypes.other, 1);
});

test('local, synthetic and queued user rows are exclusive cuts even when no later ordinary turn exists', async t => {
  for (const [content, extra, type] of [['/model', {}, 'local-command'], ['hidden', { isMeta: true }, 'synthetic-user'],
    ['queued', { isQueuedSupplement: true }, 'queued-message'], ['', {}, 'user']]) {
    const f = fixture(t); f.rows.splice(2); f.rows.push({ type: 'user', uuid: U2, sessionId: SOURCE,
      message: { content }, ...extra }); f.write();
    const result = await f.invoke(); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.calls[0].opts.forkCCSessionId, undefined);
    assert.equal(result.session.codeagentPrefixFork.cutUserUuid, U2);
    assert.equal(fs.readFileSync(result.session.transcriptPath, 'utf8').trim().split('\n').length, 2);
    const log = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8'));
    assert.equal(log.cutLineType, type);
  }
});

test('queued attachment is a cut, missing/duplicate UUID never becomes ordinary fork', async t => {
  for (const uuid of [U2, null, U1]) {
    const f = fixture(t); f.rows.splice(2); f.rows.push({ type: 'attachment', uuid, sessionId: SOURCE,
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'queued', source_uuid: U2 } }); f.write();
    const result = await f.invoke();
    if (uuid === U2) { assert.equal(result.ok, true); assert.equal(result.session.codeagentPrefixFork.cutUserUuid, U2); }
    else { assert.equal(result.reason, 'ambiguous-cut'); assert.equal(f.calls.length, 0); }
  }
  const f = fixture(t); delete f.rows[2].uuid; f.write();
  assert.equal((await f.invoke()).reason, 'ambiguous-cut'); assert.equal(f.calls.length, 0);
});

test('only retained prefix contributes subtask rejection; parent_tool_use_id alone is not a subtask', async t => {
  const f = fixture(t);
  f.rows[1].parent_tool_use_id = 'ordinary-tool-parent';
  f.rows[5].message.content.push({ type: 'tool_use', id: 'future-task', name: 'Task' }); f.write();
  assert.equal((await f.invoke()).ok, true);
  const log = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8'));
  assert.equal(log.hasSubtasks, true); assert.equal(log.prefixHasSubtasks, false);
});

test('paired main-chain tools with agent IDs and task markers are diagnostic-only; unpaired tools still refuse', async t => {
  // Mirrors the reviewed native shape: a main-chain user tool_result carries
  // agentId. All identities and payloads here are synthetic.
  for (const [name, field] of [['WebFetch', 'agentId'], ['Task', 'agent_id'], ['Agent', 'agentId']]) {
    const f = fixture(t), resultId = randomUUID();
    f.rows[1].message.content.push({ type: 'tool_use', id: 'paired-call', name, input: {} });
    f.rows.splice(2, 0, { type: 'user', uuid: resultId, parentUuid: A1, sessionId: SOURCE,
      isSidechain: false, [field]: 'private-agent-id', origin: { kind: 'task-notification' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'paired-call', content: 'synthetic result' }] } });
    f.write(); const before = fs.readFileSync(f.file);
    const result = await f.invoke(); assert.equal(result.ok, true, JSON.stringify(result));
    const kept = fs.readFileSync(result.session.transcriptPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(kept.length, 3); assert.equal(kept.at(-1).uuid, resultId);
    assert.equal(result.session.codeagentPrefixFork.cutUserUuid, U2);
    const log = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8'));
    assert.equal(log.prefixHasSubtasks, true); assert.equal(log.prefixHasSidechain, false);
    assert.equal(log.hasAgentId, true); assert.equal(log.hasSidechain, false);
    assert.equal(log.hasOriginKind, true); assert.equal(log.hasTaskNotification, true);
    assert.equal(log.hasTaskToolUse, name !== 'WebFetch');
    assert.equal(JSON.stringify(log).includes('private-agent-id'), false);
    assert.deepEqual(fs.readFileSync(f.file), before);
    f.rows[2].message.content[0].tool_use_id = 'missing-call'; f.write();
    assert.equal((await f.invoke()).reason, 'unpaired-tool');
  }
});

test('sidechain users and queued attachments are not cut points; retained sidechains still refuse', async t => {
  const { resolveAfterReply, transcriptStats } = require('../core/claude-prefix-fork');
  for (const row of [
    { type: 'user', message: { content: 'sidechain input' } },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: 'sidechain input' } },
  ]) {
    const f = fixture(t);
    // A missing UUID on a sidechain row must not hide the real main-chain cut.
    f.rows.splice(2, 0, { ...row, sessionId: SOURCE, isSidechain: true });
    assert.equal(resolveAfterReply(f.rows, U1 + ':assistant').cutUserUuid, U2);
    f.write(); assert.equal((await f.invoke()).reason, 'unsupported-sidechain');
    const log = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8'));
    assert.equal(log.cutUserUuid, U2); assert.equal(log.prefixHasSidechain, true);
    // With no later main-chain user, this is genuinely the last round.
    assert.equal(resolveAfterReply(f.rows.slice(0, 3), U1 + ':assistant').cutUserUuid, null);
    delete f.rows[3].uuid;
    assert.equal(resolveAfterReply(f.rows, U1 + ':assistant').reason, 'ambiguous-cut');
  }
  for (const isSidechain of [false, 'true', 1, undefined]) {
    assert.equal(transcriptStats([{ type: 'system', isSidechain }]).hasSidechain, false);
  }
});

test('case-insensitive known directories allow arbitrary ordinary files, reject nested directories', async t => {
  const f = fixture(t), dir = f.file.replace(/\.jsonl$/, '');
  for (const name of ['Model-IO/tasks.log', 'Model-IO/record.jsonl.1', 'Observability/obs.lock']) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), 'private');
  }
  assert.equal((await f.invoke()).ok, true);
  fs.mkdirSync(path.join(dir, 'Model-IO/nested'));
  assert.equal((await f.invoke()).reason, 'sidecar-unknown-content');
});

test('post-copy seed read and createSession failures clean only the new file; cleanup failure is explicit', async t => {
  for (const mode of ['seed-read', 'create', 'cleanup']) {
    let source;
    const f = fixture(t, { deps: { prefixFs: { ...fs,
      openSync(file, flag, ...rest) {
        if (mode === 'seed-read' && file !== source && flag === 'r') throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return fs.openSync(file, flag, ...rest);
      }, unlinkSync(file) { if (mode === 'cleanup') throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.unlinkSync(file); }
    } } }); source = f.file;
    const before = fs.readFileSync(source);
    if (mode !== 'seed-read') f.manager.createSession = () => { throw new Error('synthetic startup failure'); };
    const result = await f.invoke(); assert.equal(result.ok, false);
    const log = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8'));
    assert.equal(log.preparedFileState, mode === 'cleanup' ? 'retained' : 'removed');
    assert.equal(fs.existsSync(path.join(path.dirname(source), log.newSessionId + '.jsonl')), mode === 'cleanup');
    if (mode === 'cleanup') { assert.equal(result.reason, 'cleanup-failed'); assert.ok(result.message.includes(log.newSessionId)); }
    assert.deepEqual(fs.readFileSync(source), before);
  }
});

test('off/busy/wrong-kind client requests never read records or scan directories', async t => {
  const deny = () => { throw new Error('unexpected file IO'); };
  for (const mode of ['off', 'busy', 'wrong-kind']) {
    let calls = 0;
    const f = fixture(t, { deps: { prefixEnabled: () => mode !== 'off', prefixFs: new Proxy(fs, {
      get(target, key) { if (['openSync', 'readFileSync', 'statSync', 'lstatSync', 'readdirSync'].includes(key)) return () => { calls++; deny(); }; return target[key]; }
    }) } });
    if (mode === 'busy') f.source.status = 'running';
    if (mode === 'wrong-kind') f.source.kind = 'claude';
    assert.equal((await f.invoke()).ok, false);
    assert.equal(f.handlers.get('session:prefix-fork-client-failed')(null, { sourceSessionId: HUB }).ok, false);
    assert.equal(calls, 0);
    const logs = fs.readFileSync(path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(logs.every(log => log.readSkipped));
  }
});

test('oversized records reject before payload reads and diagnostic fallback is bounded', async t => {
  const f = fixture(t), { MAX_TRANSCRIPT_BYTES, readStableTranscript, diagnosticStats } = require('../core/claude-prefix-fork');
  fs.truncateSync(f.file, MAX_TRANSCRIPT_BYTES + 1);
  const result = readStableTranscript(f.file, { fsModule: { ...fs, readFileSync() { throw new Error('must not read'); } } });
  assert.equal(result.reason, 'source-too-large');
  assert.equal(diagnosticStats(f.file).readSkipped, 'source-too-large');
  assert.equal((await f.invoke()).reason, 'source-too-large');
});

test('renderer logicalTurnId matches Main; merged cards spanning a user boundary refuse rather than swallow it', async t => {
  const f = fixture(t), { claudeDiskRecords } = require('../core/claude-disk-transcript');
  const { claudeTranscriptTurns } = require('../core/claude-native-transcript');
  const { displayChatTurns } = require('../renderer/simple-chat-display');
  const { resolveAfterReply } = require('../core/claude-prefix-fork');
  const taskId = randomUUID(), answerId = randomUUID();
  f.rows.splice(2, 0, { ...f.rows[0], uuid: taskId, timestamp: stamp(2.2), origin: { kind: 'task-notification' },
    message: { content: '<task-notification>synthetic completion</task-notification>' } },
  { ...f.rows[1], uuid: answerId, parentUuid: taskId, timestamp: stamp(2.3),
    message: { ...f.rows[1].message, id: 'continued', content: [{ type: 'text', text: 'continued answer' }] } });
  const projected = claudeTranscriptTurns(claudeDiskRecords(f.rows, { codeagent: true }));
  const cards = displayChatTurns(projected.map(turn => ({ ...turn, source: 'claude-transcript' })));
  const selected = cards.find(turn => turn.role === 'assistant' && turn.logicalTurnId === U1 + ':assistant');
  assert.ok(selected.replySegments.length >= 2);
  const action = branchAction(selected, f.source); assert.ok(projected.some(card => card.id === action.replyId));
  assert.equal(resolveAfterReply(f.rows, action.replyId).reason, 'ambiguous-reply');
  f.write(); assert.equal((await f.invoke()).reason, 'ambiguous-reply');
});

test('multiple body frames and tool results preserve the final reply; partial pages cannot expose earlier bodies', async t => {
  const f = fixture(t), { claudeDiskRecords } = require('../core/claude-disk-transcript');
  const { claudeTranscriptTurns } = require('../core/claude-native-transcript');
  const { displayTurns } = require('../core/conversation-display');
  const nextBody = { ...f.rows[1], uuid: randomUUID(), parentUuid: A1,
    message: { ...f.rows[1].message, id: 'next-body', content: [{ type: 'text', text: 'second body' }] } };
  f.rows.splice(2, 0, nextBody);
  f.rows[3].parentUuid = nextBody.uuid;
  // A tool result after the body is not a new user boundary.
  nextBody.message.content.push({ type: 'tool_use', id: 'read-one', name: 'Read' });
  f.rows.splice(3, 0, { type: 'user', uuid: randomUUID(), parentUuid: nextBody.uuid, sessionId: SOURCE,
    message: { content: [{ type: 'tool_result', tool_use_id: 'read-one', content: 'result' }] } });
  const cards = displayTurns(claudeTranscriptTurns(claudeDiskRecords(f.rows, { codeagent: true })));
  const bodies = cards.filter(card => card.logicalTurnId === U1 + ':assistant' && card.text);
  assert.equal(bodies.length, 2);
  assert.equal(branchAction(bodies[0], f.source), null); // Even when it is the only card on the page.
  assert.equal(branchAction(bodies[1], f.source).replyId, U1 + ':assistant');
  f.write(); const result = await f.invoke(); assert.equal(result.ok, true);
  const kept = fs.readFileSync(result.session.transcriptPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(kept.length, 4); assert.equal(kept.at(-1).message.content[0].type, 'tool_result');
});

test('hidden inputs followed by absorbed answers cannot move the cut past those inputs', async t => {
  for (const [content, extra] of [['/model', {}], ['hidden', { isMeta: true }], ['queued', { isQueuedSupplement: true }]]) {
    const f = fixture(t); f.rows[2].message.content = content; Object.assign(f.rows[2], extra); f.write();
    const result = await f.invoke();
    if (result.ok) {
      assert.equal(result.session.codeagentPrefixFork.cutUserUuid, U2);
      assert.equal(fs.readFileSync(result.session.transcriptPath, 'utf8').trim().split('\n').length, 2);
    } else { assert.equal(result.reason, 'ambiguous-reply'); assert.equal(f.calls.length, 0); }
  }
});

test('malformed records produce counts without leaking bodies; ordinary fork errors are diagnosed', async t => {
  const f = fixture(t), handler = f.handlers.get('session:fork-before-turn');
  fs.appendFileSync(f.file, '{unfinished-private-prompt\n');
  assert.equal((await f.invoke()).reason, 'incomplete-json');
  const filename = path.join(f.dataDir, 'diagnostics/codeagent-prefix-fork.jsonl');
  let log = JSON.parse(fs.readFileSync(filename, 'utf8').trim().split('\n').at(-1));
  assert.equal(log.recordLines, 7); assert.equal(log.invalidLines, 1); assert.equal(log.metadataComplete, false);
  assert.equal(JSON.stringify(log).includes('unfinished-private'), false);
  f.write(); f.manager.createSession = () => { throw new Error('private failure detail'); };
  assert.equal((await handler(null, { sourceSessionId: HUB, replyId: U3 + ':assistant' })).reason, 'prefix-fork-failed');
  log = JSON.parse(fs.readFileSync(filename, 'utf8').trim().split('\n').at(-1));
  assert.equal(log.recordLines, 6); assert.equal(JSON.stringify(log).includes('private failure'), false);
});

test('prefix config defaults on; unrelated IPC saves preserve absent/false keys and experiments', async t => {
  const f = fixture(t), config = require('../core/hub-config');
  const prev = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = f.dataDir;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; config.clearConfigCache(); });
  config.clearConfigCache(); assert.equal(config.getConfig().codeagentPrefixBranch, true);
  const { registerConfigIpc, toEditableConfig, toMaskedConfig } = require('../main/ipc/config-handlers');
  const saves = new Map();
  registerConfigIpc({ handle: (key, fn) => saves.set(key, fn) }, { clearSessionManagerConfigCache() {} });
  for (const raw of [{}, { experiments: { another: 'keep' } },
    { experiments: { codeagentPrefixBranch: false, another: 'keep' } }]) {
    config.saveConfig(raw);
    const expected = raw.experiments?.codeagentPrefixBranch !== false;
    assert.equal(config.getConfig().codeagentPrefixBranch, expected);
    assert.equal(toEditableConfig(config.getConfig()).codeagentPrefixBranch, expected);
    assert.equal(toMaskedConfig(config.getConfig()).codeagentPrefixBranch, expected);
    assert.equal(saves.get('save-hub-config')(null, { proxy: 'http://localhost:1', codeagentPrefixBranch: !expected }).success, true);
    const disk = JSON.parse(fs.readFileSync(config.getConfigPath(), 'utf8'));
    assert.deepEqual(disk.experiments, raw.experiments);
    assert.equal(Object.hasOwn(disk, 'codeagentPrefixBranch'), false);
  }
  const handlers = new Map();
  registerPrefixForkIpc({ handle: (key, fn) => handlers.set(key, fn) }, { sessionManager: f.manager, dataDir: f.dataDir, sendToRenderer() {} });
  const result = await handlers.get('session:fork-before-turn')(null, { sourceSessionId: HUB, replyId: U1 + ':assistant' });
  assert.equal(result.reason, 'experiment-disabled'); assert.equal(f.calls.length, 0);
  for (const value of [undefined, null, true, 0, '', 'false', {}, []]) {
    config.saveConfig({ experiments: { codeagentPrefixBranch: value } });
    assert.equal(config.getConfig().codeagentPrefixBranch, true);
    assert.equal((await handlers.get('session:fork-before-turn')(null, { sourceSessionId: HUB, replyId: U1 + ':assistant' })).ok, true);
  }
});

test('Main and renderer use default-on gates even for null config; false hides the actual menu', async t => {
  const config = require('../core/hub-config'), original = config.getConfig;
  t.after(() => { config.getConfig = original; setEnabled(true); });
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const callback = source.match(/\.then\(config => \{([\s\S]*?)\n  \}\)/)[1];
  const vm = require('node:vm');
  const f = fixture(t, { deps: { prefixEnabled: undefined } });
  const reply = { id: U1 + ':assistant', userMessageId: U1, role: 'assistant', source: 'claude-transcript', text: '正文' };
  const { toEditableConfig, toMaskedConfig } = require('../main/ipc/config-handlers');
  for (const value of [undefined, null, {}, ...[false, true, 0, '', 'false', {}, []].map(codeagentPrefixBranch => ({ codeagentPrefixBranch }))]) {
    const expected = value?.codeagentPrefixBranch !== false;
    config.getConfig = () => value;
    assert.equal(toEditableConfig(value).codeagentPrefixBranch, expected);
    assert.equal(toMaskedConfig(value).codeagentPrefixBranch, expected);
    vm.runInNewContext(callback, { config: value, require: () => require('../renderer/card-prefix-fork'),
      applyHubCardDisplaySettings: config => require('../renderer/card-display-settings').applyCardDisplaySettings(null, config) });
    const html = renderer(f.source).renderTurnCard(reply, { mainCard: true, sessionId: HUB });
    assert.equal(html.includes('data-action="fork-before-turn"'), expected);
    const result = await f.invoke();
    assert.equal(result.ok, expected);
    if (!expected) assert.equal(result.reason, 'experiment-disabled');
  }
});

test('UI gate excludes user/progress/group/other-provider cards and keeps ordinary actions', async t => {
  const f = fixture(t), reply = { id: U1 + ':assistant', userMessageId: U1, role: 'assistant', source: 'claude-transcript', text: '正文' };
  setEnabled(false);
  assert.equal(branchAction(reply, f.source), null);
  const off = renderer(f.source).renderTurnCard(reply, { mainCard: true, sessionId: HUB });
  assert.doesNotMatch(off, /fork-before-turn/); assert.match(off, /data-action="regen"/);
  setEnabled(true);
  t.after(() => setEnabled(true));
  for (const turn of [{ ...reply, role: 'user' }, { ...reply, phase: 'commentary' }, { ...reply, phase: 'activity' },
    { ...reply, text: '' }, { ...reply, inherited: true }, { ...reply, queuedSupplement: true }]) assert.equal(branchAction(turn, f.source), null);
  assert.equal(branchAction(reply, { ...f.source, kind: 'claude' }), null);
  assert.equal(branchAction(reply, { ...f.source, meetingId: 'group' }), null);
  assert.match(renderer(f.source).renderTurnCard(reply, { mainCard: true, sessionId: HUB }), /文件不会回退，跨会话记忆共享/);
  const calls = [];
  await forkBeforeTurn({ turn: reply, session: f.source, button: { dataset: {} }, invoke: async (channel, payload) => {
    calls.push({ channel, payload }); return { ok: true, session: { id: 'new' } };
  }, notify() {}, selectSession: id => assert.equal(id, 'new') });
  assert.deepEqual(calls, [{ channel: 'session:fork-before-turn', payload: { sourceSessionId: HUB, replyId: reply.id } }]);
});

test('only last body card in each round exposes the entry, running state disables it', async t => {
  const f = fixture(t), turns = new Map();
  const cards = [U1, U1, U2].map((uuid, n) => {
    const id = uuid + ':reply:' + n, button = {};
    turns.set(id, { id, role: 'assistant', text: '正文', source: 'claude-transcript', userMessageId: uuid });
    return { dataset: { sessionId: HUB, turnId: id }, classList: { toggle() {} }, querySelector: () => button, button };
  });
  patchCardActions(cards, turns, () => f.source);
  assert.deepEqual(cards.map(card => card.button.hidden), [true, false, false]);
  f.source.status = 'running'; patchCardActions(cards, turns, () => f.source);
  assert.ok(cards.every(card => card.button.disabled));
});

test('branch is a final-body More option; disabled menus match the mainline markup exactly', t => {
  const f = fixture(t), turn = { id: 'msg_reply', userMessageId: 'msg_user', role: 'assistant',
    text: '正文', source: 'claude-transcript' };
  t.after(() => setEnabled(true));
  const menu = html => html.match(/<details class="card-actions-menu">[\s\S]*?<\/details>/)[0];
  const baseline = '<details class="card-actions-menu"><summary class="card-actions-more" aria-label="更多消息操作">更多</summary>'
    + '<div class="card-actions-popover"><button class="ta-btn ta-multi" data-action="multi-select">多选</button>'
    + '<button class="ta-btn" data-action="regen" title="先查看待重发正文">重新生成…</button></div></details>';
  setEnabled(false);
  assert.equal(menu(renderer(f.source).renderTurnCard(turn, { mainCard: true, sessionId: HUB })), baseline);
  setEnabled(true);
  const on = renderer(f.source).renderTurnCard(turn, { mainCard: true, sessionId: HUB });
  assert.match(menu(on), /class="card-actions-popover">[\s\S]*data-action="fork-before-turn"/);
  assert.doesNotMatch(on.replace(menu(on), ''), /fork-before-turn|prefix-fork-actions/);
  for (const earlier of [{ ...turn, logicalTurnId: 'logical' }, { ...turn, phase: 'commentary' }]) {
    assert.doesNotMatch(renderer(f.source).renderTurnCard(earlier, { mainCard: true, sessionId: HUB }), /fork-before-turn/);
  }
});

function renderer(session, options = {}) {
  const doc = { addEventListener() {}, removeEventListener() {}, getElementById() { return null; }, querySelector() { return null; } };
  return require('../renderer/turn-card-renderer').createTurnCardRenderer({ document: doc, window: { localStorage: { getItem: () => null } },
    state: {}, getSessionContext: () => session, getActiveSessionId: () => session.id,
    normalizeMarkdownPathBreaks: text => text,
    formatAbsoluteTime: () => '', escapeHtml: text => String(text ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    marked: { parse: text => text }, DOMPurify: { sanitize: text => text }, ...options });
}


test('dormant selection executes the original open-status and resume path with either gate', async t => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const start = source.indexOf("  if (session.status === 'dormant') {", source.indexOf('async function selectSession('));
  const end = source.indexOf('  // Reading a reply', start);
  assert.ok(start > 0 && end > start);
  const code = '(async()=>{' + source.slice(start, end) + '})()';
  for (const enabled of [true, false]) {
    setEnabled(enabled);
    const calls = [], session = { id: HUB, kind: 'codeagent', status: 'dormant' };
    const noop = () => {};
    const context = { session, id: HUB, opts: {}, intent: 1, sessionOpenIntent: 1, activeSessionId: HUB,
      targetView: 'card', forceScrollBottom: false, sessions: new Map([[HUB, session]]),
      _pendingDormantResumes: new Map(), paintSidebarResumePending: noop,
      showDormantResumePlaceholder: noop, scheduleSessionListRender: noop,
      acknowledgeSessionFailureState: () => false, schedulePersist: noop,
      ipcRenderer: { send: noop, invoke: async (channel, id) => { calls.push([channel, id]); return { available: true }; } },
      resumeDormantSession: async id => { calls.push(['resume', id]); },
      require: () => { throw Error('Unexpected experimental history open'); }, console };
    await require('node:vm').runInNewContext(code, context);
    assert.deepEqual(calls, [['session:open-status', HUB], ['resume', HUB]]);
  }
  t.after(() => setEnabled(true));
});

test('real dormant Main IPC and real card rendering share full-record and disabled contracts', async t => {
  const f = sleepingFixture(t);
  f.saved[0].status = 'dormant';
  const saved = JSON.stringify(f.saved);
  const reply = { id: f.request(2).replyId, userMessageId: f.rows[4].uuid,
    role: 'assistant', source: 'claude-transcript', text: 'native final reply' };
  const { configureStatus, invalidateStatus } = require('../renderer/card-prefix-fork');
  t.after(() => { configureStatus(null); setEnabled(true); });
  setEnabled(true);
  configureStatus(() => f.status()); invalidateStatus(HUB);
  const dormant = { ...f.saved[0], id: HUB };
  renderer(dormant).renderTurnCard(reply, { mainCard: true, sessionId: HUB });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(renderer(dormant).renderTurnCard(reply, { mainCard: true, sessionId: HUB }), /fork-before-turn/);
  const result = await f.fork(2);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.readFileSync(result.session.transcriptPath, 'utf8').trim().split('\n').length, f.rows.length);
  assert.equal(f.calls.length, 1); assert.notEqual(f.calls[0].opts.id, HUB);
  assert.equal(f.manager.getSession(HUB), undefined); assert.equal(JSON.stringify(f.saved), saved);
  setEnabled(false);
  assert.doesNotMatch(renderer(dormant).renderTurnCard(reply, { mainCard: true, sessionId: HUB }), /fork-before-turn/);
  const off = fixture(t, { deps: { prefixEnabled: () => false } });
  for (const channel of ['session:fork-before-turn', 'session:prefix-fork-status', 'session:prefix-fork-ordinary']) {
    const denied = await off.handlers.get(channel)(null, f.request(2));
    assert.equal(denied.reason, 'experiment-disabled');
  }
});
