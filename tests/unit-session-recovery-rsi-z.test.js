'use strict';
// Synthetic fixtures only. HUB_RSI_BASELINE=1 executes the pre-fix source.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function source(file) {
  return process.env.HUB_RSI_BASELINE === '1'
    ? execFileSync('git', ['show', `${process.env.HUB_RSI_BASELINE_REF || 'origin/main'}:${file}`], { cwd: root, windowsHide: true, encoding: 'utf8' })
    : fs.readFileSync(path.join(root, file), 'utf8');
}
function load(file) {
  if (process.env.HUB_RSI_BASELINE !== '1') return require(path.join(root, file));
  const name = path.join(root, file), mod = new Module(name, module);
  mod.filename = name; mod.paths = Module._nodeModulePaths(path.dirname(name));
  mod._compile(source(file), name);
  return mod.exports;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function cards(parse = s => '<p>' + esc(s) + '</p>') {
  return load('renderer/turn-card-renderer.js').createTurnCardRenderer({ document: { addEventListener() {} }, window: {}, navigator: {}, escapeHtml: esc,
    marked: { parse }, DOMPurify: { sanitize: s => s }, formatAbsoluteTime: () => '', normalizeMarkdownPathBreaks: s => s });
}
test('malformed card remains visible with escaped original text; the next card still renders', () => {
  const r = cards(s => { if (s.includes('broken')) throw new Error('<bad-parser>'); return '<p>' + esc(s) + '</p>'; });
  const warn = console.warn; console.warn = () => {};
  try {
    const html = r.renderTurnCard({ id: 'bad', role: 'assistant', text: 'broken <script>alert(1)</script>', kind: 'claude' });
    assert.match(html, /turn-render-error/);
    assert.match(html, /原始记录仍保留/);
    assert.match(html, /broken &lt;script&gt;/);
    assert.doesNotMatch(html, /<script>|<bad-parser>/);
    assert.match(r.renderTurnCard({ id: 'good', role: 'assistant', text: 'next answer' }), /next answer/);
  } finally { console.warn = warn; }
});
test('empty and whitespace messages have a placeholder; tool-only messages retain tools', () => {
  const r = cards();
  for (const text of ['', '  \n ']) assert.match(r.renderTurnCard({ id: 'empty', role: 'assistant', text }), /这条消息没有正文/);
  const tools = r.renderTurnCard({ id: 'tools', role: 'assistant', text: '', toolCalls: [{ name: 'Read', input: { file_path: 'test.txt' } }] });
  assert.doesNotMatch(tools, /这条消息没有正文/);
  assert.match(tools, /Read|test.txt/);
});
test('group join recovers a dormant stale snapshot from its exact saved identity without mutating it', () => {
  const { recoverForkSource, registerGroupChatForkIpc } = load('main/ipc/groupchat-fork-handlers.js');
  const live = { id: 'hub-test', kind: 'codeagent', cwd: 'D:/test', status: 'dormant' };
  const sid = '11111111-1111-4111-8111-111111111111';
  const saved = { ...live, hubId: live.id, ccSessionId: sid, transcriptPath: 'D:/test/history.jsonl' };
  assert.equal(typeof recoverForkSource, 'function');
  assert.equal(recoverForkSource(live, () => saved).ccSessionId, sid);
  assert.equal(recoverForkSource({ ...live, transcriptPath: 'old-location.jsonl' }, () => saved).transcriptPath, saved.transcriptPath);
  assert.equal(live.ccSessionId, undefined);
  let created;
  const api = registerGroupChatForkIpc({ handle() {} }, {
    sessionManager: { getAllSessions: () => [live] }, sessionStore: { loadSessionFile: () => saved },
    meetingManager: {}, addMeetingSubInternal: async (_m, _k, opts) => { created = opts; return { session: { id: 'child' } }; },
  });
  assert.equal(api.forkabilityOf(live).ok, true);
  return api.forkSessionIntoMeeting('meeting', live).then(result => {
    assert.equal(result.ok, true);
    assert.equal(created.forkCCSessionId, sid);
  });
});
test('unbound first-turn sessions give recovery steps and never guess an unrelated native id', () => {
  const { registerGroupChatForkIpc } = load('main/ipc/groupchat-fork-handlers.js');
  const api = registerGroupChatForkIpc({ handle() {} }, { sessionStore: { loadSessionFile: () => null } });
  const result = api.forkabilityOf({ id: 'empty', kind: 'codeagent', status: 'idle' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'native-session-id-missing');
  assert.match(result.message, /发送一条消息/);
  assert.match(result.message, /已有回答仍失败/);
});
test('group identity recovery refuses wrong account, path, provider, live reset, or Hub id', () => {
  const { recoverForkSource } = load('main/ipc/groupchat-fork-handlers.js');
  assert.equal(typeof recoverForkSource, 'function');
  const live = { id: 'hub-test', kind: 'codeagent', cwd: 'D:/test', status: 'dormant' };
  const saved = { ...live, hubId: live.id, ccSessionId: '11111111-1111-4111-8111-111111111111' };
  for (const patch of [{ hubId: 'other' }, { kind: 'claude' }, { cwd: 'D:/other' }, { claudeConfigDir: 'different-account' }, { codeagentPoolAccount: 'other-account' }]) {
    assert.equal(recoverForkSource(live, () => ({ ...saved, ...patch })), live);
  }
  for (const patch of [{ status: 'idle' }, { codeagentIdentityPending: true }, { codeagentPrefixFork: { pending: true } }]) {
    const current = { ...live, ...patch };
    assert.equal(recoverForkSource(current, () => saved), current);
  }
});
test('null resume result clears pending state and leaves the dormant history untouched', async () => {
  const text = source('renderer/renderer.js');
  const start = text.indexOf('async function resumeDormantSession('), end = text.indexOf('window.resumeDormantSession =', start);
  const dormant = { id: 'old', status: 'dormant', transcriptPath: 'history.jsonl', ccSessionId: 'old-native' };
  const pending = new Map();
  const ctx = { sessions: new Map([['old', dormant]]), _pendingDormantResumes: pending,
    paintSidebarResumePending() {}, scheduleSessionListRender() {}, buildSessionResumeMeta: s => s,
    ipcRenderer: { invoke: async () => null } };
  vm.runInNewContext(text.slice(start, end), ctx);
  await assert.rejects(ctx.resumeDormantSession('old'), /会话未能启动/);
  assert.equal(pending.size, 0);
  assert.equal(dormant._resumePending, false);
  assert.equal(dormant.transcriptPath, 'history.jsonl');
  assert.equal(dormant.ccSessionId, 'old-native');
});
test('resume failure buttons read history without waking CLI and open a separate new-session form', async () => {
  const text = source('renderer/renderer.js'), start = text.indexOf('function showDormantResumePlaceholder(');
  const end = text.indexOf('\nconst wakeDormantMeetingMembers', start);
  const nodes = [];
  const node = () => { const n = { classList: { add() {}, remove() {} }, style: {}, children: [],
    append(...items) { this.children.push(...items); }, appendChild(x) { this.append(x); }, setAttribute() {},
    addEventListener(type, fn) { this[type] = fn; }, remove() { this.removed = true; } }; nodes.push(n); return n; };
  const panel = node(), overlay = node(); let read = 0, opened;
  const ctx = { document: { createElement: node, getElementById: () => overlay }, terminalPanelEl: panel, emptyStateEl: node(), activeSessionId: 'old',
    suspendInactiveTerminalRenderers() {}, preserveAndClearTerminalPanel() {}, applyViewMode() {},
    loadSessionHistoryToOverlay: async id => { assert.equal(id, 'old'); read++; }, sessionModelId() {},
    ipcRenderer: {}, require: () => ({ mountPiRouteKeyFix: async () => {} }),
    window: { WorkspaceController: { openNewSessionModal: opts => { opened = opts; } } } };
  vm.runInNewContext(text.slice(start, end), ctx);
  ctx.showDormantResumePlaceholder({ id: 'old', kind: 'codeagent' }, new Error('resume failed'));
  const history = nodes.find(n => n.textContent === '查看已有历史'), fresh = nodes.find(n => n.textContent === '新建会话（保留此会话）');
  assert.ok(history); assert.ok(fresh);
  await history.click(); fresh.click();
  assert.equal(read, 1); assert.equal(opened.kind, 'codeagent');
});
