'use strict';
// 问一下卡死回归：计时与取消、队列恢复、真实 Windows 进程树退出。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { withDeadline, waitForProcess, cancelled } = require('../core/help-ask/request-lifecycle');
const { createAskAsideService, runAsk, registerAskAsideIpc } = require('../main/ask-aside/service');
const { createHelpAskEngine } = require('../core/help-ask/engine');
const { askCodexSide } = require('../core/ask-aside-codex');
const { runOnce } = require('../core/company-assistant/ppt-map-model');
const { DshCliSession } = require('../core/dsh-cli-session');
const CC = '11111111-1111-4111-8111-111111111111';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-timeout-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const hang = ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));

test('进程没有 close 事件也能取消：先完成进程树清理，再释放请求', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const controller = new AbortController(); let killed = false;
  const request = waitForProcess(child, { signal: controller.signal, kill: async () => { await tick(); killed = true; } });
  controller.abort(cancelled());
  await assert.rejects(request, /已取消/); assert.equal(killed, true);
  assert.equal(child.listenerCount('close'), 0); assert.equal(child.stdout.listenerCount('data'), 0);
});

test('空闲计时随新输出刷新；持续有输出也受总时限约束', async () => {
  let timer;
  await assert.rejects(withDeadline(({ signal, onActivity }) => {
    timer = setInterval(onActivity, 10); return hang({ signal });
  }, { timeoutMs: 150, idleMs: 70 }), error => error.timeoutKind === 'total');
  clearInterval(timer);
  await assert.rejects(withDeadline(hang, { timeoutMs: 500, idleMs: 30 }), error => error.timeoutKind === 'idle');
});

function service(t, options = {}) {
  const root = tmp(t);
  const svc = createAskAsideService({ sessionManager: { getSession: () => ({ kind: 'codeagent', cwd: root, ccSessionId: CC }) },
    getHubDataDir: () => root, resolveConfig: () => ({ command: 'codeagent', configDir: root }),
    hasHistory: () => true, idleMs: 30, timeoutMs: 500, cleanupMs: 50, ...options });
  t.after(() => svc.dispose()); return svc;
}

test('空闲超时自动继续同会话队列，底层确实收到 abort，保留超时原因', async t => {
  let firstSignal;
  const svc = service(t, { run: args => {
    if (args.question === '一') { firstSignal = args.signal; return hang(args); }
    return { answer: '第二题答案' };
  } });
  svc.ask({ sessionId: 's', question: '一' }); svc.ask({ sessionId: 's', question: '二' });
  await svc.drain();
  const items = svc.list('s').items;
  assert.equal(firstSignal.aborted, true); assert.equal(items[0].timedOut, true); assert.equal(items[0].timeoutKind, 'idle');
  assert.match(items[0].error, /无新输出/); assert.equal(items[1].status, 'done'); assert.equal(items[1].a, '第二题答案');
});

test('底层 Promise 不响应取消也不能堵队列；晚到的旧结果不覆盖终态', async t => {
  let release;
  const svc = service(t, { run: args => args.question === '一' ? new Promise(resolve => { release = resolve; }) : { answer: '第二题' } });
  const first = svc.ask({ sessionId: 's', question: '一' }); svc.ask({ sessionId: 's', question: '二' });
  await tick();
  assert.equal(svc.cancel({ sessionId: 'other', id: first.id }), false);
  assert.equal(svc.cancel({ sessionId: 's', id: first.id }), true);
  await svc.drain();
  release({ answer: '旧答案' }); await tick();
  assert.deepEqual(svc.list('s').items.map(item => [item.status, item.a]), [['error', ''], ['done', '第二题']]);
  assert.equal(svc.list('s').items[0].cancelled, true);
});

