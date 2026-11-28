'use strict';
// 2026-11-28 黄区真机（CodeAgent 1.2615.02.05，PTY 窗口较矮、模型菜单出滚动条）：分组标题行末尾带着滚动条块字符
// 「Built-in            █」，解析器把它当成说明行，内置组两行都没有分组；新会话按推荐「换成 GLM-5.2-WX-Auto 并创建」后，
// 启动时选模型在回车前的分组核对失败（「未确认光标已移到 GLM-5.2-WX-Auto 的目标分组」），首句被「原模型不可用」挡回。
// 菜单行原样取自隔离 Hub 的 codeagent-usage-menu.log（只补了菜单标题与底栏两行）。
// A scrollbar glyph at the end of a group heading line must not hide the heading.
const test = require('node:test');
const assert = require('node:assert/strict');
const picker = require('../core/codeagent-model-picker');

const MENU = [
  '   Select model',
  '   Credit用量                                                                                         shift + ↓ to detail',
  '   月度: 13722.03/400000,已用3. 每天(忙时): 1027.98/20000,已用5.每天(平时,闲时): 536.22/20000,已用2. 闲时2折将在12:00    ',
  '   43%                          13%                             68%                                 后开启               ',
  '                                                                                                                         ',
  '         模型名称                          Credit消耗系数  Token用量/配额        ● 负载      模型描述                    ',
  '   Built-in                                                                                                             █',
  '   ❯  1. GLM-5.2-WX-Auto                   0-1x            暂无数据              ● 低负载    【内部模型】GLM-5.2为主    █',
  '      2. GLM-5.3-CodeAgent-Auto            0-1x            暂无数据              ● 低负载    【内部模型】GLM-5.3 作      ',
  '   Navigate ↑↓  Select enter  Back esc',
];

test('group heading followed by a scrollbar glyph still names the group', () => {
  const parsed = picker.parsePicker(MENU, { allowNoCursor: true });
  assert.deepEqual(parsed.rows.map(row => [row.label, row.group]),
    [['GLM-5.2-WX-Auto', 'Built-in'], ['GLM-5.3-CodeAgent-Auto', 'Built-in']]);
  assert.equal(parsed.cursor, 0);
  // 仍按「一屏没放下」处理，不写进菜单缓存。
  assert.equal(parsed.incompleteReason, 'scroll-truncated');
});

test('other scrollbar shapes on the heading line are stripped too', () => {
  for (const glyph of ['▐', '▌', '▓', '▄']) {
    const menu = MENU.map(line => line.replace(/█$/, glyph));
    assert.equal(picker.parsePicker(menu, { allowNoCursor: true }).rows[0].group, 'Built-in', glyph);
  }
});

test('a description line with wide gaps is still not taken for a heading', () => {
  const menu = MENU.slice();
  menu.splice(6, 1, '   说明文字      第二列                                                                              █');
  assert.equal(picker.parsePicker(menu, { allowNoCursor: true }).rows[0].group, undefined);
});

// 回车前核对时菜单整个不见了（CLI 重画关掉了菜单）：不按回车，重开一次 /model 再选，第二次选上。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function pickerVm(screen) {
  const file = path.join(__dirname, '..', 'core', 'codeagent-model-picker.js'), localRequire = createRequire(file);
  const state = { clock: 1000 };
  const FakeDate = class extends Date { static now() { return state.clock; } };
  const context = vm.createContext({ module: { exports: {} }, process, Buffer, Date: FakeDate, screen,
    setTimeout: (fn, ms) => { state.clock += ms || 0; fn(); return 0; }, clearTimeout: () => {}, require: localRequire });
  new vm.Script(fs.readFileSync(file, 'utf8') + '\nopenSessionScreen = async () => screen;', { filename: file }).runInContext(context);
  return context.module.exports;
}
const IDLE = ['', ' │ > Anything I can assist you with?                                    │', ''];

