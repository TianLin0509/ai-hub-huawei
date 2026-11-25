'use strict';
// R38（WeLink 反馈第 19 轮，v5.6.105）：群聊小队模式里 DSH 成员收不到派工、回复传不回来。
// 根因：群聊等待「答完」时，ACP 类 kind（deepseek-acp）只认 'acp' 来源；群聊里的 DSH 跑在终端（DSH CLI），
// 回合结束事件来源是 'provider-cli'，被当成不可信信号整条丢掉，成员一直「思考中」，负责人收不到交回。
// 这里用真实的 DshCliSession 喂 DSH 事件日志格式（turn/start → user/message → assistant/message → turn/end，
// 字段与本机 ~/.claude-session-hub/acp/*/home/.dsh/hub-events 里的真实记录一致），不启动真实 DSH 进程。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DshCliSession, sameSubmittedText } = require('../core/dsh-cli-session');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher');
const { createSquadEngine } = require('../main/groupchat/squad-engine');
const P = require('../core/squad-protocol');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 一个已连上的 DSH 终端会话：Hub 往终端写入，按回车后由「DSH」按真实事件格式回放这一轮。
function fakeDsh({ answer = text => `结论：已完成。\n依据：${text.split('\n')[1] || ''}`, prefix = '', autoFinish = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r38-dsh-'));
  const s = new DshCliSession({ id: 's2', kind: 'deepseek-acp', home });
  s.seen = new Set();
  s.ready = Promise.resolve();
  s.routeChecked = true;
  s.threadId = 'th-1';
  s.runtime = { ...s.runtime, connection: 'connected', state: 'idle' };
  let seq = 100, turn = 0, typed = '';
  const delivered = [];
  const finishers = [];
  s.pty = {
    write(chunk) {
      if (chunk !== '\r') { typed += chunk; s.output += chunk.replace(/\x1b\[20[01]~/g, ''); return; }
      const text = typed.replace(/\x1b\[20[01]~/g, '');
      typed = '';
      turn += 1;
      const t = turn, at = Date.now();
      delivered.push(text);
      setImmediate(() => {
        s.event({ seq: seq++, type: 'turn/start', time: at, data: { turn: t } });
        s.event({ seq: seq++, type: 'user/message', time: at + 1, data: { id: `u${t}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prefix + text }] } });
        const finish = () => {
          s.event({ seq: seq++, type: 'assistant/message', time: at + 2, data: { message: { content: [{ type: 'text', text: answer(text) }] }, usage: { inputTokens: 10, outputTokens: 5 } } });
          s.event({ seq: seq++, type: 'turn/end', time: at + 3, data: { turn: t, reason: { kind: 'completed' } } });
        };
        if (autoFinish) setTimeout(finish, 20); else finishers.push(finish);
      });
    },
  };
  const cleanup = () => fs.rmSync(home, { recursive: true, force: true });
  return { s, delivered, finishers, cleanup };
}

// 与 main.js 一致：DSH 会话的 lifecycle 事件原样转给 transcriptTap，群聊等待器在 tap 上听。
function tapFor(s) {
  const tap = new EventEmitter();
  s.on('lifecycle', ev => tap.emit(ev.type, ev));
  return tap;
}

function waitFor(s, tap, receipt, attemptId) {
  const attempt = { attemptId, sid: 's2', kind: 'deepseek-acp', providerTurnId: receipt.turnId, startedAt: Date.now() - 1000 };
  const rejected = [];
  const watcher = createTurnCompletionWatcher({ transcriptTap: tap, hubSessionId: 's2', label: 'DSH', kind: 'deepseek-acp',
    nativeOnly: true, attempt, onEventRejected: e => rejected.push(e.reason) });
  return { watcher, rejected, waiting: watcher.wait() };
}

test('派工送达：小队任务经 DSH 终端写入，DSH 记下的用户消息带终端残留前缀也认得出这条回执', async () => {
  const { s, delivered, cleanup } = fakeDsh({ prefix: ';1_', autoFinish: false });
  try {
    const prompt = P.memberPrompt('只回复三个水果的中文名', { leaderLabel: '成员 1' });
    const receipt = await s.send(prompt, { clientSubmissionId: 'gca-m2-1' });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0], prompt);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.sendStatus, 'ok');
    assert.equal(receipt.acknowledgementSource, 'provider-cli');
    assert.equal(receipt.turnId, '1');
    assert.equal(receipt.clientSubmissionId, 'gca-m2-1');
  } finally { cleanup(); }
});

test('回执比对只放宽首尾空白与几个字符的终端残留，不把别的消息认成这一条', () => {
  assert.equal(sameSubmittedText('任务正文', '任务正文'), true);
  assert.equal(sameSubmittedText('任务正文\n', '任务正文'), true);
  assert.equal(sameSubmittedText('任务正文', ';1_任务正文'), true);
  assert.equal(sameSubmittedText('任务正文', '另一条任务正文的很长前缀任务正文'), false);
  assert.equal(sameSubmittedText('任务正文', '上一行\n任务正文'), false);
  assert.equal(sameSubmittedText('任务正文', '任务正文（改过）'), false);
  assert.equal(sameSubmittedText(undefined, '任务正文'), false);
});

test('回复回传：DSH 一轮结束（provider-cli 来源）后群聊等待器收尾，拿到 DSH 的最终回答', async () => {
  const { s, finishers, cleanup } = fakeDsh({ autoFinish: false });
  try {
    const tap = tapFor(s);
    const prompt = P.memberPrompt('把水果名翻译成英文', { leaderLabel: '成员 1' });
    const receipt = await s.send(prompt, { clientSubmissionId: 'gca-m2-2' });
    const { waiting, rejected } = waitFor(s, tap, receipt, 'gca-m2-2');
    finishers.shift()();
    const result = await Promise.race([waiting, sleep(1000).then(() => null)]);
    assert.ok(result, `DSH 的回答没有交回，等待器拒收原因：${rejected.join(',') || '无'}`);
    assert.equal(result.status, 'completed');
    assert.equal(result.signalSource, 'provider-cli');
    assert.match(result.text, /^结论：已完成。/);
    assert.equal(result.providerTurnId, '1');
  } finally { cleanup(); }
});

test('回复回传：DSH 在等待器挂上前已答完，补读到的结局（readOutcome）同样能收尾', async () => {
  const { s, finishers, cleanup } = fakeDsh({ autoFinish: false });
  try {
    const tap = new EventEmitter();          // 不转 lifecycle：只靠补读
    const receipt = await s.send(P.memberPrompt('摸底代码', { leaderLabel: '成员 1' }), { clientSubmissionId: 'gca-m2-3' });
    finishers.shift()();
    const { watcher, waiting } = waitFor(s, tap, receipt, 'gca-m2-3');
    watcher.observeNativeOutcome(await s.readOutcome(receipt.turnId));
    const result = await Promise.race([waiting, sleep(500).then(() => null)]);
    assert.ok(result, '补读到的 DSH 结局被丢掉了');
    assert.equal(result.status, 'completed');
    assert.match(result.text, /^结论：已完成。/);
  } finally { cleanup(); }
});

test('来源把关不放松：ACP 类成员的屏幕猜测类信号仍不算答完；千问终端版的 qwen-cli 算', async () => {
  for (const [source, expected] of [['pty_scan', false], ['stop_reason_terminal', false], ['qwen-cli', true], ['acp', true]]) {
    const tap = new EventEmitter();
    const attempt = { attemptId: 'a', sid: 's2', kind: 'deepseek-acp', providerTurnId: '7', startedAt: 1 };
    const w = createTurnCompletionWatcher({ transcriptTap: tap, hubSessionId: 's2', label: 'x', kind: 'deepseek-acp', nativeOnly: true, attempt });
    let done = false;
    const waiting = w.wait().then(() => { done = true; });
    tap.emit('turn-complete', { type: 'turn-complete', hubSessionId: 's2', turnId: '7', status: 'completed', signalSource: source, completedAt: Date.now(), text: '好' });
    await sleep(5);
    assert.equal(done, expected, source);
    if (!done) w.skip();
    await waiting;
  }
});

// 小队整链：负责人（假）派工 → DSH 成员（真实 DshCliSession + 真实等待器）→ 自动交回负责人。
function squadWith({ dshResult, interrupted = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r38-squad-'));
  const meeting = { id: 'g1', groupChat: true, subSessions: ['s1', 's2'], participants: [0, 1] };
  const members = [
    { sid: 's1', index: 0, memberId: 'm1', displayName: '成员 1', kind: 'codex', aliases: ['m1'] },
    { sid: 's2', index: 1, memberId: 'm2', displayName: '成员 2', kind: 'deepseek-acp', aliases: ['m2'] },
  ];
  const dsh = fakeDsh();
  const tap = tapFor(dsh.s);
  const notes = [], leaderInputs = [];
  let leaderTurn = 0, n = 0;
  const leaderReplies = ['拆一步。\n【派工·依次】\n@m2：只回复三个水果的中文名', '验收通过：苹果、香蕉、橙子。'];
  const dispatcher = {
    async dispatchGroupChatTurn(_id, args) {
      n += 1;
      const ids = args.targetMemberIds;
      if (ids.includes('m1')) {
        leaderInputs.push(args.userInput);
        return { status: 'completed', turnNum: n, results: [{ sid: 's1', status: 'completed', text: leaderReplies[Math.min(leaderTurn++, 1)] }] };
      }
      if (dshResult) return { status: 'completed', turnNum: n, ...(interrupted ? { interrupted: true } : {}), results: [{ sid: 's2', ...dshResult }] };
      const prompt = args.perMemberInput.m2;
      const receipt = await dsh.s.send(prompt, { clientSubmissionId: `gca-m2-${n}` });
      if (!receipt.ok) return { status: 'completed', turnNum: n, results: [{ sid: 's2', status: 'errored', text: '', reason: receipt.sendStatus }] };
      const { waiting } = waitFor(dsh.s, tap, receipt, `gca-m2-${n}`);
      const settled = await Promise.race([waiting, sleep(1500).then(() => ({ sid: 's2', status: 'errored', text: '', reason: 'hard_timeout' }))]);
      return { status: 'completed', turnNum: n, results: [settled] };
    },
  };
  const engine = createSquadEngine({
    getHubDataDir: () => dir,
    meetingManager: { getMeeting: id => (id === 'g1' ? meeting : null) },
    getDispatcher: () => dispatcher,
    getMembers: () => members,
    ensureMemberReady: async () => {},
    getOrchestrator: () => ({ appendSystemNote: (_turn, text) => notes.push(text) }),
    logger: { warn: () => {}, log: () => {} },
  });
  const waitIdle = async () => {
    for (let i = 0; i < 400; i += 1) {
      const run = engine.view('g1').run;
      if (run && ['done', 'limit', 'stopped', 'error'].includes(run.status)) return run;
      await sleep(10);
    }
    throw new Error('squad run did not settle');
  };
  const cleanup = () => { dsh.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { engine, dsh, notes, leaderInputs, waitIdle, cleanup, base: (id, args) => dispatcher.dispatchGroupChatTurn(id, args) };
}

test('小队整链：DSH 成员收到派工、回答交回负责人，和 Codex 成员同等对待', async () => {
  const t = squadWith();
  try {
    t.engine.configure('g1', { enabled: true });
    await t.engine.userTurn('g1', { userInput: '让 m2 说三个水果' }, t.base);
    const run = await t.waitIdle();
    assert.equal(run.status, 'done');
    assert.equal(t.dsh.delivered.length, 1);
    assert.match(t.dsh.delivered[0], /只回复三个水果的中文名/);
    assert.deepEqual(run.steps.map(s => s.state), ['done']);
    assert.equal(t.leaderInputs.length, 2);
    assert.match(t.leaderInputs[1], /@m2 成员 2：已交回/);
    assert.deepEqual(t.notes, []);
  } finally { t.cleanup(); }
});

test('解析失败提示：DSH 成员的回答没取回时，群里写一行人话（哪个成员、什么原因），交回负责人时也说明', async () => {
  const t = squadWith({ dshResult: { status: 'errored', text: '', reason: 'hard_timeout' } });
  try {
    t.engine.configure('g1', { enabled: true });
    await t.engine.userTurn('g1', { userInput: '让 m2 说三个水果' }, t.base);
    const run = await t.waitIdle();
    assert.deepEqual(run.steps.map(s => s.state), ['failed']);
    assert.ok(t.notes.includes('小队成员 @成员 2 的回答没能交回负责人：长时间没收到它答完的信号。'), t.notes.join('\n'));
    assert.match(t.leaderInputs[1], /@m2 成员 2：没有完成（长时间没收到它答完的信号）/);
  } finally { t.cleanup(); }
});

test('完成了但回答是空的：同样提示，不静默当作交回', async () => {
  const t = squadWith({ dshResult: { status: 'completed', text: '' } });
  try {
    t.engine.configure('g1', { enabled: true });
    await t.engine.userTurn('g1', { userInput: '让 m2 说三个水果' }, t.base);
    await t.waitIdle();
    assert.ok(t.notes.includes('小队成员 @成员 2 的回答没能交回负责人：交回的内容是空的。'), t.notes.join('\n'));
  } finally { t.cleanup(); }
});

test('新增提示有英文', () => {
  const dict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'core', 'i18n', 'locales', 'en', 'rooms-area.json'), 'utf8'));
  assert.ok(dict['小队成员 @{0} 的回答没能交回负责人：{1}。']);
  for (const zh of ['长时间没收到它答完的信号', '它的 CLI 还没启动好，任务没送到', '没能确认它收到了任务', '交回的内容是空的'])
    assert.equal(typeof dict[zh], 'string', zh);
  assert.equal(P.reasonText('hard_timeout'), '长时间没收到它答完的信号');
});

// 经真实群聊派发器（main/groupchat/dispatcher.js + 真实群聊编排状态）：派工写进 DSH 终端 → 回执带回本轮编号 →
// 只靠补读 DSH 结局（不转 lifecycle）也能收尾。回执里没有本轮编号时补读查不到，这一轮会一直挂着（审查 P1-1）。
test('真实派发器：DSH 回执带回本轮编号，补读结局收尾，群聊记录里是 DSH 的回答', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r38-dispatch-'));
  const { s, delivered, cleanup } = fakeDsh();
  const tap = new EventEmitter();          // 故意不转 DSH 的 lifecycle：只剩补读这一条路
  const tapProxy = new Proxy(tap, { get: (t, k) => (k in t ? (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) : () => null) });
  const meeting = { id: 'g-r38', groupChat: true, subSessions: ['s2'], participants: [0] };
  const session = { id: 's2', kind: 'deepseek-acp', title: '成员 2', status: 'idle' };
  const sessionManager = { getSession: sid => (sid === 's2' ? session : null), getNativeSession: sid => (sid === 's2' ? s : null), on() {}, removeListener() {} };
  const groupchat = require('../core/group-chat-orchestrator');
  const dispatcher = require('../main/groupchat/dispatcher').createGroupChatDispatcher({
    getHubDataDir: () => dir, meetingManager: { getMeeting: id => (id === meeting.id ? meeting : null) },
    groupchat, sessionManager, transcriptTap: tapProxy, maybeAutoTitleMeetingFromPrompt() {},
    sendToRenderer() {}, logger: { warn() {}, log() {} }, isCodexBaseKind: () => false,
  });
  try {
    const prompt = P.memberPrompt('只回复三个水果的中文名', { leaderLabel: '成员 1' });
    const res = await Promise.race([
      dispatcher.dispatchGroupChatTurn(meeting.id, { userInput: '负责人派给 @成员 2：只回复三个水果的中文名', targetMemberIds: ['m1'],
        perMemberInput: { m1: prompt }, appendUserMessage: false, dispatchMode: 'squad',
        workflowRun: { kind: 'squad', runId: 'squad-r38-1', stepIndex: 0, attempt: 1 } }),
      sleep(5000).then(() => null),
    ]);
    assert.ok(res, '真实派发器这一轮没有收尾（补读没查到 DSH 的结局）');
    assert.equal(delivered.length, 1);
    assert.match(delivered[0], /只回复三个水果的中文名/);
    const item = res.results.find(r => r.sid === 's2');
    assert.equal(item.status, 'completed');
    assert.match(item.text, /^结论：已完成。/);
    assert.equal(item.providerTurnId, '1');
  } finally {
    try { groupchat.cleanup?.(meeting.id); } catch { /* 测试目录随后整体删除 */ }
    cleanup(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('停止本轮：成员这一轮被中断时就地停下，不提示「没能交回」，也不交回负责人', async () => {
  const t = squadWith({ dshResult: { status: 'interrupted', text: '' }, interrupted: true });
  try {
    t.engine.configure('g1', { enabled: true });
    const engine = t.engine;
    await engine.userTurn('g1', { userInput: '让 m2 说三个水果' }, t.base);
    for (let i = 0; i < 100 && !['stopped', 'done', 'error'].includes(engine.view('g1').run?.status); i += 1) await sleep(10);
    assert.equal(engine.view('g1').run.status, 'stopped');
    assert.equal(t.leaderInputs.length, 1, '不应交回负责人');
    assert.deepEqual(t.notes.filter(n => /没能交回/.test(n)), []);
  } finally { t.cleanup(); }
});

test('真机失败码与异常原文换成人话，不露英文代码和本地路径', () => {
  assert.equal(P.reasonText('response_timeout'), '长时间没收到它答完的信号');
  assert.equal(P.reasonText('provider_error'), '它这一轮异常结束了');
  assert.equal(P.reasonText('network_interrupted'), '网络连接中断');
  assert.equal(P.reasonText('some_new_code'), '它这一轮异常结束了');
  assert.equal(P.reasonText('ENOENT: no such file, open \'C:\\Users\\x\\a.json\''),'任务派发出错');
  assert.equal(P.reasonText('读取 D:/AIWork/x.json 失败'), '任务派发出错');
  assert.equal(P.reasonText('负责人不在群里'), '负责人不在群里');
  const dict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'core', 'i18n', 'locales', 'en', 'rooms-area.json'), 'utf8'));
  const P2 = require('../core/squad-protocol');
  for (const code of ['response_timeout', 'provider_error', 'runtime_exited', 'network_interrupted', 'provider_unavailable', 'rate_limited',
    'quota_exceeded', 'token_plan_quota', 'token_plan_quota_rerouted', 'auth_required', 'context_limit', 'trusted_repo_required', 'stuck'])
    assert.equal(typeof dict[P2.reasonText(code)], 'string', code);
  assert.equal(typeof dict['任务派发出错'], 'string');
});

test('插话回执同样容忍终端残留前缀；前缀只认 ASCII 可见字符', () => {
  assert.equal(sameSubmittedText('同意', '不同意'), false);
  assert.equal(sameSubmittedText('同意', ';1_同意'), true);
  assert.equal(sameSubmittedText('同意', '123456789同意'), false);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r38-steer-'));
  try {
    const s = new DshCliSession({ id: 's2', kind: 'deepseek-acp', home });
    s.pendingSteers = [{ id: 'steer-1', text: '补充一句', at: Date.now() }];
    assert.equal(s.takePendingSteer(';1_补充一句')?.id, 'steer-1');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
