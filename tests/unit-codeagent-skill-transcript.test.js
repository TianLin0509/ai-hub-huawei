'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../core/synthetic-user-filter');
const { claudeDiskRecords } = require('../core/claude-disk-transcript');
const { parseClaudeTranscriptEntries } = require('../core/claude-transcript-parser');
const { claudeTranscriptTurns } = require('../core/claude-native-transcript');
const { withQueuedHumanInputs } = require('../core/claude-queued-input');
const { userTextIdentity } = require('../core/conversation-display');
const { isPtyLocalCommand } = require('../core/codeagent-command-policy');

// 脱敏合成样本：复现已核实的两条 isMeta user 结构，路径、标识和正文均为假值。
const NOW = Date.parse('2026-11-02T08:00:00Z');
const wrapper = (args = 'whoami') => '<command-message>git-ai</command-message>\n<command-name>/git-ai</command-name>\n<command-args>' + args + '</command-args>';
const user = (uuid, text, extra = {}) => ({ type: 'user', uuid, timestamp: new Date(NOW).toISOString(), sessionId: 'fixture-native', message: { role: 'user', content: text }, ...extra });
const answer = (uuid, text, parentUuid) => ({ type: 'assistant', uuid, parentUuid, sessionId: 'fixture-native', timestamp: new Date(NOW + 2000).toISOString(),
  message: { id: 'message-' + uuid, role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
function skill(id = 'first', args = 'whoami', parentUuid = null) {
  return [user(id, wrapper(args), { isMeta: true, promptId: 'prompt-' + id, parentUuid }),
    user(id + '-body', 'Base directory for this skill: C:/example/skills/git-ai\nFixture skill instructions', { isMeta: true, promptId: 'prompt-' + id, parentUuid: id }),
    answer(id + '-answer', '回答-' + id, id + '-body')];
}
function fileFixture(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-transcript-')), file = path.join(dir, 'fixture.jsonl');
  fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('disk cards keep a late old reply under its stopped question after a new answer', () => {
  const entries = [user('old', '旧问题'), user('stop', '[Request interrupted by user]', { parentUuid: 'old' }),
    user('next', '新问题'), answer('new-answer', '当前回答', 'next'), answer('late-old', '迟到旧回答', 'old')];
  const records = claudeDiskRecords(entries);
  assert.deepEqual(records.map(r => [r.userMessageId, r.finalText]), [['old', '迟到旧回答'], ['next', '当前回答']]);
  assert.equal(records[0].status, 'interrupted', 'late output cannot erase the explicit stop');
  const cards = claudeTranscriptTurns(records);
  assert.deepEqual(cards.map(c => [c.role, c.text]), [['user', '旧问题'], ['assistant', '迟到旧回答'], ['user', '新问题'], ['assistant', '当前回答']]);
  assert.deepEqual(cards[3].displayMessages.map(m => m.text), ['当前回答']);
});

test('disk ownership follows hidden skill and tool-result chains across a later user', () => {
  const tool = answer('old-tool', '', 'old-body');
  tool.message.content = [{ type: 'tool_use', id: 'old-call', name: 'Read', input: {} }];
  tool.message.stop_reason = 'tool_use';
  const result = user('old-result', '', { parent_uuid: 'old-tool' });
  result.message.content = [{ type: 'tool_result', tool_use_id: 'old-call', content: '旧轮工具结果' }];
  for (const linked of [true, false]) {
    const receipt = { ...result }; if (!linked) delete receipt.parent_uuid;
    const entries = [user('old', wrapper(), { isMeta: true }),
      user('old-body', 'Base directory for this skill: C:/fixture\nInstructions', { isMeta: true, parentUuid: 'old' }),
      tool, user('new', '新问题'), answer('new-answer', '新答案', 'new'), receipt,
      { ...answer('old-final', '旧答案', 'old-result'), parentUuid: undefined, parent_uuid: 'old-result' }];
    const cards = claudeTranscriptTurns(claudeDiskRecords(entries));
    assert.deepEqual(cards.filter(c => c.role === 'assistant').map(c => c.text), ['旧答案', '新答案']);
    assert.equal(cards[1].toolCalls[0].output, '旧轮工具结果');
    assert.equal(cards[1].toolCalls[0].status, 'completed');
    assert.equal(cards[3].toolCalls.length, 0);
  }
});

test('disk queued supplements keep their reply in the original round through attachment UUID aliases', () => {
  const supplement = { type: 'attachment', uuid: 'queued-wire', timestamp: new Date(NOW + 500).toISOString(),
    attachment: { type: 'queued_command', origin: { kind: 'human' }, humanTurn: true, commandMode: 'prompt', source_uuid: 'queued-source', prompt: '补充说明' } };
  const records = claudeDiskRecords([user('old', '旧问题'), supplement, user('new', '新问题'),
    answer('new-answer', '新答案', 'new'), answer('old-answer', '旧轮补充后的答案', 'queued-wire')]);
  assert.deepEqual(records.map(r => r.finalText), ['旧轮补充后的答案', '新答案']);
  assert.equal(records[0].userSupplements[0].text, '补充说明');
  assert.equal(records[1].userSupplements, undefined);
});

test('disk duplicate queued deliveries retain the original owner across changed source UUIDs', () => {
  const queued = (uuid, source) => ({ type: 'attachment', uuid, timestamp: new Date(NOW + 500).toISOString(),
    attachment: { type: 'queued_command', origin: { kind: 'human' }, humanTurn: true, commandMode: 'prompt',
      source_uuid: source, delivery_id: 'same-delivery', prompt: '补充说明' } });
  const records = claudeDiskRecords([user('old', '旧问题'), queued('wire1', 'source1'), user('new', '新问题'),
    answer('new-answer', '新答案', 'new'), queued('wire2', 'source2'), answer('late-old', '旧轮补充后的答案', 'wire2')]);
  assert.deepEqual(records.map(r => r.finalText), ['旧轮补充后的答案', '新答案']);
  assert.equal(records[0].userSupplements.length, 1);
  assert.equal(records[1].userSupplements, undefined);
  const last = claudeTranscriptTurns(records).at(-1);
  assert.deepEqual(last.displayMessages.map(m => m.text), ['新答案']);
  // The second replay can introduce another alias without creating a question.
  const third = queued('wire3', 'source2'); third.attachment.delivery_id = 'later-delivery';
  const chained = claudeDiskRecords([user('old', '旧问题'), queued('wire1', 'source1'), user('new', '新问题'),
    answer('new-answer', '新答案', 'new'), queued('wire2', 'source2'), third, answer('late-old', '旧轮补充后的答案', 'wire3')]);
  assert.deepEqual(chained.map(r => r.finalText), ['旧轮补充后的答案', '新答案']);
});

test('disk linked revisions and repeated UUID snapshots cannot move into the newer question or roll back', () => {
  const revision = answer('revision', '短修订', 'old-answer'); revision.timestamp = new Date(NOW + 4000).toISOString();
  const stale = answer('revision', '迟到但更旧的长草稿', 'old-answer'); stale.timestamp = new Date(NOW + 3000).toISOString();
  stale.message.stop_reason = null;
  const records = claudeDiskRecords([user('old', '旧问题'), answer('old-answer', '初版', 'old'),
    user('new', '新问题'), answer('new-answer', '新答案', 'new'), revision, stale]);
  assert.deepEqual(records.map(r => r.finalText), ['短修订', '新答案']);
  assert.equal(records[0].messages.get('revision').message.content[0].text, '短修订');
  assert.equal(records[0].messages.size, 2);
});

test('disk legacy records without parent links or with unavailable parents retain adjacency', () => {
  const records = claudeDiskRecords([user('one', '第一问'), answer('a', '第一答'),
    user('two', '第二问'), answer('b', '第二答', 'missing-parent')]);
  assert.deepEqual(records.map(r => r.finalText), ['第一答', '第二答']);
});

test('disk partial windows with a missing old parent reread the full file before projecting cards', t => {
  const rows = [user('outside-window', '窗口外旧问题'),
    { type: 'system', note: 'x'.repeat(8 * 1024 * 1024 + 1024) }];
  for (let i = 0; i < 4; i++) rows.push(user('new-' + i, '新问题' + i), answer('new-answer-' + i, '新答案' + i, 'new-' + i));
  rows.push(answer('late-outside', '窗口外旧回答', 'outside-window'));
  const file = fileFixture(t, rows);
  const cards = require('../core/claude-disk-transcript').parseClaudeTranscriptToNativeTurns(file, { fromTail: true, limit: 4 });
  assert.deepEqual(cards.map(c => c.text), ['新问题2', '新答案2', '新问题3', '新答案3']);
});

test('disk partial windows with an unknown tool receipt reread its old tool owner', t => {
  const tool = answer('outside-tool', '', 'outside-user');
  tool.message.content = [{ type: 'tool_use', id: 'outside-call', name: 'Read', input: {} }];
  tool.message.stop_reason = 'tool_use';
  const rows = [user('outside-user', '窗口外旧问题'), tool,
    { type: 'system', note: 'x'.repeat(8 * 1024 * 1024 + 1024) }];
  for (let i = 0; i < 4; i++) rows.push(user('new-' + i, '新问题' + i), answer('new-answer-' + i, '新答案' + i, 'new-' + i));
  const receipt = user('outside-result', '');
  receipt.message.content = [{ type: 'tool_result', tool_use_id: 'outside-call', content: '窗口外工具结果' }];
  rows.push(receipt, answer('late-outside', '窗口外旧回答', 'outside-result'));
  assert.equal(claudeDiskRecords(rows.slice(3), { codeagentPartial: true }).needsFullRead, true);
  const known = answer('inside-tool', '', 'new-0');
  known.message.content = [{ type: 'tool_use', id: 'inside-call', name: 'Read', input: {} }];
  known.message.stop_reason = 'tool_use';
  const mixed = { ...receipt, message: { content: [...receipt.message.content,
    { type: 'tool_result', tool_use_id: 'inside-call', content: '窗口内结果' }] } };
  assert.equal(claudeDiskRecords([user('new-0', '新问题'), known, mixed], { codeagentPartial: true }).needsFullRead, true);
  const file = fileFixture(t, rows);
  const cards = require('../core/claude-disk-transcript').parseClaudeTranscriptToNativeTurns(file, { fromTail: true, limit: 4 });
  assert.deepEqual(cards.map(c => c.text), ['新问题2', '新答案2', '新问题3', '新答案3']);
  const full = claudeTranscriptTurns(claudeDiskRecords(rows));
  assert.equal(full[1].text, '窗口外旧回答');
  assert.equal(full[1].toolCalls[0].output, '窗口外工具结果');
});

test('disk partial prefix fragments before its first question do not request a full reread', () => {
  const orphan = answer('prefix-answer', '被截掉的问题的回答', 'outside-user');
  const receipt = user('prefix-result', '');
  receipt.message.content = [{ type: 'tool_result', tool_use_id: 'outside-call', content: '窗口开头旧结果' }];
  const prefix = [orphan, receipt,
    user('prefix-meta', 'hidden instructions', { isMeta: true, parentUuid: 'outside-user' }),
    user('prefix-stop', '[Request interrupted by user]', { parentUuid: 'outside-user' })];
  const records = claudeDiskRecords([...prefix, user('visible', '窗口内问题'), answer('visible-answer', '窗口内回答', 'visible')], { codeagentPartial: true });
  assert.equal(records.needsFullRead, undefined);
  assert.deepEqual(records.map(r => [r.userMessageId, r.finalText]), [['visible', '窗口内回答']]);
  // Once a question exists, the same missing parent could misattribute an old
  // answer to it. The full-read protection must still apply there.
  const afterQuestion = claudeDiskRecords([user('visible', '窗口内问题'), orphan], { codeagentPartial: true });
  assert.equal(afterQuestion.needsFullRead, true);
});

test('disk large-file tail parsing ignores leading orphan frames without reading the whole file', t => {
  const rows = [user('outside-user', '窗口外问题'),
    { type: 'system', note: 'x'.repeat(8 * 1024 * 1024 + 1024) },
    answer('prefix-answer', '窗口开头旧回答', 'outside-user')];
  for (let i = 0; i < 4; i++) rows.push(user('visible-' + i, '窗口内问题' + i), answer('answer-' + i, '窗口内回答' + i, 'visible-' + i));
  const file = fileFixture(t, rows), readFile = fs.readFileSync;
  let fullReads = 0;
  fs.readFileSync = function(target, ...args) {
    if (typeof target === 'string' && path.resolve(target) === path.resolve(file)) fullReads++;
    return readFile.call(this, target, ...args);
  };
  let cards;
  try { cards = require('../core/claude-disk-transcript').parseClaudeTranscriptToNativeTurns(file, { fromTail: true, limit: 4 }); }
  finally { fs.readFileSync = readFile; }
  assert.deepEqual(cards.map(c => c.text), ['窗口内问题2', '窗口内回答2', '窗口内问题3', '窗口内回答3']);
  assert.equal(fullReads, 0, 'an already-discarded prefix frame must not force the entire transcript into memory');
});

test('skill command helper recognizes only command-message wrappers, including no arguments and array content', () => {
  assert.equal(S.skillCommandText(wrapper()), '/git-ai whoami');
  assert.equal(S.skillCommandText(wrapper('')), '/git-ai');
  assert.equal(S.skillCommandText('  ' + wrapper(' alpha beta ')), '/git-ai alpha beta');
  for (const text of ['/git-ai whoami', 'quoted ' + wrapper(), '<command-message>missing name</command-message>', '<command-name>/model</command-name>']) assert.equal(S.skillCommandText(text), null);
  assert.equal(S.displayUserText(wrapper()), '/git-ai whoami');
  assert.equal(S.searchableUserText(wrapper()), '/git-ai whoami');
  assert.equal(userTextIdentity(wrapper()), userTextIdentity('/git-ai whoami'));
  const entries = skill(); entries[0].message.content = [{ type: 'text', text: wrapper() }];
  assert.equal(S.isSyntheticUserEntry(entries[0]), false);
  assert.equal(S.isSyntheticUserEntry(entries[1]), true);
  assert.equal(claudeDiskRecords(entries)[0].text, '/git-ai whoami');
  assert.equal(parseClaudeTranscriptEntries(entries)[0].text, '/git-ai whoami');
});

test('a root skill command retains its answer in disk, native card and plain transcript projections', () => {
  const entries = skill(), records = claudeDiskRecords(entries);
  assert.equal(records.length, 1);
  assert.equal(records[0].text, '/git-ai whoami');
  assert.equal(records[0].finalText, '回答-first');
  assert.equal(records[0].status, 'completed');
  for (const turns of [claudeTranscriptTurns(records), parseClaudeTranscriptEntries(entries)]) {
    assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', '/git-ai whoami'], ['assistant', '回答-first']]);
    assert.ok(!JSON.stringify(turns).includes('Base directory for this skill:'));
  }
});

test('skill, greeting, skill each own their answer and an unfinished prior turn settles independently', () => {
  const entries = [...skill('first'), user('hello', '你好', { parentUuid: 'first-answer' }), answer('hello-answer', '你好回答', 'hello'), ...skill('last', '', 'hello-answer')];
  const records = claudeDiskRecords(entries);
  assert.deepEqual(records.map(row => [row.text, row.finalText]), [['/git-ai whoami', '回答-first'], ['你好', '你好回答'], ['/git-ai', '回答-last']]);
  assert.deepEqual(parseClaudeTranscriptEntries(entries).map(row => row.text), ['/git-ai whoami', '回答-first', '你好', '你好回答', '/git-ai', '回答-last']);
  const pending = skill('pending'); pending[2].message.stop_reason = 'tool_use';
  const split = claudeDiskRecords([...pending, ...skill('next')]);
  assert.equal(split[0].status, 'interrupted');
  assert.equal(split[0].finalText, '');
  assert.equal(split[1].finalText, '回答-next');
});

test('Claude local command echoes and other meta records remain hidden', () => {
  const hidden = [user('local', '<command-name>/model</command-name>', { isMeta: true }), user('other-meta', 'injected material', { isMeta: true }),
    user('summary', wrapper(), { isCompactSummary: true }), user('visible-only', wrapper(), { isVisibleInTranscriptOnly: true })];
  for (const entry of hidden) assert.equal(S.isSyntheticUserEntry(entry), true);
  assert.equal(S.displayUserText(hidden[0].message.content), null);
  assert.deepEqual(claudeDiskRecords(hidden), []);
  assert.deepEqual(parseClaudeTranscriptEntries(hidden), []);
});

test('queue-operation bookkeeping never creates cards, and same-prompt queued delivery plus command wrapper creates one', () => {
  const entries = skill(), queued = { type: 'attachment', uuid: 'queued-attachment', promptId: 'prompt-first', timestamp: entries[0].timestamp,
    attachment: { type: 'queued_command', origin: { kind: 'human' }, humanTurn: true, commandMode: 'prompt', source_uuid: 'queued-source', delivery_id: 'delivery-first', prompt: '/git-ai whoami' } };
  const enqueue = { type: 'queue-operation', operation: 'enqueue', content: '/git-ai whoami', promptId: 'prompt-first' };
  const remove = { ...enqueue, operation: 'remove', reason: 'absorbed_mid_turn' };
  for (const pair of [[entries[0], queued], [queued, entries[0]]]) {
    const replay = [enqueue, ...pair, entries[1], remove, entries[2]];
    assert.equal([...withQueuedHumanInputs(replay)].filter(row => row.type === 'user' && !S.isSyntheticUserEntry(row)).length, 1);
    assert.equal(claudeDiskRecords(replay).length, 1);
    assert.deepEqual(parseClaudeTranscriptEntries(replay).map(row => row.role), ['user', 'assistant']);
  }
});

test('two sends with identical command text and different prompt IDs remain two questions and two answers', () => {
  const entries = [...skill('one'), ...skill('two')];
  assert.deepEqual(claudeDiskRecords(entries).map(row => row.finalText), ['回答-one', '回答-two']);
  assert.deepEqual(parseClaudeTranscriptEntries(entries).filter(row => row.role === 'user').map(row => row.text), ['/git-ai whoami', '/git-ai whoami']);
});

test('prompt alias dedup never consumes tool results belonging to that skill submission', () => {
  const entries = skill();
  const tool = answer('read-tool', '', 'first-body'); tool.message.content = [{ type: 'tool_use', id: 'read-id', name: 'Read', input: { file_path: 'C:/example/fixture.txt' } }]; tool.message.stop_reason = 'tool_use';
  const result = user('read-result', '', { promptId: 'prompt-first' }); result.message.content = [{ type: 'tool_result', tool_use_id: 'read-id', content: 'fixture tool output' }];
  const replay = [...entries.slice(0, 2), tool, result, entries[2]];
  assert.ok([...withQueuedHumanInputs(replay)].includes(result));
  const turns = parseClaudeTranscriptEntries(replay);
  assert.equal(turns.find(turn => turn.role === 'assistant').toolCalls[0].result, 'fixture tool output');
});

test('skill submissions reset subagent and progress-card boundaries without treating skill material as a new prompt', () => {
  const { isHumanPrompt, summarizeMainRecords } = require('../core/subagent-progress');
  const { humanMessageTimes, recentDialogue } = require('../main/progress-card-service');
  const entries = skill(); entries[1].timestamp = new Date(NOW + 1000).toISOString();
  assert.equal(isHumanPrompt(entries[0]), true);
  assert.equal(isHumanPrompt(entries[1]), false);
  assert.equal(humanMessageTimes(entries.map(JSON.stringify).join('\n')), NOW);
  const dialogue = recentDialogue(entries.map(JSON.stringify).join('\n'));
  assert.match(dialogue, /用户：\/git-ai whoami/);
  assert.doesNotMatch(dialogue, /Base directory|<command-message>/);
  const prior = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'old-task', name: 'Task', input: {} }] } };
  const summary = summarizeMainRecords([user('old', 'previous'), prior, ...entries]);
  assert.equal(summary.turnStartTs, NOW);
  assert.equal(summary.toolUses.length, 0);
});

