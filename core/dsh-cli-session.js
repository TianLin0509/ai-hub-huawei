'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { JsonlTail } = require('./jsonl-tail');
const { captureClaudeMessage, claudeTranscriptTurns } = require('./claude-native-transcript');
const paste = require('./pty-prompt-submit');
const textOf = content => (content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
// The native question panel keeps stdin until the terminal answers it. The Hub
// cannot answer for the user, so it publishes the question verbatim: the status
// line names it and the "到终端处理" panel points at the right terminal.
// Options stay inline on one line on purpose — numbered lines would be parsed as
// quick-reply chips, and those fill the composer (blocked while waiting).
function describeQuestion(raw) {
  let input; try { input = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return ''; }
  const list = Array.isArray(input?.questions) ? input.questions : (input?.question ? [input] : []);
  return list.map(question => {
    const text = String(question?.question || '').trim();
    const options = (question?.options || []).map(option => String(option?.label || '').trim()).filter(Boolean);
    if (!text && !options.length) return '';
    return options.length ? `${text}（${options.join(' / ')}）` : text;
  }).filter(Boolean).join(' / ').slice(0, 400);
}
class DshCliSession extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.isCliProvider = true; this.closed = false;
    this.runtime = { connection: 'starting', state: 'starting', epoch: 1, turnId: null };
    this.records = []; this.contentRevision = 0; this.threadId = null;
    // Interjections are acknowledged at the composer, so their submission id is
    // claimed when the native user/message finally lands (one entry per send).
    this.pendingSteers = [];
    // Native usage is per request: inputTokens is the whole prompt that request
    // carried, so the sum is the real consumption while the last one is the
    // live context occupancy. request/context owns the window size.
    this.usageTotals = { input: 0, output: 0, cached: 0, total: 0 };
    this.contextWindow = null; this.contextUsed = null;
    // Background jobs run outside the turn's visible tool row; their lifecycle
    // is the only signal that a "long silence" is work in progress.
    this.jobs = new Map();
    this.log = path.join(options.home, '.dsh', 'hub-events', randomUUID() + '.jsonl');
    fs.mkdirSync(path.dirname(this.log), { recursive: true }); fs.writeFileSync(this.log, '');
  }
  get pid() { return this.pty?.pid || null; }
  onData(fn) { this.on('data', fn); return { dispose: () => this.off('data', fn) }; }
  onExit(fn) { this.on('exit', fn); return { dispose: () => this.off('exit', fn) }; }
  resize(cols, rows) { this.cols = cols; this.rows = rows; this.pty?.resize(cols, rows); }
  write(data) { if (this.closed) throw new Error('DSH CLI 已退出'); this.pty?.write(data); }
  apply(patch) { this.runtime = { ...this.runtime, ...patch }; this.emit('state', this.runtime); }
  lifecycle(type, extra = {}) { this.emit('lifecycle', { type, hubSessionId: this.options.id,
    kind: this.options.kind, threadId: this.threadId, turnId: this.runtime.turnId, signalSource: 'provider-cli', ...extra }); }
  start() { return this.ready ||= this.launch(); }
  async launch() {
    const ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.tail = new JsonlTail(this.log, row => { try { this.observe(row); } catch (error) { this.fail(error); } });
    await this.tail.start();
    if (this.closed) throw new Error('DSH CLI 已关闭');
    this.startTimer = setTimeout(() => this.fail(new Error('DSH CLI 启动未确认，请查看终端')), 60000);
    try {
      this.pty = require('node-pty').spawn(this.options.launch.command, this.options.launch.args, {
        cwd: this.options.cwd, env: { ...this.options.launch.env, AI_HUB_DSH_EVENT_LOG: this.log },
        cols: this.cols || 120, rows: this.rows || 35, name: 'xterm-256color', useConpty: true, conptyInheritCursor: false });
      require('./pty-process-owner').recordPtySpawn(this.pty);
      this.pty.onData(data => { this.output = ((this.output || '') + data).slice(-32768); this.emit('data', data); });
      this.pty.onExit(info => { this.closed = true; this.fail(new Error('DSH CLI 已退出')); this.dispose(); this.emit('exit', info); });
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
    if (row.type === 'ready') { this.bootReady = true; return; }
    if (row.type === 'bound') {
      if (!this.threadId && this.options.resumeId && row.sessionId !== this.options.resumeId) throw new Error('DSH 恢复身份不一致，消息未发送');
      if (path.resolve(row.cwd || '') !== path.resolve(this.options.cwd)) throw new Error('DSH 工作目录不一致');
      this.threadId = row.sessionId; this.records = []; this.seen = new Set();
      this.routeChecked = false; this.lastOutcome = null; this.activeTurn = null;
      this.runtime = { ...this.runtime, turnId: null };
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve({ ok: false, sendStatus: 'stuck', unconfirmed: true }); this.pending = null; }
      this.pendingSteers = [];
      this.currentModel = row.model || this.options.model;
      this.currentEffort = row.effort;
      for (const event of row.events || []) this.event(event, true);
      this.emit('bound', { threadId: this.threadId, path: this.log, cwd: row.cwd, model: this.currentModel, configOptions: this.configOptions });
      this.waitForComposer(row.sessionId, row.status).catch(error => this.fail(error)); return;
    }
    if (row.sessionId !== this.threadId) return;
    if (row.type === 'event') this.event(row.event);
    else if (row.type === 'stream') this.stream(row.frame);
    else if (row.type === 'waiting') this.apply({ state: 'waiting' });
    else if (row.type === 'status' && row.status === 'running') this.apply({ state: 'running' });
    else if (row.type === 'error') this.emit('action-error', row.message);
  }
  stream(frame) {
    // Usage frames carry no attemptId and arrive once per request, so they are
    // accounted before the attempt lookup (which a usage frame would miss).
    if (frame.type === 'chunk' && frame.chunk?.type === 'usage') { this.accountUsage(frame.chunk.usage); return; }
    const record = this.records.at(-1); if (!record) return;
    if (frame.type === 'start') {
      record.streams ||= new Map();
      record.streams.set(frame.attemptId, { type: 'assistant', partial: true, uuid: frame.attemptId,
        message: { id: frame.attemptId, content: [] } });
    } else if (frame.type === 'end') record.streams?.delete(frame.attemptId);
    else {
      const message = record.streams?.get(frame.attemptId)?.message, chunk = frame.chunk;
      if (message && ['text-delta', 'reasoning-delta'].includes(chunk?.type)) {
        const index = chunk.index ?? 0, thinking = chunk.type === 'reasoning-delta';
        const block = message.content[index] ||= thinking ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' };
        block[thinking ? 'thinking' : 'text'] += chunk.text || '';
      }
    }
    this.contentRevision++; this.emit('items');
  }
  async waitForComposer(sessionId, nativeStatus) {
    // Native discovery is published only after the TUI renderer has mounted.
    // agent/created alone precedes stdin readiness and loses early PTY input.
    const file = path.join(this.options.home, '.dsh-tui/inject/servers.json');
    for (const end = Date.now() + 55000; Date.now() < end && !this.closed;) {
      let entries = []; try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      const painted = /Say something|说点什么|❯/.test((this.output || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''));
      if (this.bootReady && painted && Array.isArray(entries) && entries.some(e => e.pid === this.pid && e.sessionId === sessionId
        && path.resolve(e.cwd) === path.resolve(this.options.cwd))) {
        if (sessionId !== this.threadId) return;
        this.apply({ connection: 'connected', state: nativeStatus === 'running' || this.records.at(-1)?.status === 'running' ? 'running' : 'idle', turnId: this.activeTurn }); clearTimeout(this.startTimer);
        this.prefWatcher?.close();
        this.prefWatcher = fs.watch(path.join(this.options.home, '.dsh-tui'), { persistent: false }, (_event, file) => {
          if (['model.json', 'effort.json'].includes(String(file))) this.observePreferences(String(file));
        });
        this.readyResolve?.(); return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!this.closed) throw new Error('DSH 输入界面尚未就绪，消息未发送');
  }
  event(event, replay = false) {
    if (this.seen.has(event.seq)) return;
    this.seen.add(event.seq);
    const d = event.data || {}, at = Number(event.time) || Date.parse(event.time) || Date.now();
    if (event.type === 'turn/start') {
      this.activeTurn = String(d.turn);
      if (!replay) { this.apply({ state: 'running', turnId: this.activeTurn }); this.lifecycle('turn-started', { startedAt: at }); }
    }
    if (event.type === 'user/message' && d.source?.kind === 'user') {
      const text = textOf(d.content), pending = !replay && this.pending?.text === text ? this.pending : null;
      const steered = replay ? null : this.takePendingSteer(text);
      // A message that lands while this very turn already has an open record is
      // an interjection, not the turn's opening prompt.
      const steer = !!steered || (!replay && this.runtime.state === 'running'
        && this.records.some(r => r.turnId === this.activeTurn && r.status === 'running'));
      this.records.push({ userMessageId: d.id || String(event.seq), turnId: this.activeTurn,
        text, createdAt: at, accepted: true, status: 'running',
        submissionId: pending?.id || steered?.id, ...(steer ? { steer: true } : {}) });
      if (!replay) {
        this.lifecycle('prompt-submitted', { text, submittedAt: at, clientSubmissionId: pending?.id || steered?.id });
        if (pending) { clearTimeout(pending.timer); this.pending = null;
          pending.resolve({ ok: true, sendStatus: 'ok', acknowledgementSource: 'provider-cli',
            threadId: this.threadId, turnId: this.runtime.turnId, clientSubmissionId: pending.id }); }
      }
    }
    const record = this.records.at(-1);
    const header = d.header?.config || d.header;
    if (event.type === 'request/header' && header?.model) {
      this.currentModel = header.model;
      this.currentEffort = header.reasoningEffort;
      if (!replay) this.emit('bound', { threadId: this.threadId, model: this.currentModel,
        reasoningEffort: header.reasoningEffort, configOptions: this.configOptions });
    }
    if (event.type === 'request/context' && Number(d.contextWindow) > 0) {
      const window = Number(d.contextWindow);
      if (window !== this.contextWindow) { this.contextWindow = window; this.emitUsage(); }
    }
    if (record && event.type === 'assistant/message') {
      record.streams?.clear();
      record.finalText = textOf(d.message?.content);
      captureClaudeMessage(record, { type: 'assistant', uuid: String(event.seq), timestamp: new Date(at).toISOString(),
        message: { id: String(event.seq), usage: { input_tokens: d.usage?.inputTokens, output_tokens: d.usage?.outputTokens }, content: (d.message?.content || []).map(b => b.type === 'reasoning'
          ? { type: 'thinking', thinking: b.text || '' } : b) } });
    } else if (record && event.type === 'tool/call') {
      if (!replay && d.name === 'ask_user_question') this.apply({ state: 'waiting', reason: describeQuestion(d.arguments) });
      let input; try { input = JSON.parse(d.arguments); } catch { input = d.arguments; }
      captureClaudeMessage(record, { type: 'assistant', uuid: 'tool-' + event.seq, timestamp: new Date(at).toISOString(),
        message: { id: 'tool-' + event.seq, content: [{ type: 'tool_use', id: d.callId, name: d.name, input }] } });
    } else if (record && event.type === 'tool/result') {
      if (!replay && this.runtime.state === 'waiting') this.apply({ state: 'running', reason: null });
      captureClaudeMessage(record, { type: 'user', uuid: 'result-' + event.seq, timestamp: new Date(at).toISOString(),
        message: { content: [{ type: 'tool_result', tool_use_id: d.message?.source?.callId,
          content: textOf(d.message?.content), is_error: d.isError === true }] } });
    } else if (record && event.type === 'turn/end') {
      const kind = d.reason?.kind;
      const status = kind === 'completed' ? 'completed' : ['aborted', 'interrupted'].includes(kind) ? 'interrupted' : 'failed';
      // A steered message opens another record inside the same native turn; the
      // turn's end settles every open record, not just the newest one.
      for (const item of this.records) if (item.turnId === String(d.turn) && item.status === 'running') {
        item.status = status; item.completedAt = at;
      }
      record.status = status; record.completedAt = at;
      this.lastOutcome = { hubSessionId: this.options.id, threadId: this.threadId, turnId: String(d.turn),
        status, completedAt: at, signalSource: 'provider-cli', finality: 'provider_final', text: record.finalText,
        ...(d.reason?.error?.message ? { reason: d.reason.error.message } : {}) };
      if (!replay) { this.apply({ state: status, completedAt: at,
        reason: status === 'failed' ? (d.reason?.error?.message || '') : null });
        this.lifecycle(status === 'completed' ? 'turn-complete' : status === 'interrupted' ? 'turn-aborted' : 'turn-error', this.lastOutcome); }
    }

    if (event.type === 'job/registered' || event.type === 'job/settled') this.trackJob(event.type, d, at);
    this.contentRevision++; this.emit('items');
  }
  trackJob(type, data, at) {
    const id = String(data?.jobId || '');
    if (!id) return;
    const previous = this.jobs.get(id) || {};
    this.jobs.set(id, {
      id, kind: String(data?.kind || previous.kind || ''),
      label: String(data?.label || previous.label || ''),
      startedAt: Number(data?.startedAt) || previous.startedAt || at,
      status: type === 'job/registered' ? 'running' : String(data?.status || 'settled'),
      ...(type === 'job/settled' ? { finishedAt: Number(data?.finishedAt) || at, detail: String(data?.detail || '') } : {}),
    });
    // Settled jobs stay for the tooltip but must not grow the map forever.
    const settled = [...this.jobs.values()].filter(job => job.status !== 'running')
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    for (const job of settled.slice(6)) this.jobs.delete(job.id);
    this.emitJobs();
  }
  emitJobs() {
    const running = [...this.jobs.values()].filter(job => job.status === 'running');
    const recent = [...this.jobs.values()].filter(job => job.status !== 'running')
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)).slice(0, 3);
    this.emit('jobs', {
      running: running.map(job => ({ id: job.id, kind: job.kind, label: job.label, startedAt: job.startedAt })),
      recent: recent.map(job => ({ id: job.id, kind: job.kind, label: job.label, status: job.status, detail: job.detail || '' })),
    });
  }
  // DSH reports one usage frame per request: inputTokens counts only the fresh
  // prompt, cacheReadTokens the replayed prefix, and totalTokens the whole
  // request (prompt + reply) — that last one is what occupies the window now.
  accountUsage(usage) {
    const fresh = Number(usage?.inputTokens), output = Number(usage?.outputTokens);
    if (!Number.isFinite(fresh) || !Number.isFinite(output) || fresh < 0 || output < 0) return;
    const cached = Number(usage?.cacheReadTokens) > 0 ? Number(usage.cacheReadTokens) : 0;
    const input = fresh + cached;
    this.usageTotals.input += input; this.usageTotals.output += output; this.usageTotals.cached += cached;
    this.usageTotals.total = this.usageTotals.input + this.usageTotals.output;
    const windowed = Number(usage?.totalTokens);
    this.contextUsed = Number.isFinite(windowed) && windowed > 0 ? windowed : input + output;
    this.emitUsage();
  }
  emitUsage() {
    const totals = this.usageTotals;
    this.emit('usage', {
      at: Date.now(), model: this.currentModel || null,
      total: totals.total > 0 ? { inputTokens: totals.input, outputTokens: totals.output,
        totalTokens: totals.total, cachedInputTokens: totals.cached } : null,
      context: { used: this.contextUsed, window: this.contextWindow },
    });
  }
  // Match a native user/message back to the interjection that typed it, so the
  // record keeps the submission id the Hub's optimistic card was mounted with.
  takePendingSteer(text) {
    if (!Array.isArray(this.pendingSteers) || !this.pendingSteers.length) return null;
    const cutoff = Date.now() - 10 * 60_000;
    this.pendingSteers = this.pendingSteers.filter(entry => entry.at >= cutoff);
    const index = this.pendingSteers.findIndex(entry => entry.text === text);
    return index < 0 ? null : this.pendingSteers.splice(index, 1)[0];
  }
  async send(text, options = {}) {
    await this.start(); text = String(text).replace(/\r\n?/g, '\n');
    if (!options.configurationCommand && !this.routeChecked) {
      this.routeChecked = true;
      const models = this.routeModels();
      if (!models.some(m => m.id === this.currentModel)) {
        try { await this.configure({ model: this.options.model, effort: this.options.effort }); }
        catch (error) { this.routeChecked = false; throw Object.assign(error, { notSent: true }); }
      }
    }
    if (this.closed || this.runtime.connection !== 'connected') throw Object.assign(new Error('DSH CLI 未连接'), { notSent: true });
    if (this.configurePending && !options.configurationCommand) throw Object.assign(new Error('DSH 正在确认模型设置'), { notSent: true });
    if (options.attachments?.length) throw Object.assign(new Error('请在 DSH 终端中添加附件'), { notSent: true });
    const command = text.trimStart().startsWith('/');
    // A pending question owns stdin in the native TUI: pasting a prompt now
    // would be consumed as its answer, so the terminal keeps that decision.
    if (this.runtime.state === 'waiting') throw Object.assign(new Error('DSH 正在等你在后台终端回答提问，回答后可继续发送'), { notSent: true });
    if (this.pending) throw Object.assign(new Error('上一条消息还在等 DSH 确认，请稍候再发'), { notSent: true });
    // The native composer accepts input mid-turn: Enter steers the running turn
    // and the message is delivered at the next step boundary. The native
    // user/message event still proves what the session actually took; it can
    // land long after the keystroke, so a steer is acknowledged at the composer
    // instead of holding a receipt open for it.
    const steer = !command && this.runtime.state === 'running';
    const id = options.clientSubmissionId || randomUUID();
    if (steer) this.pendingSteers.push({ id, text, at: Date.now() });
    let receipt = null;
    if (!command && !steer) receipt = new Promise(resolve => { this.pending = { id, text, resolve,
      timer: setTimeout(() => { if (this.pending?.id === id) this.pending = null;
        resolve({ ok: false, sendStatus: 'stuck', unconfirmed: true }); }, 20000) }; });
    options.beforeStart?.();
    this.output = '';
    await paste.writeBracketedPaste({ writeToSession: (_id, chunk) => this.write(chunk) }, this.options.id, text);
    await paste.waitForPasteSettled({ settleMs: paste.computeSettleMs(text.length),
      echoNeedle: paste.echoNeedle(text), readOutputSince: () => this.output });
    this.write('\r');
    if (command) return { ok: true, sendStatus: 'dispatched', commandOutput: '已送入 DSH CLI，请在终端查看' };
    if (steer) return { ok: true, sendStatus: 'steered', steer: true, acknowledgementSource: 'native-composer',
      threadId: this.threadId, turnId: this.runtime.turnId, clientSubmissionId: id,
      message: '已插话，DSH 会在当前步骤结束后收到' };
    return receipt;
  }
  readTranscript(options = {}) {
    let records = options.turnId ? this.records.filter(r => r.turnId === options.turnId) : this.records;
    if (options.latestTurn) records = records.slice(-1);
    const cards = claudeTranscriptTurns(records).map(card => {
      const record = records.find(r => r.userMessageId === (card.userMessageId || card.id));
      const identity = { providerTurnId: record?.turnId || null, clientSubmissionId: record?.submissionId || null };
      return { ...card, ...identity, ...(record?.steer ? { steer: true } : {}), kind: 'deepseek-acp', source: 'provider-cli',
        ...(card.displayMessages ? { displayMessages: card.displayMessages.map(m => ({ ...m, ...identity })) } : {}) };
    });
    return Number.isFinite(options.limit) ? options.fromTail === false ? cards.slice(0, options.limit) : cards.slice(-options.limit) : cards;
  }
  blocks() { return this.readTranscript().filter(c => c.role === 'assistant').slice(-1).map(c => ({ type: 'text', text: c.text || '' })); }
  finalText() { return this.blocks().map(b => b.text).join('\n'); }
  async readOutcome(turnId) { return this.lastOutcome?.turnId === turnId ? this.lastOutcome : null; }
  async reconcile() { if (this.runtime.connection !== 'connected') throw new Error('请先恢复 DSH CLI'); return this.runtime; }
  // Escape is the native interrupt (verified against the real TUI: the turn
  // aborts in ~0.2s), matching the other PTY agents' stop gesture.
  async interrupt() { if (['running', 'waiting'].includes(this.runtime.state)) this.write('\x1b'); }
  observePreferences(changed) {
    try {
      if (changed && changed !== 'model.json') throw new Error('unchanged');
      const pref = JSON.parse(fs.readFileSync(path.join(this.options.home, '.dsh-tui/model.json'), 'utf8'));
      if (pref.provider === 'bailian-tpp' && pref.model && pref.model !== this.currentModel) {
        this.currentModel = pref.model; this.emit('bound', { threadId: this.threadId, model: pref.model, configOptions: this.configOptions });
      }
    } catch {}
    try {
      if (changed && changed !== 'effort.json') throw new Error('unchanged');
      const pref = JSON.parse(fs.readFileSync(path.join(this.options.home, '.dsh-tui/effort.json'), 'utf8'));
      if (pref.effort && pref.effort !== this.currentEffort) {
        this.currentEffort = pref.effort; this.emit('bound', { threadId: this.threadId, reasoningEffort: pref.effort, configOptions: this.configOptions });
      }
    } catch {}
  }
  async configure({ model, effort } = {}, { timeoutMs = 15000 } = {}) {
    await this.start();
    if (this.configurePending || this.pending || ['running', 'waiting'].includes(this.runtime.state)) throw new Error('请等当前轮结束后再调整模型');
    const models = this.routeModels();
    const target = models.find(m => m.id === (model || this.currentModel || this.options.model));
    if (!target) throw new Error('该模型不在当前消费通道中');
    if (effort !== undefined && !Object.hasOwn(target.reasoningEfforts || {}, effort)) throw new Error('该模型不支持此思考强度');
    this.configurePending = true;
    try {
      for (const [key, value, command] of [['model', model, '/model bailian-tpp/'], ['effort', effort, '/effort ']]) {
        if (value === undefined || value === (key === 'model' ? this.currentModel : this.currentEffort)) continue;
        const file = path.join(this.options.home, '.dsh-tui', key + '.json');
        const revision = fs.existsSync(file) ? fs.statSync(file, { bigint: true }).mtimeNs : null;
        await this.send(command + value, { configurationCommand: true });
        let confirmed = false;
        for (const end = Date.now() + timeoutMs; Date.now() < end && !this.closed;) {
          try { confirmed = fs.statSync(file, { bigint: true }).mtimeNs !== revision && JSON.parse(fs.readFileSync(file, 'utf8'))[key] === value; } catch {}
          if (confirmed) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!confirmed) throw new Error('DSH 未确认设置变更，请查看终端；Hub 未更新该设置');
        this.observePreferences();
      }
      return { modelId: this.currentModel || this.options.model, displayName: this.currentModel || this.options.model,
        effort: this.currentEffort, appliesOn: 'next-turn', confirmationSource: 'native-settings-write' };
    } finally { this.configurePending = false; }
  }
  routeModels() {
    const patch = JSON.parse(fs.readFileSync(this.options.launch.args.at(-1), 'utf8'));
    return patch.find(p => p.id === 'llm-pi-ai').config.providers['bailian-tpp'].models;
  }
  get configOptions() {
    let choices = [];
    try { choices = Object.keys(this.routeModels().find(m => m.id === this.currentModel)?.reasoningEfforts || {}); }
    catch (error) { console.warn('[DSH CLI] model catalog unavailable:', error.message); }
    return choices.length ? [{ id: 'reasoning_effort', category: 'thought_level', type: 'select',
      currentValue: this.currentEffort || '', options: choices.map(value => ({ value, name: value })) }] : [];
  }
  async fork() {
    await this.start();
    if (!this.records.length) throw new Error('请先完成一轮对话，再创建分支');
    const sourceId = this.threadId;
    await this.send('/fork');
    // The native TUI prints this command only after the detached writer has
    // released its reservation and finished its final title write.
    for (const end = Date.now() + 15000; Date.now() < end && !this.closed;) {
      const plain = (this.output || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      const id = plain.match(/(?:Forked \(|已分叉（)([a-f0-9-]{36})(?:\)|）)/)?.[1];
      if (id && id !== sourceId) {
        if (this.threadId !== sourceId) throw new Error('DSH 分支期间前台会话已改变');
        return { home: this.options.home, sessionId: id };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('DSH 尚未确认分支完成，请查看终端');
  }
  dispose() { clearTimeout(this.startTimer); this.tail?.close(); this.prefWatcher?.close(); }
  kill() { if (this.closed) return; this.closed = true; this.fail(new Error('DSH CLI 已关闭')); this.dispose(); this.pty?.kill(); }
}
function readDshCliTranscript(file, options = {}) {
  const view = Object.create(DshCliSession.prototype);
  EventEmitter.call(view);
  Object.assign(view, { options: {}, records: [], runtime: {}, seen: new Set(), contentRevision: 0 });
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'bound') {
      view.threadId = row.sessionId; view.records = []; view.seen = new Set();
      for (const event of row.events || []) view.event(event, true);
    } else if (row.type === 'event' && row.sessionId === view.threadId) view.event(row.event, true);
  }
  return view.readTranscript(options);
}
module.exports = { DshCliSession, readDshCliTranscript };
