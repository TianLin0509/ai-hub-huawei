'use strict';
// 卡片视图里直接回答终端选择菜单（core/pty-choice-menu.js）：识别、按键映射、核对后才按键、按用户设置自动答。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const m = require('../core/pty-choice-menu');

const PERMISSION = [
  ' ● Bash(dir)',
  '',
  ' Bash command',
  '   dir',
  '   List files',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for dir commands in D:\\work",
  '   3. No, and tell CodeAgent what to do differently (esc)',
  '',
  ' Esc to cancel · Tab to amend',
];
const BOXED_PERMISSION = [
  '╭──────────────────────────────────────────────╮',
  '│ Edit file                                    │',
  '│ Do you want to make this edit to a.txt?      │',
  '│   1. Yes                                     │',
  '│ ❯ 2. Yes, allow all edits during this session │',
  '│   3. No                                      │',
  '╰──────────────────────────────────────────────╯',
];
const QUESTION = [
  ' Which color should the button use?',
  ' ❯ 1. Blue',
  '   2. Green',
  '   3. Type something.',
  '',
  ' Enter to select · ↑/↓ to navigate · Esc to cancel',
];
const TRUST = [
  ' Accessing workspace:',
  ' D:\\work',
  ' Quick safety check: Is this a project you created or one you trust?',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  ' Enter to confirm · Esc to cancel',
];
const BYPASS = [
  ' WARNING: CodeAgent running in Bypass Permissions mode',
  ' In Bypass Permissions mode, CodeAgent will not ask for your approval.',
  ' ❯ 1. No, exit',
  '   2. Yes, I accept',
  ' Enter to confirm · Esc to cancel',
];
const IDLE = [' fake CodeAgent ready', '', '❯ ', '', ' ? for shortcuts'];

test('识别工具授权菜单：题目、选项、语气、短文案', () => {
  const menu = m.describeMenu(PERMISSION);
  assert.equal(menu.kind, 'permission');
  assert.equal(menu.question, '允许执行 dir？');
  assert.equal(menu.original, 'Do you want to proceed?');
  assert.deepEqual(menu.options.map(o => o.key), ['1', '2', '3']);
  assert.deepEqual(menu.options.map(o => o.tone), ['allow', 'always', 'deny']);
  assert.deepEqual(menu.options.map(o => o.short), ['允许', '允许且不再询问', '拒绝']);
  assert.equal(menu.options[0].selected, true);
  assert.ok(menu.signature);
  assert.equal(menu.auto, undefined);
});

test('带边框的菜单、光标不在第一项也能认', () => {
  const menu = m.describeMenu(BOXED_PERMISSION);
  assert.equal(menu.kind, 'permission');
  assert.equal(menu.question, '允许修改 a.txt？');
  assert.equal(menu.options[1].selected, true);
  assert.equal(menu.options[1].tone, 'always');
  assert.equal(menu.options[2].short, '拒绝');
});

test('提问类菜单归为 question，选项原样保留', () => {
  const menu = m.describeMenu(QUESTION);
  assert.equal(menu.kind, 'question');
  assert.equal(menu.question, 'Which color should the button use?');
  assert.deepEqual(menu.options.map(o => o.short), ['Blue', 'Green', 'Type something.']);
});

test('信任目录、Bypass 警告：标成自动处理中，卡片先不打扰', () => {
  assert.equal(m.describeMenu(TRUST).auto, 'pending');
  assert.equal(m.describeMenu(BYPASS).auto, 'pending');
});

test('普通输入框画面认不出菜单', () => {
  assert.equal(m.describeMenu(IDLE), null);
  assert.equal(m.describeMenu([]), null);
});

test('按键映射：从高亮项上下移动到目标再回车', () => {
  const menu = m.describeMenu(PERMISSION);
  assert.deepEqual(m.keysFor(menu, '1'), ['\r']);
  assert.deepEqual(m.keysFor(menu, '2'), ['\x1b[B', '\r']);
  assert.deepEqual(m.keysFor(menu, '3'), ['\x1b[B', '\x1b[B', '\r']);
  const boxed = m.describeMenu(BOXED_PERMISSION);
  assert.deepEqual(m.keysFor(boxed, '1'), ['\x1b[A', '\r']);
  assert.equal(m.keysFor(menu, '9'), null);
  assert.equal(m.keysFor({ options: [{ key: '1', selected: false }] }, '1'), null);
});

