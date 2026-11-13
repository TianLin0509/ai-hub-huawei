'use strict';
// Community edition contract: edition marker, no private modules, hooks that
// need neither Python nor Node, and no changes to the user's global CLI
// permission settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('public audit rejects profile paths in binary encodings and filenames', t => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-audit-binary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts/audit-public.js'), path.join(dir, 'scripts/audit-public.js'));
  const userPath = ['C:', 'Users', 'fixture-account', 'cache'].join('\\');
  const utf16 = Buffer.from(userPath, 'utf16le');
  const cases = [Buffer.from(userPath), utf16, Buffer.concat([Buffer.from([0]), utf16]), Buffer.from(utf16).swap16()];
  for (let index = 0; index < cases.length; index++) fs.writeFileSync(path.join(dir, 'cache-' + index), cases[index]);
  fs.mkdirSync(path.join(dir, 'Users', 'fixture-account'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Users', 'fixture-account', 'cache'), 'safe');
  fs.writeFileSync(path.join(dir, 'image.png'), Buffer.from([0, 255, 0, 123]));
  const result = spawnSync(process.execPath, [path.join(dir, 'scripts/audit-public.js')], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(result.status, 1, result.stderr);
  const failures = JSON.parse(result.stdout).failures;
  assert.equal(failures.filter(hit => hit.rule === 'machine user path in binary').length, 4);
  assert.equal(failures.filter(hit => hit.rule === 'machine user path in filename').length, 1);
  assert.equal(failures.some(hit => hit.file === 'image.png'), false);
});

test('CDP HTTP helpers bound partial responses and settle aborted bodies', async () => {
  const http = require('node:http'), vm = require('node:vm'), { createRequire } = require('node:module');
  const filename = path.join(__dirname, 'helpers/hub-launcher.js');
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.dirname(filename),
    require: createRequire(filename), process, console, Buffer, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.httpProbe = { _httpGetJson, _httpCloseTarget };', context);
  const { _httpGetJson: getJson, _httpCloseTarget: closeTarget } = context.module.exports.httpProbe;
  const sockets = new Set(), timers = new Set(), faultConnections = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.end('{"ready":true}'); return; }
    faultConnections.push({ route: req.url, closed: new Promise(resolve => req.socket.once('close', () => resolve(true))) });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('[');
    if (req.url === '/abort') { setImmediate(() => res.destroy()); return; }
    const timer = setInterval(() => res.write(' '), 10); timers.add(timer);
    res.on('close', () => { clearInterval(timer); timers.delete(timer); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bounded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve({ watchdog: true }), 1000); })]); }
    finally { clearTimeout(timer); }
  };
  const assertFaultClosed = async (route, operation) => {
    const connection = faultConnections.shift();
    assert.ok(connection, operation + ' must reach the fault server');
    assert.equal(connection.route, route);
    assert.equal(await bounded(connection.closed), true, route + ' ' + operation + ' must close its socket before fallback cleanup');
  };
  try {
    assert.equal((await getJson(base + '/ok', 5000)).ready, true);
    for (const route of ['/trickle', '/abort']) {
      assert.equal(await bounded(getJson(base + route, 100)), null, route + ' JSON must settle');
      await assertFaultClosed(route, 'JSON');
      const error = await bounded(closeTarget(base + route, 100).catch(error => error));
      assert.equal(error instanceof Error || error?.name === 'Error', true, route + ' close must reject');
      assert.match(error.message, /timed out|aborted|closed|reset/i);
      await assertFaultClosed(route, 'close');
    }
  } finally {
    for (const timer of timers) clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('CDP initial target query obeys its wait budget even when HTTP never responds', async () => {
  const http = require('node:http'), sockets = new Set();
  let connectionClosed;
  const server = http.createServer(req => { connectionClosed = new Promise(resolve => req.socket.once('close', () => resolve(true))); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let timer;
  try {
    const outcome = await Promise.race([
      require('./helpers/cdp-client').connectFirstPage({ cdpHttpBase: `http://127.0.0.1:${server.address().port}`, label: 'unresponsive fixture' }, () => true, { waitMainMs: 100 }).catch(error => error),
      new Promise(resolve => { timer = setTimeout(() => resolve({ watchdog: true }), 1000); }),
    ]);
    assert.equal(outcome instanceof Error, true, 'target query must fail within its budget');
    assert.match(outcome.message, /No matching CDP target/);
    clearTimeout(timer);
    assert.ok(connectionClosed, 'target query must reach the unresponsive server');
    assert.equal(await Promise.race([
      connectionClosed,
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
    ]), true, 'target query must close its socket before fallback cleanup');
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

class FakeCdpSocket extends require('node:events').EventEmitter {
  constructor() { super(); this.sent = []; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.emit('close', 1000, Buffer.from('closed')); }
  reply(id, result = {}) { this.emit('message', Buffer.from(JSON.stringify({ id, result }))); }
}

test('CDP HTTP deadline destroys a late response without consuming its body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { EventEmitter } = require('node:events');
  const { requestCdpHttp } = require('./helpers/cdp-http');
  const request = new EventEmitter(), response = new EventEmitter();
  let onResponse, requestDestroyed = 0, responseDestroyed = 0;
  request.destroy = () => { requestDestroyed++; };
  response.destroy = () => { responseDestroyed++; response.emit('error', Error('late transport error')); };
  const pending = requestCdpHttp({ get(_url, callback) { onResponse = callback; return request; } }, 'http://fixture', 100).catch(error => error);
  t.mock.timers.tick(100);
  assert.match((await pending).message, /timed out/);
  onResponse(response);
  assert.equal(requestDestroyed, 1);
  assert.equal(responseDestroyed, 1);
  assert.equal(response.listenerCount('data'), 0);
});

test('CDP default timeout remains 30 seconds and cleans pending without replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const ws = new FakeCdpSocket(), c = new (require('./helpers/cdp-client').CDPClient)(ws);
  let settled = false; const pending = c.send('Page.enable').catch(e => { settled = true; return e; });
  t.mock.timers.tick(29999); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1); const e = await pending;
  assert.equal(e.method, 'Page.enable'); assert.equal(e.requestId, 1);
  assert.equal(e.elapsedMs, 30000); assert.equal(e.timeoutMs, 30000);
  assert.ok(Object.keys(e).includes('elapsedMs'));
  assert.equal(c.pending.size, 0); assert.equal(ws.sent.length, 1);
});

test('CDP 60 second budget succeeds after 31 seconds and still rejects at its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const ws = new FakeCdpSocket(), c = new (require('./helpers/cdp-client').CDPClient)(ws, { commandTimeoutMs: 60000 });
  const first = c.send('Page.enable').catch(e => e);
  t.mock.timers.tick(31000); ws.reply(1, { enabled: true });
  assert.deepEqual(await first, { enabled: true });
  const second = c.send('Page.disable').catch(e => e);
  t.mock.timers.tick(60000); const error = await second;
  assert.equal(error.timeoutMs, 60000); assert.equal(error.elapsedMs, 60000);
  ws.reply(2); assert.equal(c.pending.size, 0); assert.equal(ws.sent.length, 2);
});

test('CDP per-command and eval budgets honor the remaining poll time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const ws = new FakeCdpSocket(), c = new (require('./helpers/cdp-client').CDPClient)(ws, { commandTimeoutMs: 60000 });
  const direct = c.send('Page.enable', {}, { timeoutMs: 120 }).catch(e => e);
  const evaluation = c.eval('1+1', { timeoutMs: 250 }).catch(e => e);
  t.mock.timers.tick(120); assert.equal(c.pending.size, 1); assert.equal((await direct).timeoutMs, 120);
  t.mock.timers.tick(130); assert.equal((await evaluation).elapsedMs, 250);
  assert.equal(c.pending.size, 0); assert.equal(ws.sent.length, 2);
  assert.equal(Object.hasOwn(ws.sent[1].params, 'timeoutMs'), false);
});

test('CDP disconnects and target loss reject all pending calls immediately without replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  for (const event of ['close', 'error', 'Inspector.targetCrashed', 'Inspector.detached']) {
    const ws = new FakeCdpSocket(), c = new (require('./helpers/cdp-client').CDPClient)(ws);
    const pending = [c.send('Page.enable').catch(e => e), c.eval('42').catch(e => e)];
    t.mock.timers.tick(17);
    if (event === 'close') ws.close();
    else if (event === 'error') ws.emit('error', Error('socket failed'));
    else ws.emit('message', Buffer.from(JSON.stringify({ method: event, params: { reason: 'test' } })));
    assert.equal(c.pending.size, 0, event);
    for (const e of await Promise.all(pending)) { assert.equal(e.elapsedMs, 17); assert.equal(e.timeoutMs, 30000); assert.ok(e.requestId); }
    await assert.rejects(c.send('Page.disable'));
    t.mock.timers.tick(60000); assert.equal(ws.sent.length, 2);
  }
});

