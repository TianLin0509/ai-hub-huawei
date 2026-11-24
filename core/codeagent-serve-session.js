'use strict';
// CodeAgent ACP 试点会话（2026-11-22）：卡片走共享 serve，点「后台」才把真实终端接到同一会话。
// 卡片、历史、权限、提问沿用 AcpSession；这里只多三件事：管理按需终端、serve 故障自动恢复、连续失败时请 Hub 改回 PTY。
const { AcpSession } = require('./acp-session');
const { CodeAgentServeClient, canonicalDir } = require('./codeagent-serve-client');
const serveFallback = require('./codeagent-serve-fallback');

const TERMINAL_KEEP_MS = 3 * 60_000;
const SERVE_HANDOVER = 'SERVE_FALLBACK_HANDOVER';
function serveHandoverError(reason, cause) {
  return Object.assign(new Error('CodeAgent 轻享服务暂不可用，正在改用终端方式，本条消息未发送' + (reason ? `（${reason}）` : '')),
    { code: SERVE_HANDOVER, notSent: true, ...(cause ? { cause } : {}) });
} // 回到卡片后终端再留 3 分钟，来回看不用反复等连接。
const RECOVER_DELAY_MS = 1200;
const RECOVER_WINDOW_MS = 5 * 60_000;
const RECOVER_MAX = 3;

class CodeAgentServeSession extends AcpSession {
  constructor(options) {
    super(options);
    this.host = options.host;
    this.terminal = null;
    this.terminalStarting = null;
    this.terminalTimer = null;
    this.cols = 120;
    this.rows = 30;
    this.failures = [];
    this.options.clientFactory = () => {
      const client = new CodeAgentServeClient({ host: this.host, cwd: options.cwd, model: options.model || '', provider: options.provider || '',
        permissionMode: options.permissionMode, title: options.title, systemPrompt: options.systemPrompt || '' });
      client.on('external-prompt', text => {
        this._send(text, {}).catch(error => {
          client.cancelAdopt(text);
          this.emit('action-error', '终端里发的消息未同步到卡片：' + error.message);
        });
      });
      client.on('request-resolved', requestId => this.resolveElsewhere(requestId));
      client.on('turn-unknown', message => {
        if (this.client !== client || !this.active || this.closed) return;
        try {
          clearTimeout(this.active.timer);
          this.apply({ type: 'submission', submission: { ...this.runtime.submission, status: 'unknown', error: message } });
          this.active.reject(new Error(message));
          this.promptQueue.hold(message);
          this.persist();
        } catch (error) { client.fail(error); this.emit('action-error', error.message); }
        this.emit('action-error', message);
      });
      client.on('disconnect', error => setTimeout(() => this.recover(client, error), 0));
      client.on('transport-disconnect', error => setTimeout(() => this.recover(client, error), 0));
      return client;
    };
  }
  print() { /* 后台显示的是真实终端，结构化输出只进卡片 */ }

  // 首次连接（或重连）失败：记进账号冷却账本，请 Hub 无感改回终端方式；错误照原样抛给直接调用方。
  async _start() {
    try {
      const result = await super._start();
      this.everConnected = true;
      serveFallback.clearCooldown(this.host?.configDir);
      return result;
    } catch (error) {
      if (!this.closed && !this.fellBack) {
        const reason = error?.message || String(error);
        serveFallback.recordFailure(this.host?.configDir, reason);
        this.fellBack = true;
        this.fallbackReason = reason;
        this.emit('serve-fallback', { reason, phase: this.everConnected ? 'runtime' : 'startup', hasThread: !!(this.threadId || this.options.resumeId),
          pendingPrompts: this._snapshotPendingPrompts() });
      }
      throw error;
    }
  }
  // 还没送进 serve、留在待发队列里的用户消息（回执里如实报数）。已提交、结果不明的轮次不在这里，绝不重发。
  _snapshotPendingPrompts() {
    const out = [];
    for (const record of this.promptQueue?.records || []) {
      if (this.promptQueue.launching === record) continue;
      if (typeof record.text === 'string' && record.text.trim()) out.push({ id: record.id, text: record.text });
    }
    return out;
  }
  // 已经请 Hub 改回终端时，这条消息肯定没送进 serve：报「改道中、未发送」（notSent），
  async send(text, options = {}) {
    // 改道时旧对象会被关掉（closed），所以这里只看 fellBack。
    if (this.fellBack) throw serveHandoverError(this.fallbackReason);
    try { return await super.send(text, options); }
    catch (error) {
      if (this.fellBack && error?.notSent === true) throw serveHandoverError(this.fallbackReason, error);
      throw error;
    }
  }
  acknowledge() {
    const unknown = this.runtime.submission?.status === 'unknown' ? this.runtime.submission : null;
    super.acknowledge();
    // 迟到正文只证明已经执行，不能解除缺少终态的 unknown。
    if (unknown) this.apply({ type: 'submission', submission: unknown });
  }
  finish(active, status, error, nativeResult) {
    // 只有收到服务端终态才解除 unknown；本地等待超时不会走到这里。
    if (this.runtime.submission?.status === 'unknown') {
      this.apply({ type: 'submission', submission: { ...this.runtime.submission, status: 'accepted' } });
    }
    return super.finish(active, status, error, nativeResult);
  }

