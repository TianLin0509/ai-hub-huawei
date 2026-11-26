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

function apiHost(domain) { return domain ? `api.inner.welink.${domain}` : ''; }
function authProtocol(ak, sk, now = Date.now()) {
  const ts = Math.floor(now / 1000).toString();
  const nonce = randomUUID();
  const sign = createHmac('sha256', sk).update(`${ak}${ts}${nonce}`).digest('base64');
  return 'auth.' + Buffer.from(JSON.stringify({ ak, ts, nonce, sign })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
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
  }
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
  }
  close() {
    this.gen += 1; this.stopped = true; this.stopRegister();
    clearTimeout(this.retry); this.retry = null; clearInterval(this.hb); this.hb = null;
    const ws = this.ws; this.ws = null; this.phase = 'idle';
    try { ws?.close(); } catch { /* 已断 */ }
  }
  forget() { this.close(); try { fs.unlinkSync(this.credFile()); } catch { /* 没有 */ } this.a.write('welink-bot.json', {}); this.reg = null; this.a.changed(); }
  connect() {
    const c = this.cred();
    if (!c) { this.save({ lastError: '助手凭据读不出来，请重新创建助手' }); return; }
    let ws;
    try {
      const WS = this.WS || require('ws');
      ws = new WS(this.gateway(), [authProtocol(c.ak, c.sk, this.now())], tlsOptions());
    } catch (e) { this.save({ lastError: '连不上 WeLink：' + e.message }); this.later(); return; }
    this.ws = ws; this.phase = 'connecting';
    const timer = setTimeout(() => { if (this.ws === ws && this.phase !== 'ready') { this.save({ lastError: '连接 WeLink 超时' }); try { ws.close(); } catch { /* */ } } }, CONNECT_TIMEOUT_MS);
    timer.unref?.();
    // 旧连接（已被关掉或替换）晚到的事件一律不理：不会重新就绪、不会触发提问、不会起心跳。
    const live = () => this.ws === ws && !this.stopped;
    ws.addEventListener('open', () => {
      if (!live()) return;
      this.send1({ type: 'register', deviceName: 'ai-hub-assistant', os: process.platform, toolType: CHANNEL, toolVersion: 'ai-hub', sdkVersion: 'ai-hub', macAddress: this.mac() });
      this.phase = 'registering';
    });
    ws.addEventListener('message', ev => { if (live()) this.onFrame(ev.data); });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      if (this.ws !== ws) return;
      clearInterval(this.hb); this.hb = null; this.ws = null;
      const was = this.phase; this.phase = 'idle';
      if (was === 'ready') this.backoff = 5000;
      this.a.changed();
      this.later();
    });
    ws.addEventListener('error', () => { /* 随后会收到 close */ });
  }
  later() {
    if (this.stopped || this.retry || this.manual) return;
    this.retry = setTimeout(() => { this.retry = null; if (!this.stopped && !this.ws) this.connect(); }, this.backoff);
    this.retry.unref?.();
    this.backoff = Math.min(this.backoff * 2, 60000);
  }
  send1(o) { try { this.ws.send(JSON.stringify(o)); return true; } catch { return false; } }
  onFrame(raw) {
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return; }
    if (!m || typeof m !== 'object') return;
    this.lastRx = this.now();
    if (m.type === 'register_ok' || m.type === 'ready') {
      this.phase = 'ready'; this.backoff = 5000; this.save({ readyAt: this.now(), lastError: '' }); this.a.changed();
      clearInterval(this.hb);
      // 半开连接（网断了却没收到关闭）：5 分钟一个包都没收到就主动断开重连。
      this.hb = setInterval(() => {
        if (this.now() - this.lastRx > RX_IDLE_MS) { this.save({ lastError: '5 分钟没收到 WeLink 的任何消息，正在重连' }); try { this.ws?.close(); } catch { /* */ } return; }
        this.send1({ type: 'heartbeat', seq: this.now() });
      }, HEARTBEAT_MS);
      this.hb.unref?.();
      return;
    }
    if (m.type === 'register_rejected') {
      // 同一个助手同时只能连一处（公司真机实测 reason=duplicate_connection，关闭码 4409）：另一台电脑或另一个 Hub 正连着，
      // 那边断开后这边自动接上，每分钟试一次。其他原因（身份作废等）才需要重新创建。
      if (m.reason === 'duplicate_connection') { this.save({ lastError: '这个助手正在另一处连着（另一台电脑或另一个 Hub），那边断开后自动接上' }); this.backoff = 60000; }
      else { this.save({ lastError: `WeLink 拒绝了这个助手身份（${String(m.reason || '未说明原因').slice(0, 40)}），请重新创建助手` }); this.stopped = true; }
      try { this.ws?.close(); } catch { /* */ }
      return;
    }
    if (m.type === 'heartbeat') return;
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
    void Promise.resolve(this.onChat?.({ text: r.text, sender: r.sender, entry: r.entry, messageId: r.messageId })).catch(e => console.warn('[welink-bot] chat', e.message));
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

module.exports = { WelinkBot, qrImage, parseInbound, authProtocol, apiHost, CHANNEL };
