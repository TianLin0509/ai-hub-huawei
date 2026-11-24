'use strict';
// CodeAgent-Lite 护栏（2026-11-24）：serve 起不来或连续断线时无感改回终端方式 + 账号冷却；8 项互动功能一键全切 Lite / 还原。
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fallback = require('../core/codeagent-serve-fallback');
const { CodeAgentServeSession, SERVE_HANDOVER } = require('../core/codeagent-serve-session');
const { SessionManager } = require('../core/session-manager');
const { AcpSession } = require('../core/acp-session');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test.beforeEach(() => fallback.resetForTest());

// ---------------------------------------------------------------- 冷却账本
test('冷却账本：按规范化 configDir 记账，到期自动解除，成功后清除', () => {
  let now = 1_000;
  const opts = { now: () => now, cooldownMs: 60_000 };
  assert.deepEqual(fallback.isCoolingDown('C:/A', opts), { cooling: false, reason: '', until: 0, count: 0 });
  fallback.recordFailure('C:/Users/X/.cac', '不支持 serve', opts);
  // 大小写、斜杠不同也是同一个账号
  const hit = fallback.isCoolingDown('c:\\users\\x\\.CAC', opts);
  assert.equal(hit.cooling, true);
  assert.equal(hit.reason, '不支持 serve');
  assert.equal(hit.until, 61_000);
  assert.equal(hit.count, 1);
  fallback.recordFailure('C:/Users/X/.cac', '启动超时', opts);
  assert.equal(fallback.isCoolingDown('C:/Users/X/.cac', opts).count, 2);
  // 其他账号不受影响；空目录记在 default
  assert.equal(fallback.isCoolingDown('C:/Users/Y/.cac', opts).cooling, false);
  fallback.recordFailure('', 'x', opts);
  assert.equal(fallback.isCoolingDown(undefined, opts).cooling, true);
  assert.equal(fallback.keyOf(''), 'default');
  now = 61_000;
  assert.equal(fallback.isCoolingDown('C:/Users/X/.cac', opts).cooling, false, '到期解除');
  assert.equal(fallback.status({ now: () => 0 }).length, 2);
  assert.equal(fallback.clearCooldown('C:/Users/X/.cac'), true);
  assert.equal(fallback.status().length, 1);
  assert.equal(fallback.COOLDOWN_MS, 30 * 60_000);
});

test('冷却短路：冷却中隐式 serve（低开销 L2 / 功能会话）改走终端；显式点 Lite 允许试连；不冷却原样返回', () => {
  const dir = 'C:/acct';
  const l2 = { codeagentRunMode: 'serve', lowOverheadServe: true, title: 't' };
  const feature = { codeagentRunMode: 'serve', codeagentLiteFeature: true, purpose: 'company-assistant' };
  const explicit = { codeagentRunMode: 'serve', explicitCodeagentLite: true };
  assert.equal(fallback.routeAroundCooldown(l2, dir).opts, l2, '不冷却时同一对象');
  fallback.recordFailure(dir, 'serve 启动超时');
  const a = fallback.routeAroundCooldown(l2, dir);
  assert.equal(a.reason, 'serve 启动超时');
  assert.equal(a.opts.codeagentRunMode, 'pty');
  assert.equal('lowOverheadServe' in a.opts, false);
  assert.equal(a.opts.title, 't');
  assert.equal(l2.codeagentRunMode, 'serve', '不改调用方对象');
  const b = fallback.routeAroundCooldown(feature, dir);
  assert.equal(b.opts.codeagentRunMode, 'pty');
  assert.equal('codeagentLiteFeature' in b.opts, false);
  assert.equal(require('../core/codeagent-run-mode').usesServeRuntime('codeagent', b.opts), false, '改道后不再走 serve');
  const c = fallback.routeAroundCooldown(explicit, dir);
  assert.equal(c.reason, '');
  assert.equal(c.opts, explicit, '用户亲手点 Lite：照常试连');
});

test('session-manager 接线：冷却短路在选号之后、决定走不走 serve 之前；转发 serve-fallback 前同步挂过渡态', () => {
  const src = read('core/session-manager.js');
  const accountIdx = src.indexOf('const launchAccount = this._resolveCodeAgentLaunchAccount(kind, opts, { id, freshLaunch });');
  // 拼接写法：公开版构建会把测试里的相对 require 字面量当成依赖去解析。
  const serveIdx = src.indexOf('const isCodeAgentServe = ' + 'require(' + "'./codeagent-run-mode').usesServeRuntime(kind, opts)");
  assert.ok(accountIdx > 0 && serveIdx > accountIdx, '账号与冷却先定，再决定是否走 serve');
  const method = src.slice(src.indexOf('  _resolveCodeAgentLaunchAccount(kind, opts'), src.indexOf('  _resolveCodeAgentPool(opts, personalConfig) {'));
  assert.ok(method.indexOf('this._resolveCodeAgentPool(') < method.indexOf('routeAroundCooldown(opts, codeagentConfig?.configDir)'), '先选号再查冷却');
  assert.match(src, /\.\.\.\(codeagentServeFallbackReason \? \{ codeagentServeFallbackReason \} : \{\}\)/);
  assert.match(src, /this\._beginServeFallback\(id, info\);\n\s+this\.emit\('codeagent-serve-fallback'/);
  assert.match(src, /\.\.\.\(isCodeAgentServe \? \{ serveLaunchOpts \} : \{\}\)/);
});

test('启动中心：低开销 L2 隐式 serve 带 lowOverheadServe，点 Lite 入口带 explicitCodeagentLite', () => {
  const src = read('renderer/workspace-controller.js');
  assert.match(src, /opts\.codeagentRunMode === 'serve' && !codeagentLite && codeagentRunMode !== 'serve'\) opts\.lowOverheadServe = true;/);
  assert.match(src, /if \(selectedKind === 'codeagent' && codeagentLite\) opts\.explicitCodeagentLite = true;/);
});

