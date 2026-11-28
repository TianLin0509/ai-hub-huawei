'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ---- 1. 看得见的变化判断（renderer/surface-change-gate.js）----
const gate = require('../renderer/surface-change-gate.js');
{
  const { surfaceSignature: sig, persistSignature, telemetrySignature, sameSurface: same } = gate;
  const base = () => ({ id: 's1', kind: 'claude', title: 'A', contextPct: 10, contextUsed: 1000, sessionUsage: { total: 5 },
    currentModel: { id: 'opus' }, unreadCount: 0, lastMessageTime: 1, updatedAt: 1, _tokenSamples: [], apiMs: 1 });
  const before = base();
  const tele = { ...base(), contextUsed: 2000, sessionUsage: { total: 9 }, apiMs: 99, updatedAt: 2, _tokenSamples: [{ t: 1, used: 2 }] };
  assert.ok(same(sig(before), sig(tele)), '只改 token 数、累计用量、接口耗时：侧栏不重绘');
  assert.ok(!same(sig(before, { details: true }), sig(tele, { details: true })), '会话详情打开时累计用量可见，要重绘');
  assert.ok(!same(sig(before), sig({ ...base(), contextPct: 11 })), '上下文百分比首页和详情都显示，要重绘');
  assert.ok(!same(sig(before), sig({ ...base(), title: 'B' })), '标题变了要重绘');
  assert.ok(!same(sig(before), sig({ ...base(), unreadCount: 1 })), '未读变了要重绘');
  assert.ok(same(sig(before), sig({ ...base(), currentModel: { id: 'opus' } })), '模型对象换了新副本但内容相同：不重绘');
  assert.ok(!same(sig(before), sig({ ...base(), currentModel: { id: 'sonnet' } })), '模型变了要重绘');
  assert.ok(!same(sig(before), sig({ ...base(), brandNewField: 1 })), '没登记过的新字段变了照旧重绘（排除清单，不是白名单）');
  const nat = (extra) => ({ ...base(), nativeRuntime: { state: 'running', connection: 'connected', revision: 1, items: [1], ...extra } });
  assert.ok(same(sig(nat()), sig(nat({ revision: 2, items: [1, 2] }))), '原生快照只是版本号和内容条目变了：侧栏不重绘');
  assert.ok(!same(sig(nat()), sig(nat({ state: 'waiting' }))), '原生快照运行状态变了要重绘');
  assert.ok(!same(persistSignature(nat()), persistSignature(nat({ revision: 2 }))), '原生快照换了版本照旧保存');
  assert.ok(same(persistSignature(before), persistSignature(tele)), '纯遥测不触发立即保存');
  assert.ok(same(persistSignature(before), persistSignature({ ...base(), contextPct: 50 })), '上下文百分比走慢保存');
  assert.ok(!same(telemetrySignature(before), telemetrySignature({ ...base(), contextPct: 50 })), '上下文变了要排慢保存');
  assert.ok(!same(persistSignature(before), persistSignature({ ...base(), title: 'B' })), '标题变了立即保存');
  const cyclic = base(); cyclic._timer = {}; cyclic._timer.self = cyclic._timer;
  assert.ok(same(sig(cyclic), sig(cyclic)), '有环的本地字段不抛错，按引用比');
}

