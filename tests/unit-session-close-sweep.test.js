'use strict';
// 关闭 / 休眠会话后的进程树补杀（core/session-close-sweep.js）：共享后台进程绝不当成会话自己的树去杀（2026-11-24 三审 P0-1）。
const test = require('node:test'), assert = require('node:assert/strict');
const sweep = require('../core/session-close-sweep');
const serveHost = require('../core/codeagent-serve-host');

const HOST_PID = 4242;
// 一张进程快照：共享 serve（4242）下挂两个会话各自的 MCP 子进程。
function inspector() {
  const processes = [
    { pid: HOST_PID, ppid: 1, name: 'codeagent.exe', startedAt: 1 },
    { pid: 5001, ppid: HOST_PID, name: 'node.exe', startedAt: 2 },
    { pid: 5002, ppid: HOST_PID, name: 'node.exe', startedAt: 3 },
  ];
  const snap = { processes, byPid: new Map(processes.map(p => [p.pid, p])) };
  return { snapshot: async () => snap, getCached: () => snap };
}
function liteEntry(id) {
  return { pty: { pid: HOST_PID }, info: { id, kind: 'codeagent', runtimeBackend: 'acp', codeagentRunMode: 'serve', codeagentLiteFeature: true } };
}

test('两个 Lite 会话共用同一个 serve：关掉其中一个不安排补杀', async () => {
  const manager = { sessions: new Map([['a', liteEntry('a')], ['b', liteEntry('b')]]), listLivePtyPids: () => [HOST_PID] };
  assert.equal(await sweep.prepareCloseSweep(manager, 'a', { inspect: inspector, platform: 'win32', log() {} }), null);
  assert.ok(manager.sessions.get('b'), '另一个会话不受影响');
});

test('共享运行时判定与 session-manager 同口径', () => {
  assert.equal(sweep.sharedRuntime(liteEntry('a')), true);
  assert.equal(sweep.sharedRuntime({ pty: { pid: 1 }, info: { kind: 'codeagent', runtimeBackend: 'acp' } }), true);
  assert.equal(sweep.sharedRuntime({ pty: { pid: 1 }, info: { kind: 'codex', runtimeBackend: 'codex-app-server' } }), true);
  assert.equal(sweep.sharedRuntime({ pty: { pid: 1, isCliProvider: true }, info: { kind: 'deepseek-acp', runtimeBackend: 'acp' } }), false);
  assert.equal(sweep.sharedRuntime({ pty: { pid: 1 }, info: { kind: 'codeagent' } }), false);
});

test('保护名单含全部共享 serve，且不会把会话借用的那个 serve 剔掉', t => {
  const original = serveHost.livePids;
  serveHost.livePids = () => [HOST_PID];
  t.after(() => { serveHost.livePids = original; });
  const pids = sweep.protectedPids({ listLivePtyPids: () => [HOST_PID, 7777] }, HOST_PID);
  assert.ok(pids.includes(process.pid));
  assert.ok(pids.includes(HOST_PID), '共享 serve 在保护名单里');
  assert.ok(pids.includes(7777));
});

test('普通 PTY CodeAgent 会话照旧补杀', async () => {
  const processes = [{ pid: 900, ppid: 1, startedAt: 1 }, { pid: 901, ppid: 900, startedAt: 2 }];
  const snap = { processes, byPid: new Map(processes.map(p => [p.pid, p])) };
  const manager = { sessions: new Map([['p', { pty: { pid: 900 }, info: { kind: 'codeagent' } }]]), listLivePtyPids: () => [900] };
  const plan = await sweep.prepareCloseSweep(manager, 'p', { inspect: () => ({ snapshot: async () => snap }), platform: 'win32', log() {} });
  assert.ok(plan && typeof plan.schedule === 'function');
  assert.ok(plan.before.length >= 2);
});

const mainSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
// 公开版不带这段休眠逻辑，没有就跳过。
test('公司通道休眠补杀也跳过共享运行时并用同一份保护名单', { skip: !/suspendSession: \(id, opts\) => \{/.test(mainSrc) }, () => {
  const src = mainSrc;
  assert.match(src, /&& !closeSweep\.sharedRuntime\(entry\);/);
  assert.match(src, /protect: \(\) => closeSweep\.protectedPids\(sessionManager, rootPid\),/);
});
