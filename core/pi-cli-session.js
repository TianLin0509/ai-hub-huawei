'use strict';
// pi 终端会话（r39）：真实 pi TUI 跑在 PTY 里，Hub 的观察扩展（core/pi-cli-observer.mjs）把身份、轮次、消息写进事件日志。
// 结构照 DSH（core/dsh-cli-session.js）：发消息走括号粘贴 + 回车，回执以 pi 自己记下的 user 消息为准；
// 历史以 pi 的会话文件为准（休眠会话也直接读它），卡片复用 Claude 记录的整形（claudeTranscriptTurns）。
// 暂不支持（界面已说明）：Hub 的「问一下」旁路提问、Hub 侧的分支按钮（终端里 /fork 可用）、附件（在终端里 @文件）。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { JsonlTail } = require('./jsonl-tail');
const { captureClaudeMessage, claudeTranscriptTurns } = require('./claude-native-transcript');
const paste = require('./pty-prompt-submit');

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// pi 没有任何可用模型（没登录、没钥匙）时 ctx.model 是 unknown/unknown：当作还没选模型。
const modelName = model => model && model.id && model.provider !== 'unknown' ? `${model.provider}/${model.id}` : '';
const userText = content => typeof content === 'string' ? content
  : (content || []).filter(b => b?.type === 'text').map(b => b.text || '').join('\n');

// pi 的一条消息记进卡片记录（Claude 记录的形状）：assistant 的 text / thinking / toolCall，toolResult 回成 tool_result。
function capturePiMessage(view, message, uuid) {
  if (!message) return;
  const at = Number(message.timestamp) || Date.now();
  const iso = new Date(at).toISOString();
  if (message.role === 'user') {
    view.records.push({ userMessageId: uuid, turnId: uuid, text: userText(message.content), createdAt: at, accepted: true, status: 'running' });
    if (!view._noTrim && require('./native-history-cap').trimRecords(view.records)) view._trimmedRecords = true;   // 内存只留最近若干轮，离线全量回放不裁
    return;
  }
  const record = view.records.at(-1);
  if (!record) return;
  if (message.role === 'assistant') {
    record.partial = null;
    if (message.model) record.model = `${message.provider ? message.provider + '/' : ''}${message.model}`;
    const content = (message.content || []).map(b => b.type === 'toolCall' ? { type: 'tool_use', id: b.id, name: b.name, input: b.arguments }
      : b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking || '' } : b.type === 'text' ? { type: 'text', text: b.text || '' } : null).filter(Boolean);
    if (message.stopReason === 'error' && message.errorMessage) content.push({ type: 'text', text: `（pi 报错：${message.errorMessage}）` });
    captureClaudeMessage(record, { type: 'assistant', uuid, timestamp: iso,
      message: { id: uuid, usage: { input_tokens: message.usage?.input, output_tokens: message.usage?.output }, content } });
    record.lastStop = message.stopReason;
    if (message.stopReason === 'error') record.errorMessage = message.errorMessage || 'pi 请求失败';
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (text) record.finalText = text;
  } else if (message.role === 'toolResult') {
    captureClaudeMessage(record, { type: 'user', uuid, timestamp: iso,
      message: { content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: userText(message.content), is_error: message.isError === true }] } });
  }
}

// pi 会话文件里当前分支上的消息（按 id/parentId 从最后一条往回走；/tree 换过分支的只显示当前分支）。
function readPiSessionMessages(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* 写到一半的末行 */ }
  }
  const header = entries.find(e => e.type === 'session') || null;
  const byId = new Map(entries.filter(e => e.id).map(e => [e.id, e]));
  const chain = [];
  let cur = [...entries].reverse().find(e => e.id && e.type !== 'session');
  const seen = new Set();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); chain.push(cur); cur = cur.parentId ? byId.get(cur.parentId) : null; }
  chain.reverse();
  return { header, messages: chain.filter(e => e.type === 'message' && e.message).map(e => ({ uuid: e.id, message: e.message })) };
}