test('CDP rejects invalid budgets before sending a request', async () => {
  const { CDPClient } = require('./helpers/cdp-client');
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, '60000', null, 2147483648]) {
    const ws = new FakeCdpSocket();
    assert.throws(() => new CDPClient(ws, { commandTimeoutMs: timeoutMs }), /timeout/i);
    const c = new CDPClient(ws);
    assert.throws(() => c.send('Page.enable', {}, { timeoutMs }), /timeout/i);
    await assert.rejects(c.eval('1', { timeoutMs }), /timeout/i);
    assert.equal(ws.sent.length, 0);
  }
});

test('CDP connection entry points forward budgets and reject connection loss', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const vm = require('node:vm'), { createRequire } = require('node:module'), { EventEmitter } = require('node:events');
  const filename = path.join(__dirname, 'helpers/cdp-client.js'), localRequire = createRequire(filename);
  let connectEvent = 'open'; const sockets = [];
  class Socket extends FakeCdpSocket {
    constructor() { super(); sockets.push(this); queueMicrotask(() => this.emit(connectEvent, Error('connect failure'))); }
  }
  const http = { get(_url, callback) {
    const request = new EventEmitter(), response = new EventEmitter();
    queueMicrotask(() => { callback(response); response.emit('data', JSON.stringify([{ type: 'page', url: 'file:///renderer/index.html', webSocketDebuggerUrl: 'ws://fixture' }])); response.emit('end'); });
    return request;
  } };
  const context = vm.createContext({ module: { exports: {} }, Buffer, setTimeout, clearTimeout, Date,
    require: name => name === 'ws' ? Socket : name === 'http' ? http : localRequire(name) });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  const { connectCDP, connectFirstPage } = context.module.exports;
  for (const create of [() => connectCDP('ws://fixture', { commandTimeoutMs: 60000 }),
    () => connectFirstPage({ cdpHttpBase: 'http://fixture' }, null, { commandTimeoutMs: 60000 }),
    () => connectFirstPage({ cdpHttpBase: 'http://fixture' }, null, { waitMainMs: 0, commandTimeoutMs: 60000 })]) {
    const c = await create(), ws = sockets.at(-1), pending = c.send('Page.enable').catch(e => e);
    t.mock.timers.tick(31000); ws.reply(1, { alive: true }); assert.equal((await pending).alive, true);
    await c.close();
  }
  for (const event of ['close', 'error']) {
    connectEvent = event;
    await assert.rejects(connectCDP('ws://fixture'), error => error.method === 'connect' && error.requestId === 0 && error.elapsedMs === 0 && error.timeoutMs === 5000);
  }
  const before = sockets.length;
  await assert.rejects(connectCDP('ws://fixture', { commandTimeoutMs: 0 }), /timeout/i);
  await assert.rejects(connectFirstPage({}, null, { commandTimeoutMs: NaN }), /timeout/i);
  assert.equal(sockets.length, before, 'invalid budgets must not open a socket');
});

