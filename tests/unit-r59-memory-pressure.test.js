'use strict';
// R59 内存紧张就地提示：判定门槛与回滞、闲置/在跑计数、只在变化时推送、一键休眠只动可休眠的、
// 一键反馈运行快照带上低开销模式与会话进程树合计、界面文字与按钮组合。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const hint = require('../core/memory-pressure-hint');
const { createMemoryPressureWatch, runtimeText } = require('../main/memory-pressure-watch');
const { hintModel, resultText } = require('../renderer/memory-pressure-bar');

const GB = 1024 ** 3;

test('紧张判定：≥85% 或可用不足 4 GB 进入；<80% 且 ≥5 GB 才退出', () => {
  assert.equal(hint.isTight({ usage: 0.84, freeBytes: 10 * GB }), false);
  assert.equal(hint.isTight({ usage: 0.85, freeBytes: 10 * GB }), true);
  assert.equal(hint.isTight({ usage: 0.5, freeBytes: 3.9 * GB }), true);
  // 回滞：已紧张时 82% 仍算紧张，79% 且 6 GB 才放
  assert.equal(hint.isTight({ usage: 0.82, freeBytes: 10 * GB }, true), true);
  assert.equal(hint.isTight({ usage: 0.79, freeBytes: 4.5 * GB }, true), true);
  assert.equal(hint.isTight({ usage: 0.79, freeBytes: 6 * GB }, true), false);
});

test('summarize：闲着=可休眠，在跑=不可休眠且在运行，休眠/关闭的不算', () => {
  const rows = [
    { id: 'a', suspendable: true, running: false, status: 'idle' },
    { id: 'b', suspendable: false, running: true, status: 'running' },
    { id: 'c', suspendable: false, running: false, status: 'idle' }, // 当前会话或刚有输出：既不闲也不在跑
    { id: 'd', suspendable: true, status: 'dormant' },
  ];
  const s = hint.summarize({ rows, usage: 0.9, freeBytes: 3 * GB, totalBytes: 32 * GB });
  assert.equal(s.tight, true);
  assert.equal(s.liveCount, 3);
  assert.deepEqual(s.idleIds, ['a']);
  assert.equal(s.busyCount, 1);
});

function fakeWorld({ usage = 0.9, rows = [] } = {}) {
  const total = 32 * GB;
  const mem = { free: (1 - usage) * total };
  const sent = [];
  const suspended = [];
  const sessions = new Map(rows.filter(r => r.ptyPid).map(r => [r.id, { info: { status: r.status || 'idle' }, pty: { pid: r.ptyPid } }]));
  const sm = {
    sessions,
    describeSessionsForMemory: () => rows,
    suspendSession: (id, opts) => { suspended.push({ id, opts }); mem.free += 1.5 * GB; return { ok: true }; },
  };
  let measures = 0;
  const watch = createMemoryPressureWatch({
    getSessionManager: () => sm,
    send: s => sent.push(s),
    osApi: { totalmem: () => total, freemem: () => mem.free },
    createInspector: () => ({ snapshot: async () => { measures += 1; return {}; } }),
    treeBytes: (_snap, roots) => roots.map(r => ({ id: r.id, bytes: 1.5 * GB, processes: 30 })),
    listServeHosts: () => [],
    suspendOptions: () => ({ reason: 'memory-release', minIdleMs: 600000, excludeFocused: true, excludeMeeting: true }),
    delay: async () => {},
    setIntervalFn: () => null,
    logger: { log() {}, warn() {} },
  });
  return { watch, sent, suspended, mem, measures: () => measures, setUsage: u => { mem.free = (1 - u) * total; } };
}

