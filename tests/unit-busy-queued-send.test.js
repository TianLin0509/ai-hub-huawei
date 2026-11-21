'use strict';
// 上一条没跑完时发的第二条（终端会话由 CLI 自己排队）：CLI 没执行时要把原文交还界面（core/busy-queued-watch.js，rsi-q）。
// 以前 Hub 记成「已送达」就不管了：CLI 退出、重启、Esc 中断后退回自己的输入框，这条都静默消失。全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createBusyQueuedWatch, fileUserPromptCount, textConsumed } = require('../core/busy-queued-watch');

function harness(overrides = {}) {
  const state = { alive: true, token: 'pty-1', active: true, exited: false, transcript: 0, now: 1000, notes: [], late: [] };
  const watch = createBusyQueuedWatch({
    isSessionAlive: () => state.alive, processToken: () => state.token, isTurnActive: () => state.active,
    cliExited: () => state.exited, transcriptPromptCount: () => state.transcript, notify: p => state.notes.push(p),
    notifyExecuted: p => state.late.push(p),
    now: () => state.now, settleMs: 10000, autoStart: false, logger: { warn() {} }, ...overrides,
  });
  return { state, watch };
}

test('上一轮还在跑时不判；结束后空闲满 settle 仍没执行 → 原文交还界面', () => {
  const { state, watch } = harness();
  watch.track({ sessionId: 's1', clientSubmissionId: 'c2', text: '第二条：顺便把测试也跑了', dispatchedAt: 1000 });
  for (let i = 0; i < 5; i++) { state.now += 3000; watch.tick(); }
  assert.equal(state.notes.length, 0, '回合进行中（CLI 可能把它并进当前这一轮）不提醒');
  state.active = false;
  state.now += 3000; watch.tick();
  state.now += 5000; watch.tick();
  assert.equal(state.notes.length, 0, '刚结束、还没到 settle');
  state.now += 6000; watch.tick();
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].code, 'queued-not-started');
  assert.equal(state.notes[0].text, '第二条：顺便把测试也跑了');
  assert.equal(state.notes[0].clientSubmissionId, 'c2');
  state.now += 20000; watch.tick();
  assert.equal(state.notes.length, 1, '只提醒一次');
});

test('新回合带来的原文包含这条（含 CLI 把多条排队消息拼成一条）→ 视为已执行', () => {
  const { state, watch } = harness();
  watch.track({ sessionId: 's1', clientSubmissionId: 'c2', text: 'second  one', dispatchedAt: 1000 });
  watch.observePrompt('s1', 'first queued\nsecond one');
  state.active = false;
  for (let i = 0; i < 10; i++) { state.now += 3000; watch.tick(); }
  assert.equal(state.notes.length, 0);
  assert.equal(watch.pending('s1').length, 0);
});

test('同文不同提交 ID：一次回执只消费最早一条，合并原文按出现次数逐条消费', () => {
  const { watch } = harness();
  for (const id of ['a', 'b', 'c']) watch.track({ sessionId: 's1', clientSubmissionId: id, text: 'same' });
  watch.observePrompt('s1', 'same');
  assert.deepEqual(watch.pending('s1').map(x => x.clientSubmissionId), ['b', 'c']);
  watch.observePrompt('s1', 'same\nsame');
  assert.equal(watch.pending('s1').length, 0);
});

test('已报告与看护中的同文提交共用一份回执证据；重发只撤最早一条', () => {
  const { watch, state } = harness();
  for (const id of ['a', 'b']) watch.track({ sessionId: 's1', clientSubmissionId: id, text: 'same' });
  state.active = false;
  watch.tick(); state.now += 11000; watch.tick();
  watch.track({ sessionId: 's1', clientSubmissionId: 'c', text: 'same' });
  watch.noteSubmitted('s1', 'same');
  assert.deepEqual(watch.reportedPending('s1').map(x => x.clientSubmissionId), ['b']);
  watch.observePrompt('s1', 'same');
  assert.deepEqual(state.late.map(x => x.clientSubmissionId), ['b']);
  assert.deepEqual(watch.pending('s1').map(x => x.clientSubmissionId), ['c']);
});

