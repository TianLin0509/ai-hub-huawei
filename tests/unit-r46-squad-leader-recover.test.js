'use strict';
// R46：小队负责人会话掉线后一键「重启负责人并继续」；CLI 退出 / Hub 重启后，没跑完的子 Agent 显示「已中断」而不是一直「进行中」。
// R46: one-click leader restart + resume for squads; subagents orphaned by a CLI exit or Hub restart show as interrupted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSquadEngine } = require('../main/groupchat/squad-engine');
const P = require('../core/squad-protocol');
const SP = require('../core/subagent-progress');
const { createSubagentProgressService } = require('../main/subagent-progress-service');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CLI_EXITED = 'CLI 已退出到系统终端，消息未发送；请先重启会话';

// leaderScript：负责人每一次被派发时的结果，'exit' 表示这一次 CLI 已退出（消息没送到）。
function setup({ leaderScript, needsRestart = () => true, restartResult = { id: 's1' } }) {
  const needsCalls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-r46-'));
  const meeting = { id: 'g1', groupChat: true, subSessions: ['s1', 's2', 's3'], participants: [0, 1, 2] };
  const members = [1, 2, 3].map(i => ({ sid: `s${i}`, index: i - 1, memberId: `m${i}`, displayName: `成员 ${i}`, kind: 'codeagent', aliases: [`m${i}`] }));
  const calls = [], notes = [], restarts = [];
  let leaderTurn = 0;
  const dispatcher = {
    async dispatchGroupChatTurn(_id, args) {
      if (args.shouldDispatch && !args.shouldDispatch()) return { status: 'error', cancelledBeforeDispatch: true };
      const ids = args.targetMemberIds;
      calls.push({ ids, args });
      const results = ids.map(id => {
        const sid = members.find(m => m.memberId === id).sid;
        if (id !== 'm1') return { sid, status: 'completed', text: `${id} 做完了` };
        const step = leaderScript[Math.min(leaderTurn, leaderScript.length - 1)];
        leaderTurn += 1;
        if (step === 'exit') return { sid, status: 'errored', text: '', reason: CLI_EXITED };
        if (step === 'dsh') return { sid, status: 'errored', text: '', reason: 'DSH CLI 未连接' };
        if (step === 'timeout') return { sid, status: 'errored', text: '', reason: 'hard_timeout' };
        if (step === 'stopped') return { sid, status: 'interrupted', text: '' };
        return { sid, status: 'completed', text: step };
      });
      const stopped = ids.includes('m1') && leaderScript[Math.min(leaderTurn - 1, leaderScript.length - 1)] === 'stopped';
      return { status: 'completed', turnNum: calls.length, results, ...(stopped ? { interrupted: true } : {}) };
    },
  };
  const engine = createSquadEngine({
    getHubDataDir: () => dir,
    meetingManager: { getMeeting: id => (id === 'g1' ? meeting : null) },
    getDispatcher: () => dispatcher,
    getMembers: () => members,
    ensureMemberReady: async () => {},
    getOrchestrator: () => ({ appendSystemNote: (_turn, text) => notes.push(text) }),
    restartSession: async sid => { restarts.push(sid); return restartResult; },
    leaderNeedsRestart: (sid, opts) => { needsCalls.push([sid, opts]); return needsRestart(sid, opts); },
    logger: { warn: () => {}, log: () => {} },
  });
  const base = (id, args) => dispatcher.dispatchGroupChatTurn(id, args);
  const settle = async (want = ['done', 'limit', 'stopped', 'error']) => {
    for (let i = 0; i < 300; i += 1) {
      const run = engine.view('g1').run;
      if (run && want.includes(run.status)) return run;
      await sleep(5);
    }
    throw new Error('squad run did not settle');
  };
  return { engine, calls, notes, restarts, base, settle, needsCalls };
}

test('协议：CLI 退回终端、没就绪、进程退出算「重启就能接上」；额度、超时不算', () => {
  for (const r of [CLI_EXITED, 'cli_not_ready', 'runtime_exited', 'session_not_ready', '未找到 CodeAgent CLI：终端里「codeagent」无法识别',
    'DSH CLI 未连接', 'DSH CLI 已退出', '千问 CLI 未连接，消息未发送', 'pi 已退出', 'pi 未连接', 'CodeAgent 尚未连接', 'CodeAgent 连接已断开', 'Codex 原生连接不可用']) {
    assert.equal(P.leaderNeedsRestart(r), true, r);
    assert.equal(P.leaderRecoverMode(r), 'restart-resend', r);
  }
  for (const r of ['quota_exceeded', 'hard_timeout', '交回的内容是空的', '']) assert.equal(P.leaderNeedsRestart(r), false, r);
  for (const r of ['hard_timeout', 'response_timeout', 'stuck', 'submission_unknown']) assert.equal(P.leaderRecoverMode(r), 'restart-only', r);
  for (const r of ['quota_exceeded', '交回的内容是空的', 'provider_error']) assert.equal(P.leaderRecoverMode(r), 'resend', r);
  assert.match(P.resumePrompt('原文'), /会话刚重启[\s\S]*原文$/);
  assert.match(P.resumePrompt('原文', { restarted: false }), /没有给出有效回答[\s\S]*原文$/);
});