test('file-flow history binds a restored skill command and keeps its same-prompt body attached to that request', () => {
  const { createHistoryReader, rememberPrompt } = require('../core/dev-chat-history');
  const orch = { state: { attempts: { fixture: { attemptId: 'fixture', turnNum: 1, runId: 'run', memberId: 'member', kind: 'codeagent', dispatchAt: NOW } },
    pendingPrompts: {}, messages: [] }, _saveState() {}, _appendMessage(message) { this.state.messages.push(message); return message; } };
  rememberPrompt(orch, 'hub-fixture', { attemptId: 'fixture', prompt: '/git-ai whoami' });
  const reader = createHistoryReader({ orch, sid: 'hub-fixture', kind: 'codeagent', sourcePath: 'C:/example/fixture.jsonl' });
  for (const entry of skill()) reader.record(entry);
  assert.equal(orch.state.messages.length, 1);
  assert.equal(orch.state.messages[0].content, '回答-first');
  assert.equal(orch.state.messages[0].attemptId, 'fixture');
  assert.equal(orch.state.devChatHistory.receipts.fixture.sourcePromptMatched, true);
});

test('live final reader recognizes a skill as a fresh submission rather than reusing the previous receipt', t => {
  const { readFinals } = require('../core/hub-assistant/live-history');
  const file = fileFixture(t, skill());
  const result = readFinals({ kind: 'claude', id: 'hub-fixture', ccSessionId: 'fixture-native', transcriptPath: file },
    { cursor: { identity: 'fixture-native', path: file, offset: 0, clientSubmissionId: 'previous-receipt', clientSubmissionIds: ['previous-receipt'] } });
  assert.equal(result.available, true);
  assert.equal(result.records[0].text, '回答-first');
  assert.equal(result.records[0].clientSubmissionId, null);
  assert.deepEqual(result.records[0].clientSubmissionIds, []);
});

