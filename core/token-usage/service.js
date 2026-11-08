'use strict';
// Token 开销账本：每天两个时间点在后台统计一次，也能手动统计。账本存 Hub 数据目录，原始日志被清理后历史数字还在。
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const VERSION = 1;
const FIRST_DAYS = 90;   // 第一次把本机还留着的记录尽量算全
const ROUTINE_DAYS = 4;  // 之后只重算最近几天
const KEEP_DAYS = 400;
const SHOW_DAYS = 92;
const SLOTS = [[12, 30], [23, 30]];
const CHECK_MS = 10 * 60 * 1000;
const START_DELAY_MS = 3 * 60 * 1000;
const DAY_MS = 86400000;

const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayStart = day => new Date(day + 'T00:00:00').getTime();
const dayTotal = rows => (rows || []).reduce((s, r) => s + r[3] + r[4] + r[5] + r[6], 0);
// 日志被清理或压缩后，重算的那天可能变少；取大的，已记下的开销不倒退。
function mergeDays(old, scanned) {
  const days = { ...old };
  for (const [day, rows] of Object.entries(scanned)) if (dayTotal(rows) >= dayTotal(days[day])) days[day] = rows;
  return days;
}
function slotTimes(now, offsets) {
  const out = [];
  for (const offset of offsets) for (const [h, m] of SLOTS) { const d = new Date(now); d.setDate(d.getDate() + offset); d.setHours(h, m, 0, 0); out.push(d.getTime()); }
  return out;
}
const lastSlot = now => Math.max(...slotTimes(now, [-1, 0]).filter(t => t <= now));
const nextSlot = now => Math.min(...slotTimes(now, [0, 1]).filter(t => t > now));

class TokenUsageService {
  constructor({ dataDir, homeDir, codeAgentDir = () => '', publish = () => {}, logger = console, now = () => Date.now(), runScan = null }) {
    Object.assign(this, { dataDir, homeDir, codeAgentDir, publish, logger, now });
    this.file = path.join(dataDir, 'token-usage-ledger.json');
    this.runScan = runScan || (opts => this.runWorker(opts));
    this.ledger = this.load();
    this.running = null; this.stage = ''; this.error = ''; this.timers = []; this.worker = null;
  }
  load() {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (v?.version === VERSION && v.days) return v;
    } catch {}
    return { version: VERSION, days: {}, syncedAt: 0 };
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.ledger));
    fs.renameSync(tmp, this.file);
  }
  start() {
    this.timers.push(setTimeout(() => this.tick(), START_DELAY_MS), setInterval(() => this.tick(), CHECK_MS));
    for (const t of this.timers) t.unref?.();
  }
  dispose() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; void this.worker?.terminate(); }
  tick() { if (this.ledger.syncedAt < lastSlot(this.now())) void this.sync('auto'); }
  state() {
    const cutoff = startOfDay(this.now()) - SHOW_DAYS * DAY_MS;
    const days = Object.fromEntries(Object.entries(this.ledger.days).filter(([d]) => dayStart(d) >= cutoff));
    return { days, syncedAt: this.ledger.syncedAt, trigger: this.ledger.trigger || '', files: this.ledger.files || 0, errors: this.ledger.errors || 0,
      running: !!this.running, stage: this.stage, error: this.error, nextAt: nextSlot(this.now()), now: this.now() };
  }
  runWorker(opts) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: opts });
      this.worker = worker;
      let settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; this.worker = null; fn(v); };
      worker.on('message', m => {
        if (m.stage) { this.stage = m.stage; this.publish(this.state()); }
        else if (m.result) done(resolve, m.result);
        else if (m.error) done(reject, Error(m.error));
      });
      worker.on('error', e => done(reject, e));
      worker.on('exit', () => done(reject, Error('统计线程提前退出')));
    });
  }
  sync(trigger = 'manual') {
    if (this.running) return this.running;
    const first = !this.ledger.syncedAt;
    const sinceMs = startOfDay(this.now()) - ((first ? FIRST_DAYS : ROUTINE_DAYS) - 1) * DAY_MS;
    this.error = ''; this.stage = '准备';
    this.running = this.perform(trigger, sinceMs);
    this.publish(this.state());
    return this.running;
  }
  async perform(trigger, sinceMs) {
    try {
      const r = await this.runScan({ homeDir: this.homeDir, dataDir: this.dataDir, codeAgentDir: this.codeAgentDir(), sinceMs });
      const days = mergeDays(this.ledger.days, r.days);
      const keepFrom = startOfDay(this.now()) - KEEP_DAYS * DAY_MS;
      for (const d of Object.keys(days)) if (dayStart(d) < keepFrom) delete days[d];
      this.ledger = { version: VERSION, days, syncedAt: this.now(), trigger, files: r.files, errors: r.errors };
      this.save();
    } catch (e) {
      this.error = e.message || String(e);
      this.logger.warn('[token-usage] sync failed:', this.error);
    } finally {
      this.running = null; this.stage = '';
      this.publish(this.state());
    }
    return this.state();
  }
}

module.exports = { TokenUsageService, mergeDays, lastSlot, nextSlot };
