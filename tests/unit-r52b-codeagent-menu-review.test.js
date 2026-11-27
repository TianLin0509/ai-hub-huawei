'use strict';
// R52b：CodeAgent 方向键菜单返工（2026-11-27 Antigravity 审查 4 个 P1、2 个 P2）。每条撤掉对应修复都会失败。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const runtime = require('../core/session-runtime-truth');
const attention = require('../core/session-attention-state');
const classifier = require('../core/terminal-runtime-state');
const kinds = require('../core/ai-kinds');
const choiceScreen = require('../core/choice-menu-screen');
const ptyChoice = require('../core/pty-choice-menu');

const CA_MENU = [
  ' ● Bash(dir)',
  '',
  ' Allow this command?',
  ' ❯ Allow once',
  '   Allow always',
  '   Reject',
  '',
  ' Navigate ↑ ↓ | Select enter | Back esc',
];
const CA_READY = ['│ > Anything I can assist you with? │', 'Bypass (Cycle shift+tab) | GLM-5.2'];
const GROUPED = fs.readFileSync(path.join(__dirname, 'fixtures', 'codeagent-model-picker-grouped-real.txt'), 'utf8').split(/\r?\n/);
// 同一份多分组菜单，光标移到 Custom 组第 1 项
const GROUPED_CUSTOM = (() => {
  const rows = GROUPED.map(l => l.replace('❯  2. GLM-5.3', '   2. GLM-5.3'));
  const at = rows.findIndex((l, i) => i > rows.findIndex(x => /^\s*Custom\s*$/.test(x)) && /^\s+1\.\s/.test(l));
  rows[at] = rows[at].replace(/^(\s*)\s\s1\./, '$1❯  1.');
  return rows;
})();

// ---- P1-1：renderer 状态机放行 codeagent-choice-menu ----
const rendererFile = require.resolve('../renderer/renderer');
const rendererSource = fs.readFileSync(rendererFile, 'utf8');
function rendererFixture() {
  let lines = CA_MENU;
  const context = vm.createContext({
    ...runtime, ...attention, ...kinds, isCodexKind: kinds.isCodexSessionKind,
    require: createRequire(rendererFile), Date, clearTimeout, Set,
    isNativeSession: () => false, isClaudeRuntimeSession: () => false, isAiRuntimeSession: () => true,
    classifyTerminalRuntime: classifier.classifyTerminalRuntime,
    terminalActivityMonitor: { extractLiveScreenLines: () => lines },
    getSessionRuntimeTruth: runtime.getSessionRuntimeTruth,
    observeSessionRuntime: runtime.applySessionRuntimeObservation,
    ptyTurnClosedAuthoritatively: () => false,
    clearPtyRunningAnimationCandidate() {}, clearPtyInputReadyCandidate() {},
    ptyInputReadyIsStable: () => true, claudeBackgroundKeepsRunning: () => false,
    disarmPtyBurstFallback(s) { s._ptyFallbackArmedUntil = 0; s._ptyRuntimeSawRunning = false; },
    clearCodexCardWorking() {},
    updateFloatingBarState() {}, scheduleSessionListRender() {}, schedulePersist() {},
    PTY_RUNTIME_SUBMIT_PENDING_MS: 1500,
  });
  const decl = /^const CODEAGENT_MENU_REASONS = .*$/m.exec(rendererSource);
  assert.ok(decl, 'renderer 里有 CODEAGENT_MENU_REASONS');
  vm.runInContext(decl[0].replace(/^const /, 'var '), context);
  for (const name of ['canUsePtyBurstFallback', 'classifySessionRuntimeFrame', 'ptyObservationSidebarSignature', 'applyPtyRuntimeObservation']) {
    const start = rendererSource.indexOf('function ' + name + '(');
    const end = rendererSource.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, name);
    vm.runInContext(rendererSource.slice(start, end), context);
  }
  const session = { id: 'm', kind: 'codeagent', agentRuntime: 'pty', status: 'idle' };
  return { c: context, s: session, frame(value) { lines = value; return context.classifySessionRuntimeFrame(session, lines); } };
}

