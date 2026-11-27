'use strict';
// 专属 WeLink 助手（2026-11-13 用户要求「不建群就可以有助手」，公司真机已端到端验证）：
//   扫一次码向 WeLink 申请一个只属于自己的助手身份（拿到 AK/SK），Hub 用它长连 WeLink 网关；
//   手机上私聊这个助手 = 和 Hub 的助理对话，不用再建专用群。
// 协议参照内部开源项目 clowder-ai-welink-proxy（scripts/register-welink.js、src/welink/*.js），只取必需部分：
//   注册：POST /assistant-api/nologin/we-crew/im-register/qrcode {channel, mac} → qrcode、accessToken、pcUrl、weUrl；
//         GET  …/qrcode-detail/<qrcode>（头 qrcodeToken）→ status 1 已扫 / 2 已确认（带 ak、sk）/ 3 取消，码约 5 分钟过期。
//   网关：wss://<api 主机>（2026-11-27 公司真机核实 TLS 入口存在，未授权回 401）/appstore-gateway/ws/agent，子协议 auth.<base64url({ak,ts,nonce,sign})>，sign=HMAC-SHA256(sk, ak+ts+nonce)；
//         连上发 register 帧，等 register_ok/ready，之后 30 秒一次心跳。
//   收：action=create_session（要回 session_created）、action=chat（payload.text、toolSessionId、sendUserAccount）。
//   发：tool_event 包一条 text.done，再跟一条 step.done。助手不能主动开新对话，只能回到用户私聊过的那个对话，所以记下最近的私聊路由。
// AK/SK 用系统加密（Windows DPAPI）存在本机，不写进明文设置。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { createHmac, randomUUID, createHash } = require('node:crypto');

const CHANNEL = 'opencode';
const RX_IDLE_MS = 5 * 60000, HEARTBEAT_MS = 30000, CONNECT_TIMEOUT_MS = 10000, POLL_MS = 2000, MAX_ROUNDS = 3;
// 断线根治（2026-11-27 同事反馈「静置几小时自动断开」）：重连不设永久上限，退避 5 秒起翻倍、封顶 5 分钟；
// 看门狗每 30 秒看一次——非就绪卡住超过 2 分钟、或既没连接也没排着重连，就立即重连；
// 系统睡眠唤醒、锁屏解锁、网络恢复时立即重连（已就绪时解锁、网络恢复只先探一次心跳，15 秒没回音再重连）。
const BACKOFF_MIN_MS = 5000, BACKOFF_MAX_MS = 5 * 60000, WATCHDOG_MS = 30000, STUCK_MS = 2 * 60000, PROBE_MS = 15000;
// 唤醒时的「在途窗口」：发起连接后这么久之内不重复打断（连接超时 10 秒 + 余量）；同一助手被别处占用后等 1 分钟再抢。
const IN_FLIGHT_MS = CONNECT_TIMEOUT_MS + 5000, DUPLICATE_HOLD_MS = 60000;

