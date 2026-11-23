'use strict';
// 新建会话结果判定：会话已建成时附属步骤没成只给一行提示；真没建成才报「创建失败」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const outcome = require('../renderer/session-create-outcome');

test('已建成 + 附属步骤失败：不说创建失败，说清哪一步没成、会话可用、下一步，并给按钮', () => {
  const session = { id: '69b166e2-0000-4000-8000-000000000000', kind: 'codeagent', cwd: 'D:\\AIWork\\task' };
  const error = new Error("Error invoking remote method 'create-session': Error: 公司模型暂时用不了：无法核实 CodeAgent 版本（SIGNER_VERSION）。\n第二行细节");
  const result = outcome.classifyCreateOutcome({ session, followup: { step: 'launch', error } });
  assert.equal(result.state, 'created-partial');
  assert.doesNotMatch(result.message, /创建失败/);
  assert.match(result.message, /^会话已建好，可以直接用；启动后的收尾步骤没成：公司模型暂时用不了/);
  assert.match(result.message, /重新启动模型通道/);
  assert.doesNotMatch(result.message, /\n|Error invoking/, '一行提示，去掉 IPC 前缀和多行细节');
  assert.deepEqual(result.actions, ['open-session', 'proxy-restart']);

  const remember = outcome.classifyCreateOutcome({ session, followup: { step: 'remember', error: new Error('QuotaExceededError') } });
  assert.equal(remember.state, 'created-partial');
  assert.match(remember.message, /记住本次的选择没成：QuotaExceededError。不影响使用/);
  assert.deepEqual(remember.actions, ['open-session']);

  assert.deepEqual(outcome.classifyCreateOutcome({ session }), { state: 'created', session, message: '', actions: [] });
});

test('真失败：没拿到会话才报创建失败', () => {
  const error = new Error("Error invoking remote method 'create-session': Error: 公司模型反代还没准备好");
  const result = outcome.classifyCreateOutcome({ error });
  assert.equal(result.state, 'failed');
  assert.equal(result.message, '创建失败：公司模型反代还没准备好');
  // 返回了东西但没有会话 ID，也不算建成。
  assert.equal(outcome.classifyCreateOutcome({ session: {}, error }).state, 'failed');
});

test('创建调用报错时，只认带本次请求标识的事件；并发建在同目录同种类的别的会话不算', () => {
  const mine = 'req-mine';
  const events = [
    // 同一时刻别的入口（群聊席位、快捷键、另一次点击）在同目录建的同种会话
    { session: { id: 'concurrent', kind: 'codeagent', cwd: 'D:/AIWork/task' } },
    { session: { id: 'other-request', kind: 'codeagent', cwd: 'D:/AIWork/task' }, createRequestId: 'req-other' },
  ];
  assert.equal(outcome.matchCreatedSession(events, mine), null, '真失败时不能被并发会话冒认成功');
  events.push({ session: { id: 'mine-sid', kind: 'codeagent', cwd: 'D:/AIWork/task' }, createRequestId: mine });
  events.push({ session: { id: 'later-concurrent', kind: 'codeagent', cwd: 'D:/AIWork/task' } });
  assert.equal(outcome.matchCreatedSession(events, mine).id, 'mine-sid');
  assert.equal(outcome.matchCreatedSession(events, ''), null);
  assert.equal(outcome.matchCreatedSession([{ createRequestId: mine, session: {} }], mine), null, '没有会话编号不算');
  const a = outcome.newCreateRequestId(), b = outcome.newCreateRequestId();
  assert.ok(a && b && a !== b);
  assert.ok(outcome.newCreateRequestId(null).startsWith('create-'));
});

function registerHandlers({ registerSessionForTap, createSession }) {
  const handlers = new Map(), sent = [], launched = [];
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { createSession: (kind, opts) => { launched.push(opts); return createSession(kind, opts); },
      getSession: () => null, getAllSessions: () => [], codeagentPoolActiveCounts: () => ({}) },
    sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
    ...(registerSessionForTap ? { registerSessionForTap } : {}),
  });
  return { create: arg => handlers.get('create-session')(null, arg), sent, launched };
}

test('主进程：Tap 内部登记异常被吞后仍带回提示；请求标识只随事件带回、不进会话参数', async () => {
  const { registerTranscriptTap } = require('../main/session-tap-register');
  const warnings = [];
  const transcriptTap = { registerSession: () => { throw new Error('watcher boom'); } };
  // 与 main.js registerSessionForTap 同一条实现：内部异常不抛出，改为返回没成的一步。
  const registerSessionForTap = session => registerTranscriptTap(transcriptTap, session, () => ({ cwd: session.cwd }),
    { warn: (...args) => warnings.push(args.join(' ')) });
  const session = { id: 'sid-1', kind: 'powershell', cwd: 'D:/w' };
  const env = registerHandlers({ registerSessionForTap, createSession: () => session });
  const result = await env.create({ kind: 'powershell', opts: { cwd: 'D:/w', createRequestId: 'req-1' } });
  assert.equal(result.id, 'sid-1');
  assert.deepEqual(result.createWarning, { step: 'tap', message: 'watcher boom' });
  assert.match(warnings[0], /registerSession failed for sid-1/);
  const event = env.sent.find(item => item.channel === 'session-created');
  assert.equal(event.payload.session, session);
  assert.equal(event.payload.createRequestId, 'req-1');
  assert.equal('createRequestId' in env.launched[0], false, '请求标识不交给会话本身');
  const text = outcome.classifyCreateOutcome({ session: result,
    followup: { step: result.createWarning.step, error: new Error(result.createWarning.message) } }).message;
  assert.match(text, /^会话已建好，可以直接用；对话记录接入没成：watcher boom。终端里照常可用/);

  // 组装登记参数时出错也算登记没成，不抛出。
  assert.deepEqual(registerTranscriptTap(transcriptTap, session, () => { throw new Error('bad path'); }, { warn() {} }),
    { ok: false, step: 'tap', message: 'bad path' });
  assert.deepEqual(registerTranscriptTap({ registerSession() {} }, session, {}, { warn() {} }), { ok: true });

  // 登记函数自己抛出（其他实现）也不让整次创建失败。
  const thrown = registerHandlers({ registerSessionForTap: () => { throw new Error('tap boom'); }, createSession: () => session });
  const original = console.warn; console.warn = () => {};
  try { assert.deepEqual((await thrown.create({ kind: 'powershell', opts: { cwd: 'D:/w' } })).createWarning, { step: 'tap', message: 'tap boom' }); }
  finally { console.warn = original; }
  assert.equal('createRequestId' in thrown.sent[0].payload, false);

  // 正常路径不带 createWarning，返回的就是原会话对象。
  const ok = registerHandlers({ registerSessionForTap: () => ({ ok: true }), createSession: () => session });
  assert.equal(await ok.create({ kind: 'powershell', opts: { cwd: 'D:/w' } }), session);
});

