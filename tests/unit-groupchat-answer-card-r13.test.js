'use strict';
// 群聊体验修复（2026-11-23 群聊审查 Top1–5）：
// 1. 成员答完但没写回答文件：结算时把聊天里的最终回复落成回答文件，卡片不再从「有字」变回「还没交」，小队与下一轮上下文都拿得到。
// 2. 「提取」对 ACP / CLI 提供方会话走原生回执读本轮结果。
// 3–5. 卡片状态：还在跑时显示「思考中」与运行状态、卡在输入框时给「再次发送」；先答完的成员不必等最慢的人才有「提取」；
//      「重新发送」只给已停下的成员，报错时直接露出「重试」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../core/group-answer-files');
const { getOrchestrator } = require('../core/group-chat-orchestrator');
const Card = require('../renderer/groupchat-answer-card-state');

function room(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-r13-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orch = getOrchestrator(dir, `room${Math.random().toString(36).slice(2, 8)}`);
  orch.beginTurn('问题');
  const add = (sid, member) => {
    const e = A.entryFor({ dataDir: dir, meetingId: 'room', turnNum: 1, memberId: member, answerId: 'run-1' });
    orch.registerAnswerFile(1, sid, e);
    return orch.answerFileFor(1, sid);
  };
  const msg = sid => orch.state.messages.find(m => m.sid === sid && m.role === 'assistant');
  return { dir, orch, add, msg };
}

test('Top1：成员正常答完没写回答文件，结算时聊天回复写成回答文件并显示在卡片上', t => {
  const { orch, add, msg } = room(t);
  const e = add('s1', 'm1');
  orch.patchTurnResult(1, 's1', { text: '聊天里的最终回答', status: 'completed', memberId: 'm1', speaker: '成员一' });
  assert.equal(fs.readFileSync(e.ready, 'utf8').trim(), '聊天里的最终回答');
  assert.equal(msg('s1').content, '聊天里的最终回答');
  assert.equal(msg('s1').answer.state, 'delivered');
  assert.deepEqual(fs.readdirSync(path.dirname(e.ready)), ['回答.md'], '不留临时文件');
  // 整轮结算（completeTurn）不得把已显示的正文清掉
  orch.completeTurn(1, '问题', [{ sid: 's1', status: 'completed', text: '聊天里的最终回答' }], { s1: { memberId: 'm1' } });
  assert.equal(msg('s1').content, '聊天里的最终回答');
  // 下一轮其他成员的上下文里能看到这份回答
  const delta = orch.buildDelta('s2', '下一问');
  assert.match(JSON.stringify(delta), /聊天里的最终回答/);
});

test('Top1：成员自己写了回答文件时，以文件为准，不用聊天摘要覆盖', t => {
  const { orch, add, msg } = room(t);
  const e = add('s1', 'm1');
  fs.mkdirSync(path.dirname(e.ready), { recursive: true });
  fs.writeFileSync(e.ready, '成员写的完整回答', 'utf8');
  orch.patchTurnResult(1, 's1', { text: '3 行摘要', status: 'completed', memberId: 'm1' });
  A.reconcile(orch);
  assert.equal(fs.readFileSync(e.ready, 'utf8'), '成员写的完整回答');
  assert.equal(msg('s1').content, '成员写的完整回答');
});

test('Top1：报错 / 中断的半截输出不写成回答文件；整轮一次结算（completeTurn 直达）同样补文件', t => {
  const { orch, add, msg } = room(t);
  const e1 = add('s1', 'm1'), e2 = add('s2', 'm2');
  orch.completeTurn(1, '问题', [
    { sid: 's1', status: 'errored', text: '半截输出' },
    { sid: 's2', status: 'completed', text: '成员二回答' },
  ], { s1: { memberId: 'm1' }, s2: { memberId: 'm2' } });
  assert.equal(fs.existsSync(e1.ready), false);
  assert.equal(fs.readFileSync(e2.ready, 'utf8').trim(), '成员二回答');
  assert.equal(msg('s2').content, '成员二回答');
});

test('Top1：交付工作流的回答文件不自动补', () => {
  assert.equal(A.fillFromChat({ kind: 'delivery', ready: path.join(os.tmpdir(), 'never.md') }, '文本'), false);
  assert.equal(A.fillFromChat({ kind: 'plain', ready: path.join(os.tmpdir(), 'never.md') }, '   '), false);
});