test('CodeAgent known local commands stay local; unknown skill commands start tracking with bounded STARTING TTL', () => {
  const session = { kind: 'codeagent', agentRuntime: 'pty', status: 'idle' };
  for (const command of ['/model', '/model fixture-model', '/compact', '/clear', '/help', '/config']) assert.equal(isPtyLocalCommand(session, command), true);
  for (const command of ['/git-ai whoami', '/git-ai', '/unknown-local-or-skill']) assert.equal(isPtyLocalCommand(session, command), false);
  assert.equal(isPtyLocalCommand({ ...session, kind: 'codeagent-resume' }, '/git-ai'), false);
  for (const kind of ['claude', 'codex', 'kimi', 'gemini']) assert.equal(isPtyLocalCommand({ ...session, kind }, '/git-ai'), true);
  const runtime = require('../core/session-runtime-truth');
  runtime.applySessionRuntimeObservation(session, { state: runtime.RUNTIME_STARTING, source: 'pty-local-submit', confidence: runtime.CONFIDENCE_SEMANTIC, observedAt: NOW, startedAt: NOW });
  assert.equal(runtime.getSessionRuntimeTruth(session, { now: NOW + 1 }).state, runtime.RUNTIME_STARTING);
  assert.equal(runtime.getSessionRuntimeTruth(session, { now: NOW + runtime.STARTING_TTL_MS + 1 }).state, runtime.RUNTIME_UNKNOWN);
});

test('context-tail and session search use the restored command and exclude skill material', async t => {
  const file = fileFixture(t, skill());
  const { readTranscriptTail } = require('../core/session-manager');
  const text = await readTranscriptTail('codeagent', file, 10);
  assert.match(text, /USER: \/git-ai whoami/);
  assert.doesNotMatch(text, /Base directory|<command-message>/);
  const { scanSessionMetadata } = require('../core/session-archive');
  assert.equal((await scanSessionMetadata(file)).firstUserMessage, '/git-ai whoami');
  const { parseSourceDescriptor } = require('../core/session-search-sources');
  const indexed = parseSourceDescriptor({ type: 'claude', provider: 'codeagent', key: 'fixture-source', signature: 'fixture-signature', nativeSessionId: 'fixture-native', filePath: file }, {});
  assert.match(indexed.session.title, /git-ai/);
  assert.ok(indexed.docs.some(doc => doc.text.includes('/git-ai whoami')));
  assert.ok(indexed.docs.some(doc => doc.text.includes('回答-first')));
  assert.ok(!JSON.stringify(indexed.docs).includes('Base directory for this skill:'));
});