test('取消排队项不会启动它，后面的第三题自动继续；IPC 只传会话与问题编号', async t => {
  const seen = [];
  const svc = service(t, { run: args => { seen.push(args.question); return args.question === '一' ? hang(args) : { answer: args.question }; } });
  const first = svc.ask({ sessionId: 's', question: '一' }); const second = svc.ask({ sessionId: 's', question: '二' });
  svc.ask({ sessionId: 's', question: '三' }); await tick();
  const handlers = new Map(); registerAskAsideIpc({ handle: (name, fn) => handlers.set(name, fn) }, svc);
  const cancel = request => handlers.get('ask-aside:cancel')(null, request);
  assert.equal((await cancel({ sessionId: 's', id: second.id, context: '不能转发' })).result, true);
  await cancel({ sessionId: 's', id: first.id }); await svc.drain();
  assert.deepEqual(seen, ['一', '三']); assert.equal(svc.list('s').items[2].status, 'done');
});

test('问问 Hub 在 --help 探测中静默也超时，不再换引擎', async t => {
  let runs = 0;
  const engine = createHelpAskEngine({ dataDir: tmp(t), edition: 'public', env: {},
    findCommand: () => 'fixture-cli', runOnce: async args => { runs++; await hang(args); }, idleMs: 30, totalMs: 500 });
  const result = await engine.ask({ question: '设置在哪？' });
  assert.equal(result.timedOut, true); assert.equal(result.timeoutKind, 'idle'); assert.equal(runs, 1);
});

test('DSH 取消写入专用取消信号，清掉本地等待，不触碰主终端', async t => {
  const session = new DshCliSession({ home: tmp(t), id: 'x', launch: { args: [] } });
  t.after(() => session.dispose()); session.runtime.connection = 'connected'; session.threadId = 'thread';
  const controller = new AbortController(); const pending = session.askSide('问题', { signal: controller.signal });
  controller.abort(cancelled()); await assert.rejects(pending, /已取消/);
  assert.equal(session.sideAsks.size, 0); assert.equal(session.closed, false);
  assert.equal(fs.readdirSync(session.askDir).filter(name => name.endsWith('.ask.json')).length, 0);
  assert.equal(fs.readdirSync(session.askDir).filter(name => name.endsWith('.cancel.json')).length, 1);
});