test('自动作答只在会话权限为全部放开、普通授权、有纯 Yes 时', () => {
  const menu = m.describeMenu(PERMISSION);
  assert.equal(m.autoAnswerKey(menu, { permissionMode: 'bypassPermissions' }), '1');
  assert.equal(m.autoAnswerKey(menu, { permissionMode: 'default' }), null);
  assert.equal(m.autoAnswerKey(menu, {}), null);
  assert.equal(m.autoAnswerKey(m.describeMenu(QUESTION), { permissionMode: 'bypassPermissions' }), null);
  assert.equal(m.autoAnswerKey(m.describeMenu(TRUST), { permissionMode: 'bypassPermissions' }), null);
  // 孤零零的 Yes/No、题目也不像授权：可能是普通提问，不代答
  const bare = { kind: 'permission', original: 'Continue with the plan?', options: [{ key: '1', label: 'Yes', selected: true }, { key: '2', label: 'No' }] };
  assert.equal(m.autoAnswerKey(bare, { permissionMode: 'bypassPermissions' }), null);
  assert.equal(m.autoAnswerKey({ ...bare, original: 'Do you want to proceed?' }, { permissionMode: 'bypassPermissions' }), '1');
  // 没有纯 Yes（只有「本次会话都允许」一类）时不替用户选
  const noPlain = m.describeMenu(['Do you want to proceed?', '❯ 1. Yes, allow all edits during this session', '  2. No', 'Esc to cancel']);
  assert.equal(m.autoAnswerKey(noPlain, { permissionMode: 'bypassPermissions' }), null);
});

// 假会话：屏幕按队列依次给出，记录写进终端的每个键。
function fakeManager(screens, info = {}) {
  const writes = [];
  let index = 0;
  const manager = {
    sessions: new Map([['s1', { pty: {}, info }]]),
    writeToSession: (sid, data) => { writes.push([sid, data]); if (index < screens.length - 1) index += 1; },
  };
  const openScreen = async () => ({ lines: async () => screens[Math.min(index, screens.length - 1)], dispose() {} });
  const api = m.createPtyChoiceMenu(manager, { openScreen, rules: () => undefined, sleep: async () => {}, log: () => {} });
  return { api, writes, manager, openScreen };
}

const moveCursor = (screen, to) => screen.map(l => l.replace(/^(\s*)[❯ ] (\d)\./, (all, pad, n) => `${pad}${n === String(to) ? '❯' : ' '} ${n}.`));
const PERMISSION_AT_2 = moveCursor(PERMISSION, 2);

test('answer：画面与卡片所见一致才按键；回车前复核光标到位，按完确认菜单收起', async () => {
  assert.match(PERMISSION_AT_2.join('\n'), /❯ 2\. Yes, and/);
  const sig = m.describeMenu(PERMISSION).signature;
  const { api, writes } = fakeManager([PERMISSION, PERMISSION_AT_2, IDLE]);
  const result = await api.answer('s1', { signature: sig, key: '2' });
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  assert.deepEqual(writes.map(w => w[1]), ['\x1b[B', '\r']);
});

test('answer：方向键后光标没到位或换了题，不按回车', async () => {
  const sig = m.describeMenu(PERMISSION).signature;
  let t = 0;
  const stuck = fakeManager([PERMISSION, PERMISSION]);
  const r1 = await m.createPtyChoiceMenu(stuck.manager, { openScreen: stuck.openScreen, rules: () => undefined, sleep: async () => {}, now: () => (t += 100), log: () => {} })
    .answer('s1', { signature: sig, key: '3' });
  assert.equal(r1.reason, 'cursor-mismatch');
  assert.ok(!stuck.writes.some(w => w[1] === '\r'), '没有回车');
  const other = PERMISSION.map(l => l.replace('Bash(dir)', 'Bash(del a.txt)'));
  const changed = fakeManager([PERMISSION, moveCursor(other, 2)]);
  const r2 = await m.createPtyChoiceMenu(changed.manager, { openScreen: changed.openScreen, rules: () => undefined, sleep: async () => {}, now: () => (t += 100), log: () => {} })
    .answer('s1', { signature: sig, key: '2' });
  assert.equal(r2.reason, 'menu-changed');
  assert.deepEqual(changed.writes.map(w => w[1]), ['\x1b[B']);
});

