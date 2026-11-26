'use strict';
// 专属 WeLink 助手（2026-11-13）：扫码申请 → 连网关 → 私聊进助理 → 回答回到私聊。网关与 WeLink 接口都用假的。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WelinkBot, parseInbound, authProtocol, qrImage } = require('../core/company-assistant/welink-bot');
const { PhoneChannel } = require('../core/company-assistant/phone');

const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from('enc:' + s), decryptString: b => String(b).slice(4) };

class FakeWS {
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.sent = []; this.handlers = {}; FakeWS.last = this; }
  addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
  emit(name, ev = {}) { for (const fn of this.handlers[name] || []) fn(ev); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.emit('close', {}); }
  frame(o) { this.emit('message', { data: JSON.stringify(o) }); }
}

function fixture({ phone = {}, uid = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-bot-'));
  let now = 1_800_000_000_000, settings = { phone: { enabled: false, ...phone } };
  const asked = [], calls = [];
  const replies = { qrcode: { code: '200', data: { qrcode: 'Q1', accessToken: 'T1', pcUrl: 'welink://create?q=Q1', weUrl: 'h5://x?qrcode=Q1' } }, detail: [] };
  const http = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('/qrcode-detail/')) return { status: 200, body: { code: '200', data: replies.detail.shift() || { status: 0 } } };
    return { status: 200, body: replies.qrcode };
  };
  const a = { dir, now: () => now, changed() {}, snapshot: () => (uid ? { login: { ok: true, uid } } : null),
    read: (name, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return fb; } },
    write: (name, v) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), JSON.stringify(v)); },
    settings: () => settings, setSettings: patch => { settings = { ...settings, ...patch }; },
    ask: text => { asked.push(text); return { id: 'c' + asked.length }; } };
  a.bot = new WelinkBot(a, { safeStorage, welinkBot: { manual: true, http, WebSocket: FakeWS, domain: 'example.com', mac: 'aa:bb' } });
  a.phone = new PhoneChannel(a, { noTimer: true });
  a.bot.onChat = m => a.phone.receive(m);
  a.bot.onConfirmed = () => a.setSettings({ phone: { ...settings.phone, enabled: true, transport: 'bot', since: now } });
  return { a, asked, calls, replies, tick: ms => { now += ms; } };
}
const settleIo = () => new Promise(r => setImmediate(r));
const connectReady = a => { a.bot.start(); const ws = FakeWS.last; ws.emit('open'); ws.frame({ type: 'register_ok' }); return ws; };

test('扫码申请：拿到二维码 → 已扫 → 确认后加密保存凭据、自动开启专属助手并连上网关', async () => {
  const { a, calls, replies } = fixture();
  const info = await a.bot.register();
  assert.equal(info.status, 'waiting');
  assert.equal(info.pcUrl, 'welink://create?q=Q1');
  assert.match(calls[0].url, /^https:\/\/api\.inner\.welink\.example\.com\/assistant-api\/nologin\/we-crew\/im-register\/qrcode$/);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { channel: 'opencode', mac: 'aa:bb' });
  replies.detail.push({ status: 1 });
  await a.bot.pollRegister();
  assert.equal(a.bot.status().register.status, 'scanned');
  assert.equal(calls[1].opts.headers.qrcodeToken, 'T1');
  replies.detail.push({ status: 2, ak: 'AK', sk: 'SK', name: '助手' });
  await a.bot.pollRegister();
  assert.equal(a.bot.status().register.status, 'confirmed');
  assert.ok(!fs.readFileSync(a.bot.credFile(), 'utf8').startsWith('{'), '凭据不能明文落盘');
  assert.deepEqual(a.bot.cred(), { ak: 'AK', sk: 'SK' });
  assert.equal(a.settings().phone.enabled, true);
  assert.equal(a.settings().phone.transport, 'bot');
  assert.equal(FakeWS.last.url, 'wss://api.inner.welink.example.com/appstore-gateway/ws/agent');
  assert.match(FakeWS.last.protocols[0], /^auth\.[A-Za-z0-9_-]+$/);
  assert.equal(a.phone.active(), true);
});