test('CDP send failures and protocol errors clear pending timers with request diagnostics', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { CDPClient } = require('./helpers/cdp-client');
  for (const mode of ['throw', 'callback', 'protocol']) {
    const ws = new FakeCdpSocket(), c = new CDPClient(ws);
    if (mode !== 'protocol') ws.send = (_text, done) => { if (mode === 'throw') throw Error('write failed'); done(Error('write failed')); };
    const pending = c.send('Page.enable').catch(e => e);
    if (mode === 'protocol') ws.emit('message', Buffer.from(JSON.stringify({ id: 1, error: { message: 'not supported' } })));
    const error = await pending;
    assert.equal(error.method, 'Page.enable'); assert.equal(error.requestId, 1);
    assert.equal(error.elapsedMs, 0); assert.equal(error.timeoutMs, 30000); assert.equal(c.pending.size, 0);
    t.mock.timers.tick(60000);
  }
});

test('CDP eval preserves existing result semantics and close rejects outstanding requests', async () => {
  const ws = new FakeCdpSocket(), c = new (require('./helpers/cdp-client').CDPClient)(ws);
  const value = c.eval('42');
  for (const frame of ['invalid json', 'null', 'true']) ws.emit('message', Buffer.from(frame));
  ws.reply(1, { result: { type: 'number', value: 42 } }); assert.equal(await value, 42);
  assert.equal(ws.sent[0].params.awaitPromise, true); assert.equal(ws.sent[0].params.returnByValue, true);
  const failed = c.eval('throw Error("fixture")').catch(e => e);
  ws.reply(2, { exceptionDetails: { exception: { description: 'fixture exception' } } });
  const error = await failed; assert.equal(error.method, 'Runtime.evaluate'); assert.equal(error.requestId, 2);
  assert.match(error.message, /fixture exception/);
  const pending = c.send('Page.enable').catch(e => e); await c.close();
  assert.match((await pending).message, /closed/); assert.equal(c.pending.size, 0); assert.equal(ws.sent.length, 3);
});