test('DSH 观察插件收到取消文件后 abort 真实 HTTP 请求，不终止主会话', async t => {
  const http = require('node:http');
  const { pathToFileURL } = require('node:url');
  const dir = tmp(t), modules = path.join(dir, 'modules'), asks = path.join(dir, 'asks'), log = path.join(dir, 'events.jsonl');
  fs.mkdirSync(asks); fs.writeFileSync(log, '');
  const write = (rel, text) => { const file = path.join(modules, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write('@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/sideQuestion.js', [
    'exports.splitUnresolvedToolCalls = messages => ({messages,pending:[]});',
    'exports.openStepToolCallIds = () => [];', 'exports.wrapSideQuestion = text => text;',
    'exports.runAsSideBranch = (agents,agent,fn) => fn();',
    'exports.runSideQuestion = async ({stream,options}) => ({answer:await stream(options)});',
  ].join('\n'));
  write('@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/compat/liveSession.js', 'exports.snapshotLiveSessionEvents = () => [];');
  write('@deepseek-ai/dsh-llm/lib/index.js', 'exports.createUserMessage = message => ({role:"user",...message});');
  let connected, disconnected;
  const connection = new Promise(resolve => { connected = resolve; });
  const disconnection = new Promise(resolve => { disconnected = resolve; });
  const server = http.createServer((_req, res) => { connected(); res.on('close', disconnected); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { HOME: dir, AI_HUB_DSH_ASK_DIR: asks, AI_HUB_DSH_EVENT_LOG: log, AI_HUB_DSH_CLI_ENTRY: path.join(modules, '@deepseek-ai/dsh/lib/bin.js') };
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  fs.mkdirSync(path.join(dir, '.dsh-tui/inject'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.dsh-tui/inject/servers.json'), JSON.stringify([{ pid: process.pid, sessionId: 'root' }]));
  const agent = { id: 'root', status: 'running', options: {}, session: { id: 'root', header: {}, snapshotEvents: () => [], deriveMessages: () => [] } };
  const effects = [];
  const ctx = { agents: { get: () => agent, list: () => [agent] }, effect: fn => effects.push(fn()), on() {}, provide() {},
    get: () => ({ stream: async ({ signal }) => (await fetch(`http://127.0.0.1:${server.address().port}`, { signal })).text() }) };
  const observer = await import(pathToFileURL(path.resolve(__dirname, '../core/dsh-cli-observer.mjs')).href);
  observer.apply(ctx); t.after(() => effects.forEach(fn => fn()));
  await sleep(70);
  fs.writeFileSync(path.join(asks, CC + '.ask.json'), JSON.stringify({ id: CC, question: 'q' }));
  await Promise.race([connection, sleep(3000).then(() => { throw new Error('HTTP 未启动'); })]);
  fs.writeFileSync(path.join(asks, CC + '.cancel.json'), '{}');
  await Promise.race([disconnection, sleep(3000).then(() => { throw new Error('HTTP 未取消'); })]);
  assert.equal(agent.status, 'running');
});

// Windows 真实进程测试：覆盖 CodeAgent 的 cmd 包装、Codex 原生命令和问问 Hub 共用 runner。
for (const engine of ['codeagent', 'codex', 'help']) for (const stop of ['timeout', 'cancel']) {
  test(`${engine} ${stop}：真实子进程与孙进程全部退出`, { skip: process.platform !== 'win32' }, async t => {
    const dir = tmp(t), file = path.join(dir, 'hang.js'), pids = path.join(dir, 'pids.json');
    fs.writeFileSync(file, [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });",
      `require('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));`,
      'setInterval(()=>{},1000);',
    ].join('\n'));
    const wrapper = path.join(dir, 'codeagent.cmd');
    fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${file}" %*\r\n`);
    const controller = new AbortController();
    const timeoutMs = stop === 'timeout' ? 1500 : 20000;
    let running;
    if (engine === 'codeagent') running = runAsk({ config: { command: wrapper, configDir: dir }, cwd: dir, ccSessionId: CC, question: 'q', signal: controller.signal, timeoutMs });
    else if (engine === 'codex') running = askCodexSide({ session: { codexSid: CC, cwd: dir }, question: 'q', signal: controller.signal, timeoutMs,
      resolveCommand: env => ({ command: process.execPath, args: [file], env }), tmpRoot: dir });
    else running = runOnce({ command: process.execPath, args: [file], cwd: dir, env: process.env, signal: controller.signal, timeoutMs });
    // 在等待启动时就绑定 rejection，避免取消与测试继续之间出现未处理的拒绝。
    const settled = running.then(value => ({ value }), error => ({ error }));
    for (let i = 0; i < 100 && !fs.existsSync(pids); i++) await sleep(20);
    assert.equal(fs.existsSync(pids), true, '真实 CLI 已启动');
    const ids = JSON.parse(fs.readFileSync(pids, 'utf8'));
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    t.after(() => { for (const pid of ids) if (alive(pid)) process.kill(pid, 'SIGKILL'); });
    if (stop === 'cancel') controller.abort(cancelled());
    const result = await settled;
    if (engine === 'help') {
      assert.equal(result.value[stop === 'timeout' ? 'timedOut' : 'aborted'], true);
      if (stop === 'timeout') assert.equal(result.value.aborted, false, '自身超时不能被库地图等调用方误判成用户取消');
    }
    else assert.equal(result.error[stop === 'timeout' ? 'timedOut' : 'cancelled'], true);
    for (let i = 0; i < 100 && ids.some(alive); i++) await sleep(20);
    assert.deepEqual(ids.map(alive), [false, false]);
  });
}
