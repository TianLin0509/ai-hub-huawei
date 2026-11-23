'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createDormantResumeWatch } = require('../renderer/dormant-resume-watch');
const { createResumeSessionHandler } = require('../main/ipc/resume-session-handlers');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// 手动推进同一时钟，覆盖 90 秒边界，不靠真实等待或缩短产品超时。
function clock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) { const id = ++next; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    tick(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
    get size() { return timers.size; },
  };
}

function rendererFixture() {
  const time = clock(), request = deferred(), ui = [];
  const requests = [request];
  let invokes = 0;
  const dormant = { id: 'wake-test', kind: 'codeagent', status: 'dormant', transcriptPath: 'saved.jsonl' };
  const ctx = {
    sessions: new Map([[dormant.id, dormant]]), _pendingDormantResumes: new Map(), activeSessionId: dormant.id, sessionOpenIntent: 1,
    paintSidebarResumePending() {}, scheduleSessionListRender() {}, buildSessionResumeMeta: s => ({ hubId: s.id }),
    selectSession(id) { assert.equal(ctx.sessions.get(id).status, 'idle'); ui.push('live'); },
    showDormantResumePlaceholder(_session, error, opts = {}) { ui.push(opts.timedOut ? 'timeout' : error ? 'failed' : 'waiting'); },
    ipcRenderer: { invoke(channel) {
      if (channel === 'resume-session:status') return Promise.resolve({ canRetry: true });
      if (channel === 'session:open-status') return Promise.resolve({ available: true });
      return (requests[invokes++] || request).promise;
    } },
  };
  // 使用产品里的回调，核对超时确实停止侧栏等待并就地显示出路。
  const start = source.indexOf('const dormantResumeWatch = ');
  const end = source.indexOf("\nipcRenderer.on('session-created'", start);
  ctx.require = () => ({ createDormantResumeWatch: opts => createDormantResumeWatch({ ...opts, setTimer: time.setTimer, clearTimer: time.clearTimer }) });
  vm.runInNewContext(source.slice(start, end) + '\nthis.dormantResumeWatch = dormantResumeWatch;\n'
    + section('async function resumeDormantSession(', 'window.resumeDormantSession ='), ctx);
  const selectStart = source.indexOf("  if (session.status === 'dormant') {", source.indexOf('async function selectSession('));
  const selectEnd = source.indexOf('  // Reading a reply', selectStart);
  Object.assign(ctx, { schedulePersist() {}, acknowledgeSessionFailureState: () => false, console });
  ctx.ipcRenderer.send = () => {};
  vm.runInNewContext("async function selectDormant(opts = {}) { const id = 'wake-test'; const intent = ++sessionOpenIntent; const session = sessions.get(id);\n"
    + source.slice(selectStart, selectEnd) + '\n}', ctx);
  return { ctx, time, request, requests, ui, dormant, get invokes() { return invokes; } };
}

test('唤醒在 90 秒到期停止等待，重复选择不延后截止时间', async () => {
  const f = rendererFixture();
  const pending = f.ctx.resumeDormantSession(f.dormant.id, { selectIntent: 1 });
  f.time.tick(89_999);
  assert.equal(f.dormant._resumePending, true);
  const second = f.ctx.resumeDormantSession(f.dormant.id);
  f.time.tick(1);
  assert.equal(f.dormant._resumePending, false);
  assert.deepEqual(f.ui, ['timeout']);
  assert.equal(f.invokes, 1);
  f.request.resolve({ id: f.dormant.id });
  await Promise.all([pending, second]);
});

test('90 秒内成功清除计时，回包先到也移除等待提示', async () => {
  const f = rendererFixture();
  const pending = f.ctx.resumeDormantSession(f.dormant.id, { selectIntent: 1 });
  f.time.tick(30_000);
  f.request.resolve({ id: f.dormant.id });
  await pending;
  assert.equal(f.time.size, 0);
  f.time.tick(90_000);
  assert.deepEqual(f.ui, ['live']);
  assert.equal(f.ctx.sessions.get(f.dormant.id).transcriptPath, 'saved.jsonl');
});

test('超时后普通重复唤醒仍复用原请求，迟到成功清除提示且不启动第二次', async () => {
  const f = rendererFixture();
  const pending = f.ctx.resumeDormantSession(f.dormant.id, { selectIntent: 1 });
  f.time.tick(90_000);
  const retry = f.ctx.resumeDormantSession(f.dormant.id, { selectIntent: 2 });
  f.ctx.sessionOpenIntent = 2;
  f.request.resolve({ id: f.dormant.id });
  await Promise.all([pending, retry]);
  assert.equal(f.invokes, 1);
  assert.equal(f.time.size, 0);
  assert.equal(f.ctx.sessions.get(f.dormant.id).status, 'idle');
  // 实际接回必须跟随最新选择，而非最初那次选择。
  assert.deepEqual(f.ui, ['timeout', 'live']);
});