test('CLI 合并不同原文可确认多条，但重叠子串不复用证据', () => {
  const { watch } = harness();
  for (const [id, text] of [['a', 'alpha'], ['b', 'beta'], ['c', 'alpha']]) {
    watch.track({ sessionId: 's1', clientSubmissionId: id, text });
  }
  watch.observePrompt('s1', 'alpha\nbeta');
  assert.deepEqual(watch.pending('s1').map(x => x.clientSubmissionId), ['c']);
});

test('tick 同文排队按发送顺序核销次数，连续轮询不能复用一条转写', () => {
  for (const restarted of [false, true]) {
    const { watch, state } = harness({ transcriptPromptCount: () => 1 });
    // 插入顺序与发送顺序相反，核销仍必须优先最早发送的 a。
    watch.track({ sessionId: 's1', clientSubmissionId: 'b', text: '继续', dispatchedAt: 1100 });
    watch.track({ sessionId: 's1', clientSubmissionId: 'a', text: '继续', dispatchedAt: 1000 });
    state.active = false;
    if (restarted) state.token = 'pty-2';
    watch.tick(); state.now += 11000; watch.tick();
    assert.deepEqual(state.notes.map(x => x.clientSubmissionId), ['b']);
    assert.equal(state.notes[0].code, restarted ? 'cli-restarted' : 'queued-not-started');
    state.now += 2000; watch.tick();
    assert.deepEqual(watch.reportedPending('s1').map(x => x.clientSubmissionId), ['b']);
    assert.equal(state.late.length, 0, '下一次 tick 不能用 a 的转写撤掉 b');
  }
});

test('迟到窗口同文两条只有一次转写，只撤最早一条，新增第二次执行才撤余下那条', () => {
  let count = 0;
  const { watch, state } = harness({ transcriptPromptCount: () => count });
  for (const id of ['a', 'b']) watch.track({ sessionId: 's1', clientSubmissionId: id, text: '继续' });
  state.active = false;
  watch.tick(); state.now += 11000; watch.tick();
  assert.equal(state.notes.length, 2);
  count = 1;
  watch.tick(); watch.tick();
  assert.deepEqual(state.late.map(x => x.clientSubmissionId), ['a']);
  assert.deepEqual(watch.reportedPending('s1').map(x => x.clientSubmissionId), ['b']);
  count = 2; watch.tick();
  assert.deepEqual(state.late.map(x => x.clientSubmissionId), ['a', 'b']);
});

test('转写按每条发送时间过滤，早于第二次发送的执行不能核销第二条', () => {
  let executions = [1050];
  const { watch, state } = harness({ transcriptPromptCount: (_sid, _text, since) => executions.filter(ts => ts >= since).length });
  watch.track({ sessionId: 's1', clientSubmissionId: 'a', text: '继续', dispatchedAt: 1000 });
  watch.track({ sessionId: 's1', clientSubmissionId: 'b', text: '继续', dispatchedAt: 1100 });
  state.active = false;
  watch.tick(); state.now += 11000; watch.tick(); watch.tick();
  assert.deepEqual(state.notes.map(x => x.clientSubmissionId), ['b']);
  assert.equal(state.late.length, 0);
  executions.push(1200); watch.tick();
  assert.deepEqual(state.late.map(x => x.clientSubmissionId), ['b']);
});

test('回执已确认的同文提交占用转写证据，不能再次核销剩下的提交', () => {
  for (const resolve of [w => w.resolve('s1', 'a'), w => w.observePrompt('s1', '继续')]) {
    const { watch, state } = harness({ transcriptPromptCount: () => 1 });
    for (const id of ['a', 'b']) watch.track({ sessionId: 's1', clientSubmissionId: id, text: '继续' });
    resolve(watch);
    state.active = false;
    watch.tick(); state.now += 11000; watch.tick(); watch.tick();
    assert.deepEqual(state.notes.map(x => x.clientSubmissionId), ['b']);
    assert.equal(state.late.length, 0);
  }
});