test('watch：紧张时量闲置会话占用，状态不变不重复推送', async () => {
  const w = fakeWorld({ rows: [
    { id: 'a', suspendable: true, ptyPid: 11 }, { id: 'b', suspendable: true, ptyPid: 12 },
    { id: 'c', suspendable: false, running: true, ptyPid: 13 },
  ] });
  const s1 = await w.watch.check({});
  assert.equal(s1.tight, true);
  assert.equal(s1.idleCount, 2);
  assert.equal(s1.busyCount, 1);
  assert.equal(Math.round(s1.idleBytes / GB * 10), 30);
  assert.equal(w.sent.length, 1);
  await w.watch.check({});
  assert.equal(w.sent.length, 1, '没变化不再推');
  assert.equal(w.measures(), 1, '3 分钟内同一批闲置会话不重量');
});

test('watch：不紧张时不枚举进程', async () => {
  const w = fakeWorld({ usage: 0.5, rows: [{ id: 'a', suspendable: true, ptyPid: 11 }] });
  const s = await w.watch.check({ measure: true });
  assert.equal(s.tight, false);
  assert.equal(w.measures(), 0);
});

test('一键休眠：只休眠可休眠的会话，参数与「释放内存」面板同一组', async () => {
  const w = fakeWorld({ rows: [
    { id: 'a', suspendable: true, ptyPid: 11 }, { id: 'b', suspendable: false, running: true, ptyPid: 12 },
    { id: 'c', suspendable: true, ptyPid: 13 },
  ] });
  const r = await w.watch.suspendIdle();
  assert.equal(r.ok, true);
  assert.equal(r.requested, 2);
  assert.deepEqual(w.suspended.map(x => x.id), ['a', 'c']);
  for (const x of w.suspended) {
    assert.equal(x.opts.reason, 'memory-release');
    assert.equal(x.opts.excludeFocused, true);
    assert.equal(x.opts.minIdleMs, 600000);
  }
  assert.ok(r.freedBytes >= 3 * GB - 1);
});

test('一键反馈运行快照：带低开销模式开关与会话进程树合计', async () => {
  assert.match(runtimeText({ lowOverheadOn: false, allMem: null }), /低开销模式 关 · 会话进程树内存：测量中/);
  assert.equal(runtimeText({ lowOverheadOn: true, allMem: { bytes: 6.4 * GB, sessions: 4, serve: 1, processes: 120 } }),
    '低开销模式 开 · 会话进程树内存合计 6.4 GB（4 个会话、1 个 Lite 共享后台，120 个进程）');
  const w = fakeWorld({ rows: [{ id: 'a', suspendable: true, ptyPid: 11, status: 'idle' }, { id: 'b', ptyPid: 12, status: 'dormant' }] });
  assert.equal(w.watch.allMemCached(), null, '第一次只发起测量');
  const m = await w.watch.refreshAllMem();
  assert.equal(m.sessions, 1, '休眠的不算');
  assert.equal(Math.round(m.bytes / GB * 10), 15);
  // main.js 的运行快照确实接上了
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /runtimeText\(\{ lowOverheadOn: optionalFeatures\?\.lowOverhead\?\.\(\) === true, allMem: memoryPressureWatch\.allMemCached\(\) \}\)/);
});

