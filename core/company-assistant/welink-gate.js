'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { AUTH_FAILURE } = require('./welink');

const WELINK_INTERVAL_MS = 3000;
const WELINK_COOLDOWN_MS = 30000;
const WELINK_RATE_RETRIES = 2;
const WELINK_RATE_LIMITED = 'WELINK_RATE_LIMITED';
const MESSAGE_ROUND_EXPIRED = 'WELINK_MESSAGE_ROUND_EXPIRED';
const PRIORITY = Object.freeze({ phone: 0, user: 1, background: 2 });
const context = new AsyncLocalStorage();
const withWelinkPriority = (priority, run) => context.run({ ...context.getStore(), priority }, run);
const withWelinkCaller = (caller, run) => context.run({ ...context.getStore(), caller }, run);
function rateLimited(result) {
  if ([result?.code, result?.status, result?.statusCode].some(code => String(code) === '429')) return true;
  const business = value => value && typeof value === 'object' && ([value.code, value.resultCode, value.status, value.statusCode, value.error_code, value.error?.code, value.error?.error_code].some(code => String(code) === '429') || business(value.error));
  if (business(result)) return true;
  for (const line of String(result?.stdout || '').split(/\r?\n/)) { try { if (business(JSON.parse(line))) return true; } catch {} }
  try { if (business(JSON.parse(String(result?.stdout || '')))) return true; } catch {}
  return result?.code != null && Number(result.code) !== 0 && /\b(?:status|HTTP(?:\/\d(?:\.\d)?)?)\s*[:=]?\s+429\b/i.test(String(result.stdout || '') + '\n' + String(result.stderr || ''));
}
const exempt = args => args[0] === '--version' || args.includes('--help') || args[0] === 'auth' && args[1] === 'login';
// Exchange commands have not hit rate limits in the observed account. Bypass
// request spacing for these verified commands, but share cooldown and retries.
const EXCHANGE_COMMANDS = new Set(['mail list', 'mail get', 'mail autodiscover', 'calendar list']);

