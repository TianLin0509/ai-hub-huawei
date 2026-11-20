'use strict';
// 诊断界面返工（2026-11-21，独立审查 6 条）：每条一条「撤掉修复就会失败」的单测。
// 体检页（renderer/env-check.js）在 vm 里跑完整脚本、点真实的按钮回调，不启动 Electron；定位中心用假客户端。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const fake = require('./fixtures/harness-locate-fake');
const view = require('../renderer/harness-view');

// ---------- 体检页的最小假 DOM ----------
function stub() {
  return { textContent: '', innerHTML: '', hidden: false, disabled: false, dataset: {}, classList: { toggle() {} },
    setAttribute() {}, removeAttribute() {}, querySelector: () => null, scrollIntoView() {} };
}
function envCheckPage({ items, harness, invoke = () => ({}) }) {
  const parts = new Map(), calls = [];
  const dialog = { open: false, listeners: {}, setAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; },
    addEventListener(name, fn) { this.listeners[name] = fn; }, set innerHTML(_v) {},
    querySelector(sel) { if (!parts.has(sel)) parts.set(sel, stub()); return parts.get(sel); }, querySelectorAll: () => [] };
  const document = { readyState: 'complete', head: { append() {} }, body: { appendChild() {} },
    createElement: tag => (tag === 'dialog' ? dialog : stub()), getElementById: () => null, querySelector: () => null, addEventListener() {} };
  const result = { items, counts: {}, report: 'x' };
  const ipcRenderer = { on() {}, invoke: async (name, args) => {
    calls.push([name, args]);
    if (name === 'env-check:run') return result;
    if (name === 'cli-tools:state') return { available: true, tools: {} };
    if (name === 'components:state') return { doctor: null };
    return invoke(name, args);
  } };
  const window = { addEventListener() {} };
  const localRequire = name => {
    if (name === 'electron') return { ipcRenderer };
    if (name === './harness-view') return view;
    if (name === './harness-client') return { createHarnessClient: () => harness, copyText: async () => {} };
    if (name === './download-source-view') return { slotHtml: () => '', fill: async () => [] };
    if (name === './download-progress-view') return { html: () => '' };
    if (name === '../core/distribution') return { editionVersion: '' };
    throw new Error('Unexpected require: ' + name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/env-check.js'), 'utf8'), {
    document, window, require: localRequire, console, localStorage: { getItem: () => '', setItem() {} }, navigator: {},
  }, { filename: 'renderer/env-check.js' });
  // 点按钮：目标节点只认给定的 data-* 属性。
  const click = attrs => {
    const node = { dataset: {}, getAttribute: k => attrs[k] };
    for (const [k, v] of Object.entries(attrs)) node.dataset[k.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    const target = { closest: sel => { const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel); return m && m[1] in attrs && (m[2] == null || attrs[m[1]] === m[2]) ? node : null; } };
    return dialog.listeners.click({ target, preventDefault() {}, stopPropagation() {} });
  };
  return { window, dialog, calls, click, list: () => dialog.querySelector('[data-ec="list"]').innerHTML, msg: () => dialog.querySelector('[data-ec="msg"]').textContent };
}
function fakeHarness(over = {}) {
  const log = [];
  const h = { log, missing: false, onChange: () => () => {}, diagnosisText: async () => '',
    locateAll: async () => { log.push('locateAll'); return { value: {} }; },
    locate: async id => { log.push('locate:' + id); return { value: null }; },
    pickPath: async () => ({ value: null }), clearPath: async () => ({ value: null }), applyFix: async () => ({ value: null }), setPath: async () => ({ value: null }), ...over };
  return h;
}
const row = (id, name, status, locate, extra = {}) => ({ id, name, status, detail: locate.reason, fixes: locate.fixes, extra: { locate }, ...extra });
const settle = () => new Promise(r => setImmediate(r));

// 试跑没通过的手动文件：定位中心 v1.2 不保存，但返回值的 chosen 就是那份失败的文件。
function failedManual(id = 'claude') {
  const bad = { path: 'E:\\junk\\notepad.exe', source: 'manual', sourceLabel: '你手动指定的', version: '9.9.9', runtime: null, verdict: 'too-old', reason: '版本太低' };
  return { ...fake.results()[id], verdict: 'too-old', reasonCode: 'manual-path-failed', reason: '你选的 E:\\junk\\notepad.exe 没通过试跑：版本太低', chosen: bad, candidates: [bad],
    fixes: [{ label: '改回自动查找', act: 'harness-clear-manual', id }, { label: '手动选择程序…', act: 'harness-pick', id }] };
}