function isolatedLauncherDiagnostics(query, http = { get() { throw Error('unverified CDP must not receive requests'); } }) {
  const vm = require('node:vm'), { createRequire } = require('node:module');
  const filename = path.join(__dirname, 'helpers/hub-launcher.js'), localRequire = createRequire(filename);
  let now = 1000; const calls = [];
  const execFile = async (command, args, options) => {
    calls.push({ command, args, options });
    return query(command, args, options, ms => { now += ms; });
  };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.dirname(filename),
    process: { platform: 'win32', env: {} }, Date: Clock, console,
    setTimeout: (fn, ms) => { now += ms; queueMicrotask(fn); return 1; }, clearTimeout() {},
    require: name => name === 'util' ? { promisify: () => execFile }
      : name === 'http' ? http
      : localRequire(name) });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { launcher: context.module.exports, calls };
}

test('CDP listener diagnostics retain boolean success and expose only exact-port owners', async () => {
  const { launcher, calls } = isolatedLauncherDiagnostics((_cmd, _args, _options, advance) => {
    advance(7);
    return { stdout: 'TCP 127.0.0.1:93330 0.0.0.0:0 LISTENING 99988\n'
      + 'TCP 127.0.0.1:9333 0.0.0.0:0 ESTABLISHED 55555\n'
      + 'TCP 127.0.0.1:9333 0.0.0.0:0 LISTENING 2468\nTCP [::1]:9333 [::]:0 LISTENING 2468' };
  });
  assert.equal(await launcher._verifyCdpPortOwner(9333, 2468), true, 'existing signature still returns a boolean');
  let evidence;
  assert.equal(await launcher._verifyCdpPortOwner(9333, 2468, undefined, value => { evidence = value; }), true);
  assert.equal(evidence.outcome, 'matched'); assert.equal(evidence.expectedPid, 2468);
  assert.equal(evidence.queries.length, 1); assert.equal(evidence.queries[0].owners.join(','), '2468');
  assert.equal(evidence.queries[0].elapsedMs, 7);
  assert.doesNotMatch(JSON.stringify(evidence), /99988|55555|93330|ESTABLISHED/);
  assert.ok(calls.every(c => c.command === 'netstat.exe' && c.options.timeout === 3000 && c.options.windowsHide === true));
  assert.equal(await launcher._verifyCdpPortOwner(9333, 2468, undefined, () => { throw Error('observer failed'); }), true);
});

test('CDP listener diagnostics distinguish a real PID mismatch from no listener', async () => {
  for (const mismatch of [true, false]) {
    const { launcher, calls } = isolatedLauncherDiagnostics(() => ({ stdout: mismatch
      ? 'TCP 127.0.0.1:9333 0.0.0.0:0 LISTENING 4321' : '' }));
    let evidence;
    assert.equal(await launcher._verifyCdpPortOwner(9333, 2468, undefined, value => { evidence = value; }), false);
    assert.equal(evidence.outcome, mismatch ? 'pid-mismatch' : 'no-listener');
    assert.equal(calls.length, mismatch ? 1 : 2, 'keep the existing fallback decision');
    assert.equal(evidence.queries.at(-1).owners.join(','), mismatch ? '4321' : '');
  }
});