test('负责人第一棒就掉线：就地说明 + 「重启负责人并继续」，一键重启并原样重发需求，后续照常派工收口', async () => {
  const t = setup({ leaderScript: ['exit', '【派工·依次】\n@m2：做 A', '验收通过'] });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: '给考勤加弹性制' }, t.base);
  const halted = await t.settle();
  assert.equal(halted.status, 'error');
  assert.equal(halted.recoverable, true);
  assert.equal(halted.restartLeader, true);
  assert.match(halted.note, /CLI 掉线了[\s\S]*重启负责人并继续/);
  assert.equal(halted.pending, undefined, '要重发的原文不发给界面');
  assert.match(t.notes.at(-1), /重启负责人并继续/);

  const r = t.engine.resume('g1');
  assert.equal(r.ok, true);
  assert.equal(r.run.status, 'leader', '点了就立刻显示正在接着做');
  const run = await t.settle(['done', 'limit', 'error']);
  assert.equal(run.status, 'done');
  assert.deepEqual(t.restarts, ['s1'], '只重启负责人一次');
  assert.deepEqual(t.calls.map(c => c.ids.join('+')), ['m1', 'm1', 'm2', 'm1']);
  assert.match(t.calls[1].args.perMemberInput.m1, /会话刚重启[\s\S]*小队模式 · 你是负责人[\s\S]*给考勤加弹性制/, '重发的是同一份需求');
  assert.match(t.calls[1].args.userInput, /^Hub 重发给负责人 @成员 1：/, '群里卡片只放一行，不把整段负责人协议画出来');
  assert.doesNotMatch(t.calls[1].args.userInput, /小队模式 · 你是负责人/);
  assert.equal(t.needsCalls[0][0], 's1');
  assert.ok(t.needsCalls[0][1].haltedAt > 0, '把停下时刻交给真实判定，已手动重启的不再重启');
  assert.equal(t.calls[1].args.appendUserMessage, false, '不在群里重复显示用户的话');
});

test('负责人验收时掉线：重启后重发同一份交回（含已完成成员的结果），成员不重做', async () => {
  const t = setup({ leaderScript: ['【派工·同时】\n@m2：A\n@m3：B', 'exit', '全部完成'] });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: '做 A 和 B' }, t.base);
  const halted = await t.settle();
  assert.equal(halted.status, 'error');
  assert.match(halted.note, /第 1\/\d+ 轮验收/);
  assert.deepEqual(halted.steps.map(s => s.state), ['done', 'done'], '成员状态是真实的已完成');
  t.engine.resume('g1');
  const run = await t.settle(['done', 'limit']);
  assert.equal(run.status, 'done');
  assert.deepEqual(t.calls.map(c => c.ids.join('+')), ['m1', 'm2+m3', 'm1', 'm1']);
  assert.match(t.calls[3].args.perMemberInput.m1, /会话刚重启[\s\S]*Hub 交回 · 第 1[\s\S]*@m2[\s\S]*@m3/);
});

test('负责人已被手动重启好：不再重启，直接重发；重启失败时留着按钮可再点，不卡死', async () => {
  const ok = setup({ leaderScript: ['exit', '直接答复'], needsRestart: () => false });
  ok.engine.configure('g1', { enabled: true });
  await ok.engine.userTurn('g1', { userInput: 'x' }, ok.base);
  await ok.settle();
  ok.engine.resume('g1');
  assert.equal((await ok.settle(['done'])).status, 'done');
  assert.deepEqual(ok.restarts, []);

  const bad = setup({ leaderScript: ['exit', '直接答复'], restartResult: { ok: false, message: '会话重启失败：旧进程迟迟未退出' } });
  bad.engine.configure('g1', { enabled: true });
  await bad.engine.userTurn('g1', { userInput: 'x' }, bad.base);
  await bad.settle();
  bad.engine.resume('g1');
  await sleep(20);
  const run = await bad.settle(['error']);
  assert.equal(run.recoverable, true, '失败后按钮还在');
  assert.match(run.note, /重启负责人没有成功[\s\S]*旧进程迟迟未退出/);
  assert.throws(() => bad.engine.resume('nope'), /没有停下待接着做/);
});