// 只实现卡片挂载/替换用到的 DOM 接口；调用真实 renderer，不安装 DOM 依赖。
function cardFixture({ storage } = {}) {
  class Element {
    constructor() { this.dataset = {}; this.children = []; this.style = {}; this.className = ''; this.scrollHeight = 100; this.clientHeight = 100; this.scrollTop = 0;
      this.classList = { contains: value => this.className.split(' ').includes(value), add() {}, remove() {}, toggle() {} }; }
    addEventListener() {} removeEventListener() {} scrollIntoView() {}
    querySelector(selector) {
      const id = selector.match(/data-turn-id="([^"]+)"/);
      return id ? this.children.find(child => child.dataset.turnId === id[1].replace(/\\/g, '')) || null : null;
    }
    querySelectorAll(selector) {
      if (selector === '.turn-card.user[data-optimistic="true"]') return this.children.filter(child => child.dataset.optimistic === 'true');
      if (selector === '.turn-card.user') return this.children.filter(child => child.className.split(' ').includes('user'));
      return [];
    }
    appendChild(child) { if (child.parentNode) child.remove(); child.parentNode = child.parentElement = this; this.children.push(child); }
    insertBefore(child, before) { if (!before) return this.appendChild(child); if (child.parentNode) child.remove(); child.parentNode = child.parentElement = this; this.children.splice(this.children.indexOf(before), 0, child); }
    remove() { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = this.parentElement = null; }
    set innerHTML(html) {
      const root = new Element(); root.ownerDocument = doc;
      root.className = html.match(/class="([^"]+)"/)?.[1] || '';
      root.dataset.turnId = html.match(/data-turn-id="([^"]+)"/)?.[1];
      this.firstElementChild = root;
    }
  }
  const doc = { addEventListener() {}, removeEventListener() {}, createElement: () => new Element() };
  const container = new Element(); container.ownerDocument = doc;
  const state = { requestAnimationFrame: callback => callback(), localStorage: storage };
  const renderer = require('../renderer/turn-card-renderer').createTurnCardRenderer({ document: doc, window: state,
    root: container, container, bridgeIpc: null, formatAbsoluteTime: () => 'fixture-time', escapeHtml: value => String(value || '').replace(/</g, '&lt;'),
    getSessionContext: () => ({ kind: 'codeagent' }) });
  return { container, renderer, doc, state };
}

test('only stopped submitted user cards show inline edit-resend, using the same action as the menu', () => {
  const f = cardFixture();
  for (const state of [{ stopped: true }, { deliveryStatus: 'interrupted' }, { commandResult: { stopped: true, notSent: false } }]) {
    const html = f.renderer.renderTurnCard({ id: 'user', role: 'user', text: 'request', ...state });
    assert.match(html, /turn-stopped-action.*已停止 · .*data-action="edit-resend"/);
    assert.equal((html.match(/data-action="edit-resend"/g) || []).length, 2);
  }
  for (const state of [{}, { commandResult: { stopped: true, notSent: true } }]) {
    const html = f.renderer.renderTurnCard({ id: 'normal', role: 'user', text: 'request', ...state });
    assert.doesNotMatch(html, /turn-stopped-action/); assert.equal((html.match(/data-action="edit-resend"/g) || []).length, 1);
  }
  assert.notEqual(f.renderer.turnRenderSignature({ role: 'user', text: 'same' }), f.renderer.turnRenderSignature({ role: 'user', text: 'same', stopped: true }));
  f.renderer.dispose();
});

test('a stopped optimistic user card transfers its state to the real card and survives reloading', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const f = cardFixture({ storage });
  const pending = f.renderer.mountOptimisticUserCard('hub-fixture', '/git-ai whoami', 'codeagent', { clientSubmissionId: 'stopped-send' });
  assert.equal(f.renderer.latestUserCard('hub-fixture'), pending);
  f.renderer.markUserStopped('hub-fixture', pending);
  const real = { id: 'real-user', role: 'user', text: '/git-ai whoami', ts: Date.now() + 1000 };
  f.renderer.mountSessionTurnCard('hub-fixture', real);
  assert.equal(f.container.children.length, 1); assert.equal(pending.parentNode, null);
  assert.equal(f.state._sessionTurns.get('real-user').stopped, true);
  const reloaded = cardFixture({ storage }); reloaded.renderer.mountSessionTurnCard('hub-fixture', { ...real });
  const turn = reloaded.state._sessionTurns.get('real-user');
  assert.equal(turn.stopped, true); assert.match(reloaded.renderer.renderTurnCard(turn), /turn-stopped-action/);
  f.renderer.dispose(); reloaded.renderer.dispose();
});

test('a CodeAgent interrupted transcript round still shows stopped editing after actual IPC reload', async t => {
  const entries = [user('interrupted-user', 'request'),
    { ...answer('partial', 'working', 'interrupted-user'), message: { role: 'assistant', content: [{ type: 'text', text: 'working' }], stop_reason: 'tool_use' } },
    user('interrupt', '[Request interrupted by user]', { timestamp: new Date(NOW + 3000).toISOString() })];
  const result = await reloadCommandFixture(t, { entries });
  const f = cardFixture(), turn = result.turns.find(turn => turn.role === 'user');
  assert.equal(turn.deliveryStatus, 'interrupted'); f.renderer.mountSessionTurnCard('hub-fixture', turn);
  assert.match(f.renderer.renderTurnCard(f.state._sessionTurns.get(turn.id)), /turn-stopped-action/); f.renderer.dispose();
});

test('Stop finishing after transcript replacement marks the same submitted user card, not the next draft', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const f = cardFixture({ storage });
  const clicked = f.renderer.mountOptimisticUserCard('hub-fixture', 'original prompt', 'codeagent', { clientSubmissionId: 'stopped-send' });
  const real = { id: 'real-ordinary', role: 'user', text: 'original prompt', ts: Date.now() + 1000 };
  f.renderer.mountSessionTurnCard('hub-fixture', real);
  const next = f.renderer.mountOptimisticUserCard('hub-fixture', 'next prompt', 'codeagent', { clientSubmissionId: 'next-send' });
  f.renderer.markUserStopped('hub-fixture', clicked);
  assert.equal(f.state._sessionTurns.get(real.id).stopped, true); assert.equal(next.dataset.stopped, undefined);
  const reloaded = cardFixture({ storage }); reloaded.renderer.mountSessionTurnCard('hub-fixture', real);
  assert.equal(reloaded.state._sessionTurns.get(real.id).stopped, true);
  f.renderer.dispose(); reloaded.renderer.dispose();
});

test('real user card replaces exactly one optimistic skill card; a genuine repeated send keeps a second card', () => {
  const { container, renderer } = cardFixture();
  renderer.mountOptimisticUserCard('hub-fixture', '/git-ai whoami', 'codeagent');
  renderer.mountOptimisticUserCard('hub-fixture', '/git-ai whoami', 'codeagent');
  const first = renderer.mountSessionTurnCard('hub-fixture', { id: 'real-first', role: 'user', text: wrapper(), ts: Date.now() + 1 });
  assert.ok(first);
  assert.equal(container.children.length, 2);
  assert.equal(container.children.filter(row => row.dataset.optimistic === 'true').length, 1);
  renderer.mountSessionTurnCard('hub-fixture', { id: 'real-second', role: 'user', text: '/git-ai whoami', ts: Date.now() + 2 });
  assert.deepEqual(container.children.map(row => row.dataset.turnId), ['real-first', 'real-second']);
  renderer.dispose();
});

test('command dividers render a thin separator without a user or assistant card header', () => {
  const { renderer } = cardFixture();
  const html = renderer.renderTurnCard({ id: 'compact', role: 'divider', text: '上下文已压缩' });
  assert.match(html, /command-divider/); assert.match(html, /role="separator"/);
  assert.match(html, /上下文已压缩/); assert.doesNotMatch(html, /turn-head|turn-avatar|turn-card user|turn-card assistant/);
  assert.notEqual(renderer.turnRenderSignature({ role: 'user', text: '/compact' }),
    renderer.turnRenderSignature({ role: 'divider', text: '上下文已压缩' }));
  renderer.dispose();
});

test('one send plus staged history reload leaves one real card; replay never consumes the next identical send', () => {
  const { container, renderer, doc } = cardFixture();
  const firstReceipt = { clientSubmissionId: 'submission-first' };
  const pending = renderer.mountOptimisticUserCard('hub-fixture', '/git-ai whoami', 'codeagent', firstReceipt);
  assert.equal(renderer.mountOptimisticUserCard('hub-fixture', '/git-ai whoami', 'codeagent', firstReceipt), pending);
  assert.equal(container.children.length, 1, 'replaying the same Hub send cannot mount a second placeholder');
  const staging = doc.createElement('div'), concurrentExtraCards = [pending];
  const real = { id: 'real-first', role: 'user', text: '/git-ai whoami', ts: Date.now() + 1 };
  const card = renderer.mountSessionTurnCard('hub-fixture', real, { kind: 'codeagent', container: staging, deferOptimisticReconcile: true });
  assert.equal(container.children.length, 1);
  container.appendChild(card);
  assert.equal(container.children.length, 2, 'the formerly broken staging path has both cards before reconciliation');
  renderer.reconcileOptimisticUserCards('hub-fixture', [real], { container, kind: 'codeagent' });
  for (const extra of concurrentExtraCards) if (extra.parentNode === container) container.appendChild(extra);
  assert.deepEqual(container.children.map(row => row.dataset.turnId), ['real-first']);
  renderer.mountOptimisticUserCard('hub-fixture', '/git-ai whoami', 'codeagent', { clientSubmissionId: 'submission-second' });
  renderer.reconcileOptimisticUserCards('hub-fixture', [real], { container, kind: 'codeagent' });
  assert.equal(container.children.length, 2, 'refreshing the first real turn cannot claim a later identical send');
  renderer.mountSessionTurnCard('hub-fixture', { ...real, id: 'real-second', ts: Date.now() + 2 }, { kind: 'codeagent' });
  assert.deepEqual(container.children.map(row => row.dataset.turnId), ['real-first', 'real-second']);
  renderer.dispose();
});

