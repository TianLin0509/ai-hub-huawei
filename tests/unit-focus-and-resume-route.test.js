'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pickFocusTarget } = require('../renderer/focus-target.js');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');

test('A2-03 卡片视图发送后焦点回输入框，后台终端视图才给终端', () => {
  assert.equal(pickFocusTarget({ nativeAgent: false, cardView: true }), 'input');
  assert.equal(pickFocusTarget({ nativeAgent: true, cardView: false }), 'input');
  assert.equal(pickFocusTarget({ nativeAgent: false, cardView: false }), 'terminal');
});

test('A2-03 发送、停止、Esc 三处都走 focusAfterSend', () => {
  const i = renderer.indexOf('function mountFloatingInput(');
  const j = renderer.indexOf('\nfunction ', i + 10);
  const body = renderer.slice(i, j > 0 ? j : undefined);
  assert.ok((body.match(/focusAfterSend\(\)/g) || []).length >= 4);
  assert.ok(!/\n\s+terminal\.focus\(\);/.test(body.replace(/const focusAfterSend[\s\S]*?\};\n/, '')));
});

const start = renderer.indexOf("ipcRenderer.on('session-created', async (_e, { session }) => {");
const end = renderer.indexOf('  const activatedSession = sessions.get(session.id);', start);
const registration = renderer.slice(start, end) + ' activated = true; });';
async function route({ active, home = false, team = false, selectIntent = 7, currentIntent = 7 }) {
  let handler;
  const session = { id: 'A', kind: 'codeagent', currentModel: { id: 'm' } };
  const sessions = new Map([['A', { id: 'A', kind: 'codeagent', status: 'dormant', unreadCount: 0 }]]);
  const ctx = { sessions, activeSessionId: active, activated: false, sessionOpenIntent: currentIntent,
    require: id => require(path.join(__dirname, '../renderer', id)),
    ipcRenderer: { on: (_n, fn) => { handler = fn; } }, nativeSessionBootstrap: { record() {} },
    codexAccountUi: { resumeCodexAccountRestart: () => false },
    _pendingDormantResumes: new Map([['A', { forceScrollBottom: true, selectIntent }]]),
    paintSidebarResumePending() {}, observeSessionRuntime() {}, RUNTIME_IDLE: 'idle', CONFIDENCE_AUTHORITATIVE: 'authoritative',
    scheduleSessionListRender() {}, schedulePersist() {}, sessionSplit: null,
    assistantPanel: { isOpen: () => false }, Date,
    document: { body: { classList: { contains: c => team && c === 'team-page-open' } } },
    terminalPanelEl: { classList: { contains: c => home && c === 'home-active' } } };
  vm.runInNewContext(registration, ctx);
  await handler(null, { session });
  return ctx.activated;
}
test('A2-06 点侧栏唤醒后用户已切走（别的会话/主页/团队页），完成时不抢回', async () => {
  assert.equal(await route({ active: 'A' }), true);
  assert.equal(await route({ active: 'B', currentIntent: 8 }), false);
  assert.equal(await route({ active: 'A', home: true }), false);
  assert.equal(await route({ active: 'A', team: true }), false);
});

test('A2-06 搜索结果「继续会话」等入口没有 selectIntent：完成时照旧打开它', async () => {
  assert.equal(await route({ active: 'B', selectIntent: null }), true);
  assert.equal(await route({ active: null, selectIntent: null }), true);
});

test('A2-18 唤醒完成后仍在该会话时聚焦输入框', () => {
  assert.match(renderer, /if \(pendingResume\) \{\s*const resumedId = session\.id;[\s\S]{0,500}floating-input-box[\s\S]{0,200}box\.focus\(\)/);
});