// ---------------------------------------------------------------- serve 会话：启动失败 / 运行中断线
function liteSession(t, host, extra = {}) {
  const storeDir = tmp('lite-guard-');
  const session = new CodeAgentServeSession({ id: 'hub-g', kind: 'codeagent', cwd: storeDir, host, model: 'm1', provider: 'w3',
    recoverDelayMs: 5, permissionMode: 'default', profileId: 'codeagent-serve', storeDir, launch: { env: {} }, spawnTerminal: () => null, ...extra });
  session.on('action-error', () => {});
  t.after(() => { try { session.kill(); } catch {} try { fs.rmSync(storeDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 句柄稍后释放 */ } });
  return session;
}
const fakeHost = (configDir, ensure = async () => {}) => Object.assign(new EventEmitter(), { configDir, url: 'http://127.0.0.1:1', token: 'x', released: 0,
  ensure, release() { this.released += 1; } });
const brokenHost = (message, configDir = 'C:/acct-broken') => fakeHost(configDir, async () => { throw new Error(message); });

test('首次启动失败（无 threadId）：记冷却、发 startup 回退；send 报「改道中、未发送」，不假装已排队；start 照原样抛错', async t => {
  const host = brokenHost('unknown command "serve"');
  const session = liteSession(t, host);
  const events = [];
  session.on('serve-fallback', event => events.push(event));
  const error = await session.send('帮我总结一下').then(() => null, e => e);
  assert.equal(error?.code, SERVE_HANDOVER);
  assert.equal(error.notSent, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, 'startup');
  assert.equal(events[0].hasThread, false);
  assert.match(events[0].reason, /serve/);
  assert.deepEqual(events[0].pendingPrompts, []);
  const cooling = fallback.isCoolingDown('C:/acct-broken');
  assert.equal(cooling.cooling, true);
  assert.match(cooling.reason, /serve/);
  await assert.rejects(session.start(), /unknown command "serve"/, '直接调用方仍拿到原错误');
  // 回退后再发（秒败竞态）：绝不落回已失败的 serve，同样报改道中
  const again = await session.send('第二句').then(() => null, e => e);
  assert.equal(again?.code, SERVE_HANDOVER);
  assert.equal(events.length, 1, '同一会话只回退一次');
  assert.equal(fallback.isCoolingDown('C:/acct-broken').count, 1);
});

test('已绑定 resumeId 的会话启动失败：hasThread 如实为真，send 只报未发送（notSent），不虚报已排队', async t => {
  const session = liteSession(t, brokenHost('ServeHost 启动超时', 'C:/acct-2'), { resumeId: 'thread-old' });
  const events = [];
  session.on('serve-fallback', event => events.push(event));
  const error = await session.send('继续').then(() => null, e => e);
  assert.equal(error.notSent, true);
  assert.equal(error.code, SERVE_HANDOVER);
  assert.equal(events[0].hasThread, true);
  const other = liteSession(t, brokenHost('端口被策略拦截', 'C:/acct-3'));
  other.on('serve-fallback', () => {});
  await assert.rejects(other.start(), /端口被策略拦截/);
});

test('已关闭的会话启动失败不回退、不记冷却', async t => {
  const session = liteSession(t, brokenHost('boom', 'C:/acct-closed'));
  let fired = 0;
  session.on('serve-fallback', () => { fired += 1; });
  session.closed = true;
  await assert.rejects(session._start(), /boom/);
  assert.equal(fired, 0);
  assert.equal(fallback.isCoolingDown('C:/acct-closed').cooling, false);
});

test('启动成功后清除该账号冷却（显式点 Lite 试连成功）', async t => {
  fallback.recordFailure('C:/acct-ok', '上次启动超时');
  t.mock.method(AcpSession.prototype, '_start', async function () { return { ok: true }; });
  const session = liteSession(t, fakeHost('C:/acct-ok'));
  await session.start();
  assert.equal(fallback.isCoolingDown('C:/acct-ok').cooling, false);
  assert.equal(session.everConnected, true);
});

test('运行中连续断线超过 3 次：发 runtime 回退并记冷却，带上未发送的排队消息', async t => {
  const session = liteSession(t, fakeHost('C:/acct-rt'));
  const client = { closed: false, markUnknown() { throw new Error('不该走到'); } };
  session.client = client;
  session.threadId = 'thread-1';
  session.promptQueue.records = [{ id: 'q1', text: '排队中的消息', status: 'held' }];
  session.promptQueue.save = () => {};
  const event = new Promise(resolve => session.once('serve-fallback', resolve));
  session.failures = [Date.now(), Date.now(), Date.now()];
  await session.recover(client, new Error('事件流断开'));
  const e = await event;
  assert.equal(e.phase, 'runtime');
  assert.equal(e.hasThread, true);
  assert.equal(e.reason, '事件流断开');
  assert.deepEqual(e.pendingPrompts, [{ id: 'q1', text: '排队中的消息' }]);
  const cooling = fallback.isCoolingDown('C:/acct-rt');
  assert.equal(cooling.cooling, true);
  assert.equal(cooling.reason, '事件流断开');
});

// ---------------------------------------------------------------- 主进程：改回终端（真实 SessionManager 过渡态 + 真实 session-handlers）
async function untilTrue(check, label, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('等待超时：' + label);
}
// 真实 SessionManager：只替换「结束进程」「建会话」「落盘元数据」三处外部动作。
function realManager({ exitDelayMs = 10, onCreate = null } = {}) {
  const manager = new SessionManager();
  const created = [], suspended = [];
  manager._terminateWithTreeSweep = (id, entry) => {
    try { entry.pty?.kill?.(); } catch { /* 已退出 */ }
    setTimeout(() => { if (manager.sessions.get(id) === entry) { manager.sessions.delete(id); suspended.push(id); } }, exitDelayMs);
    return true;
  };
  manager.updateSessionMeta = (id, fields) => { const e = manager.sessions.get(id); if (e) Object.assign(e.info, fields); return e?.info; };
  manager.ensureSessionModelReady = async () => {};
  manager.createSession = (kind, opts) => {
    created.push({ kind, opts });
    const native = { delivered: [], isCliProvider: false, async send(text, o) { native.delivered.push({ text, o }); return { ok: true, sendStatus: 'ok', mode: 'pty' }; } };
    const info = { id: opts.id, kind, cwd: opts.cwd, title: opts.title, ccSessionId: 'pty-native-1', runtimeBackend: 'acp', codeagentRunMode: 'pty' };
    manager.sessions.set(opts.id, { info, pty: native, pendingTimers: [] });
    onCreate?.(native);
    return { ...info };
  };
  return { manager, created, suspended };
}
function liteEntry(manager, id, { serve = null, info = {}, launchOpts = null } = {}) {
  const base = { id, kind: 'codeagent', cwd: 'D:/w', title: 'Lite', runtimeBackend: 'acp', acpCapabilities: {}, codeagentRunMode: 'serve', codeagentLiteFeature: true, ...info };
  const pty = serve || { kill() {} };
  manager.sessions.set(id, { info: base, pty, pendingTimers: [], ...(launchOpts ? { serveLaunchOpts: launchOpts } : {}) });
  // 与 _createSession 的转发一致：同步挂过渡态，再发事件。
  serve?.on('serve-fallback', event => {
    manager._beginServeFallback(id, base);
    manager.emit('codeagent-serve-fallback', { sessionId: id, reason: event.reason, phase: event.phase, hasThread: event.hasThread, pendingPrompts: event.pendingPrompts, configDir: '' });
  });
  return base;
}
function registerHandlers(manager, { resumeSession = null } = {}) {
  const sent = [];
  require('../main/ipc/session-handlers').registerSessionIpc({ handle() {}, on() {} }, {
    sessionManager: manager, sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
    ...(resumeSession ? { resumeSession } : {}),
  });
  return sent;
}

test('首轮未建原生会话就回退：不报 native-session-id-missing；同一会话 ID、原参数（去掉打开预约）原地改建 PTY，界面不收「会话被删除」', async () => {
  const { manager, created, suspended } = realManager();
  const launchOpts = { cwd: 'D:/w', title: '助理', model: 'm1', fixedModel: 'm1', permissionMode: 'default', purpose: 'company-assistant', featureAgent: 'assistant',
    featureAgentChoice: '{"kind":"codeagent-lite"}', autonomous: true, noInheritCursor: true, addDirs: ['D:/x'], workspaceLabel: 'W', pinned: true,
    codeagentPoolAccount: 'pool-a', codeagentRunMode: 'serve', codeagentLiteFeature: true, mcpConfigFile: 'D:/mcp.json', appendSystemPromptFile: 'D:/sys.md', _openLeaseNonce: 'nonce-1' };
  const info = liteEntry(manager, 'lite-1', { launchOpts });
  const sent = registerHandlers(manager);
  manager._beginServeFallback('lite-1', info);
  manager.emit('codeagent-serve-fallback', { sessionId: 'lite-1', reason: 'unknown command "serve"', phase: 'startup', hasThread: false, pendingPrompts: [] });
  await untilTrue(() => sent.some(s => s.channel === 'session-notice'), '回执');
  assert.deepEqual(suspended, ['lite-1'], '旧对象按休眠收尾');
  assert.equal(created.length, 1);
  const { kind, opts } = created[0];
  assert.equal(kind, 'codeagent');
  assert.equal(opts.id, 'lite-1', '同一会话 ID');
  assert.equal(opts.codeagentRunMode, 'pty');
  assert.equal('codeagentLiteFeature' in opts, false);
  assert.equal('_openLeaseNonce' in opts, false, '打开预约不带进改建');
  assert.equal(opts.openInBackground, true, '后台接上，不抢焦点');
  for (const key of ['cwd', 'model', 'fixedModel', 'permissionMode', 'purpose', 'featureAgent', 'featureAgentChoice', 'autonomous', 'noInheritCursor',
    'addDirs', 'workspaceLabel', 'pinned', 'codeagentPoolAccount', 'mcpConfigFile', 'appendSystemPromptFile']) assert.deepEqual(opts[key], launchOpts[key], key);
  assert.equal(opts.title, 'Lite', '标题沿用会话当前显示的（用户可能改过名）');
  assert.ok(sent.some(s => s.channel === 'session-created' && s.payload.session.id === 'lite-1'));
  assert.equal(sent.some(s => s.channel === 'session-closed'), false, '不广播销毁');
  const notice = sent.find(s => s.channel === 'session-notice').payload;
  assert.equal(notice.message, 'CodeAgent 轻享服务暂不可用，已自动改用终端方式继续');
  assert.equal(notice.persistent, false);
  assert.equal(notice.noticeKind, 'auto', '隐式改道按提示闸门静默（只进日志）');
  assert.equal(manager.serveFallbackPending('lite-1'), false, '收尾后过渡态清掉');
});

test('用户亲手点的 Lite 回退给一行回执；运行中回退有待发消息时如实报数', async () => {
  const { manager } = realManager();
  const info = liteEntry(manager, 'lite-2', { launchOpts: { cwd: 'D:/w', explicitCodeagentLite: true, codeagentRunMode: 'serve' } });
  const sent = registerHandlers(manager);
  manager._beginServeFallback('lite-2', info);
  manager.emit('codeagent-serve-fallback', { sessionId: 'lite-2', reason: '启动超时', phase: 'startup', hasThread: false, pendingPrompts: [] });
  await untilTrue(() => sent.some(s => s.channel === 'session-notice'), '回执');
  const notice = sent.find(s => s.channel === 'session-notice').payload;
  assert.equal(notice.noticeKind, 'user-action');
  assert.equal(notice.message, 'CodeAgent 轻享服务暂不可用，已自动改用终端方式继续');
});

test('已绑定原生会话 ID 的运行中回退：按原历史休眠后恢复成 PTY，清掉 Lite 标记，待发消息如实报数', async () => {
  const { manager, created } = realManager();
  manager.suspendSession = (id) => { setTimeout(() => manager.sessions.delete(id), 5); return { ok: true }; };
  let resumed = null;
  liteEntry(manager, 'lite-3', { info: { acpSid: 'thread-9', ccSessionId: 'thread-9', acpCapabilities: { loadSession: true } } });
  const sent = registerHandlers(manager, { resumeSession: meta => { resumed = meta; return { id: meta.hubId, ok: true }; } });
  manager._beginServeFallback('lite-3', manager.sessions.get('lite-3').info);
  manager.emit('codeagent-serve-fallback', { sessionId: 'lite-3', reason: '事件流断开', phase: 'runtime', hasThread: true, pendingPrompts: [{ id: 'q', text: '排队' }] });
  await untilTrue(() => sent.some(s => s.channel === 'session-notice'), '回执');
  assert.equal(created.length, 0, '不新建空会话');
  assert.equal(resumed.codeagentRunMode, 'pty');
  assert.equal(resumed.codeagentLiteFeature, undefined, '恢复参数里不再带 Lite 标记，不会重入 serve');
  const notice = sent.find(s => s.channel === 'session-notice').payload;
  assert.match(notice.message, /已自动改用终端方式继续；有 1 条待发消息未自动发送/);
  assert.equal(notice.noticeKind, 'user-action');
});

// ---------------------------------------------------------------- 真实发送链路：group-chat-watcher.sendToPty + hub-memory-service
function realChain(t, { hostDelayMs = 0, exitDelayMs = 10 } = {}) {
  const dataDir = tmp('lite-chain-');
  const cwd = tmp('lite-chain-cwd-');
  t.after(() => { for (const d of [dataDir, cwd]) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 句柄稍后释放 */ } });
  let newNative = null;
  const { manager, created } = realManager({ exitDelayMs, onCreate: native => { newNative = native; } });
  const host = fakeHost('C:/acct-chain', async () => { if (hostDelayMs) await new Promise(r => setTimeout(r, hostDelayMs)); throw new Error('unknown command "serve"'); });
  const serve = liteSession(t, host, { id: 'chain-1', cwd });
  liteEntry(manager, 'chain-1', { serve, info: { cwd, nativeRuntime: serve.runtime }, launchOpts: { cwd, title: 'Lite', codeagentRunMode: 'serve' } });
  registerHandlers(manager);
  t.mock.method(require('../core/memory-rule-files'), 'sharedWorkspaceRules', () => [{ path: path.join(cwd, 'AGENTS.md'), content: '工作区规则正文' }]);
  const { HubMemoryService } = require('../core/hub-memory-service');
  const memory = new HubMemoryService({ dataDir, sessionManager: manager, homeDir: cwd, logger: { error() {}, warn() {}, log() {} },
    hubRules: { injection: () => ({ content: '通用规则正文', version: 'v1', label: '通用规则' }) } });
  const watcher = require('../core/group-chat-watcher');
  watcher.init({ sessionManager: manager });
  const receipts = kind => fs.readdirSync(path.join(dataDir, 'memory', 'context')).map(f => JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'context', f), 'utf8')))
    .flat().filter(r => r.kind === kind);
  return { manager, created, serve, memory, watcher, receipts, native: () => newNative };
}
const count = (text, needle) => text.split(needle).length - 1;