test('answer：方向键后读到画了一半的帧（光标暂时不见）先接着等，画完、光标到位才按回车', async () => {
  const sig = m.describeMenu(PERMISSION).signature;
  const half = PERMISSION.map(l => l.replace(/❯/, ' ')); // 旧光标擦掉了，新光标还没画上
  const writes = [];
  const reads = [PERMISSION, half, half, moveCursor(PERMISSION, 3), IDLE];
  let n = 0, t = 0;
  const manager = { sessions: new Map([['s1', { pty: {}, info: {} }]]), writeToSession: (sid, d) => writes.push(d) };
  const openScreen = async () => ({ lines: async () => reads[Math.min(n++, reads.length - 1)], dispose() {} });
  const api = m.createPtyChoiceMenu(manager, { openScreen, rules: () => undefined, sleep: async () => {}, now: () => (t += 100), log: () => {} });
  const r = await api.answer('s1', { signature: sig, key: '3' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(writes, ['\x1b[B', '\x1b[B', '\r']);
});

test('签名带上工具参数行：选项一样、命令不同的两道题不算同一道', () => {
  const other = PERMISSION.map(l => l.replace('Bash(dir)', 'Bash(del a.txt)'));
  assert.notEqual(m.describeMenu(other).signature, m.describeMenu(PERMISSION).signature);
  assert.equal(m.describeMenu(other).question, '允许执行 del a.txt？');
  // 命令正文里的 sleep(1) 不抢带圆点的工具行
  const body = [' ● Bash(python run.py)', ' Bash command', '   sleep(1)', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'];
  assert.equal(m.describeMenu(body).question, '允许执行 python run.py？');
});

test('菜单下面已是有内容的输入框或草稿：旧画面，不当菜单', () => {
  assert.equal(m.describeMenu([...PERMISSION, '╭────╮', '│ > Anything I can assist you with? │', '╰────╯']), null);
  assert.equal(m.describeMenu([...PERMISSION, '❯ 我的草稿']), null);
  assert.ok(m.describeMenu(PERMISSION), '菜单下面只有按键提示时照常识别');
});

test('answer：题目已经变了就一个键都不按', async () => {
  const stale = m.describeMenu(QUESTION).signature;
  const { api, writes } = fakeManager([PERMISSION]);
  const result = await api.answer('s1', { signature: stale, key: '1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'menu-changed');
  assert.equal(writes.length, 0);
  const gone = fakeManager([IDLE]);
  assert.equal((await gone.api.answer('s1', { signature: stale, key: '1' })).reason, 'menu-gone');
  assert.equal(gone.writes.length, 0);
});

test('read：全部放开的会话遇到普通授权直接允许，不交给卡片', async () => {
  const { api, writes } = fakeManager([PERMISSION, IDLE], { permissionMode: 'bypassPermissions' });
  const result = await api.read('s1');
  assert.equal(result.menu, null);
  assert.equal(result.autoAnswered.label, 'Yes');
  assert.deepEqual(writes.map(w => w[1]), ['\r']);
});

test('read：普通权限档把菜单交给卡片，不按键', async () => {
  const { api, writes } = fakeManager([PERMISSION], { permissionMode: 'default' });
  const result = await api.read('s1');
  assert.equal(result.menu.kind, 'permission');
  assert.equal(writes.length, 0);
});

test('卡片提示条：不再是盖住对话的深色浮层，点选项走 pty-choice:answer', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pty-attention-controls.js'), 'utf8');
  assert.doesNotMatch(src, /codex-native-controls/, '不复用绝对定位的深色浮层样式');
  assert.match(src, /pty-choice:read/);
  assert.match(src, /pty-choice:answer/);
  const rule = css.match(/\.pty-choice-inline \{[^}]*\}/)[0];
  assert.match(rule, /font-size: 12px/);
  assert.doesNotMatch(rule, /position:\s*absolute|box-shadow/);
});

test('CodeAgent-Lite 的工具授权：一行小字 + 小按钮，点「允许」回复 once', async () => {
  const { createCodexNativeControls } = require('../renderer/codex-native-controls');
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.classes = new Set(); }
    set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(' '); }
    get classList() { return { toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)), contains: c => this.classes.has(c) }; }
    setAttribute() {}
    append(...children) { for (const c of children) { c.parent = this; this.children.push(c); } }
    insertBefore(child, next) { child.parent = this; const i = this.children.indexOf(next); this.children.splice(i < 0 ? this.children.length : i, 0, child); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    querySelectorAll() { return this.children.filter(c => c.tag === 'button'); }
    get childElementCount() { return this.children.length; }
    get lastElementChild() { return this.children.at(-1); }
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  }
  const calls = [];
  const controls = createCodexNativeControls({ sessionId: 's1', document: { createElement: tag => new Element(tag) },
    invoke: async (channel, payload) => { calls.push([channel, payload]); return { ok: true }; } });
  const { PERMISSION_OPTIONS } = require('../core/codeagent-serve-client');
  const request = { id: 'permission:p1', method: 'session/request_permission',
    params: { toolCall: { title: 'bash · dir', rawInput: { command: 'dir' } }, options: PERMISSION_OPTIONS } };
  controls.update({ runtimeBackend: 'acp', codeagentRunMode: 'serve', nativeRuntime: { connection: 'connected', state: 'running', epoch: 3, requests: [request] } });
  const form = controls.element.children[0];
  assert.ok(form.classes.has('native-quiet-request'));
  assert.ok(controls.element.classes.has('native-controls-quiet'), '只有授权时整块收成一行');
  assert.equal(form.children[0].textContent, '允许 bash：dir？');
  const buttons = form.children.filter(c => c.tag === 'button');
  assert.deepEqual(buttons.map(b => b.textContent), ['允许', '本会话都允许', '拒绝']);
  await buttons[0].handlers.click();
  assert.deepEqual(calls[0], ['codex:native-action', { sessionId: 's1', action: 'reply', requestId: 'permission:p1', epoch: 3, result: { outcome: { outcome: 'selected', optionId: 'once' } } }]);
  // 普通 ACP / Codex 会话的授权维持原来的完整表单
  const other = createCodexNativeControls({ sessionId: 's2', document: { createElement: tag => new Element(tag) }, invoke: async () => ({ ok: true }) });
  other.update({ runtimeBackend: 'acp', nativeRuntime: { connection: 'connected', state: 'running', epoch: 1, requests: [request] } });
  assert.ok(!other.element.children[0].classes.has('native-quiet-request'));
  assert.ok(!other.element.classes.has('native-controls-quiet'));
});