  // serve 的模型跟着每条消息走，不需要 ACP 配置项；思考强度第一期不开放，明确报错，不假装切换成功。
  async configure({ model, effort, provider = '' } = {}, starting = false) {
    if (!starting) await this.start();
    if (this.active) throw new Error('请等待当前轮次结束后修改模型');
    if (effort && !starting) throw new Error('CodeAgent-Lite 暂不支持切换思考强度，请用 PTY 方式');
    let resolved = null;
    if (model) {
      // 中途换只拦空值、控制字符和超长：显示名可能带括号或线路前缀，交给 switchModel 按清单认，解析出的 id 在那里再校验。
      if (typeof model !== 'string' || !model.trim() || model.length > 164 || /[\x00-\x1f\x7f]/.test(model)) throw new Error('模型名称无效');
      if (starting) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) throw new Error('模型名称无效');
        if (this.client.model !== model) { this.client.model = model; this.client.provider = ''; await this.client._resolveProvider(); }
      } else {
        // 会话中途换：以 serve 的模型清单为准，认不出就报错、保留原模型（core/codeagent-serve-client.js switchModel）。
        resolved = await this.client.switchModel(model, provider);
      }
      this.currentModel = this.client.model;
      this.options.model = this.client.model;
      this.options.provider = this.client.provider;
    }
    if (!this.bootstrapping) this.emit('bound', { threadId: this.threadId, model: this.currentModel, configOptions: [] });
    this.persist();
    return { ok: true, modelId: this.currentModel, displayName: resolved?.label || this.currentModel, effort: null, appliesOn: 'next-turn',
      ...(resolved ? { provider: resolved.provider, providerLabel: resolved.providerLabel, matchKind: resolved.kind } : {}) };
  }

  // 在真实终端里已经答过的权限或提问，卡片上的按钮要同步收起。
  resolveElsewhere(requestId) {
    const request = this.runtime.requests?.find(r => String(r.id).endsWith(':' + requestId));
    if (!request) return;
    this.client?.incoming.delete(request.id);
    this.apply({ type: 'resolved', threadId: this.threadId, requestId: request.id });
  }

  async recover(client, error) {
    if (this.closed || this.client !== client || this.fellBack) return;
    // 正在重订时再断线也必须记下，不能让 recovering 守卫吞掉。
    if (this.recovering) { this.recoveryAgain = true; return; }
    this.recovering = true;
    const fallBack = reason => {
      if (this.fellBack) return;
      this.fellBack = true;
      serveFallback.recordFailure(this.host?.configDir, reason);
      this.emit('serve-fallback', { reason, phase: 'runtime', hasThread: !!this.threadId, pendingPrompts: this._snapshotPendingPrompts() });
    };
    try {
      do {
        this.recoveryAgain = false;
        const now = Date.now();
        this.failures = [...this.failures.filter(at => now - at < RECOVER_WINDOW_MS), now];
        if (this.failures.length > RECOVER_MAX) {
          if (this.active) client.markUnknown();
          else fallBack(error.message);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, this.options.recoverDelayMs ?? RECOVER_DELAY_MS));
        if (this.closed || this.client !== client) return;
        if (client.closed) {
          this.closeTerminal();
          if (this.active) {
            this.emit('action-error', 'CodeAgent 连接已断开，当前轮次结果不明，请核对原生会话。');
          } else {
            try { await this.reconnect(); }
            catch (recoverError) { fallBack(recoverError.message); }
          }
          return;
        }
        try {
          await client._subscribe();
          // 给 close/error 回调机会，检查仍是同一条存活订阅。
          await new Promise(resolve => setImmediate(resolve));
          if (this.closed || this.client !== client) return;
          if (!client.sse || this.recoveryAgain) { this.recoveryAgain = true; continue; }
          this.emit('action-error', '已重新订阅事件流，等待服务端终态确认。');
        } catch (recoverError) { error = recoverError; this.recoveryAgain = true; }
      } while (this.recoveryAgain);
    } finally { this.recovering = false; }
  }

  terminalArgs() {
    const { host, options } = this;
    return ['--disable-update', '--skip-safe-check',
      ...(options.model ? ['--model', options.model] : []), ...(options.provider ? ['--provider', options.provider] : []),
      ...(options.permissionMode ? ['--permission-mode', options.permissionMode] : []),
      '--server-url', host.url, '--server-token', host.token, '--server-dir', canonicalDir(options.cwd), '--resume', this.threadId];
  }
  async attachTerminal({ cols, rows } = {}) {
    if (cols) this.cols = cols;
    if (rows) this.rows = rows;
    clearTimeout(this.terminalTimer);
    this.terminalTimer = null;
    this.detachAfterOpen = null;
    if (this.terminal) {
      if (!this.stopBypassWatch) this.watchTerminal(this.terminal);
      try { this.terminal.resize(this.cols, this.rows); } catch { /* 正在退出 */ }
      return { ok: true, reused: true };
    }
    this.terminalStarting ||= this._openTerminal().finally(() => { this.terminalStarting = null; });
    return this.terminalStarting;
  }
  async _openTerminal() {
    await this.start();
    if (!this.threadId || this.runtime.connection !== 'connected') throw new Error('CodeAgent 尚未连接');
    const startedAt = Date.now();
    // 终端的工作目录也要用真实长路径，否则 CodeAgent 会认为会话属于别的目录并弹确认。
    const term = this.options.spawnTerminal({ args: this.terminalArgs(), cols: this.cols, rows: this.rows, cwd: canonicalDir(this.options.cwd) });
    this.terminal = term;
    this.watchTerminal(term);
    this.emit('data', '\x1bc');
    term.onData(data => { if (this.terminal === term) this.emit('data', data); });
    term.onExit(() => {
      if (this.terminal !== term) return;
      this.stopTerminalWatch();
      this.terminal = null;
      this.emit('terminal-closed');
    });
    // 终端还在连接时用户已经切回卡片：开好后照常进入保温倒计时，不留常驻进程。
    if (this.detachAfterOpen) { const delayMs = this.detachAfterOpen.delayMs; this.detachAfterOpen = null; this.detachTerminal({ delayMs }); }
    return { ok: true, reused: false, ms: Date.now() - startedAt };
  }
  detachTerminal({ delayMs = TERMINAL_KEEP_MS } = {}) {
    this.stopTerminalWatch();
    if (!this.terminal) { if (this.terminalStarting) this.detachAfterOpen = { delayMs }; return; }
    clearTimeout(this.terminalTimer);
    this.terminalTimer = setTimeout(() => this.closeTerminal(), delayMs);
    this.terminalTimer.unref?.();
  }
  closeTerminal() {
    this.stopTerminalWatch();
    clearTimeout(this.terminalTimer);
    this.terminalTimer = null;
    const term = this.terminal;
    this.terminal = null;
    if (!term) return;
    try { term.kill(); } catch { /* 已退出 */ }
    this.emit('terminal-closed');
  }
  watchTerminal(term) {
    this.stopTerminalWatch();
    if (this.options.permissionMode !== 'bypassPermissions') return;
    const watch = this.options.watchBypassWarning || require('./claude-trust-dialog').watchBypassWarning;
    let attached = true;
    const stop = watch({ onData: fn => term.onData(fn), write: data => {
      if (attached && this.terminal === term) term.write(data);
    } });
    this.stopBypassWatch = () => { attached = false; stop(); };
  }
  stopTerminalWatch() {
    this.stopBypassWatch?.();
    this.stopBypassWatch = null;
  }
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.terminal) this.terminal.resize(cols, rows);
  }
  write(data) {
    if (this.terminal) { this.terminal.write(data); return; }
    if (data === '\x03') this.interrupt().catch(error => this.emit('action-error', error.message));
  }
  kill() {
    if (this.closed) return;
    this.closeTerminal();
    try { super.kill(); }
    finally { this.host.release(); }
  }
}

module.exports = { CodeAgentServeSession, TERMINAL_KEEP_MS, SERVE_HANDOVER };
