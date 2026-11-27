'use strict';
// 公司 CodeAgent 1.2615.02.05 的模型菜单每个分组各自从 1 编号（2026-11-25 同事一键反馈附带的 codeagent-model-picker-last.txt 实录，
// 会话正文、会话号和模型说明已换成占位，菜单行与列宽原样保留）。以前解析器只认跨分组连续编号，
// 整张菜单只留下一组：Built-in 的 DeepSeek-V4.1-Flash-1017 或 Custom 的 cannbotprovider/GLM-5.3 永远「菜单里没有」（R53）。
// Real CodeAgent 1.2615.02.05 menu: each group restarts numbering at 1; both groups must be read as one menu.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const picker = require('../core/codeagent-model-picker');

const REAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'codeagent-model-picker-grouped-real.txt'), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/);
const IDLE = ['', ' │ > Anything I can assist you with?                                    │', ''];

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r53-grouped-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 真实画面里把光标挪到第 index 个模型行（行首「   ❯  」与「      」等宽）。
function realMenu(index) {
  const header = REAL.findIndex(line => /模型名称/.test(line));
  const rowLines = REAL.map((line, at) => at > header && /^\s+(?:❯\s+)?\d+\.\s/.test(line) ? at : -1).filter(at => at >= 0);
  return REAL.map((line, at) => {
    const plain = line.replace(/^ {3}❯ {2}/, '      ');
    return at === rowLines[index] ? plain.replace(/^ {6}/, '   ❯  ') : plain;
  });
}

function pickerVm(screen) {
  const file = path.join(__dirname, '..', 'core', 'codeagent-model-picker.js'), localRequire = createRequire(file);
  // 假时钟：sleep 立刻返回并把时钟往前拨，等待上限按假时钟算，单测不真等。
  const state = { clock: 1000 };
  const FakeDate = class extends Date { static now() { return state.clock; } };
  const context = vm.createContext({ module: { exports: {} }, process, Buffer, Date: FakeDate, screen,
    setTimeout: (fn, ms) => { state.clock += ms || 0; fn(); return 0; }, clearTimeout: () => {}, require: localRequire });
  new vm.Script(fs.readFileSync(file, 'utf8') + '\nopenSessionScreen = async () => screen;', { filename: file }).runInContext(context);
  return context.module.exports;
}

async function pick(t, modelId, extra = {}) {
  const dir = temp(t), writes = [];
  let at = 1, closed = false;
  const screen = { lines: async () => closed ? IDLE : realMenu(at), dispose() {} };
  const api = pickerVm(screen);
  const result = await api.pickModel({ manager: { writeToSession: (_sid, key) => {
    writes.push(key);
    if (key === '\x1b[B') at += 1; if (key === '\x1b[A') at -= 1;
    if (key === '\r' || key === '\x1b') closed = true;
  } }, sid: 'synthetic-r53', kind: 'codeagent', modelId, dataDir: dir, ...extra });
  return { result, writes, at };
}

test('real grouped menu: both groups are read as one menu in arrow-key order', () => {
  const parsed = picker.parsePicker(REAL, { allowNoCursor: true });
  assert.equal(parsed.rows.length, 12);
  assert.deepEqual(parsed.rows.slice(0, 4).map(row => row.label),
    ['GLM-5.2-WX-Auto', 'GLM-5.3-CodeAgent-Auto', 'DeepSeek-V4.1-Flash-1017', 'cannbotprovider/GLM-5.3']);
  assert.equal(parsed.cursor, 1);
  assert.deepEqual(parsed.rows.map(row => row.number), Array.from({ length: 12 }, (_v, i) => i + 1));
  assert.equal(parsed.rows[3].groupNumber, 1, 'the menu shows Custom numbered from 1 again');
  assert.equal(parsed.rows[3].group, 'Custom');
  // 一屏没放下（右侧有滚动条）：照常算不完整，不写进菜单缓存。
  assert.equal(parsed.complete, false);
  assert.equal(parsed.incompleteReason, 'scroll-truncated');
  // 不带 allowNoCursor 的读法（判断菜单是否还开着）同样看到整张菜单。
  assert.equal(picker.parsePicker(REAL).rows.length, 12);
});

test('real grouped menu: the Built-in DeepSeek row is picked by the Hub id spelling', async t => {
  const { result, writes, at } = await pick(t, 'deepseek-v4.1-flash-1017');
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(at, 2);
  assert.deepEqual(writes.filter(key => key !== '\x1b'), ['\x1b[B', '\r']);
});