test('界面：文字与按钮按情况组合', () => {
  assert.equal(hintModel({ tight: false }), null);
  const idle = hintModel({ tight: true, usage: 0.91, freeBytes: 2.9 * GB, idleCount: 4, idleBytes: 6.1 * GB, busyCount: 2, lowOverheadOn: false });
  assert.equal(idle.head, '内存 91%，剩 2.9 GB');
  assert.equal(idle.detail, '4 个会话闲着，约占 6.1 GB');
  assert.deepEqual(idle.actions.map(a => a.id), ['suspend', 'lowOverhead', 'snooze']);
  const busyOnly = hintModel({ tight: true, usage: 0.95, freeBytes: 1.6 * GB, idleCount: 0, busyCount: 3, liveCount: 3, lowOverheadOn: true });
  const recent = hintModel({ tight: true, usage: 0.9, freeBytes: 3 * GB, idleCount: 0, busyCount: 1, liveCount: 3, lowOverheadOn: true });
  assert.match(recent.detail, /3 个会话刚用过，闲置满 10 分钟后可一键休眠/);
  assert.match(hintModel({ tight: true, usage: 0.9, idleCount: 0, busyCount: 0, liveCount: 0 }).detail, /主要是其他程序/);
  assert.match(busyOnly.detail, /3 个会话正在运行，Hub 不会动它们/);
  assert.deepEqual(busyOnly.actions.map(a => a.id), ['snooze']);
  const launch = hintModel({ tight: true, usage: 0.9, freeBytes: 3 * GB, idleCount: 0, busyCount: 1, liveCount: 1, lowOverheadOn: false }, { place: 'launch', liteAvailable: true });
  assert.deepEqual(launch.actions.map(a => a.id), ['lite', 'lowOverhead']);
  assert.equal(launch.actions[0].primary, true);
  assert.equal(resultText({ ok: true, requested: 3, freedBytes: 4.2 * GB }), '已休眠 3 个会话，腾出约 4.2 GB；点会话即可接着用');
  assert.match(resultText({ ok: true, requested: 0 }), /没有可休眠的会话/);
});

test('精简反馈：运行快照加了两项后不被截掉', () => {
  const os = require('node:os');
  const { slimFeedback } = require('../core/hub-feedback-slim');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r59-slim-'));
  const base = '状态回报端口 3456 正常 · 会话 14 个（codeagent 6、codeagent-resume 2、claude 2、claude-resume 1、deepseek-acp 1、codex 1、codex-resume 1、gemini 1、kimi 1、qwen 1、glm 1、opencode 1、powershell 1）· Hub 钩子已接上，状态回报端口与会话工具均正常· 主进程内存 412 MB · 系统剩余 1830/32438 MB · 已运行 238 分钟';
  const runtime = `${base} · ${runtimeText({ lowOverheadOn: false, allMem: { bytes: 12.3 * GB, sessions: 9, serve: 1, processes: 211 } })}`;
  const out = slimFeedback({ info: { productName: 'AI HUB', version: '5.6.134', runtime }, description: '内存 95%', logsDir: path.join(dir, 'logs'), dataDir: dir });
  assert.match(out.text, /低开销模式 关 · 会话进程树内存合计 12\.3 GB（9 个会话、1 个 Lite 共享后台，211 个进程）/);
});

// ── 审查返工（R59 复审）：用真实闸门（SessionManager.describeSessionsForMemory / suspendSession 的判定）逐类验证 ──
const { SessionManager, MEMORY_HINT_SUSPEND_OPTIONS, MEMORY_RELEASE_SUSPEND_OPTIONS } = require('../core/session-manager');
const { collectProtectedSessionIds } = require('../main/session-auto-suspend');
const HOUR = 3600e3;
function realGate(sessions, focused = null) {
  const sm = Object.create(SessionManager.prototype);
  sm.sessions = new Map(Object.entries(sessions));
  sm.focusedSessionId = focused;
  return sm;
}
const idleSession = (extra = {}, info = {}) => ({ startedAt: Date.now() - HOUR, ...extra,
  info: { kind: 'claude', status: 'idle', agentRuntime: 'pty', ccSessionId: '11111111-1111-1111-1111-111111111111', ...info } });
const verdictOf = (sm, id, extra = {}) => sm.describeSessionsForMemory({ now: Date.now(), suspendOptions: MEMORY_HINT_SUSPEND_OPTIONS, ...extra }).find(r => r.id === id);

test('对照：普通会话闲置 1 小时算闲着（下面各类豁免都相对它）', () => {
  assert.equal(verdictOf(realGate({ a: idleSession() }), 'a').suspendable, true);
});