test('非掉线类失败（负责人答了空）：按钮是「重新交给负责人」，不重启会话', async () => {
  const t = setup({ leaderScript: ['', '直接答复'] });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: 'x' }, t.base);
  const halted = await t.settle();
  assert.equal(halted.recoverable, true);
  assert.equal(halted.restartLeader, false);
  t.engine.resume('g1');
  assert.equal((await t.settle(['done'])).status, 'done');
  assert.deepEqual(t.restarts, []);
  assert.match(t.calls[1].args.perMemberInput.m1, /没有给出有效回答/, '没重启就不说「会话刚重启」');
  assert.doesNotMatch(t.calls[1].args.perMemberInput.m1, /会话刚重启/);
});

test('停止小队后不能再「接着做」；正常完成的小队没有按钮', async () => {
  const t = setup({ leaderScript: ['直接答复'] });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: 'x' }, t.base);
  const run = await t.settle();
  assert.equal(run.status, 'done');
  assert.equal(run.recoverable, false);
  assert.throws(() => t.engine.resume('g1'), /没有停下待接着做/);
});

// ---- 子任务进度 / subagent progress ----
const T0 = Date.parse('2026-11-25T03:00:00Z');
function mainRecs(n) {
  const recs = [{ type: 'user', timestamp: new Date(T0).toISOString(), message: { content: '开始' } }];
  for (let i = 0; i < n; i += 1) recs.push({ type: 'assistant', timestamp: new Date(T0 + 1000 + i).toISOString(), message: { content: [{ type: 'tool_use', id: `tu${i}`, name: 'Task', input: {} }] } });
  return recs;
}
const files = (n, mtimeMs) => Array.from({ length: n }, (_, i) => ({ name: `agent-${i}.jsonl`, toolUseId: `tu${i}`, firstTs: T0 + 2000, mtimeMs, done: false, lastStep: '修改 out_nonno_b06.json' }));

test('子任务：CLI 进程重启前没跑完的，显示「已中断」而不是一直「进行中」', () => {
  const main = SP.summarizeMainRecords(mainRecs(24));
  const fs24 = files(24, T0 + 60000);
  for (let i = 9; i < 24; i += 1) fs24[i].done = true;
  const before = SP.buildSubagentProgress(main, fs24, { now: T0 + 70000 });
  assert.equal(before.running, 9, '旧行为对照：没有进程信息时仍算进行中');
  const after = SP.buildSubagentProgress(main, fs24, { now: T0 + 3600000, processStartedAt: T0 + 3500000 });
  assert.equal(after.running, 0);
  assert.equal(after.interrupted, 9);
  assert.equal(after.done, 15);
  assert.match(after.text, /^9 个子任务已中断[\s\S]*15 个已完成$/);
});

test('子任务：CLI 退回终端时全部判中断；本轮结束且 30 分钟无写入判中断；还在写的照常进行中', () => {
  const main = SP.summarizeMainRecords(mainRecs(2));
  const gone = SP.buildSubagentProgress(main, files(2, T0 + 60000), { now: T0 + 61000, processStartedAt: T0 - 1000, cliGone: true });
  assert.equal(gone.interrupted, 2);
  const idle = SP.buildSubagentProgress(main, files(2, T0 + 60000), { now: T0 + 60000 + 31 * 60000, processStartedAt: T0 - 1000, turnActive: false });
  assert.equal(idle.interrupted, 2);
  const busy = SP.buildSubagentProgress(main, files(2, T0 + 60000), { now: T0 + 60000 + 31 * 60000, processStartedAt: T0 - 1000, turnActive: true });
  assert.equal(busy.running, 2, '本轮还在跑：长命令不写记录也不误判');
  const live = SP.buildSubagentProgress(main, files(2, T0 + 60000), { now: T0 + 65000, processStartedAt: T0 - 1000, turnActive: false });
  assert.equal(live.running, 2, '后台子 Agent 刚写过：照常进行中');
  assert.match(live.text, /^2 个子任务进行中/);
});

test('子任务：没有子 Agent 文件、只有派出记录的，也按派出时间判断', () => {
  const main = SP.summarizeMainRecords(mainRecs(3));
  const p = SP.buildSubagentProgress(main, [], { now: T0 + 999999, processStartedAt: T0 + 500000 });
  assert.equal(p.interrupted, 3);
});

