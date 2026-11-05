// tests/helpers/cdp-client.js
//
// 最小化 CDP 客户端：连一个 page target 的 webSocketDebuggerUrl，发 Runtime.evaluate
// 在 renderer 里跑任意 JS（含 ipcRenderer.invoke 调 IPC handler）。
//
// 用法：
//   const client = await connectCDP(pageWsUrl);
//   const r = await client.eval(`(async () => await ipcRenderer.invoke('get-sessions'))()`);
//   await client.close();

const WebSocket = require('ws');

function validateTimeout(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 2147483647) throw new RangeError('CDP timeout must be a positive integer up to 2147483647 ms');
  return value;
}
function commandError(message, request) {
  return Object.assign(new Error(message), { method: request.method, requestId: request.id,
    elapsedMs: Date.now() - request.startedAt, timeoutMs: request.timeoutMs });
}

class CDPClient {
  constructor(ws, { commandTimeoutMs = 30000 } = {}) {
    this.commandTimeoutMs = validateTimeout(commandTimeoutMs);
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.disconnected = null;
    ws.on('close', (code, reason) => this.failPending(`socket closed (${code}): ${String(reason || '')}`));
    ws.on('error', error => this.failPending(`socket error: ${error.message || error}`));
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (['Inspector.targetCrashed', 'Inspector.detached'].includes(msg.method)) {
        this.failPending(`${msg.method}: ${msg.params?.reason || 'target unavailable'}`);
        return;
      }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(commandError(`CDP ${p.method} error: ${JSON.stringify(msg.error)}`, p));
          else p.resolve(msg.result);
        }
      }
    });
  }

  failPending(reason) {
    this.disconnected = reason;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(commandError(`CDP ${p.method} failed: ${reason}`, p));
    }
    this.pending.clear();
  }

  send(method, params = {}, { timeoutMs = this.commandTimeoutMs } = {}) {
    validateTimeout(timeoutMs);
    const id = ++this.id;
    const request = { id, method, timeoutMs, startedAt: Date.now() };
    if (this.disconnected) return Promise.reject(commandError(`CDP ${method} failed: ${this.disconnected}`, request));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(commandError(`CDP ${method} timeout`, request));
        }
      }, timeoutMs);
      this.pending.set(id, { ...request, resolve, reject, timer });
      const fail = error => {
        if (!error || !this.pending.has(id)) return;
        this.pending.delete(id); clearTimeout(timer);
        reject(commandError(`CDP ${method} send failed: ${error.message || error}`, request));
      };
      try { this.ws.send(JSON.stringify({ id, method, params }), fail); }
      catch (error) { fail(error); }
    });
  }

  // Run JS expression in renderer context. Use awaitPromise so async expressions resolve.
  async eval(expression, { awaitPromise = true, returnByValue = true, timeoutMs = this.commandTimeoutMs } = {}) {
    const request = { id: this.id + 1, method: 'Runtime.evaluate', startedAt: Date.now(), timeoutMs };
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    }, { timeoutMs });
    if (r.exceptionDetails) {
      const e = r.exceptionDetails.exception;
      throw commandError(`Eval threw: ${e && (e.description || e.value || JSON.stringify(e))}`, request);
    }
    return r.result && r.result.value !== undefined ? r.result.value : r.result;
  }

  async close() {
    this.failPending('client closed');
    try { this.ws.close(); } catch {}
  }
}

async function connectCDP(wsUrl, { commandTimeoutMs = 30000 } = {}) {
  validateTimeout(commandTimeoutMs);
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  const client = new CDPClient(ws, { commandTimeoutMs });
  await new Promise((resolve, reject) => {
    const request = { id: 0, method: 'connect', startedAt: Date.now(), timeoutMs: 5000 };
    const cleanup = () => { clearTimeout(timer); ws.removeListener('open', opened); ws.removeListener('error', failed); ws.removeListener('close', closed); };
    const opened = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(commandError(`CDP ws connect failed: ${error.message || error}`, request)); };
    const closed = () => failed(new Error('socket closed before open'));
    const timer = setTimeout(() => { failed(new Error('timeout')); client.failPending('connection timed out'); ws.terminate?.(); }, 5000);
    ws.once('open', opened); ws.once('error', failed); ws.once('close', closed);
  });
  return client;
}

