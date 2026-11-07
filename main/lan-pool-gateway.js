'use strict';
const http = require('node:http');
const { StringDecoder } = require('node:string_decoder');
const pool = require('../core/lan-pool');
const ROUTES = new Set(['/v1/messages', '/v1/messages/count_tokens', '/v1/responses', '/v1/chat/completions']);
const MAX_BODY = 16 * 1024 * 1024;
const IDLE_MS = 5 * 60 * 1000;
function json(res, status, value, headers = {}) { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(value)); } }
function fail(res, status, message, headers) { json(res, status, { error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message } }, headers); }
// Observe only protocol completion/error metadata; conversation text is forwarded and never retained.
function completionMeter() {
  const decoder = new StringDecoder('utf8'); let line = '', finished = false, failed = false, finishReason = false;
  return {
    take(chunk) {
      line += decoder.write(chunk);
      let at;
      while ((at = line.indexOf('\n')) >= 0) {
        const raw = line.slice(0, at).trim(); line = line.slice(at + 1);
        if (!raw.startsWith('data:')) continue;
        const data = raw.slice(5).trim(); if (data === '[DONE]') { if (finishReason) finished = true; continue; }
        try {
          const v = JSON.parse(data);
          if (v.error || ['error', 'response.failed', 'response.incomplete'].includes(v.type)) failed = true;
          if (['message_stop', 'response.completed'].includes(v.type)) finished = true;
          if (Array.isArray(v.choices) && v.choices.some(c => ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(c.finish_reason))) finishReason = true;
        } catch { /* Non-JSON protocol metadata does not change the stream. */ }
      }
      if (line.length > 1024 * 1024) { line = ''; failed = true; }
    },
    complete: () => finished && !failed,
    failed: () => failed,
  };
}