test('CDP listener diagnostics retain netstat timeout and successful PowerShell fallback', async () => {
  const { launcher, calls } = isolatedLauncherDiagnostics((command, _args, options, advance) => {
    if (command === 'netstat.exe') {
      advance(options.timeout);
      throw Object.assign(Error('secret-output and full command must not escape'), { killed: true, signal: 'SIGTERM', code: null });
    }
    advance(17); return { stdout: '2468' };
  });
  let evidence;
  assert.equal(await launcher._verifyCdpPortOwner(9333, 2468, undefined, value => { evidence = value; }), true);
  assert.equal(evidence.outcome, 'matched'); assert.equal(evidence.queries[0].elapsedMs, 3000);
  assert.equal(evidence.queries[0].error.timedOut, true); assert.equal(evidence.queries[0].error.signal, 'SIGTERM');
  assert.equal(evidence.queries[1].elapsedMs, 17); assert.equal(calls[1].options.timeout, 5000);
  assert.equal(calls[1].options.windowsHide, true); assert.doesNotMatch(JSON.stringify(evidence), /secret-output|-Command|Get-NetTCPConnection/);
});

test('CDP listener diagnostics distinguish PowerShell timeout and nonzero query exit', async () => {
  for (const timedOut of [true, false]) {
    const { launcher } = isolatedLauncherDiagnostics((command, _args, options, advance) => {
      if (command === 'netstat.exe') return { stdout: '' };
      advance(timedOut ? options.timeout : 13);
      throw Object.assign(Error('private stderr and command'), timedOut
        ? { killed: true, signal: 'SIGTERM', code: null } : { code: 7, killed: false, signal: null });
    });
    let evidence;
    assert.equal(await launcher._verifyCdpPortOwner(9333, 2468, undefined, value => { evidence = value; }), false);
    assert.equal(evidence.outcome, 'query-failed');
    assert.equal(evidence.queries[0].outcome, 'no-listener');
    assert.equal(evidence.queries[1].error.timedOut, timedOut);
    assert.equal(evidence.queries[1].error.exitCode, timedOut ? null : 7);
    assert.equal(evidence.queries[1].elapsedMs, timedOut ? 5000 : 13);
    assert.doesNotMatch(JSON.stringify(evidence), /private stderr|-Command|Get-NetTCPConnection/);
  }
});

