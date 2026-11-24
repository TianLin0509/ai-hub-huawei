'use strict';
// 同事反复被卡住的几处小事（2026-11-21 rsi-p）：首次关窗问托盘、终端输入框没清空时「去后台」、
// 模型下拉底部指路 /model、检查更新旁的版本状态。全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---- 1. 首次点关闭：问「最小化到托盘 / 退出」，记住选择 ----
function trayFixture({ pending = true, answer = 'tray' } = {}) {
  let trayOn = false;
  const asked = [], remembered = [], balloons = [];
  const win = { hidden: false, isDestroyed: () => false, isVisible() { return !this.hidden; }, hide() { this.hidden = true; } };
  class Tray { constructor() {} setToolTip() {} setContextMenu() {} on() {} destroy() {} displayBalloon(b) { balloons.push(b); } }
  const controller = require('../main/tray-controller').createTrayController({
    Tray, Menu: { buildFromTemplate: t => t }, getIcon: () => null, getMainWindow: () => win,
    focusWindow() {}, quit() {}, isEnabled: () => trayOn, logger: { warn() {} },
    closeChoice: {
      pending: () => pending && !remembered.length,
      ask: w => { asked.push(w); return answer; },
      remember: tray => { remembered.push(tray); trayOn = tray; },
    },
  });
  const close = () => { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; return { handled: controller.interceptClose(ev), ev }; };
  return { controller, win, asked, remembered, balloons, close };
}

test('首次关窗选「最小化到托盘」：窗口藏起来、选择记住、下次不再问', () => {
  const f = trayFixture({ answer: 'tray' });
  const first = f.close();
  assert.equal(first.handled, true);
  assert.equal(first.ev.prevented, true);
  assert.equal(f.win.hidden, true);
  assert.deepEqual(f.remembered, [true]);
  assert.equal(f.asked.length, 1);
  f.win.hidden = false;
  const second = f.close();
  assert.equal(second.handled, true);
  assert.equal(f.asked.length, 1, '记住后不再问');
});

test('首次关窗选「退出」：照常退出、记住不开托盘；「取消」：窗口不关、下次再问', () => {
  const quit = trayFixture({ answer: 'quit' });
  const r = quit.close();
  assert.equal(r.handled, false);
  assert.equal(r.ev.prevented, false);
  assert.deepEqual(quit.remembered, [false]);
  assert.equal(quit.close().handled, false);
  assert.equal(quit.asked.length, 1);

  const cancel = trayFixture({ answer: 'cancel' });
  const c = cancel.close();
  assert.equal(c.handled, true, '取消时调用方不能走退出流程');
  assert.equal(c.ev.prevented, true);
  assert.equal(cancel.win.hidden, false);
  assert.deepEqual(cancel.remembered, []);
  cancel.close();
  assert.equal(cancel.asked.length, 2, '取消不算选过');
});

test('已经选过（或没接选择框）的老行为不变：托盘关着就直接退出，不弹框', () => {
  const f = trayFixture({ pending: false });
  assert.equal(f.close().handled, false);
  assert.equal(f.asked.length, 0);
});