test('menu closed by a redraw right before Enter: reopen once and pick, never press Enter on a closed menu', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-vanish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 第一次打开：前两次读屏是菜单，之后菜单被重画关掉；重开后菜单一直在，回车后关闭。
  let opens = 1, reads = 0, closed = false;
  const writes = [], sent = [];
  const screen = { lines: async () => {
    reads += 1;
    if (closed) return IDLE;
    if (opens === 1 && reads > 3) return IDLE; // 第 1 次读屏记状态行，2–3 次读到菜单，之后菜单被关
    return MENU;
  }, dispose() {} };
  const api = pickerVm(screen);
  const result = await api.pickModel({ manager: { getSession: () => ({ pid: 1 }), writeToSession: (_sid, key) => { writes.push(key); if (key === '\r' || key === '\x1b') closed = true; } },
    sendToPty: async (_sid, text) => { sent.push(text); opens += 1; closed = false; reads = 0; return { ok: true, sendStatus: 'ok' }; },
    sid: 'vanish', kind: 'codeagent', modelId: 'GLM-5.2-WX-Auto', provider: 'w3', providerLabel: 'Built-in', dataDir: dir });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(sent, ['/model'], 'reopened the menu exactly once');
  assert.equal(writes.filter(key => key === '\r').length, 1, 'Enter pressed only on the reopened menu');
  assert.match(fs.readFileSync(path.join(dir, 'logs', 'codeagent-model.log'), 'utf8'), /pick-retry/);
});

// ---- 二审（2026-11-28）：菜单消失不等于没人选；有人接手、会话换了，都不再写任何键 ----
const statusLine = model => ` │ Bypass (Cycle shift+tab) | ${model}                                  @  ✲  ↵  ▷   │`;
const idleWith = model => [...IDLE, statusLine(model)];
// 场景脚本：开始时是普通输入框（状态行 DeepSeek），Hub 发 /model 后出菜单，读到 2 次菜单后菜单被关；onVanish 决定之后的画面。
function scripted({ onVanish }) {
  const st = { phase: 'idle', reads: 0, model: 'DeepSeek-V4.1-Flash-1017', pid: 1 };
  const writes = [], sent = [];
  const screen = { lines: async () => {
    if (st.phase === 'menu') { st.reads += 1; if (!st.vanished && st.reads > 2) { st.vanished = true; st.phase = 'after'; onVanish(st); } else return MENU; }
    return idleWith(st.model);
  }, dispose() {} };
  const manager = { getSession: () => ({ pid: st.pid }), writeToSession: (_sid, key) => { writes.push(key); if (key === String.fromCharCode(13) || key === String.fromCharCode(27)) st.phase = 'after'; } };
  const sendToPty = async (_sid, text, _kind, opts) => { sent.push([text, !!opts?.preserveInput]); st.phase = 'menu'; st.reads = 0; return { ok: true, sendStatus: 'ok' }; };
  return { st, writes, sent, screen, manager, sendToPty };
}
async function runScripted(t, sc, api) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-hands-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await api.pickModel({ manager: sc.manager, sendToPty: sc.sendToPty, sid: 's1', kind: 'codeagent', modelId: 'GLM-5.2-WX-Auto', dataDir: dir });
  return { result, log: fs.readFileSync(path.join(dir, 'logs', 'codeagent-model.log'), 'utf8') };
}

test('user picked another model in the terminal and closed the menu: keep it, no retry, no keys', async t => {
  let api;
  const sc = scripted({ onVanish: st => { api.noteUserInput('s1', '\r'); st.model = 'MiniMax-M2.7'; } });
  api = pickerVm(sc.screen);
  const { result, log } = await runScripted(t, sc, api);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.userPicked, 'MiniMax-M2.7');
  assert.deepEqual(sc.sent.map(x => x[0]), ['/model'], 'menu not reopened');
  assert.deepEqual(sc.writes, [], 'no Esc, Enter, arrows or backspace written');
  assert.match(log, /pick-retry-skipped.*why=user-picked/);
});

test('user typing while Hub waits to retry: no reopen, no keys, plain failure', async t => {
  let api;
  const sc = scripted({ onVanish: () => { api.noteUserInput('s1', 'h'); } });
  api = pickerVm(sc.screen);
  const { result, log } = await runScripted(t, sc, api);
  assert.equal(result.ok, false);
  assert.equal(sc.sent.length, 1);
  assert.deepEqual(sc.writes, []);
  assert.match(log, /why=user-active/);
});

test('session relaunched or closed during the wait: no reopen, no keys', async t => {
  const sc = scripted({ onVanish: st => { st.pid = 2; } });
  const api = pickerVm(sc.screen);
  const { result, log } = await runScripted(t, sc, api);
  assert.equal(result.ok, false);
  assert.equal(sc.sent.length, 1);
  assert.deepEqual(sc.writes, []);
  assert.match(log, /why=session-changed/);
});