test('P1-1 空闲时弹出的 CodeAgent 选择框进「等你操作」；按 Esc 回到输入框后退出等待，不卡住', () => {
  const { c, s, frame } = rendererFixture();
  const now = Date.now();
  c.applyPtyRuntimeObservation(s, frame(CA_MENU), now);
  assert.equal(runtime.getSessionRuntimeTruth(s, { now }).state, 'waiting', '空闲态下弹框也要报等待');
  c.applyPtyRuntimeObservation(s, frame(CA_READY), now + 100);
  assert.notEqual(runtime.getSessionRuntimeTruth(s, { now: now + 100 }).state, 'waiting', '回到输入框要退出等待');
  assert.equal(attention.sessionNeedsUserInput(s), false);
});

test('P1-1 从执行中进入选择框、选完回到输入框：同样退出等待', () => {
  const { c, s, frame } = rendererFixture();
  const now = Date.now();
  runtime.applySessionRuntimeObservation(s, { state: 'running', source: 'hook', confidence: 'strong', observedAt: now - 10 });
  c.applyPtyRuntimeObservation(s, frame(CA_MENU), now);
  assert.equal(runtime.getSessionRuntimeTruth(s, { now }).state, 'waiting');
  c.applyPtyRuntimeObservation(s, frame(CA_READY), now + 100);
  assert.notEqual(runtime.getSessionRuntimeTruth(s, { now: now + 100 }).state, 'waiting');
});

// ---- P1-2：旧菜单底栏留在输入框上方 / 输出里含底栏字样，不误报等待 ----
test('P1-2 旧菜单底栏留在空闲输入框上方：报空闲，不报等你选择', () => {
  const rt = classifier.classifyTerminalRuntime('codeagent', [' Reject', '', ' Navigate ↑ ↓ | Select enter | Back esc', ...CA_READY]);
  assert.notEqual(rt.state, 'waiting');
  assert.equal(rt.reason, 'codeagent-input-ready');
});

test('P1-2 执行中输出末尾带底栏字样：报执行中', () => {
  const rt = classifier.classifyTerminalRuntime('codeagent', ['docs: press Select enter to pick', '⠋ Running…', '> 补充指令（Enter 排队等待发送）...']);
  assert.equal(rt.state, 'running');
});

test('P1-2 真正停在选择框上仍报等你选择', () => {
  assert.equal(classifier.classifyTerminalRuntime('codeagent', CA_MENU).reason, 'codeagent-choice-menu');
});

// ---- P1-3：输入框排除规则下沉到 choice-menu-screen；群聊发送预筛认无编号菜单 ----
test('P1-3 旧菜单下面已是带占位符的输入框：菜单识别（发送前守卫用的同一个）不当菜单', () => {
  assert.equal(choiceScreen.detectChoiceMenu([...CA_MENU, '╭────╮', '│ > Anything I can assist you with? │', '╰────╯']), null);
  assert.equal(choiceScreen.detectChoiceMenu([...CA_MENU, '❯ 我的草稿']), null);
  assert.ok(choiceScreen.detectChoiceMenu(CA_MENU), '真正的菜单照常识别');
});

test('P1-3 codeagent-input-guard 的菜单检查：旧菜单留在输入框上方不拒发', () => {
  const src = fs.readFileSync(require.resolve('../core/codeagent-input-guard'), 'utf8');
  const start = src.indexOf('function choiceMenuOpen(');
  const fn = vm.runInNewContext('(' + src.slice(start, src.indexOf('\n}', start) + 2) + ')', { require: createRequire(require.resolve('../core/codeagent-input-guard')) });
  assert.equal(fn([...CA_MENU, '│ > Anything I can assist you with? │', 'Bypass (Cycle shift+tab) | GLM-5.2']), false);
  assert.equal(fn(CA_MENU), true);
});

test('P1-3 群聊发送前的菜单预筛认得无编号方向键菜单（不再直接落到守卫按 Esc 关掉授权框）', async () => {
  const { visibleChoiceMenu } = require('../core/group-chat-watcher')._private;
  const sessionManager = { getSessionBuffer: () => CA_MENU.join('\r\n') + '\r\n' };
  const menu = await visibleChoiceMenu(sessionManager, 's1');
  assert.ok(menu, '要认出菜单');
  assert.deepEqual(menu.options.map(o => o.label), ['Allow once', 'Allow always', 'Reject']);
  const idle = { getSessionBuffer: () => ['● 好了', '  - 一', '  - 二', ...CA_READY].join('\r\n') };
  assert.equal(await visibleChoiceMenu(idle, 's1'), null);
});