// ---- 卡片提示条（renderer/pty-attention-controls.js）：用最小的假 DOM 驱动 ----
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
const MENU = { kind: 'permission', question: '允许执行 dir？', signature: 'sig-1', options: [{ key: '1', label: 'Yes', short: '允许', tone: 'allow', selected: true }, { key: '3', label: 'No', short: '拒绝', tone: 'deny' }] };

test('提示条：不在卡片视图时连第一次都不读屏；离开文档后作废、不再轮询', async () => {
  global.document = fakeDom();
  delete require.cache[require.resolve('../renderer/pty-attention-controls')];
  const ui = require('../renderer/pty-attention-controls');
  const calls = [];
  const c = ui.createPtyAttentionControls({ invoke: async (ch, p) => { calls.push(ch); return { ok: true, menu: MENU }; } });
  c.element.connected = true;
  c.update({ id: 's1', agentRuntime: 'pty' }, { state: 'waiting', detail: 'x' });
  await sleepMs(250);
  assert.equal(calls.length, 0, '终端视图下不读屏');
  c.element.card = true;
  c.update({ id: 's1', agentRuntime: 'pty' }, { state: 'waiting', detail: 'y' });
  await sleepMs(250);
  assert.equal(calls.length, 1, '卡片视图读屏');
  assert.equal(c.element.hidden, false);
  // 输入条重建、旧元素离开文档：下一次轮询时作废
  c.element.connected = false;
  await sleepMs(1400);
  const n = calls.length;
  await sleepMs(1400);
  assert.equal(calls.length, n, '作废后不再读屏');
  ui.notePtyOutput('s1');
  assert.equal(calls.length, n);
  delete global.document;
});