test('real grouped menu: a Custom row is reached across the group boundary', async t => {
  const { result, writes, at } = await pick(t, 'cannbotprovider/GLM-5.3');
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(at, 3);
  assert.deepEqual(writes.filter(key => key !== '\x1b'), ['\x1b[B', '\x1b[B', '\r']);
});

test('numbered answer text that restarts at 1 is not merged outside a CodeAgent menu frame', () => {
  const body = ['An answer', '❯ 1. GLM-5.2', '2. DeepSeek-V4.1', 'Other', '1. GLM-5.3'];
  const parsed = picker.parsePicker(body);
  assert.ok(!parsed || parsed.rows.length === 2);
});

test('pick failures are told apart: absent from the menu, sent but unconfirmed, or the menu was not matched', () => {
  assert.equal(picker.pickFailureKind({ message: '模型菜单里没有 deepseek-v4.1-flash-1017（菜单里有：GLM-5.2-WX-Auto）' }), 'absent');
  assert.equal(picker.pickFailureKind({ message: '模型菜单里没有 X（菜单里有：X…）', menuMiss: true }), 'mismatch', 'same name seen but not matched');
  assert.equal(picker.pickFailureKind({ message: '选中后未确认恢复普通输入框；尚未确认恢复普通输入框' }), 'unconfirmed');
  assert.equal(picker.pickFailureKind({ message: '当前 CodeAgent 模型菜单的布局无法自动识别，未完成模型切换' }), 'mismatch');
  assert.equal(picker.pickFailureKind({ message: '未确认光标已移到 X 的目标分组，没有选择模型' }), 'mismatch');
});

// ---- R53 审查退回：按 Hub 真实传参选（会话下拉 core/codeagent-models.js modelOptions、功能设置 codeagent-assistant-route.js modelOptions
// 都带 { modelId, provider, providerLabel, menuLabel }，id / menuLabel 不带「供应商/」前缀）。
// 会滚动的菜单：真实画面的菜单行按 height 行一屏开窗，光标移出窗口就跟着滚（上面的组滚出屏幕后，下面一组显示的又是从 1 起的组内编号）。
// 搜索框里打字只改搜索框、不过滤（过滤后的样子没有实录，不造）。Esc：搜索框有字先清空，空了才关菜单。
// Scrolling simulation over the real frame: a window of `height` menu lines follows the cursor; typing only fills the search box.
const HEAD = REAL.findIndex(line => /模型名称/.test(line));
const FOOT = REAL.findIndex((line, at) => at > HEAD && /^\s*─{5,}/.test(line));
const MENU = REAL.slice(HEAD + 1, FOOT).map(line => line.replace(/^ {3}❯ {2}/, '      '));
const ROWS = MENU.map((line, at) => /^\s+\d+\.\s/.test(line) ? at : -1).filter(at => at >= 0);
function scrollingMenu({ height = 12, start = 1 } = {}) {
  const st = { cursor: start, offset: 0, search: '', closed: false };
  const follow = () => {
    const at = ROWS[st.cursor];
    if (at < st.offset) st.offset = at;
    if (at > st.offset + height - 1) st.offset = at - height + 1;
  };
  const lines = () => {
    if (st.closed) return IDLE;
    const head = REAL.slice(0, HEAD + 1).map(line => st.search && /⌕/.test(line) ? line.replace('Search…', st.search) : line);
    const view = MENU.map((line, at) => at === ROWS[st.cursor] ? line.replace(/^ {6}/, '   ❯  ') : line).slice(st.offset, st.offset + height);
    return [...head, ...view, ...REAL.slice(FOOT)];
  };
  const write = key => {
    if (key === '\x1b[B') { st.cursor = Math.min(st.cursor + 1, ROWS.length - 1); follow(); }
    else if (key === '\x1b[A') { st.cursor = Math.max(st.cursor - 1, 0); follow(); }
    else if (key === '\r') st.closed = true;
    else if (key === '\x1b') { if (st.search) st.search = ''; else st.closed = true; }
    else if (/^\x7f+$/.test(key)) st.search = st.search.slice(0, -key.length);
    else if (!key.startsWith('\x1b')) st.search += key;
  };
  return { st, lines, write };
}
async function pickScrolling(t, args, menuOptions) {
  const dir = temp(t), writes = [], menu = scrollingMenu(menuOptions);
  const api = pickerVm({ lines: async () => menu.lines(), dispose() {} });
  const result = await api.pickModel({ manager: { writeToSession: (_sid, key) => { writes.push(key); menu.write(key); } },
    sid: 'synthetic-r53', kind: 'codeagent', dataDir: dir, ...args });
  return { result, writes, label: picker.parsePicker(REAL, { allowNoCursor: true }).rows[menu.st.cursor].label };
}
// FULL：整张实录一屏（Custom 组里两行截断的 cannbotprovider/deepseek-v4.1-f… 同屏可见），即反馈里的原样画面。
const FULL = { height: 99 };
const BUILT_IN = { provider: 'w3', providerLabel: 'Built-in' }, CUSTOM = { provider: 'cannbotprovider', providerLabel: 'cannbotprovider' };