// ---- P1-4：模型菜单（含 R53 多分组）与 Hub 自动选模型期间不当卡片选择题 ----
test('P1-4 多分组模型菜单（光标在 Built-in 或 Custom）都不渲染成卡片选项', () => {
  assert.equal(require('../core/codeagent-model-picker').modelDialogVisible(GROUPED), true);
  assert.equal(ptyChoice.describeMenu(GROUPED), null);
  assert.equal(ptyChoice.describeMenu(GROUPED_CUSTOM), null, '光标在 Custom 组时以前会只画出 Custom 9 项');
  // 状态仍报模型菜单，卡片走「请到后台选择模型」
  assert.equal(classifier.classifyTerminalRuntime('codeagent', GROUPED_CUSTOM).reason, 'codeagent-model-menu');
});

function fakeChoice(screens, { picking = false } = {}) {
  const writes = [];
  let opened = 0;
  const manager = { sessions: new Map([['s1', { pty: {}, info: {} }]]), writeToSession: (sid, d) => writes.push(d) };
  const api = ptyChoice.createPtyChoiceMenu(manager, {
    openScreen: async () => { opened += 1; return { lines: async () => screens[0], dispose() {} }; },
    rules: () => undefined, sleep: async () => {}, log: () => {}, isPicking: () => picking,
  });
  return { api, writes, opened: () => opened };
}

test('P1-4 Hub 后台自动选模型期间：读屏直接返回 picking，不打开屏幕；点选被拒、一个键不按', async () => {
  const f = fakeChoice([CA_MENU], { picking: true });
  const r = await f.api.read('s1');
  assert.equal(r.ok, true);
  assert.equal(r.picking, true);
  assert.equal(r.menu, null);
  assert.equal(f.opened(), 0);
  const a = await f.api.answer('s1', { signature: 'x', key: '1' });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'model-picking');
  assert.deepEqual(f.writes, []);
});

test('P1-4 手动 /model 打开的模型菜单：读屏无菜单，点选回执 menu-gone，不按键', async () => {
  const f = fakeChoice([GROUPED_CUSTOM]);
  assert.equal((await f.api.read('s1')).menu, null);
  const a = await f.api.answer('s1', { signature: 'x', key: '1' });
  assert.equal(a.reason, 'menu-gone');
  assert.deepEqual(f.writes, []);
});

// ---- 卡片提示条（renderer/pty-attention-controls.js） ----
function fakeDom() {
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.handlers = {}; this.hidden = false; this.textContent = ''; this.connected = false; this.card = false; }
    setAttribute() {}
    append(...c) { this.children.push(...c); }
    replaceChildren(...c) { this.children = c; }
    addEventListener(t, fn) { this.handlers[t] = fn; }
    closest(sel) { return sel === '.card-view-active' && this.card ? this : null; }
    get isConnected() { return this.connected; }
  }
  return { createElement: tag => new El(tag) };
}
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const MENU = { kind: 'permission', question: '允许执行 dir？', signature: 'sig-1', options: [{ key: '1', label: 'Allow once', short: 'Allow once', tone: 'allow', selected: true }, { key: '2', label: 'Reject', short: 'Reject', tone: 'deny' }] };
function loadUi() {
  global.document = fakeDom();
  delete require.cache[require.resolve('../renderer/pty-attention-controls')];
  return require('../renderer/pty-attention-controls');
}
const ev = key => ({ key, preventDefault() {} });
const live = new Set();
test.afterEach(() => { for (const c of live) c.dispose(); live.clear(); delete global.document; });

test('P1-4 自动选模型期间多次读屏：提示条不出现「去后台」、不接管键盘', async () => {
  const ui = loadUi();
  let calls = 0;
  const writes = [];
  const c = ui.createPtyAttentionControls({ invoke: async () => { calls += 1; return { ok: true, menu: null, picking: true }; }, writeTerminal: (s, d) => writes.push(d) });
  live.add(c); c.element.connected = true; c.element.card = true;
  c.update({ id: 's1', agentRuntime: 'pty' }, { state: 'waiting', reason: 'codeagent-model-menu', detail: '请到「后台」选择模型，或按 Esc 退出菜单' });
  await sleepMs(4200); // 首读 + 3 次 1.2 秒轮询，以前第 3 次就转「去后台」兜底
  assert.ok(calls >= 4, `读了 ${calls} 次`);
  assert.equal(c.element.hidden, true);
  assert.equal(c.forwardKey(ev('ArrowDown'), true), false);
  assert.deepEqual(writes, []);
  c.dispose();
  delete global.document;
});