// ---- 1b. session-updated 的排期：可见→重绘，落盘字段→保存，只有遥测→慢保存，不认识的会话照旧保存 ----
{
  const calls = [];
  const g = gate.createSessionUpdateGate({ render: () => calls.push('render'), persist: () => calls.push('persist'), telemetryPersist: () => calls.push('slow') });
  const s = { id: 'x', title: 'A', contextUsed: 1, contextPct: 1, sessionUsage: { total: 1 } };
  let t = g.begin(s); s.contextUsed = 2; s.sessionUsage = { total: 2 }; t.finish();
  assert.deepEqual(calls.splice(0), ['slow'], '只有遥测：不重绘、不立即保存，排慢保存');
  t = g.begin(s); s.sessionUsage = { total: 3 }; t.finish();
  assert.deepEqual(calls.splice(0), [], '只有累计用量：主进程自己记账，什么都不排');
  t = g.begin(s); s.title = 'B'; t.finish();
  assert.deepEqual(calls.splice(0), ['render', 'persist'], '标题变了：重绘并保存');
  t = g.begin(s); t.finish();
  assert.deepEqual(calls.splice(0), [], '没变化：什么都不排');
  g.begin(undefined).finish();
  assert.deepEqual(calls.splice(0), ['persist'], '不认识的会话照旧保存');
}

// ---- 2. 渲染层接线：用量事件不再白写 state.json，session-updated 不再无条件保存/重绘 ----
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const usage = src.slice(src.indexOf("ipcRenderer.on('session-usage-updated'"), src.indexOf("ipcRenderer.on('status-event'"));
  assert.ok(usage.length > 0 && !/schedulePersist\(\)/.test(usage), 'session-usage-updated 不再发起保存（主进程自己记账）');
  assert.ok(!/scheduleSessionListRender\(\);\s*\n\s*schedulePersist\(\);/.test(usage), '用量事件不再无条件重绘');
  assert.doesNotMatch(src, /\['session-created', 'session-closed', 'session-suspended', 'session-updated'/, 'session-updated 不再挂在无条件保存清单上');
  const status = src.slice(src.indexOf("ipcRenderer.on('status-event'"), src.indexOf("ipcRenderer.on('agent-usage'"));
  assert.match(status, /if \(surfaceChanged\) scheduleSessionListRender\(\);/, 'status-event 只为可见变化重绘');
  assert.match(src, /TELEMETRY_PERSIST_MS = 30000/, '遥测慢保存 30 秒');
}


// ---- 5. 交叉审查（codex1）三项回归：走真实监听体 / 控制器 ----
const vm = require('node:vm');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
function realListener(event, globals) {
  const start = rendererSource.indexOf(`ipcRenderer.on('${event}',`);
  const end = rendererSource.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start, `找到真实 ${event} 监听体`);
  let handler;
  vm.runInNewContext(rendererSource.slice(start, end + 4), { ipcRenderer: { on: (_n, fn) => { handler = fn; } }, ...globals });
  return handler;
}
function gateGlobals(counts, sessions) {
  const g = gate;
  return {
    sessions, require, queueMicrotask, turnCardRenderer: { refreshCardActions() {} }, sameSurface: g.sameSurface, surfaceSignature: g.surfaceSignature, persistSignature: g.persistSignature, telemetrySignature: g.telemetrySignature,
    sessionSurfaceSignature: s => g.surfaceSignature(s), sessionListRenderer: { isDetailsEnabled: () => false },
    schedulePersist: () => counts.persist++, scheduleTelemetryPersist: () => counts.slow++, scheduleSessionListRender: () => counts.render++,
    sessionUpdateGate: g.createSessionUpdateGate({ render: () => counts.render++, persist: () => counts.persist++, telemetryPersist: () => counts.slow++ }),
  };
}