test('the unheaded first group of a grouped menu is read as Built-in; single-group menus stay ungrouped', () => {
  const parsed = picker.parsePicker(REAL, { allowNoCursor: true });
  assert.deepEqual(parsed.rows.slice(0, 3).map(row => row.group), ['Built-in', 'Built-in', 'Built-in']);
  assert.equal(parsed.rows[3].group, 'Custom');
  const single = REAL.slice(0, FOOT).filter(line => !/^\s+Custom\s*$/.test(line) && !/cannbotprovider\//.test(line)).concat(REAL.slice(FOOT));
  const old = picker.parsePicker(single, { allowNoCursor: true });
  assert.equal(old.rows.length, 3);
  assert.deepEqual(old.rows.map(row => row.group), [undefined, undefined, undefined]);
});

test('Hub dropdown args: Built-in DeepSeek-V4.1-Flash-1017 with provider w3 is picked, not reported as a menu mismatch', async t => {
  const { result, writes, label } = await pickScrolling(t, { modelId: 'DeepSeek-V4.1-Flash-1017', menuLabel: 'DeepSeek-V4.1-Flash-1017', ...BUILT_IN }, FULL);
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(label, 'DeepSeek-V4.1-Flash-1017');
  assert.deepEqual(writes.filter(key => key !== '\x1b'), ['\x1b[B', '\r']);
});

test('Hub dropdown args: Custom GLM-5.3 (menu shows cannbotprovider/GLM-5.3) is taken from the first screen', async t => {
  const { result, writes, label } = await pickScrolling(t, { modelId: 'GLM-5.3', menuLabel: 'GLM-5.3', ...CUSTOM });
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(label, 'cannbotprovider/GLM-5.3');
  assert.deepEqual(writes.filter(key => key !== '\x1b'), ['\x1b[B', '\x1b[B', '\r'], 'no search typed, no scrolling');
});

test('Hub dropdown args: a Custom row below the first screen is reached by scrolling', async t => {
  const { result, label } = await pickScrolling(t, { modelId: 'Qwen3.8-27B', menuLabel: 'Qwen3.8-27B', ...CUSTOM });
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(label, 'cannbotprovider/Qwen3.8-27B');
});

test('scrolling a grouped menu does not count one row twice when its displayed number changes', async t => {
  // 没带供应商（升级前存下的选择）：只有 Custom 组有 GLM-5.3，翻完整张菜单后退回去选它；
  // 翻到底时 Built-in 滚出屏幕，cannbotprovider/GLM-5.3 的顺序号从 4 变回 1，以前记成两行报「多个线路都有」。
  const { result, label } = await pickScrolling(t, { modelId: 'GLM-5.3' });
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(label, 'cannbotprovider/GLM-5.3');
});

test('a provider spelled unlike the Built-in heading still takes the single same-name row past foreign truncated lookalikes', async t => {
  const { result, label } = await pickScrolling(t, { modelId: 'DeepSeek-V4.1-Flash-1017', menuLabel: 'DeepSeek-V4.1-Flash-1017', provider: 'corp-w3-route', providerLabel: 'W3 线路' }, FULL);
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(label, 'DeepSeek-V4.1-Flash-1017');
});

test('a wrapped description in the right-hand column is not taken as a group heading', () => {
  const lines = REAL.slice();
  const at = lines.findIndex(line => /^\s+1\. cannbotprovider\/GLM-5\.3\s/.test(line));
  // Custom 标题挪到右侧说明列（缩进在编号右边）：不应被认成分组标题。
  lines[at - 1] = ' '.repeat(60) + 'Custom';
  const parsed = picker.parsePicker(lines, { allowNoCursor: true });
  assert.notEqual(parsed?.rows.find(row => /cannbotprovider\/GLM-5\.3$/.test(row.label))?.group, 'Custom');
});

test('absent from the menu but the menu did not close: the backstage button is offered (mismatch)', () => {
  assert.equal(picker.pickFailureKind({ message: '模型菜单里没有 X', inputReady: false }), 'mismatch');
  assert.equal(picker.pickFailureKind({ message: '模型菜单里没有 X', inputReady: true }), 'absent');
});