function apiHost(domain) { return domain ? `api.inner.welink.${domain}` : ''; }
function authProtocol(ak, sk, now = Date.now()) {
  const ts = Math.floor(now / 1000).toString();
  const nonce = randomUUID();
  const sign = createHmac('sha256', sk).update(`${ak}${ts}${nonce}`).digest('base64');
  return 'auth.' + Buffer.from(JSON.stringify({ ak, ts, nonce, sign })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
// 掐断一条连接：能 terminate 就直接掐（半开连接 close() 要等关闭握手超时），否则 close。
function kill(ws) { try { if (ws && typeof ws.terminate === 'function') ws.terminate(); else ws?.close(); } catch { /* 已断 */ } }
function defaultIsOnline() { try { const { net } = require('electron'); return typeof net?.isOnline === 'function' ? net.isOnline() : true; } catch { return true; } }
function macAddress() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (!i.internal && i.mac && i.mac !== '00:00:00:00:00:00') return i.mac;
  return '';
}
// 注册响应里带 AK/SK，证书一律校验（审查 2026-11-27）：在 Electron 里走 net.fetch，用 Windows 系统证书库（含公司根证书）；
// 不在 Electron 里（单测、脚本）才用 Node https，同样校验证书。
async function electronJson(url, { method = 'GET', headers = {}, body } = {}) {
  const { net } = require('electron');
  const r = await net.fetch(String(url), { method, headers, body, signal: AbortSignal.timeout(15000) });
  let json = null; try { json = JSON.parse((await r.text()) || 'null'); } catch { /* 不是 JSON */ }
  return { status: r.status, body: json };
}
function defaultHttp(url, opts) {
  let net = null; try { net = require('electron').net; } catch { /* 非 Electron */ }
  return net && typeof net.fetch === 'function' && !String(url).startsWith('http:') ? electronJson(url, opts) : httpsJson(url, opts);
}
function httpsJson(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('http:') ? http : https; // http 只用于测试替身（见 base()）
    const req = lib.request(url, { method, headers, timeout: 15000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { /* 不是 JSON */ } resolve({ status: res.statusCode, body: json }); });
    });
    req.on('timeout', () => req.destroy(new Error('连接 WeLink 超时')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const okData = r => r && r.status >= 200 && r.status < 300 && r.body && (r.body.code === '200' || r.body.code === 200) ? r.body.data : null;

// 入站帧 → 路由信息。真实网关把 welinkSessionId、traceId 放在帧顶层，业务字段在 payload 里，两处都要看。
function parseInbound(m) {
  const inner = m && m.payload && typeof m.payload === 'object' ? m.payload : {};
  const plat = (inner.extParameters && inner.extParameters.platformExtParam) || {};
  const group = plat.businessSessionType === 'group' || (plat.businessSessionType !== 'direct' && !!inner.imGroupId);
  const sender = String(inner.sendUserAccount || '');
  return {
    action: m.action || 'chat',
    kind: group ? 'group' : 'direct',
    entry: plat.businessSessionId || (sender ? 'direct:' + sender : 'unknown'),
    sender,
    tsid: m.toolSessionId || inner.toolSessionId || '',
    wsid: m.welinkSessionId || inner.welinkSessionId || '',
    messageId: String(inner.messageId || ''),
    text: typeof inner.text === 'string' ? inner.text : '',
  };
}
// 远端关闭原因、拒绝理由：只认已知的几个标识，其余记 other（有原文但不记）。
const KNOWN_REASONS = new Set(['duplicate_connection', 'invalid_sign', 'sign_error', 'auth_failed', 'unauthorized', 'expired', 'timestamp_expired', 'kicked', 'server_shutdown', 'idle_timeout']);
function reasonKind(reason) {
  const r = String(reason || '').trim();
  if (!r) return 'none';
  return KNOWN_REASONS.has(r.toLowerCase()) ? r.toLowerCase() : 'other';
}
// 连接错误：只记类别。
function errorKind(ev) {
  const code = String(ev?.error?.code || ev?.code || '');
  if (/^E[A-Z_]{2,30}$/.test(code)) return code.toLowerCase(); // 日志白名单只收小写标识
  const msg = String(ev?.message || ev?.error?.message || '');
  if (/certificate|self.signed|tls|ssl/i.test(msg)) return 'tls';
  if (/timed? ?out/i.test(msg)) return 'timeout';
  if (/refused/i.test(msg)) return 'refused';
  if (/getaddrinfo|ENOTFOUND|dns/i.test(msg)) return 'dns';
  if (/reset|hang ?up/i.test(msg)) return 'reset';
  const http = /\b([45]\d\d)\b/.exec(msg);
  if (http) return 'http-' + http[1];
  return msg ? 'other' : 'none';
}
// 日志字段白名单：数字、布尔、null，以及本机自己定的短标识（事件阶段、类别）；其余一律丢掉。
const LOG_KEYS = new Set(['code', 'reasonKind', 'kind', 'was', 'phase', 'reason', 'type', 'ms', 'delayMs', 'backoffMs', 'uptimeMs', 'rx', 'hbSent', 'hbReplies', 'wsPongs', 'lastRxAgoMs', 'keys']);
function safeLogDetail(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail || {})) {
    if (!LOG_KEYS.has(k)) continue;
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string' && (k === 'keys' ? v.length <= 400 && /^[A-Za-z?:{},]*$/.test(v) : /^[a-z][a-z0-9_-]{0,39}$/.test(v))) out[k] = v;
  }
  return out;
}
// 帧的「形状」：只取字段名和类型（两层），不取任何值——用来从真机日志里补文件类消息的协议。
// 字段名也只收纯字母（像 fileUrl、msgType），带数字、符号的记成「?」，免得把值当成键带出来。
function payloadShape(m) {
  const name = k => /^[A-Za-z]{1,24}$/.test(k) ? k : '?';
  const shape = (o, depth) => Object.entries(o || {}).slice(0, 30).map(([k, v]) => name(k) + ':' + (v && typeof v === 'object' && !Array.isArray(v) && depth < 1 ? '{' + shape(v, depth + 1) + '}' : Array.isArray(v) ? 'array' : typeof v)).join(',');
  return shape(m && typeof m.payload === 'object' ? m.payload : {}, 0).slice(0, 400);
}
const fallbackTsid = entry => 'hub-' + createHash('sha1').update(String(entry)).digest('hex').slice(0, 16);