class WelinkGate {
  constructor({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onMinute = () => {}, blackboard = null } = {}) {
    this.now = now; this.sleep = sleep; this.onMinute = onMinute;
    this.blackboard = blackboard;
    this.queue = []; this.lastStart = -Infinity; this.pausedUntil = 0; this.localPausedUntil = 0; this.running = false;
    this.minute = null; this.counts = new Map(); this.timer = null;
  }
  syncPausedUntil(shared) {
    if (this.now() >= this.localPausedUntil) this.localPausedUntil = 0;
    const sharedUntil = shared?.cooldown?.until || 0;
    this.pausedUntil = Math.max(this.localPausedUntil, sharedUntil);
    return this.pausedUntil;
  }
  clearLocalCooldown() { this.pausedUntil = 0; this.localPausedUntil = 0; }
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
    const caller = options.caller || context.getStore()?.caller || (options.priority === 'phone' || context.getStore()?.priority === 'phone' ? 'phone' : 'assistant');
    if (exempt(args) || EXCHANGE_COMMANDS.has(args.slice(0, 2).join(' '))) return this.executeJob({ args, execute, options, caller }, false);
    return new Promise((resolve, reject) => {
      const priority = options.priority || context.getStore()?.priority || 'user';
      this.queue.push({ args, execute, options, caller, priority: PRIORITY[priority] ?? PRIORITY.user, resolve, reject });
      void this.drain();
    });
  }
  async wait(deadline = Infinity) {
    if (this.blackboard) this.syncPausedUntil(this.blackboard.read());
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
    const bypassCooldown = exempt(job.args);
    for (let attempt = 0; attempt <= WELINK_RATE_RETRIES; attempt += 1) {
      const shared = this.blackboard?.read();
      if (shared) this.syncPausedUntil(shared);
      while (!bypassCooldown && this.now() < this.pausedUntil) {
        this.check(job);
        const until = Math.min(this.pausedUntil, job.options.deadline ?? Infinity);
        await this.sleep(this.blackboard ? Math.min(1000, until - this.now()) : until - this.now());
        if (this.blackboard) this.syncPausedUntil(this.blackboard.read());
      }
      this.check(job);
      if (queued) this.lastStart = this.now();
      this.record(job.args, false);
      const execute = async () => {
        // Recheck after acquiring the shared lease: another process may have
        // hit 429 while this job was waiting for its command to finish.
        const state = this.blackboard?.read();
        if (!bypassCooldown && state?.cooldown.until > this.now() || state?.authBusy) return { deferred: true, until: Math.max(bypassCooldown ? 0 : state.cooldown.until, state.authBusy ? this.now() + 75 : 0) };
        this.check(job);
        if (job.options.signal?.aborted) throw Object.assign(new Error('操作已取消'), { code: 'ABORT_ERR' });
        await job.options.beforeRun?.();
        this.check(job);
        if (job.options.authAutomatic && state?.auth.state === 'signed_out') throw Object.assign(new Error('已退出 WeLink 登录，请手动登录后继续'), { code: 'WELINK_SIGNED_OUT' });
        const conservativeRead = state?.policy.groupReadMode === 'conservative_30s' && job.args[0] === 'im' && job.args[1] === 'query-history-message' && job.args.includes('--group-id');
        const readAfter = conservativeRead && state.lastGroupReadAt ? state.lastGroupReadAt + state.policy.conservativeIntervalSec * 1000 : 0;
        if (readAfter > this.now()) return { deferred: true, until: readAfter };
        if (conservativeRead) this.blackboard?.update(s => { s.lastGroupReadAt = this.now(); });
        const started = this.now(), auth = job.args[0] === 'auth' && ['login', 'logout'].includes(job.args[1]);
        const skipStats = job.args[0] === '--version' || job.args.includes('--help');
        if (auth) this.blackboard?.setAuthBusy(job.caller, job.args);
        try {
          const result = await job.execute();
          const status = rateLimited(result) ? 'rate_limited' : AUTH_FAILURE.test(String(result?.stdout || '') + '\n' + String(result?.stderr || '')) ? 'auth_error' : Number(result?.code || 0) ? 'error' : 'ok';
          if (!skipStats) this.blackboard?.record({ caller: job.caller, args: job.args, durationMs: this.now() - started, status });
          if (auth && job.args[1] === 'logout' && status === 'ok') this.blackboard?.setAuth({ state: 'signed_out' });
          return { result };
        } catch (error) {
          if (!skipStats) this.blackboard?.record({ caller: job.caller, args: job.args, durationMs: this.now() - started, status: rateLimited(error) ? 'rate_limited' : 'error' });
          throw error;
        } finally { if (auth) this.blackboard?.clearAuthBusy(); }
      };
      let outcome;
      do {
        this.check(job);
        try { outcome = this.blackboard ? await this.blackboard.withLock(job.caller, job.args, execute, { deadline: job.options.deadline, signal: job.options.signal }) : await execute(); }
        catch (error) { this.check(job); throw error; }
        if (outcome.deferred) { this.check(job); await this.sleep(Math.max(1, Math.min(1000, Math.min(outcome.until, job.options.deadline ?? Infinity) - this.now()))); }
      } while (outcome.deferred);
      const result = outcome.result;
      if (bypassCooldown) return result;
      if (!rateLimited(result)) return result;
      this.record(job.args, true);
      const nextUntil = this.now() + WELINK_COOLDOWN_MS;
      this.localPausedUntil = Math.max(this.localPausedUntil, nextUntil);
      this.pausedUntil = Math.max(this.pausedUntil, nextUntil);
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
function sharedWelinkGate(options) { return shared || (shared = new WelinkGate({ blackboard: require('./welink-blackboard').sharedBlackboard(), ...options })); }
module.exports = { WelinkGate, sharedWelinkGate, withWelinkPriority, withWelinkCaller, rateLimited, WELINK_INTERVAL_MS, WELINK_COOLDOWN_MS, WELINK_RATE_RETRIES, WELINK_RATE_LIMITED, MESSAGE_ROUND_EXPIRED };