test('提示条：「已发送未确认」和出错原因至少留 3 秒', async () => {
  global.document = fakeDom();
  delete require.cache[require.resolve('../renderer/pty-attention-controls')];
  const ui = require('../renderer/pty-attention-controls');
  let answer = { ok: true, confirmed: false };
  let reads = 0;
  const c = ui.createPtyAttentionControls({ invoke: async ch => (ch === 'pty-choice:read' ? (reads++ ? { ok: true, menu: null } : { ok: true, menu: MENU }) : answer) });
  c.element.connected = true; c.element.card = true;
  c.update({ id: 's1', agentRuntime: 'pty' }, { state: 'waiting', detail: 'x' });
  await sleepMs(250);
  const opts = c.element.children[1];
  await opts.children[0].handlers.click();
  const note = c.element.children[2];
  assert.equal(note.textContent, '已发送，终端尚未确认');
  assert.equal(c.element.hidden, false, '菜单收起后提示仍可见');
  await sleepMs(900); // 之后的读屏（菜单已不在）不抹掉提示
  assert.equal(note.textContent, '已发送，终端尚未确认');
  assert.equal(c.element.hidden, false);
  c.dispose();
  delete global.document;
});

// ---- 2026-11-27：CodeAgent（opentui）的方向键菜单：底栏「Navigate ↑ ↓ | Select enter | Back esc」，选项可能没有编号 ----
const CA_UNNUMBERED = [
  ' ● Bash(dir)',
  '',
  ' Allow this command?',
  ' ❯ Allow once',
  '   Allow always',
  '      remember for this project',
  '   Reject',
  '',
  ' Navigate ↑ ↓ | Select enter | Back esc',
];
const CA_NUMBERED_NO_QUESTION = [
  '  Pick a plan',
  '',
  '  ❯  1. Fast',
  '     2. Careful',
  '',
  '  Navigate ↑ ↓ | Select enter | Back esc',
];
const CA_IDLE = [
  ' │ > Anything I can assist you with? (Ctrl+J 换行 · esc×2 清空 · ↑↓ 历史) │',
  ' Bypass (Cycle shift+tab) | GLM-5.2',
];

test('CodeAgent 无编号方向键菜单：按光标行和对齐认选项，说明行不算选项，点选仍是方向键 + 回车', () => {
  const menu = m.describeMenu(CA_UNNUMBERED);
  assert.ok(menu, '认得出');
  assert.equal(menu.kind, 'permission');
  assert.equal(menu.question, '允许执行 dir？');
  assert.deepEqual(menu.options.map(o => o.label), ['Allow once', 'Allow always', 'Reject']);
  assert.deepEqual(menu.options.map(o => o.tone), ['allow', 'always', 'deny']);
  assert.deepEqual(m.keysFor(menu, '3'), ['\x1b[B', '\x1b[B', '\r']);
  // 光标在中间
  const moved = CA_UNNUMBERED.map(l => l === ' ❯ Allow once' ? '   Allow once' : l === '   Allow always' ? ' ❯ Allow always' : l);
  const mm = m.describeMenu(moved);
  assert.equal(mm.options[1].selected, true);
  assert.deepEqual(m.keysFor(mm, '1'), ['\x1b[A', '\r']);
  assert.equal(mm.signature, menu.signature, '光标移动不算换题');
});

test('CodeAgent 编号菜单只有 Navigate 底栏、题目不带问号也能认', () => {
  const menu = m.describeMenu(CA_NUMBERED_NO_QUESTION);
  assert.ok(menu);
  assert.equal(menu.kind, 'question');
  assert.deepEqual(menu.options.map(o => o.label), ['Fast', 'Careful']);
});

