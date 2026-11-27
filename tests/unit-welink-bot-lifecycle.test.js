'use strict';
// WeLink 私聊助理断线根治（2026-11-27）：生命周期日志不含凭据与正文；重连不设永久上限、退避封顶 5 分钟；
// 看门狗（卡住 2 分钟 / 连接丢了没排重连）、睡眠唤醒、解锁、网络恢复立即重连；收包超时直接掐断重连。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('../core/company-assistant/welink-bot');

const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from('enc:' + s), decryptString: b => String(b).slice(4) };
class FakeWS {
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.sent = []; this.handlers = {}; this.terminated = false; FakeWS.all.push(this); }
  static get last() { return FakeWS.all.at(-1); }
  addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
  emit(name, ev = {}) { for (const fn of this.handlers[name] || []) fn(ev); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.emit('close', { code: 1000, reason: '' }); }
  terminate() { this.terminated = true; this.emit('close', { code: 1006, reason: '' }); }
  frame(o) { this.emit('message', { data: JSON.stringify(o) }); }
}
FakeWS.all = [];

function fixture({ online = () => true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-bot-life-'));
  let now = 1_800_000_000_000;
  const logs = [];
  const a = { dir, now: () => now, changed() {}, read: (n, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return fb; } },
    write: (n, v) => fs.writeFileSync(path.join(dir, n), JSON.stringify(v)) };
  const bot = new B.WelinkBot(a, { safeStorage, welinkBot: { manual: true, WebSocket: FakeWS, domain: 'example.com', mac: 'aa:bb', log: (e, d) => logs.push([e, d]), isOnline: online } });
  bot.saveCred({ ak: 'AK-SECRET-1', sk: 'SK-SECRET-2' });
  return { bot, logs, tick: ms => { now += ms; }, dir };
}
const ready = bot => { bot.start(); const ws = FakeWS.last; ws.emit('open'); ws.frame({ type: 'register_ok' }); return ws; };

test('生命周期日志：connect / open / ready / close(code) / retry 都记，不含 AK/SK 与消息正文', () => {
  const { bot, logs } = fixture();
  const ws = ready(bot);
  ws.frame({ action: 'chat', payload: { text: '这是一条私聊正文', sendUserAccount: 'u1' } });
  ws.frame({ type: 'heartbeat' });
  ws.emit('error', { message: 'socket hang up' });
  ws.emit('close', { code: 1006, reason: 'abnormal' });
  bot.manual = false; bot.later(); clearTimeout(bot.retry);
  const names = logs.map(l => l[0]);
  for (const e of ['connect', 'open', 'ready', 'heartbeat-reply', 'error', 'close', 'retry']) assert.ok(names.includes(e), '缺少 ' + e);
  const close = logs.find(l => l[0] === 'close')[1];
  assert.equal(close.code, 1006);
  assert.equal(close.was, 'ready');
  assert.equal(close.hbReplies, 1);
  const dump = JSON.stringify(logs);
  assert.equal(/AK-SECRET|SK-SECRET|私聊正文/.test(dump), false, '日志不含凭据与正文');
});

test('重连不设永久上限：退避 5 秒起翻倍、封顶 5 分钟，一直排下去', () => {
  const { bot, logs } = fixture();
  bot.manual = false; bot.stopped = false;
  const delays = [];
  for (let i = 0; i < 12; i += 1) { bot.later(); delays.push(logs.at(-1)[1].delayMs); clearTimeout(bot.retry); bot.retry = null; }
  assert.deepEqual(delays.slice(0, 7), [5000, 10000, 20000, 40000, 80000, 160000, 300000]);
  assert.ok(delays.slice(6).every(d => d === B.BACKOFF_MAX_MS));
  bot.close();
});

test('5 分钟收不到任何包：直接掐断（terminate）并立即重连，不等关闭握手', () => {
  const { bot, tick } = fixture();
  const ws = ready(bot);
  const before = FakeWS.all.length;
  tick(B.RX_IDLE_MS + 1000);
  bot.heartbeatTick();
  assert.equal(ws.terminated, true);
  assert.equal(FakeWS.all.length, before + 1, '马上新开一条连接');
  assert.equal(bot.phase, 'connecting');
});

test('心跳：就绪后按节拍发 heartbeat 并计数；register_ok 后再来 ready 不重复就绪', () => {
  const { bot, logs } = fixture();
  const ws = ready(bot);
  ws.frame({ type: 'ready' });
  assert.equal(logs.filter(l => l[0] === 'ready').length, 1);
  bot.heartbeatTick(); bot.heartbeatTick();
  assert.equal(ws.sent.filter(f => f.type === 'heartbeat').length, 2);
  assert.equal(bot.connStats().hbSent, 2);
  clearInterval(bot.hb);
});