test('duplicate placeholders of one known receipt are all removed, while another send receipt survives', () => {
  const { container, renderer, doc } = cardFixture();
  const first = renderer.mountOptimisticUserCard('hub-fixture', '/git-ai whoami', 'codeagent', { clientSubmissionId: 'same-send' });
  const duplicate = doc.createElement('div'); duplicate.className = first.className; duplicate.dataset = { ...first.dataset };
  container.appendChild(duplicate);
  renderer.mountOptimisticUserCard('hub-fixture', '/git-ai whoami', 'codeagent', { clientSubmissionId: 'different-send' });
  renderer.mountSessionTurnCard('hub-fixture', { id: 'real-once', role: 'user', text: '/git-ai whoami', ts: Date.now() + 1 }, { kind: 'codeagent' });
  assert.equal(container.children.length, 2);
  assert.equal(container.children.filter(row => row.dataset.optimistic === 'true').length, 1);
  assert.equal(container.children[0].dataset.clientSubmissionId, 'different-send');
  renderer.dispose();
});

// Synthetic legacy journal + CodeAgent transcript fixtures. No real account data.
function commandEcho(name, args, at, id) {
  const text = '<command-message>' + name + '</command-message>\n<command-name>/' + name
    + '</command-name>\n<command-args>' + args + '</command-args>';
  const timestamp = new Date(at).toISOString();
  return [user(id, text, { isMeta: true, promptId: 'prompt-' + id, parentUuid: null, timestamp }),
    user(id + '-body', 'Base directory for this skill: C:/example/skills/' + name + '\nSynthetic instructions',
      { isMeta: true, promptId: 'prompt-' + id, parentUuid: id, timestamp }),
    { ...answer(id + '-answer', '回答-' + id, id + '-body'), timestamp: new Date(at + 1000).toISOString() }];
}

function builtinEntry(name, id, at = NOW) {
  return user(id, `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args></command-args>`,
    { isMeta: true, timestamp: new Date(at).toISOString() });
}

test('both parsers remove built-in turn boundaries while preserving skills and their answers', () => {
  const policy = require('../core/codeagent-command-records');
  const entries = [user('human', 'question'), answer('before', 'before', 'human'), builtinEntry('compact', 'compact', NOW + 3000),
    answer('continued', 'continue', 'compact'), builtinEntry('model', 'model', NOW + 4000), ...skill('skill')];
  for (const turns of [claudeTranscriptTurns(claudeDiskRecords(entries, { codeagent: true })),
    parseClaudeTranscriptEntries(entries, { codeagent: true })]) {
    const visible = policy.projectCommandRecords(turns);
    assert.deepEqual(visible.filter(turn => turn.role === 'user').map(turn => turn.id), ['human', 'skill']);
    assert.deepEqual(visible.filter(turn => turn.role === 'divider').map(turn => turn.text), ['上下文已压缩']);
    assert.ok(visible.some(turn => turn.role === 'assistant' && /回答-skill/.test(turn.text)));
    assert.ok(visible.filter(turn => turn.role === 'assistant').some(turn => /continue/.test(turn.text)));
    assert.ok(!turns.some(turn => turn.role === 'assistant' && turn.userMessageId === 'compact'));
  }
});

test('CodeAgent builtin reload shows compact once, hides model and local stdout, and logs no body', async t => {
  const entries = [user('human', 'private question'), answer('a', 'answer', 'human'), builtinEntry('compact', 'compact', NOW + 3000),
    user('stdout', '<local-command-stdout>private command output</local-command-stdout>', { isMeta: true }),
    builtinEntry('model', 'model', NOW + 4000)];
  const result = await reloadCommandFixture(t, { entries, commands: [{ text: '/compact', ts: NOW + 2500 }, { text: '/model private-model', ts: NOW + 3500 }] });
  assert.deepEqual(result.turns.map(turn => turn.role), ['user', 'assistant', 'divider']);
  assert.equal(result.turns.at(-1).text, '上下文已压缩');
  assert.equal(result.logs.length, 2, 'SQLite reopen plus parser cache hit must not duplicate diagnostics');
  assert.deepEqual(result.logs.map(row => row.command), ['compact', 'model']);
  assert.deepEqual(result.logs.map(row => row.action), ['divider', 'hidden']);
  for (const row of result.logs) {
    assert.deepEqual(Object.keys(row).sort(), ['action', 'at', 'command', 'file', 'firstUserInFile', 'identitySwitch', 'sessionId'].sort());
    assert.equal(row.sessionId, 'hub-fixt'); assert.equal(row.file, 'fixture.');
  }
  assert.doesNotMatch(JSON.stringify(result.logs), /private|question|command output|[\\/]/);
});

function applyCommandHistoryWire(index, fixture, result, kind = 'codeagent') {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const calls = [...source.matchAll(/turnCardRenderer\.reconcileCommandUserCards\(sessionId,[\s\S]*?\);/g)].map(match => match[0]);
  assert.equal(calls.length, 2);
  require('node:vm').runInNewContext(calls[index], { turnCardRenderer: fixture.renderer, sessionId: 'hub-fixture',
    result, turns: result.turns, container: fixture.container, kind, mountKind: kind });
}

test('real journal reload clears only exact CodeAgent builtin placeholders, including after session reload', async t => {
  const result = await reloadCommandFixture(t, { commands: [{ text: '/model', ts: NOW }] });
  const response = { turns: result.turns, codeagentCommandSubmissionIds: result.commandSubmissionIds };
  assert.deepEqual(response.codeagentCommandSubmissionIds, ['submission-0']);
  const f = cardFixture();
  f.renderer.mountOptimisticUserCard('hub-fixture', '/model', 'codeagent', { clientSubmissionId: 'submission-0' });
  f.renderer.mountOptimisticUserCard('hub-fixture', '/model', 'codeagent', { clientSubmissionId: 'different-send' });
  f.renderer.mountOptimisticUserCard('hub-fixture', '/git-ai whoami', 'codeagent', { clientSubmissionId: 'skill-send' });
  applyCommandHistoryWire(0, f, response, 'claude');
  assert.equal(f.container.children.length, 3, 'a non-CodeAgent view must leave even a matching receipt alone');
  applyCommandHistoryWire(0, f, response);
  assert.deepEqual(f.container.children.map(card => card.dataset.clientSubmissionId), ['different-send', 'skill-send']);
  applyCommandHistoryWire(0, f, response, 'claude');
  assert.equal(f.container.children.length, 2);
  f.renderer.mountSessionTurnCard('hub-fixture', { id: 'real-skill', role: 'user', text: '/git-ai whoami', clientSubmissionId: 'skill-send', ts: NOW });
  assert.equal(f.container.children.length, 2); assert.equal(f.container.children.at(-1).dataset.turnId, 'real-skill');
  const reloaded = cardFixture(); applyCommandHistoryWire(0, reloaded, response);
  assert.deepEqual(reloaded.container.children, []);
  reloaded.renderer.dispose(); f.renderer.dispose();
});

test('compact placeholder is kept until its divider mounts, then replaced in the same slot', async t => {
  const result = await reloadCommandFixture(t, { commands: [{ text: '/compact', ts: NOW }] });
  const response = { turns: result.turns, codeagentCommandSubmissionIds: result.commandSubmissionIds };
  const f = cardFixture();
  const placeholder = f.renderer.mountOptimisticUserCard('hub-fixture', '/compact', 'codeagent', { clientSubmissionId: 'submission-0' });
  const later = f.renderer.mountOptimisticUserCard('hub-fixture', 'later question', 'codeagent', { clientSubmissionId: 'later' });
  applyCommandHistoryWire(0, f, response); assert.equal(f.container.children[0], placeholder);
  const divider = f.renderer.mountSessionTurnCard('hub-fixture', response.turns[0]);
  applyCommandHistoryWire(1, f, response);
  assert.deepEqual(f.container.children, [divider, later]); assert.equal(placeholder.parentNode, null);
  assert.equal(divider.className, 'turn-card command-divider'); f.renderer.dispose();
});