test('terminal protocol replies (focus, cursor report) are not user input; the retry reopens with preserveInput', async t => {
  let api;
  const sc = scripted({ onVanish: () => { api.noteUserInput('s1', '\x1b[O'); api.noteUserInput('s1', '\x1b[12;40R'); api.noteUserInput('s1', '\x1b[<35;10;5M'); api.noteUserInput('s1', '\x1b[?1;2c'); api.noteUserInput('s1', '\x1b[?2026;0$y'); api.noteUserInput('s1', '\x1b]11;rgb:0000/0000/0000\x1b\\'); } });
  api = pickerVm(sc.screen);
  const { log } = await runScripted(t, sc, api);
  assert.deepEqual(sc.sent, [['/model', false], ['/model', true]], 'second /model keeps the draft');
  assert.match(log, /event=pick-retry /);
});

test('statusModel reads the model from the line under the input box', () => {
  assert.equal(picker.statusModel(idleWith('w3/Glm-5.3')), 'w3/Glm-5.3');
  assert.equal(picker.statusModel(IDLE), '');
});

// 三审：真实原地重拉不换会话对象，只把 modelSubmissionEpoch 加一、往同一个 pty 写命令。走真实 Map 分支核对 epoch。
function mapManager(sc) {
  const entry = { info: { id: 's1', status: 'running' }, modelSubmissionEpoch: 1, pty: { closed: false } };
  const sessions = new Map([['s1', entry]]);
  return { entry, manager: { sessions, getSession: id => (sessions.has(id) ? { ...sessions.get(id).info } : null),
    writeToSession: (_sid, key) => { sc.writes.push(key); if (key === String.fromCharCode(13) || key === String.fromCharCode(27)) sc.st.phase = 'after'; } } };
}

test('in-place relaunch (same entry, epoch 1 → 2) during the wait: no reopen and no keys', async t => {
  let entry;
  const sc = scripted({ onVanish: () => { entry.modelSubmissionEpoch = 2; } });
  const mm = mapManager(sc); entry = mm.entry; sc.manager = mm.manager;
  const api = pickerVm(sc.screen);
  const { result, log } = await runScripted(t, sc, api);
  assert.equal(result.ok, false);
  assert.deepEqual(sc.sent.map(x => x[0]), ['/model'], 'no second /model into the relaunched epoch');
  assert.deepEqual(sc.writes, []);
  assert.match(log, /why=session-changed/);
});

test('relaunch after the menu was reopened but before Enter: Enter is not written into the new epoch', async t => {
  let entry;
  const sc = scripted({ onVanish: () => {} });
  const mm = mapManager(sc); entry = mm.entry; sc.manager = mm.manager;
  const send = sc.sendToPty;
  sc.sendToPty = async (...args) => { const r = await send(...args); if (sc.sent.length === 2) entry.modelSubmissionEpoch = 2; return r; };
  const api = pickerVm(sc.screen);
  const { result } = await runScripted(t, sc, api);
  assert.equal(result.ok, false);
  assert.equal(sc.sent.length, 2);
  assert.ok(!sc.writes.includes(String.fromCharCode(13)), 'no Enter in the relaunched epoch');
});

test('same entry and epoch with the real Map branch still retries and picks', async t => {
  const sc = scripted({ onVanish: () => {} });
  sc.manager = mapManager(sc).manager;
  const api = pickerVm(sc.screen);
  const { result } = await runScripted(t, sc, api);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(sc.sent, [['/model', false], ['/model', true]]);
});

// 三审 ②：第一次 /model 就没确认（超时失败）、期间用户在终端打字：收尾不能再写 Esc 和退格删他的草稿。
test('first /model not confirmed while the user is typing: cleanup writes no Esc and no backspace', async t => {
  let api;
  const st = { model: 'DeepSeek-V4.1-Flash-1017' };
  const writes = [];
  const screen = { lines: async () => [...IDLE.slice(0, 1), ' │ > 我正在写的草稿                                          │', statusLine(st.model)], dispose() {} };
  api = pickerVm(screen);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-typing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await api.pickModel({ manager: { getSession: () => ({ pid: 1 }), writeToSession: (_sid, key) => writes.push(key) },
    sendToPty: async () => { api.noteUserInput('s1', '我'); return { ok: false, sendStatus: 'stuck', message: '模型命令尚未确认' }; },
    sid: 's1', kind: 'codeagent', modelId: 'GLM-5.2-WX-Auto', dataDir: dir });
  assert.equal(result.ok, false);
  assert.deepEqual(writes, [], 'no Esc, no backspace, no Enter after the user took over');
});

test('Shift+F3 (ESC[1;2R) counts as a key, a real cursor report does not', async t => {
  let api;
  const sc = scripted({ onVanish: () => { api.noteUserInput('s1', '\x1b[1;2R'); } });
  api = pickerVm(sc.screen);
  const { log } = await runScripted(t, sc, api);
  assert.match(log, /why=user-active/);
  assert.deepEqual(sc.writes, []);
});