test('超时后用户切走，迟到结果只更新会话状态', async () => {
  const f = rendererFixture();
  const pending = f.ctx.resumeDormantSession(f.dormant.id, { selectIntent: 1 });
  f.ctx.activeSessionId = 'another';
  f.time.tick(90_000);
  f.request.resolve({ id: f.dormant.id });
  await pending;
  assert.deepEqual(f.ui, []);
  assert.equal(f.ctx.sessions.get(f.dormant.id).status, 'idle');
});

test('旧请求尚未结束时显式重试不重置超时、不再等待原请求', async () => {
  const f = rendererFixture();
  const pending = f.ctx.resumeDormantSession(f.dormant.id, { selectIntent: 1 });
  f.time.tick(90_000);
  await f.ctx.selectDormant({ resumeRetry: true });
  assert.equal(f.invokes, 1);
  assert.equal(f.ctx.dormantResumeWatch.isTimedOut(f.dormant.id), true);
  assert.equal(f.time.size, 0);
  f.request.resolve({ id: f.dormant.id });
  await pending;
});

test('旧请求失败后连续点重试只发一个新请求，切走后新请求成功不抢焦点', async () => {
  const f = rendererFixture();
  const old = f.ctx.resumeDormantSession(f.dormant.id, { selectIntent: 1 });
  f.time.tick(90_000);
  f.request.reject(new Error('明确启动失败'));
  await assert.rejects(old, /明确启动失败/);
  const next = deferred(); f.requests.push(next);
  await Promise.all([f.ctx.selectDormant({ resumeRetry: true }), f.ctx.selectDormant({ resumeRetry: true })]);
  assert.equal(f.invokes, 2, '第一次失败，加一次真正的新请求');
  assert.equal(f.ctx.dormantResumeWatch.isTimedOut(f.dormant.id), false);
  f.ctx.activeSessionId = 'other';
  f.ctx.sessionOpenIntent++;
  next.resolve({ id: f.dormant.id });
  await f.ctx.resumeDormantSession(f.dormant.id);
  assert.equal(f.ctx.sessions.get(f.dormant.id).status, 'idle');
  assert.equal(f.ui.includes('live'), false);
});

test('占用状态检查卡住也在 90 秒超时，检查迟到不重新转圈', async () => {
  const f = rendererFixture(), opening = deferred(), invoke = f.ctx.ipcRenderer.invoke;
  f.ctx.ipcRenderer.invoke = (channel, ...args) => channel === 'session:open-status' ? opening.promise : invoke(channel, ...args);
  const selecting = f.ctx.selectDormant();
  f.time.tick(90_000);
  assert.equal(f.invokes, 0, '状态确认前不启动 CLI');
  assert.deepEqual(f.ui, ['waiting', 'timeout']);
  opening.resolve({ available: true });
  await selecting;
  assert.equal(f.invokes, 1);
  assert.equal(f.ui.at(-1), 'timeout');
  assert.equal(f.dormant._resumePending, false);
  f.request.resolve({ id: f.dormant.id });
  await f.ctx.resumeDormantSession(f.dormant.id);
});

test('超时后重选侧栏仍保留出路，迟到成功按最新选择接回', async () => {
  const f = rendererFixture();
  const pending = f.ctx.resumeDormantSession(f.dormant.id, { selectIntent: 1 });
  f.time.tick(90_000);
  await f.ctx.selectDormant();
  assert.equal(f.invokes, 1);
  assert.equal(f.ctx._pendingDormantResumes.get(f.dormant.id).selectIntent, 2);
  f.request.resolve({ id: f.dormant.id });
  await pending;
  assert.deepEqual(f.ui, ['timeout', 'timeout', 'live']);
});