// Helper: 找到 main window 的 page target 并连上。
//   filter 可选：返回 boolean 决定是否选这个 target（给了就严格按它选）。
//   不给 filter：优先主窗口 renderer/index.html；Hub 启动后桌宠等小窗口可能排在 CDP 页面清单第一个
//   （2026-10-17 发布分身报：连到了桌宠），主窗口一时没出现就稍等，最多等 waitMainMs 再退回第一个 page。
const isMainWindow = t => t.type === 'page' && /renderer[\\/]index\.html/i.test(String(t.url || ''));
async function listTargets(hub) {
  const http = require('http');
  return new Promise((resolve) => {
    http.get(`${hub.cdpHttpBase}/json/list`, (res) => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

// Independent browser HTTP diagnostics: never use the possibly hung renderer
// WebSocket, and bound the entire response (including partial bodies).
async function snapshotPageTargets(hub) {
  const http = require('http'), timeoutMs = 3000, startedAt = Date.now();
  const url = `${hub.cdpHttpBase}/json/list`;
  return new Promise(resolve => {
    let request, response, settled = false, statusCode = null;
    const finish = (details, destroy = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (destroy) { response?.destroy(); request?.destroy(); }
      resolve({ url, timeoutMs, elapsedMs: Date.now() - startedAt, statusCode, ...details });
    };
    const failed = (error, code) => finish({ ok: false, error: String(error.message || error), code: code || error.code || 'HTTP_ERROR' }, true);
    const timer = setTimeout(() => failed(new Error('CDP target HTTP snapshot timed out after 3000 ms'), 'HTTP_TIMEOUT'), timeoutMs);
    try {
      request = http.get(url, res => {
        response = res; statusCode = res.statusCode;
        res.on('error', error => failed(error));
        res.on('aborted', () => failed(new Error('CDP target HTTP response aborted'), 'HTTP_ABORTED'));
        if (statusCode !== 200) { failed(new Error(`CDP target HTTP status ${statusCode}`), 'HTTP_STATUS'); return; }
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const targets = JSON.parse(body);
            if (!Array.isArray(targets)) throw new Error('CDP target HTTP response is not an array');
            finish({ ok: true, pages: targets.filter(t => t && t.type === 'page').map(({ id, type, url }) => ({ id, type, url })) });
          } catch (error) { failed(error, 'HTTP_INVALID_JSON'); }
        });
      });
      request.on('error', error => failed(error));
    } catch (error) { failed(error); }
  });
}

async function connectFirstPage(hub, filter = null, { waitMainMs = 5000, commandTimeoutMs = 30000 } = {}) {
  validateTimeout(commandTimeoutMs);
  let targets = await listTargets(hub);
  let t = null;
  if (typeof filter === 'function') t = targets.find(filter);
  else {
    for (const end = Date.now() + waitMainMs; !(t = targets.find(isMainWindow)) && Date.now() < end;) {
      await new Promise(r => setTimeout(r, 250));
      targets = await listTargets(hub);
    }
    t = t || targets.find(x => x.type === 'page');
  }
  if (!t) throw new Error(`No matching CDP target for ${hub.label}`);
  const targetSnapshot = Object.freeze({ id: t.id, type: t.type, url: t.url });
  const client = await connectCDP(t.webSocketDebuggerUrl, { commandTimeoutMs });
  client.targetSnapshot = targetSnapshot;
  return client;
}

module.exports = { CDPClient, connectCDP, connectFirstPage, isMainWindow, snapshotPageTargets };