test('clear and new require a first user record or a matching clear identity switch', async t => {
  for (const name of ['clear', 'new']) {
    const first = await reloadCommandFixture(t, { entries: [builtinEntry(name, 'first')] });
    assert.deepEqual(first.turns.map(turn => turn.text), ['已开始新对话，之前的上下文已清空']);
    assert.equal(first.logs[0].firstUserInFile, true);
    const entries = [user('first', 'question'), answer('a', 'answer', 'first'), builtinEntry(name, 'middle', NOW + 3000)];
    const middle = await reloadCommandFixture(t, { entries });
    assert.deepEqual(middle.turns.map(turn => turn.role), ['user', 'assistant']); assert.equal(middle.logs[0].action, 'hidden');
    for (const [source, to, at, visible] of [['clear', 'fixture', NOW + 4000, true], ['resume', 'fixture', NOW + 4000, false],
      ['clear', 'other-file', NOW + 4000, false], ['clear', 'fixture', NOW + 90000, false]]) {
      const switched = await reloadCommandFixture(t, { entries, identitySwitch: { source, to, at } });
      assert.equal(switched.turns.some(turn => turn.role === 'divider'), visible);
      assert.equal(switched.logs[0].identitySwitch, visible);
    }
  }
});

test('builtin journal pairing never shifts identical skills around a compact record', async t => {
  const entries = [...commandEcho('git-ai', 'first formatted', NOW + 45000, 'first'), builtinEntry('compact', 'compact', NOW + 50000),
    ...commandEcho('git-ai', 'second formatted', NOW + 90000, 'second')];
  const commands = [{ text: '/git-ai first original', ts: NOW }, { text: '/compact', ts: NOW + 1000 }, { text: '/git-ai second original', ts: NOW + 2000 }];
  const result = await reloadCommandFixture(t, { entries, commands });
  assert.deepEqual(result.turns.map(turn => [turn.role, turn.text]), [['user', '/git-ai first original'], ['assistant', '回答-first'],
    ['divider', '上下文已压缩'], ['user', '/git-ai second original'], ['assistant', '回答-second']]);
  assert.equal(result.logs.length, 1);
});

test('per-account command kinds and aliases override fallback; unknown and custom skills stay visible', async t => {
  const cache = { version: 1, accounts: { personal: { commands: [{ name: 'new', aliases: ['clear'], kind: 'command' },
    { name: 'model', kind: 'skill' }, { name: 'compact', kind: 'custom-command' }] }, other: { commands: [{ name: 'git-ai', kind: 'command' }] } } };
  const result = await reloadCommandFixture(t, { cache, entries: [builtinEntry('clear', 'clear'), ...commandEcho('model', 'x', NOW + 1000, 'model'),
    ...commandEcho('compact', 'x', NOW + 4000, 'compact'), ...commandEcho('git-ai', 'x', NOW + 8000, 'git-ai')] });
  assert.deepEqual(result.turns.filter(turn => turn.role === 'user').map(turn => turn.text), ['/model x', '/compact x', '/git-ai x']);
  assert.equal(result.turns[0].role, 'divider');
  const legacy = await reloadCommandFixture(t, { kind: 'claude', entries: [builtinEntry('compact', 'legacy')] });
  assert.deepEqual(legacy.turns.map(turn => turn.text), ['/compact']);
});

test('partial transcript windows never claim a clear is the first user in the file', () => {
  const policy = require('../core/codeagent-command-records');
  const turns = parseClaudeTranscriptEntries([builtinEntry('clear', 'clear')], { codeagent: true, codeagentPartial: true });
  assert.equal(turns[0].codeagentCommand.firstUserInFile, false);
  assert.deepEqual(policy.projectCommandRecords(turns), []);
});

test('command record diagnostics rotate, deduplicate and are collected by feedback', t => {
  const policy = require('../core/codeagent-command-records');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-diagnostic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 12; i++) {
    const turns = [{ id: 'record-' + i, role: 'user', text: '/compact private-text', source: 'hub-command', ts: NOW }];
    for (let twice = 0; twice < 2; twice++) policy.projectCommandRecords(turns, { dataDir: dir, sessionId: 'abcdefgh-private', maxBytes: 500 });
  }
  const file = path.join(dir, 'logs', 'codeagent-command-records.log');
  assert.ok(fs.existsSync(file + '.1')); assert.ok(fs.statSync(file).size <= 500); assert.ok(fs.statSync(file + '.1').size <= 500);
  const rows = [file, file + '.1'].flatMap(file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse));
  assert.doesNotMatch(JSON.stringify(rows), /private|record-/);
  assert.ok(require('../core/hub-feedback').collectBundle({ logsDir: path.dirname(file) }).items.some(item => item.name === '日志 codeagent-command-records.log'));
});