test('本 Hub 的启动预约允许普通重选，其他 Hub 的占用仍被拒绝', () => {
  const text = fs.readFileSync(path.join(__dirname, '../main/ipc/session-handlers.js'), 'utf8');
  const start = text.indexOf("  ipcMain.handle('session:open-status'");
  const end = text.indexOf('  const claudeModelPreferenceGuards', start);
  let handler, owner, live;
  const events = [];
  vm.runInNewContext(text.slice(start, end), {
    process: { pid: 123 }, ipcMain: { handle(_name, fn) { handler = fn; } },
    sessionManager: { _openOwners: () => ({ owner: () => owner }), getSession: () => live },
    sendToRenderer: (name, payload) => events.push({ name, payload }),
    require: () => ({ occupied: () => ({ message: '其他 Hub 正在使用' }) }),
  });
  owner = { pid: 123 };
  assert.equal(handler(null, 'wake').available, true);
  assert.equal(handler(null, 'wake', { reconcile: true }).available, true);
  assert.equal(events.length, 0, '启动仍在进行时不会创建第二个进程');
  live = { id: 'wake', status: 'idle' };
  handler(null, 'wake', { reconcile: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'session-created');
  assert.equal(events[0].payload.session, live);
  owner = { pid: 456 };
  assert.equal(handler(null, 'wake', { reconcile: true }).available, false);
  assert.equal(events.length, 1, '其他 Hub 的占用不能被接回');
  owner = null;
  assert.equal(handler(null, 'wake').available, true);
});

test('超时占位保留历史和如实的新建入口，在途唤醒不提供重试', async () => {
  const nodes = [];
  const node = () => { const n = { classList: { add() {}, remove() {} }, style: {}, children: [],
    append(...items) { this.children.push(...items); }, appendChild(item) { this.append(item); }, setAttribute() {},
    isConnected: true, addEventListener(type, handler) { this[type] = handler; } }; nodes.push(n); return n; };
  const terminal = node(); let retried, opened;
  const ctx = { terminalPanelEl: terminal, emptyStateEl: node(), activeSessionId: 'old', sessionOpenIntent: 1,
    sessions: new Map([['old', { status: 'dormant' }]]), ipcRenderer: { invoke: async () => ({ canRetry: false }) },
    document: { createElement: node, getElementById: () => null }, suspendInactiveTerminalRenderers() {}, preserveAndClearTerminalPanel() {},
    selectSession: (id, opts) => { retried = { id, opts }; },
    window: { WorkspaceController: { openNewSessionModal: opts => { opened = opts; } } } };
  vm.runInNewContext(section('function showDormantResumePlaceholder(', '\nconst wakeDormantMeetingMembers'), ctx);
  ctx.showDormantResumePlaceholder({ id: 'old', kind: 'codeagent', cwd: 'D:/fixture-work' }, null, { timedOut: true });
  await Promise.resolve();
  const panel = terminal.children[0], copy = panel.children[0];
  assert.equal(panel.children.length, 1, '超时不挂载转圈元素');
  assert.equal(copy.children[0].textContent, '唤醒没有完成');
  assert.equal(copy.children.length, 3, '说明收进 ⓘ');
  const [retry, history, fresh] = copy.children[2].children;
  assert.equal(retry.hidden, true); assert.equal(history.textContent, '查看已有历史');
  assert.equal(fresh.textContent, '在原目录新建会话');
  retry.click(); fresh.click();
  assert.equal(retried, undefined, '隐藏的重试不能触发旧请求等待');
  assert.equal(opened.kind, 'codeagent'); assert.equal(opened.workspace.path, 'D:/fixture-work');
});

function mainFixture(t, { auth, launch } = {}) {
  // 不启动真实 CLI；计数的是创建进程入口，并模拟运行表中的已有进程。
  t.mock.method(require('../core/session-store'), 'loadSessionFile', () => null);
  const live = new Map(), events = []; let creates = 0;
  const resume = createResumeSessionHandler({ fs, os, path, getHookPort: () => 0,
    isClaudeFamily: () => false, isCodexBaseKind: () => false, meetingManager: { getAllMeetings: () => [] },
    ensureLaunchAuth: auth, registerSessionForTap() {}, sendToRenderer: (name, payload) => events.push({ name, payload }),
    sessionManager: { getSession: id => live.get(id), async createSession(kind, opts) {
      creates++; if (launch) await launch();
      const session = { id: opts.id, kind, status: 'idle' }; live.set(opts.id, session); return session;
    } } });
  return { resume, live, events, get creates() { return creates; } };
}

test('主进程在认证和启动阶段都复用普通唤醒，普通重选已运行会话只接回', async t => {
  const auth = deferred(), launch = deferred();
  const f = mainFixture(t, { auth: () => auth.promise, launch: () => launch.promise });
  const meta = { hubId: 'main-wake', kind: 'powershell' };
  const first = f.resume(meta), duringAuth = f.resume(meta);
  assert.equal(first, duringAuth);
  auth.resolve();
  // 让认证继续到进程创建入口。
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.creates, 1);
  assert.equal(f.resume(meta), first);
  launch.resolve();
  const session = await first;
  assert.equal(await f.resume(meta), session);
  assert.equal(f.creates, 1);
  assert.equal(f.events.at(-1).name, 'session-created');
});

test('明确启动失败释放在途任务，下一次重试可重新启动', async t => {
  let attempt = 0;
  const f = mainFixture(t, { launch: () => { if (++attempt === 1) throw new Error('启动失败'); } });
  const meta = { hubId: 'retry-wake', kind: 'powershell' };
  await assert.rejects(f.resume(meta), /启动失败/);
  assert.equal((await f.resume(meta)).id, meta.hubId);
  assert.equal(f.creates, 2);
});
