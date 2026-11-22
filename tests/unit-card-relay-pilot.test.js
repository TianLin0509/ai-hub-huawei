'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const mode = require('../core/card-run-mode');
const { CardRelay, sessionBusy } = require('../core/card-relay');
const { DshCardHost, HostedAcpClient, acquireDshCardHost, shutdownDshCardHosts, CAPACITY } = require('../core/dsh-card-host');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const company = { companyCli: true, claudeBackend: 'proxy', dshBackend: 'proxy' };

test('运行方式：默认 PTY，只有公司反代线路的普通会话能走卡片', () => {
  assert.equal(mode.usesCardDriver('claude', {}, company), false);
  assert.equal(mode.usesCardDriver('claude', { cardRunMode: 'card' }, company), true);
  assert.equal(mode.usesCardDriver('deepseek-acp', { cardRunMode: 'card' }, company), true);
  assert.equal(mode.usesCardDriver('codex', { cardRunMode: 'card' }, company), false);
  assert.equal(mode.usesCardDriver('claude', { cardRunMode: 'card' }, { claudeBackend: 'subscription' }), false);
  assert.equal(mode.usesCardDriver('claude', { cardRunMode: 'card' }, { ...company, claudeBackend: 'subscription' }), false);
  assert.equal(mode.usesCardDriver('claude', { cardRunMode: 'card', cliApiProfileId: 'x' }, company), false);
  for (const extra of [{ meetingId: 'm' }, { teamId: 't' }, { purpose: 'hub-assistant' }, { resumePicker: true }]) {
    assert.equal(mode.usesCardDriver('claude', { cardRunMode: 'card', ...extra }, company), false);
  }
});

test('点了后台的卡片会话走 PTY，但仍属于卡片试点', () => {
  const opts = { cardRunMode: 'card', cardTerminal: true };
  assert.equal(mode.isCardSession('claude', opts, company), true);
  assert.equal(mode.usesCardDriver('claude', opts, company), false);
});

test('DSH 范围按线路、模型和账号区分，同条件相同', () => {
  const base = mode.dshCardScope({ dshBackend: 'proxy', dshUpstream: 'gateway' }, { model: 'm1' });
  assert.equal(base, mode.dshCardScope({ dshBackend: 'proxy', dshUpstream: 'gateway' }, { model: 'm1' }));
  assert.notEqual(base, mode.dshCardScope({ dshBackend: 'proxy', dshUpstream: '' }, { model: 'm1' }));
  assert.notEqual(base, mode.dshCardScope({ dshBackend: 'proxy', dshUpstream: 'gateway' }, { model: 'm2' }));
  assert.match(base, /^[a-f0-9]{24}$/);
});

test('Claude 结构化通道用定位中心找到的真实程序，找不到时给出明确提示', () => {
  const locator = result => ({ launchSpec: () => result });
  assert.deepEqual(mode.claudeCardLaunch({}, locator({ command: 'C:/npm/claude.exe', args: [] })), { executable: 'C:/npm/claude.exe', commandArgs: [] });
  assert.deepEqual(mode.claudeCardLaunch({}, locator({ command: 'node.exe', args: ['cli.js'] })), { executable: 'node.exe', commandArgs: ['cli.js'] });
  assert.throws(() => mode.claudeCardLaunch({}, locator({ command: 'claude.cmd', args: [], shell: 'cmd' })), /Claude Code/);
  assert.throws(() => mode.claudeCardLaunch({}, locator(null)), /Claude Code/);
});

