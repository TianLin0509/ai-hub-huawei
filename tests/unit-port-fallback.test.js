'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { HOOK_PORT_CANDIDATES, listenWithPortFallback, fallbackMessage } = require('../core/port-fallback');

// 模拟 Windows 保留段的绑定拒绝，不修改真实系统保留表、不占生产端口。
class FakeServer extends EventEmitter {
  constructor(fail, actualPort = 49876) { super(); this.fail = fail; this.actualPort = actualPort; this.tried = []; }
  listen(port, host) {
    this.tried.push(port); this.host = host;
    const code = this.fail(port);
    queueMicrotask(() => code ? this.emit('error', Object.assign(new Error(code), { code })) : this.emit('listening'));
  }
  address() { return { port: this.actualPort }; }
}

test('默认从原端口开始，成功后不触发额外绑定', async () => {
  const server = new FakeServer(() => null, 3456);
  const result = await listenWithPortFallback(server);
  assert.deepEqual(server.tried, [3456]);
  assert.equal(result.port, 3456);
  assert.equal(result.fallback, false);
});

for (const code of ['EACCES', 'EADDRINUSE', 'EPERM']) {
  test(`${code} 耗尽原段后请求端口 0，返回实际分配值且无监听泄漏`, async () => {
    const server = new FakeServer(port => port ? code : null);
    const existing = () => {};
    server.on('error', existing);
    const result = await listenWithPortFallback(server);
    assert.deepEqual(server.tried, [...HOOK_PORT_CANDIDATES, 0]);
    assert.equal(server.host, '127.0.0.1');
    assert.equal(result.port, 49876);
    assert.equal(result.fallback, true);
    assert.equal(result.failures.length, 20);
    assert.match(result.message, code === 'EADDRINUSE' ? /已被占用，已改用 49876/ : /被系统保留或访问受限，已改用 49876/);
    assert.deepEqual(server.listeners('error'), [existing]);
    assert.equal(server.listenerCount('listening'), 0);
  });
}

test('个别端口失败后继续原段，不提前切系统分配', async () => {
  const server = new FakeServer(port => port === 3456 ? 'EADDRINUSE' : null, 3457);
  const result = await listenWithPortFallback(server);
  assert.deepEqual(server.tried, [3456, 3457]);
  assert.equal(result.port, 3457);
  assert.equal(result.fallback, false);
});

test('系统分配也失败时终止重试，保留可诊断的错误', async () => {
  const server = new FakeServer(() => 'EACCES');
  await assert.rejects(listenWithPortFallback(server), error => error.code === 'EACCES' && error.portFailures.length === 21);
  assert.equal(server.tried.length, 21);
  assert.equal(server.listenerCount('error'), 0);
  assert.equal(server.listenerCount('listening'), 0);
  assert.match(fallbackMessage({ port: null }), /未能绑定/);
});

test('未知错误与同步抛错不盲目重试，也不遗留监听', async () => {
  for (const synchronous of [false, true]) {
    const server = new FakeServer(() => 'EINVAL');
    if (synchronous) server.listen = () => { throw Object.assign(new Error('bad bind'), { code: 'EINVAL' }); };
    await assert.rejects(listenWithPortFallback(server), { code: 'EINVAL' });
    assert.equal(server.listenerCount('error'), 0);
    assert.equal(server.listenerCount('listening'), 0);
  }
});

test('真实占用端口自动换口，HTTP 回调仍可收到', async t => {
  const blocker = http.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const server = http.createServer((_req, res) => res.end('hook received'));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await listenWithPortFallback(server, { ports: [blocker.address().port] });
  assert.equal(result.port, server.address().port);
  assert.notEqual(result.port, blocker.address().port);
  assert.equal(result.fallback, true);
  const response = await fetch(`http://127.0.0.1:${result.port}/api/hook`, { method: 'POST', body: '{}' });
  assert.equal(await response.text(), 'hook received');
});

test('成员环境覆盖继承端口，绑定失败时不保留父 Hub 地址', () => {
  const source = fs.readFileSync(path.join(__dirname, '../core/session-manager.js'), 'utf8');
  const method = source.match(/  _applyHubSessionEnv\(sessionEnv, id\) \{[\s\S]*?\n  \}/)[0];
  const Manager = vm.runInNewContext(`(class { ${method} })`);
  const manager = new Manager();
  manager.hookPort = 49876; manager.hookToken = 'fixture-token';
  const env = { CLAUDE_HUB_PORT: '3456' };
  manager._applyHubSessionEnv(env, 'member-fixture');
  assert.equal(env.CLAUDE_HUB_PORT, '49876');
  assert.equal(env.CLAUDE_HUB_SESSION_ID, 'member-fixture');
  manager.hookPort = null;
  manager._applyHubSessionEnv(env, 'member-fixture');
  assert.equal(env.CLAUDE_HUB_PORT, undefined);
});

test('一键诊断通过真实 IPC 处理器附上当前端口和兜底原因', async () => {
  const { registerHarnessLocatorIpc } = require('../main/ipc/harness-locator-handlers');
  const handlers = new Map();
  registerHarnessLocatorIpc({ handle: (key, fn) => handlers.set(key, fn) }, {
    locator: { onChange() {}, diagnosisText: () => 'CLI 检查正常' },
    portDiagnosis: () => fallbackMessage({ port: 49876, fallback: true, failures: [{ code: 'EACCES' }] }),
  });
  const result = await handlers.get('harness:diagnosis')(null, {});
  assert.match(result.text, /CLI 检查正常\n端口段被系统保留或访问受限，已改用 49876/);
});