// R52c 复审 P1-1：runtime 必须是 deriveSessionRuntimeStatus 的真实输出（以前手工传 reason，掩盖了真实链路没带出 reason）
function realModelMenuRuntime() {
  const { c, s, frame } = rendererFixture();
  const now = Date.now();
  c.applyPtyRuntimeObservation(s, frame(GROUPED), now);
  const derived = require('../renderer/session-runtime-status').deriveSessionRuntimeStatus(s, { now });
  return { s, derived };
}

test('P1-4 手动 /model 菜单（真实链路）：提示条维持「请到后台选择模型」，方向键/回车不转发给终端', async () => {
  const { s, derived } = realModelMenuRuntime();
  assert.equal(derived.state, 'waiting');
  const ui = loadUi();
  const writes = [];
  const c = ui.createPtyAttentionControls({ invoke: async () => ({ ok: true, menu: null }), writeTerminal: (sid, d) => writes.push(d) });
  live.add(c); c.element.connected = true; c.element.card = true;
  c.update(s, derived);
  await sleepMs(3000);
  assert.equal(c.element.dataset.mode, 'fallback');
  assert.equal(c.element.hidden, false);
  assert.match(c.element.children[0].textContent, /后台/);
  assert.equal(c.element.children[5].hidden, true, '不显示「或按 ↑↓ 回车」');
  assert.equal(c.forwardKey(ev('Enter'), true), false);
  assert.equal(c.forwardKey(ev('ArrowDown'), true), false);
  assert.deepEqual(writes, []);
});

test('R52c P1-1 deriveSessionRuntimeStatus 带出等待原因 codeagent-model-menu', () => {
  const { derived } = realModelMenuRuntime();
  assert.equal(derived.reason, 'codeagent-model-menu');
});

test('R52c P1-1 runtime 没带 reason 时，提示条兜底取会话上的等待原因', async () => {
  const ui = loadUi();
  const writes = [];
  const c = ui.createPtyAttentionControls({ invoke: async () => ({ ok: true, menu: null }), writeTerminal: (sid, d) => writes.push(d) });
  live.add(c); c.element.connected = true; c.element.card = true;
  c.update({ id: 's1', agentRuntime: 'pty', waitingReason: 'codeagent-model-menu' }, { state: 'waiting', detail: '请到「后台」选择模型，或按 Esc 退出菜单' });
  await sleepMs(3000);
  assert.equal(c.element.dataset.mode, 'fallback');
  assert.equal(c.element.children[5].hidden, true);
  assert.equal(c.forwardKey(ev('Enter'), true), false);
  assert.deepEqual(writes, []);
});

test('P2-5 回车发给终端后、下次读屏回来前：紧接着按的 ↑ 不再被当成菜单键', async () => {
  const ui = loadUi();
  const writes = [];
  let release;
  let reads = 0;
  const c = ui.createPtyAttentionControls({
    invoke: async () => { reads += 1; if (reads > 1) await new Promise(r => { release = r; }); return { ok: true, menu: MENU }; },
    writeTerminal: (s, d) => writes.push(d),
  });
  live.add(c); c.element.connected = true; c.element.card = true;
  c.update({ id: 's1', agentRuntime: 'pty' }, { state: 'waiting', reason: 'codeagent-choice-menu', detail: 'x' });
  await sleepMs(250);
  assert.equal(c.forwardKey(ev('Enter'), true), true);
  assert.equal(c.forwardKey(ev('ArrowUp'), true), false, '回车后锁住');
  await sleepMs(600); // 读屏已发出但没回来
  assert.equal(c.forwardKey(ev('ArrowUp'), true), false, '读屏回来前仍锁住');
  release?.();
  await sleepMs(20);
  assert.equal(c.forwardKey(ev('ArrowDown'), true), true, '读屏回来、菜单还在就解锁');
  assert.deepEqual(writes, ['\r', '\x1b[B']);
  c.dispose();
  delete global.document;
});