async function reloadCommandFixture(t, { commands = [], entries = [], kind = 'codeagent', live = true, requestKind = 'claude', opts = {}, cache, identitySwitch } = {}) {
  const { CommandTranscriptStore } = require('../core/command-transcript-store');
  const { TranscriptParserService } = require('../core/transcript-parser-service');
  const { registerTranscriptIpc } = require('../main/ipc/transcript-handlers');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-command-reload-')), file = path.join(dir, 'fixture.jsonl');
  const sid = 'hub-fixture';
  let store = new CommandTranscriptStore(dir), parser;
  t.after(async () => { await parser?.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const [index, command] of commands.entries()) {
    const id = command.id || 'submission-' + index;
    store.begin(sid, id, command.text);
    if (command.result !== null) store.finish(sid, id, command.result || { ok: true });
    // Represent already-persisted sends at deterministic times, without waiting.
    store.db.prepare('UPDATE commands SET ts=? WHERE session_id=? AND submission_id=?').run(command.ts, sid, id);
  }
  const saved = store.read(sid);
  store.close(); store = new CommandTranscriptStore(dir); // reload from an existing journal, no migration
  fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const session = { id: sid, hubId: sid, kind, ccSessionId: 'fixture-native', transcriptPath: file, createdAt: NOW - 1000 };
  if (cache) { fs.mkdirSync(path.join(dir, 'codeagent-pool')); fs.writeFileSync(path.join(dir, 'codeagent-pool', 'codeagent-commands.json'), JSON.stringify(cache)); }
  const manager = Object.assign(new (require('node:events').EventEmitter)(), { getSession: id => live && id === sid ? session : null });
  parser = new TranscriptParserService();
  const handlers = new Map();
  registerTranscriptIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    sessionManager: manager, dataDir: dir,
    getPersistedSessions: () => [session], transcriptParserService: parser, commandTranscriptStore: store,
    parseClaudeTranscriptToNativeTurns: require('../core/claude-disk-transcript').parseClaudeTranscriptToNativeTurns,
    parseClaudeTranscriptToTurns: require('../core/claude-transcript-parser').parseClaudeTranscriptToTurns,
    isCodexCliKind: require('../core/ai-kinds').isCodexCliKind, defer: async () => {},
  });
  if (identitySwitch) manager.emit('claude-identity-switched', { sessionId: sid, ...identitySwitch });
  // A caller's mode flag cannot override the actual live/persisted session kind.
  const args = { hubSessionId: sid, kind: requestKind, transcriptPath: file, opts: { limit: 50, fromTail: true, ...opts, codeagent: true } };
  const read = () => handlers.get('parse-session-transcript')(null, args);
  const first = await read(), reloaded = await read();
  assert.equal(first.error, null); assert.equal(reloaded.error, null);
  assert.equal(first.parseCacheHit, false); assert.equal(reloaded.parseCacheHit, true);
  assert.deepEqual(reloaded.turns, first.turns);
  assert.deepEqual(store.read(sid), saved, 'reading must never alter the saved journal text, timestamps or results');
  const log = path.join(dir, 'logs', 'codeagent-command-records.log');
  return { turns: reloaded.turns, saved, commandSubmissionIds: reloaded.codeagentCommandSubmissionIds,
    logs: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

for (const [label, original, echoed, name, cliName] of [
  ['line breaks become spaces', '仿真\nxxx', '仿真 xxx', 'airview-development', 'airview-development'],
  ['CRLF is reformatted', '仿真\r\nxxx', '仿真\nxxx', 'airview-development', 'airview-development'],
  ['blank lines are removed', '仿真\n\nxxx', '仿真xxx', 'airview-development', 'airview-development'],
  ['uppercase skill name', 'whoami', 'whoami', 'GIT-AI', 'git-ai'],
]) {
  test('CodeAgent journal reload pairs formatted skill echoes: ' + label, async t => {
    const text = '/' + name + ' ' + original, at = NOW + 1000;
    const { turns } = await reloadCommandFixture(t, { commands: [{ text, ts: NOW }], entries: commandEcho(cliName, echoed, at, 'echo') });
    assert.deepEqual(turns.map(turn => turn.role), ['user', 'assistant'], 'user must precede its answer even when logical timestamps tie');
    assert.equal(turns[0].id, 'command:submission-0'); assert.equal(turns[0].text, text); assert.equal(turns[0].ts, at);
    assert.equal(turns[1].text, '回答-echo'); assert.equal(turns[1].userMessageId, 'echo');
    const displayed = require('../renderer/simple-chat-display').displayChatTurns(turns);
    assert.deepEqual(displayed.map(turn => turn.role), ['user', 'assistant']);
    const { container, renderer } = cardFixture();
    renderer.mountSessionTurnCard('hub-fixture', displayed[0], { kind: 'codeagent' });
    assert.equal(container.children.length, 1); renderer.dispose();
  });
}

for (const [label, delay] of [['queued more than thirty seconds', 45000], ['first launch waits for initialization', 180000]]) {
  test('CodeAgent single-line command reload pairs after delay: ' + label, async t => {
    const { turns } = await reloadCommandFixture(t, { commands: [{ text: '/git-ai whoami', ts: NOW }],
      entries: commandEcho('git-ai', 'whoami', NOW + delay, 'delayed') });
    assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', '/git-ai whoami'], ['assistant', '回答-delayed']]);
    assert.equal(turns[0].ts, NOW + delay);
  });
}

test('two genuine identical skill sends keep two original user cards and their respective answers', async t => {
  const text = '/git-ai whoami\nplease';
  const { turns } = await reloadCommandFixture(t, { commands: [{ text, ts: NOW }, { text, ts: NOW + 60000 }],
    entries: [...commandEcho('git-ai', 'whoami please', NOW + 45000, 'first'), ...commandEcho('git-ai', 'whoami please', NOW + 120000, 'second')] });
  assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', text], ['assistant', '回答-first'], ['user', text], ['assistant', '回答-second']]);
  assert.deepEqual(turns.filter(turn => turn.role === 'user').map(turn => turn.id), ['command:submission-0', 'command:submission-1']);
});

test('tail windows align the newest same-name journals; partial forward pages conservatively keep the CLI text', async t => {
  const commands = Array.from({ length: 30 }, (_, index) => ({ text: '/git-ai original-' + index, ts: NOW + index * 10000 }));
  const entries = commands.flatMap((command, index) => commandEcho('git-ai', 'formatted-' + index, command.ts + 1000, 'echo-' + index));
  for (const opts of [{ fromTail: true }, { fromTail: false }, { fromTail: true, offset: 2 }]) {
    const { turns } = await reloadCommandFixture(t, { commands, entries, opts: { limit: 2, ...opts } });
    if (opts.fromTail && !opts.offset) {
      assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', commands[29].text], ['assistant', '回答-echo-29']]);
      assert.equal(turns[0].id, 'command:submission-29');
    } else if (!opts.fromTail) {
      assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', commands[0].text], ['user', '/git-ai formatted-0']]);
      assert.equal(turns[1].id, 'echo-0', 'without complete context do not replace the provider text with a guessed journal');
    } else {
      assert.equal(turns[0].id, 'echo-29', 'an offset request without suffix counts must keep the provider text');
      assert.equal(turns[0].text, '/git-ai formatted-29');
    }
  }
});

test('tail alignment selects the latest visible sends separately for each command name', async t => {
  const commands = [{ text: '/first old', ts: NOW }, { text: '/second old', ts: NOW + 10000 },
    { text: '/FIRST new', ts: NOW + 20000 }, { text: '/SECOND new', ts: NOW + 30000 }];
  const entries = [...commandEcho('first', 'formatted old', NOW + 1000, 'first-old'),
    ...commandEcho('second', 'formatted old', NOW + 11000, 'second-old'),
    ...commandEcho('first', 'formatted new', NOW + 21000, 'first-new'),
    ...commandEcho('second', 'formatted new', NOW + 31000, 'second-new')];
  const { turns } = await reloadCommandFixture(t, { commands, entries, opts: { limit: 4 } });
  assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', '/FIRST new'], ['assistant', '回答-first-new'],
    ['user', '/SECOND new'], ['assistant', '回答-second-new']]);
});

test('a forward read that exhausts the provider history can safely use FIFO pairing', async t => {
  const { turns } = await reloadCommandFixture(t, { commands: [{ text: '/git-ai first', ts: NOW }, { text: '/git-ai second', ts: NOW + 1000 }],
    entries: [...commandEcho('git-ai', 'formatted first', NOW + 45000, 'first'), ...commandEcho('git-ai', 'formatted second', NOW + 90000, 'second')],
    opts: { fromTail: false, limit: 50 } });
  assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', '/git-ai first'], ['assistant', '回答-first'],
    ['user', '/git-ai second'], ['assistant', '回答-second']]);
});

test('same-millisecond journal rows greedily consume one echo each in stored order', async t => {
  const first = '/git-ai first\nrequest', second = '/git-ai second\nrequest';
  const { turns } = await reloadCommandFixture(t, { commands: [{ text: first, ts: NOW }, { text: second, ts: NOW }],
    entries: [...commandEcho('git-ai', 'first request', NOW + 45000, 'first'), ...commandEcho('git-ai', 'second request', NOW + 90000, 'second')] });
  assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', first], ['assistant', '回答-first'], ['user', second], ['assistant', '回答-second']]);
  assert.deepEqual(turns.filter(turn => turn.role === 'user').map(turn => turn.ts), [NOW + 45000, NOW + 90000]);
});

test('a delayed CodeAgent echo still pairs when a different local command was journaled before it arrived', async t => {
  const { turns } = await reloadCommandFixture(t, { commands: [{ text: '/git-ai whoami', ts: NOW }, { text: '/other local', ts: NOW + 10000 }],
    entries: commandEcho('git-ai', 'whoami', NOW + 12000, 'late') });
  assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', '/other local'], ['user', '/git-ai whoami'], ['assistant', '回答-late']]);
  assert.equal(turns[1].id, 'command:submission-0'); assert.equal(turns[1].ts, NOW + 12000);
});

test('two sends one second apart keep two cards and answers when both CLI echoes arrive after the second journal', async t => {
  const { turns } = await reloadCommandFixture(t, { commands: [{ text: '/git-ai first', ts: NOW }, { text: '/git-ai second', ts: NOW + 1000 }],
    entries: [...commandEcho('git-ai', 'formatted first', NOW + 45000, 'first'), ...commandEcho('git-ai', 'formatted second', NOW + 90000, 'second')] });
  assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', '/git-ai first'], ['assistant', '回答-first'], ['user', '/git-ai second'], ['assistant', '回答-second']]);
  assert.deepEqual(turns.filter(turn => turn.role === 'user').map(turn => turn.id), ['command:submission-0', 'command:submission-1']);
});

for (const result of [{ ok: false, notSent: true }, { ok: false, sendStatus: 'rejected', error: 'cli-not-ready' }, { ok: false, error: 'send-failed' }]) {
  test('a failed same-name journal cannot consume the next successful CLI echo: ' + JSON.stringify(result), async t => {
    const { turns } = await reloadCommandFixture(t, { commands: [{ text: '/git-ai first', ts: NOW },
      { text: '/git-ai not delivered', ts: NOW + 1000, result }, { text: '/git-ai third', ts: NOW + 2000 }],
    entries: [...commandEcho('git-ai', 'formatted first', NOW + 45000, 'first'), ...commandEcho('git-ai', 'formatted third', NOW + 90000, 'third')] });
    assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', '/git-ai not delivered'],
      ['user', '/git-ai first'], ['assistant', '回答-first'], ['user', '/git-ai third'], ['assistant', '回答-third']]);
    assert.deepEqual(turns.filter(turn => turn.role === 'user').map(turn => turn.id), ['command:submission-1', 'command:submission-0', 'command:submission-2']);
  });
}

for (const result of [null, { ok: true, sendStatus: 'stuck' }, { ok: false, sendStatus: 'stuck' }, { ok: false, unconfirmed: true }]) {
  test('pending or uncertain journal results can still claim their eventual CLI echo: ' + JSON.stringify(result), async t => {
    const { turns } = await reloadCommandFixture(t, { commands: [{ text: '/git-ai original', ts: NOW, result }],
      entries: commandEcho('git-ai', 'reformatted', NOW + 60000, 'eventual') });
    assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', '/git-ai original'], ['assistant', '回答-eventual']]);
  });
}

