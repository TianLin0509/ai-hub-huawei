'use strict';
// opencode 终端会话（2026-11-26）：真实 opencode 终端跑在 PTY 里，启动时 --port 打开它自带的本机服务（127.0.0.1 + 随机密码）。
// Hub 和它的分工：
//   发消息  POST /session/<id>/prompt_async（不往终端里粘贴，长文、换行、中文都原样送到）
//   回执    Hub 自带消息编号，事件流里出现这个编号的 user 消息才算送到
//   状态    事件流 session.status busy/idle、permission.asked / question.asked（等你在终端里确认）
//   卡片    事件流里的消息与分片（message.updated / message.part.updated / message.part.delta），整轮结束再整份校对一次
//   终端    /tui/select-session 让终端显示 Hub 绑定的同一个会话，用户在终端里看到的就是这一份
// 历史在 opencode 自己的数据库里；每轮结束 Hub 另存一份快照（休眠会话不启动 opencode 也能看卡片）。
// 暂不支持（界面已说明）：Hub 的「问一下」旁路提问、Hub 侧的分支按钮、附件（在终端里 @文件）、运行中插话。
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { captureClaudeMessage, claudeTranscriptTurns } = require('./claude-native-transcript');

const READY_MARK = 'ctrl+p';   // opencode 终端底栏「ctrl+p commands」：画出来说明终端界面已经连上自己的服务
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorText = error => {
  if (!error) return '';
  const data = error.data || {};
  return String(data.message || data.responseBody || error.message || error.name || 'opencode 请求失败').slice(0, 600);
};
const textOfParts = parts => parts.filter(p => p.type === 'text' && !p.synthetic && !p.ignored).map(p => p.text || '').join('\n');

// opencode 的消息编号：msg_ + 12 位十六进制（毫秒时间 ×4096 + 计数，取低 48 位）+ 14 位随机字母数字，按时间递增。
// Hub 发消息时自己给编号（prompt_async 的 messageID），回执只认这个编号，终端里别的输入不会被错认（审查 #4）。
let idCounter = 0, idLastAt = 0;
function messageId(now = Date.now()) {
  if (now !== idLastAt) { idLastAt = now; idCounter = 0; }
  const head = ((BigInt(now) * 4096n + BigInt(++idCounter)) & 0xffffffffffffn).toString(16).padStart(12, '0');
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = require('node:crypto').randomBytes(14);
  return 'msg_' + head + [...bytes].map(b => chars[b % 62]).join('');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

// opencode 的一组消息 → 卡片记录（Claude 记录的形状，复用 claudeTranscriptTurns）。
function buildRecords(messages, { runningId = null } = {}) {
  const records = [];
  const sorted = [...messages].sort((a, b) => (a.info.time?.created || 0) - (b.info.time?.created || 0) || String(a.info.id).localeCompare(String(b.info.id)));
  for (const { info, parts } of sorted) {
    const list = [...parts.values ? parts.values() : parts];
    const created = Number(info.time?.created) || Date.now();
    if (info.role === 'user') {
      records.push({ userMessageId: info.id, turnId: info.id, text: textOfParts(list), createdAt: created, accepted: true,
        status: info.id === runningId ? 'running' : 'completed' });
      continue;
    }
    const record = records.at(-1);
    if (!record || info.role !== 'assistant') continue;
    if (info.modelID) record.model = `${info.providerID ? info.providerID + '/' : ''}${info.modelID}`;
    const content = [];
    const results = [];
    for (const part of list) {
      if (part.type === 'text' && !part.synthetic) content.push({ type: 'text', text: part.text || '' });
      else if (part.type === 'reasoning') content.push({ type: 'thinking', thinking: part.text || '' });
      else if (part.type === 'tool') {
        const state = part.state || {};
        content.push({ type: 'tool_use', id: part.callID || part.id, name: part.tool || 'tool', input: state.input || {} });
        if (state.status === 'completed' || state.status === 'error') {
          results.push({ type: 'tool_result', tool_use_id: part.callID || part.id, content: String(state.status === 'error' ? state.error || '' : state.output || ''), is_error: state.status === 'error' });
        }
      }
    }
    if (info.error) {
      const message = errorText(info.error);
      if (info.error.name !== 'MessageAbortedError') { content.push({ type: 'text', text: `（opencode 报错：${message}）` }); record.errorMessage = message; }
      else record.aborted = true;
    }
    const iso = new Date(created).toISOString();
    captureClaudeMessage(record, { type: 'assistant', uuid: info.id, timestamp: iso,
      message: { id: info.id, usage: { input_tokens: info.tokens?.input, output_tokens: info.tokens?.output }, content } });
    if (results.length) captureClaudeMessage(record, { type: 'user', uuid: info.id + ':results', timestamp: iso, message: { content: results } });
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (text) record.finalText = text;
    // 一轮里每一步（工具调用前后）各有一份用量，累加起来才是这一轮的消耗（复审 P3）。
    if (info.tokens) {
      const t = record.tokens ||= { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
      t.input += Number(info.tokens.input) || 0; t.output += Number(info.tokens.output) || 0; t.reasoning += Number(info.tokens.reasoning) || 0;
      t.cache.read += Number(info.tokens.cache?.read) || 0; t.cache.write += Number(info.tokens.cache?.write) || 0;
    }
    if (info.time?.completed) record.completedAt = info.time.completed;
  }
  return records;
}

function cardsFrom(records, options = {}, currentModel = '') {
  let list = options.turnId ? records.filter(r => r.turnId === options.turnId) : records;
  if (options.latestTurn) list = list.slice(-1);
  const cards = claudeTranscriptTurns(list).map(card => {
    const record = list.find(r => r.userMessageId === (card.userMessageId || card.id));
    const identity = { providerTurnId: record?.turnId || null, clientSubmissionId: record?.submissionId || null };
    const model = card.role === 'assistant' ? record?.model || currentModel || '' : '';
    return { ...card, ...identity, ...(model ? { model } : {}), kind: 'opencode', source: 'provider-cli',
      ...(card.displayMessages ? { displayMessages: card.displayMessages.map(m => ({ ...m, ...identity })) } : {}) };
  });
  return Number.isFinite(options.limit) ? options.fromTail === false ? cards.slice(0, options.limit) : cards.slice(-options.limit) : cards;
}

// 和本机 opencode 服务说话用 node:http 直连 127.0.0.1：不受 HTTP_PROXY / NODE_USE_ENV_PROXY 影响，
// 事件流也没有 fetch 默认的 5 分钟无数据断流（复审 P1-7）。
const http = require('node:http');
function localRequest(base, auth, method, route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: url.port, path: url.pathname + url.search, method, agent: false,
      headers: { authorization: auth, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('opencode 服务 ' + Math.round(timeoutMs / 1000) + ' 秒没有响应'), { name: 'TimeoutError' })));
    req.on('error', reject);
    req.end(payload || undefined);
  });
}
const TASKKILL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
const modelOf = info => info?.providerID && info?.modelID ? `${info.providerID}/${info.modelID}` : '';