// ① status-event 只改外部标题 / 首次目录（同模型、同上下文）也要立即保存，之后只来用量事件也不影响。
{
  const { shouldAcceptExternalSessionTitle } = require('../core/session-title-guards.js');
  for (const [name, payload, check] of [
    ['外部标题', { sessionName: 'Renamed externally' }, s => s.title === 'Renamed externally'],
    ['首次目录', { cwd: 'D:/work/new' }, s => s.cwd === 'D:/work/new'],
  ]) {
    const local = { id: 'c1', kind: 'claude', title: 'Claude 1', cwd: name === '外部标题' ? 'D:/work' : null, currentModel: { id: 'opus' }, contextPct: 10, contextUsed: 100, lastMessageTime: 1 };
    const sessions = new Map([['c1', local]]);
    const counts = { persist: 0, slow: 0, render: 0 };
    const globals = { ...gateGlobals(counts, sessions), activeSessionId: null, shouldAcceptExternalSessionTitle, toolbarCrumbEl: null,
      accountUsageController: { recordSessionContextSample() {}, recordStatusUsage() {} }, isCodexConversationModelId: () => true,
      updateActiveModelChip() {}, updateActiveMetricsRow() {}, scheduleFloatingBarState() {} };
    const status = realListener('status-event', globals);
    const usage = realListener('session-usage-updated', globals);
    status(null, { sessionId: 'c1', model: { id: 'opus' }, contextPct: 10, contextUsed: 100, ...payload });
    usage(null, { sessionId: 'c1', usage: { total: 5 } });
    assert.ok(check(local), `${name}已写进会话`);
    assert.equal(counts.persist, 1, `status-event 改${name}要立即保存（审查必改 1）`);
    assert.equal(counts.render, 1, `${name}变了要重绘`);
  }
}

// ② 原生快照：提交待核对出现 / 解除、同数量待答请求换了内容，侧栏都要重绘。
{
  const { sessionRuntimeIssue } = require('../core/session-runtime-issue.js');
  const nativeRuntime = (extra = {}) => ({ state: 'idle', connection: 'connected', epoch: 1, revision: 1, threadId: 't', turnId: 'u1', requests: [],
    endedTurns: [], waitingFlags: [], reason: null, submission: { status: 'submitting' }, ...extra });
  const local = { id: 'n1', kind: 'codex', title: 'Codex 1', runtimeBackend: 'codex-app-server', agentRuntime: 'native', lastMessageTime: 1, nativeRuntime: nativeRuntime() };
  const sessions = new Map([['n1', local]]);
  const counts = { persist: 0, slow: 0, render: 0 };
  const native = require('../core/codex-native-runtime.js');
  const update = realListener('session-updated', { ...gateGlobals(counts, sessions), window: {}, document: { querySelectorAll: () => [] },
    nativeSessionBootstrap: { record() {} }, isNativeSession: native.isNativeSession, acceptNativeSnapshot: native.acceptNativeSnapshot,
    floatingInputDrafts: new Map(), clearRuntimeTruthExpiryTimer() {}, clearPtyRunningAnimationCandidate() {}, _updateStreamingIndicator() {},
    scheduleFloatingBarState() {}, codexAccountUi: require('../renderer/composer-codex-account'),
    claudeSessionAccountMeta: require('../core/session-capabilities').claudeSessionAccountMeta, activeSessionId: null });
  const push = (rev, extra) => update(null, { session: { id: 'n1', kind: 'codex', runtimeBackend: 'codex-app-server', nativeRuntime: nativeRuntime({ revision: rev, ...extra }) } });
  assert.equal(sessionRuntimeIssue(local), null);
  push(2, { submission: { status: 'unknown' } });
  assert.equal(sessionRuntimeIssue(local)?.label, '状态待核对', '真实告警计算已出现待核对');
  assert.equal(counts.render, 1, '提交待核对出现要重绘（审查必改 2）');
  push(3, { submission: { status: 'accepted' } });
  assert.equal(sessionRuntimeIssue(local), null);
  assert.equal(counts.render, 2, '待核对解除要重绘');
  const ask = q => [{ id: 'r1', method: 'item/tool/requestUserInput', params: { questions: [{ question: q }] } }];
  push(4, { state: 'waiting', requests: ask('A?') });
  const before = counts.render;
  push(5, { state: 'waiting', requests: ask('B?') });
  assert.equal(counts.render, before + 1, '待答请求数量不变但内容换了要重绘');
  push(6, { state: 'waiting', requests: ask('B?') });
  assert.equal(counts.render, before + 1, '只换版本号不重绘');
  assert.equal(counts.persist, 5, '原生快照每换一个版本都照旧保存');
}