test('Top1：小队模式按卡片上的回答解析负责人派工（详细派工写在回答文件、聊天里只给摘要）', async () => {
  const { createSquadEngine } = require('../main/groupchat/squad-engine');
  const members = [1, 2].map(i => ({ sid: `s${i}`, index: i - 1, memberId: `m${i}`, displayName: `成员 ${i}`, kind: 'codeagent', aliases: [`m${i}`] }));
  const meeting = { id: 'g1', groupChat: true, subSessions: ['s1', 's2'], participants: [0, 1] };
  const messages = [], calls = [];
  let turn = 0;
  const dispatcher = {
    async dispatchGroupChatTurn(_id, args) {
      turn += 1; calls.push(args.targetMemberIds);
      const leader = (args.targetMemberIds || []).includes('m1');
      const card = leader && turn === 1 ? '计划如下。\n【派工·依次】\n@m2：摸底代码' : leader ? '验收通过' : '摸底完成';
      messages.push({ role: 'assistant', sid: leader ? 's1' : 's2', turnNum: turn, content: card });
      return { status: 'completed', turnNum: turn, results: [{ sid: leader ? 's1' : 's2', status: 'completed', text: leader ? '本轮摘要：已派工' : '摸底完成' }] };
    },
  };
  const engine = createSquadEngine({
    getHubDataDir: () => os.tmpdir(), meetingManager: { getMeeting: () => meeting }, getDispatcher: () => dispatcher,
    getMembers: () => members, ensureMemberReady: async () => {}, interruptMeetingTurn: () => {},
    getOrchestrator: () => ({ appendSystemNote() {}, state: { messages } }), sendToRenderer() {}, logger: { warn() {}, log() {} },
  });
  engine.configure('g1', { enabled: true });
  await engine.userTurn('g1', { userInput: '做个功能' }, (id, args) => dispatcher.dispatchGroupChatTurn(id, args));
  for (let i = 0; i < 200 && !['done', 'limit', 'stopped', 'error'].includes(engine.view('g1').run?.status); i += 1) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(calls.map(ids => ids.join('+')), ['m1', 'm2', 'm1']);
});

test('Top2：「提取」对 ACP 会话按原生回执读本轮结果并写进回答文件', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-r13-acp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const answerDir = path.join(dir, 'answers', 'm');
  const entry = { kind: 'plain', dir: answerDir, ready: path.join(answerDir, '回答.md'), memberId: 'm', speaker: 'DSH' };
  const message = { id: 'a2', turnNum: 2, role: 'assistant', sid: 'sid-acp', content: '' };
  const orch = {
    state: { currentTurn: 2, revision: 1, answerFiles: { 2: { 'sid-acp': entry } },
      turns: [{ n: 2, byStatus: { 'sid-acp': 'completed' }, attemptIdBy: { 'sid-acp': 'att-1' }, providerTurnIdBy: { 'sid-acp': 'turn-9' } }],
      messages: [{ id: 'u2', turnNum: 2, role: 'user', content: '问题', createdAt: Date.now() - 1000 }, message] },
    answerFileFor: (n, sid) => orch.state.answerFiles[n]?.[sid] || null,
    applyAnswerFile(_n, _sid, got) { message.content = got.text; message.answer = { state: got.state }; return true; },
    getAttempt: () => null,
  };
  const acp = { runtime: { epoch: 3, submission: null }, threadId: 'th-1', receipts: new Map(),
    readOutcome: async turnId => ({ turnId, threadId: 'th-1', status: 'completed', text: 'ACP 成员的最终回答' }) };
  const handlers = {};
  require('../main/ipc/groupchat-recovery-handlers').registerGroupchatRecoveryIpc({ handle: (n, fn) => { handlers[n] = fn; } }, {
    dispatchGroupChatTurn: async () => ({}), getHubDataDir: () => dir, getActiveWatchers: () => new Map(),
    groupchat: { getOrchestrator: () => orch }, groupChatWatcher: { extractStreamingText: () => null },
    logger: { warn() {}, error() {}, log() {} }, meetingManager: { getMeeting: () => ({ id: 'm1', groupChat: true }) },
    sendToRenderer() {},
    sessionManager: { getSession: () => ({ kind: 'deepseek-acp', runtimeBackend: 'acp' }), getNativeSession: () => acp, getNativeCodex: () => null },
    transcriptTap: { extractLatestTurn: async () => { throw new Error('ACP 不应走 PTY 会话记录'); } },
  });
  const r = await handlers['groupchat-manual-extract']({}, { meetingId: 'm1', sid: 'sid-acp', turnNum: 2, answerFileFallback: 'transcript' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.source, 'acp');
  assert.equal(fs.readFileSync(entry.ready, 'utf8').trim(), 'ACP 成员的最终回答');
});