function warmupHarness() {
  const { createTerminalWarmup } = require('../renderer/terminal-warmup');
  let now = 0, nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) { const id = nextId++; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { pending.delete(id); },
  };
  const advance = ms => {
    const end = now + ms;
    for (;;) {
      const due = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  const views = [];
  const mount = () => { const view = { state: 'shown', slowed: false, slow() { this.slowed = true; }, leave() { this.state = 'left'; }, remove() { this.state = 'removed'; } }; views.push(view); return view; };
  return { warmup: createTerminalWarmup({ mount, timers }), advance, views };
}

test('过渡动画：很快就绪或终端已开着时不出现', () => {
  const { warmup, advance, views } = warmupHarness();
  warmup.begin('a');
  warmup.output('a', '\x1b[2J\x1b[Hhello terminal ready');
  advance(1000);
  assert.equal(views.length, 0);
  warmup.begin('b');
  warmup.cancel('b');
  advance(1000);
  assert.equal(views.length, 0);
});

test('过渡动画：冷启动才出现，控制序列不算内容，画出内容后淡出', () => {
  const { warmup, advance, views } = warmupHarness();
  warmup.begin('a');
  advance(200);
  assert.equal(views.length, 1);
  warmup.output('a', '\x1bc\x1b[?25l\x1b]0;title\x07\r\n');
  advance(500);
  assert.equal(views[0].state, 'shown');
  warmup.output('a', 'Claude Code is ready');
  advance(200);
  assert.equal(views[0].state, 'left');
  assert.equal(warmup.activeSession(), null);
});

test('过渡动画：等待久了换提示，切走立即消失，超时不会一直盖着', () => {
  const first = warmupHarness();
  first.warmup.begin('a');
  first.advance(9000);
  assert.equal(first.views[0].slowed, true);
  first.warmup.cancel();
  assert.equal(first.views[0].state, 'removed');
  const second = warmupHarness();
  second.warmup.begin('a');
  second.advance(149000);
  assert.equal(second.views[0].state, 'shown');
  second.advance(2000);
  assert.equal(second.views[0].state, 'left');
});

test('配置写入保留其他运行方式', () => {
  const next = mode.withCardModeInJson({ runtime: { agent: 'pty', cardRunModes: { claude: 'card' } } }, 'deepseek-acp', 'card');
  assert.deepEqual(next.runtime.cardRunModes, { claude: 'card', 'deepseek-acp': 'card' });
  assert.equal(next.runtime.agent, 'pty');
  assert.deepEqual(mode.cardModesFrom({ claude: 'x' }), { claude: 'pty', 'deepseek-acp': 'pty' });
});

class FakeAcp extends EventEmitter {
  constructor() { super(); this.calls = []; this.incoming = new Set(); this.proc = { pid: 4321 }; this.closed = false; }
  async start() { return { protocolVersion: 1, agentCapabilities: {} }; }
  request(method, params) {
    this.calls.push([method, params]);
    if (method === 'session/new') return Promise.resolve({ sessionId: 'sid-' + this.calls.filter(c => c[0] === 'session/new').length });
    return Promise.resolve({});
  }
  notify() { return Promise.resolve(); }
  respond(id) { this.calls.push(['respond', id]); return Promise.resolve(); }
  close() { if (this.closed) return; this.closed = true; this.emit('disconnect', new Error('closed')); }
}
const newHost = () => {
  const fake = new FakeAcp();
  const host = new DshCardHost({ scope: 's', index: 0, tag: 't', createClient: () => fake, idleCloseMs: 10 });
  host.setLaunch({ command: 'x' });
  host.retain();
  return { host, fake };
};

function relayHarness(info = {}) {
  const entry = { info: { cardRunMode: 'card', cardTerminal: false, nativeRuntime: { connection: 'connected', state: 'idle' }, ...info } };
  const restarts = [];
  const events = [];
  const relay = new CardRelay({
    sessions: { getRaw: () => entry, updateMeta: (_id, fields) => Object.assign(entry.info, fields) },
    restart: async () => { restarts.push(entry.info.cardTerminal); return { ok: true }; },
    notify: (...args) => events.push(args), keepMs: 20, pollMs: 5,
  });
  return { entry, relay, restarts, events };
}

test('空闲时点后台立即切到终端，离开后保温再切回', async () => {
  const { entry, relay, restarts } = relayHarness();
  assert.equal((await relay.attach('s')).ok, true);
  assert.deepEqual(restarts, [true]);
  relay.detach('s');
  await wait(50);
  assert.deepEqual(restarts, [true, false]);
  assert.equal(entry.info.cardTerminal, false);
  relay.shutdown();
});

test('保温期内再次打开后台不切换', async () => {
  const { relay, restarts } = relayHarness();
  await relay.attach('s');
  relay.detach('s');
  await relay.attach('s');
  await wait(40);
  assert.deepEqual(restarts, [true]);
  relay.shutdown();
});

test('回答中点后台不打断，答完才切', async () => {
  const { entry, relay, restarts } = relayHarness({ nativeRuntime: { connection: 'connected', state: 'running' } });
  const result = await relay.attach('s');
  assert.equal(result.pending, true);
  await wait(20);
  assert.deepEqual(restarts, []);
  entry.info.nativeRuntime = { connection: 'connected', state: 'completed' };
  await wait(30);
  assert.deepEqual(restarts, [true]);
  relay.shutdown();
});

test('终端正在回答时不切回卡片', async () => {
  const { entry, relay, restarts } = relayHarness({ cardTerminal: true });
  entry.agentTurnActive = true;
  relay.detach('s');
  await wait(45);
  assert.deepEqual(restarts, []);
  entry.agentTurnActive = false;
  await wait(30);
  assert.deepEqual(restarts, [false]);
  relay.shutdown();
});

test('切换失败时标记复原并提示', async () => {
  const entry = { info: { cardRunMode: 'card', cardTerminal: false, nativeRuntime: { connection: 'connected', state: 'idle' } } };
  const notes = [];
  const relay = new CardRelay({ sessions: { getRaw: () => entry, updateMeta: (_id, f) => Object.assign(entry.info, f) },
    restart: async () => ({ ok: false, message: '模拟失败' }), notify: (...a) => notes.push(a), keepMs: 10, pollMs: 5 });
  const result = await relay.attach('s');
  assert.equal(result.ok, false);
  assert.equal(entry.info.cardTerminal, false);
  assert.match(notes[0][2], /模拟失败/);
  relay.shutdown();
});

test('打开终端失败后不自动重试，再点一次才重试', async () => {
  const entry = { info: { cardRunMode: 'card', cardTerminal: false, nativeRuntime: { connection: 'connected', state: 'idle' } } };
  let calls = 0, fail = true;
  const relay = new CardRelay({ sessions: { getRaw: () => entry, updateMeta: (_id, f) => Object.assign(entry.info, f) },
    restart: async () => { calls += 1; return fail ? { ok: false, message: '模拟失败' } : { ok: true }; }, notify: () => {}, keepMs: 10, pollMs: 2 });
  assert.equal((await relay.attach('s')).notified, true);
  await wait(30);
  assert.equal(calls, 1);
  fail = false;
  assert.equal((await relay.attach('s')).ok, true);
  assert.equal(calls, 2);
  assert.equal(entry.info.cardTerminal, true);
  relay.shutdown();
});

test('切换途中会话短暂消失时点后台，切完按最新意图继续', async () => {
  const entry = { info: { cardRunMode: 'card', cardTerminal: true, nativeRuntime: { connection: 'connected', state: 'idle' } } };
  let present = true, release;
  const restarts = [];
  const relay = new CardRelay({ sessions: { getRaw: () => (present ? entry : undefined), updateMeta: (_id, f) => Object.assign(entry.info, f) },
    restart: async () => { restarts.push(entry.info.cardTerminal); if (restarts.length === 1) { present = false; await new Promise(r => { release = r; }); present = true; } return { ok: true }; },
    keepMs: 5, pollMs: 2 });
  relay.detach('s');
  await wait(20);
  assert.equal((await relay.attach('s')).pending, true);
  release();
  await wait(30);
  assert.deepEqual(restarts, [false, true]);
  assert.equal(entry.info.cardTerminal, true);
  relay.shutdown();
});

test('释放会话第一次失败时重试一次', async () => {
  const { host, fake } = newHost();
  const a = new HostedAcpClient(host);
  await a.start();
  await a.request('session/new', {});
  const original = fake.request.bind(fake);
  let closes = 0;
  fake.request = (method, params) => {
    if (method !== 'session/close') return original(method, params);
    closes += 1;
    return closes === 1 ? Promise.reject(new Error('busy')) : Promise.resolve({});
  };
  await a.release();
  assert.equal(closes, 2);
  host.stop();
});

test('忙闲判断覆盖结构化和终端两种状态', () => {
  assert.equal(sessionBusy({ info: { nativeRuntime: { connection: 'connected', state: 'idle' } } }), false);
  assert.equal(sessionBusy({ info: { nativeRuntime: { connection: 'connected', state: 'running' } } }), true);
  assert.equal(sessionBusy({ info: { cliRuntime: { connection: 'connected', state: 'waiting' } } }), true);
  assert.equal(sessionBusy({ info: {}, agentTurnActive: true }), true);
  assert.equal(sessionBusy({ info: { nativeRuntime: { connection: 'disconnected', state: 'idle' } } }), true);
});

test('DSH 共享进程的启动等待和真实终端一致，电脑忙时不误报失败', async () => {
  let options;
  const host = new DshCardHost({ scope: 's', index: 0, tag: 't', createClient: value => { options = value; return new FakeAcp(); } });
  host.setLaunch({ command: 'x' });
  await host.ensure();
  assert.equal(options.timeoutMs, 150000);
  host.stop();
});

test('共享进程按 sessionId 分流通知和请求', async () => {
  const { host, fake } = newHost();
  const a = new HostedAcpClient(host), b = new HostedAcpClient(host);
  await a.start(); await b.start();
  const sa = (await a.request('session/new', {})).sessionId;
  const sb = (await b.request('session/new', {})).sessionId;
  const seenA = [], seenB = [];
  a.on('notification', m => seenA.push(m)); b.on('notification', m => seenB.push(m));
  b.on('request', m => seenB.push(m));
  fake.emit('notification', { method: 'session/update', params: { sessionId: sa, n: 1 } });
  fake.emit('notification', { method: 'session/update', params: { sessionId: sb, n: 2 } });
  fake.emit('request', { id: 9, method: 'session/request_permission', params: { sessionId: sb } });
  assert.equal(seenA.length, 1); assert.equal(seenA[0].params.n, 1);
  assert.equal(seenB.length, 2);
  host.stop();
});

test('session/new 结果前到达的通知不丢', async () => {
  const { host, fake } = newHost();
  const a = new HostedAcpClient(host);
  await a.start();
  fake.emit('notification', { method: 'session/update', params: { sessionId: 'sid-1', early: true } });
  const seen = [];
  a.on('notification', m => seen.push(m));
  await a.request('session/new', {});
  assert.equal(seen.length, 1);
  host.stop();
});

test('释放一个会话只发 session/close，不影响其他会话', async () => {
  const { host, fake } = newHost();
  const a = new HostedAcpClient(host), b = new HostedAcpClient(host);
  await a.start(); await b.start();
  const sa = (await a.request('session/new', {})).sessionId;
  await b.request('session/new', {});
  let bLost = false;
  b.on('disconnect', () => { bLost = true; });
  await a.release();
  assert.deepEqual(fake.calls.filter(c => c[0] === 'session/close').map(c => c[1].sessionId), [sa]);
  assert.equal(bLost, false);
  assert.equal(fake.closed, false);
  host.stop();
});

test('共享进程断开时所有会话都收到通知', async () => {
  const { host, fake } = newHost();
  const a = new HostedAcpClient(host), b = new HostedAcpClient(host);
  await a.start(); await b.start();
  await a.request('session/new', {}); await b.request('session/new', {});
  let lost = 0;
  a.on('disconnect', () => { lost += 1; }); b.on('disconnect', () => { lost += 1; });
  fake.emit('disconnect', new Error('crash'));
  assert.equal(lost, 2);
  assert.equal(host.client, null);
  host.stop();
});

test('一个进程最多放满容量，再多开下一个并换 Key', () => {
  const hosts = [];
  for (let i = 0; i < CAPACITY + 1; i++) hosts.push(acquireDshCardHost('pool-scope', { createClient: () => new FakeAcp() }));
  assert.equal(new Set(hosts.slice(0, CAPACITY)).size, 1);
  assert.notEqual(hosts[CAPACITY], hosts[0]);
  assert.notEqual(hosts[CAPACITY].tag, hosts[0].tag);
  assert.equal(shutdownDshCardHosts(), 2);
});

test('最后一个会话释放后延时关闭进程', async () => {
  const { host, fake } = newHost();
  await host.ensure();
  host.release();
  await wait(30);
  assert.equal(host.stopped, true);
  assert.equal(fake.closed, true);
});
