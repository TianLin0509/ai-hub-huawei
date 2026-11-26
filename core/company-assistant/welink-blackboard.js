'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const LEASE_MS = 45000, HOUR_MS = 3600000, MIN_VERSION = '1.0.20';
const CALLERS = Object.freeze({ assistant: ['公司助理', 'builtin'], avatar: ['数字分身', 'builtin'], phone: ['手机对话', 'builtin'], feedback: ['一键反馈', 'builtin'], join: ['一键入群', 'builtin'], 'welink-ro': ['会话只读工具', 'external'], external: ['其他外部组件', 'external'] });
const STATES = new Set(['online', 'needs_scan', 'desktop_unavailable', 'account_mismatch', 'cli_missing', 'cli_outdated', 'rate_limited', 'network_error', 'signed_out', 'unknown']);
const REASONS = { online: '', needs_scan: '登录已失效，请重新扫码', desktop_unavailable: '请打开并登录本机 WeLink 桌面端', account_mismatch: '桌面端与命令行账号不一致，请重新登录', cli_missing: '未找到 WeLink 命令行工具', cli_outdated: '命令行版本低于推荐版本，请升级', rate_limited: '服务端限流，稍后再试', network_error: '暂时无法连接 WeLink，请检查公司网络', signed_out: '已退出登录，自动续期已停止', unknown: '尚未确认登录状态' };
const statusSummary = { ok: '正常完成', rate_limited: '服务端限流，已共享冷却', auth_error: '需要检查登录状态', error: '调用未完成' };
const normalizeCaller = caller => Object.hasOwn(CALLERS, caller) ? caller : 'external';
function commandName(args) {
  const [group, sub = ''] = Array.isArray(args) ? args : String(args || '').split(/\s+/);
  if (['--version', 'version', 'state', 'settings'].includes(group)) return group;
  const commands = require('./welink');
  const allowed = [...(commands.READ_ONLY[group] || []), ...(commands.SETUP[group] || []), ...(group === 'im' ? ['send-to-group', 'send-to-user', 'add-group-member', 'recall-message'] : [])];
  return allowed.includes(sub) ? [group, sub].join(' ') : 'unknown';
}
function compareVersions(a, b = MIN_VERSION) {
  const parse = v => /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(String(v || '').trim());
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +x[i] > +y[i] ? 1 : -1;
  return x[4] === y[4] ? 0 : !x[4] ? 1 : !y[4] ? -1 : x[4].localeCompare(y[4], undefined, { numeric: true });
}
function proxyHint(error) {
  const text = typeof error === 'string' ? error : [error?.message, error?.stderr, error?.stdout, error?.code, error?.cause?.message].join(' ');
  if (/\b407\b|Proxy Authentication Required/i.test(text)) return '公司代理要求认证（407）。请完成公司代理认证后重试安装。';
  if (/\b504\b|Gateway Timeout/i.test(text)) return '公司代理或软件源响应超时（504）。请检查公司网络后重试。';
  if (/ECONNREFUSED|could not connect to proxy|failed to connect to proxy|proxy.*(?:failed|refused|unreachable)/i.test(text)) return '无法连接公司代理。请检查代理地址与公司网络后重试。';
  return '';
}
function fresh() {
  return { schemaVersion: 1, updatedAt: 0, cli: { path: '', source: 'missing', version: '', minRecommendedVersion: MIN_VERSION, outdated: false, checkedAt: 0 },
    auth: { state: 'unknown', accountLabel: '', desktopOnline: false, desktopMismatch: false, reason: REASONS.unknown, updatedAt: 0 }, authBusy: null,
    cooldown: { until: 0, reason: '', caller: '', consecutive: 0 }, policy: { groupReadMode: 'hotspot_first', conservativeIntervalSec: 30, hotspotIntervalSec: 10 }, callers: {}, events: [], samples: [] };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

class WelinkBlackboard {
  constructor({ dataDir, env = process.env, fsModule = fs, now = Date.now, isAlive = alive, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), retrySleepSync = sleepSync } = {}) {
    this.env = env; this.fs = fsModule; this.now = now; this.isAlive = isAlive; this.sleep = sleep; this.retrySleepSync = retrySleepSync;
    this.dir = path.join(dataDir || env.CLAUDE_HUB_DATA_DIR || env.HUB_DATA_DIR || require('../data-dir').getHubDataDir(), 'company-assistant');
    this.file = path.join(this.dir, 'welink-blackboard.json'); this.lockFile = path.join(this.dir, 'welink-blackboard.lock');
    this.context = new AsyncLocalStorage(); this.listeners = new Set();
  }
  readJson(file) { try { return JSON.parse(this.fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
  liveLease(lease) { return lease && lease.expiresAt > this.now() && Number.isInteger(lease.pid) && this.isAlive(lease.pid); }
  read() {
    const base = fresh(), raw = this.readJson(this.file) || {};
    const state = { ...base, ...raw, cli: { ...base.cli, ...raw.cli }, auth: { ...base.auth, ...raw.auth }, cooldown: { ...base.cooldown, ...raw.cooldown }, policy: { ...base.policy, ...raw.policy } };
    if (!this.liveLease(state.authBusy)) state.authBusy = null;
    state.samples = (Array.isArray(raw.samples) ? raw.samples : []).filter(s => Array.isArray(s) && s[0] > this.now() - HOUR_MS && s[0] <= this.now());
    state.events = (Array.isArray(raw.events) ? raw.events : []).slice(0, 30);
    state.callers = {};
    for (const [caller, [label, kind]] of Object.entries(CALLERS)) {
      const samples = state.samples.filter(s => s[1] === caller), last = samples.at(-1);
      state.callers[caller] = { label, kind, calls1h: samples.length, ok1h: samples.filter(s => s[2] === 'ok').length, rateLimited1h: samples.filter(s => s[2] === 'rate_limited').length,
        errors1h: samples.filter(s => s[2] === 'error' || s[2] === 'auth_error').length, lastAt: last?.[0] || Number(raw.callers?.[caller]?.lastAt) || 0,
        lastStatus: last?.[2] || (Object.hasOwn(statusSummary, raw.callers?.[caller]?.lastStatus) ? raw.callers[caller].lastStatus : 'idle') };
    }
    return state;
  }
  atomicWrite(state) {
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      this.fs.mkdirSync(this.dir, { recursive: true }); this.fs.writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      for (let retry = 0; ; retry++) {
        try { this.fs.renameSync(temp, this.file); return true; }
        catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code) || retry >= 3) { this.lastIoFailure = { operation: 'rename', code: error.code }; return false; } this.retrySleepSync(10 * (retry + 1)); }
      }
    } catch (error) { this.lastIoFailure = { operation: 'write', code: error.code }; return false; }
    finally { try { this.fs.unlinkSync(temp); } catch { /* Already renamed or inaccessible. */ } }
  }
  acquireGuard() {
    // Publish a populated directory atomically. A unique marker lets exactly
    // one survivor remove a dead reclaimer, without deleting a newer owner.
    const guard = this.lockFile + '.reclaim', id = randomUUID();
    const temp = guard + '-' + id, marker = process.pid + '-' + id + '.json';
    let held = false;
    try {
      this.fs.mkdirSync(temp); this.fs.writeFileSync(path.join(temp, marker), JSON.stringify({ pid: process.pid }));
      for (let retry = 0; ; retry++) {
        try { this.fs.renameSync(temp, guard); held = true; break; }
        catch (error) {
          if (!this.fs.existsSync(guard)) {
            if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code) && retry < 3) { this.retrySleepSync(10 * (retry + 1)); continue; }
            this.lastIoFailure = { operation: 'guard-rename', code: error.code };
            return ['EEXIST', 'ENOTEMPTY'].includes(error.code) ? null : { unavailable: true };
          }
          try {
            const files = this.fs.readdirSync(guard);
            if (files.length === 1) {
              const oldMarker = path.join(guard, files[0]), old = this.readJson(oldMarker);
              if (old && !this.isAlive(old.pid)) { this.fs.unlinkSync(oldMarker); this.fs.rmdirSync(guard); }
            } else if (!files.length) this.fs.rmdirSync(guard);
          } catch { /* A contender or the live owner made progress. */ }
          return null;
        }
      }
      return { dir: guard, marker };
    } catch { return { unavailable: true }; }
    finally {
      if (!held) { try { this.fs.unlinkSync(path.join(temp, marker)); } catch {} try { this.fs.rmdirSync(temp); } catch {} }
    }
  }
  releaseGuard(guard) {
    if (!guard || guard.unavailable) return;
    try { this.fs.unlinkSync(path.join(guard.dir, guard.marker)); } catch {}
    try { this.fs.rmdirSync(guard.dir); } catch {}
  }
  // Called only while holding the same guard used by creation and release.
  reclaim(expected) {
    const current = this.readJson(this.lockFile);
    if (expected ? current?.id !== expected.id || this.liveLease(current) : current || this.now() - this.fs.statSync(this.lockFile).mtimeMs < LEASE_MS) return false;
    this.fs.unlinkSync(this.lockFile); return true;
  }
  tryAcquire(owner = 'external', op = '') {
    let guard;
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      guard = this.acquireGuard();
      if (!guard) return null;
      if (guard.unavailable) return { unavailable: true };
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = { pid: process.pid, owner: normalizeCaller(owner), op: commandName(op), acquiredAt: this.now(), expiresAt: this.now() + LEASE_MS, id: randomUUID() };
        let fd;
        try { fd = this.fs.openSync(this.lockFile, 'wx', 0o600); this.fs.writeFileSync(fd, JSON.stringify(token)); return { token, fd }; }
        catch (error) {
          if (fd !== undefined) { try { this.fs.closeSync(fd); this.fs.unlinkSync(this.lockFile); } catch {} return { unavailable: true }; }
          if (error.code !== 'EEXIST') return { unavailable: true };
          const old = this.readJson(this.lockFile);
          // Another process may still be writing the newly created lock.
          if (!old) {
            try { if (this.now() - this.fs.statSync(this.lockFile).mtimeMs < LEASE_MS) return null; }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          }
          else if (this.liveLease(old)) return null;
          if (!this.reclaim(old)) return null;
        }
      }
    } catch { return { unavailable: true }; }
    finally { this.releaseGuard(guard); }
    return null;
  }
  release(handle) {
    if (!handle || handle.unavailable) return;
    const guard = this.acquireGuard();
    try {
      if (guard && !guard.unavailable) { if (this.readJson(this.lockFile)?.id === handle.token.id) this.fs.unlinkSync(this.lockFile); }
      else {
        // This descriptor refers to our own inode even if a newer lease has
        // replaced its path. Expire it without a racy path-based deletion.
        handle.token.expiresAt = 0; const data = Buffer.from(JSON.stringify(handle.token));
        this.fs.writeSync(handle.fd, data, 0, data.length, 0); this.fs.ftruncateSync(handle.fd, data.length);
      }
    } catch {}
    finally { try { this.fs.closeSync(handle.fd); } catch {} this.releaseGuard(guard); }
  }
  renew(handle) {
    const guard = this.acquireGuard();
    if (!guard || guard.unavailable) return;
    try {
      if (this.readJson(this.lockFile)?.id !== handle.token.id) return;
      handle.token.expiresAt = this.now() + LEASE_MS;
      const data = Buffer.from(JSON.stringify(handle.token)); this.fs.writeSync(handle.fd, data, 0, data.length, 0); this.fs.ftruncateSync(handle.fd, data.length);
    } catch { /* Expiry recovers abandoned leases. */ }
    finally { this.releaseGuard(guard); }
  }
  async withLock(owner, op, fn, { deadline = this.now() + 360000, signal } = {}) {
    const owned = this.context.getStore();
    if (owned && this.readJson(this.lockFile)?.id === owned.token.id) return fn(owned);
    let handle;
    while (!(handle = this.tryAcquire(owner, op))) {
      if (signal?.aborted) throw Object.assign(new Error('操作已取消'), { code: 'ABORT_ERR' });
      if (this.now() >= deadline) throw Object.assign(new Error('WeLink 正在处理其他请求，请稍后重试'), { code: 'WELINK_BUSY' });
      await this.sleep(Math.max(1, Math.min(75, deadline - this.now())));
    }
    if (handle.unavailable) return fn(null);
    const timer = setInterval(() => this.renew(handle), LEASE_MS / 3); timer.unref?.();
    try { return await this.context.run(handle, () => fn(handle)); }
    finally { clearInterval(timer); this.release(handle); }
  }
  withLockSync(owner, op, fn) {
    const handle = this.tryAcquire(owner, op);
    if (!handle) throw Object.assign(new Error('WeLink 正在处理其他请求，请稍后重试'), { code: 'WELINK_BUSY' });
    try { return this.context.run(handle.unavailable ? null : handle, fn); } finally { this.release(handle); }
  }
  update(change) {
    const inherited = this.context.getStore(), owned = inherited && this.readJson(this.lockFile)?.id === inherited.token.id ? inherited : null;
    const handle = owned || this.tryAcquire('external', 'state');
    if (!handle || handle.unavailable) { this.lastIoFailure = { operation: 'update-lock', code: handle ? 'unavailable' : 'busy', inherited: !!inherited }; return false; }
    try {
      const state = this.read(); if (change(state) === false) return false; state.updatedAt = this.now();
      if (!this.atomicWrite(state)) return false;
      this.notify(); return true;
    } catch { return false; }
    finally { if (!owned) this.release(handle); }
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { for (const listener of this.listeners) { try { listener(); } catch {} } }
  announceCli({ path: cliPath = '', source = 'path', version } = {}) {
    return this.update(s => {
      const normalized = cliPath ? (['managed', 'npm', 'manual'].includes(source) ? source : 'path') : 'missing';
      const keep = cliPath && normalized === 'path' && s.cli.path === cliPath && ['managed', 'npm'].includes(s.cli.source) ? s.cli.source : normalized;
      s.cli = { ...s.cli, path: String(cliPath), source: keep,
        version: version === undefined && s.cli.path === cliPath ? s.cli.version : String(version || ''), minRecommendedVersion: MIN_VERSION, checkedAt: this.now() };
      s.cli.outdated = compareVersions(s.cli.version) < 0;
    });
  }
  setAuth(auth = {}, { manual = false } = {}) {
    return this.update(s => {
      let state = String(auth.state || 'unknown').replace(/-/g, '_');
      if (auth.renewCause?.id === 'account-mismatch') state = 'account_mismatch';
      else if (['pc', 'pc-busy', 'pc-version', 'other-device'].includes(auth.renewCause?.id)) state = 'desktop_unavailable';
      if (!STATES.has(state)) state = 'unknown';
      // A late automatic probe must never undo an explicit global logout.
      if (s.auth.state === 'signed_out' && state !== 'signed_out' && !manual) return false;
      // No raw diagnostics or account identifiers cross into this public board.
      const desktopOnline = typeof auth.desktopOnline === 'boolean' ? auth.desktopOnline
        : state === 'desktop_unavailable' ? false
        : state === 'account_mismatch' ? true : null;
      s.auth = { state, accountLabel: '', desktopOnline, desktopMismatch: state === 'account_mismatch', reason: REASONS[state], updatedAt: this.now() };
    });
  }
  setAuthBusy(owner, op) { return this.update(s => { s.authBusy = { pid: process.pid, owner: normalizeCaller(owner), op: commandName(op), acquiredAt: this.now(), expiresAt: this.now() + 360000 }; }); }
  clearAuthBusy() { return this.update(s => { if (s.authBusy?.pid === process.pid) s.authBusy = null; }); }
  record({ caller, args, durationMs, status = 'ok', cooldownMs = 30000 }) {
    caller = normalizeCaller(caller); if (!Object.hasOwn(statusSummary, status)) status = 'error';
    return this.update(s => {
      s.samples.push([this.now(), caller, status]);
      const row = s.callers[caller]; row.calls1h++; row.lastAt = this.now(); row.lastStatus = status;
      if (status === 'ok') row.ok1h++; else if (status === 'rate_limited') row.rateLimited1h++; else row.errors1h++;
      s.events.unshift({ id: 'ev-' + randomUUID(), at: this.now(), caller, callerLabel: CALLERS[caller][0], command: commandName(args), durationMs: Math.max(0, Math.round(durationMs || 0)), status, summary: statusSummary[status] });
      s.events = s.events.slice(0, 30);
      if (status === 'ok') s.lastSuccessAt = this.now();
      if (status === 'rate_limited') s.cooldown = { until: this.now() + cooldownMs, reason: REASONS.rate_limited, caller, consecutive: s.cooldown.consecutive + 1 };
    });
  }
  clearCooldown() { return this.update(s => { s.cooldown = fresh().cooldown; }); }
  clearEvents() { return this.update(s => { s.events = []; }); }
  updatePolicy(request = {}) {
    if (request.groupReadMode !== undefined && !['hotspot_first', 'conservative_30s'].includes(request.groupReadMode)) throw new Error('请选择热点优先或保守 30 秒策略');
    return this.update(s => { if (request.groupReadMode) s.policy.groupReadMode = request.groupReadMode; });
  }
  stub() { const file = this.env.WELINK_BLACKBOARD_STUB_FILE; return file ? this.readJson(file) : null; }
  buildSnapshot({ loginFlow = null, installFlow = null } = {}) {
    const s = this.read(), stub = this.stub();
    if (stub) Object.assign(s, stub.snapshot || stub);
    s.cooldownRemainingSec = Math.max(0, Math.ceil(((s.cooldown?.until || 0) - this.now()) / 1000));
    const issues = [];
    if (!s.cli.path) issues.push(['cli_missing', '安装 WeLink 命令行工具', 'install-cli', 'find-cli']);
    else if (s.cli.outdated) issues.push(['cli_outdated', '升级 WeLink 命令行工具', 'upgrade-cli', 'find-cli']);
    if (s.cooldownRemainingSec) issues.push(['rate_limited', '正在等待 WeLink 限流冷却', 'refresh', 'clear-cooldown']);
    if (s.auth.state !== 'online' && !issues.some(i => i[0] === 'cli_missing')) issues.push([s.auth.state, REASONS[s.auth.state] || REASONS.unknown, ['needs_scan', 'signed_out'].includes(s.auth.state) ? 'start-login' : 'refresh', s.auth.state === 'account_mismatch' ? 'start-login' : 'refresh']);
    s.health = issues.length ? issues.some(i => ['cli_missing', 'account_mismatch'].includes(i[0])) ? 'error' : 'warning' : 'healthy';
    s.badgeCount = issues.length; s.headline = issues[0]?.[1] || 'WeLink 运行正常';
    s.advice = issues.length ? { kind: issues[0][0], title: issues[0][1], detail: REASONS[issues[0][0]] || REASONS.unknown, primaryAction: issues[0][2], secondaryAction: issues[0][3] || 'refresh', redZoneNote: ['needs_scan', 'signed_out', 'account_mismatch'].includes(issues[0][0]) ? '红区无摄像头暂不支持扫码，请先在蓝区电脑完成登录或联系团队了解免扫码进展' : '' } : null;
    const lock = this.readJson(this.lockFile);
    s.lockHolder = this.liveLease(lock) ? { owner: lock.owner, op: lock.op, ageSec: Math.max(0, Math.floor((this.now() - lock.acquiredAt) / 1000)) } : null;
    s.paths = { blackboardFile: this.file, lockFile: this.lockFile }; s.lastSuccessAt = s.lastSuccessAt || 0;
    s.loginFlow = loginFlow; s.installFlow = installFlow; delete s.samples;
    return stub ? { ...s, ...(stub.snapshot || stub) } : s;
  }
}
let shared;
function sharedBlackboard(options) { return shared || (shared = new WelinkBlackboard(options)); }
module.exports = { WelinkBlackboard, sharedBlackboard, compareVersions, proxyHint, commandName, normalizeCaller, LEASE_MS, MIN_VERSION };