test('Top2：提取失败的提示不再指向已下线的「进 shell」', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'groupchat-recovery-handlers.js'), 'utf8');
  assert.doesNotMatch(src, /进 shell/);
});

const runningState = extra => ({ currentTurn: 1, currentMode: 'parallel', turns: [], _partialBy: {}, ...extra });

test('Top3：成员还在思考、没有正文时显示「思考中」，不显示「还没交」，也不给提取 / 重新发送', () => {
  const p = Card.plan({ message: { id: 'pending-s1', sid: 's1', turnNum: 1, status: 'thinking', content: '' }, state: runningState() });
  assert.equal(p.running, true);
  assert.equal(p.body, 'running');
  assert.equal(p.statusText, '思考中');
  assert.equal(p.cursor, true);
  assert.deepEqual(p.exposed, ['openCli']);
  assert.equal(p.retry, '');
  assert.equal(Card.waitingText('awaiting_binding').includes('绑定'), true);
});

test('Top3：输入卡在 CLI 输入框时显示「输入未提交」并给「再次发送」', () => {
  const p = Card.plan({ message: { id: 'pending-s1', sid: 's1', turnNum: 1, status: 'thinking', content: '' },
    opts: { sendStatus: 'stuck' }, state: runningState() });
  assert.equal(p.body, 'stuck');
  assert.equal(p.statusText, '输入未提交');
  assert.equal(p.exposed[0], 'submitAgain');
  assert.ok(!p.exposed.includes('extract'));
});

test('Top3：流式正文到达时显示正文与「正在发言」，答完结算后卡片保留正文', () => {
  const p = Card.plan({ message: { id: 'pending-s1', sid: 's1', turnNum: 1, status: 'streaming', content: '写到一半' }, state: runningState() });
  assert.equal(p.body, 'text');
  assert.equal(p.statusText, '正在发言');
});

test('Top4：整轮未结算时，先答完的成员按自己的状态判定已停下，立即有「提取」', () => {
  const state = runningState({ _partialBy: { s1: { status: 'completed' }, s2: { status: 'streaming' } } });
  const done = Card.plan({ message: { id: 'a1-m1', sid: 's1', turnNum: 1, status: 'completed', content: '' }, state });
  assert.equal(done.running, false);
  assert.ok(done.exposed.includes('extract'));
  const slow = Card.plan({ message: { id: 'pending-s2', sid: 's2', turnNum: 1, status: 'streaming', content: '' }, state });
  assert.equal(slow.running, true);
  assert.ok(!slow.exposed.includes('extract'));
  // 没有任何成员级状态时，按整轮是否在跑兜底
  assert.equal(Card.memberRunning(runningState(), { sid: 's3', turnNum: 1 }), true);
  assert.equal(Card.memberRunning(runningState({ currentMode: 'idle' }), { sid: 's3', turnNum: 1 }), false);
});

test('Top5：已停下没交的成员在「更多」里有「重新发送」；报错的直接露出「重试」；还在跑的都没有', () => {
  const idle = runningState({ currentMode: 'idle', turns: [{ n: 1, byStatus: { s1: 'completed', s2: 'errored', s3: 'streaming' } }] });
  const missing = Card.plan({ message: { id: 'a1', sid: 's1', turnNum: 1, status: 'completed', content: '' }, state: idle });
  assert.equal(missing.body, 'missing');
  assert.equal(missing.retry, 'resend');
  assert.deepEqual(missing.exposed, ['extract', 'openCli']);
  const failed = Card.plan({ message: { id: 'a2', sid: 's2', turnNum: 1, status: 'errored', content: '' }, state: idle, failureText: '这一轮没完成：额度已用尽' });
  assert.equal(failed.body, 'failure');
  assert.ok(failed.exposed.includes('retryFailed'));
  assert.equal(failed.retry, '');
  const delivered = Card.plan({ message: { id: 'a1', sid: 's1', turnNum: 1, status: 'completed', content: '回答', answer: { state: 'delivered' } }, state: idle });
  assert.equal(delivered.retry, 'resend');
  assert.deepEqual(delivered.exposed, []);
  const unknown = Card.plan({ message: { id: 'a2', sid: 's2', turnNum: 1, status: 'errored', content: '', failure: { code: 'submission_unknown' } }, state: idle, failureText: 'x' });
  assert.equal(unknown.retry, '');
  assert.ok(!unknown.exposed.includes('retryFailed'), '提交待核对时不鼓励重发');
});