test('真实链路：发第一句时 serve 起不来 → 等改建完成后用原文、新编号重发到终端，规则各一份，不报会话/指纹/提交编号冲突', async t => {
  const chain = realChain(t);
  const result = await chain.watcher.sendToPty('chain-1', '帮我总结一下', 'codeagent', { clientSubmissionId: 'c1' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const delivered = chain.native().delivered;
  assert.equal(delivered.length, 1, '只发一次');
  const text = delivered[0].text;
  assert.equal(count(text, '<ai-hub-rules '), 1, '通用规则只一份');
  assert.equal(count(text, '<ai-hub-workspace-rules '), 1, '工作区规则只一份');
  assert.ok(text.endsWith('帮我总结一下'));
  assert.equal(delivered[0].o.clientSubmissionId, 'c1-pty', '新提交编号，避开旧会话的回执与去重记录');
  assert.equal(chain.created.length, 1);
  // 旧会话（serve）那份规则回执标为失败，新会话按新身份重新登记
  const hub = chain.receipts('hub-rules');
  assert.deepEqual(hub.map(r => [r.id, r.status]).sort(), [['hubrules-c1', 'failed'], ['hubrules-c1-pty', 'unconfirmed']]);
  assert.notEqual(hub.find(r => r.id === 'hubrules-c1').identity, hub.find(r => r.id === 'hubrules-c1-pty').identity);
  const ws = chain.receipts('workspace');
  assert.deepEqual(ws.map(r => [r.id, r.status]).sort(), [['workspace-c1', 'failed'], ['workspace-c1-pty', 'unconfirmed']]);
});

test('真实链路·秒败竞态：启动刚失败就有后台功能发消息，不落回失败的 serve，等改建后送达新终端', async t => {
  const chain = realChain(t, { exitDelayMs: 40 });
  await chain.serve.start().catch(() => {}); // 会话建好后的微任务启动就失败
  assert.equal(chain.manager.serveFallbackPending('chain-1'), true);
  const gaps = [];
  const poll = setInterval(() => { if (!chain.manager.getSession('chain-1')) gaps.push(Date.now()); }, 2);
  const result = await chain.watcher.sendToPty('chain-1', '后台任务', 'codeagent', { clientSubmissionId: 'job-1' });
  clearInterval(poll);
  assert.equal(result.ok, true);
  assert.equal(gaps.length, 0, '过渡期间 getSession 一直有值，后台轮询不会误判会话已关');
  assert.equal(chain.native().delivered.length, 1);
  assert.ok(chain.native().delivered[0].text.endsWith('后台任务'));
  assert.equal(count(chain.native().delivered[0].text, '<ai-hub-rules '), 1);
});

test('真实链路·慢败空窗：改建期间 getSession 不为空（带过渡标记），最终补发成功', async t => {
  const chain = realChain(t, { hostDelayMs: 30, exitDelayMs: 60 });
  const seen = [];
  const poll = setInterval(() => { const s = chain.manager.getSession('chain-1'); seen.push(s ? (s.serveFallbackPending ? 'transit' : 'live') : 'missing'); }, 2);
  // 旧对象已退出、新终端会话正要建的那一刻（空窗正中）必然是过渡态：在建会话入口确定性地看一眼。
  const create = chain.manager.createSession;
  chain.manager.createSession = (kind, opts) => {
    const s = chain.manager.getSession(opts.id);
    seen.push(s ? (s.serveFallbackPending ? 'transit' : 'live') : 'missing');
    assert.equal(chain.manager.hasLiveSession(opts.id), false, '旧对象确已退出');
    return create(kind, opts);
  };
  const result = await chain.watcher.sendToPty('chain-1', '慢慢失败', 'codeagent', { clientSubmissionId: 'slow-1' });
  clearInterval(poll);
  assert.equal(result.ok, true);
  assert.equal(seen.includes('missing'), false, '从头到尾没有断档');
  assert.ok(seen.includes('transit'), '确实经历了过渡态');
  assert.equal(chain.native().delivered.length, 1);
});

test('冷却按最终生效的账号目录：号池 A 冷却只拦 A，不拦健康的 B；个人号冷却不误拦号池 B', () => {
  const manager = new SessionManager();
  let pick = 'A';
  manager._resolveCodeAgentPool = () => ({ account: { id: pick, dir: `C:/pool/${pick}`, models: [] }, model: '' });
  const base = { codeagentAccount: 'pool', codeagentRunMode: 'serve', codeagentLiteFeature: true, purpose: 'company-text', _openLeaseNonce: 'n1' };
  fallback.recordFailure('C:/pool/A', 'A 的 serve 起不来');
  let r = manager._resolveCodeAgentLaunchAccount('codeagent', base, { id: 'x' });
  assert.equal(r.codeagentConfig.configDir, 'C:/pool/A');
  assert.equal(r.serveFallbackReason, 'A 的 serve 起不来');
  assert.equal(r.opts.codeagentRunMode, 'pty');
  assert.equal(r.serveLaunchOpts.codeagentPoolAccount, 'A', '改建时回到同一个号');
  assert.equal('_openLeaseNonce' in r.serveLaunchOpts, false, '留存的启动参数不带打开预约');
  pick = 'B';
  r = manager._resolveCodeAgentLaunchAccount('codeagent', base, { id: 'y' });
  assert.equal(r.serveFallbackReason, '', '健康的 B 照常走 serve');
  assert.equal(r.opts.codeagentRunMode, 'serve');
  fallback.resetForTest();
  fallback.recordFailure(require('../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir, '个人号坏了');
  r = manager._resolveCodeAgentLaunchAccount('codeagent', base, { id: 'z' });
  assert.equal(r.serveFallbackReason, '', '个人号冷却不误拦号池 B');
  const personal = manager._resolveCodeAgentLaunchAccount('codeagent', { codeagentRunMode: 'serve', lowOverheadServe: true }, { id: 'p' });
  assert.equal(personal.serveFallbackReason, '个人号坏了', '个人号会话照常被拦');
  assert.equal('lowOverheadServe' in personal.opts, false);
  const explicit = manager._resolveCodeAgentLaunchAccount('codeagent', { codeagentRunMode: 'serve', explicitCodeagentLite: true }, { id: 'e' });
  assert.equal(explicit.serveFallbackReason, '', '亲手点 Lite 允许试连');
});

test('一键全切 Lite 后助理 / 分身仍继承助理设置的模型与供应商（功能选型只换后端、没指定模型）', () => {
  const choice = require('../core/feature-agent-choice');
  assert.equal(choice.inheritsAssistantChoice(''), true);
  assert.equal(choice.inheritsAssistantChoice('{"kind":"codeagent-lite","model":""}'), true);
  assert.equal(choice.inheritsAssistantChoice('{"kind":"codeagent","model":""}'), true);
  assert.equal(choice.inheritsAssistantChoice('{"kind":"codeagent-lite","model":"m2"}'), false, '单独指定了模型的以功能选型为准');
  assert.equal(choice.inheritsAssistantChoice('{"kind":"codeagent-lite","model":"","codeagentModelProvider":"w3"}'), false);
  assert.equal(choice.inheritsAssistantChoice('{"kind":"api-gateway","model":""}'), false);
  assert.equal(choice.inheritsAssistantChoice('坏的'), false);
  assert.match(read('core/session-manager.js'), /\['company-assistant', 'avatar-agent'\]\.includes\(opts\.purpose\) && require\('\.\/feature-agent-choice'\)\.inheritsAssistantChoice\(opts\.featureAgentChoice\)/);
  assert.match(read('core/company-assistant/service.js'), /if \(!require\('\.\.\/feature-agent-choice'\)\.inheritsAssistantChoice\(info\.featureAgentChoice\)\) return false;/);
  assert.match(read('core/avatar/agent-session.js'), /inheritsAssistantChoice\(meta\?\.featureAgentChoice\) \|\| routes\.matchesSession\(meta, route\)/);
});

// ---------------------------------------------------------------- 一键预设
function presetEnv(t) {
  const dataDir = tmp('fa-preset-');
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 句柄稍后释放 */ } });
  return dataDir;
}
const models = [{ id: 'm1', label: 'm1', provider: 'w3' }, { id: 'm2', label: 'm2', provider: 'w3' }];
const backends = (liteAvailable = true) => [
  { kind: 'codeagent', label: 'CodeAgent', available: liteAvailable, defaultModel: '', models },
  { kind: 'codeagent-lite', label: 'CodeAgent-Lite（省内存）', available: liteAvailable, defaultModel: '', models },
  { kind: 'claude', label: 'Claude', available: true, defaultModel: '', models: [] },
  { kind: 'api-gateway', label: '部门 API key（网关）', available: true, defaultModel: 'g1', models: [{ id: 'g1', label: 'g1' }] },
];

test('一键全切 Lite：默认与 CodeAgent 的切到 Lite 并保留原模型/供应商，部门 API key 不动；还原只还原 Lite', t => {
  const dataDir = presetEnv(t);
  const choice = require('../core/feature-agent-choice');
  const routes = require('../core/codeagent-assistant-route');
  const ids = choice.FEATURES.filter(f => f.kinds.includes('codeagent-lite')).map(f => f.id);
  assert.deepEqual(ids.sort(), ['assistant', 'avatar', 'forum', 'meeting', 'ppt', 'pptImgtext', 'pptMake', 'text'].sort());
  routes.setFeaturePreference(dataDir, 'assistant', { kind: 'api-gateway', model: 'g1' });
  routes.setFeaturePreference(dataDir, 'ppt', { kind: 'codeagent', model: 'm2', codeagentModelProvider: 'w3', codeagentModelProviderLabel: 'W3', codeagentModelMenuLabel: 'm2 · W3' });
  routes.setFeaturePreference(dataDir, 'help', { kind: 'claude', model: '' });
  const opts = { backends: backends() };
  const res = choice.applyPreset(dataDir, 'codeagent-lite', opts);
  assert.equal(res.ok, true);
  assert.equal(res.preset, 'codeagent-lite');
  assert.deepEqual(res.skipped, ['assistant']);
  assert.equal(res.changed.length, 7);
  assert.ok(!res.changed.includes('assistant'));
  assert.deepEqual(routes.featurePreference(dataDir, 'assistant'), { kind: 'api-gateway', model: 'g1' }, '部门 API key 不覆盖');
  assert.deepEqual(routes.featurePreference(dataDir, 'ppt'), { kind: 'codeagent-lite', model: 'm2', codeagentModelProvider: 'w3', codeagentModelProviderLabel: 'W3', codeagentModelMenuLabel: 'm2 · W3' }, '保留 CodeAgent 原模型与供应商');
  assert.deepEqual(routes.featurePreference(dataDir, 'forum'), { kind: 'codeagent-lite', model: '' });
  assert.deepEqual(routes.featurePreference(dataDir, 'help'), { kind: 'claude', model: '' }, '单次功能不动');
  assert.equal(res.state.features.find(f => f.id === 'ppt').selected.kind, 'codeagent-lite');
  // 再切一次：没有可切的
  const again = choice.applyPreset(dataDir, 'codeagent-lite', opts);
  assert.deepEqual(again.changed, []);
  assert.deepEqual(again.skipped, ['assistant']);
  // 还原：只把 Lite 恢复默认
  const reset = choice.applyPreset(dataDir, 'reset-lite', opts);
  assert.equal(reset.changed.length, 7);
  assert.deepEqual(reset.skipped, []);
  assert.equal(routes.featurePreference(dataDir, 'ppt'), null, '还原为默认（不是还原成 CodeAgent）');
  assert.equal(routes.featurePreference(dataDir, 'forum'), null);
  assert.deepEqual(routes.featurePreference(dataDir, 'assistant'), { kind: 'api-gateway', model: 'g1' });
  assert.deepEqual(routes.featurePreference(dataDir, 'help'), { kind: 'claude', model: '' });
});

test('一键全切 Lite：Lite 不可用时报明确错误且一项不写；未知预设报错', t => {
  const dataDir = presetEnv(t);
  const choice = require('../core/feature-agent-choice');
  const routes = require('../core/codeagent-assistant-route');
  assert.throws(() => choice.applyPreset(dataDir, 'codeagent-lite', { backends: backends(false) }), /CodeAgent-Lite 暂不可用/);
  for (const f of choice.FEATURES) assert.equal(routes.featurePreference(dataDir, f.id), null, f.id);
  assert.throws(() => choice.applyPreset(dataDir, 'everything'), /未知/);
});

test('IPC feature-agents:preset：调用预设、广播变更、同步本机反代，返回 state + changed/skipped；出错返回 ok:false', async t => {
  const dataDir = presetEnv(t);
  void dataDir;
  const choice = require('../core/feature-agent-choice');
  const calls = [];
  t.mock.method(choice, 'applyPreset', (dir, preset) => {
    calls.push({ dir, preset });
    if (preset === 'bad') throw new Error('未知的一键预设');
    return { ok: true, preset, changed: ['ppt'], skipped: ['assistant'], state: { ok: true, features: [], backends: [] } };
  });
  const handlers = new Map(), sent = [];
  let synced = 0;
  require('../main/ipc/config-handlers').registerConfigIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
    companyProxyService: { syncWithConfig: async () => { synced += 1; } },
  });
  const r = await handlers.get('feature-agents:preset')(null, { preset: 'codeagent-lite' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed, ['ppt']);
  assert.deepEqual(r.skipped, ['assistant']);
  assert.equal(calls[0].preset, 'codeagent-lite');
  assert.ok(sent.some(s => s.channel === 'feature-agents:changed'));
  assert.equal(synced, 1);
  const bad = await handlers.get('feature-agents:preset')(null, { preset: 'bad' });
  assert.deepEqual(bad, { ok: false, error: '未知的一键预设' });
});