test('看门狗：卡在注册中超过 2 分钟就重连；连接丢了又没排重连也重连；正常就绪不动', () => {
  const { bot, tick } = fixture();
  bot.start(); FakeWS.last.emit('open');                 // 停在 registering
  assert.equal(bot.tick(), null);
  tick(B.STUCK_MS + 1);
  assert.equal(bot.tick(), 'stuck');
  FakeWS.last.emit('open'); FakeWS.last.frame({ type: 'register_ok' });
  tick(10 * 60000);
  assert.equal(bot.tick(), null, '就绪时不动');
  bot.manual = false; bot.ws = null; bot.phase = 'idle'; bot.retry = null;
  assert.equal(bot.tick(), 'lost');
  bot.close();
});

test('睡眠唤醒：直接重连；解锁时已就绪先探心跳，没回音才重连；网络恢复按解锁处理', () => {
  let online = true;
  const { bot, logs } = fixture({ online: () => online });
  let ws = ready(bot);
  bot.wake('resume');
  assert.equal(ws.terminated, true);
  ws = FakeWS.last; ws.emit('open'); ws.frame({ type: 'register_ok' });
  const n = FakeWS.all.length;
  bot.wake('unlock-screen');
  assert.equal(FakeWS.all.length, n, '已就绪：先不断');
  assert.equal(ws.sent.at(-1).type, 'heartbeat');
  bot.probeCheck(bot.lastRx, 'unlock-screen');          // 15 秒内一个包都没收到
  assert.equal(FakeWS.all.length, n + 1);
  ws = FakeWS.last; ws.emit('open'); ws.frame({ type: 'register_ok' });
  online = false; assert.equal(bot.tick(), 'offline');
  online = true; assert.equal(bot.tick(), 'network');
  assert.ok(logs.some(l => l[0] === 'wake' && l[1].reason === 'network'));
  bot.close();
});

test('关掉之后：唤醒、看门狗都不再重连；凭据读不出来时看门狗不空转', () => {
  const { bot } = fixture();
  ready(bot);
  bot.close();
  const n = FakeWS.all.length;
  bot.wake('resume'); bot.tick();
  assert.equal(FakeWS.all.length, n);
  const f = fixture();
  fs.writeFileSync(f.bot.credFile(), 'garbage');
  f.bot.safe = () => ({ decryptString: () => { throw new Error('bad'); } });
  f.bot.start();
  f.bot.manual = false;
  assert.equal(f.bot.tick(), null);
  f.bot.close();
});

test('远端原文不进日志：关闭原因、错误信息、拒绝理由里带 sk / token / 正文时，日志只留类别和数字', () => {
  const { bot, logs } = fixture();
  const ws = ready(bot);
  ws.emit('error', { message: 'Unexpected server response: 401 token=tok_ABC123 body=这是一条私聊正文' });
  ws.emit('close', { code: 4401, reason: 'sk=SK-SECRET-2 私聊正文 token tok_ABC123' });
  bot.stopped = false; bot.connect(); const ws2 = FakeWS.last; ws2.emit('open');
  ws2.frame({ type: 'register_rejected', reason: 'bad sign sk=SK-SECRET-2 token=tok_ABC123' });
  const dump = JSON.stringify(logs);
  for (const leak of ['SK-SECRET', 'tok_ABC123', '私聊正文', 'bad sign', 'Unexpected server']) assert.equal(dump.includes(leak), false, '日志里不能有 ' + leak);
  assert.deepEqual(logs.find(l => l[0] === 'register-rejected')[1], { reasonKind: 'other' });
  assert.deepEqual(logs.find(l => l[0] === 'error')[1], { kind: 'http-401' });
  const close = logs.find(l => l[0] === 'close')[1];
  assert.equal(close.code, 4401);
  assert.equal(close.reasonKind, 'other');
  assert.equal(B.reasonKind('duplicate_connection'), 'duplicate_connection');
  assert.equal(B.errorKind({ error: { code: 'ECONNREFUSED' } }), 'econnrefused');
  assert.deepEqual(B.safeLogDetail({ kind: B.errorKind({ error: { code: 'ECONNRESET' } }) }), { kind: 'econnreset' }, '错误码类别能过日志白名单');
});

test('日志白名单：未知字段、长串、含空格的字符串一律丢掉', () => {
  assert.deepEqual(B.safeLogDetail({ code: 1000, was: 'ready', secret: 'x', reason: 'has space token', phase: 'A'.repeat(60), ms: 12, ok: true }), { code: 1000, was: 'ready', ms: 12 });
});


test('图片、文件等非文字私聊：日志只记字段名和类型（不记值），并交给手机通道认人后回提示', () => {
  const { bot, logs } = fixture();
  const got = [];
  bot.onChat = m => got.push(m);
  const ws = ready(bot);
  ws.frame({ action: 'chat', payload: { msgType: 'IMAGE', fileUrl: 'https://files/secret-path.png', sendUserAccount: 'u1', a9b8c7: 'x', ext: { size: 12 } } });
  const keys = logs.find(l => l[0] === 'non-text-chat')[1].keys;
  assert.match(keys, /msgType:string/);
  assert.match(keys, /fileUrl:string/);
  assert.match(keys, /ext:\{size:number\}/);
  assert.equal(/secret-path|IMAGE|u1|a9b8c7/.test(JSON.stringify(logs)), false);
  assert.equal(got[0].nonText, true);
  clearInterval(bot.hb);
});