test('Top6：卡片头不再平铺「复制本轮 Prompt」，「打开 CLI」不带长标题', () => {
  const p = Card.plan({ message: { id: 'a1', sid: 's1', turnNum: 1, status: 'completed', content: '', sourcePrompt: 'p' }, state: runningState({ currentMode: 'idle' }) });
  assert.ok(!p.exposed.includes('copyPrompt'));
  assert.deepEqual(p.more, ['viewPrompt', 'copyPrompt']);
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
  assert.match(src, /title="\$\{escapeHtml\(`打开 \$\{memberName\} 的 CLI`\)\}">打开 CLI<\/button>/);
});

test('Top7：横幅按群聊记住，整块重绘照样画出；「等太久」提醒本轮结束后自动收起，操作失败提示要点 × 才收', () => {
  const store = require('../renderer/groupchat-soft-banner').createSoftBannerStore();
  assert.match(store.html('g1', 'parallel'), /display:none/);
  store.set('g1', { kind: 'soft', cls: '', html: '<b>成员 A 已等待 90 秒</b>' });
  for (let i = 0; i < 3; i += 1) assert.match(store.html('g1', 'parallel'), /display:flex[\s\S]*已等待 90 秒/, '重绘多次仍在');
  assert.match(store.html('g2', 'parallel'), /display:none/, '别的群聊不受影响');
  assert.match(store.html('g1', 'idle'), /display:none/, '本轮结束后收起');
  store.set('g1', { kind: 'notice', cls: 'urgent', html: '同步失败：原因' });
  assert.match(store.html('g1', 'idle'), /urgent[\s\S]*display:flex[\s\S]*同步失败/);
  const el = { style: {} };
  assert.equal(store.paint('g1', el), true);
  assert.equal(el.style.display, 'flex');
  store.set('g1', null);
  store.paint('g1', el);
  assert.equal(el.style.display, 'none');
});

test('Top8：@点名解析主进程与渲染进程共用，点到人才算点名', () => {
  const { parseGroupTargets } = require('../core/group-mentions');
  const members = [0, 1, 2].map(i => ({ sid: `s${i}`, index: i, memberId: `m${i + 1}`, kind: 'claude', displayName: `成员${i}`, aliases: [] }));
  assert.deepEqual(parseGroupTargets('@m2 看下', members, [0, 1, 2]).targets.map(m => m.sid), ['s1']);
  assert.deepEqual(parseGroupTargets('@m2帮我看下', members, [0, 1, 2]).mentions, ['m2']);
  assert.equal(parseGroupTargets('@all 一起看', members, [0]).targets.length, 3);
  assert.deepEqual(parseGroupTargets('邮件 a@b 不是点名', members, [0, 1]).mentions, []);
  assert.equal(require('../main/groupchat/dispatcher')._parseGroupTargets, parseGroupTargets);
});

test('Top8：群聊里的确认与提示不再用系统原生弹窗', () => {
  for (const file of ['renderer/meeting-room.js', 'renderer/delivery-workflow-controls.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(src, /window\.confirm\(|[^.\w]alert\(/, file);
  }
});

test('合入 main：模型权限被收回时卡片最先露出「点此换模型」，不鼓励原样重试', () => {
  const idle = runningState({ currentMode: 'idle', turns: [{ n: 1, byStatus: { s1: 'errored' } }] });
  const p = Card.plan({ message: { id: 'a1', sid: 's1', turnNum: 1, status: 'errored', content: '' }, state: idle,
    failureText: '模型无权限，点右上角“需要换个模型”选择可用模型后继续。', modelRevoked: true });
  assert.equal(p.exposed[0], 'modelChange');
  assert.ok(!p.exposed.includes('retryFailed'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
  assert.match(src, /data-gc-model-revoked="\$\{sid\}">点此换模型/);
});