// 最小 DOM：只实现提示用到的接口。
function fakeDocument() {
  const byId = new Map();
  const make = tag => ({
    tagName: tag, children: [], style: {}, dataset: {}, attrs: {}, listeners: {}, parent: null, textContent: '', _id: '',
    get id() { return this._id; }, set id(v) { this._id = v; byId.set(v, this); },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
      this.parent = null;
      if (this._id && byId.get(this._id) === this) byId.delete(this._id);
    },
    fire(type) { return Promise.all((this.listeners[type] || []).map(fn => fn())); },
  });
  const body = make('body');
  return { body, createElement: make, getElementById: id => byId.get(id) || null };
}

test('提示：一次性一行轻提示，约 10 秒自动消失，按会话编号去重，按钮各管各的会话', async () => {
  const { showCreateFollowupToast, DEFAULT_MS } = require('../renderer/session-create-toast');
  assert.equal(DEFAULT_MS, 10000);
  const doc = fakeDocument(), timers = [], clicks = [];
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
  const clearTimer = t => { if (t) t.cleared = true; };
  const show = (sessionId, message, actions) => showCreateFollowupToast(doc, { sessionId, message, actions, setTimer, clearTimer,
    onAction: async (action, sid) => { clicks.push([action, sid]); } });
  const same = '会话已建好，可以直接用；对话记录接入没成：x。';
  const first = show('s1', same, ['open-session']);
  const stack = doc.getElementById('session-create-toast-stack');
  assert.equal(stack.children.length, 1);
  assert.equal(first.style.whiteSpace, 'nowrap', '一行显示');
  assert.equal(first.attrs.role, 'status');
  assert.deepEqual(first.children.map(c => c.textContent), [same, '打开会话']);
  assert.equal(timers.at(-1).ms, 10000);
  // 同文案、不同会话：各自一条，按钮操作各自的会话。
  const second = show('s2', same, ['open-session', 'proxy-restart']);
  assert.equal(stack.children.length, 2);
  assert.deepEqual(second.children.map(c => c.textContent), [same, '打开会话', '重新启动模型通道']);
  await second.children[1].fire('click');
  await first.children[1].fire('click');
  assert.deepEqual(clicks, [['open-session', 's2'], ['open-session', 's1']]);
  assert.equal(stack.children.length, 0, '点按钮成功后提示收起');
  // 同一会话再来一条：替换，不叠加。
  show('s3', '旧', ['open-session']);
  const replaced = show('s3', '新', ['open-session']);
  assert.equal(stack.children.length, 1);
  assert.equal(replaced.children[0].textContent, '新');
  // 悬停时不消失；移开后到时自动消失。
  await replaced.fire('mouseenter');
  assert.equal(replaced._hideTimer, null);
  await replaced.fire('mouseleave');
  replaced._hideTimer.fn();
  assert.equal(stack.children.length, 0);
  // 按钮操作失败：留着提示，按钮上写原因。
  const failing = showCreateFollowupToast(doc, { sessionId: 's4', message: 'm', actions: ['proxy-restart'], setTimer, clearTimer,
    onAction: async () => { throw new Error('没重启成功'); } });
  await failing.children[1].fire('click');
  assert.equal(stack.children.length, 1);
  assert.equal(failing.children[1].textContent, '没重启成功，点击重试');
  assert.equal(showCreateFollowupToast(doc, { sessionId: '', message: 'x' }), null);
});

test('界面接线：新建弹窗带请求标识，附属步骤失败走一次性提示而非常驻提示块', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/workspace-controller.js'), 'utf8');
  assert.match(src, /createOutcome\.matchCreatedSession\(createdEvents, createRequestId\)/);
  assert.match(src, /opts: \{ \.\.\.tuningOpts\(\), createRequestId \}/);
  assert.match(src, /ipcRenderer\.emit\('session-create-followup'/);
  assert.doesNotMatch(src, /setError\(`创建失败：/);
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  assert.match(renderer, /ipcRenderer\.on\('session-create-followup'[\s\S]{0,200}showCreateFollowupToast/);
  assert.doesNotMatch(renderer, /session-created-partial/);
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /registerTranscriptTap\(transcriptTap, session, \(\) => \(\{/);
  assert.match(main, /if \(!tap\.ok\) return tap;/);
});