test('P2-5 卡片里按方向键只移动高亮，不清「等你操作」；回车才清', () => {
  const start = rendererSource.indexOf('writeTerminal: (sid, data) => {');
  assert.ok(start > 0);
  const end = rendererSource.indexOf('\n    },', start);
  const body = rendererSource.slice(start + 'writeTerminal: '.length, end + '\n    }'.length);
  const cleared = [], sent = [];
  const fn = vm.runInNewContext('(' + body + ')', {
    clearSessionWaitingState: sid => cleared.push(sid),
    ipcRenderer: { send: (ch, p) => sent.push(p.data) },
  });
  fn('s1', '\x1b[B');
  fn('s1', '\x1b[A');
  assert.deepEqual(cleared, []);
  fn('s1', '\r');
  assert.deepEqual(cleared, ['s1']);
  assert.deepEqual(sent, ['\x1b[B', '\x1b[A', '\r']);
});

// ---- R52c 复审 P2-1：Windows ConPTY 用 ESC[1C 代替空格 ----
test('R52c P2-1 群聊发送前预筛认得 ConPTY 光标右移代替空格的无编号菜单', async () => {
  const { visibleChoiceMenu } = require('../core/group-chat-watcher')._private;
  const sp = s => s.replace(/ /g, '\x1b[1C');
  const raw = [
    ' ● Bash(dir)', '', ' Allow this command?',
    '\x1b[1C\x1b[36m❯\x1b[0m\x1b[1CAllow\x1b[1Conce', '\x1b[3C' + sp('Allow always'), '\x1b[3CReject', '',
    sp(' Navigate ↑ ↓ | Select enter | Back esc'),
  ].join('\r\n') + '\r\n';
  const menu = await visibleChoiceMenu({ getSessionBuffer: () => raw }, 's1');
  assert.ok(menu, 'ConPTY 缓冲也要认出菜单');
  assert.deepEqual(menu.options.map(o => o.label), ['Allow once', 'Allow always', 'Reject']);
});

// ---- R52c 复审 P2-2：回车锁两处漏锁 ----
test('R52c P2-2 按键前发出的旧读屏晚回来：不提前解锁、不取消回车后的复核', async () => {
  const ui = loadUi();
  const writes = [];
  const pending = [];
  let reads = 0;
  const c = ui.createPtyAttentionControls({
    invoke: async () => { reads += 1; if (reads === 1) return { ok: true, menu: MENU }; return new Promise(r => pending.push(r)); },
    writeTerminal: (sid, d) => writes.push(d),
  });
  live.add(c); c.element.connected = true; c.element.card = true;
  c.update({ id: 's1', agentRuntime: 'pty' }, { state: 'waiting', reason: 'codeagent-choice-menu', detail: 'x' });
  await sleepMs(220);
  assert.equal(c.forwardKey(ev('ArrowDown'), true), true);
  await sleepMs(300); // ↓ 后 250ms 的读屏已发出、还没回来
  assert.equal(pending.length, 1);
  assert.equal(c.forwardKey(ev('Enter'), true), true);
  pending.shift()({ ok: true, menu: MENU }); // 旧读屏这时才回来
  await sleepMs(20);
  assert.equal(c.forwardKey(ev('ArrowUp'), true), false, '旧读屏回来不解锁');
  await sleepMs(520); // 回车后 500ms 的复核照常发出
  assert.equal(pending.length, 1, '回车后的复核没有被旧读屏取消');
  pending.shift()({ ok: true, menu: null });
  await sleepMs(20);
  assert.deepEqual(writes, ['\x1b[B', '\r']);
});

test('R52c P2-2 「去后台」兜底时按回车：提示条收起，之后的 ↑ 不再发给终端', async () => {
  const ui = loadUi();
  const writes = [];
  const c = ui.createPtyAttentionControls({ invoke: async () => ({ ok: true, menu: null }), writeTerminal: (sid, d) => writes.push(d) });
  live.add(c); c.element.connected = true; c.element.card = true;
  c.update({ id: 's1', agentRuntime: 'pty' }, { state: 'waiting', reason: 'codeagent-choice-menu', detail: '终端在等你操作' });
  await sleepMs(3000);
  assert.equal(c.element.dataset.mode, 'fallback');
  assert.equal(c.forwardKey(ev('Enter'), true), true);
  await sleepMs(600); // 回车后 500ms 读屏：菜单已收起，状态仍是等待（输入框稳定前）
  assert.equal(c.element.hidden, true, '提示条收起');
  assert.equal(c.forwardKey(ev('ArrowUp'), true), false);
  assert.deepEqual(writes, ['\r']);
});