test('CDP teardown owner failure includes query evidence and only terminates the spawned child', async () => {
  for (const failure of ['query-failed', 'pid-mismatch', 'no-listener']) {
    const { launcher, calls } = isolatedLauncherDiagnostics((_command, _args, options, advance) => {
      if (failure === 'query-failed') {
        advance(options.timeout);
        throw Object.assign(Error('unrelated listener data must not escape'), { code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' });
      }
      return { stdout: failure === 'pid-mismatch' ? 'TCP 127.0.0.1:9333 0.0.0.0:0 LISTENING 4321' : '' };
    });
    const signals = [], child = { pid: 2468, exitCode: null, signalCode: null, killed: false,
      kill(signal) { signals.push(signal); this.killed = true; this.signalCode = signal; return true; } };
    const hub = { pid: child.pid, port: 9333, child, identityVerified: true, label: 'fixture',
      isAlive: () => child.signalCode == null, exitCode: () => child.exitCode, exitSignal: () => child.signalCode };
    const error = await launcher.gracefulQuit(hub, { captureDiagnostics: true }).catch(e => e), evidence = error.cdpOwnershipDiagnostics;
    assert.equal(evidence.outcome, failure); assert.equal(evidence.expectedPid, 2468);
    assert.equal(error.childState.beforeTermination.spawnedPid, 2468); assert.equal(error.childState.beforeTermination.reportedAlive, true);
    assert.equal(error.childState.afterTermination.reportedAlive, false); assert.equal(error.childState.afterTermination.childSignal, 'SIGTERM');
    assert.deepEqual(signals, ['SIGTERM']); assert.equal(error.termination.forced, true);
    assert.match(error.message, /listener owner verification failed/); assert.match(error.message, /diagnostics=/);
    assert.doesNotMatch(error.message, /identity changed|unrelated listener data|-Command/);
    if (failure === 'query-failed') {
      assert.equal(calls.length, 2, 'existing query timeout already consumes the retry budget');
      assert.equal(evidence.checks[0].queries.length, 2);
      assert.ok(evidence.checks[0].queries.every(q => q.error.timedOut));
    }
  }
});

test('CDP teardown with verified ownership still closes its page and exits cleanly without termination', async () => {
  for (const queryMode of ['matched', 'query-failed', 'query-timeout']) {
  const { EventEmitter } = require('node:events'), requests = [], signals = [];
  const child = { pid: 2468, exitCode: null, signalCode: null, kill(signal) { signals.push(signal); return true; } };
  const http = { get(url, _options, callback) {
    if (typeof _options === 'function') callback = _options;
    requests.push(url); const request = new EventEmitter(), response = new EventEmitter();
    response.statusCode = 200; response.resume = () => {};
    queueMicrotask(() => {
      callback(response);
      if (url.endsWith('/json/list')) response.emit('data', JSON.stringify([{ id: 'fixture-page', type: 'page', url: 'file:///renderer/index.html' }]));
      else child.exitCode = 0;
      response.emit('end');
    });
    return request;
  } };
  const { launcher, calls } = isolatedLauncherDiagnostics((command, _args, options, advance) => {
    if (command === 'netstat.exe') {
      if (queryMode === 'matched') return { stdout: 'TCP 127.0.0.1:9333 0.0.0.0:0 LISTENING 2468' };
      if (queryMode === 'query-timeout') advance(options.timeout);
      throw Object.assign(Error('query unavailable'), { code: queryMode === 'query-timeout' ? 'ETIMEDOUT' : 1 });
    }
    return { stdout: '2468' };
  }, http);
  const hub = { pid: child.pid, port: 9333, child, identityVerified: true, cdpHttpBase: 'http://127.0.0.1:9333',
    isAlive: () => child.exitCode == null, exitCode: () => child.exitCode, exitSignal: () => child.signalCode };
  const result = await launcher.gracefulQuit(hub);
  assert.equal(result.exitCode, 0); assert.equal(result.forced, false); assert.deepEqual(signals, []);
  assert.equal(calls.length, queryMode === 'matched' ? 1 : 2);
  assert.deepEqual(requests, ['http://127.0.0.1:9333/json/list', 'http://127.0.0.1:9333/json/close/fixture-page']);
  }
});

test('CDP diagnostic metadata failure cannot suppress successful owner fallback', async () => {
  for (const diagnostics of [false, true]) {
    const queryError = new Error('query failed');
    Object.defineProperty(queryError, 'code', { get() { throw Error('diagnostic metadata unavailable'); } });
    const { launcher, calls } = isolatedLauncherDiagnostics(command => {
      if (command === 'netstat.exe') throw queryError;
      return { stdout: '2468' };
    });
    assert.equal(await launcher._verifyCdpPortOwner(9333, 2468, undefined, diagnostics ? () => {} : null), true);
    assert.equal(calls.length, 2);
  }
});

test('CDP owner query timeout preserves clean spontaneous exit during teardown', async () => {
  for (const captureDiagnostics of [false, true]) {
    const signals = [], child = { pid: 2468, exitCode: null, signalCode: null,
      kill(signal) { signals.push(signal); return true; } };
    const { launcher } = isolatedLauncherDiagnostics((command, _args, options, advance) => {
      advance(options.timeout);
      if (command === 'powershell.exe') child.exitCode = 0;
      throw Object.assign(Error('query timed out'), { code: 'ETIMEDOUT' });
    });
    const hub = { pid: child.pid, port: 9333, child, identityVerified: true,
      isAlive: () => child.exitCode == null, exitCode: () => child.exitCode, exitSignal: () => child.signalCode };
    const result = await launcher.gracefulQuit(hub, { captureDiagnostics });
    assert.equal(result.exitCode, 0); assert.equal(result.forced, false); assert.deepEqual(signals, []);
  }
});

test('CDP child diagnostic failure never prevents owned-child termination', async () => {
  const signals = [], child = { pid: 2468, exitCode: null, signalCode: null,
    kill(signal) { signals.push(signal); this.signalCode = signal; return true; } };
  const { launcher } = isolatedLauncherDiagnostics(() => ({ stdout: '' }));
  const hub = { pid: child.pid, port: 9333, child, identityVerified: true,
    isAlive: () => child.signalCode == null, exitCode() { throw Error('snapshot unavailable'); } };
  const error = await launcher.gracefulQuit(hub, { captureDiagnostics: true }).catch(error => error);
  assert.deepEqual(signals, ['SIGTERM']); assert.equal(error.termination.forced, true);
});

test('CDP default teardown still refuses an unverified live child without diagnostic reads', async () => {
  const signals = [], child = { pid: 2468, exitCode: null, signalCode: null,
    kill(signal) { signals.push(signal); this.signalCode = signal; return true; } };
  const { launcher } = isolatedLauncherDiagnostics((_command, _args, options, advance) => {
    advance(options.timeout); throw Error('owner query unavailable');
  });
  const hub = { pid: child.pid, port: 9333, child, identityVerified: true,
    isAlive: () => child.signalCode == null, exitCode() { throw Error('must not read diagnostic getter'); } };
  const error = await launcher.gracefulQuit(hub).catch(error => error);
  assert.match(error.message, /CDP identity changed/);
  assert.equal(error.cdpOwnershipDiagnostics, undefined);
  assert.deepEqual(signals, ['SIGTERM']); assert.equal(error.termination.forced, true);
});

test('CDP eval keeps an undefined readiness condition false until real readiness', async () => {
  const ws = new FakeCdpSocket(), c = new (require('./helpers/cdp-client').CDPClient)(ws);
  const replies = [{ type: 'undefined' }, { type: 'boolean', value: false }, { type: 'boolean', value: true }];
  let attempts = 0;
  try {
    for (const result of replies) {
      attempts++;
      const pending = c.eval('window.lifecycleCapture?.running && window.lifecycleCapture.bytes > 0');
      ws.reply(ws.sent.at(-1).id, { result });
      if (await pending) break;
    }
    assert.equal(attempts, 3, 'an absent capture must not satisfy the readiness wait');
    assert.equal(c.pending.size, 0);
  } finally { await c.close(); }
});

test('CDP eval decodes undefined without changing other values or remote handles', async () => {
  const ws = new FakeCdpSocket(), c = new (require('./helpers/cdp-client').CDPClient)(ws);
  const handle = { type: 'object', objectId: 'fixture-object', description: 'Object' };
  const special = { type: 'number', unserializableValue: 'NaN' };
  const cases = [
    [{ type: 'undefined' }, undefined],
    [{ type: 'undefined' }, undefined, { returnByValue: false }],
    [{ type: 'object', subtype: 'null', value: null }, null],
    [{ type: 'boolean', value: false }, false],
    [{ type: 'number', value: 0 }, 0],
    [{ type: 'string', value: '' }, ''],
    [{ type: 'object', value: { ready: true } }, { ready: true }],
    [handle, handle, { returnByValue: false }],
    [special, special],
  ];
  try {
    for (const [result, expected, options] of cases) {
      const pending = c.eval('fixtureExpression', options);
      ws.reply(ws.sent.at(-1).id, { result });
      assert.deepEqual(await pending, expected);
    }
  } finally { await c.close(); }
});

test('edition marker enables the community edition and records the upstream version', () => {
  const marker = JSON.parse(read('community-edition.json'));
  assert.equal(marker.edition, 'community');
  assert.match(marker.upstreamVersion, /^\d+\.\d+\.\d+$/);
  const distribution = require('../core/distribution');
  assert.equal(distribution.community, true);
  assert.equal(distribution.personalModules, false);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'ai-hub-community');
  assert.equal(pkg.version, marker.version);
  assert.equal(pkg.build.productName, 'AI Hub Community');
  assert.ok(pkg.build.files.includes('community-edition.json'));
  // Run without -Version, the published installer must install this release.
  const installer = read('scripts/install-release.ps1');
  assert.equal(/\[string\]\$Version\s*=\s*'([^']+)'/.exec(installer)?.[1], `v${pkg.version}`);
  for (const doc of ['README.md', 'INSTALL.md', 'docs/AGENT-QUICKSTART.md', 'scripts/install-release.ps1']) {
    assert.doesNotMatch(read(doc), /@@COMMUNITY_|@@UPSTREAM_/, doc);
  }
});