test('回执确认（resolve）或 transcript 里找到（Claude 中途补充并进当前一轮）→ 不提醒', () => {
  const a = harness();
  a.watch.track({ sessionId: 's1', clientSubmissionId: 'c2', text: 'x', dispatchedAt: 1000 });
  a.watch.resolve('s1', 'c2');
  a.state.active = false;
  for (let i = 0; i < 10; i++) { a.state.now += 3000; a.watch.tick(); }
  assert.equal(a.state.notes.length, 0);
  const b = harness();
  b.state.transcript = 1;
  b.watch.track({ sessionId: 's1', clientSubmissionId: 'c2', text: 'x', dispatchedAt: 1000 });
  b.state.active = false;
  for (let i = 0; i < 10; i++) { b.state.now += 3000; b.watch.tick(); }
  assert.equal(b.state.notes.length, 0);
});

// rsi-q 返工 3：终端尾部像命令行提示符（回答里出现「$」结尾的行）只是弱证据，回合还在进行时不能据此判 CLI 已退出。
test('回合还在进行时，终端尾部像命令行提示符不算 CLI 退出；回合结束后才采信', () => {
  const { state, watch } = harness();
  watch.track({ sessionId: 's1', clientSubmissionId: 'c2', text: '第二条', dispatchedAt: 1000 });
  state.exited = true;
  for (let i = 0; i < 5; i++) { state.now += 2000; watch.tick(); }
  assert.equal(state.notes.length, 0, '回合进行中不采信');
  state.active = false;
  state.now += 2000; watch.tick();
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].code, 'cli-restarted');
});

// rsi-q 返工 4：报告后 CLI 迟到执行，界面上的重发提示要撤下（否则用户照做会重复执行）。
test('报告没执行后 2 分钟内 CLI 迟到执行（新回合原文 / 回执 / transcript）→ 通知界面撤下提示；超过窗口不再管', () => {
  for (const late of [(w) => w.observePrompt('s1', '第二条'), (w) => w.resolve('s1', 'c2'), (w, st) => { st.transcript = 1; w.tick(); }]) {
    const { state, watch } = harness();
    watch.track({ sessionId: 's1', clientSubmissionId: 'c2', text: '第二条', dispatchedAt: 1000 });
    state.active = false;
    watch.tick(); state.now += 11000; watch.tick();
    assert.equal(state.notes.length, 1);
    assert.equal(watch.reportedPending('s1').length, 1);
    state.now += 30000;
    late(watch, state);
    assert.equal(state.late.length, 1);
    assert.equal(state.late[0].clientSubmissionId, 'c2');
    assert.equal(watch.reportedPending('s1').length, 0);
  }
  const { state, watch } = harness();
  watch.track({ sessionId: 's1', clientSubmissionId: 'c2', text: '第二条', dispatchedAt: 1000 });
  state.active = false;
  watch.tick(); state.now += 11000; watch.tick();
  state.now += 121000; watch.tick();
  watch.observePrompt('s1', '第二条');
  assert.equal(state.late.length, 0, '窗口过了不再撤');
});

test('用户自己点了重发（同一段原文又发了一次）：之后的执行是这次重发，不当成迟到执行', () => {
  const { state, watch } = harness();
  watch.track({ sessionId: 's1', clientSubmissionId: 'c2', text: '第二条', dispatchedAt: 1000 });
  state.active = false;
  watch.tick(); state.now += 11000; watch.tick();
  watch.noteSubmitted('s1', '第二条');
  watch.observePrompt('s1', '第二条');
  assert.equal(state.late.length, 0);
});

test('CLI 进程换了（重启 / 重连）、退回命令行、会话进程没了 → 立即提醒 cli-restarted', () => {
  for (const change of [s => { s.token = 'pty-2'; }, s => { s.exited = true; s.active = false; }, s => { s.alive = false; }]) {
    const { state, watch } = harness();
    watch.track({ sessionId: 's1', clientSubmissionId: 'c2', text: '第二条', dispatchedAt: 1000 });
    change(state);
    state.now += 2000; watch.tick();
    assert.equal(state.notes.length, 1);
    assert.equal(state.notes[0].code, 'cli-restarted');
  }
});

