'use strict';
// 把 CodeAgent serve 的 HTTP + 事件流翻译成 Hub 卡片驱动（core/acp-session.js）认识的 ACP 消息。
// 事件格式按公司真机 1.2615.02.03 抓取：文字、思考、工具、权限、提问、中断。
// 本轮结束只认 serve 的 session.idle / session.error，不靠静默时长猜。
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PERMISSION_OPTIONS = [
  { optionId: 'once', name: '允许一次', kind: 'allow_once' },
  { optionId: 'always', name: '本会话都允许', kind: 'allow_always' },
  { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
];
// Windows 短路径（C:\Users\ABCDEF~1\...）传给 serve 时，会话能建但事件不进这条流（公司真机 1.2615.02.03 实测）：一律换成真实长路径。
function canonicalDir(dir) {
  const resolved = path.resolve(dir);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}
const partIndex = id => String(id || '').match(/_(\d+)$/)?.[1] ?? String(id || '');

function userText(info) {
  const content = info?.payload?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some(block => block?.type === 'tool_result')) return '';
  return content.filter(block => block?.type === 'text').map(block => block.text || '').join('');
}

function toolTitle(part) {
  const input = part.state?.input || {};
  const hint = input.description || input.command || input.file_path || input.filepath || input.path || input.pattern || input.query || '';
  return hint ? `${part.tool} · ${String(hint).slice(0, 120)}` : String(part.tool || '工具');
}

class CodeAgentServeClient extends EventEmitter {
  constructor({ host, cwd, model = '', provider = '', permissionMode = 'bypassPermissions', title = '', systemPrompt = '' }) {
    super();
    Object.assign(this, { host, cwd: canonicalDir(cwd), model, provider, permissionMode, title, systemPrompt });
    this.query = '?directory=' + encodeURIComponent(this.cwd);
    this.sessionId = null;
    this.incoming = new Map();
    this.pending = null;
    this.parts = new Map();
    this.toolsSeen = new Set();
    this.userMessages = new Set();
    this.sse = null;
    this.closed = false;
    this.busyWithoutPrompt = false;
    this.onHostExit = error => this.fail(error);
  }
  get proc() { return this.host?.pid ? { pid: this.host.pid } : null; }