test('CodeAgent 无编号菜单：没有底栏、两个光标、空闲输入框都不当菜单', () => {
  assert.equal(m.describeMenu(CA_UNNUMBERED.slice(0, -2)), null, '没有按键提示底栏');
  assert.equal(m.describeMenu(CA_UNNUMBERED.map(l => l === '   Reject' ? ' ❯ Reject' : l)), null, '两个光标');
  assert.equal(m.describeMenu(CA_IDLE), null, '空闲输入框的「↑↓ 历史」不是菜单底栏');
  assert.equal(m.describeMenu([' ❯ only one', '', ' Navigate ↑ ↓ | Select enter']), null, '只有一项');
});

test('CodeAgent 运行状态：方向键选择框报「等你操作」，空闲输入框不报', () => {
  const rt = require('../core/terminal-runtime-state');
  const w = rt.classifyTerminalRuntime('codeagent', CA_UNNUMBERED);
  assert.equal(w.state, rt.RUNTIME_WAITING);
  assert.equal(w.reason, 'codeagent-choice-menu');
  assert.notEqual(rt.classifyTerminalRuntime('codeagent', CA_IDLE).state, rt.RUNTIME_WAITING);
});

test('卡片输入框按键直通：只在提示条显示、输入框为空、无修饰键时把 ↑↓←→/回车交给终端', async () => {
  const { menuKeyBytes } = (() => { global.document = fakeDom(); delete require.cache[require.resolve('../renderer/pty-attention-controls')]; return require('../renderer/pty-attention-controls'); })();
  const on = { active: true, inputEmpty: true };
  assert.equal(menuKeyBytes({ key: 'ArrowUp' }, on), '\x1b[A');
  assert.equal(menuKeyBytes({ key: 'ArrowDown' }, on), '\x1b[B');
  assert.equal(menuKeyBytes({ key: 'Enter' }, on), '\r');
  assert.equal(menuKeyBytes({ key: 'a' }, on), null);
  assert.equal(menuKeyBytes({ key: 'Enter', shiftKey: true }, on), null);
  assert.equal(menuKeyBytes({ key: 'Enter' }, { active: true, inputEmpty: false }), null, '有草稿：回车仍是发送');
  assert.equal(menuKeyBytes({ key: 'ArrowUp' }, { active: false, inputEmpty: true }), null, '没有提示条：↑ 仍是翻历史');

  const ui = require('../renderer/pty-attention-controls');
  const writes = [];
  const c = ui.createPtyAttentionControls({ invoke: async () => ({ ok: true, menu: MENU }), writeTerminal: (sid, d) => writes.push([sid, d]) });
  c.element.connected = true; c.element.card = true;
  const ev = key => ({ key, prevented: false, preventDefault() { this.prevented = true; } });
  const e0 = ev('ArrowDown');
  assert.equal(c.forwardKey(e0, true), false, '提示条没出现前不拦');
  c.update({ id: 's1', agentRuntime: 'pty' }, { state: 'waiting', detail: 'x' });
  await sleepMs(250);
  assert.equal(c.element.dataset.mode, 'menu');
  const e1 = ev('ArrowDown');
  assert.equal(c.forwardKey(e1, true), true);
  assert.ok(e1.prevented);
  assert.equal(c.forwardKey(ev('Enter'), false), false, '输入框有字不拦');
  assert.equal(c.forwardKey(ev('Enter'), true), true);
  assert.deepEqual(writes, [['s1', '\x1b[B'], ['s1', '\r']]);
  // 用户点了 × 收起：不再拦
  c.element.children[4].handlers.click();
  assert.equal(c.forwardKey(ev('ArrowUp'), true), false);
  c.dispose();
  delete global.document;
});

test('卡片提示条：终端光标停着的那一项按钮带 data-selected', async () => {
  global.document = fakeDom();
  delete require.cache[require.resolve('../renderer/pty-attention-controls')];
  const ui = require('../renderer/pty-attention-controls');
  const c = ui.createPtyAttentionControls({ invoke: async () => ({ ok: true, menu: MENU }) });
  c.element.connected = true; c.element.card = true;
  c.update({ id: 's1', agentRuntime: 'pty' }, { state: 'waiting', detail: 'x' });
  await sleepMs(250);
  const buttons = c.element.children[1].children;
  assert.equal(buttons[0].dataset.selected, '1');
  assert.equal(buttons[1].dataset.selected, undefined);
  c.dispose();
  delete global.document;
});