test('P0：卡片 / 原生会话刚答完（终端输入输出时间为 0），不算闲着', () => {
  const now = Date.now();
  const card = idleSession({}, { runtimeBackend: 'claude-stream-json', agentRuntime: null, lastCompletedAt: now - 2000,
    nativeRuntime: { connection: 'connected', state: 'completed' } });
  const v = verdictOf(realGate({ c: card }), 'c');
  assert.equal(v.suspendable, false);
  assert.equal(v.blockReason, 'recently-active');
  // 回合结束时刻同样算活动（PTY 会话刚结束一轮）
  const pty = idleSession({ agentTurnFinishedAt: now - 3000 });
  assert.equal(verdictOf(realGate({ p: pty }), 'p').blockReason, 'recently-active');
});

test('置顶会话：不算闲着、一键休眠不碰；「释放内存」面板口径仍可手动勾选', () => {
  const sm = realGate({ p: idleSession({}, { pinned: true }) });
  assert.equal(verdictOf(sm, 'p').blockReason, 'pinned');
  assert.equal(sm.describeSessionsForMemory({ now: Date.now() }).find(r => r.id === 'p').suspendable, true);
});

test('CodeAgent-Lite 会话：不算闲着（共用后台，单休眠腾不出内存）', () => {
  const lite = idleSession({}, { kind: 'codeagent', codeagentRunMode: 'serve', runtimeBackend: 'acp', agentRuntime: null, acpSid: 'ses_lite01', ccSessionId: 'ses_lite01',
    nativeRuntime: { connection: 'connected', state: 'idle' }, status: 'idle' });
  lite.agentTurnFinishedAt = Date.now() - HOUR;
  assert.equal(verdictOf(realGate({ l: lite }), 'l').blockReason, 'codeagent-lite');
});

test('待用户确认 / 回答的会话：不算闲着（面板口径也拦）', () => {
  const sm = realGate({ q: idleSession({}, { needsUserInput: true }), m: idleSession({}, { modelConfirmationRequired: true }) });
  assert.equal(verdictOf(sm, 'q').blockReason, 'needs-user-input');
  assert.equal(verdictOf(sm, 'm').blockReason, 'needs-user-input');
  assert.equal(MEMORY_RELEASE_SUSPEND_OPTIONS.excludeNeedsInput, true);
  assert.equal(MEMORY_RELEASE_SUSPEND_OPTIONS.requireSettledCodeAgent, true);
});

test('CodeAgent 终端回合外还有输入：不算闲着', () => {
  const t = Date.now() - HOUR;
  const ca = idleSession({ agentTurnFinishedAt: t, lastInputAt: t + 1000 }, { kind: 'codeagent' });
  assert.equal(verdictOf(realGate({ x: ca }), 'x').blockReason, 'codeagent-not-settled');
});

// 受保护会话经 watch 的 getProtectedSessionIds 进来：计数不算、一键休眠不碰。
function protectedWatch(sm, getProtectedSessionIds) {
  const suspended = [];
  const orig = sm.suspendSession;
  sm.suspendSession = function (id, opts) { const v = this._evaluateSuspendEligibility(id, opts); if (v.ok) suspended.push(id); return v.ok ? { ok: true } : v; };
  const watch = createMemoryPressureWatch({
    getSessionManager: () => sm, getProtectedSessionIds, send() {},
    osApi: { totalmem: () => 32 * GB, freemem: () => 2 * GB },
    createInspector: () => ({ snapshot: async () => ({}) }), treeBytes: () => [], listServeHosts: () => [],
    delay: async () => {}, setIntervalFn: () => null, logger: { log() {}, warn() {} },
  });
  void orig;
  return { watch, suspended };
}