  async start() {
    await this.host.ensure();
    this.host.on('exit', this.onHostExit);
    await this._subscribe();
    return { agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } };
  }
  call(method, pathname, body, timeoutMs = 20000) {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port: this.host.port, path: pathname, method, timeout: timeoutMs,
        headers: { Authorization: `Bearer ${this.host.token}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 部分接口只回空文本 */ }
          resolve({ status: res.statusCode, text, json });
        });
      });
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', error => resolve({ status: 0, text: error.message, json: null }));
      if (data) req.write(data);
      req.end();
    });
  }
  _subscribe() {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: this.host.port, path: '/api/v2/event' + this.query,
        headers: { Authorization: `Bearer ${this.host.token}`, Accept: 'text/event-stream' } }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`CodeAgent 事件流连接失败：HTTP ${res.statusCode}`)); return; }
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buffer += chunk.replace(/\r\n/g, '\n');
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            if (!data) continue;
            let event;
            try { event = JSON.parse(data); } catch { continue; }
            try { this.handleEvent(event); } catch (error) { this.fail(error); return; }
          }
        });
        res.on('close', () => { if (!this.closed) this.fail(new Error('CodeAgent 事件流已断开')); });
        resolve();
      });
      req.on('error', error => { if (this.sse === req && !this.closed) this.fail(error); reject(error); });
      this.sse = req;
      req.end();
    });
  }

  async request(method, params = {}) {
    if (this.closed) throw new Error('CodeAgent serve 连接已关闭');
    if (method === 'session/new') return this._create();
    if (method === 'session/load') return this._load(params.sessionId);
    if (method === 'session/prompt') return this._prompt(params);
    if (method === 'session/set_model') { this.model = String(params.modelId || ''); return {}; }
    throw new Error('CodeAgent serve 不支持：' + method);
  }
  async _create() {
    await this._resolveProvider();
    const body = { title: this.title || undefined, permission_mode: this.permissionMode,
      ...(this.model && this.provider ? { model: { providerID: this.provider, id: this.model } } : {}) };
    const res = await this.call('POST', '/api/v2/session' + this.query, body);
    if (res.status >= 300 || !res.json?.id) throw new Error(`新建 CodeAgent 会话失败：${res.status} ${res.text.slice(0, 160)}`);
    this.sessionId = res.json.id;
    if (!this.model && res.json.model?.id) { this.model = res.json.model.id; this.provider = res.json.model.providerID || this.provider; }
    return { sessionId: res.json.id, configOptions: [], models: null, modes: null };
  }
  // 模型 id 在多个供应商下可能重名：优先用调用方给的供应商，否则取 serve 模型清单里第一个可用的。
  async _resolveProvider() {
    if (!this.model || this.provider) return;
    const res = await this.call('GET', '/api/v2/config/providers');
    const { models } = require('./codeagent-serve').parseProviders(res.json);
    const hit = models.find(item => item.id.toLowerCase() === this.model.toLowerCase());
    if (hit) { this.model = hit.id; this.provider = String(hit.provider).split('/')[0]; }
  }
  async _load(sessionId) {
    const res = await this.call('GET', `/api/v2/session/${encodeURIComponent(sessionId)}${this.query}`);
    if (res.status >= 300) throw new Error(`找不到 CodeAgent 会话：${res.status}`);
    this.sessionId = sessionId;
    if (!this.model && res.json?.model?.id) { this.model = res.json.model.id; this.provider = res.json.model.providerID || this.provider; }
    return { sessionId, configOptions: [], models: null, modes: null };
  }
  _prompt({ sessionId, prompt }) {
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, sawBusy: false, error: null, cancelled: false };
      this.pending = pending;
      // 这一轮是用户在真实终端里发的：serve 已经在跑，只接管结果，绝不再发一遍。
      const adopting = this.adopting;
      const promptText = (prompt || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (adopting && adopting.text === promptText) {
        this.adopting = null;
        pending.sawBusy = true;
        if (adopting.idle) setImmediate(() => this.finishTurn());
        return;
      }
      const parts = (prompt || []).map((part, index) => (part.type === 'image'
        ? { type: 'file', mime: part.mimeType, filename: `image-${index}`, url: `data:${part.mimeType};base64,${part.data}` }
        : { type: 'text', text: part.text }));
      this.call('POST', `/api/v2/session/${encodeURIComponent(sessionId)}/prompt_async${this.query}`, { parts,
        permission_mode: this.permissionMode, ...(this.systemPrompt ? { append_system_prompt: this.systemPrompt } : {}),
        ...(this.model && this.provider ? { model: { providerID: this.provider, modelID: this.model } } : {}) }, 30000).then(res => {
        if (res.status >= 200 && res.status < 300) return;
        if (this.pending !== pending) return;
        this.pending = null;
        const error = new Error(res.status ? `CodeAgent 拒绝了这条消息：${res.status} ${res.text.slice(0, 160)}` : `发送失败：${res.text}`);
        if (!res.status) error.uncertain = true;
        reject(error);
        // 不知道 serve 收没收到：走统一的断线恢复，恢复后也不自动重发。
        if (!res.status) this.fail(error);
      });
    });
  }
  async notify(method, params = {}) {
    if (method !== 'session/cancel') return;
    if (this.pending) this.pending.cancelled = true;
    const res = await this.call('POST', `/api/v2/session/${encodeURIComponent(params.sessionId)}/abort${this.query}`, {});
    if (res.status >= 300 || !res.status) throw new Error(`停止失败：${res.status} ${res.text.slice(0, 120)}`);
  }
  async respond(id, result, error, beforeWrite) {
    const asked = this.incoming.get(id);
    if (!asked) return;
    // 卡片这边没有对应的轮次：留给真实终端回答，不替用户拒绝。
    if (error) { this.incoming.delete(id); return; }
    const value = beforeWrite ? beforeWrite(result) : result;
    this.incoming.delete(id);
    let res;
    if (asked.kind === 'permission') {
      const option = value?.outcome?.outcome === 'selected' ? value.outcome.optionId : 'reject';
      res = await this.call('POST', `/api/v1/permission/${encodeURIComponent(asked.requestId)}/reply${this.query}`, { reply: option });
    } else if (value?.outcome?.outcome === 'selected' && value.answers) {
      const answers = asked.questions.map((question, index) => {
        const answer = String(value.answers[String(index)] || '').trim();
        return question.multiSelect ? answer.split(/[,，]\s*/).filter(Boolean) : [answer];
      });
      res = await this.call('POST', `/api/v1/question/${encodeURIComponent(asked.requestId)}/reply${this.query}`, { answers });
    } else {
      res = await this.call('POST', `/api/v1/question/${encodeURIComponent(asked.requestId)}/reject${this.query}`, {});
    }
    if (res.status >= 300 || !res.status) throw new Error(`回复 CodeAgent 失败：${res.status} ${res.text.slice(0, 120)}`);
  }

  update(update) { this.emit('notification', { method: 'session/update', params: { sessionId: this.sessionId, update } }); }

  handleEvent(event) {
    const p = event.properties || {};
    if (!this.sessionId || p.sessionID !== this.sessionId || p.backgroundQuery === true) return;
    switch (event.type) {
      case 'session.status':
        if (p.status?.type === 'busy') {
          if (this.pending) this.pending.sawBusy = true;
          else {
            this.busyWithoutPrompt = true;
            if (this.unclaimedUser) { const text = this.unclaimedUser; this.unclaimedUser = ''; this.adopt(text); }
          }
        } else if (p.status?.type === 'idle') this.onIdle();
        break;
      case 'session.idle': this.onIdle(); break;
      case 'session.error':
        if (this.pending) {
          if (p.error?.name === 'MessageAbortedError' || p.result === 'aborted') this.pending.cancelled = true;
          else this.pending.error = p.error?.message || p.error?.name || 'CodeAgent 执行出错';
        }
        break;
      case 'message.updated': this.onMessage(p.info); break;
      case 'message.part.delta': this.onDelta(p); break;
      case 'message.part.updated': this.onPart(p.part); break;
      case 'permission.asked': this.onPermission(p); break;
      case 'question.asked': this.onQuestion(p); break;
      case 'permission.replied': case 'question.replied': this.emit('request-resolved', p.requestID); break;
      default: break;
    }
  }
  onMessage(info) {
    if (info?.role !== 'user' || !info.id || this.userMessages.has(info.id)) return;
    this.userMessages.add(info.id);
    if (this.pending) return;
    const text = userText(info).trim();
    if (!text) return;
    // 事件顺序不保证：用户消息先到时记下来，等 busy 到了再接管。
    if (!this.busyWithoutPrompt) { this.unclaimedUser = text; return; }
    this.adopt(text);
  }
  // 用户在后台真实终端里自己发的话：卡片接成新一轮，内容照常显示。斜杠命令是终端本地操作，不进卡片。
  adopt(text) {
    if (this.adopting || text.startsWith('/')) return;
    this.adopting = { text, idle: false };
    this.emit('external-prompt', text);
  }
  cancelAdopt(text) { if (this.adopting?.text === text) this.adopting = null; }
  onIdle() {
    this.busyWithoutPrompt = false;
    this.unclaimedUser = '';
    if (this.adopting) this.adopting.idle = true;
    this.finishTurn();
  }
  onDelta({ messageID, partID, field, delta }) {
    if (!delta || (field !== 'text' && field !== 'thinking')) return;
    const key = `${messageID}:${partIndex(partID)}:${field === 'text' ? 'text' : 'thinking'}`;
    this.parts.set(key, (this.parts.get(key) || '') + delta);
    this.chunk(field === 'text', key, delta);
  }
  chunk(isText, messageId, text) {
    this.update({ sessionUpdate: isText ? 'agent_message_chunk' : 'agent_thought_chunk', messageId, content: { type: 'text', text } });
  }
  onPart(part) {
    if (!part) return;
    if (part.type === 'text' || part.type === 'reasoning') {
      const field = part.type === 'text' ? 'text' : 'thinking';
      const key = `${part.messageID}:${partIndex(part.id)}:${field}`;
      const seen = this.parts.get(key) || '';
      const full = String(part.text || '');
      if (full.length > seen.length && full.startsWith(seen)) {
        this.parts.set(key, full);
        this.chunk(part.type === 'text', key, full.slice(seen.length));
      }
      return;
    }
    if (part.type !== 'tool' || !part.callID) return;
    const state = part.state || {};
    const status = state.status === 'completed' ? 'completed' : state.status === 'error' ? 'failed' : 'in_progress';
    const output = state.output ?? state.error;
    const first = !this.toolsSeen.has(part.callID);
    this.toolsSeen.add(part.callID);
    this.update({ sessionUpdate: first ? 'tool_call' : 'tool_call_update', toolCallId: part.callID, title: toolTitle(part),
      kind: 'other', status, rawInput: state.input || {},
      ...(output == null ? {} : { content: [{ type: 'content', content: { type: 'text', text: String(output) } }] }) });
  }
  onPermission(p) {
    const id = 'permission:' + p.id;
    this.incoming.set(id, { kind: 'permission', requestId: p.id });
    const file = p.metadata?.filepath || p.metadata?.command || '';
    this.emit('request', { id, method: 'session/request_permission', params: { sessionId: this.sessionId,
      toolCall: { toolCallId: p.tool?.callID || p.id, title: file ? `${p.permission} · ${file}` : String(p.permission || '工具'), rawInput: p.metadata || {} },
      options: PERMISSION_OPTIONS } });
  }
  onQuestion(p) {
    const id = 'question:' + p.id;
    const questions = p.questions || [];
    this.incoming.set(id, { kind: 'question', requestId: p.id, questions });
    this.emit('request', { id, method: 'session/request_permission', params: { sessionId: this.sessionId,
      toolCall: { toolCallId: p.tool?.callID || p.id, title: 'CodeAgent 需要你的回答',
        _meta: { qwenInteractionKind: 'user_question', qwenQuestions: questions, questionTitle: 'CodeAgent 需要你的回答' } },
      options: [{ optionId: 'answer', name: '提交回答', kind: 'allow_once' }, { optionId: 'cancel', name: '取消', kind: 'reject_once' }] } });
  }
  finishTurn() {
    const pending = this.pending;
    if (!pending || !pending.sawBusy) return;
    this.pending = null;
    if (pending.cancelled) pending.resolve({ stopReason: 'cancelled' });
    else if (pending.error) pending.reject(new Error(pending.error));
    else pending.resolve({ stopReason: 'end_turn' });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.host?.off('exit', this.onHostExit);
    try { this.sse?.destroy(); } catch { /* 已断开 */ }
    const failure = error instanceof Error ? error : new Error(String(error));
    const pending = this.pending;
    this.pending = null;
    if (pending) { const uncertain = new Error(failure.message); uncertain.uncertain = true; pending.reject(uncertain); }
    this.emit('disconnect', failure);
  }
  close() { this.fail(new Error('CodeAgent serve 连接已关闭')); }
}

module.exports = { CodeAgentServeClient, PERMISSION_OPTIONS, canonicalDir };
