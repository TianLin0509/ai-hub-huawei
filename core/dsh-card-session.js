'use strict';
// DSH 卡片试点会话：平时走共享的原生 ACP 进程；点「后台」时先释放写入锁，再由现有 DSH 终端驱动接管同一会话。
// 终端里聊过的内容记在终端驱动的事件日志里，回到卡片时从那份日志读回来，卡片历史不缺轮次。
const fs = require('node:fs');
const { AcpSession } = require('./acp-session');
const { HostedAcpClient } = require('./dsh-card-host');
const { readDshCliTranscript } = require('./dsh-cli-session');
const { dshStopStatus, dshFailureText } = require('./dsh-turn-outcome');

const RECOVER_DELAY_MS = 1200;
const RECOVER_WINDOW_MS = 5 * 60_000;
const RECOVER_MAX = 3;

class DshCardSession extends AcpSession {
  constructor(options) {
    super(options);
    this.host = options.host;
    this.importedCards = [];
    this.failures = [];
    this.options.clientFactory = () => {
      const client = new HostedAcpClient(this.host);
      client.on('disconnect', error => { if (!client.released) setTimeout(() => this.recover(client, error), 0); });
      return client;
    };
  }

  // 写到单步输出上限（max_tokens）算完成；失败时把 DSH 原文换成一行人话（core/dsh-turn-outcome.js）。
  finish(active, status, error, nativeResult) {
    const stop = nativeResult && nativeResult.stopReason;
    if (stop) status = dshStopStatus(stop);
    if (status === 'failed') error = dshFailureText(stop === 'refusal' ? 'refusal' : error);
    else if (status === 'completed') error = null;
    return super.finish(active, status, error, nativeResult);
  }

  loadHistory() {
    super.loadHistory();
    const file = this.options.terminalLog;
    if (!file) return;
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    try { this.importedCards = readDshCliTranscript(file); }
    catch (error) { this.backstage.note(this.label, '终端历史读取失败：' + error.message); return; }
    if (!this.importedCards.length) return;
    // 终端日志开头回放了整段原生会话，这份日志之前的卡片轮次已经包含在里面；只在显示时隐藏，存档不删。
    this.coveredBefore = stat.mtimeMs;
  }

  withVisibleHistory(read) {
    if (!this.coveredBefore) return read();
    const all = this.history;
    this.history = new Map([...all].filter(([, turn]) => turn.status === 'inProgress' || !(Number(turn.hubStartedAt) <= this.coveredBefore)));
    try { return read(); }
    finally { this.history = all; }
  }

  readTranscript(options = {}) {
    const imported = this.importedCards;
    const live = request => this.withVisibleHistory(() => super.readTranscript(request));
    if (!imported.length || options.limit === 0) return live(options);
    if (options.turnId) {
      const hit = imported.filter(card => card.providerTurnId === options.turnId);
      return hit.length ? hit : live(options);
    }
    if (options.latestTurn) {
      const latest = live(options);
      if (latest.length) return latest;
      const last = imported.at(-1)?.providerTurnId;
      return imported.filter(card => card.providerTurnId === last);
    }
    const cards = [...imported, ...live({ ...options, limit: undefined })];
    if (!Number.isFinite(options.limit)) return cards;
    return options.fromTail === false ? cards.slice(0, options.limit) : cards.slice(-options.limit);
  }

  readToolResult(request) {
    try { return super.readToolResult(request); }
    catch (error) {
      for (const card of this.importedCards) {
        const tool = card.toolCalls?.find(item => item.id === request.itemId);
        if (tool) return typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result ?? '', null, 2);
      }
      throw error;
    }
  }

  // 模型跟共享进程走，试点期间不在卡片里切换；思考强度和权限模式走原生配置。
  async configure(request = {}, starting = false) {
    const { model, ...rest } = request;
    if (model && model !== this.options.model) throw new Error('卡片方式暂不支持中途切换模型，请点「后台」在真实终端里切换');
    if (model) this.currentModel = model;
    if (rest.effort || rest.configId) {
      if (rest.effort && !this.configOptions?.some(o => o.category === 'thought_level')) {
        if (!starting) throw new Error('当前模型不支持调整思考强度');
        return { ok: true, modelId: this.currentModel, displayName: this.currentModel, effort: null, appliesOn: 'next-turn' };
      }
      return super.configure(rest, starting);
    }
    if (!this.bootstrapping) this.emit('bound', { threadId: this.threadId, model: this.currentModel, configOptions: this.configOptions });
    return { ok: true, modelId: this.currentModel, displayName: this.currentModel, effort: this.currentEffort || null, appliesOn: 'next-turn' };
  }

  async fork() { throw new Error('卡片方式暂不支持分支，请先点「后台」切到真实终端再创建分支'); }

  async reconnect() {
    await this.client?.release?.();
    return super.reconnect();
  }

  async recover(client, error) {
    if (this.closed || this.killing || this.client !== client || this.recovering || this.fellBack) return;
    this.recovering = true;
    const fallBack = reason => {
      if (this.fellBack) return;
      this.fellBack = true;
      this.emit('card-fallback', { reason });
    };
    const now = Date.now();
    this.failures = [...this.failures.filter(at => now - at < RECOVER_WINDOW_MS), now];
    if (this.failures.length > RECOVER_MAX) {
      this.recovering = false;
      fallBack(error.message);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, RECOVER_DELAY_MS));
    if (this.closed || this.killing || this.client !== client) { this.recovering = false; return; }
    try {
      const interrupted = [...this.history.values()].filter(turn => turn.status === 'inProgress');
      for (const turn of interrupted) {
        this.history.set(turn.id, { ...turn, status: 'interrupted', hubCompletedAt: Date.now(), error: 'DSH 进程中断，这一轮没有跑完' });
      }
      const submission = this.runtime.submission;
      if (submission?.status === 'unknown') this.runtime = { ...this.runtime, submission: { ...submission, status: 'reviewed' } };
      this.active = null;
      await this.reconnect();
      this.emit('action-error', interrupted.length
        ? 'DSH 进程刚才中断，已自动恢复。上一轮没有跑完，没有自动重发，请看结果后决定是否再发一次。'
        : 'DSH 进程刚才中断，已自动恢复，上下文完整。');
    } catch (recoverError) {
      if (!this.closed && this.runtime.connection !== 'connected') fallBack(recoverError.message);
    } finally { this.recovering = false; }
  }

  // 先把写入锁放开再报告退出，紧接着启动的真实终端才不会被拒绝。
  kill() {
    if (this.closed || this.killing) return;
    this.killing = true;
    const finish = () => {
      try { super.kill(); }
      finally { this.host.release(); }
    };
    const release = this.client?.release?.();
    if (!release) { finish(); return; }
    Promise.resolve(release).catch(() => {}).finally(finish);
  }
}

module.exports = { DshCardSession };