test('private module entry points are absent from the page and the tree', () => {
  const html = read('renderer/index.html');
  assert.doesNotMatch(html, /id="(?:btn-research|btn-study|study-panel|chatgpt-web-panel)"/);
  assert.doesNotMatch(html, /data-action="sync-(?:chatgpt|company)"/);
  assert.doesNotMatch(html, /@community-/);
  assert.match(html, /<script src="community-welcome\.js"><\/script>/);
  for (const rel of ['main/ipc/study-handlers.js', 'renderer/study.js', 'main/ipc/committee-handlers.js']) {
    assert.equal(fs.existsSync(path.join(root, rel)), false, rel);
  }
  const main = read('main.js');
  assert.doesNotMatch(main, /registerStudyIpc|registerCommitteeIpc|registerChatgptBridgeIpc/);
  assert.match(main, /ipcMain\.handle\('community:setup'/);
});

test('hooks run through Windows PowerShell, not Python or Node', () => {
  const { hookRunner } = require('../core/hook-runner');
  const runner = hookRunner({});
  assert.equal(runner.name, 'powershell');
  assert.equal(runner.script, 'session-hub-hook.ps1');
  assert.ok(fs.existsSync(path.join(root, 'scripts', runner.script)));
});

test('Claude hook deployment writes PowerShell hooks and leaves global permissions and status line alone', () => {
  const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-claude-'));
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'my-status' } }));
  const result = ensureClaudeHookIntegration({ claudeDir, sourceScriptsDir: path.join(root, 'scripts'), logger: {} });
  assert.deepEqual(result.errors, []);
  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  const stop = settings.hooks.Stop[0].hooks[0].command;
  assert.match(stop, /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ".*session-hub-hook\.ps1" stop$/);
  assert.doesNotMatch(JSON.stringify(settings.hooks), /python /);
  assert.equal(settings.permissionMode, undefined, 'global permission mode is not changed');
  assert.equal(settings.statusLine.command, 'my-status', 'an existing status line is kept');
  assert.ok(fs.existsSync(path.join(claudeDir, 'scripts', 'session-hub-hook.ps1')));
});