test('第 1 条：选文件试跑没通过时按失败报，并重取定位中心当前结论，不把失败的文件标成「Hub 将用这个」', async () => {
  // 结论卡文字：版本太低的手动文件不算选成功（旧代码按 isManual 或 too-old 判成功）。
  assert.equal(view.pickSucceeded(failedManual()), false);
  assert.equal(view.pickMessage(failedManual()).bad, true);
  assert.match(view.pickMessage(failedManual()).text, /^没用上你选的文件：.*原来的设置没有改动。$/);
  assert.equal(view.pickSucceeded(fake.pickOk('pi')), true);
  // 体检页：点「选择文件」→ 失败 → 重取 locate → 列表里只有原来那份。
  const claude = fake.results().claude;
  const h = fakeHarness({ pickPath: async () => ({ value: failedManual() }), locate: async id => { h.log.push('locate:' + id); return { value: claude }; } });
  const p = envCheckPage({ items: [row('claude', 'Claude Code', 'ok', claude)], harness: h });
  await p.window.__envCheck.open({ tab: 'environment' });
  p.click({ 'data-ec-toggle': 'claude' });
  await p.click({ 'data-hx-act': 'pick', 'data-hx-id': 'claude' }); await settle();
  assert.ok(h.log.includes('locate:claude'), '失败后要重新取一次当前状态');
  assert.doesNotMatch(p.list(), /notepad\.exe/, '没保存的失败文件不出现在结论卡里');
  assert.match(p.list(), /Hub 将用这个|官方安装位置/);
  assert.match(p.msg(), /^没用上你选的文件/);
});

test('第 1 条：CodeAgent 安装说明里选文件失败只报原因，不说「可以直接新建会话」', async () => {
  const els = new Map();
  const el = sel => { if (!els.has(sel)) els.set(sel, { textContent: '', hidden: false, disabled: false, onclick: null, remove() {}, removeAttribute() {}, insertAdjacentHTML() {} }); return els.get(sel); };
  const dialog = { isConnected: true, open: false, dataset: {}, set innerHTML(_v) {}, showModal() { this.open = true; }, close() {}, setAttribute() {}, addEventListener() {}, querySelector: el };
  const document = { createElement: () => dialog, body: { append() {} } };
  const calls = [];
  const ipcRenderer = { on() {}, invoke: async (name) => {
    calls.push(name);
    if (name === 'harness:pick-path') return failedManual('codeagent');
    if (name === 'community:setup') return { providers: [{ id: 'codeagent', installed: false }] };
    if (name === 'harness:locate') return { ...fake.results().codeagent };
    return { ok: true, candidates: [] };
  } };
  const { createCodeAgentSetup } = require('../renderer/codeagent-setup');
  createCodeAgentSetup({ document, ipcRenderer }).showGuide(); await settle(); await settle();
  await el('[data-setup="pick"]').onclick();
  const status = el('[role="status"]').textContent;
  assert.match(status, /^没用上你选的文件/);
  assert.doesNotMatch(status, /新建会话/);
});

test('第 2 条：一键补齐失败时把原因（打码后）挂在那一行按钮旁，不只说「还没好」', async () => {
  const dsh = { ...fake.results().dsh, verdict: 'broken', reason: '缺界面包', fixes: [{ label: '一键补齐', act: 'harness-repair', id: 'dsh' }] };
  // 样本路径分段拼接：源码里不出现连续的本机用户目录路径，免得被公开版的本机路径检查当成泄露。
  const cachePath = ['C:', 'Users', 'someone', 'AppData', 'npm-cache'].join('\\');
  const h = fakeHarness({ applyFix: async () => ({ value: { ...dsh, repairError: '公司代理要求登录（407）。原话：npm ERR 407 at ' + cachePath } }) });
  const p = envCheckPage({ items: [row('dsh', 'DSH', 'bad', dsh)], harness: h });
  await p.window.__envCheck.open({ tab: 'environment' });
  await p.click({ 'data-ec-fix': 'dsh:0' }); await settle();
  assert.match(p.list(), /hx-repair-error[^>]*>没补齐：公司代理要求登录（407）/);
  assert.match(p.list(), /C:\\Users\\&lt;user&gt;/);
  assert.doesNotMatch(p.list() + p.msg(), /someone/);
  assert.match(p.msg(), /^没补齐：公司代理要求登录（407）/);
});

