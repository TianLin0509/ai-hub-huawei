'use strict';
// 黄区菜单状态回归：执行真实的 renderer 状态入口，使用模型菜单夹具，不连接公司账号。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { formatContextWindow } = require('../renderer/model-ui');
const runtime = require('../core/session-runtime-truth');
const attention = require('../core/session-attention-state');
const classifier = require('../core/terminal-runtime-state');
const kinds = require('../core/ai-kinds');
const file = require.resolve('../renderer/renderer');
const source = fs.readFileSync(file, 'utf8');
const menu = ['Select model', '⌕ Search…', '❯ 1. GLM-5.2-WX-Auto', '  2. DeepSeek-V4.1', 'Navigate ↑ ↓ | Select enter | Back esc'];
const ready = ['│ > Anything I can assist you with? │', 'Bypass (Cycle shift+tab) | GLM-5.2'];

test('上下文整数格式：真实 202752/409600、百万和未知值', () => {
  for (const [value, text] of [[202752, '203K'], [409600, '410K'], [200000, '200K'], [1000000, '1M'], [2000000, '2M'], [1536000, '1536K'], [0, '上下文未知'], [NaN, '上下文未知']]) {
    assert.equal(formatContextWindow(value), text);
  }
});

test('模型菜单优先于遮在后面的运行行；普通回答中的模型列表不是菜单', () => {
  assert.equal(classifier.classifyTerminalRuntime('codeagent', ['⠋ Running…', ...menu]).state, 'waiting');
  assert.equal(classifier.classifyTerminalRuntime('codeagent-resume', menu).reason, 'codeagent-model-menu');
  assert.equal(classifier.classifyTerminalRuntime('codeagent', ['1. GLM-5.2', '2. DeepSeek-V4.1', ...ready]).state, 'idle');
  assert.equal(classifier.classifyTerminalRuntime('codeagent', ['⠋ Running…', '> 补充指令（Enter 排队等待发送）...']).state, 'running');
});

function fixture(kind = 'codeagent') {
  let lines = menu;
  const context = vm.createContext({
    ...runtime, ...attention, ...kinds, isCodexKind: kinds.isCodexSessionKind,
    require: createRequire(file), Date, clearTimeout,
    isNativeSession: () => false, isClaudeRuntimeSession: () => false, isAiRuntimeSession: () => true,
    classifyTerminalRuntime: classifier.classifyTerminalRuntime,
    terminalActivityMonitor: { extractLiveScreenLines: () => lines },
    getSessionRuntimeTruth: runtime.getSessionRuntimeTruth,
    observeSessionRuntime: runtime.applySessionRuntimeObservation,
    ptyTurnClosedAuthoritatively: () => false,
    clearPtyRunningAnimationCandidate() {}, clearPtyInputReadyCandidate() {},
    ptyInputReadyIsStable: () => true, claudeBackgroundKeepsRunning: () => false,
    disarmPtyBurstFallback(s) { s._ptyFallbackArmedUntil = 0; s._ptyRuntimeSawRunning = false; },
    clearCodexCardWorking() { session.cardWorkingSince = null; session.cardWorkingSource = null; context.disarmPtyBurstFallback(session); },
    updateFloatingBarState() {}, scheduleSessionListRender() {}, schedulePersist() {},
    PTY_RUNTIME_SUBMIT_PENDING_MS: 1500,
  });
  for (const name of ['canUsePtyBurstFallback', 'classifySessionRuntimeFrame', 'ptyObservationSidebarSignature', 'applyPtyRuntimeObservation']) {
    const start = source.indexOf('function ' + name + '(');
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, name);
    vm.runInContext(source.slice(start, end), context);
  }
  const session = { id: 'menu', kind, agentRuntime: 'pty', status: 'idle', _ptyFallbackArmedUntil: Date.now() + 10000 };
  return { context, session, frame(value) { lines = value; return context.classifySessionRuntimeFrame(session, lines); } };
}

test('renderer：菜单重绘不触发字节兜底，误报工作中和空闲态均进入等待；Esc 后恢复就绪', () => {
  for (const initial of ['idle', 'running', 'completed']) {
    const { context: c, session: s, frame } = fixture();
    const now = Date.now();
    if (initial === 'running') runtime.applySessionRuntimeObservation(s, { state: 'running', source: 'pty-byte-burst', confidence: 'fallback', observedAt: now - 10 });
    if (initial === 'completed') runtime.applySessionRuntimeObservation(s, { state: 'completed', source: 'hook', confidence: 'authoritative', observedAt: now - 10 });
    s.cardWorkingSince = now - 10; s.cardWorkingSource = 'floating_input';
    assert.equal(c.canUsePtyBurstFallback(s, now), false);
    c.applyPtyRuntimeObservation(s, frame(menu), now);
    assert.equal(runtime.getSessionRuntimeTruth(s, { now }).state, 'waiting');
    assert.notEqual(s.status, 'running');
    assert.equal(s._ptyFallbackArmedUntil, 0);
    assert.equal(s.cardWorkingSince, null);
    c.applyPtyRuntimeObservation(s, frame(ready), now + 100);
    assert.equal(runtime.getSessionRuntimeTruth(s, { now: now + 100 }).state, 'completed');
    assert.equal(attention.sessionNeedsUserInput(s), false);
  }
});