test('子任务服务：把会话启动时刻、CLI 是否退回终端、本轮状态传给读取器（Hub 重启场景端到端）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-r46-'));
  const transcript = path.join(dir, 'abc.jsonl');
  fs.writeFileSync(transcript, mainRecs(2).map(r => JSON.stringify(r)).join('\n') + '\n');
  const subDir = path.join(dir, 'abc', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  for (let i = 0; i < 2; i += 1) {
    const f = path.join(subDir, `agent-${i}.jsonl`);
    fs.writeFileSync(f, JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 3000).toISOString(), message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.json' } }] } }) + '\n');
    fs.writeFileSync(f.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ toolUseId: `tu${i}` }));
  }
  const sent = [];
  const mtime = fs.statSync(path.join(subDir, 'agent-0.jsonl')).mtimeMs;
  let createdAt = mtime - 60000;   // 进程在子 Agent 写入之前启动：还在跑
  const svc = createSubagentProgressService({
    getSession: () => ({ id: 's1', kind: 'codeagent', transcriptPath: transcript, createdAt }),
    isTurnActive: () => true,
    sendToRenderer: (_ch, payload) => sent.push(payload),
    pollMs: 1e9,
  });
  svc.watch('s1');
  for (let i = 0; i < 50 && !sent.length; i += 1) await sleep(10);
  assert.match(sent.at(-1).progress.text, /^2 个子任务进行中/);
  createdAt = mtime + 60000;       // Hub / 会话重启：新进程启动晚于最后写入
  await svc.tick();
  assert.match(sent.at(-1).progress.text, /^2 个子任务已中断/);
  assert.equal(sent.at(-1).progress.interrupted, 2);
  svc.stop();
});

test('审查 P1-1：负责人首棒时点了「停止本轮」，小队就地停下，不进错误恢复态、没有按钮', async () => {
  const t = setup({ leaderScript: ['stopped'] });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: 'x' }, t.base);
  const run = await t.settle();
  assert.equal(run.status, 'stopped');
  assert.equal(run.recoverable, false);
  assert.deepEqual(t.notes, [], '不写「负责人没有给出回答」');
});

test('审查 P1-2：负责人超时 / 提交结果不明，只给「重启负责人」：一律重启结束它这一轮，不自动重发', async () => {
  const t = setup({ leaderScript: ['timeout', '不该被用到'], needsRestart: () => false });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: 'x' }, t.base);
  const halted = await t.settle();
  assert.equal(halted.recoverMode, 'restart-only');
  assert.match(halted.note, /可能还在跑或没收到[\s\S]*不会自动重发/);
  t.engine.resume('g1');
  await sleep(20);
  const run = await t.settle(['stopped']);
  assert.deepEqual(t.restarts, ['s1'], '即使 CLI 看起来正常也重启，确保旧的这一轮结束');
  assert.equal(t.calls.length, 1, '没有重发');
  assert.match(run.note, /已重启[\s\S]*没有自动重发/);
});

test('审查 P1-5：DSH 负责人报「DSH CLI 未连接」时也按掉线处理：重启并重发', async () => {
  const t = setup({ leaderScript: ['dsh', '直接答复'] });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: 'x' }, t.base);
  const halted = await t.settle();
  assert.equal(halted.restartLeader, true);
  assert.equal(halted.recoverMode, 'restart-resend');
  t.engine.resume('g1');
  assert.equal((await t.settle(['done'])).status, 'done');
  assert.deepEqual(t.restarts, ['s1']);
});

// ---- 真实判定 / real judgement (main/groupchat/squad-leader-health.js) ----
const H = require('../main/groupchat/squad-leader-health');
function fakeSM({ session = { createdAt: 1000 }, native = null, buffer = '', ready = true, relaunch = true } = {}) {
  const log = [];
  return { log,
    getSession: () => session, getNativeClaude: () => native, getNativeSession: () => null,
    getSessionBuffer: () => buffer, getGroupChatReady: () => ready,
    relaunchCli: (sid, opts) => { log.push(['relaunch', sid, opts.trigger]); return relaunch; } };
}
const SHELL = 'PS C:\\work>';
const shell = buf => buf === SHELL;