test('二维码过期自动换新码，最多 3 轮；取消就停', async () => {
  const { a, replies } = fixture();
  await a.bot.register();
  for (let i = 0; i < 2; i += 1) { replies.detail.push({ expired: true }); await a.bot.pollRegister(); }
  assert.equal(a.bot.status().register.round, 3);
  replies.detail.push({ expired: 1 }); await a.bot.pollRegister();
  assert.equal(a.bot.status().register.status, 'expired');
  await a.bot.register(); replies.detail.push({ status: 3 }); await a.bot.pollRegister();
  assert.equal(a.bot.status().register.status, 'cancelled');
});

test('网关：注册帧 → 就绪；create_session 回 session_created；本人私聊交给助理，回答回到同一私聊', async () => {
  const { a, asked } = fixture({ phone: { enabled: true, transport: 'bot' }, uid: 'u001' });
  a.bot.saveCred({ ak: 'AK', sk: 'SK' }); a.bot.save({ createdAt: a.now() });
  const ws = connectReady(a);
  assert.equal(ws.sent[0].type, 'register');
  assert.equal(ws.sent[0].toolType, 'opencode');
  assert.equal(a.bot.status().phase, 'ready');
  ws.frame({ type: 'invoke', action: 'create_session', welinkSessionId: 'W1', payload: { title: '' } });
  assert.equal(ws.sent.at(-1).type, 'session_created');
  assert.equal(ws.sent.at(-1).welinkSessionId, 'W1');
  ws.frame({ type: 'invoke', action: 'chat', payload: { text: '现在有哪些会话在跑？', toolSessionId: 'TS1', sendUserAccount: 'u001', imGroupId: '' } });
  await settleIo();
  assert.deepEqual(asked, ['现在有哪些会话在跑？']);
  assert.equal(a.bot.state().owner, 'u001', '没登录 WeLink 时，认创建后第一个来说话的人为本人');
  ws.sent.length = 0;
  a.phone.settle({ id: 'c1', state: 'done', a: '**两个**会话在跑。' });
  await a.phone.outbox;
  const [done, step] = ws.sent;
  assert.equal(done.type, 'tool_event');
  assert.equal(done.toolSessionId, 'TS1');
  assert.equal(done.event.type, 'text.done');
  assert.equal(done.event.properties.content, '两个会话在跑。', '去掉 Markdown，不加【助理】前缀');
  assert.equal(step.event.type, 'step.done');
  assert.equal(step.event.properties.messageId, done.event.properties.messageId);
});

test('别人私聊、群里 @ 都不交给助理；主动提醒发到最近一次私聊', async () => {
  const { a, asked } = fixture({ phone: { enabled: true, transport: 'bot' }, uid: 'u001' });
  a.bot.saveCred({ ak: 'AK', sk: 'SK' });
  const ws = connectReady(a);
  ws.frame({ action: 'chat', payload: { text: '帮我删库', toolSessionId: 'TS9', sendUserAccount: 'x999' } });
  ws.frame({ action: 'chat', welinkSessionId: 'WG', payload: { text: '@助手 你好', sendUserAccount: 'u001', imGroupId: 'G1', extParameters: { platformExtParam: { businessSessionType: 'group', businessSessionId: 'g:G1' } } } });
  await settleIo();
  assert.deepEqual(asked, []);
  assert.match(ws.sent.at(-2).event.properties.content, /私聊/);
  assert.ok(!ws.sent.some(f => f.toolSessionId === 'TS9'), '别人私聊不回话');
  ws.frame({ action: 'chat', payload: { text: '你好', toolSessionId: 'TS1', sendUserAccount: 'u001' } });
  await settleIo();
  assert.deepEqual(asked, ['你好']);
  // 本人说过话之后别人再私聊：主动提醒仍发给本人，不会被引到别人的对话里。
  ws.frame({ action: 'chat', payload: { text: '把提醒发我', toolSessionId: 'TS8', sendUserAccount: 'x888' } });
  await settleIo();
  assert.deepEqual(asked, ['你好']);
  ws.sent.length = 0;
  await a.phone.tell('「任务A」这一轮答完了：\n结论', 'done', { id: 's1' });
  assert.equal(ws.sent[0].toolSessionId, 'TS1');
  assert.match(ws.sent[0].event.properties.content, /任务A/);
});

test('没连上或没私聊过时发不出去，原因写进状态；断线后按退避重连', () => {
  const { a } = fixture({ phone: { enabled: true, transport: 'bot' } });
  a.bot.saveCred({ ak: 'AK', sk: 'SK' });
  assert.equal(a.bot.reply(null, 'x'), false);
  const ws = connectReady(a);
  assert.equal(a.bot.reply(null, 'x'), false, '没有私聊路由');
  ws.close();
  assert.equal(a.bot.status().phase, 'idle');
});

