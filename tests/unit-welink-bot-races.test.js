'use strict';
// WeLink 私聊助理竞态（审查 wave1，真实定时器，不用 manual）：重连在途时睡醒/解锁不重复连；旧探针不掐新连接；
// 被别处占用的 1 分钟等待期唤醒不抢；身份作废停机时看门狗、探针一并收掉；服务端只回协议层 pong 也算活着。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('../core/company-assistant/welink-bot');

const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from('enc:' + s), decryptString: b => String(b).slice(4) };
class FakeWS {
  constructor() { this.sent = []; this.handlers = {}; this.on_ = {}; this.terminated = false; this.pings = 0; FakeWS.all.push(this); }
  static get last() { return FakeWS.all.at(-1); }
  addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
  on(name, fn) { (this.on_[name] ||= []).push(fn); }
  emit(name, ev = {}) { for (const fn of this.handlers[name] || []) fn(ev); for (const fn of this.on_[name] || []) fn(ev); }
  send(s) { this.sent.push(JSON.parse(s)); }
  ping() { this.pings += 1; }
  close() { this.emit('close', { code: 1000 }); }
  terminate() { this.terminated = true; this.emit('close', { code: 1006 }); }
  frame(o) { this.emit('message', { data: JSON.stringify(o) }); }
}
FakeWS.all = [];

function realBot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-bot-race-'));
  let now = Date.now();
  const logs = [];
  const a = { dir, now: () => now, changed() {}, read: (n, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return fb; } },
    write: (n, v) => fs.writeFileSync(path.join(dir, n), JSON.stringify(v)) };
  const bot = new B.WelinkBot(a, { safeStorage, welinkBot: { WebSocket: FakeWS, domain: 'example.com', mac: 'aa:bb', log: (e, d) => logs.push([e, d]), isOnline: () => true } });
  bot.saveCred({ ak: 'AK', sk: 'SK' });
  t.after(() => { bot.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { bot, logs, tick: ms => { now += ms; } };
}

test('重连还在握手时接连来 resume、unlock-screen：不重复连、不打断', t => {
  const { bot, logs } = realBot(t);
  bot.start();
  assert.ok(bot.watchdog, '非 manual：看门狗真的起了');
  const n = FakeWS.all.length;
  bot.wake('resume');
  bot.wake('unlock-screen');
  assert.equal(FakeWS.all.length, n, '在途窗口内不再新开连接');
  assert.equal(FakeWS.last.terminated, false);
  assert.equal(logs.filter(l => l[0] === 'wake-skip').length, 2);
});

test('解锁探针晚到：期间已经换了新连接，旧探针作废，不掐新连接', t => {
  const { bot, tick } = realBot(t);
  bot.start(); const ws1 = FakeWS.last; ws1.emit('open'); ws1.frame({ type: 'register_ok' });
  tick(B.STUCK_MS);
  bot.wake('unlock-screen');                     // 已就绪：只探心跳，挂上真实的 15 秒探针
  assert.ok(bot.probe, '探针已挂');
  const before = bot.lastRx;
  bot.wake('resume');                            // 紧接着睡醒：重连，换成新连接
  const ws2 = FakeWS.last;
  assert.notEqual(ws2, ws1);
  assert.equal(bot.probe, null, '新连接清掉旧探针');
  bot.probeCheck(before, 'unlock-screen', ws1);  // 旧探针晚到
  assert.equal(FakeWS.last, ws2);
  assert.equal(ws2.terminated, false);
});

test('同一助手被别处占用：1 分钟等待期内唤醒不抢，过了才重连', t => {
  const { bot, tick } = realBot(t);
  bot.start(); const ws = FakeWS.last; ws.emit('open');
  ws.frame({ type: 'register_rejected', reason: 'duplicate_connection' });
  tick(20000);                                   // 过了在途窗口，还在 1 分钟等待期里
  const n = FakeWS.all.length;
  bot.wake('resume');
  assert.equal(FakeWS.all.length, n);
  tick(41000);
  bot.wake('resume');
  assert.equal(FakeWS.all.length, n + 1);
});

test('身份作废停机：看门狗、探针都收掉，之后唤醒也不连', t => {
  const { bot } = realBot(t);
  bot.start(); const ws = FakeWS.last; ws.emit('open');
  ws.frame({ type: 'register_rejected', reason: 'revoked' });
  assert.equal(bot.stopped, true);
  assert.equal(bot.watchdog, null);
  assert.equal(bot.probe, null);
  assert.equal(ws.terminated, true, '拒绝后直接掐断');
  const n = FakeWS.all.length;
  bot.wake('resume');
  assert.equal(FakeWS.all.length, n);
});

test('心跳同时发协议层 ping；服务端只回 pong 也算活着，不会 5 分钟误判重连；计数进关闭日志', t => {
  const { bot, logs, tick } = realBot(t);
  bot.start(); const ws = FakeWS.last; ws.emit('open'); ws.frame({ type: 'register_ok' });
  for (let i = 0; i < 12; i += 1) { tick(30000); bot.heartbeatTick(); ws.emit('pong'); }
  assert.equal(ws.terminated, false, '6 分钟里只收到 pong，没有误判');
  assert.equal(ws.pings, 12);
  assert.ok(logs.some(l => l[0] === 'ws-pong'));
  ws.emit('close', { code: 1001 });
  const close = logs.find(l => l[0] === 'close')[1];
  assert.equal(close.wsPongs, 12);
  assert.equal(close.hbReplies, 0, '应用层心跳没回过');
});