// wss 要认公司内部根证书：Node 自带的证书表里没有，叠加 Windows 系统证书（Node 22+ 有 getCACertificates）。
function tlsOptions() {
  try {
    const tls = require('node:tls');
    if (typeof tls.getCACertificates !== 'function') return {};
    return { ca: [...tls.getCACertificates('default'), ...tls.getCACertificates('system')] };
  } catch { return {}; }
}

class WelinkBot {
  // assistant：CompanyAssistant（用它的 read/write/changed/now/dir）；deps.safeStorage 加密 AK/SK；
  // deps.welinkBot 可注入 { http, WebSocket, domain, mac } 供测试。
  constructor(assistant, deps = {}) {
    this.a = assistant; this.deps = deps; this.now = assistant.now;
    const inject = deps.welinkBot || {};
    this.http = inject.http || defaultHttp;
    this.WS = inject.WebSocket || null;
    this.domainOf = inject.domain ? () => inject.domain : () => require('../company-domain').knownDomain(deps.dataDir).domain;
    this.mac = inject.mac != null ? () => inject.mac : macAddress;
    // 扫码轮询和断线重连是用户点了才有的，不受「后台定时取数」开关影响；只有单测用 manual 手动推进。
    this.manual = !!inject.manual;
    this.ws = null; this.hb = null; this.retry = null; this.backoff = 5000; this.stopped = true;
    this.phase = 'idle'; this.reg = null; this.regTimer = null; this.gen = 0; this.lastRx = 0;
    this.onChat = null; // PhoneChannel 挂上来：收到私聊文字时调用
    this.onConfirmed = null; // 助理服务挂上来：扫码确认后自动开启手机对话
    // 连接生命周期日志（<数据目录>/logs/welink-bot.log）：只记事件、关闭码、时长、计数与退避值，不记 AK/SK、不记消息正文。
    this.logFn = inject.log || (deps.dataDir ? require('../window-keep-rendering').createWindowEventLog(path.join(deps.dataDir, 'logs', 'welink-bot.log'), { logger: {} }) : null);
    this.isOnline = typeof inject.isOnline === 'function' ? inject.isOnline : defaultIsOnline;
    this.watchdog = null; this.connectAt = 0; this.conn = null; this.wasOnline = true; this.probe = null; this.holdUntil = 0;
  }
  // 日志只收白名单形状（审查 2026-11-27）：数字、布尔、本机自己定的短标识；远端给的原文（关闭原因、错误信息、拒绝理由）
  // 一律先归成固定类别再记，任何其他字符串都丢掉——连接被拒或出错时，远端原文里可能带凭据或消息正文。
  log(event, detail = {}) { try { this.logFn?.(event, safeLogDetail(detail)); } catch { /* 写日志失败不影响连接 */ } }
  credFile() { return path.join(this.a.dir, 'welink-bot.bin'); }
  state() { return { name: '', createdAt: 0, routes: {}, last: '', lastError: '', readyAt: 0, ...this.a.read('welink-bot.json', {}) }; }
  save(patch) { const s = { ...this.state(), ...patch }; this.a.write('welink-bot.json', s); return s; }
  safe() { const s = this.deps.safeStorage || require('electron').safeStorage; if (!s?.isEncryptionAvailable?.()) throw new Error('系统加密不可用，没法安全保存助手凭据'); return s; }
  cred() {
    try { return JSON.parse(this.safe().decryptString(fs.readFileSync(this.credFile()))); } catch { return null; }
  }
  hasCred() { return fs.existsSync(this.credFile()); }
  saveCred(c) { fs.mkdirSync(this.a.dir, { recursive: true }); const tmp = this.credFile() + '.tmp'; fs.writeFileSync(tmp, this.safe().encryptString(JSON.stringify(c))); fs.renameSync(tmp, this.credFile()); }
  // 测试替身：CLAUDE_HUB_WELINK_BOT_BASE / _WS 把接口和网关指到本机假服务（界面验收用），平时不设。
  base() { if (process.env.CLAUDE_HUB_WELINK_BOT_BASE) return process.env.CLAUDE_HUB_WELINK_BOT_BASE; const host = apiHost(this.domainOf()); if (!host) throw new Error('还不知道公司域名，在助理页填一下本人邮箱即可'); return 'https://' + host; }
  gateway() { return process.env.CLAUDE_HUB_WELINK_BOT_WS || `wss://${apiHost(this.domainOf())}/appstore-gateway/ws/agent`; }