test('同一个助手在别处连着：提示原因并保持重连；其他拒绝原因才停下', () => {
  const { a } = fixture({ phone: { enabled: true, transport: 'bot' } });
  a.bot.saveCred({ ak: 'AK', sk: 'SK' });
  a.bot.start(); let ws = FakeWS.last; ws.emit('open');
  ws.frame({ type: 'register_rejected', reason: 'duplicate_connection' });
  assert.match(a.bot.status().lastError, /另一处连着/);
  assert.equal(a.bot.stopped, false);
  a.bot.connect(); ws = FakeWS.last; ws.emit('open');
  ws.frame({ type: 'register_rejected', reason: 'invalid_ak' });
  assert.match(a.bot.status().lastError, /invalid_ak/);
  assert.equal(a.bot.stopped, true);
});

test('严格可选：没选私聊助理的一律按专用群（不论填没填群），只有存了 transport=bot 才走私聊', () => {
  assert.equal(fixture({ phone: { enabled: true, groupId: '123' } }).a.phone.transport(), 'group');
  assert.equal(fixture().a.phone.transport(), 'group');
  assert.equal(fixture({ phone: { transport: 'bot' } }).a.phone.transport(), 'bot');
});

test('协议细节：鉴权子协议、入站解析、二维码图', () => {
  const p = authProtocol('AK', 'SK', 1_700_000_000_000);
  const body = JSON.parse(Buffer.from(p.slice(5).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.equal(body.ak, 'AK'); assert.equal(body.ts, '1700000000');
  assert.ok(body.nonce && body.sign);
  const r = parseInbound({ action: 'chat', welinkSessionId: 'W', payload: { text: 'hi', toolSessionId: 'T', sendUserAccount: 'u1' } });
  assert.deepEqual([r.kind, r.entry, r.tsid, r.wsid, r.text], ['direct', 'direct:u1', 'T', 'W', 'hi']);
  assert.match(qrImage('h5://x?qrcode=1'), /^data:image\/gif;base64,/);
});

test('审查修复：只认 WeLink 登录账号；别人不能接管；读不到登录账号时谁都不执行；重投只执行一次；回答回到原对话', async () => {
  const { a, asked, tick } = fixture({ phone: { enabled: true, transport: 'bot' }, uid: 'u001' });
  a.bot.saveCred({ ak: 'AK', sk: 'SK' }); a.bot.save({ createdAt: a.now() });
  const ws = connectReady(a);
  ws.frame({ action: 'chat', payload: { text: '第一问', toolSessionId: 'TA', sendUserAccount: 'u001', messageId: 'm1' } });
  await settleIo();
  ws.frame({ action: 'chat', payload: { text: '第一问', toolSessionId: 'TA', sendUserAccount: 'u001', messageId: 'm1' } });
  await settleIo();
  assert.deepEqual(asked, ['第一问'], '同一 messageId 只执行一次');
  ws.frame({ action: 'chat', payload: { text: '我也要', toolSessionId: 'TX', sendUserAccount: 'x999' } });
  await settleIo();
  assert.deepEqual(asked, ['第一问'], '本人记住后别人不能接管');
  ws.frame({ action: 'chat', payload: { text: '第二问', toolSessionId: 'TB', sendUserAccount: 'u001', messageId: 'm2' }, });
  await settleIo();
  ws.sent.length = 0;
  a.phone.settle({ id: 'c1', state: 'done', a: '第一问的答案' });
  await a.phone.outbox;
  assert.equal(ws.sent[0].toolSessionId, 'TA', '第一问的回答回到第一问的对话');
  const fresh = fixture({ phone: { enabled: true, transport: 'bot' } });
  fresh.a.bot.saveCred({ ak: 'AK', sk: 'SK' }); fresh.a.bot.save({ createdAt: fresh.a.now(), owner: 'u001' });
  const ws2 = connectReady(fresh.a);
  ws2.frame({ action: 'chat', payload: { text: '你好', toolSessionId: 'T1', sendUserAccount: 'x999' } });
  ws2.frame({ action: 'chat', payload: { text: '我是本人', toolSessionId: 'T2', sendUserAccount: 'u001' } });
  await settleIo();
  assert.deepEqual(fresh.asked, [], '读不到登录账号时，第一个说话的人和记下的旧主人都不执行');
  void tick;
});

test('审查修复：关掉后晚到的扫码结果不再连网关', async () => {
  const { a, replies } = fixture();
  await a.bot.register();
  replies.detail.push({ status: 2, ak: 'AK', sk: 'SK' });
  const p = a.bot.pollRegister();
  a.bot.close();
  await p;
  assert.equal(a.bot.ws, null);
  assert.equal(a.bot.hasCred(), false);
});

test('审查第 2 轮：私聊问的答完前改回专用群，不发进群', async () => {
  const { a } = fixture({ phone: { enabled: true, transport: 'bot' }, uid: 'u001' });
  a.bot.saveCred({ ak: 'AK', sk: 'SK' });
  const ws = connectReady(a);
  ws.frame({ action: 'chat', payload: { text: '问一句', toolSessionId: 'TA', sendUserAccount: 'u001' } });
  await settleIo();
  const sent = [];
  a.welink = async args => { sent.push(args); return { code: 0, stdout: '{}', stderr: '' }; };
  a.setSettings({ phone: { ...a.settings().phone, transport: undefined, groupId: '123' } });
  delete a.settings().phone.transport;
  assert.equal(a.phone.viaBot(), false);
  a.phone.settle({ id: 'c1', state: 'done', a: '私聊的答案' });
  await a.phone.outbox;
  assert.deepEqual(sent, [], '没有往群里发');
});

test('审查第 2 轮：关掉后旧连接晚到的消息不触发提问、不重新就绪', async () => {
  const { a, asked } = fixture({ phone: { enabled: true, transport: 'bot' }, uid: 'u001' });
  a.bot.saveCred({ ak: 'AK', sk: 'SK' });
  const ws = connectReady(a);
  a.bot.close();
  ws.frame({ type: 'register_ok' });
  ws.frame({ action: 'chat', payload: { text: '晚到', toolSessionId: 'TA', sendUserAccount: 'u001' } });
  await settleIo();
  assert.deepEqual(asked, []);
  assert.equal(a.bot.status().phase, 'idle');
  assert.equal(a.bot.hb, null);
});

test('审查第 2 轮：申请二维码期间关掉，晚到的码作废', async () => {
  const { a } = fixture();
  let release; const gate = new Promise(r => { release = r; });
  const http = a.bot.http;
  a.bot.http = async (...args) => { await gate; return http(...args); };
  const p = a.bot.register();
  a.bot.close();
  release();
  assert.equal(await p, null);
  assert.equal(a.bot.status().register, null);
});

test('审查第 2 轮：连着两条消息在身份查询完成前到达，各自回到各自那一轮', async () => {
  const { a } = fixture({ phone: { enabled: true, transport: 'bot' }, uid: 'u001' });
  a.bot.saveCred({ ak: 'AK', sk: 'SK' });
  const ws = connectReady(a);
  ws.frame({ action: 'chat', payload: { text: '一', toolSessionId: 'TA', sendUserAccount: 'u001', messageId: 'a' } });
  ws.frame({ action: 'chat', payload: { text: '二', toolSessionId: 'TB', sendUserAccount: 'u001', messageId: 'b' } });
  await settleIo(); await settleIo();
  ws.sent.length = 0;
  a.phone.settle({ id: 'c1', state: 'done', a: '答一' });
  await a.phone.outbox;
  assert.equal(ws.sent[0].toolSessionId, 'TA');
});

test('审查复核：登录守护没确认在线时，私聊不用快照或缓存里的旧身份', async () => {
  const { a, asked } = fixture({ phone: { enabled: true, transport: 'bot' }, uid: 'u001' });
  a.auth = { status: () => ({ state: 'expired', login: { ok: false, uid: 'u001' } }) };
  a.bot.saveCred({ ak: 'AK', sk: 'SK' });
  const ws = connectReady(a);
  ws.frame({ action: 'chat', payload: { text: '你好', toolSessionId: 'T1', sendUserAccount: 'u001' } });
  await settleIo();
  assert.deepEqual(asked, []);
  a.auth = { status: () => ({ state: 'online', login: { ok: true, uid: 'u001' } }) };
  ws.frame({ action: 'chat', payload: { text: '再试', toolSessionId: 'T2', sendUserAccount: 'u001' } });
  await settleIo();
  assert.deepEqual(asked, ['再试']);
});