class PiCliSession extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.isCliProvider = true; this.closed = false;
    this.runtime = { connection: 'starting', state: 'starting', epoch: 1, turnId: null };
    this.records = []; this.contentRevision = 0; this.threadId = null; this.pendingSteers = []; this.seq = 0;
    this.currentModel = options.model || ''; this.currentEffort = options.effort || null;
    this.usageTotals = { input: 0, output: 0, cached: 0, total: 0 };
    const root = path.join(require('./data-dir').getHubDataDir(), 'pi', 'hub-events');
    this.log = path.join(options.eventDir || root, randomUUID() + '.jsonl');
    fs.mkdirSync(path.dirname(this.log), { recursive: true }); fs.writeFileSync(this.log, '');
  }
  get pid() { return this.pty?.pid || null; }
  onData(fn) { this.on('data', fn); return { dispose: () => this.off('data', fn) }; }
  onExit(fn) { this.on('exit', fn); return { dispose: () => this.off('exit', fn) }; }
  resize(cols, rows) { this.cols = cols; this.rows = rows; this.pty?.resize(cols, rows); }
  write(data) { if (this.closed) throw new Error('pi 已退出'); if (process.env.AI_HUB_PI_TRACE_INPUT) { try { fs.appendFileSync(this.log + '.input', JSON.stringify({ at: Date.now(), data: String(data), stack: new Error().stack.split(/\r?\n/).slice(2, 6).join(' | ') }) + String.fromCharCode(10)); } catch {} } this.pty?.write(data); }
  apply(patch) { this.runtime = { ...this.runtime, ...patch }; this.emit('state', this.runtime); }
  lifecycle(type, extra = {}) { this.emit('lifecycle', { type, hubSessionId: this.options.id,
    kind: 'pi', threadId: this.threadId, turnId: this.runtime.turnId, signalSource: 'provider-cli', ...extra }); }
  start() { return this.ready ||= this.launch(); }
  async launch() {
    const ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.tail = new JsonlTail(this.log, row => { try { this.observe(row); } catch (error) { this.fail(error); } });
    await this.tail.start();
    if (this.closed) throw new Error('pi 已关闭');
    this.startTimer = setTimeout(() => this.fail(new Error('pi 启动未确认，请查看终端')), 60000);
    try {
      this.pty = require('./pty-host').spawnPty(require('node-pty'), this.options.launch.command, this.options.launch.args, {
        cwd: this.options.cwd, env: { ...this.options.launch.env, AI_HUB_PI_EVENT_LOG: this.log },
        cols: this.cols || 120, rows: this.rows || 35, name: 'xterm-256color', useConpty: true, conptyInheritCursor: false });
      require('./pty-process-owner').recordPtySpawn(this.pty);
      this.pty.onData(data => { this.output = ((this.output || '') + data).slice(-32768); this.lastOutputAt = Date.now(); this.emit('data', data); });
      this.pty.onExit(info => { this.closed = true; this.fail(new Error('pi 已退出')); this.dispose(); this.emit('exit', info); });
    } catch (error) { this.fail(error); this.dispose(); }
    return ready;
  }
  fail(error) {
    clearTimeout(this.startTimer); this.readyReject?.(error);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve({ ok: false, sendStatus: 'stuck', unconfirmed: true }); this.pending = null; }
    this.apply({ connection: 'disconnected', state: 'failed', reason: error.message }); this.emit('action-error', error.message);
  }
  observe(row) {
    if (this.closed) return;
    if (row.type === 'error') { this.emit('action-error', row.message); return; }
    if (row.type === 'bound') return this.bind(row);
    if (row.sessionId && row.sessionId !== this.threadId) return;
    if (row.type === 'status' && row.status === 'running') {
      if (this.runtime.state !== 'running') { this.apply({ state: 'running', reason: null, turnId: this.records.at(-1)?.turnId || null }); this.lifecycle('turn-started', { startedAt: row.at }); }
    } else if (row.type === 'waiting') this.apply({ state: 'waiting', reason: row.title || 'pi 正在等你在终端里确认' });
    else if (row.type === 'model' && row.model) {
      this.currentModel = modelName(row.model) || this.currentModel;
      this.emit('bound', { threadId: this.threadId, model: this.currentModel, configOptions: this.configOptions });
    } else if (row.type === 'thinking' && row.level) {
      this.currentEffort = row.level;
      this.emit('bound', { threadId: this.threadId, reasoningEffort: row.level, configOptions: this.configOptions });
    } else if (row.type === 'partial') {
      const record = this.records.at(-1);
      if (record && record.status === 'running') { record.partial = row.text || ''; this.contentRevision++; this.emit('items'); }
    } else if (row.type === 'message') this.message(row.message);
    else if (row.type === 'settled') this.settle(row);
  }
  bind(row) {
    if (this.options.resumeId && !this.threadId && row.sessionId !== this.options.resumeId) throw new Error('pi 恢复身份不一致，消息未发送');
    this.threadId = row.sessionId; this.sessionFile = row.sessionFile || null;
    this.records = []; this.seq = 0; this._trimmedRecords = false;
    if (modelName(row.model)) this.currentModel = modelName(row.model);
    if (row.thinking) this.currentEffort = row.thinking;
    // 恢复的会话：把 pi 会话文件里已有的消息补进卡片。
    if (this.sessionFile && fs.existsSync(this.sessionFile)) {
      try { for (const item of readPiSessionMessages(this.sessionFile).messages) capturePiMessage(this, item.message, item.uuid); }
      catch (error) { console.warn('[pi] 读取会话文件失败:', error.message); }
      for (const record of this.records) if (record.status === 'running') record.status = 'completed';
    }
    this.contentRevision++;
    this.emit('bound', { threadId: this.threadId, path: this.sessionFile, cwd: row.cwd, model: this.currentModel,
      reasoningEffort: this.currentEffort, configOptions: this.configOptions });
    this.emit('items');
    this.waitForComposer(row.sessionId).catch(error => this.fail(error));
  }
  async waitForComposer(sessionId) {
    // pi 的输入框没有固定提示词：观察扩展报到之后，终端画面静止 600ms 就当输入框已就绪。
    for (const end = Date.now() + 55000; Date.now() < end && !this.closed;) {
      if (sessionId !== this.threadId) return;
      if ((this.output || '').length && Date.now() - (this.lastOutputAt || 0) > 600) {
        if (this.runtime.connection !== 'connected') {
          this.apply({ connection: 'connected', state: 'idle' }); clearTimeout(this.startTimer); this.readyResolve?.();
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!this.closed) throw new Error('pi 输入界面尚未就绪，消息未发送');
  }
  message(message) {
    const uuid = 'm' + (++this.seq) + '-' + (Number(message.timestamp) || Date.now());
    if (message.role === 'user') {
      const text = userText(message.content);
      const pending = this.pending?.text === text ? this.pending : null;
      const steered = pending ? null : this.takePendingSteer(text);
      const running = this.runtime.state === 'running' && this.records.some(r => r.status === 'running');
      capturePiMessage(this, message, uuid);
      const record = this.records.at(-1);
      record.submissionId = pending?.id || steered?.id;
      if (steered || (running && !pending)) record.steer = true;
      this.apply({ turnId: record.turnId });
      this.lifecycle('prompt-submitted', { text, submittedAt: record.createdAt, clientSubmissionId: record.submissionId });
      if (pending) { clearTimeout(pending.timer); this.pending = null;
        pending.resolve({ ok: true, sendStatus: 'ok', acknowledgementSource: 'provider-cli', threadId: this.threadId, turnId: record.turnId, acknowledgementTurnId: record.turnId, clientSubmissionId: pending.id }); }
    } else {
      capturePiMessage(this, message, uuid);
      if (message.role === 'assistant') this.accountUsage(message.usage);
    }
    this.contentRevision++; this.emit('items');
  }
  settle(row) {
    const record = this.records.at(-1);
    const status = row.aborted ? 'interrupted' : record?.lastStop === 'error' ? 'failed' : 'completed';
    const at = row.at || Date.now();
    for (const item of this.records) if (item.status === 'running') { item.status = status; item.completedAt = at; item.partial = null; }
    this.lastOutcome = { hubSessionId: this.options.id, threadId: this.threadId, turnId: record?.turnId || null, status, completedAt: at,
      signalSource: 'provider-cli', finality: 'provider_final', text: record?.finalText || '', ...(status === 'failed' ? { reason: record?.errorMessage } : {}) };
    this.apply({ state: status, completedAt: at, reason: status === 'failed' ? record?.errorMessage || '' : null });
    this.lifecycle(status === 'completed' ? 'turn-complete' : status === 'interrupted' ? 'turn-aborted' : 'turn-error', this.lastOutcome);
    this.contentRevision++; this.emit('items');
  }
  // pi 每条回复带一次请求的用量：input 是新输入，cacheRead 是复用的前缀，totalTokens 是这次请求占的上下文。
  accountUsage(usage) {
    const fresh = Number(usage?.input), output = Number(usage?.output);
    if (!Number.isFinite(fresh) || !Number.isFinite(output)) return;
    const cached = Number(usage?.cacheRead) > 0 ? Number(usage.cacheRead) : 0;
    const input = fresh + cached;
    this.usageTotals.input += input; this.usageTotals.output += output; this.usageTotals.cached += cached;
    this.usageTotals.total = this.usageTotals.input + this.usageTotals.output;
    const windowed = Number(usage?.totalTokens);
    this.emit('usage', { at: Date.now(), model: this.currentModel || null,
      total: { inputTokens: this.usageTotals.input, outputTokens: this.usageTotals.output, totalTokens: this.usageTotals.total, cachedInputTokens: this.usageTotals.cached },
      context: { used: Number.isFinite(windowed) && windowed > 0 ? windowed : input + output, window: null } });
  }
  takePendingSteer(text) {
    const cutoff = Date.now() - 10 * 60_000;
    this.pendingSteers = this.pendingSteers.filter(entry => entry.at >= cutoff);
    const index = this.pendingSteers.findIndex(entry => entry.text === text);
    return index < 0 ? null : this.pendingSteers.splice(index, 1)[0];
  }
  async send(text, options = {}) {
    await this.start(); text = String(text).replace(/\r\n?/g, '\n');
    if (this.closed || this.runtime.connection !== 'connected') throw Object.assign(new Error('pi 未连接'), { notSent: true });
    if (this.configurePending && !options.configurationCommand) throw Object.assign(new Error('pi 正在确认模型设置'), { notSent: true });
    if (options.attachments?.length) throw Object.assign(new Error('pi 的附件请在终端里用 @文件 添加'), { notSent: true });
    if (this.runtime.state === 'waiting') throw Object.assign(new Error('pi 正在等你在终端里确认，处理后可继续发送'), { notSent: true });
    if (this.pending) throw Object.assign(new Error('上一条消息还在等 pi 确认，请稍候再发'), { notSent: true });
    const command = text.trimStart().startsWith('/');
    // pi 一个模型都没有（没登录、Hub 也没有可用线路）：消息送进去 pi 只在终端里提示，Hub 这边石沉大海。当场说清，不送。
    if (!command && !this.currentModel) throw Object.assign(new Error('pi 还没有可用的模型，这条消息没有发出。'
      + '请在 pi 终端里 /login 登录或 /model 选模型；也可以在 Hub 设置里填 DeepSeek Key，或接入公司模型 / API 网关后新建 pi 会话'), { notSent: true });
    // pi 的输入框运行中也能收：回车会作为插话（steer），在当前步骤结束后送到。
    const steer = !command && this.runtime.state === 'running';
    const id = options.clientSubmissionId || randomUUID();
    if (steer) this.pendingSteers.push({ id, text, at: Date.now() });
    let receipt = null;
    if (!command && !steer) receipt = new Promise(resolve => { this.pending = { id, text, resolve,
      timer: setTimeout(() => { if (this.pending?.id === id) this.pending = null; resolve({ ok: false, sendStatus: 'stuck', unconfirmed: true }); }, 20000) }; });
    options.beforeStart?.();
    this.output = '';
    // Hub 自带的 ConPTY 会把粘贴里的换行（LF）变成 Ctrl+Enter 键，pi 开着 kitty 键盘协议，收到的是 [13;5u 这类键码、原样进了消息；
    // 换成回车（CR）后 pi 照样当换行（r39 实测：自带 ConPTY 下 CR→换行，系统 ConPTY 下 CR 会被当成回车发送，所以只在自带时换）。
    const pasted = this.pty?.hubBundledConpty ? text.replace(/\n/g, '\r') : text;
    await paste.writeBracketedPaste({ writeToSession: (_id, chunk) => this.write(chunk) }, this.options.id, pasted);
    await paste.waitForPasteSettled({ settleMs: paste.computeSettleMs(text.length),
      echoNeedle: paste.echoNeedle(text), readOutputSince: () => this.output });
    this.write('\r');
    if (command) return { ok: true, sendStatus: 'dispatched', commandOutput: '已送入 pi，请在终端查看' };
    if (steer) return { ok: true, sendStatus: 'steered', steer: true, acknowledgementSource: 'native-composer',
      threadId: this.threadId, turnId: this.runtime.turnId, clientSubmissionId: id, message: '已插话，pi 会在当前步骤结束后收到' };
    return receipt;
  }
  readTranscript(options = {}) {
    let source = this.records;
    if (this._trimmedRecords && this.sessionFile && !options.latestTurn && fs.existsSync(this.sessionFile)) {
      const needFull = options.turnId ? !this.records.some(r => r.turnId === options.turnId)
        : (!Number.isFinite(options.limit) || options.fromTail === false || options.limit > this.records.length);
      if (needFull) {
        try {
          const diskRecords = readPiCliRecords(this.sessionFile).records;
          const liveIds = new Set(this.records.map(r => r.userMessageId));
          const minLiveAt = this.records.length ? Math.min(...this.records.map(r => r.createdAt || Infinity)) : Infinity;
          source = [...diskRecords.filter(r => !liveIds.has(r.userMessageId) && (r.createdAt || 0) < minLiveAt), ...this.records];
        } catch { /* 文件不可读时退回内存近期轮次 */ }
      }
    }
    let records = options.turnId ? source.filter(r => r.turnId === options.turnId) : source;
    if (options.latestTurn) records = records.slice(-1);
    // 流式中的半截回复：pi 每 250ms 报一次全文，放成一条临时的 assistant 消息。
    for (const record of records) {
      record.streams ||= new Map();
      if (record.partial && record.status === 'running') record.streams.set('pi-partial', { type: 'assistant', partial: true, uuid: 'pi-partial',
        message: { id: 'pi-partial', content: [{ type: 'text', text: record.partial }] } });
      else record.streams.delete('pi-partial');
    }
    const cards = claudeTranscriptTurns(records).map(card => {
      const record = records.find(r => r.userMessageId === (card.userMessageId || card.id));
      const identity = { providerTurnId: record?.turnId || null, clientSubmissionId: record?.submissionId || null };
      const model = card.role === 'assistant' ? record?.model || this.currentModel || '' : '';
      return { ...card, ...identity, ...(record?.steer ? { steer: true } : {}), ...(model ? { model } : {}), kind: 'pi', source: 'provider-cli',
        ...(card.displayMessages ? { displayMessages: card.displayMessages.map(m => ({ ...m, ...identity })) } : {}) };
    });
    return Number.isFinite(options.limit) ? options.fromTail === false ? cards.slice(0, options.limit) : cards.slice(-options.limit) : cards;
  }
  blocks() { return this.readTranscript({ latestTurn: true }).filter(c => c.role === 'assistant').slice(-1).map(c => ({ type: 'text', text: c.text || '' })); }
  finalText() { return this.blocks().map(b => b.text).join('\n'); }
  async readOutcome(turnId) { return this.lastOutcome?.turnId === turnId ? this.lastOutcome : null; }
  async reconcile() { if (this.runtime.connection !== 'connected') throw new Error('请先恢复 pi 会话'); return this.runtime; }
  // Escape 是 pi 的中断键（和其他终端 Agent 的停止手势一致）。
  async interrupt() { if (['running', 'waiting'].includes(this.runtime.state)) this.write('\x1b'); }
  modelChoices() { return require('./pi-cli-profile').piModelOptions(this.options.config || {}, this.options.launch?.env || process.env); }
  get configOptions() {
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    return [{ id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: this.currentEffort || '',
      options: levels.map(value => ({ value, name: value })) }];
  }
  // 换模型 / 思考强度：在 pi 里打 /model、/thinking，观察扩展报回 model_select / thinking_level_select 才算生效。
  async configure({ model, effort } = {}, { timeoutMs = 15000 } = {}) {
    await this.start();
    if (this.configurePending || this.pending || ['running', 'waiting'].includes(this.runtime.state)) throw new Error('请等当前轮结束后再调整模型');
    this.configurePending = true;
    try {
      for (const [key, value, command] of [['model', model, '/model '], ['effort', effort, '/thinking ']]) {
        if (!value || value === (key === 'model' ? this.currentModel : this.currentEffort)) continue;
        await this.send(command + value, { configurationCommand: true });
        let confirmed = false;
        for (const end = Date.now() + timeoutMs; Date.now() < end && !this.closed;) {
          confirmed = (key === 'model' ? this.currentModel : this.currentEffort) === value;
          if (confirmed) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!confirmed) throw new Error('pi 未确认设置变更，请查看终端；Hub 未更新该设置');
      }
      return { modelId: this.currentModel, displayName: this.currentModel, effort: this.currentEffort, appliesOn: 'next-turn', confirmationSource: 'native-event' };
    } finally { this.configurePending = false; }
  }
  async fork() { throw new Error('pi 会话暂不支持 Hub 的分支按钮，请在终端里用 /fork'); }
  askSide() { return Promise.reject(new Error('pi 会话暂不支持「问一下」，请直接发消息')); }
  dispose() { clearTimeout(this.startTimer); this.tail?.close(); }
  kill() { if (this.closed) return; this.closed = true; this.fail(new Error('pi 已关闭')); this.dispose(); this.pty?.kill(); }
}

// 休眠会话读历史：直接读 pi 的会话文件。
function readPiCliRecords(file) {
  const view = Object.create(PiCliSession.prototype);
  EventEmitter.call(view);
  Object.assign(view, { options: {}, records: [], runtime: {}, pendingSteers: [], currentModel: '', _noTrim: true, usageTotals: { input: 0, output: 0, cached: 0, total: 0 } });
  for (const item of readPiSessionMessages(file).messages) capturePiMessage(view, item.message, item.uuid);
  for (const record of view.records) if (record.status === 'running') record.status = 'completed';
  return view;
}
function readPiCliTranscript(file, options = {}) {
  return readPiCliRecords(file).readTranscript(options);
}
module.exports = { PiCliSession, readPiCliTranscript, readPiSessionMessages, capturePiMessage };
