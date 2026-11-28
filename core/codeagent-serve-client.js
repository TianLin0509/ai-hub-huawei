'use strict';
// 把 CodeAgent serve 的 HTTP + 事件流翻译成 Hub 卡片驱动（core/acp-session.js）认识的 ACP 消息。
// 事件格式按公司真机 1.2615.02.03 抓取：文字、思考、工具、权限、提问、中断。
// 本轮结束只认 serve 的 session.idle / session.error，不靠静默时长猜。
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { projectSlugOf } = require('./codeagent-transcript-dirs');
const { parseAssistantContent, isClaudeTurnStopReasonTerminal } = require('./claude-transcript-parser');
const { isSyntheticUserEntry } = require('./synthetic-user-filter');

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
const PENDING_TIMEOUT_MS = 30 * 60_000;
const RECOVERY_RESULT_MS = 30_000;
const UNKNOWN_RESULT = '连接中断，服务端结果未知，请在后台终端查看。';
// 事件流断过之后，终态（session.idle）可能正好落在断开的空档里，重订后再也等不到（2026-11-25 / 11-27 反馈：前台一直「等待终态」，
// 后台其实早答完了）。这时改看 CodeAgent 自己写的会话记录 <配置目录>/projects/<目录>/<会话号>.jsonl（公司真机 1.2615.02.03 实测：
// serve 会话同样落这份记录，Hub 读 CodeAgent 回答也靠它的 stop_reason）。只在事件流断过或已判结果不明时才看，事件流正在出字时不看。
// After an event-stream gap the idle event may be lost; settle the turn from CodeAgent's own transcript (same file the TUI writes).
const TRANSCRIPT_POLL_MS = 5000;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_LIVE_QUIET_MS = 3000;
// 卡片自己发的提问：记录里的提问时间不会早于发出前一刻，只留 2 秒时钟余量；终端里自己发、卡片接管的提问会先落盘，放宽到 30 秒。
const PROMPT_CLOCK_SLACK_MS = 2000;
const ADOPTED_CLOCK_SLACK_MS = 30_000;
const squash = text => String(text || '').replace(/\s+/g, '');
// 会话记录里一条用户提问的正文；工具结果、系统插入的元信息不算提问。
function transcriptPromptText(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain) return '';
  const content = entry.message?.content;
  if (typeof content === 'string') return isSyntheticUserEntry(entry, content) ? '' : content;
  if (!Array.isArray(content) || content.some(block => block?.type === 'tool_result')) return '';
  const text = content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n');
  // 后台任务通知、斜杠命令回显等 CLI 自己写的 user 行不是提问，不能挡住本轮提问的匹配。
  return isSyntheticUserEntry(entry, text) ? '' : text;
}
// 从会话记录尾部判断「这一轮」是否已经结束：最后一条真实提问必须是本轮发的（时间、正文都对得上），
// 它之后的最后一条记录是带终态 stop_reason 且有正文的回答，或模型接口报错。认不出就返回 null，继续按原来的「结果未知」处理。
// Returns null unless the last real prompt is this turn's and is followed by a terminal answer or an API error row.
function transcriptTurnOutcome(lines, { startedAt, promptText, adopted = false }) {
  const entries = [];
  for (const line of lines) {
    if (!line || (!line.includes('"user"') && !line.includes('"assistant"'))) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if ((entry?.type === 'user' || entry?.type === 'assistant') && !entry.isSidechain) entries.push(entry);
  }
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) { if (transcriptPromptText(entries[i]).trim()) { start = i; break; } }
  if (start < 0) return null;
  const asked = Date.parse(entries[start].timestamp);
  if (!(asked >= startedAt - (adopted ? ADOPTED_CLOCK_SLACK_MS : PROMPT_CLOCK_SLACK_MS))) return null;
  const want = squash(promptText).slice(0, 200);
  if (want && !squash(transcriptPromptText(entries[start])).includes(want)) return null;
  const tail = entries.slice(start + 1), last = tail.at(-1);
  if (!last || last.type !== 'assistant') return null;
  const message = last.message || {};
  const lastText = parseAssistantContent(message.content).text || '';
  if (last.isApiErrorMessage || (message.model === '<synthetic>' && /^\s*API Error/i.test(lastText))) {
    return { status: 'failed', id: last.uuid || '', error: lastText.trim().slice(0, 300) || 'CodeAgent 模型接口报错' };
  }
  if (!isClaudeTurnStopReasonTerminal(message.stop_reason) || !lastText.trim()) return null;
  // 同一条回答可能拆成几行（每个内容块一行），按 message.id 收齐正文块。
  const rows = message.id ? tail.filter(entry => entry.type === 'assistant' && entry.message?.id === message.id) : [last];
  const blocks = rows.flatMap(entry => (Array.isArray(entry.message?.content) ? entry.message.content : [{ type: 'text', text: entry.message?.content }])
    .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim()).map(block => block.text.replace(/\r\n/g, '\n')));
  const stopReason = ['end_turn', 'stop_sequence'].includes(message.stop_reason) ? 'end_turn' : message.stop_reason;
  return { status: 'completed', id: last.uuid || message.id || '', stopReason, blocks };
}

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
    // 供应商可能带分组后缀（providerId/group）：serve 只认 providerId。
    Object.assign(this, { host, cwd: canonicalDir(cwd), model, provider: String(provider || '').split('/')[0], permissionMode, title, systemPrompt });
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
    this.pendingTimeoutMs = PENDING_TIMEOUT_MS;
    this.messageIds = new Set();
    this.round = 0;
    this.recoveryResultMs = RECOVERY_RESULT_MS;
    this.snapshotRequired = false;
    this.deltaReady = new Set();
    this.transcriptPollMs = TRANSCRIPT_POLL_MS;
    this.liveQuietMs = TRANSCRIPT_LIVE_QUIET_MS;
    this.transcriptFile = null;
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
    // 共享 serve 有新请求：低开销模式下若正节能调度，先同步恢复全速（core/codeagent-serve-host.js noteActivity）。
    try { this.host?.noteActivity?.(); } catch { /* 不影响请求 */ }
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
        res.on('error', error => resolve({ status: 0, text: error.message, json: null }));
      });
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', error => resolve({ status: 0, text: error.message, json: null }));
      if (data) req.write(data);
      req.end();
    });
  }
  _subscribe(round = this.round) {
    if (this.closed) return Promise.reject(new Error('CodeAgent serve 连接已关闭'));
    const previous = this.sse;
    this.sse = null;
    previous?.destroy();
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: this.host.port, path: '/api/v2/event' + this.query,
        headers: { Authorization: `Bearer ${this.host.token}`, Accept: 'text/event-stream' } }, res => {
        req.setTimeout(0);
        if (res.statusCode !== 200) {
          if (this.sse === req) this.sse = null;
          res.resume(); reject(new Error(`CodeAgent 事件流连接失败：HTTP ${res.statusCode}`)); return;
        }
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (this.sse !== req || round !== this.round || this.closed) return;
          buffer += chunk.replace(/\r\n/g, '\n');
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            if (!data) continue;
            let event;
            try { event = JSON.parse(data); } catch { continue; }
            try { this.handleEvent(event, round); } catch (error) { this.fail(error); return; }
          }
        });
        res.on('error', () => this.transportLost(req, new Error('CodeAgent 事件流已断开')));
        res.on('close', () => this.transportLost(req, new Error('CodeAgent 事件流已断开')));
        resolve();
      });
      req.on('error', error => { this.transportLost(req, error); reject(error); });
      req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
      this.sse = req;
      req.end();
    });
  }

  // 事件流只是观察连接；断开不代表服务端停止，也不能拒绝正在等待终态的 prompt。
  transportLost(req, error) {
    if (this.closed || this.sse !== req) return;
    this.sse = null;
    // 缺口后的 delta 没有位置，只能等已证实的 SSE 全文事件重新建立起点。
    this.snapshotRequired = true;
    this.deltaReady.clear();
    if (this.pending && !this.pending.recoveryTimer) {
      const pending = this.pending;
      pending.recoveryTimer = setTimeout(() => {
        if (this.pending === pending) this.markUnknown();
      }, this.recoveryResultMs);
      pending.recoveryTimer.unref?.();
    }
    // 断开前的出字不能证明新订阅在送内容：只认重订之后的。
    if (this.pending) { this.pending.lastLiveAt = 0; this.watchTranscript(this.pending); }
    req.destroy();
    this.emit('transport-disconnect', error);
  }

  markUnknown(message = UNKNOWN_RESULT) {
    if (!this.pending || this.pending.unknown) return;
    this.pending.unknown = true;
    // 保留 promise、轮次及 Stop，迟到终态仍归原轮；绝不把本地期限当服务端终态。
    this.emit('turn-unknown', message);
    // 结果不明期间继续看会话记录：后台答完了就按记录收尾（不是本地期限，是 CodeAgent 写下的终态）。
    if (this.pending) this.watchTranscript(this.pending);
  }

  // 这个 serve 会话的记录文件：先查本工作目录对应的子目录，找不到再扫 projects 下各子目录（公司实测探针同样这么找）。
  locateTranscript() {
    const configDir = this.host?.configDir;
    if (!configDir || !/^[A-Za-z0-9_-]{8,128}$/.test(String(this.sessionId || ''))) return null;
    const name = this.sessionId + '.jsonl';
    if (this.transcriptFile && path.basename(this.transcriptFile) === name && fs.existsSync(this.transcriptFile)) return this.transcriptFile;
    const base = path.join(configDir, 'projects');
    const preferred = [projectSlugOf(this.cwd), this.cwd.replace(/[^A-Za-z0-9]/g, '-')];
    let dirs;
    try { dirs = [...new Set([...preferred, ...fs.readdirSync(base)])]; } catch { return null; }
    for (const dir of dirs) {
      const file = path.join(base, dir, name);
      if (fs.existsSync(file)) { this.transcriptFile = file; return file; }
    }
    return null;
  }
  transcriptSize() {
    const file = this.locateTranscript();
    if (!file) return this.host?.configDir ? 0 : null;
    try { return fs.statSync(file).size; } catch { return 0; }
  }
  watchTranscript(pending) {
    if (pending.transcriptTimer || this.closed || !this.host?.configDir) return;
    pending.transcriptTimer = setInterval(() => { void this.checkTranscript(pending); }, this.transcriptPollMs);
    pending.transcriptTimer.unref?.();
  }
  // 重订成功后马上核对一次：终态落在断开空档里的，不用再等下一次轮询。
  reconcileNow() { return this.pending ? this.checkTranscript(this.pending) : Promise.resolve(false); }
  async checkTranscript(pending) {
    if (this.pending !== pending || this.closed || pending.checking) return false;
    // 事件流正在送本轮的内容：终态会照常从事件流来，不抢先按记录收尾。
    if (pending.lastLiveAt && Date.now() - pending.lastLiveAt < this.liveQuietMs) return false;
    const file = this.locateTranscript();
    if (!file) return false;
    pending.checking = true;
    try {
      const stat = await fs.promises.stat(file);
      const stamp = `${stat.size}:${stat.mtimeMs}`;
      if (pending.transcriptStamp === stamp) return false;
      const base = Number.isFinite(pending.transcriptBase) && pending.transcriptBase <= stat.size ? pending.transcriptBase : null;
      const start = Math.max(stat.size - TRANSCRIPT_TAIL_BYTES, base ?? 0), length = stat.size - start;
      const handle = await fs.promises.open(file, 'r');
      let text;
      try { const buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, start); text = buffer.toString('utf8'); }
      finally { await handle.close(); }
      const lines = text.split(/\r?\n/);
      // 从行中间开始读的，第一行不完整，丢掉；从发出前的文件末尾开始读的，正好在行首。
      if (start > 0 && start !== base) lines.shift();
      const outcome = transcriptTurnOutcome(lines, pending);
      pending.transcriptStamp = stamp;
      if (!outcome || this.pending !== pending || this.closed) return false;
      this.settleFromTranscript(pending, outcome);
      return true;
    } catch { return false; } finally { pending.checking = false; }
  }
  // 按记录补齐卡片上缺的正文（断开期间丢掉的增量），再按记录里的终态结束这一轮。
  settleFromTranscript(pending, outcome) {
    if (outcome.status === 'completed') {
      const used = new Set();
      outcome.blocks.forEach((full, index) => {
        let best = null;
        for (const [key, text] of this.parts) {
          if (!key.endsWith(':text') || used.has(key) || !text) continue;
          if (pending.knownMessages.has(key.slice(0, key.indexOf(':')))) continue;
          if (full.startsWith(text) && (!best || text.length > best.text.length)) best = { key, text };
        }
        if (best) {
          used.add(best.key);
          if (best.text.length < full.length) { this.parts.set(best.key, full); this.chunk(true, best.key, full.slice(best.text.length)); }
          return;
        }
        const key = `transcript-${outcome.id}:${index}:text`;
        // 记成已知消息：下一轮按前缀续接时不会把它当成本轮的开头（审查 P2-3）。
        this.messageIds.add(`transcript-${outcome.id}`);
        used.add(key);
        this.parts.set(key, full);
        this.chunk(true, key, full);
      });
      if (outcome.stopReason !== 'end_turn') pending.stopReason = outcome.stopReason;
    } else pending.error = outcome.error;
    pending.sawBusy = true;
    pending.staleTail = false;
    this.emit('transcript-settled', { status: outcome.status });
    this.finishTurn();
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
  // Lite 会话中途换模型：直接按 serve 自己的模型清单（/api/v2/config/providers）认名字，不读终端菜单。
  // 名字写法不同（显示名、大小写、线路前缀、同版本相近名）走统一对照 core/model-name-match.js；
  // 清单里没有就报一行人话、不改当前模型，免得消息悄悄按服务端默认模型发出去。
  async switchModel(want, provider = '') {
    const name = String(want || '').trim();
    const route = String(provider || '').trim();
    const res = await this.call('GET', '/api/v2/config/providers');
    if (res.status < 200 || res.status >= 300 || !res.json) {
      throw Object.assign(new Error(`读不到 CodeAgent 的模型清单（${res.status ? 'HTTP ' + res.status : res.text || '连接失败'}），模型没有切换，请稍后再试`), { code: 'model-list-unavailable' });
    }
    const all = require('./codeagent-serve').parseProviders(res.json).models;
    const optionText = () => {
      const options = [...new Set(all.map(m => m.label || m.id))];
      return options.length ? `（可选：${options.slice(0, 12).join('、')}${options.length > 12 ? ' 等' : ''}）` : '';
    };
    // 指定了线路：只在这条线路里找；线路这次不可用就照实报，不悄悄换到别的线路。
    const key = value => String(value || '').toLowerCase();
    let pool = all;
    if (route) {
      pool = all.filter(m => key(m.provider) === key(route));
      if (!pool.length && !route.includes('/')) pool = all.filter(m => key(m.provider).split('/')[0] === key(route));
      if (!pool.length) throw Object.assign(new Error(`这个账号的 CodeAgent 这次没有报出线路 ${route}，模型没有切换，请换一个${optionText()}`), { code: 'model-route-unavailable' });
    }
    // 同一个 id 挂在多条线路下时按 id 去重后再认名字；没指定线路就用清单里排在前面的那条（与启动时一致）。
    const entries = pool.filter((m, i) => pool.findIndex(x => key(x.id) === key(m.id)) === i);
    const match = require('./model-name-match');
    const catalog = entries.map(m => ({ id: m.id, label: m.label }));
    const ids = entries.map(m => m.id), labels = entries.map(m => m.label || m.id);
    let found = match.resolveName(name, ids, { catalog });
    if (found.index < 0) found = match.resolveName(name, labels, { catalog });
    let near = null;
    if (found.index < 0) {
      near = match.resolveName(name, ids, { catalog, allowSimilar: true });
      if (near.index < 0 && near.kind !== 'ambiguous') {
        const byLabel = match.resolveName(name, labels, { catalog, allowSimilar: true });
        if (byLabel.index >= 0 || byLabel.kind === 'ambiguous') near = byLabel;
      }
      if (near.index >= 0) found = near;
    }
    if (found.index < 0) {
      // 与 PTY 菜单同一口径（core/model-name-match.js fallbackNote）：同版本几条分不清、或同家族只有别的版本时不替换，保留当前模型并说明一行。
      if (near && (near.kind === 'ambiguous' || (near.sameFamily || []).length)) {
        const note = match.fallbackNote(name, near).replace('模型菜单里没有', '模型清单里没有').replace(/，沿用账号默认模型$/, '');
        throw Object.assign(new Error(`${note}，模型没有切换（仍用 ${this.model || '当前模型'}），请直接选具体的一个`), { code: 'model-name-fallback', nameFallback: true });
      }
      throw Object.assign(new Error(all.length
        ? `这个账号的 CodeAgent 模型清单里没有 ${name}，请换一个${optionText()}`
        : `CodeAgent 这次没报出可用模型，没能切到 ${name}，请稍后再试或换一个`), { code: 'model-not-listed' });
    }
    const hit = entries[found.index];
    if (!require('./model-id').isSafeModelId(hit.id)) throw Object.assign(new Error(`CodeAgent 清单里的模型名 ${hit.id} 无法使用，请换一个`), { code: 'model-not-listed' });
    this.model = hit.id;
    this.provider = String(hit.provider).split('/')[0];
    return { id: hit.id, label: hit.label || hit.id, provider: hit.provider, providerLabel: hit.providerLabel || '', kind: found.kind };
  }
  async _load(sessionId) {
    const res = await this.call('GET', `/api/v2/session/${encodeURIComponent(sessionId)}${this.query}`);
    if (res.status >= 300) throw new Error(`找不到 CodeAgent 会话：${res.status}`);
    this.sessionId = sessionId;
    if (!this.model && res.json?.model?.id) { this.model = res.json.model.id; this.provider = res.json.model.providerID || this.provider; }
    return { sessionId, configOptions: [], models: null, modes: null };
  }
  _prompt({ sessionId, prompt }) {
    if (this.pending) return Promise.reject(new Error('上一轮结果尚未确认，请在后台终端查看。'));
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, round: ++this.round, sawBusy: false, error: null, cancelled: false, knownMessages: new Set(this.messageIds),
        startedAt: Date.now(), promptText: '', lastLiveAt: 0 };
      this.pending = pending;
      this.snapshotRequired = false;
      pending.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        this.markUnknown('等待结果超时，服务端结果未知，请在后台终端查看。');
      }, this.pendingTimeoutMs);
      pending.timer.unref?.();
      // 这一轮是用户在真实终端里发的：serve 已经在跑，只接管结果，绝不再发一遍。
      const adopting = this.adopting;
      const promptText = (prompt || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      pending.promptText = promptText;
      if (adopting && adopting.text === promptText) {
        this.adopting = null;
        pending.sawBusy = true;
        pending.submitted = true;
        // 接管时不丢弃正在接收的终端事件；同一订阅重新绑定到本轮。
        this.round -= 1;
        pending.round = this.round;
        pending.adopted = true;
        if (adopting.idle) setImmediate(() => this.finishTurn());
        return;
      }
      // 发出前记下会话记录当时的长度：之后只在新写入的部分里找本轮提问，上一轮的问答再像也认不成本轮（审查 P1-2）。
      pending.transcriptBase = this.transcriptSize();
      const parts = (prompt || []).map((part, index) => (part.type === 'image'
        ? { type: 'file', mime: part.mimeType, filename: `image-${index}`, url: `data:${part.mimeType};base64,${part.data}` }
        : { type: 'text', text: part.text }));
      // 新轮 POST 前切换订阅代次，旧连接队列里的回调不得作用于新轮。
      this._subscribe(pending.round).then(() => {
        if (this.closed || this.pending !== pending) return null;
        pending.submitted = true;
        return this.call('POST', `/api/v2/session/${encodeURIComponent(sessionId)}/prompt_async${this.query}`, { parts,
          permission_mode: this.permissionMode, ...(this.systemPrompt ? { append_system_prompt: this.systemPrompt } : {}),
          ...(this.model && this.provider ? { model: { providerID: this.provider, modelID: this.model } } : {}) }, 30000);
      }).then(res => {
        if (!res) return;
        if (res.status >= 200 && res.status < 300) return;
        if (this.pending !== pending) return;
        this.pending = null;
        clearTimeout(pending.timer);
        clearTimeout(pending.recoveryTimer);
        const error = new Error(res.status ? `CodeAgent 拒绝了这条消息：${res.status} ${res.text.slice(0, 160)}` : `发送失败：${res.text}`);
        if (!res.status) error.uncertain = true;
        reject(error);
        // 不知道 serve 收没收到：走统一的断线恢复，恢复后也不自动重发。
        if (!res.status) this.fail(error);
      }).catch(error => { if (this.pending === pending) this.fail(error); });
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

  handleEvent(event, round = this.round) {
    const p = event.properties || {};
    if (round !== this.round || !this.sessionId || p.sessionID !== this.sessionId || p.backgroundQuery === true) return;
    if (this.pending && !this.pending.submitted) return;
    const messageId = p.messageID || p.part?.messageID || p.info?.id;
    if (this.pending && messageId) {
      if (this.pending.knownMessages.has(messageId)) { this.pending.staleTail = true; return; }
      this.pending.staleTail = false;
    }
    if (!this.pending && !['message.updated', 'session.status', 'session.idle'].includes(event.type)) return;
    if (this.pending && ['message.part.delta', 'message.part.updated', 'permission.asked', 'question.asked'].includes(event.type)) this.pending.lastLiveAt = Date.now();
    // 低开销模式 L7：转忙碌、要审批、要回答时唤醒共享 serve；其余事件（输出、答完）只刷新活动时间，2 分钟空闲从这时算起。
    try {
      if ((event.type === 'session.status' && p.status?.type === 'busy') || event.type === 'permission.asked' || event.type === 'question.asked') this.host?.noteActivity?.();
      else this.host?.touchActivity?.();
    } catch { /* 不影响事件处理 */ }
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
        if (this.pending && !this.pending.staleTail) {
          this.pending.sawBusy = true;
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
    if (info?.id) this.messageIds.add(info.id);
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
    if (this.pending) this.pending.sawBusy = true;
    if (messageID) this.messageIds.add(messageID);
    // 恢复后的 delta 没有位置；等 SSE 全文更新再续接。
    const key = `${messageID}:${partIndex(partID)}:${field === 'text' ? 'text' : 'thinking'}`;
    if (this.snapshotRequired && !this.deltaReady.has(key)) return;
    this.parts.set(key, (this.parts.get(key) || '') + delta);
    this.chunk(field === 'text', key, delta);
  }
  chunk(isText, messageId, text) {
    this.update({ sessionUpdate: isText ? 'agent_message_chunk' : 'agent_thought_chunk', messageId, content: { type: 'text', text } });
  }
  onPart(part) {
    if (!part) return;
    if (this.pending) this.pending.sawBusy = true;
    if (part.messageID) this.messageIds.add(part.messageID);
    if (part.type === 'text' || part.type === 'reasoning') {
      const field = part.type === 'text' ? 'text' : 'thinking';
      const key = `${part.messageID}:${partIndex(part.id)}:${field}`;
      const seen = this.parts.get(key) || '';
      const full = String(part.text || '');
      // 流内全文追上旧前缀后，这个 part 后续的 delta 才有可靠的起点。
      if (full.startsWith(seen)) this.deltaReady.add(key);
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
    if (!pending || !pending.sawBusy || pending.staleTail) return;
    this.pending = null;
    clearTimeout(pending.timer);
    clearTimeout(pending.recoveryTimer);
    clearInterval(pending.transcriptTimer);
    if (pending.cancelled) pending.resolve({ stopReason: 'cancelled' });
    else if (pending.error) pending.reject(new Error(pending.error));
    else pending.resolve({ stopReason: pending.stopReason || 'end_turn' });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.host?.off('exit', this.onHostExit);
    try { this.sse?.destroy(); } catch { /* 已断开 */ }
    const failure = error instanceof Error ? error : new Error(String(error));
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending?.timer);
    clearTimeout(pending?.recoveryTimer);
    clearInterval(pending?.transcriptTimer);
    if (pending) { const uncertain = new Error(failure.message); uncertain.uncertain = true; pending.reject(uncertain); }
    this.emit('disconnect', failure);
  }
  close() { this.fail(new Error('CodeAgent serve 连接已关闭')); }
}

module.exports = { CodeAgentServeClient, PERMISSION_OPTIONS, canonicalDir, transcriptTurnOutcome };