test('选择框文字与按钮映射：按钮 0=托盘 1=退出 2=取消，说明里写清以后去哪改', () => {
  const tc = require('../main/tray-controller');
  const opts = tc.closeChoiceDialogOptions();
  assert.deepEqual(opts.buttons, ['最小化到托盘', '退出 AI Hub', '取消']);
  assert.equal(opts.cancelId, 2);
  assert.match(opts.detail, /可选功能/);
  assert.deepEqual([0, 1, 2, -1].map(tc.closeChoiceFromButton), ['tray', 'quit', 'cancel', 'cancel']);
  const main = read('main.js');
  assert.match(main, /closeChoice: \{\s*pending: \(\) => optionalFeatures\.closePromptPending\(\)/);
  assert.match(main, /remember: tray => optionalFeatures\.rememberCloseChoice\(tray\)/);
});

test('可选功能：没问过时 closePromptPending=true；记住后落盘、重开仍记得；在设置里亲手开关托盘也算选过', () => {
  const { createOptionalFeatures } = require('../core/optional-features');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-p-of-'));
  try {
    const a = createOptionalFeatures({ dataDir: dir, logger: { warn() {} } });
    assert.equal(a.closePromptPending(), true);
    assert.equal(a.rememberCloseChoice(true), true);
    assert.equal(a.get('tray'), true);
    const b = createOptionalFeatures({ dataDir: dir, logger: { warn() {} } });
    assert.equal(b.closePromptPending(), false);
    assert.equal(b.get('tray'), true);
    b.set('tray', false);
    const c = createOptionalFeatures({ dataDir: dir, logger: { warn() {} } });
    assert.equal(c.closePromptPending(), false, '关掉托盘后不再问');
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-p-of2-'));
    const d = createOptionalFeatures({ dataDir: dir2, logger: { warn() {} } });
    d.set('tray', false);
    assert.equal(createOptionalFeatures({ dataDir: dir2, logger: { warn() {} } }).closePromptPending(), false);
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 2. 终端输入框没清空：报错旁「去后台」 ----
function fakeDoc() {
  return { body: { appendChild() {} }, getElementById: () => null,
    createElement: () => ({ dataset: {}, innerHTML: '', classList: { add() {}, contains: () => false }, setAttribute() {}, addEventListener() {}, insertAdjacentHTML() {}, remove() {} }) };
}

test('「终端输入框未能清空」命中已知问题，主按钮是「去后台」', () => {
  const { matchKnownIssue } = require('../core/known-issues');
  for (const text of ['终端输入框未能清空，请到终端确认后再发送', '终端输入行已有内容或尚未确认空白，请先在终端处理']) {
    const hit = matchKnownIssue({ area: 'toast', details: text });
    assert.equal(hit && hit.id, 'terminal-input-residual', text);
    assert.equal(hit.action.act, 'known:open-backstage');
  }
  const card = require('../renderer/hub-error-card');
  const el = card.showErrorToast(fakeDoc(), '终端输入框未能清空，请到终端确认后再发送', { sessionId: 's1' });
  assert.match(el.innerHTML, /data-hub-err-act="known:open-backstage">去后台</);
  assert.equal(el.dataset.sessionId, 's1');
});

test('点「去后台」：切到报错所属会话的后台终端；认不出会话时说清下一步', async () => {
  const { runKnownAction } = require('../renderer/hub-error-card');
  const opened = [];
  const button = { textContent: '去后台', disabled: false, isConnected: true, closest: sel => (sel === '[data-session-id]' ? { dataset: { sessionId: 's1' } } : null) };
  const win = { __hubOpenBackstage: async id => { opened.push(id); return { ok: true }; } };
  await runKnownAction('known:open-backstage', button, { doc: {}, win, ipcRenderer: {}, closeOverlays() {} });
  assert.deepEqual(opened, ['s1']);
  const orphan = { textContent: '去后台', disabled: false, isConnected: true, closest: () => null };
  await runKnownAction('known:open-backstage', orphan, { doc: {}, win, ipcRenderer: {}, closeOverlays() {} });
  assert.match(orphan.textContent, /后台/);
  assert.deepEqual(opened, ['s1']);
});

test('渲染层：输入框没清空的几处提示都按报错显示并带会话 id；__hubOpenBackstage 切到后台', () => {
  const renderer = read('renderer/renderer.js');
  const hits = renderer.match(/showToast\('终端输入框未能清空，请到终端确认后再发送', '([a-z]+)'(, \{ sessionId \})?\)/g) || [];
  assert.equal(hits.length, 3);
  for (const h of hits) assert.match(h, /'error', \{ sessionId \}\)$/);
  assert.match(renderer, /window\.__hubOpenBackstage = async sessionId => \{[\s\S]{0,600}applyViewMode\('pty'\)/);
  assert.match(renderer, /createCodeAgentInputRecovery\(\{\s*notify: showToast, sessionId,/);
  const notices = [];
  const rec = require('../renderer/composer-codeagent-input').createCodeAgentInputRecovery({
    sessionId: 's9', isRunning: () => true, notify: (...a) => notices.push(a), invoke: async () => ({ ok: true, cleared: false }) });
  return rec.stop().then(() => assert.deepEqual(notices, [['终端输入框未能清空，请到终端确认后再发送', 'error', { sessionId: 's9' }]]));
});

// ---- 4. 模型下拉底部：更多模型在后台用 /model 切 ----
test('模型下拉提示只给终端里能用 /model 的会话', () => {
  const { backstageModelHint } = require('../renderer/model-ui');
  const yes = [{ kind: 'claude', agentRuntime: 'pty' }, { kind: 'codex' }, { kind: 'codeagent-resume', agentRuntime: 'pty' }, { kind: 'deepseek-claude' }];
  for (const s of yes) assert.match(backstageModelHint(s), /后台.*\/model/, JSON.stringify(s));
  const no = [null, { kind: 'deepseek-acp' }, { kind: 'pi' }, { kind: 'gemini' }, { kind: 'claude', runtimeBackend: 'claude-stream-json' },
    { kind: 'codex', runtimeBackend: 'codex-app-server' }, { kind: 'codeagent', agentRuntime: 'native' }, { kind: 'codeagent', _codeagentAutomatic: true }];
  for (const s of no) assert.equal(backstageModelHint(s), '', JSON.stringify(s));
  const src = read('renderer/model-ui.js');
  assert.ok((src.match(/appendBackstageModelHint\(menu, session\);/g) || []).length >= 2, '有模型和没模型两种菜单都挂提示');
});

// ---- 5. 检查更新旁的版本状态 ----
test('检查更新旁的状态：已是最新 / 有新版本 / 正在下载 / 已就绪 / 标题已写版本时不重复', () => {
  const { menuStatusText } = require('../renderer/app-update-menu-status');
  const latest = v => ({ version: v });
  assert.equal(menuStatusText(null), '');
  assert.equal(menuStatusText({ phase: 'idle', current: '5.6.76' }), '当前 v5.6.76');
  assert.equal(menuStatusText({ phase: 'none', current: '5.6.76', latest: latest('5.6.76'), plan: { kind: 'none' } }), '已是最新 v5.6.76');
  assert.equal(menuStatusText({ phase: 'checking', current: '5.6.76' }), '正在检查…');
  const quiet = { phase: 'available', current: '5.6.76', latest: { version: '5.6.77', notify: false }, plan: { kind: 'incremental' } };
  assert.equal(menuStatusText(quiet), '有新版本 v5.6.77', '小版本不弹窗，但菜单里看得到');
  assert.equal(menuStatusText({ ...quiet, phase: 'downloading' }), '正在下载 v5.6.77');
  assert.equal(menuStatusText({ ...quiet, phase: 'ready' }), 'v5.6.77 已就绪，重启生效');
  assert.equal(menuStatusText(quiet, { labelVersion: '5.6.77' }), '当前 v5.6.76');
  const src = read('renderer/app-update.js');
  assert.match(src, /require\('\.\/app-update-menu-status'\)\.menuStatusText\(state, \{ labelVersion: version \}\)/);
  assert.match(src, /paintMenuEntry\(item, version\);/);
});

// ---- 3. Agent 标识：窄窗口顶栏被挤没时，输入框下方补一个 ----
test('窄窗口：输入框下方有 Agent 标识，宽窗口隐藏（顶栏已有）', () => {
  const renderer = read('renderer/renderer.js');
  assert.match(renderer, /composerAgentTag\.className = 'composer-agent-tag';[\s\S]{0,400}getAgentLabel\(require\('\.\.\/core\/session-capabilities'\)\.runtimeKindForSession\(s\) \|\| s\.kind\)/);
  assert.match(renderer, /tuningControls\.append\(attachBtn, secondaryActions, composerAgentTag, modelChip,/);
  const css = read('renderer/styles/composer.css');
  assert.match(css, /\.composer-agent-tag \{ display: none; \}\s*@media \(max-width: 1240px\) \{\s*\.composer-agent-tag:not\(\[hidden\]\) \{\s*display: inline-flex;/);
});