test('组队负责人与成员：不算闲着、一键休眠不碰；main.js 把组队会话加进受保护名单', async () => {
  const sm = realGate({ lead: idleSession(), member: idleSession({}, { hubTeamMember: true }), free: idleSession() });
  const team = { teamOfLead: id => id === 'lead', teamOfMember: () => null };
  const { watch, suspended } = protectedWatch(sm, () => {
    const ids = new Set();
    for (const [sid, s] of sm.sessions) if (s.info.hubTeamMember || team.teamOfMember(sid) || team.teamOfLead(sid)) ids.add(sid);
    return ids;
  });
  const s = await watch.check({});
  assert.deepEqual(s.idleIds, ['free']);
  const r = await watch.suspendIdle();
  assert.deepEqual(suspended, ['free']);
  assert.equal(r.requested, 1);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const block = main.slice(main.indexOf('createMemoryPressureWatch({'), main.indexOf('memoryPressureWatch.start()'));
  assert.match(block, /hubTeamMember/);
  assert.match(block, /teamOfLead/);
  assert.match(block, /collectProtectedSessionIds\(/);
});

test('WeLink 手机连线的会话：不算闲着、一键休眠不碰', async () => {
  const sm = realGate({ wl: idleSession(), free: idleSession() });
  const { watch, suspended } = protectedWatch(sm, () => collectProtectedSessionIds({ getWelinkLinkedIds: () => ['wl'] }));
  assert.deepEqual((await watch.check({})).idleIds, ['free']);
  await watch.suspendIdle();
  assert.deepEqual(suspended, ['free']);
});

test('会议录制 / 理解中的会话：不算闲着、一键休眠不碰', async () => {
  const sm = realGate({ mt: idleSession(), free: idleSession() });
  const { watch, suspended } = protectedWatch(sm, () => collectProtectedSessionIds({ getCompanyMeetings: () => ({ protectedSessionIds: () => ['mt'] }) }));
  assert.deepEqual((await watch.check({})).idleIds, ['free']);
  await watch.suspendIdle();
  assert.deepEqual(suspended, ['free']);
});

test('界面：外部切了低开销模式，按钮立刻跟上', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'memory-pressure-bar.js'), 'utf8');
  assert.match(src, /lowOverhead\?\.onChange\?\.\(/);
});

test('进程树合计：按根进程累加整棵树、同一进程只算一次（公开版不依赖公司通道模块）', () => {
  const { sessionTreeBytes } = require('../main/memory-pressure-watch');
  const processes = [
    { pid: 10, ppid: 1, wsBytes: 100 }, { pid: 11, ppid: 10, wsBytes: 50 }, { pid: 12, ppid: 11, wsBytes: 25 },
    { pid: 20, ppid: 1, wsBytes: 300 },
  ];
  const out = sessionTreeBytes({ processes }, [{ id: 'a', pid: 10 }, { id: 'b', pid: 20 }, { id: 'dup', pid: 11 }, { id: 'gone', pid: 99 }]);
  assert.deepEqual(out, [{ id: 'a', bytes: 175, processes: 3 }, { id: 'b', bytes: 300, processes: 1 }, { id: 'dup', bytes: 0, processes: 0 }]);
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'memory-pressure-watch.js'), 'utf8');
  assert.doesNotMatch(src, new RegExp(['company', 'bridge'].join('-')));
});

test('量出 0（进程快照还没有这个会话）不缓存，下一轮重量', async () => {
  let calls = 0;
  const sm = { sessions: new Map(), describeSessionsForMemory: () => [{ id: 'a', suspendable: true, ptyPid: 11 }], suspendSession: () => ({ ok: true }) };
  const watch = createMemoryPressureWatch({ getSessionManager: () => sm, send() {}, osApi: { totalmem: () => 32 * GB, freemem: () => 2 * GB },
    createInspector: () => ({ snapshot: async () => ({}) }), treeBytes: () => { calls += 1; return [{ id: 'a', bytes: calls === 1 ? 0 : GB, processes: 3 }]; },
    listServeHosts: () => [], delay: async () => {}, setIntervalFn: () => null, logger: { log() {}, warn() {} } });
  assert.equal((await watch.check({})).idleBytes, null);
  assert.equal((await watch.check({})).idleBytes, GB);
  assert.equal(calls, 2);
});