test('Codex hook trust is written without Python', () => {
  const { ensureCodexHookIntegration } = require('../core/codex-hook-integration');
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'community-codex-'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5"\n\n[tui]\nstatus_line = ["model"]\n');
  const result = ensureCodexHookIntegration({ codexHome, logger: {} });
  assert.deepEqual(result.errors, []);
  assert.ok(result.trusted.length >= 6);
  const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /^powershell .*session-hub-hook\.ps1" stop$/);
  const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(config, /^model = "gpt-5"$/m, 'existing settings are preserved');
  assert.match(config, /trusted_hash = "sha256:[0-9a-f]{64}"/);
});

test('Codex hook trust keys use the final on-disk path of CODEX_HOME (short names, directory links)', () => {
  // Codex canonicalizes CODEX_HOME before it builds trust keys; a TEMP like C:\Users\ABCDEF~1\... or a
  // junction would otherwise leave every Hub hook "new or changed" (Codex stops at Hooks need review).
  const { ensureCodexHookIntegration } = require('../core/codex-hook-integration');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'community-codex-link-'));
  const real = path.join(root, 'real'); const link = path.join(root, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, 'junction');
  const result = ensureCodexHookIntegration({ codexHome: path.join(link, 'home'), logger: {} });
  assert.deepEqual(result.errors, []);
  const finalHome = fs.realpathSync.native(path.join(real, 'home'));
  assert.equal(result.codexHome, finalHome);
  const config = fs.readFileSync(path.join(real, 'home', 'config.toml'), 'utf8');
  const keys = [...config.matchAll(/^\[hooks\.state\.'([^']+)'\]$/gm)].map(m => m[1]);
  assert.ok(keys.length >= 6);
  for (const key of keys) assert.ok(key.startsWith(path.join(finalHome, 'hooks.json') + ':'), key);
});

test('data directory and product naming are separate from any private installation', () => {
  const dataDir = require('../core/data-dir');
  const saved = process.env.CLAUDE_HUB_DATA_DIR;
  delete process.env.CLAUDE_HUB_DATA_DIR;
  try { assert.equal(path.basename(dataDir.getHubDataDir()), '.ai-hub-community'); }
  finally { if (saved !== undefined) process.env.CLAUDE_HUB_DATA_DIR = saved; }
  // 快捷方式和窗口标题用发行版的产品显示名（社区版 AI Hub Community，公司版另有名字）。
  assert.match(read('core/windows-shell-integration.js'), /require\('\.\/distribution'\)\.productName\}\.lnk/);
  assert.match(read('main.js'), /\$\{_productName\}.* v\$\{_pkgVersion\}/);
  assert.equal(require('../core/distribution').productName, require('../community-edition.json').productName || 'AI Hub Community');
});

test('API defaults point to official endpoints', () => {
  const config = read('core/hub-config.js');
  assert.match(config, /claude_api_base_url: 'https:\/\/api\.anthropic\.com'/);
  assert.match(config, /codex_api_base_url: 'https:\/\/api\.openai\.com\/v1'/);
  assert.match(config, /proxy: ''/);
});

// 用户 Codex 全局配置保护（npm test 命令行已近 Windows 8191 字符上限，新用例从这里引入）。
require('./unit-codex-user-config-guard.test.js');