  // ---- 扫码申请 ----
  // 返回二维码信息；之后后台每 2 秒查一次，确认后自动保存凭据并连上网关。过期自动换码，最多 3 轮。
  async register() {
    this.stopRegister();
    const round = (this.reg?.round || 0) + 1, gen = this.gen;
    const r = await this.http(new URL('/assistant-api/nologin/we-crew/im-register/qrcode', this.base()), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: CHANNEL, mac: this.mac() }) });
    const d = okData(r);
    if (this.gen !== gen) return null; // 等二维码期间关掉了（暂停、退出）：晚到的码作废，不开始轮询
    if (!d || !d.qrcode || !d.accessToken) throw new Error('WeLink 没给出二维码：' + String(r?.body?.message || r?.body?.code || `HTTP ${r?.status}`).slice(0, 120));
    this.reg = { round, qrcode: String(d.qrcode), token: String(d.accessToken), pcUrl: String(d.pcUrl || ''), weUrl: String(d.weUrl || ''), at: this.now(), status: 'waiting', error: '' };
    this.a.changed();
    if (!this.manual) this.regTimer = setTimeout(() => { void this.pollRegister(); }, POLL_MS);
    return this.regInfo();
  }
  stopRegister() { clearTimeout(this.regTimer); this.regTimer = null; }
  async pollRegister() {
    const g = this.reg, gen = this.gen;
    if (!g || !['waiting', 'scanned'].includes(g.status)) return;
    let x = null;
    try { x = okData(await this.http(new URL(`/assistant-api/nologin/we-crew/im-register/qrcode-detail/${encodeURIComponent(g.qrcode)}`, this.base()), { headers: { qrcodeToken: g.token } })); } catch { /* 网络抖动下一轮再查 */ }
    if (this.reg !== g || this.gen !== gen) return; // 期间关掉了（暂停、退出、删除助手）：晚到的结果作废
    if (x && (x.expired === true || x.expired === 1)) {
      if (g.round >= MAX_ROUNDS) { g.status = 'expired'; this.a.changed(); return; }
      try { await this.register(); } catch (e) { g.status = 'failed'; g.error = e.message; this.a.changed(); }
      return;
    }
    if (x && x.status === 3) { g.status = 'cancelled'; this.a.changed(); return; }
    if (x && x.status === 2 && x.ak && x.sk) {
      this.saveCred({ ak: String(x.ak), sk: String(x.sk) });
      this.save({ name: String(x.name || '助手'), createdAt: this.now(), routes: {}, last: '', lastError: '' });
      g.status = 'confirmed';
      try { this.onConfirmed?.(); } catch (e) { console.warn('[welink-bot] confirmed', e.message); }
      this.a.changed();
      this.start();
      return;
    }
    if (x && x.status === 1 && g.status !== 'scanned') { g.status = 'scanned'; this.a.changed(); }
    if (this.now() - g.at > 6 * 60000) { g.status = 'expired'; this.a.changed(); return; }
    if (!this.manual) this.regTimer = setTimeout(() => { void this.pollRegister(); }, POLL_MS);
  }
  regInfo() { const g = this.reg; return g ? { round: g.round, status: g.status, pcUrl: g.pcUrl, weUrl: g.weUrl, at: g.at, error: g.error } : null; }

  // ---- 网关 ----
  start() {
    if (!this.hasCred()) return;
    this.stopped = false;
    if (!this.ws) this.connect();
    if (!this.watchdog && !this.manual) { this.watchdog = setInterval(() => this.tick(), WATCHDOG_MS); this.watchdog.unref?.(); }
  }
  close() {
    this.gen += 1; this.stopped = true; this.stopRegister();
    clearTimeout(this.retry); this.retry = null; clearInterval(this.hb); this.hb = null;
    clearInterval(this.watchdog); this.watchdog = null; clearTimeout(this.probe); this.probe = null;
    const ws = this.ws; this.ws = null; this.phase = 'idle';
    if (ws) this.log('stop', this.connStats());
    try { ws?.close(); } catch { /* 已断 */ }
  }
  // 本次连接的统计（只有计数和时长）：收到几个包、发了几次心跳、服务端回过几次心跳、距上次收包多久。
  connStats() {
    const c = this.conn; if (!c) return {};
    const t = this.now();
    return { uptimeMs: c.readyAt ? t - c.readyAt : 0, rx: c.rx, hbSent: c.hbSent, hbReplies: c.hbReplies, wsPongs: c.wsPongs || 0, lastRxAgoMs: this.lastRx ? t - this.lastRx : null };
  }
  // 强制断开当前连接并立即重连（看门狗、唤醒、收包超时用）。半开连接 close() 要等关闭握手超时，能 terminate 就直接掐断。
  reconnectNow(reason) {
    if (this.stopped || !this.hasCred()) return false;
    this.log('reconnect-now', { reason, phase: this.phase, ...this.connStats() });
    clearTimeout(this.retry); this.retry = null; clearInterval(this.hb); this.hb = null; clearTimeout(this.probe); this.probe = null;
    const ws = this.ws; this.ws = null; this.phase = 'idle'; this.backoff = BACKOFF_MIN_MS;
    kill(ws);
    this.a.changed();
    this.connect();
    return true;
  }
  // 系统睡眠唤醒、锁屏解锁、网络恢复（main.js 的 powerMonitor 与看门狗调用）。
  wake(reason) {
    if (this.stopped || !this.hasCred()) return;
    // 刚发起的连接还在握手（睡醒、解锁接连触发时常见）：不打断，等它自己出结果；
    // 同一助手被别处占用后的 1 分钟等待期内也不抢（唤醒不能打穿这段退避）。
    const inFlight = this.ws && this.phase !== 'ready' && this.now() - this.connectAt < IN_FLIGHT_MS;
    if (inFlight || this.now() < this.holdUntil) { this.log('wake-skip', { reason, phase: this.phase }); return; }
    this.log('wake', { reason, phase: this.phase });
    // 睡过觉的连接多半已经死了，直接重连；解锁、网络恢复时若还就绪，先发一次心跳探一探，15 秒一个包都没收到再重连。
    if (reason === 'resume' || this.phase !== 'ready' || !this.ws) { this.reconnectNow(reason); return; }
    const before = this.lastRx, ws = this.ws;
    this.sendHeartbeat();
    clearTimeout(this.probe);
    if (this.manual) return;
    this.probe = setTimeout(() => this.probeCheck(before, reason, ws), PROBE_MS);
    this.probe.unref?.();
  }
  // 探针晚到时先核对还是不是同一条连接：期间已重连过就作废，不掐新连接。
  probeCheck(before, reason, ws = this.ws) {
    this.probe = null;
    if (this.stopped || this.ws !== ws || !ws) return;
    if (this.lastRx === before) this.reconnectNow(reason + '-probe-silent');
  }
  // 看门狗（每 30 秒；单测直接调）：卡在连接中 / 注册中超过 2 分钟、或既没连接也没排着重连，就立即重连；顺带看网络是否刚恢复。
  tick() {
    if (this.stopped || !this.hasCred() || this.credBroken) return null; // 凭据读不出来时重连也没用，等用户重新绑定
    let online = true; try { online = this.isOnline() !== false; } catch { /* 拿不到就当在线 */ }
    const back = online && !this.wasOnline; this.wasOnline = online;
    if (!online) return 'offline';
    if (back) { this.wake('network'); return 'network'; }
    if (this.ws && this.phase !== 'ready' && this.now() - this.connectAt > STUCK_MS) { this.reconnectNow('watchdog-stuck-' + this.phase); return 'stuck'; }
    if (!this.ws && !this.retry && !this.manual) { this.reconnectNow('watchdog-lost'); return 'lost'; }
    return null;
  }
  forget() { this.close(); try { fs.unlinkSync(this.credFile()); } catch { /* 没有 */ } this.a.write('welink-bot.json', {}); this.reg = null; this.a.changed(); }
  connect() {
    const c = this.cred();
    if (!c) { this.credBroken = true; this.save({ lastError: '助手凭据读不出来，请重新创建助手' }); this.log('cred-unreadable'); return; }
    this.credBroken = false;
    let ws;
    try {
      const WS = this.WS || require('ws');
      ws = new WS(this.gateway(), [authProtocol(c.ak, c.sk, this.now())], tlsOptions());
    } catch (e) { this.save({ lastError: '连不上 WeLink：' + e.message }); this.later(); return; }
    clearTimeout(this.probe); this.probe = null; // 新连接不继承旧连接的探针
    this.ws = ws; this.phase = 'connecting'; this.connectAt = this.now();
    this.conn = { at: this.connectAt, readyAt: 0, rx: 0, hbSent: 0, hbReplies: 0, wsPongs: 0 };
    this.log('connect', { backoffMs: this.backoff });
    const timer = setTimeout(() => { if (this.ws === ws && this.phase !== 'ready') { this.save({ lastError: '连接 WeLink 超时' }); this.log('connect-timeout', { phase: this.phase }); kill(ws); } }, CONNECT_TIMEOUT_MS);
    timer.unref?.();
    // 旧连接（已被关掉或替换）晚到的事件一律不理：不会重新就绪、不会触发提问、不会起心跳。
    const live = () => this.ws === ws && !this.stopped;
    ws.addEventListener('open', () => {
      if (!live()) return;
      this.send1({ type: 'register', deviceName: 'ai-hub-assistant', os: process.platform, toolType: CHANNEL, toolVersion: 'ai-hub', sdkVersion: 'ai-hub', macAddress: this.mac() });
      this.phase = 'registering';
      this.log('open', { ms: this.now() - this.connectAt });
    });
    ws.addEventListener('message', ev => { if (live()) this.onFrame(ev.data); });
    ws.addEventListener('close', ev => {
      clearTimeout(timer);
      if (this.ws !== ws) return;
      clearInterval(this.hb); this.hb = null; this.ws = null;
      const was = this.phase; this.phase = 'idle';
      if (was === 'ready') this.backoff = BACKOFF_MIN_MS;
      this.log('close', { code: Number(ev && ev.code) || 0, reasonKind: reasonKind(ev && ev.reason), was, ...this.connStats() });
      this.a.changed();
      this.later();
    });
    ws.addEventListener('error', ev => { if (this.ws === ws) this.log('error', { kind: errorKind(ev) }); /* 随后会收到 close */ });
    // 协议层 pong（ws 库的 ping/pong）：服务端不回应用层心跳时，靠它也能确认连接还活着，免得每 5 分钟误判收包超时重连一次。
    if (typeof ws.on === 'function') ws.on('pong', () => { if (!live()) return; this.lastRx = this.now(); if (this.conn) { this.conn.wsPongs += 1; if (this.conn.wsPongs === 1) this.log('ws-pong'); } });
  }
  later() {
    if (this.stopped || this.retry || this.manual) return;
    const delay = this.backoff;
    this.retry = setTimeout(() => { this.retry = null; if (!this.stopped && !this.ws) this.connect(); }, delay);
    this.retry.unref?.();
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.log('retry', { delayMs: delay });
  }
  send1(o) { try { this.ws.send(JSON.stringify(o)); return true; } catch { return false; } }
  heartbeatTick() {
    if (!this.ws) return;
    if (this.now() - this.lastRx > RX_IDLE_MS) {
      this.save({ lastError: '5 分钟没收到 WeLink 的任何消息，正在重连' });
      this.reconnectNow('rx-idle');
      return;
    }
    this.sendHeartbeat();
  }
  // 应用层心跳 + 协议层 ping 一起发；回没回分别计在 hbReplies、wsPongs（关闭时写进日志，用来判断服务端到底回哪种）。
  sendHeartbeat() {
    if (this.send1({ type: 'heartbeat', seq: this.now() }) && this.conn) this.conn.hbSent += 1;
    try { if (typeof this.ws?.ping === 'function') this.ws.ping(); } catch { /* 不支持就算了 */ }
  }
  onFrame(raw) {
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return; }
    if (!m || typeof m !== 'object') return;
    this.lastRx = this.now();
    if (this.conn) this.conn.rx += 1;
    if (m.type === 'register_ok' || m.type === 'ready') {
      if (this.phase === 'ready') return; // register_ok 和 ready 都来时只就绪一次，不重复起心跳
      this.phase = 'ready'; this.backoff = BACKOFF_MIN_MS; this.save({ readyAt: this.now(), lastError: '' }); this.a.changed();
      if (this.conn) this.conn.readyAt = this.now();
      this.log('ready', { type: m.type === 'ready' ? 'ready' : 'register_ok', ms: this.now() - this.connectAt });
      clearInterval(this.hb);
      // 半开连接（网断了却没收到关闭）：5 分钟一个包都没收到就主动断开重连（heartbeatTick）。
      this.hb = setInterval(() => this.heartbeatTick(), HEARTBEAT_MS);
      this.hb.unref?.();
      return;
    }
    if (m.type === 'register_rejected') {
      this.log('register-rejected', { reasonKind: reasonKind(m.reason) });
      // 同一个助手同时只能连一处（公司真机实测 reason=duplicate_connection，关闭码 4409）：另一台电脑或另一个 Hub 正连着，
      // 那边断开后这边自动接上，每分钟试一次。其他原因（身份作废等）才需要重新创建。
      if (m.reason === 'duplicate_connection') { this.save({ lastError: '这个助手正在另一处连着（另一台电脑或另一个 Hub），那边断开后自动接上' }); this.backoff = 60000; this.holdUntil = this.now() + DUPLICATE_HOLD_MS; }
      else {
        this.save({ lastError: `WeLink 拒绝了这个助手身份（${String(m.reason || '未说明原因').slice(0, 40)}），请重新创建助手` });
        // 身份作废：停下，看门狗和探针一并收掉（不再空转）。
        this.stopped = true; clearInterval(this.watchdog); this.watchdog = null; clearTimeout(this.probe); this.probe = null;
      }
      kill(this.ws);
      return;
    }
    if (m.type === 'heartbeat' || m.type === 'heartbeat_ack' || m.type === 'pong') {
      if (this.conn) { this.conn.hbReplies += 1; if (this.conn.hbReplies === 1) this.log('heartbeat-reply', { type: m.type === 'pong' ? 'pong' : m.type === 'heartbeat_ack' ? 'heartbeat_ack' : 'heartbeat' }); }
      return;
    }
    const r = parseInbound(m);
    // 每个对话记下网关给的会话编号：回复和之后的主动提醒都靠它投递，重启后也要能用，所以落盘。
    const st = this.state(), prev = st.routes[r.entry] || {};
    const route = { tsid: r.tsid || prev.tsid || fallbackTsid(r.entry), wsid: r.wsid || prev.wsid || '', kind: r.kind, sender: r.sender || prev.sender || '', at: this.now() };
    const routes = { ...st.routes, [r.entry]: route };
    // 「最近私聊」（主动提醒发往哪）只在确认是本人之后由 PhoneChannel.receive 记，别人私聊不会把提醒引到他那里。
    // 最多留 20 条；本人最近私聊那条永远保留，陌生人刷再多对话也挤不掉它。
    const kept = Object.entries(routes).sort((x, y) => y[1].at - x[1].at).filter(([k]) => k !== st.last).slice(0, 19);
    if (st.last && routes[st.last]) kept.push([st.last, routes[st.last]]);
    this.save({ routes: Object.fromEntries(kept) });
    if (r.action === 'create_session') { this.send1({ type: 'session_created', toolSessionId: route.tsid, ...(route.wsid ? { welinkSessionId: route.wsid } : {}) }); return; }
    if (r.action === 'query_slash_commands') { this.send1({ type: 'slash_commands_result', toolSessionId: route.tsid, commands: [] }); return; }
    if (r.action !== 'chat') return;
    if (r.kind === 'group') { this.reply(r.entry, '在群里我先不接话，请直接私聊我。'); return; }
    // 文件、图片等非文字消息：网关下行帧里文件字段的格式还没拿到实测样本，先只记字段名（不记内容）用来补协议，并回一行提示。
    const nonText = !r.text.trim();
    if (nonText) this.log('non-text-chat', { keys: payloadShape(m) });
    void Promise.resolve(this.onChat?.({ text: r.text, sender: r.sender, entry: r.entry, messageId: r.messageId, ...(nonText ? { nonText: true } : {}) })).catch(e => console.warn('[welink-bot] chat', e.message));
  }
  // 发到某个对话；不传 entry 就发到最近一次私聊（主动提醒用）。
  // entry 也可以直接传当时记下的路由（{tsid, wsid}）：同一私聊里网关换了会话编号时，回答仍回到提问那一轮。
  reply(entry, text) {
    const st = this.state(), key = typeof entry === 'string' ? entry : st.last;
    const route = entry && typeof entry === 'object' && entry.tsid ? entry : key && st.routes[key];
    if (this.phase !== 'ready' || !route) return false;
    const mid = randomUUID();
    const env = event => ({ type: 'tool_event', toolSessionId: route.tsid, ...(route.wsid ? { welinkSessionId: route.wsid } : {}), event });
    const ok = this.send1(env({ protocol: 'cloud', type: 'text.done', properties: { messageId: mid, partId: 'prt_' + mid.replace(/-/g, ''), content: String(text) } }));
    this.send1(env({ protocol: 'cloud', type: 'step.done', properties: { messageId: mid, reason: 'completed' } }));
    return ok;
  }
  status() {
    const st = this.state();
    return { hasCred: this.hasCred(), name: st.name, createdAt: st.createdAt, phase: this.phase, readyAt: st.readyAt, lastError: st.lastError, talked: !!st.last, register: this.regInfo() };
  }
}

// 二维码图（data URL），给设置页显示，手机 WeLink 扫一扫用。
function qrImage(text) {
  if (!text) return '';
  const qr = require('../vendor/qrcode-generator')(0, 'M');
  qr.addData(String(text)); qr.make();
  return qr.createDataURL(5, 4);
}

module.exports = { WelinkBot, qrImage, parseInbound, authProtocol, apiHost, CHANNEL, safeLogDetail, reasonKind, errorKind, BACKOFF_MIN_MS, BACKOFF_MAX_MS, STUCK_MS, RX_IDLE_MS };