test('transcript 证据：Claude 排队附件 / 普通 user 记录、Codex user_message；早于发送的旧记录不算', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-queued-'));
  const since = Date.parse('2026-11-21T01:00:10Z');
  const claude = path.join(dir, 'c.jsonl');
  fs.writeFileSync(claude, [
    JSON.stringify({ type: 'user', timestamp: '2026-11-21T01:00:00Z', message: { role: 'user', content: '旧的一条' } }),
    JSON.stringify({ type: 'attachment', timestamp: '2026-11-21T01:00:20Z', uuid: 'a1', attachment: { type: 'queued_command', origin: { kind: 'human' }, humanTurn: true, commandMode: 'prompt', prompt: '顺便 跑测试', source_uuid: 'u2' } }),
  ].join('\n'));
  assert.equal(fileUserPromptCount(claude, '顺便跑测试', since, { kind: 'claude' }), 1);
  assert.equal(fileUserPromptCount(claude, '旧的一条', since, { kind: 'claude' }), 0, '发送之前的同文记录不算');
  assert.equal(fileUserPromptCount(claude, '没出现过', since, { kind: 'claude' }), 0);
  const codex = path.join(dir, 'r.jsonl');
  fs.writeFileSync(codex, JSON.stringify({ type: 'event_msg', timestamp: '2026-11-21T01:00:30Z', payload: { type: 'user_message', message: 'steer me' } }));
  assert.equal(fileUserPromptCount(codex, 'steer me', since, { kind: 'codex' }), 1);
  assert.equal(fileUserPromptCount(null, 'x', since), 0);
  assert.equal(textConsumed('a\nb', ''), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('转写计数：严格发送时间、合并同文次数、Claude 附件与 Codex 多种落盘去重', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-count-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'count.jsonl');
  const since = Date.parse('2026-11-21T01:00:10Z');
  const timestamp = '2026-11-21T01:00:20Z';
  const write = entries => fs.writeFileSync(file, entries.map(x => JSON.stringify(x)).join('\n'));
  write([
    { type: 'user', timestamp: '2026-11-21T01:00:09Z', message: { content: '继续' } },
    { type: 'user', message: { content: '继续' } },
    { type: 'attachment', timestamp, attachment: { type: 'queued_command', origin: { kind: 'human' }, humanTurn: true, commandMode: 'prompt', prompt: '继续\n继续', source_uuid: 'u1' } },
    { type: 'user', timestamp, uuid: 'u1', message: { content: '继续\n继续' } },
    { type: 'user', timestamp, uuid: 'u2', message: { content: '继续' } },
  ]);
  assert.equal(fileUserPromptCount(file, '继续', since), 3);
  write([
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: '继续' } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ input_text: '继续' }] } },
    { type: 'event_msg', timestamp, payload: { type: 'item_completed', item: { type: 'UserMessage', content: '继续' } } },
  ]);
  assert.equal(fileUserPromptCount(file, '继续', since, { kind: 'codex' }), 1);
});

// 走真实的 prompt-submit-handlers：忙时发出且只拿到「已送达、未逐字确认」的那条，回执带 queuedWhileBusy，
// 上一轮结束后没执行就向界面发 session:queued-prompt-unsent（带原文）；之后 UserPromptSubmit 带来原文则不发。
function submitHarness(transcriptTap) {
  const groupChatWatcher = require('../core/group-chat-watcher');
  const original = groupChatWatcher.sendToPty;
  groupChatWatcher.sendToPty = async () => ({ ok: true, sendStatus: 'ok', enterAttempts: 1, acknowledgementSource: 'pty-input-cleared' });
  const manager = new EventEmitter();
  const st = { active: true, now: 1000 };
  manager.getSession = id => (id === 's1' ? { kind: 'claude', agentRuntime: 'pty' } : null);
  manager.isAgentTurnActive = () => st.active;
  manager.getSessionProcessToken = () => 'pty-1';
  manager.getSessionBuffer = () => '';
  const sent = [];
  const handlers = new Map();
  const { registerPromptSubmitIpc } = require('../main/ipc/prompt-submit-handlers');
  const reg = registerPromptSubmitIpc({ handle: (n, fn) => handlers.set(n, fn) }, {
    sessionManager: manager, transcriptTap, sendToRenderer: (channel, payload) => sent.push({ channel, payload }), logger: { warn() {}, log() {} },
    busyQueuedOptions: { autoStart: false, settleMs: 5000, now: () => st.now },
  });
  return { manager, st, sent, handlers, reg, restore() { groupChatWatcher.sendToPty = original; reg.dispose(); } };
}