test('第 3 条：组件中心里 CLI 不正常只画安装按钮时，展开后「选择文件」「改回自动查找」都在', async () => {
  const broken = failedManual('claude');
  const p = envCheckPage({ items: [row('claude', 'Claude Code', 'bad', broken)], harness: fakeHarness() });
  await p.window.__envCheck.open({ tab: 'components' });
  const html = p.list();
  assert.match(html, /data-ec-install="claude"/, '行上是安装按钮');
  assert.doesNotMatch(html, /data-ec-fix=/, 'fixes 没画在行上');
  assert.match(html, /data-hx-act="pick"/);
  assert.match(html, /data-hx-act="clear"[^>]*>改回自动查找</);
  // 结论卡：按行上实际画出的去重，而不是按 fixes 去重；不是手动路径时「改回自动查找」也在，只是不可点。
  assert.match(view.panelHtml(fake.results().pi), /data-hx-act="pick"/);
  assert.doesNotMatch(view.panelHtml(fake.results().pi, { rowActs: ['harness-pick'] }), /data-hx-act="pick"/);
  assert.match(view.panelHtml(fake.results().claude), /data-hx-act="clear"[^>]*disabled/);
});

test('第 4 条：打开体检和「重新体检」都不再先跑一遍 locate-all', async () => {
  const h = fakeHarness();
  const p = envCheckPage({ items: [row('claude', 'Claude Code', 'ok', fake.results().claude)], harness: h });
  await p.window.__envCheck.open({ tab: 'environment' });
  await p.click({ 'data-ec': 'rerun' }); await settle();
  assert.equal(h.log.filter(x => x === 'locateAll').length, 0);
  assert.equal(p.calls.filter(([n]) => n === 'env-check:run').length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls.filter(([n]) => n === 'env-check:run').at(-1)[1])), { fresh: true });
});

test('第 5 条：体检判「不适用」的行保持灰色「不适用」和原话，不变成红色「没找到」', async () => {
  const pi = fake.results().pi;
  const p = envCheckPage({ items: [{ id: 'node', name: 'Node.js', status: 'off', detail: '用不到（只有源码运行需要）', fixes: [], extra: { locate: { ...pi, id: 'node' } } }], harness: fakeHarness() });
  await p.window.__envCheck.open({ tab: 'environment' });
  const html = p.list();
  assert.match(html, /class="ec-item ec-off hx-row/);
  assert.match(html, /<span class="ec-state">不适用<\/span>/);
  assert.match(html, /用不到（只有源码运行需要）/);
  assert.doesNotMatch(html, /hx-bad|没找到/);
});

test('第 6 条：CodeAgent 切换版本走定位中心 set-path，不写旧的 tool-discovery；没通过就报原因', async () => {
  const picker = require('../renderer/tool-version-picker');
  const invoked = [], set = [];
  const ipcRenderer = { invoke: async (name, args) => { invoked.push(name); return { ok: true }; } };
  const harness = { setPath: async (id, file) => { set.push([id, file]); return { value: { ...fake.results().codeagent, verdict: 'ok', chosen: { path: file, source: 'manual' } } }; } };
  await picker.useVersion({ ipcRenderer, harness, tool: 'codeagent', path: 'C:\\b\\codeagent.cmd' });
  assert.deepEqual(set, [['codeagent', 'C:\\b\\codeagent.cmd']]);
  assert.deepEqual(invoked, [], '不再写 tool-discovery');
  const failing = { setPath: async () => ({ value: { verdict: 'broken', reason: '你选的 C:\\b\\codeagent.cmd 没通过试跑：跑不起来' } }) };
  await assert.rejects(picker.useVersion({ ipcRenderer, harness: failing, tool: 'codeagent', path: 'C:\\b\\codeagent.cmd' }), /没通过试跑/);
  // welink 等其他工具照旧走 tool-discovery。
  await picker.useVersion({ ipcRenderer, harness, tool: 'welink', path: 'y' });
  assert.deepEqual(invoked, ['tool-discovery:use']);
  // 「当前在用」按定位中心生效的那份标。
  const summary = { tool: 'codeagent', current: { path: 'C:\\a\\codeagent.cmd' }, candidates: [{ path: 'C:\\a\\codeagent.cmd', current: true }, { path: 'C:\\b\\codeagent.cmd', current: false }] };
  const aligned = await picker.alignWithLocator(summary, { locate: async () => ({ value: { chosen: { path: 'c:\\B\\codeagent.cmd' } } }) });
  assert.deepEqual(aligned.candidates.map(c => c.current), [false, true]);
  assert.equal(aligned.current.path, 'C:\\b\\codeagent.cmd');
});
