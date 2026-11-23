'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createResumeSessionHandler, registerResumeSessionIpc } = require('../main/ipc/resume-session-handlers');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function mainFixture(t, { tap = () => {} } = {}) {
  t.mock.method(require('../core/session-store'), 'loadSessionFile', () => null);
  let auth = deferred(), creates = 0, owner = null;
  const live = new Map(), handlers = new Map();
  const resume = createResumeSessionHandler({ fs, os, path, getHookPort: () => 0,
    isClaudeFamily: () => false, isCodexBaseKind: () => false, meetingManager: { getAllMeetings: () => [] },
    ensureLaunchAuth: () => auth.promise, registerSessionForTap: tap, sendToRenderer() {},
    sessionManager: { getSession: id => live.get(id), _openOwners: () => ({ owner: () => owner }),
      createSession(kind, opts) { creates++; const session = { id: opts.id, kind, status: 'idle' }; live.set(opts.id, session); return session; } } });
  registerResumeSessionIpc({ handle: (name, handler) => handlers.set(name, handler) }, { resumeSession: resume });
  return { resume, live, handlers, get auth() { return auth; }, nextAuth() { auth = deferred(); },
    setOwner(value) { owner = value; }, get creates() { return creates; } };
}

test('主进程仅在旧请求结束且没有写入者时允许重试，迟到成功后不再新开', async t => {
  const f = mainFixture(t), meta = { hubId: 'late', kind: 'powershell' };
  const old = f.resume(meta);
  assert.equal(f.resume.getStatus(meta.hubId).canRetry, false);
  await assert.rejects(f.resume(meta, { retry: true }), /尚未结束/);
  f.auth.resolve();
  await old;
  assert.equal(f.resume.getStatus(meta.hubId).state, 'live');
  await assert.rejects(f.resume(meta, { retry: true }), /会话已打开/);
  assert.equal(f.creates, 1);
});

test('CLI 已启动但后续挂接失败时，不因请求失败而允许第二个写入者', async t => {
  const f = mainFixture(t, { tap: () => { throw new Error('挂接失败'); } });
  const meta = { hubId: 'partial', kind: 'powershell' }, pending = f.resume(meta);
  f.auth.resolve();
  await assert.rejects(pending, /挂接失败/);
  assert.equal(f.resume.getStatus(meta.hubId).state, 'live');
  await assert.rejects(f.resume(meta, { retry: true }));
  assert.equal(f.creates, 1);
});

test('旧请求失败后重试确实创建新请求，连续点击被主进程原子拦住', async t => {
  const f = mainFixture(t), meta = { hubId: 'failed', kind: 'powershell' };
  const old = f.resume(meta);
  f.auth.reject(new Error('认证失败'));
  await assert.rejects(old, /认证失败/);
  const status = f.handlers.get('resume-session:status');
  assert.equal(status(null, meta.hubId).canRetry, true);
  f.nextAuth();
  const retry = f.handlers.get('resume-session')(null, meta, { retry: true });
  assert.notEqual(retry, old);
  const duplicates = Array.from({ length: 5 }, () => assert.rejects(f.resume(meta, { retry: true }), /尚未结束/));
  assert.equal(status(null, meta.hubId).state, 'pending');
  f.auth.resolve();
  await Promise.all([retry, ...duplicates]);
  assert.equal(f.creates, 1);
});

test('本 Hub 其他入口的预约、其他 Hub 的占用和未知状态都不暴露重试', async t => {
  const f = mainFixture(t), meta = { hubId: 'owned', kind: 'powershell' };
  for (const pid of [process.pid, process.pid + 1]) {
    f.setOwner({ pid });
    assert.equal(f.resume.getStatus(meta.hubId).state, 'occupied');
    await assert.rejects(f.resume(meta, { retry: true }));
  }
  assert.equal(f.creates, 0);
  assert.equal(f.resume.getStatus(null).canRetry, false);
});

test('能力探测尚未完成时也算在途，不能通过重试绕开旧探测', async t => {
  const probe = deferred();
  t.mock.method(require('../core/cli-capabilities'), 'providerForKind', () => 'codeagent');
  t.mock.method(require('../core/codeagent-capabilities'), 'prepareForKind', () => probe.promise);
  const f = mainFixture(t), meta = { hubId: 'probe', kind: 'powershell' };
  const pending = f.resume(meta);
  await flush();
  assert.equal(f.resume.getStatus(meta.hubId).state, 'pending');
  await assert.rejects(f.resume(meta, { retry: true }));
  assert.equal(f.creates, 0);
  f.auth.resolve(); probe.resolve();
  await pending;
  assert.equal(f.creates, 1);
});

