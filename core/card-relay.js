'use strict';
// 两边读写同一份原生会话记录，同一时刻只有一个写入者；正在回答时绝不切换，等这一轮结束。
const KEEP_TERMINAL_MS = 3 * 60_000;
const POLL_MS = 1500;
const IDLE_STATES = new Set(['idle', 'completed', 'interrupted', 'failed']);

function sessionBusy(session) {
  if (!session) return false;
  const info = session.info || session;
  if (session.agentTurnActive) return true;
  for (const runtime of [info.nativeRuntime, info.cliRuntime]) {
    if (!runtime) continue;
    if (runtime.connection && runtime.connection !== 'connected') return true;
    if (runtime.state && !IDLE_STATES.has(runtime.state)) return true;
    if (runtime.backgroundTasks?.length || runtime.backgroundActivities?.length) return true;
  }
  return false;
}

class CardRelay {
  constructor({ sessions, restart, notify = () => {}, onSwitch = () => {}, keepMs = KEEP_TERMINAL_MS, pollMs = POLL_MS }) {
    Object.assign(this, { sessions, restart, notify, onSwitch, keepMs, pollMs });
    this.states = new Map();
  }
  state(id) {
    let value = this.states.get(id);
    if (!value) { value = { wantTerminal: false, timer: null, poll: null, switching: null }; this.states.set(id, value); }
    return value;
  }
  clearTimers(value) {
    clearTimeout(value.timer); clearTimeout(value.poll);
    value.timer = null; value.poll = null;
  }
  async attach(id) {
    const session = this.sessions.getRaw(id);
    const info = session?.info;
    // 切换途中会话短暂不在列表里：记下意图，切完按最新意图继续。
    const switching = this.states.get(id);
    if (!session && switching?.switching) {
      switching.wantTerminal = true;
      this.clearTimers(switching);
      return { ok: true, pending: true, message: '正在切换，完成后自动接上真实终端。' };
    }
    if (info?.cardRunMode !== 'card') return { ok: false, message: '这个会话不是卡片试点会话' };
    const value = this.state(id);
    value.wantTerminal = true;
    this.clearTimers(value);
    if (info.cardTerminal === true && !value.switching) return { ok: true, reused: true };
    if (sessionBusy(session)) {
      this.waitIdle(id);
      return { ok: true, pending: true, message: '这一轮回答结束后自动接上真实终端，现在先显示实时输出。' };
    }
    return this.switchTo(id, true);
  }
  detach(id) {
    const session = this.sessions.getRaw(id);
    const switching = this.states.get(id);
    if (!session && switching?.switching) {
      switching.wantTerminal = false;
      this.clearTimers(switching);
      return { ok: true };
    }
    if (session?.info?.cardRunMode !== 'card') return { ok: false };
    const value = this.state(id);
    value.wantTerminal = false;
    this.clearTimers(value);
    if (session.info.cardTerminal !== true) return { ok: true };
    value.timer = setTimeout(() => this.returnToCard(id), this.keepMs);
    value.timer.unref?.();
    return { ok: true, keepMs: this.keepMs };
  }
  waitIdle(id) {
    const value = this.state(id);
    clearTimeout(value.poll);
    value.poll = setTimeout(() => {
      value.poll = null;
      const session = this.sessions.getRaw(id);
      if (!session || session.info?.cardRunMode !== 'card') { this.forget(id); return; }
      const want = value.wantTerminal;
      if (want === (session.info.cardTerminal === true)) return;
      if (sessionBusy(session)) { this.waitIdle(id); return; }
      this.switchTo(id, want).catch(() => {});
    }, this.pollMs);
    value.poll.unref?.();
  }
  returnToCard(id) {
    const value = this.state(id);
    value.timer = null;
    if (value.wantTerminal) return;
    const session = this.sessions.getRaw(id);
    if (!session || session.info?.cardTerminal !== true) return;
    if (sessionBusy(session)) { this.waitIdle(id); return; }
    this.switchTo(id, false).catch(() => {});
  }
  async switchTo(id, terminal) {
    const value = this.state(id);
    if (value.switching) return value.switching;
    value.switching = (async () => {
      const session = this.sessions.getRaw(id);
      if (!session) return { ok: false, message: '会话不存在或已经休眠' };
      const previous = session.info.cardTerminal === true;
      this.sessions.updateMeta(id, { cardTerminal: terminal });
      this.onSwitch(id, 'start', terminal);
      let result;
      try { result = await this.restart(id); }
      catch (error) { result = { ok: false, message: error.message }; }
      finally { this.onSwitch(id, 'end', terminal); }
      if (!result || result.ok === false) {
        // 没换成功：旧驱动如果还在，标记改回去；已经退出的会话由休眠恢复入口接手。
        if (this.sessions.getRaw(id)) this.sessions.updateMeta(id, { cardTerminal: previous });
        // 打开终端失败不自动重试，用户再点一次「后台」才重新尝试；切回卡片失败按保温周期再试。
        if (terminal) value.wantTerminal = previous;
        this.notify(id, 'error', terminal ? `打开真实终端失败：${result?.message || '未知错误'}` : `切回卡片失败：${result?.message || '未知错误'}，会话继续留在终端。`);
        return { ok: false, notified: true, message: result?.message || '切换失败' };
      }
      return { ok: true, switched: true };
    })().finally(() => {
      value.switching = null;
      // 切换途中用户改了主意：切完再按最新意图处理。
      const session = this.sessions.getRaw(id);
      if (session && value.wantTerminal !== (session.info.cardTerminal === true) && !value.timer) {
        if (value.wantTerminal) this.waitIdle(id);
        else { value.timer = setTimeout(() => this.returnToCard(id), this.keepMs); value.timer.unref?.(); }
      }
    });
    return value.switching;
  }
  forget(id) {
    const value = this.states.get(id);
    if (value) this.clearTimers(value);
    this.states.delete(id);
  }
  shutdown() {
    for (const value of this.states.values()) this.clearTimers(value);
    this.states.clear();
  }
}

module.exports = { CardRelay, sessionBusy, KEEP_TERMINAL_MS };