class OpencodeCliSession extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.isCliProvider = true; this.closed = false;
    this.runtime = { connection: 'starting', state: 'starting', epoch: 1, turnId: null };
    this.threadId = null; this.currentModel = options.model || ''; this.currentEffort = null;
    this.messages = new Map();   // 消息 id → { info, parts: Map<分片 id, 分片>, seq（最后一次被实时事件改动的序号）}
    this.knownUsers = new Set(); this.acked = new Map();   // 已确认的 Hub 消息编号 → 提交号
    this.records = []; this.contentRevision = 0; this.usageTotals = { input: 0, output: 0, cached: 0, total: 0 };
    this.output = ''; this.lastOutputAt = 0; this.turnGen = 0; this.settling = false; this.eventSeq = 0;
  }
  get pid() { return this.pty?.pid || null; }
  onData(fn) { this.on('data', fn); return { dispose: () => this.off('data', fn) }; }
  onExit(fn) { this.on('exit', fn); return { dispose: () => this.off('exit', fn) }; }
  resize(cols, rows) { this.cols = cols; this.rows = rows; try { this.pty?.resize(cols, rows); } catch (_) {} }
  write(data) { if (this.closed) throw new Error('opencode 已退出'); this.pty?.write(data); }
  apply(patch) { this.runtime = { ...this.runtime, ...patch }; this.emit('state', this.runtime); }
  lifecycle(type, extra = {}) { this.emit('lifecycle', { type, hubSessionId: this.options.id,
    kind: 'opencode', threadId: this.threadId, turnId: this.runtime.turnId, signalSource: 'provider-cli', ...extra }); }
  get snapshotFile() { return this.threadId ? path.join(this.options.sessionRoot, 'transcript-' + this.threadId + '.json') : null; }
  get busy() { return ['running', 'waiting'].includes(this.runtime.state); }

  // ---------- 本机服务 ----------
  async api(method, route, body, { timeoutMs = 15000 } = {}) {
    if (!this.base) throw new Error('opencode 服务还没就绪');
    const { status, text } = await localRequest(this.base, this.auth, method, route, body, timeoutMs);
    if (status < 200 || status >= 300) throw Object.assign(new Error(`opencode 服务返回 ${status}：${text.slice(0, 200)}`), { status });
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }
  listen() {
    if (this.closed) return;
    const url = new URL('/event', this.base);
    const req = http.get({ host: '127.0.0.1', port: url.port, path: url.pathname, agent: false,
      headers: { authorization: this.auth, accept: 'text/event-stream' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return this.streamLost('事件流 ' + res.statusCode); }
      // 订阅建立之后再校对（先订阅后查询，不留漏事件的空档）：断线期间完成的轮、漏掉的回执、确认框都在这里补上（复审 P1-5）。
      if (this.streamDropped) this.reconcileAfterDrop();
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
          const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let event; try { event = JSON.parse(data); } catch { continue; }
          try { this.observe(event); } catch (error) { console.warn('[opencode] 处理事件失败:', error.message); }
        }
      });
      res.on('end', () => this.streamLost('事件流结束'));
      res.on('error', error => this.streamLost(error.message));
    });
    req.on('error', error => this.streamLost(error.message));
    this.eventRequest = req;
  }
  streamLost(why) {
    if (this.closed || this.streamRetry) return;
    this.streamDropped = true;
    console.warn('[opencode] 事件流断开，重连:', why);
    if (this.busy) this.apply({ reason: 'opencode 事件流断开，正在重连…' });
    this.streamRetry = setTimeout(() => { this.streamRetry = null; this.listen(); }, 500);
  }
  async reconcileAfterDrop() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (let attempt = 0; attempt < 5 && !this.closed; attempt++) {
        try { await this.reconcileState(); this.streamDropped = false; return; }
        catch (error) { console.warn('[opencode] 重连后校对失败，稍后再试:', error.message); await sleep(1000 * (attempt + 1)); }
      }
      if (!this.closed) this.apply({ reason: '和 opencode 的连接不稳定，状态可能没跟上；请看终端，或关掉这个会话再打开' });
    } finally { this.reconciling = false; }
  }

  // ---------- 启动 ----------
  start() { return this.ready ||= this.launch(); }
  async launch() {
    const port = await freePort();
    if (this.closed) throw new Error('opencode 已关闭');
    this.base = 'http://127.0.0.1:' + port;
    this.auth = 'Basic ' + Buffer.from('opencode:' + this.options.password).toString('base64');
    try {
      this.pty = require('./pty-host').spawnPty(require('node-pty'), this.options.launch.command, [...this.options.launch.args, '--port', String(port)], {
        cwd: this.options.cwd, env: this.options.launch.env, cols: this.cols || 120, rows: this.rows || 35,
        name: 'xterm-256color', useConpty: true, conptyInheritCursor: false });
      require('./pty-process-owner').recordPtySpawn(this.pty);
      this.pty.onData(data => { this.output = (this.output + data).slice(-32768); this.lastOutputAt = Date.now(); this.emit('data', data); });
      this.pty.onExit(info => {
        this.exited = true; clearTimeout(this.killTimer);
        const was = this.closed; this.closed = true;
        if (!was) this.fail(new Error('opencode 已退出' + (info?.exitCode ? `（退出码 ${info.exitCode}）` : '')));
        this.dispose(); this.emit('exit', info);
      });
      let up = false;
      // 电脑很忙时 opencode 起服务要二三十秒（整机满载实测 22–79 秒），给足 120 秒。
      for (const end = Date.now() + 120000; Date.now() < end && !this.closed;) {
        try { await this.api('GET', '/global/health', undefined, { timeoutMs: 2000 }); up = true; break; } catch (_) { await sleep(300); }
      }
      if (this.closed) throw new Error(this.exited ? 'opencode 启动后退出了，请看终端里的报错' : 'opencode 已关闭');
      if (!up) throw new Error('opencode 2 分钟内没有启动好，请看终端');
      this.listen();
      // 终端界面连上服务后再让它切会话，太早发的切换会被丢掉（实测）。
      for (const end = Date.now() + 30000; Date.now() < end && !this.closed && !this.output.includes(READY_MARK);) await sleep(100);
      if (this.options.resumeId) {
        const info = await this.api('GET', '/session/' + this.options.resumeId).catch(error => { if (error.status === 404) return null; throw error; });
        if (!info) throw new Error('opencode 里找不到原来的会话（可能在 opencode 里被删了），请新建一个 opencode 会话');
        this.threadId = info.id;
      } else {
        const info = await this.api('POST', '/session', {});
        this.threadId = info.id;
      }
      if (this.closed) throw new Error('opencode 已关闭');
      await this.selectInTerminal();
      await this.reload();
      if (!this.currentModel) this.currentModel = await this.defaultModel().catch(() => '');
      if (this.closed) throw new Error('opencode 已关闭');
      this.emit('bound', { threadId: this.threadId, path: this.snapshotFile, cwd: this.options.cwd, model: this.currentModel, configOptions: this.configOptions });
      this.apply({ connection: 'connected', state: 'idle', reason: null });
    } catch (error) {
      // 启动或绑定没成功：先报真实原因，再收掉本机服务、终端和事件订阅（复审 P1-3：不再被「已关闭」盖掉）。
      if (!this.closed) this.fail(error);
      this.terminate();
      this.ready = null;   // 下次 start 重新试，不永远复用这次的失败
      throw error;
    }
  }
  // 没有 Hub 线路时用 opencode 自己的默认模型：配置里写了 model 就用它，否则取 opencode 认出来的第一个可用模型。
  async defaultModel() {
    const config = await this.api('GET', '/config');
    if (typeof config?.model === 'string' && config.model.includes('/')) return config.model;
    const providers = await this.api('GET', '/config/providers');
    const [provider, model] = Object.entries(providers?.default || {})[0] || [];
    return provider && model ? `${provider}/${model}` : '';
  }
  async selectInTerminal() {
    await sleep(300);
    try { await this.api('POST', '/tui/select-session', { sessionID: this.threadId }); } catch (error) { console.warn('[opencode] 终端切换会话失败:', error.message); }
  }
  fail(error) {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve({ ok: false, sendStatus: 'stuck', unconfirmed: true }); this.pending = null; }
    this.apply({ connection: 'disconnected', state: 'failed', reason: error.message }); this.emit('action-error', error.message);
  }

  // ---------- 事件 ----------
  observe(event) {
    const p = event.properties || {};
    const sid = p.sessionID || p.info?.sessionID || p.part?.sessionID;
    if (!this.threadId || sid !== this.threadId) return;
    switch (event.type) {
      case 'message.updated': {
        const entry = this.entry(p.info);
        entry.info = p.info;
        if (p.info.role === 'user') this.userSeen(p.info.id);
        if (p.info.role === 'assistant') this.modelFromReply(p.info);
        return this.changed();
      }
      case 'message.part.updated': {
        const part = p.part; if (!part) return;
        this.entry({ id: part.messageID, sessionID: sid }).parts.set(part.id, part);
        return this.changed();
      }
      case 'message.part.delta': {
        const entry = this.messages.get(p.messageID); const part = entry?.parts.get(p.partID);
        if (part && p.field) { part[p.field] = (part[p.field] || '') + (p.delta || ''); entry.seq = ++this.eventSeq; }
        return this.changed();
      }
      case 'message.removed': this.messages.delete(p.messageID); return this.changed();
      case 'session.status': {
        const type = p.status?.type;
        if (type === 'busy' || type === 'retry') return this.running({ reason: type === 'retry' ? 'opencode 正在重试模型请求' : null });
        if (type === 'idle') return void this.settle();
        return;
      }
      case 'session.idle': return void this.settle();
      case 'session.error': this.lastError = errorText(p.error); if (p.error?.name === 'MessageAbortedError') this.aborted = true; return;
      case 'permission.asked': case 'permission.v2.asked': case 'question.asked': case 'question.v2.asked':
        return this.apply({ state: 'waiting', reason: event.type.startsWith('question') ? 'opencode 在终端里问你一个问题，请到终端里回答' : 'opencode 正在等你在终端里确认权限' });
      case 'permission.replied': case 'permission.v2.replied': case 'question.replied': case 'question.v2.replied': case 'question.rejected': case 'question.v2.rejected':
        if (this.runtime.state === 'waiting') this.apply({ state: 'running', reason: null });
        return;
      default:
    }
  }
  // 终端里 /models 换的模型从新回复里认出来，并告诉 Hub 更新显示；Hub 刚在模型菜单里选过的，以 Hub 的为准（复审 P2-3）。
  modelFromReply(info) {
    const model = modelOf(info);
    if (!model || model === this.currentModel) return;
    if (this.modelPinnedAt && (info.time?.created || 0) < this.modelPinnedAt) return;
    this.currentModel = model;
    this.emit('bound', { threadId: this.threadId, model, configOptions: this.configOptions });
  }
  entry(info) {
    let entry = this.messages.get(info.id);
    if (!entry) { entry = { info, parts: new Map() }; this.messages.set(info.id, entry); }
    entry.seq = ++this.eventSeq;
    return entry;
  }
  changed() {
    this.contentRevision++;
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => { this.changeTimer = null; this.rebuild(); this.emit('items'); }, 120);
  }
  rebuild() {
    this.records = buildRecords([...this.messages.values()], { runningId: this.busy ? this.runtime.turnId : null });
    for (const record of this.records) {
      const sub = this.acked.get(record.userMessageId);
      if (sub) record.submissionId = sub;
    }
    return this.records;
  }
  userSeen(id) {
    const fresh = !this.knownUsers.has(id);
    this.knownUsers.add(id);
    const pending = this.pending;
    if (pending && pending.messageID === id) {
      // 只认 Hub 这次发出的编号：终端里同时输入的另一条不算这次的回执（审查 #4）。
      this.pending = null; clearTimeout(pending.timer);
      this.acked.set(id, pending.id);
      this.apply({ turnId: id });
      this.lifecycle('prompt-submitted', { text: pending.text, submittedAt: Date.now(), clientSubmissionId: pending.id });
      this.running({ userId: id });
      pending.resolve({ ok: true, sendStatus: 'ok', acknowledgementSource: 'provider-cli', threadId: this.threadId, turnId: id, acknowledgementTurnId: id, clientSubmissionId: pending.id });
      return;
    }
    // 终端里发的新一条：busy 可能先到，这时把这一轮的编号改成新的这条（复审 P2-4）。
    if (fresh && this.busy && this.runtime.turnId !== id && (!this.runtime.turnId || id > this.runtime.turnId)) this.apply({ turnId: id });
  }
  // 开一轮或回到运行：从「等确认」回来也走这里（复审 P1-5）。
  running({ userId = null, reason = null } = {}) {
    // 上一轮正在收尾时又开始干活：这是新的一轮，换代次，收尾那边就不会动新一轮的状态。
    // 收尾途中第二轮已经结束（等着补收尾）又来了第三轮：撤掉补收尾，按新一轮开始（三审可后续 4）。
    if (this.settling && this.newTurnDuringSettle && this.settleAgain) { this.settleAgain = false; this.newTurnDuringSettle = false; }
    if (this.settling && !this.newTurnDuringSettle) {
      this.newTurnDuringSettle = true; this.lastError = null; this.aborted = false; this.turnGen++;
      this.apply({ state: 'running', reason, turnId: userId || this.lastUserId() });
      this.lifecycle('turn-started', { startedAt: Date.now() });
      return;
    }
    if (this.runtime.state === 'running') { if (reason) this.apply({ reason }); if (userId && userId !== this.runtime.turnId) this.apply({ turnId: userId }); return; }
    if (this.runtime.state === 'waiting') { this.apply({ state: 'running', reason }); return; }
    this.lastError = null; this.aborted = false; this.turnGen++;
    const turnId = userId || this.lastUserId();
    this.apply({ state: 'running', reason, turnId });
    this.lifecycle('turn-started', { startedAt: Date.now() });
    this.changed();
  }
  lastUserId() { return [...this.messages.values()].filter(m => m.info.role === 'user').sort((a, b) => (a.info.time?.created || 0) - (b.info.time?.created || 0) || String(a.info.id).localeCompare(String(b.info.id))).at(-1)?.info.id || null; }
  // 一轮结束：对外仍显示「运行中」直到整份校对完（不出现「状态未知」）。校对期间终端里又开了新一轮：
  // 旧轮照样补发完成事件，但不动新一轮的状态（复审 P1-6）。
  async settle() {
    // 收尾途中又有一轮开始并且已经结束：记下来，这次收尾完再收一次，不把它的 idle 吞掉（复审二 P1-4）。
    if (this.settling) { if (this.newTurnDuringSettle) this.settleAgain = true; return; }
    if (!this.busy) return;
    this.settling = true; this.newTurnDuringSettle = false; this.settleAgain = false;
    const gen = this.turnGen, turnId = this.runtime.turnId, at = Date.now();
    let reloadError = null;
    try { await this.reload(); } catch (error) { reloadError = error; } finally { this.settling = false; }
    if (this.closed) return;
    if (reloadError) console.warn('[opencode] 收尾时没能整份校对消息，卡片按已收到的事件显示:', reloadError.message);
    const record = this.records.find(r => r.turnId === turnId) || this.records.at(-1);
    const sameTurn = gen === this.turnGen;
    const status = (sameTurn && this.aborted) || record?.aborted ? 'interrupted' : ((sameTurn && this.lastError) || record?.errorMessage) ? 'failed' : 'completed';
    const reason = status === 'failed' ? (sameTurn && this.lastError) || record?.errorMessage || '' : null;
    const outcome = { hubSessionId: this.options.id, threadId: this.threadId, turnId: record?.turnId || turnId, status, completedAt: at,
      signalSource: 'provider-cli', finality: 'provider_final', text: record?.finalText || '', ...(reason ? { reason } : {}) };
    this.lastOutcome = outcome;
    if (sameTurn) {
      for (const item of this.records) if (item.status === 'running') item.status = status;
      this.apply({ state: status, completedAt: at, reason, turnId: null });
    }
    this.accountUsage(record?.tokens);
    this.lifecycle(status === 'completed' ? 'turn-complete' : status === 'interrupted' ? 'turn-aborted' : 'turn-error', { ...outcome, turnId: outcome.turnId });
    this.contentRevision++; this.emit('items');
    if (this.settleAgain && !this.closed && this.busy) { this.settleAgain = false; await this.settle(); }
  }
  // 整份校对：拿这个会话的全部消息合并进内存（查询期间实时到的新消息与分片保留，不被旧列表抹掉），并另存快照。
  async reload() {
    if (!this.threadId) return;
    // 用事件序号判断「查询发出之后才到的实时更新」：同一毫秒内的更新也分得清（复审二 P2-1）。
    const seq = this.eventSeq;
    const list = await this.api('GET', '/session/' + this.threadId + '/message', undefined, { timeoutMs: 30000 });
    if (!Array.isArray(list) || this.closed) return;
    const merged = new Map();
    for (const m of list) {
      const live = this.messages.get(m.info.id);
      merged.set(m.info.id, live && live.seq > seq ? live
        : { info: m.info, parts: new Map((m.parts || []).map(part => [part.id, part])), seq });
    }
    for (const [id, live] of this.messages) if (!merged.has(id) && live.seq > seq) merged.set(id, live);
    this.messages = merged;
    const users = list.filter(m => m.info.role === 'user').map(m => m.info.id);
    // 等着的回执按编号补上（事件流断开时漏掉的 user 消息，审查 #2）。
    if (this.pending && users.includes(this.pending.messageID)) this.userSeen(this.pending.messageID);
    for (const id of users) this.knownUsers.add(id);
    // 历史里最后一条回复的模型只在 Hub 还不知道用哪个模型时采用，不盖掉用户刚选的（审查 #7）。
    if (!this.currentModel) this.currentModel = modelOf(list.filter(m => m.info.role === 'assistant').at(-1)?.info);
    this.rebuild(); this.contentRevision++; this.emit('items');
    // 快照先写临时文件再改名，写到一半崩了也不毁掉上一份（复审 P2-6）。
    try {
      const tmp = this.snapshotFile + '.' + randomUUID().slice(0, 8) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessionID: this.threadId, savedAt: Date.now(), messages: list }));
      fs.renameSync(tmp, this.snapshotFile);
    } catch (error) { console.warn('[opencode] 快照没写成:', error.message); }
  }
  // 事件流重连后：消息校对；按 opencode 的实际状态和待处理的确认框/提问，补收尾、回到运行或回到「等确认」。
  async reconcileState() {
    const gen = this.turnGen;
    await this.reload();
    const status = await this.api('GET', '/session/status');
    const asks = [];
    for (const route of ['/permission', '/question']) {
      const list = await this.api('GET', route).catch(() => []);
      if (Array.isArray(list)) asks.push(...list.filter(item => item?.sessionID === this.threadId).map(() => route));
    }
    if (this.closed || gen !== this.turnGen) return;   // 查询期间已经有新事件推进了状态，以事件为准
    const busy = status && status[this.threadId] && status[this.threadId].type !== 'idle';
    if (busy && asks.length) this.apply({ state: 'waiting', reason: asks[0] === '/question' ? 'opencode 在终端里问你一个问题，请到终端里回答' : 'opencode 正在等你在终端里确认权限' });
    else if (busy) this.running({ reason: null });
    else if (this.busy) await this.settle();
    else if (this.runtime.reason) this.apply({ reason: null });
  }
  accountUsage(tokens) {
    if (!tokens) return;
    const cached = Number(tokens.cache?.read) || 0;
    const input = (Number(tokens.input) || 0) + cached, output = (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
    this.usageTotals.input += input; this.usageTotals.output += output; this.usageTotals.cached += cached;
    this.usageTotals.total = this.usageTotals.input + this.usageTotals.output;
    this.emit('usage', { at: Date.now(), model: this.currentModel || null,
      total: { inputTokens: this.usageTotals.input, outputTokens: this.usageTotals.output, totalTokens: this.usageTotals.total, cachedInputTokens: this.usageTotals.cached },
      context: { used: input + output, window: null } });
  }

  // ---------- 发送 ----------
  async send(text, options = {}) {
    // 启动失败：这条消息肯定没发出去，标上 notSent，输入框保留原文（三审可后续 3）。
    try { await this.start(); } catch (error) { throw Object.assign(new Error(error.message), { notSent: true }); }
    text = String(text).replace(/\r\n?/g, '\n');
    if (this.closed || this.runtime.connection !== 'connected') throw Object.assign(new Error('opencode 未连接'), { notSent: true });
    if (options.attachments?.length) throw Object.assign(new Error('opencode 的附件请在终端里用 @文件 添加'), { notSent: true });
    if (this.runtime.state === 'waiting') throw Object.assign(new Error('opencode 正在等你在终端里确认，处理后可继续发送'), { notSent: true });
    if (this.runtime.state === 'running' || this.settling) throw Object.assign(new Error('opencode 正在回答上一条，等这一轮结束再发，或先点停止'), { notSent: true });
    if (this.pending) throw Object.assign(new Error('上一条消息还在等 opencode 确认，请稍候再发'), { notSent: true });
    const trimmed = text.trim();
    // 斜杠命令交给 opencode 自己的命令接口（/init、/compact 等项目命令）；终端界面专有的命令（/models、/sessions）请在终端里输入。
    const command = /^\/([A-Za-z0-9._-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (!command && !this.currentModel) throw Object.assign(new Error('opencode 还没有可用的模型，这条消息没有发出。'
      + '请在 opencode 终端里 /connect 登录或 /models 选模型；也可以在 Hub 设置里接入公司模型后新建 opencode 会话'), { notSent: true });
    const id = options.clientSubmissionId || randomUUID();
    options.beforeStart?.();
    await this.selectInTerminal();
    const messageID = messageId();
    const receipt = new Promise(resolve => { this.pending = { id, text, messageID, resolve,
      timer: setTimeout(() => { if (this.pending?.id === id) this.pending = null; resolve({ ok: false, sendStatus: 'stuck', unconfirmed: true }); }, 30000) }; });
    const { provider, id: modelId } = require('./opencode-cli-profile').splitModel(this.currentModel);
    const model = provider && modelId ? { providerID: provider, modelID: modelId } : undefined;
    const route = '/session/' + this.threadId + (command ? '/command' : '/prompt_async');
    const body = command ? { messageID, command: command[1], arguments: command[2] || '', ...(model ? { model: this.currentModel } : {}) }
      : { messageID, parts: [{ type: 'text', text }], ...(model ? { model } : {}) };
    try {
      // 命令接口要等整条命令跑完才返回：10 秒没返回就当已交出，回执以事件为准。
      await this.api('POST', route, body, { timeoutMs: command ? 10000 : 15000 });
    } catch (error) {
      // 已经确认收下的（事件先到）一律算送到；超时、连接中断时先按编号查一次历史；
      // 只有 opencode 明确拒收、且历史里确实没有这条，才算没发出（审查 #1、复审 P1-4）。
      if (this.acked.has(messageID)) return receipt;
      const landed = await this.api('GET', '/session/' + this.threadId + '/message/' + messageID, undefined, { timeoutMs: 5000 }).catch(e => e.status === 404 ? false : null);
      if (landed && landed.info) {
        // 历史里已有：把这条消息本身也记进来，后面的回复才挂得到这一轮（复审二 P1-3）。
        const entry = this.entry(landed.info); entry.info = landed.info;
        for (const part of landed.parts || []) entry.parts.set(part.id, part);
        this.userSeen(messageID); this.changed(); return receipt;
      }
      // 超时或连接中断（没有状态码）时，opencode 可能还在处理：交给回执，到时没等到报「不确定」，不让用户重发（复审二 P1-3）。
      if (!error.status || landed === null) {
        // 只有命令接口超时（命令本身还在跑）才按「已交出」放行；连不上、服务报错时交给回执判定（三审可后续 1）。
        if (command && error.name === 'TimeoutError' && this.pending?.messageID === messageID) { clearTimeout(this.pending.timer); const pending = this.pending; this.pending = null;
          pending.resolve({ ok: true, sendStatus: 'dispatched', commandOutput: '命令已交给 opencode，还在执行，请在终端查看' }); }
        return receipt;
      }
      if (this.pending?.messageID === messageID) { clearTimeout(this.pending.timer); this.pending = null; }
      throw Object.assign(new Error('opencode 没有收下这条消息：' + error.message), { notSent: true });
    }
    // 有的命令不产生用户消息：3 秒内没等到回执，就按「已交给 opencode」放行，不锁住输入框 30 秒（复审 P2-4）。
    if (command && this.pending?.messageID === messageID) {
      await Promise.race([receipt, sleep(3000)]);
      if (this.pending?.messageID === messageID) {
        clearTimeout(this.pending.timer); const pending = this.pending; this.pending = null;
        pending.resolve({ ok: true, sendStatus: 'dispatched', commandOutput: '已交给 opencode 执行，请在终端查看' });
      }
    }
    return receipt;
  }
  readTranscript(options = {}) { return cardsFrom(this.records, options, this.currentModel); }
  blocks() { return this.readTranscript({ latestTurn: true }).filter(c => c.role === 'assistant').slice(-1).map(c => ({ type: 'text', text: c.text || '' })); }
  finalText() { return this.blocks().map(b => b.text).join('\n'); }
  async readOutcome(turnId) { return this.lastOutcome?.turnId === turnId ? this.lastOutcome : null; }
  async reconcile() { if (this.runtime.connection !== 'connected') throw new Error('请先恢复 opencode 会话'); await this.reconcileState(); return this.runtime; }
  // 停止：走 opencode 的 /abort（Hub 停止按钮经 codex:native-action 调到这里，复审 P1-2）；服务不通时在终端连按两次 Esc。
  async interrupt() {
    if (!this.busy || !this.threadId) return { ok: true, idle: true };
    try { await this.api('POST', '/session/' + this.threadId + '/abort', {}); }
    catch (_) { this.write('\x1b'); await sleep(150); this.write('\x1b'); }
    return { ok: true };
  }
  modelChoices() { return Array.isArray(this.options.modelOptions) ? this.options.modelOptions : []; }
  get configOptions() { return []; }
  // 换模型：opencode 每条消息可以带自己的模型，所以只记下，下一条消息起生效（终端里 /models 换的也会从回复里认出来）。
  async configure({ model } = {}) {
    await this.start();
    if (this.pending || this.busy || this.settling) throw new Error('请等当前轮结束后再调整模型');
    if (model) {
      const { provider, id } = require('./opencode-cli-profile').splitModel(model);
      if (!provider || !id) throw new Error('opencode 的模型要写成「线路/模型」');
      // 每个会话只放了启动时那条线路的钥匙：换到别的 Hub 线路的模型下一句必失败，当场说清（复审二 P1-1）。
      const profile = require('./opencode-cli-profile');
      const hubProviders = Object.values(profile.ROUTE_PROVIDERS);
      const own = this.options.route && profile.ROUTE_PROVIDERS[this.options.route];
      if (hubProviders.includes(provider) && provider !== own) throw new Error('这个 opencode 会话只能用启动时那条线路的模型；要换到别的线路，请新建一个 opencode 会话');
      this.currentModel = model; this.modelPinnedAt = Date.now();
      this.emit('bound', { threadId: this.threadId, model: this.currentModel, configOptions: this.configOptions });
    }
    return { modelId: this.currentModel, displayName: this.currentModel, effort: null, appliesOn: 'next-turn', confirmationSource: 'hub' };
  }
  async fork() { throw new Error('opencode 会话暂不支持 Hub 的分支按钮，请在终端里用 /fork 或会话列表里的分支'); }
  askSide() { return Promise.reject(new Error('opencode 会话暂不支持「问一下」，请直接发消息')); }
  dispose() { clearTimeout(this.changeTimer); clearTimeout(this.streamRetry); this.streamRetry = null; try { this.eventRequest?.destroy(); } catch (_) {} }
  // 收掉终端与进程：先正常关终端（实测 3/3 次 opencode 随之退出；先 taskkill 再关 ConPTY 会让 Hub 退出时崩溃）。
  // 兜底：3 秒后还没收到退出事件才按 PID 结束整棵进程树；收到退出事件就取消，免得 PID 被别的进程复用后误杀（复审 P1-3）。
  terminate() {
    this.closed = true; this.dispose();
    // 还没拉起终端就被关：补发一次退出事件，Hub 关会话、退出时等的就是它（复审二 P1-2）。
    if (!this.pty && !this.exited) { this.exited = true; queueMicrotask(() => this.emit('exit', { exitCode: 0 })); return; }
    const pty = this.pty, pid = pty?.pid;
    try { pty?.kill(); } catch (_) {}
    if (pid && process.platform === 'win32' && !this.exited) {
      this.killTimer = setTimeout(() => {
        if (this.exited) return;
        try { require('node:child_process').execFile(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => {}); } catch (_) {}
      }, 3000);
      this.killTimer.unref?.();
    }
  }
  kill() {
    if (this.closed && this.terminated) return;
    if (!this.closed) this.fail(new Error('opencode 已关闭'));
    this.terminated = true;
    this.terminate();
  }
}

// 休眠会话读历史：读 Hub 每轮结束另存的快照。
function readOpencodeCliTranscript(file, options = {}) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const messages = (data.messages || []).map(m => ({ info: m.info, parts: m.parts || [] }));
  return cardsFrom(buildRecords(messages), options);
}
module.exports = { OpencodeCliSession, readOpencodeCliTranscript, buildRecords, freePort, messageId };