test('审查 P1-4：是否需要重启看 CLI 真实状态；停下后才启动的进程（已手动重启）不再重启', () => {
  assert.equal(H.leaderNeedsRestart(fakeSM({ buffer: SHELL }), 's1', { detect: shell }), true, '退回系统终端');
  assert.equal(H.leaderNeedsRestart(fakeSM({ session: { createdAt: 5000 }, ready: false }), 's1', { haltedAt: 4000, detect: shell }), false,
    '停下之后才启动 = 用户已手动重启，首次发送前 groupChatReady=false 也不再重启');
  assert.equal(H.leaderNeedsRestart(fakeSM({ session: { createdAt: 1000 }, ready: false }), 's1', { haltedAt: 4000, detect: shell }), true, '旧进程、CLI 没就绪');
  assert.equal(H.leaderNeedsRestart(fakeSM({ session: { createdAt: 1000, spawnedAt: 5000 }, ready: false }), 's1', { haltedAt: 4000, detect: shell }), false,
    '原地重拉 CLI 后的 spawnedAt 优先');
  assert.equal(H.leaderNeedsRestart(fakeSM({ ready: true }), 's1', { detect: shell }), false, '健康的终端会话');
  assert.equal(H.leaderNeedsRestart(fakeSM({ native: { runtime: { connection: 'connected', state: 'idle' } } }), 's1', { detect: shell }), false, '原生连接正常');
  assert.equal(H.leaderNeedsRestart(fakeSM({ native: { runtime: { connection: 'disconnected' } } }), 's1', { detect: shell }), true, '原生连接断开');
  assert.equal(H.leaderNeedsRestart(fakeSM({ native: { closed: true } }), 's1', { detect: shell }), true);
  assert.equal(H.leaderNeedsRestart(fakeSM({ session: null }), 's1', { detect: shell }), false, '休眠的交给唤醒');
  // 不注入 detect：用真的终端检测器 / without injection: the real shell detector
  assert.equal(H.leaderNeedsRestart(fakeSM({ buffer: 'claude> working…', ready: true }), 's1'), false);
});

test('审查 P2-2：首轮前就掉线、还没绑定原生会话 ID 时，退化为原地重拉 CLI', async () => {
  const sm = fakeSM({ buffer: SHELL });
  const r = await H.restartLeader(sm, async () => ({ ok: false, error: 'native-session-id-missing' }), 's1', { detect: shell });
  assert.notEqual(r.ok, false);
  assert.deepEqual(sm.log, [['relaunch', 's1', 'squad-leader-recover']]);
  const other = fakeSM({ buffer: SHELL });
  const bad = await H.restartLeader(other, async () => ({ ok: false, error: 'restart-exit-timeout', message: 'x' }), 's1', { detect: shell });
  assert.equal(bad.ok, false, '其他失败原样返回');
  assert.deepEqual(other.log, []);
});

test('审查 P1-3：重启后开始新一轮，上一轮留下、已经停掉的子任务不再混进新一轮', () => {
  const T1 = T0 + 600000;   // 新一轮开始 / new turn starts
  const main = SP.summarizeMainRecords([{ type: 'user', timestamp: new Date(T1).toISOString(), message: { content: '新一轮' } }]);
  const old = files(9, T1 - 60000).map(f => ({ ...f, toolUseId: null, firstTs: T0 + 2000 }));
  const p = SP.buildSubagentProgress(main, old, { now: T1 + 60000, processStartedAt: T1 - 30000 });
  assert.equal(p, null, '新一轮不挂着上一轮的「9 个子任务已中断」');
  const live = SP.buildSubagentProgress(main, old, { now: T1 + 60000, processStartedAt: T0 - 1000, turnActive: true });
  assert.equal(live.running, 9, '上一轮还在跑的后台子 Agent 仍然带进来');
});

test('审查 P2-1：原地重拉 CLI 时记下新进程的启动时刻（spawnedAt）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  const body = src.slice(src.indexOf('  relaunchCli(sessionId, options = {}) {'), src.indexOf('  getAllSessions() {'));
  assert.match(body, /s\.pty\.write\(cmd\);[\s\S]{0,300}s\.info\.spawnedAt = Date\.now\(\)/);
});

test('R47 审查 P2：群聊「抢救 → 回退上一轮」后，掉线停下的小队任务作废，按钮收起，不能再接着做', async () => {
  const t = setup({ leaderScript: ['exit'] });
  t.engine.configure('g1', { enabled: true });
  await t.engine.userTurn('g1', { userInput: '给考勤加弹性制' }, t.base);
  const halted = await t.settle();
  assert.equal(halted.recoverable, true);
  assert.equal(t.engine.discardRecovery('g1'), true);
  const after = t.engine.view('g1').run;
  assert.equal(after.status, 'stopped');
  assert.equal(after.recoverable, false);
  assert.match(after.note, /已回退上一轮/);
  assert.throws(() => t.engine.resume('g1'), /没有停下待接着做/);
  assert.equal(t.engine.discardRecovery('g1'), false, '没有可作废的就不动');
});