test('提交链路真实转写：两次忙时同文发送，CLI 只落盘一次，只报告第二条未执行', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-submit-count-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'transcript.jsonl');
  const tap = new EventEmitter();
  tap.getClaudeTranscriptPath = () => file;
  const h = submitHarness(tap);
  try {
    for (const id of ['a', 'b']) await h.handlers.get('session:send-prompt')(null,
      { sessionId: 's1', text: '继续', clientSubmissionId: id });
    fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() + 100).toISOString(), message: { content: '继续' } }));
    const busy = h.reg._test.busyQueued;
    h.st.now = Date.now() + 200;
    h.st.active = false;
    busy.tick(); h.st.now += 6000; busy.tick(); busy.tick();
    assert.deepEqual(h.sent.filter(x => x.channel === 'session:queued-prompt-unsent').map(x => x.payload.clientSubmissionId), ['b']);
    assert.equal(h.sent.filter(x => x.channel === 'session:queued-prompt-executed').length, 0);
  } finally { h.restore(); }
});

test('提交链路：忙时发出的那条，回执带 queuedWhileBusy；上一轮结束后没执行 → 界面收到原文', async () => {
  const h = submitHarness();
  try {
    const got = await h.handlers.get('session:send-prompt')(null, { sessionId: 's1', text: '第二条消息', clientSubmissionId: 'c2' });
    assert.equal(got.ok, true);
    assert.equal(got.queuedWhileBusy, true);
    const busy = h.reg._test.busyQueued;
    h.st.active = false;
    busy.tick(); h.st.now += 6000; busy.tick();
    const notes = h.sent.filter(x => x.channel === 'session:queued-prompt-unsent');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].payload.text, '第二条消息');
    assert.equal(notes[0].payload.sessionId, 's1');
  } finally { h.restore(); }
});

test('提交链路：之后 CLI 真的执行了（UserPromptSubmit 带原文）→ 不提醒；空闲时发的不看护', async () => {
  const h = submitHarness();
  try {
    await h.handlers.get('session:send-prompt')(null, { sessionId: 's1', text: '第二条消息', clientSubmissionId: 'c2' });
    h.manager.emit('agent-turn-started', { sessionId: 's1', signalSource: 'claude-user-prompt-submit', prompt: '第二条消息', observedAt: h.st.now + 10 });
    const busy = h.reg._test.busyQueued;
    h.st.active = false;
    busy.tick(); h.st.now += 6000; busy.tick();
    assert.equal(h.sent.filter(x => x.channel === 'session:queued-prompt-unsent').length, 0);
    const idle = await h.handlers.get('session:send-prompt')(null, { sessionId: 's1', text: '空闲时的一条', clientSubmissionId: 'c3' });
    assert.equal(idle.queuedWhileBusy, undefined);
    assert.equal(busy.pending('s1').length, 0);
  } finally { h.restore(); }
});

test('界面：收到 queued-prompt-unsent 放回输入框、挂「确认没收到，重发」条；忙时发出给「已排在终端里」提示', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(src, /ipcRenderer\.on\('session:queued-prompt-unsent', \(_event, payload\) => handleQueuedPromptUnsent\(payload\)\)/);
  assert.match(src, /bar\._resendStrip\.show\(entry\)/);
  assert.match(src, /uncertain: true/);
  // 返工 1：输入框非空不覆盖，提示按实际说；重发条有新草稿时直接发原文
  const has = needle => assert.ok(src.includes(needle), needle);
  has("if (inputBox && !readContenteditablePlainText(inputBox).trim()) { replaceContenteditableText(inputBox, text)");
  has('原文在输入框上方的重发条里，输入框里正在写的内容没动');
  has('} else sendInput(text);');
  assert.match(src, /if \(!override\) \{\s*replaceContenteditableText\(inputBox, ''\);/);
  // 返工 2：后台会话追加不覆盖；发送时只撤同文那条
  has('rememberPending(composerResendPending, sessionId, entry)');
  has('bar._resendStrip?.forgetText(text);');
  // 返工 4：迟到执行撤提示
  has("ipcRenderer.on('session:queued-prompt-executed', (_event, payload) => handleQueuedPromptExecuted(payload))");
  assert.match(src, /if \(wasRunning && !nativeCommand && session\?\.agentRuntime === 'pty'[^\n]*\n[^\n]*\n\s*showToast\('上一条还没跑完：这条已排在终端里/);
});