class LanPoolGateway {
  constructor({ dataDir, getEndpoint, getSnapshot, getReady = () => true, host = '127.0.0.1' }) {
    Object.assign(this, { dataDir, getEndpoint, getSnapshot, getReady, host });
    this.server = null; this.active = new Map(); this.usage = new Map(); this.sockets = new Set();
  }
  status() { return { running: !!this.server?.listening, port: this.server?.address()?.port || null,
    members: [...this.usage].map(([id, u]) => ({ id, ...u, active: this.active.get(id)?.size || 0 })),
    usageScope: '本次 Hub 运行期间的共享请求统计；不记录对话正文' }; }
  kick(id) { for (const req of this.active.get(id) || []) req.destroy(); }
  async start(port = pool.DEFAULT_PORT) {
    if (this.server) return this.status();
    const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => { void this.handle(req, res).catch(() => {
      if (!res.headersSent) fail(res, 503, '共享主机暂时无法处理请求，请稍后重试'); else res.destroy();
    }); });
    server.requestTimeout = 120000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
    server.maxConnections = 128;
    server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, this.host, () => { server.off('error', reject); resolve(); }); });
    server.on('error', () => {}); this.server = server; return this.status();
  }
  async stop() {
    const server = this.server; this.server = null;
    for (const id of this.active.keys()) this.kick(id);
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
  }
  async handle(req, res) {
    if (!pool.isPrivateAddress(req.socket.remoteAddress)) return fail(res, 403, '此服务仅允许内网连接');
    const settings = pool.read(this.dataDir);
    if (!settings.host?.enabled) return fail(res, 503, '主机已关闭共享');
    // Browser origins are rejected; there is no web UI or cookie authentication on this port.
    if (req.headers.origin || req.headers['sec-fetch-site']) return fail(res, 403, '请通过 AI Hub 或模型 CLI 连接');
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
    const identity = pool.authenticate(this.dataDir, auth);
    if (!identity) return fail(res, 401, '共享口令无效或已撤销');
    const { member, tag } = identity;
    let url; try { url = new URL(req.url, 'http://localhost'); } catch { return fail(res, 400, '请求地址无效'); }
    const pathname = url.pathname;
    // Claude Code adds ?beta=true to its Anthropic calls. It is protocol metadata, not another route.
    const beta = ['/v1/messages', '/v1/messages/count_tokens'].includes(pathname)
      && url.searchParams.size === 1 && url.searchParams.get('beta') === 'true';
    if (req.url !== pathname && !beta) return fail(res, 404, '共享端口不提供该接口');
    if (req.method === 'GET' && pathname === '/pool/v1/snapshot') {
      const snapshot = await this.getSnapshot();
      return json(res, 200, { ...snapshot, ready: this.getReady(), member: { name: member.name, maxConcurrent: member.maxConcurrent, rpm: member.rpm },
        myUsage: this.usage.get(member.id) ? { requests: this.usage.get(member.id).requests, succeeded: this.usage.get(member.id).succeeded, failed: this.usage.get(member.id).failed } : { requests: 0, succeeded: 0, failed: 0 } });
    }
    if (req.method === 'GET' && pathname === '/v1/models') return json(res, 200, { object: 'list', data: pool.MODEL_IDS.map(id => ({ id, object: 'model', owned_by: 'shared-pool' })) });
    if (req.method !== 'POST' || !ROUTES.has(pathname)) return fail(res, 404, '共享端口仅提供模型与只读额度接口');
    if (!String(req.headers['content-type'] || '').startsWith('application/json') || req.headers['content-encoding']) return fail(res, 415, '仅支持 JSON 请求');
    const active = this.active.get(member.id) || new Set(); this.active.set(member.id, active);
    const u = this.usage.get(member.id) || { requests: 0, succeeded: 0, failed: 0, bytesOut: 0, window: Date.now(), windowRequests: 0, lastAt: 0 };
    u.lastAt = Date.now();
    this.usage.set(member.id, u);
    if (Date.now() - u.window >= 60000) { u.window = Date.now(); u.windowRequests = 0; }
    if (active.size >= member.maxConcurrent || u.windowRequests >= member.rpm) return fail(res, 429, '已达到你的共享并发或每分钟上限，请稍后重试', { 'retry-after': '10' });
    if ([...this.active.values()].reduce((n, set) => n + set.size, 0) >= 16) return fail(res, 429, '共享主机正在处理较多请求，请稍后再试', { 'retry-after': '5' });
    // Reserve before receiving the body; slow uploads also occupy their member's slot.
    const cancelRequest = { destroy: () => { req.destroy(); upstreamReq?.destroy(); res.destroy(); release(false); } };
    active.add(cancelRequest); u.windowRequests++; u.requests++;
    let done = false, upstreamReq, deadline, idleTimer, responseOk = false, isSse = false;
    const meter = completionMeter();
    const release = success => { if (done) return; done = true; clearTimeout(deadline); clearTimeout(idleTimer); active.delete(cancelRequest); success ? u.succeeded++ : u.failed++; };
    const abort = () => { upstreamReq?.destroy(); release(responseOk && meter.complete()); };
    res.once('close', () => { if (!res.writableFinished) abort(); });
    deadline = setTimeout(() => { upstreamReq?.destroy(); if (!res.headersSent) fail(res, 504, '共享模型请求超时'); else res.destroy(); release(false); }, 15 * 60 * 1000);
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_BODY) { fail(res, 413, '请求超过 16 MB 上限'); release(false); return; } chunks.push(c); }
      if (done || res.destroyed) return;
      const body = Buffer.concat(chunks); let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { fail(res, 400, '请求 JSON 无效'); release(false); return; }
      if (!parsed || !pool.MODEL_IDS.includes(parsed.model)) { fail(res, 400, '请选择共享主机提供的模型'); release(false); return; }
      // Revocation during an upload is effective before forwarding.
      if (!pool.authenticate(this.dataDir, auth)) { fail(res, 401, '共享口令已撤销'); release(false); return; }
      const endpoint = this.getEndpoint();
      if (!endpoint?.port || !this.getReady()) { fail(res, 503, '共享主机的模型服务尚未就绪'); release(false); return; }
      upstreamReq = http.request({ hostname: '127.0.0.1', port: endpoint.port, path: pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length, authorization: `Bearer ${endpoint.key}.${tag}` } }, upstreamRes => {
        responseOk = upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300;
        isSse = String(upstreamRes.headers['content-type']).includes('text/event-stream');
        res.writeHead(upstreamRes.statusCode, { 'content-type': upstreamRes.headers['content-type'] || 'application/json', 'cache-control': 'no-store',
          ...(upstreamRes.headers['retry-after'] ? { 'retry-after': upstreamRes.headers['retry-after'] } : {}) });
        // A hung upstream must not hold the colleague's slot for the whole 15 minutes.
        const idle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { upstreamReq?.destroy(); res.destroy(); release(false); }, IDLE_MS); };
        idle(); res.once('close', () => clearTimeout(idleTimer));
        upstreamRes.on('data', c => { idle(); u.bytesOut += c.length; if (isSse) meter.take(c); });
        upstreamRes.on('error', () => { res.destroy(); release(false); });
        res.once('finish', () => release(responseOk && (!isSse || meter.complete())));
        upstreamRes.pipe(res);
      });
      upstreamReq.on('error', () => { if (!res.headersSent) fail(res, 502, '主机模型服务连接中断，请稍后重试'); else res.destroy(); release(false); });
      upstreamReq.end(body);
    } catch { if (!res.headersSent) fail(res, 400, '请求未完整接收'); else res.destroy(); release(false); }
  }
}
module.exports = { LanPoolGateway };