function uiFixture(status = Promise.resolve({ canRetry: true })) {
  const node = () => ({ classList: { add() {}, remove() {} }, style: {}, children: [], isConnected: true,
    append(...items) { this.children.push(...items); }, appendChild(item) { this.append(item); }, setAttribute() {},
    remove() { this.isConnected = false; }, addEventListener(type, handler) { this[type] = handler; } });
  const terminal = node(), session = { id: 'old', kind: 'codeagent', status: 'dormant', cwd: 'D:/original' };
  const history = [], selections = [], newSessions = [];
  const ctx = { terminalPanelEl: terminal, emptyStateEl: node(), activeSessionId: session.id, sessionOpenIntent: 1,
    sessions: new Map([[session.id, session]]), document: { createElement: node, getElementById: () => null },
    suspendInactiveTerminalRenderers() {}, preserveAndClearTerminalPanel() { for (const n of terminal.children) n.remove(); terminal.children = []; },
    ipcRenderer: { invoke: () => status }, sessionModelId: () => '', require: () => ({ mountPiRouteKeyFix: async () => {} }),
    applyViewMode() {}, loadSessionHistoryToOverlay: async id => { history.push(id); },
    selectSession: (id, opts) => selections.push({ id, opts }), window: { WorkspaceController: { openNewSessionModal: opts => newSessions.push(opts) } } };
  vm.runInNewContext(section('function showDormantResumePlaceholder(', '\nconst wakeDormantMeetingMembers'), ctx);
  function show(error, opts) {
    ctx.showDormantResumePlaceholder(session, error, opts);
    const panel = terminal.children[0], copy = panel.children.at(-1), [retry, history, fresh] = copy.children.at(-1).children;
    return { panel, copy, retry, history, fresh };
  }
  return { ctx, session, show, history, selections, newSessions };
}

test('失败和超时始终能看历史；仅主进程确认可重试才显示，连续点击只提交一次', async () => {
  for (const failure of [new Error('启动失败'), null]) {
    const f = uiFixture(), ui = f.show(failure, { timedOut: !failure });
    assert.equal(ui.history.textContent, '查看已有历史');
    assert.equal(ui.copy.children[1].textContent, 'ⓘ');
    assert.equal(ui.retry.hidden, true);
    await flush();
    assert.equal(ui.retry.hidden, false);
    ui.retry.click(); ui.retry.click();
    assert.equal(f.selections.length, 1);
    assert.equal(f.selections[0].opts.resumeRetry, true);
    ui.history.click();
    assert.deepEqual(f.history, ['old']);
    assert.equal(f.ctx.sessionOpenIntent, 2, '看历史后不接受原来的自动切回意图');
  }
});

test('切换会话或移除占位后，状态迟到不显示重试，旧按钮也不能新建', async () => {
  for (const leave of ['switch', 'remove']) {
    const status = deferred(), f = uiFixture(status.promise), ui = f.show(null, { timedOut: true });
    if (leave === 'switch') f.ctx.activeSessionId = 'other'; else ui.panel.remove();
    status.resolve({ canRetry: true });
    await flush();
    assert.equal(ui.retry.hidden, true);
    ui.retry.click(); ui.fresh.click();
    assert.equal(f.selections.length, 0); assert.equal(f.newSessions.length, 0);
  }
});

test('如实的新建入口携带原目录，不承诺继承对话；状态查询失败仍保留两条出路', async () => {
  const f = uiFixture(Promise.reject(new Error('IPC 不可用'))), ui = f.show(null, { timedOut: true });
  await flush();
  assert.equal(ui.retry.hidden, true);
  assert.equal(ui.fresh.textContent, '在原目录新建会话');
  ui.fresh.click();
  assert.equal(f.newSessions[0].workspace.path, 'D:/original');
  assert.equal(f.ctx.sessionOpenIntent, 2);
});

test('成员和拍图会话迟到成功也尊重看历史意图，正常选中仍接回', async () => {
  const from = source.indexOf("  if (session.purpose === 'hub-photo-assistant') {", source.indexOf("ipcRenderer.on('session-created'"));
  const to = source.indexOf('  // Background creation/recovery only refreshes', from);
  for (const session of [{ id: 'old', purpose: 'hub-photo-assistant' }, { id: 'old', meetingId: 'meeting' }]) {
    for (const abandoned of [true, false]) {
      let selected = 0;
      const ctx = { session, wasDormant: true, resumeAbandoned: abandoned, activeSessionId: 'old', pendingResume: {},
        assistantPanel: { isOpen: () => false }, selectSession: async () => { selected++; }, scheduleSessionListRender() {} };
      vm.runInNewContext('async function created() {\n' + source.slice(from, to) + '\n}', ctx);
      await ctx.created();
      assert.equal(selected, abandoned ? 0 : 1);
    }
  }
});