test('设置页：一键按钮和分类标签同一行，不可用 / 全是 Lite 时置灰写明原因，有 Lite 才出现还原', () => {
  const src = read('renderer/feature-agent-settings.js');
  // 按钮放进 .fa-group-tabs 这一行（不新增一行高度）
  assert.match(src, /aria-selected="\$\{group === 'ppt'\}">PPT<\/button>\$\{presetButtons\(\)\}<\/div>/);
  assert.match(src, /\.fa-group-tabs \.fa-presets \{ margin-left:auto;/);
  assert.match(src, /data-fa-preset="codeagent-lite"/);
  assert.match(src, /data-fa-preset="reset-lite"/);
  assert.match(src, /一键全切 Lite（省内存）/);
  assert.match(src, /还原 Lite/);
  assert.match(src, /ipcRenderer\.invoke\('feature-agents:preset', \{ preset \}\)/);
  assert.match(src, /已将 \$\{changed\} 项互动功能切换为 CodeAgent-Lite（省内存），下次任务生效/);
  assert.match(src, /保留已选其他后端的 \$\{skipped\} 项/);
  assert.match(src, /本机 CodeAgent-Lite 暂不可用/);
  assert.match(src, /原先单独指定的模型也一并恢复为默认/);
  assert.match(src, /if \(tab\) \{ group = tab\.dataset\.faGroup; presetNote = '';/);
  assert.match(src, /if \(!detail\?\.preset\) presetNote = '';/);
  assert.match(src, /presetNote = '';\n    if \(!model\)/);
  assert.match(src, /可切换的功能都已是 CodeAgent-Lite/);
});

// ---------------------------------------------------------------- R2 收尾：唤醒判活、界面原地保持、提交入口、梦境索引、回执确认
test('已绑定原生 ID 的运行中回退：过渡态里 resumeSession 仍真实建出新 PTY（不把过渡元数据当在线会话）', async t => {
  const root = presetEnv(t);
  const { manager, created } = realManager();
  manager.suspendSession = (id, opts) => { manager.lastSuspend = opts; setTimeout(() => manager.sessions.delete(id), 5); return { ok: true }; };
  const cwd = path.join(root, 'w'); fs.mkdirSync(cwd, { recursive: true });
  liteEntry(manager, 'lite-r1', { info: { cwd, acpSid: 'thread-r1', ccSessionId: 'thread-r1', acpCapabilities: { loadSession: true } } });
  const resume = require('../main/ipc/resume-session-handlers').createResumeSessionHandler({
    fs, os, path, getHookPort: () => 0, getHubDataDir: () => root, sessionManager: manager,
    isClaudeFamily: kind => /^codeagent(?:-resume)?$/.test(kind), isCodexBaseKind: () => false,
    findTranscriptByCCSessionId: () => null, meetingManager: { getAllMeetings: () => [] }, registerSessionForTap() {}, sendToRenderer() {}, slotIds: [],
  });
  const sent = registerHandlers(manager, { resumeSession: (meta, o) => resume(meta, { ...o, skipLaunchAuth: true }) });
  manager._beginServeFallback('lite-r1', manager.sessions.get('lite-r1').info);
  manager.emit('codeagent-serve-fallback', { sessionId: 'lite-r1', reason: '事件流断开', phase: 'runtime', hasThread: true, pendingPrompts: [] });
  await untilTrue(() => sent.some(s => s.channel === 'session-notice'), '回执');
  assert.equal(manager.lastSuspend.reason, 'serve-fallback', '运行中回退同样标 serve-fallback，界面体验与首轮一致');
  assert.equal(created.length, 1, '唤醒真实建了新会话');
  assert.equal(require('../core/codeagent-run-mode').usesServeRuntime(created[0].kind, created[0].opts), false, '按终端方式建');
  assert.equal(created[0].opts.resumeCCSessionId, 'thread-r1', '接着原来的原生会话');
  assert.equal(manager.hasLiveSession('lite-r1'), true);
  assert.equal(sent.find(s => s.channel === 'session-notice').payload.level, 'info');
  assert.equal(resume.getStatus('lite-r1').state, 'live');
});

function promptHarness(t, chain) {
  const handlers = new Map();
  const reg = require('../main/ipc/prompt-submit-handlers').registerPromptSubmitIpc({ handle: (n, fn) => handlers.set(n, fn) }, {
    sessionManager: chain.manager, transcriptTap: new EventEmitter(), sendToRenderer() {}, logger: { warn() {}, log() {}, error() {} },
    busyQueuedOptions: { autoStart: false },
  });
  t.after(() => reg.dispose());
  // 终端输入框预检：真实环境里查的是新终端的屏幕；这里记下调用时刻对应的会话对象，断言它发生在改建之后。
  const checks = [];
  t.mock.method(chain.watcher, 'codeAgentInputAction', async sid => { checks.push(chain.manager.sessions.get(sid)?.pty); return { ok: true }; });
  return { send: request => handlers.get('session:send-prompt')(null, request), checks };
}

test('提交入口·过渡期发消息：先等改建完成再预检和发送，不报「不是可用的 CodeAgent 终端会话」', async t => {
  const chain = realChain(t, { exitDelayMs: 40 });
  const h = promptHarness(t, chain);
  await chain.serve.start().catch(() => {});
  assert.equal(chain.manager.serveFallbackPending('chain-1'), true);
  const result = await h.send({ sessionId: 'chain-1', text: '过渡期发的', clientSubmissionId: 'ui-1' });
  assert.notEqual(result?.ok, false, JSON.stringify(result));
  assert.equal(chain.native().delivered.length, 1);
  assert.ok(chain.native().delivered[0].text.endsWith('过渡期发的'));
  assert.ok(h.checks.every(pty => pty === chain.manager.sessions.get('chain-1').pty), '终端预检只对新会话做');
});

test('提交入口·首句撞上启动失败（带梦境索引）：外层等改建后整体重来，梦境索引/规则各一份，回执按新编号登记', async t => {
  const chain = realChain(t);
  const h = promptHarness(t, chain);
  const versionDir = tmp('lite-dream-');
  t.after(() => { try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(versionDir, 'DREAM_INDEX.md'), '梦境索引正文');
  chain.memory.pointer = () => ({ version: 'dv1' });
  chain.memory.versionDir = () => versionDir;
  const result = await h.send({ sessionId: 'chain-1', text: '第一句', clientSubmissionId: 'ui-2', memoryIndex: true });
  assert.notEqual(result?.ok, false, JSON.stringify(result));
  const delivered = chain.native().delivered;
  assert.equal(delivered.length, 1);
  const text = delivered[0].text;
  assert.equal(count(text, '<ai-hub-dream-index '), 1, '梦境索引只一份');
  assert.equal(count(text, '<ai-hub-rules '), 1);
  assert.equal(count(text, '<ai-hub-workspace-rules '), 1);
  assert.match(text, /<ai-hub-dream-index ref="ui-2-pty">/, '梦境索引回执按新编号（新会话身份）登记');
  assert.equal(delivered[0].o.clientSubmissionId, 'ui-2-pty');
  assert.equal(delivered[0].o.serveFallbackOuterRetry, undefined, '外层重来时不再要求内层原样抛出');
});

test('发送回执：按旧 serve 会话建的 nativeOnly 回执，重发到终端后认终端的 prompt-submitted 确认，不干等报卡住', () => {
  const { PromptSubmissionReceipts } = require('../core/prompt-submission-receipts');
  const receipts = new PromptSubmissionReceipts(() => {});
  const receipt = receipts.begin('s-pty', 'c9', '你好', Date.now() - 10, { nativeOnly: true });
  const watcher = require('../core/group-chat-watcher');
  watcher.init({ sessionManager: { getNativeSession: () => null } });
  const opts = watcher.serveFallbackRetryOptions({ clientSubmissionId: 'c9', submissionReceipt: receipt, serveFallbackOuterRetry: true }, 's-pty');
  assert.equal(opts.clientSubmissionId, 'c9-pty');
  assert.equal(opts.requireReady, true);
  assert.equal('serveFallbackOuterRetry' in opts, false);
  assert.equal(receipt.nativeOnly, false, '目标已是终端会话：改认终端确认');
  assert.equal(receipts.observe({ sessionId: 's-pty', text: '你好', submittedAt: Date.now(), signalSource: 'prompt-submitted' }), true);
  assert.equal(receipt.status, 'confirmed');
  // 目标仍是原生会话时不改
  const other = receipts.begin('s-native', 'c8', '在吗', Date.now(), { nativeOnly: true });
  watcher.init({ sessionManager: { getNativeSession: () => ({}) } });
  watcher.serveFallbackRetryOptions({ clientSubmissionId: 'c8', submissionReceipt: other }, 's-native');
  assert.equal(other.nativeOnly, true);
});

test('界面：serve-fallback 休眠时正看着的会话原地保持并显示「正在切换到终端方式」，已切走的不抢；助理判活与重复检查', () => {
  const r = read('renderer/renderer.js');
  assert.match(r, /const serveFallbackKeepOpen = session\?\.suspendReason === 'serve-fallback' && !activeMeetingId;/);
  assert.match(r, /if \(activeSessionId === sessionId && \(_restartKeepOpen\.has\(sessionId\) \|\| serveFallbackKeepOpen\)\)/);
  assert.match(r, /switching \? '正在切换到终端方式…'/);
  assert.match(read('main.js'), /function sessionProcessAlive\(id\) \{\n[^\n]*\n  if \(sessionManager\.serveFallbackPending\?\.\(id\)\) return null;/);
  const sm = read('core/session-manager.js');
  assert.ok(sm.indexOf("if (isCodeAgentKind(kind) && this.sessions.has(id)) throw") < sm.indexOf('const launchAccount = this._resolveCodeAgentLaunchAccount('), '重复会话先拦，再选号计数');
  const fa = read('renderer/feature-agent-settings.js');
  assert.match(fa, /const opened = modalWasHidden && !hidden;/);
  assert.match(fa, /if \(opened\) presetNote = '';/);
});

test('重复会话检查早于号池选号：重复 id 不白记号池计数', () => {
  const manager = new SessionManager();
  let picks = 0;
  manager._resolveCodeAgentPool = () => { picks += 1; return { account: { id: 'A', dir: 'C:/pool/A' } }; };
  manager.sessions.set('dup-1', { info: { id: 'dup-1' } });
  assert.throws(() => manager._createSession('codeagent', { id: 'dup-1', codeagentAccount: 'pool', cwd: os.tmpdir() }), /不能重复接管/);
  assert.equal(picks, 0);
});