test('a local compact command without a CLI user record never advances the echo pointer', async t => {
  const { turns } = await reloadCommandFixture(t, { commands: [{ text: '/git-ai first', ts: NOW },
    { text: '/compact', ts: NOW + 1000 }, { text: '/git-ai second', ts: NOW + 2000 }],
  entries: [...commandEcho('git-ai', 'formatted first', NOW + 45000, 'first'), ...commandEcho('git-ai', 'formatted second', NOW + 90000, 'second')] });
  assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['divider', '上下文已压缩'],
    ['user', '/git-ai first'], ['assistant', '回答-first'], ['user', '/git-ai second'], ['assistant', '回答-second']]);
});

test('replaying the same stored submission ID creates no second journal row and consumes no extra CLI card', async t => {
  const command = { id: 'same-submission', text: '/git-ai whoami', ts: NOW };
  const { turns, saved } = await reloadCommandFixture(t, { commands: [command, command], entries: commandEcho('git-ai', 'whoami', NOW + 60000, 'once') });
  assert.equal(saved.length, 1);
  assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', '/git-ai whoami'], ['assistant', '回答-once']]);
});

test('complete forward reads follow transcript order and never move the pairing pointer backwards', () => {
  const { mergeCommandTurns } = require('../core/command-transcript-store');
  const cli = [{ id: 'earlier-entry', role: 'user', text: '/first terminal', ts: NOW + 2000 },
    { id: 'later-entry', role: 'user', text: '/second formatted', ts: NOW + 1000 }];
  const commands = [{ id: 'command:a', role: 'user', text: '/second original', ts: NOW, clientSubmissionId: 'a' },
    { id: 'command:b', role: 'user', text: '/first original', ts: NOW + 1, clientSubmissionId: 'b' }];
  const merged = mergeCommandTurns(cli, commands, { codeagent: true, fromTail: false, codeagentComplete: true });
  assert.equal(merged.find(turn => turn.id === 'command:a').ts, NOW + 1000);
  assert.equal(merged.find(turn => turn.id === 'command:b').ts, NOW + 1);
  assert.ok(merged.some(turn => turn.id === 'earlier-entry'), 'an earlier CLI input must not be stolen after advancing past it');
});

for (const [skew, expected] of [[5000, 1], [5001, 2]]) {
  test('CodeAgent send-window lower clock tolerance: ' + skew + ' ms', async t => {
    const { turns } = await reloadCommandFixture(t, { commands: [{ text: '/git-ai whoami', ts: NOW }],
      entries: commandEcho('git-ai', 'whoami', NOW - skew, 'early') });
    assert.equal(turns.filter(turn => turn.role === 'user').length, expected);
  });
}

test('one Hub command pairs only the first CLI echo and preserves a subsequent terminal send', async t => {
  const { turns } = await reloadCommandFixture(t, { commands: [{ text: '/git-ai original', ts: NOW }],
    entries: [...commandEcho('git-ai', 'formatted', NOW + 1000, 'first'), ...commandEcho('git-ai', 'direct terminal input', NOW + 10000, 'second')] });
  assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', '/git-ai original'], ['assistant', '回答-first'],
    ['user', '/git-ai direct terminal input'], ['assistant', '回答-second']]);
});

test('journal-only local commands and CLI-only terminal skills both survive reload', async t => {
  const journal = await reloadCommandFixture(t, { commands: [{ text: '/model', ts: NOW }] });
  assert.deepEqual(journal.turns, []);
  const cli = await reloadCommandFixture(t, { entries: commandEcho('git-ai', 'direct', NOW, 'direct') });
  assert.deepEqual(cli.turns.map(turn => [turn.role, turn.text]), [['user', '/git-ai direct'], ['assistant', '回答-direct']]);
});

test('a resting CodeAgent resume uses persisted session kind for command pairing', async t => {
  const { turns } = await reloadCommandFixture(t, { kind: 'codeagent-resume', live: false,
    commands: [{ text: '/GIT-AI whoami', ts: NOW }], entries: commandEcho('git-ai', 'whoami', NOW + 60000, 'resumed') });
  assert.deepEqual(turns.map(turn => [turn.role, turn.text]), [['user', '/GIT-AI whoami'], ['assistant', '回答-resumed']]);
});

test('non-CodeAgent reload retains legacy exact matching, timestamp window and original journal position', async t => {
  for (const [echoed, delay, expected] of [['whoami', 1000, 1], ['whoami reformatted', 1000, 2], ['whoami', 60000, 2]]) {
    const { turns } = await reloadCommandFixture(t, { kind: 'claude', requestKind: 'codeagent',
      commands: [{ text: '/git-ai whoami', ts: NOW }], entries: commandEcho('git-ai', echoed, NOW + delay, 'legacy') });
    assert.equal(turns.filter(turn => turn.role === 'user').length, expected);
    assert.equal(turns.find(turn => turn.source === 'hub-command').ts, NOW);
  }
});

test('ordinary user messages are unchanged and command-name matching never uses a prefix', async t => {
  const ordinary = await reloadCommandFixture(t, { commands: [{ text: '/git-ai whoami', ts: NOW }],
    entries: [user('normal', '普通消息', { timestamp: new Date(NOW + 1000).toISOString() }), answer('normal-answer', '普通回答', 'normal')] });
  assert.deepEqual(ordinary.turns.filter(turn => turn.role === 'user').map(turn => turn.text), ['/git-ai whoami', '普通消息']);
  const different = await reloadCommandFixture(t, { commands: [{ text: '/git-ai whoami', ts: NOW }],
    entries: commandEcho('git-ai-other', 'whoami', NOW + 1000, 'different') });
  assert.equal(different.turns.filter(turn => turn.role === 'user').length, 2);
});

test('explicit submission identities keep their existing match and cannot also consume a legacy echo', () => {
  const { mergeCommandTurns } = require('../core/command-transcript-store');
  const command = { id: 'command:known', role: 'user', text: '/git-ai original', ts: NOW, clientSubmissionId: 'known' };
  const explicit = { id: 'explicit', role: 'user', text: '/git-ai changed', ts: NOW + 1000, clientSubmissionId: 'known' };
  const legacy = { id: 'other', role: 'user', text: '/git-ai terminal', ts: NOW + 2000 };
  for (const codeagent of [false, true]) {
    const merged = mergeCommandTurns([explicit, legacy], [command], { codeagent });
    assert.deepEqual(merged.map(turn => turn.id), ['command:known', 'other']);
    assert.equal(merged[0], command); assert.equal(merged[0].ts, NOW);
  }
});

test('CodeAgent merge restores a raw command wrapper and uses its original CLI list position to break timestamp ties', () => {
  const { mergeCommandTurns } = require('../core/command-transcript-store');
  const echo = { id: 'echo', role: 'user', text: wrapper('changed'), ts: NOW + 1000 };
  const reply = { id: 'reply', role: 'assistant', text: 'reply', ts: echo.ts };
  const command = { id: 'command:known', role: 'user', text: '/GIT-AI original', ts: NOW, clientSubmissionId: 'known' };
  const merged = mergeCommandTurns([echo, reply], [command], { codeagent: true });
  assert.deepEqual(merged.map(turn => turn.id), ['command:known', 'reply']);
  assert.equal(merged[0].text, command.text); assert.equal(merged[0].ts, echo.ts); assert.equal(command.ts, NOW);
});

// 2026-11-07：系统 ConPTY 吞掉引号、破折号等符号（core/pty-host.js），落盘文字只比乐观气泡少几个符号，
// 以前对不上就显示两遍。只少符号要认领；文字不同（x>0 对 x<0）不能认领。
test('an optimistic card is claimed when the recorded prompt only lost symbols, never by a different prompt', () => {
  const f = cardFixture();
  const pending = f.renderer.mountOptimisticUserCard('hub-fixture', '只回复“完成”——别的不要→①', 'codeagent');
  const other = f.renderer.mountOptimisticUserCard('hub-fixture', 'x<0', 'codeagent');
  const ts = Date.now() + 1000;
  f.renderer.mountSessionTurnCard('hub-fixture', { id: 'old-user', role: 'user', text: 'x>0', ts });
  assert.ok(other.parentNode, 'x>0 must not claim x<0');
  f.renderer.mountSessionTurnCard('hub-fixture', { id: 'real-user', role: 'user', text: '只回复完成别的不要', ts });
  assert.equal(pending.parentNode, null, 'symbol-only difference is claimed');
  f.renderer.dispose();
});
