'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

const WELINK_INTERVAL_MS = 3000;
const WELINK_COOLDOWN_MS = 30000;
const WELINK_RATE_RETRIES = 2;
const WELINK_RATE_LIMITED = 'WELINK_RATE_LIMITED';
const MESSAGE_ROUND_EXPIRED = 'WELINK_MESSAGE_ROUND_EXPIRED';
const PRIORITY = Object.freeze({ phone: 0, user: 1, background: 2 });
const context = new AsyncLocalStorage();
const withWelinkPriority = (priority, run) => context.run({ ...context.getStore(), priority }, run);
const rateLimited = result => String(result?.code) === '429' || result?.code != null && Number(result.code) !== 0
  && /\bstatus\s+429\b/i.test(String(result.stdout || '') + '\n' + String(result.stderr || ''));
const exempt = args => args[0] === '--version' || args.includes('--help') || args[0] === 'auth' && args[1] === 'login';
// Exchange commands have not hit rate limits in the observed account. Bypass
// request spacing for these verified commands, but share cooldown and retries.
const EXCHANGE_COMMANDS = new Set(['mail list', 'mail get', 'mail autodiscover', 'calendar list']);

class WelinkGate {
  constructor({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onMinute = () => {} } = {}) {
    this.now = now; this.sleep = sleep; this.onMinute = onMinute;
    this.queue = []; this.lastStart = -Infinity; this.pausedUntil = 0; this.running = false;
    this.minute = null; this.counts = new Map(); this.timer = null;
  }
  record(args, limited) {
    const minute = Math.floor(this.now() / 60000);
    if (this.minute !== null && this.minute !== minute) this.flush();
    this.minute = minute;
    // Only command names, never flags, parameters or CLI output.
    const command = args.slice(0, 2).filter(x => /^[a-z][a-z-]*$/.test(x)).join(' ');
    const counts = this.counts.get(command) || { requests: 0, rateLimited: 0 };
    if (limited) counts.rateLimited += 1; else counts.requests += 1;
    this.counts.set(command, counts);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, Math.max(1, (minute + 1) * 60000 - this.now()));
      this.timer.unref?.();
    }
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.counts.size) {
      try { this.onMinute({ minute: this.minute, commands: [...this.counts].map(([command, counts]) => ({ command, ...counts })) }); } catch { /* Diagnostics never affect requests. */ }
      this.counts.clear();
    }
    this.minute = null;
  }
  run(args, execute, options = {}) {
    if (exempt(args)) return Promise.resolve().then(execute);
    if (EXCHANGE_COMMANDS.has(args.slice(0, 2).join(' '))) return this.executeJob({ args, execute, options }, false);
    return new Promise((resolve, reject) => {
      const priority = options.priority || context.getStore()?.priority || 'user';
      this.queue.push({ args, execute, options, priority: PRIORITY[priority] ?? PRIORITY.user, resolve, reject });
      void this.drain();
    });
  }
  async wait(deadline = Infinity) {
    const delay = Math.min(Math.max(this.lastStart + WELINK_INTERVAL_MS, this.pausedUntil), deadline) - this.now();
    if (delay > 0) await this.sleep(delay);
  }
  check(job) {
    if (Number.isFinite(job.options.deadline) && this.now() >= job.options.deadline)
      throw Object.assign(new Error('本轮消息取数已到时限，下轮继续'), { code: MESSAGE_ROUND_EXPIRED });
  }
  expireQueued() {
    this.queue = this.queue.filter(job => {
      try { this.check(job); return true; } catch (error) { job.reject(error); return false; }
    });
  }
  async executeJob(job, queued) {
    for (let attempt = 0; attempt <= WELINK_RATE_RETRIES; attempt += 1) {
      while (this.now() < this.pausedUntil) {
        this.check(job);
        const until = Math.min(this.pausedUntil, job.options.deadline ?? Infinity);
        await this.sleep(until - this.now());
      }
      this.check(job);
      await job.options.beforeRun?.();
      if (queued) this.lastStart = this.now();
      this.record(job.args, false);
      const result = await job.execute();
      if (!rateLimited(result)) return result;
      this.record(job.args, true);
      this.pausedUntil = this.now() + WELINK_COOLDOWN_MS;
      if (attempt === WELINK_RATE_RETRIES)
        throw Object.assign(new Error('WeLink 限流，请稍后重试'), { code: WELINK_RATE_LIMITED });
    }
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        this.expireQueued();
        if (!this.queue.length) break;
        await this.wait(Math.min(...this.queue.map(job => job.options.deadline ?? Infinity)));
        this.expireQueued();
        if (!this.queue.length) continue;
        if (this.now() < Math.max(this.lastStart + WELINK_INTERVAL_MS, this.pausedUntil)) continue;
        // Select after waiting so phone/user requests can overtake queued background work.
        this.queue.sort((a, b) => a.priority - b.priority);
        const job = this.queue.shift();
        try {
          job.resolve(await this.executeJob(job, true));
        } catch (error) { job.reject(error); }
      }
    } finally { this.running = false; }
  }
}

let shared;
function sharedWelinkGate(options) { return shared || (shared = new WelinkGate(options)); }
module.exports = { WelinkGate, sharedWelinkGate, withWelinkPriority, WELINK_INTERVAL_MS, WELINK_COOLDOWN_MS, WELINK_RATE_RETRIES, WELINK_RATE_LIMITED, MESSAGE_ROUND_EXPIRED };
