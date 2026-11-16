'use strict';
// Hub owns recovery state, never rewrites the signed helper's booking history.
const { createHash } = require('node:crypto');
const S = require('./room-schedule');
const WINDOW_MS = 15 * 60000, PROBE_MS = 10000, MAX_ATTEMPTS = 3;
const idOf = r => createHash('sha256').update(JSON.stringify(r)).digest('hex');
const networkError = r => r?.状态 === '错误' && /net::ERR_[A-Z_]+/i.test(String(r.备注 || '')) && !/登录失效|登录过期/.test(String(r.备注 || ''));
const success = r => /成功|已预订|已预定|抢到/.test(String(r?.状态 || ''));
const stamp = at => {
  const d = new Date(at), pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const recordAt = r => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r?.时间戳 || '') ? new Date(r.时间戳.replace(' ', 'T')).getTime() : NaN;

class RoomOfflineRetry {
  constructor(rooms) { this.rooms = rooms; this.timer = null; this.closed = false; this.epoch = 0; }
  tasks() { return this.rooms.a.state().roomOfflineRetries || []; }
  save(tasks) { this.rooms.a.saveState({ roomOfflineRetries: tasks.slice(-14) }); }
  active() { return this.tasks().some(t => t.phase !== 'done' || t.resume); }
  close() { this.closed = true; clearTimeout(this.timer); this.timer = null; }
  start() { this.closed = false; }
  cancel() {
    this.epoch++;
    this.save(this.tasks().map(t => ({ ...t, phase: 'done', resume: false, result: t.result || '已停止自动补抢' })));
  }
  decorate(record) {
    const t = this.tasks().find(t => t.firstId === idOf(record));
    if (!t) return record;
    const text = t.attempts ? `开抢时电脑没联网，已在网络恢复后自动重试（${t.attempts}/${MAX_ATTEMPTS} 次）`
      : '开抢时电脑没联网，正在等待网络恢复后自动重试';
    return { ...record, 备注: `${text}${t.result ? '；' + t.result : ''}` };
  }
  history(records) {
    const out = records.map(r => this.decorate(r));
    for (const t of this.tasks().filter(t => t.expired)) {
      const next = out.findIndex(r => recordAt(r) > t.deadline);
      out.splice(next < 0 ? out.length : next, 0, { ...t.record, 状态: '提示', 时间戳: stamp(t.deadline), 备注: '开抢时没联网，今天没抢到；明天照常' });
    }
    return out.slice(-50);
  }
  schedule() {
    if (this.closed || this.rooms.deps.noTimer || this.timer || !this.active()) return;
    const now = this.rooms.a.now(), waiting = this.tasks().filter(t => t.phase === 'waiting' && t.lastProbe);
    const delay = Math.min(PROBE_MS, ...waiting.map(t => Math.max(1000, PROBE_MS - (now - t.lastProbe))));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.rooms.tick().catch(e => { this.rooms.error = e.message; this.rooms.a.changed(); }).finally(() => this.schedule());
    }, delay);
    this.timer.unref?.();
  }
  async probe() {
    if (this.rooms.deps.roomNetworkProbe) return this.rooms.deps.roomNetworkProbe();
    try {
      const response = await fetch('https://inner.welink.huawei.com/meetingroom/#/', { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      // An authentication redirect still proves the internal site is reachable.
      await response.body?.cancel();
      return response.status < 500;
    } catch { return false; }
  }
  async tick(history, live, now) {
    const epoch = this.epoch;
    let tasks = this.tasks().map(t => ({ ...t }));
    const s = live.schedule, d = new Date(now), [h, m, sec] = s.openTime.split(':').map(Number);
    const open = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, sec).getTime();
    const target = S.targetDateFor(open, s.advanceDays), key = stamp(open).slice(0, 10) + ':' + target;
    // Include a prepare-stage disconnect just before opening, but never old/missing timestamps.
    const candidates = history.filter(r => r.日期 === target && recordAt(r) >= open - 30 * 60000 && recordAt(r) <= now);
    const last = candidates.at(-1);
    if (now >= open && networkError(last) && !tasks.some(t => t.key === key) && !history.some(r => r.日期 === target && success(r))) {
      tasks.push({ key, target, open, deadline: open + WINDOW_MS, record: last, firstId: idOf(last), lastId: idOf(last), attempts: 0, phase: 'waiting', resume: false, lastProbe: 0 });
    }
    this.save(tasks);
    try {
      for (const t of tasks) {
        if (epoch !== this.epoch || this.closed) return;
        if (t.phase !== 'done') {
          const latest = history.filter(r => r.日期 === t.target && recordAt(r) >= t.open - 30 * 60000).at(-1);
          if (history.some(r => r.日期 === t.target && success(r))) {
            t.phase = 'done'; t.result = '重试结果：成功';
          } else if (latest && idOf(latest) !== t.lastId) {
            t.lastId = idOf(latest);
            if (!networkError(latest)) { t.phase = 'done'; t.result = `重试结果：${latest.状态}${latest.备注 ? '（' + latest.备注 + '）' : ''}`; }
            else { t.phase = 'waiting'; t.result = '重试结果：仍未联网'; }
          }
          if ((now >= t.deadline || t.target !== target) && !(t.phase === 'booking' && live.running)) {
            t.expired = t.phase !== 'done'; t.phase = 'done';
            if (t.result === '补抢进行中') { t.expired = false; t.result = '补抢结果尚未确认，请查看历史；明天照常'; }
            if (t.expired) t.result = '开抢时没联网，今天没抢到；明天照常';
          } else if (t.attempts >= MAX_ATTEMPTS && t.phase === 'waiting') {
            t.phase = 'done'; t.result = '重试结果：已补抢 3 次，仍未成功；明天照常';
          }
          if (live.loginNeeded) { t.phase = 'done'; t.result = '需要重新登录，已停止补抢'; }
          if (live.loginBusy || live.controlBusy) continue;
        }
        // The once command only acknowledges job launch. Wait for its actual history result.
        if (t.phase === 'booking' || (live.running && live.mode !== 'daemon')) continue;
        if (t.phase === 'done') {
          if (t.resume && live.connected && !live.running && this.rooms.settings().enabled) {
            t.resume = false; this.save(tasks);
            await this.rooms.command('start', {}, { internal: true });
          } else if (!this.rooms.settings().enabled || live.running) t.resume = false;
          continue;
        }
        if (t.phase === 'waiting') {
          if (!live.connected || now - t.lastProbe < PROBE_MS) continue;
          t.lastProbe = now; this.save(tasks);
          if (!await this.probe()) continue;
          // Reachability may consume the last seconds of the recovery window.
          if (epoch !== this.epoch) return;
          if (this.rooms.a.now() >= t.deadline || this.closed) continue;
          if (live.running) {
            t.resume = !!this.rooms.settings().enabled; t.phase = 'stopping'; this.save(tasks);
            await this.rooms.command('pause', {}, { internal: true });
            continue;
          }
          t.phase = 'stopping';
        }
        if (t.phase === 'stopping' && !live.running) {
          // Re-read before dispatch: a booking can finish while the network probe was pending.
          const current = this.rooms.helper();
          if (current?.running || current?.loginNeeded || current?.loginBusy || current?.controlBusy) continue;
          const fresh = this.rooms.readHistory();
          if (fresh.some(r => r.日期 === t.target && success(r))) { t.phase = 'done'; t.result = '重试结果：成功'; continue; }
          this.rooms.checkSchedule('once');
          t.attempts++; t.phase = 'booking'; t.result = '补抢进行中'; this.save(tasks);
          // Persist before dispatch; a lost command receipt must never cause a duplicate booking.
          await this.rooms.command('once', {}, { user: true, internal: true });
        }
      }
    } finally { if (epoch === this.epoch) this.save(tasks); this.schedule(); }
  }
}
module.exports = { RoomOfflineRetry, networkError, WINDOW_MS, PROBE_MS, MAX_ATTEMPTS };
