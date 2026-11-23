'use strict';
// 每个 CodeAgent 账号（配置目录）一个共享 serve（2026-11-22 ACP 试点）。
// 公司真机实测：同一 serve 上多个会话、多个工作目录并发正常；关闭终端不影响会话；杀掉 serve 后新 serve 能读到完整历史。
// 最后一个会话关闭后留一小段时间再关，连续开关会话不用反复等启动；Hub 退出时全部结束。
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const serve = require('./codeagent-serve');
// Windows 分层 Job Object 第 2 层（2026-11-23 P2）：每个账号的共享 serve 一个盒子（serve:<账号目录>:<代>），
// 和 PTY 会话（第 1 层）完全分开：关闭、休眠任何终端会话都不会碰到它；只在它自己退出、重启、停止时结束。
const defaultJobQos = () => require('./win32-job-qos').getWin32JobQos();

const IDLE_CLOSE_MS = 60_000;
const READY_TIMEOUT_MS = 45_000;
const JOB_END_WAIT_MS = 3000;

class ServeHost extends EventEmitter {
  constructor({ command, configDir, configDirEnv, cwd, env, spawnImpl, idleCloseMs = IDLE_CLOSE_MS, readyTimeoutMs = READY_TIMEOUT_MS, jobQos = defaultJobQos }) {
    super();
    this.setMaxListeners(0);
    Object.assign(this, { command, configDir, configDirEnv, cwd, env, spawnImpl, idleCloseMs, readyTimeoutMs, jobQos });
    this.jobKey = '';
    this.lastActivityAt = Date.now();
    this.refs = 0;
    this.proc = null;
    this.port = 0;
    this.token = '';
    this.starting = null;
    this.idleTimer = null;
    this.stopped = false;
  }
  get pid() { return this.proc?.pid || null; }
  get url() { return `http://127.0.0.1:${this.port}`; }
  get running() { return !!this.proc && !this.starting; }

  ensure() {
    if (this.running) return Promise.resolve(this);
    this.starting ||= this._start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async _start() {
    const port = await serve.freePort();
    if (this.stopped) return this; // 等端口期间被停掉：不再起进程
    const token = crypto.randomBytes(32).toString('hex');
    const cwd = this.cwd || this.configDir;
    fs.mkdirSync(cwd, { recursive: true });
    const spawnServe = this.spawnImpl || serve.spawnServe;
    const spawnedFrom = Date.now();
    const proc = spawnServe({ command: this.command, port, token, configDir: this.configDir, cwd,
      env: serve.serveEnv(this.env || process.env, { configDirEnv: this.configDirEnv, configDir: this.configDir }) });
    let exited = false, spawnError = '';
    proc.once('error', error => { exited = true; spawnError = error?.message || String(error); });
    // 出生时间窗：spawn 前 1 秒到 spawn 返回后 2 秒，号码被复用的别的进程不会被认成它。
    const jobKey = proc.pid ? (this._qos()?.assign(`serve:${hostKey(this.configDir)}`, proc.pid,
      { minStartMs: spawnedFrom - 1000, maxStartMs: Date.now() + 2000, layer: 'serve' }) || '') : '';
    if (jobKey) this.jobKey = jobKey;
    proc.once('exit', () => {
      exited = true;
      // 根进程退出：结束这一代的盒子，收掉脱离父进程的 bun / MCP 子进程。
      if (jobKey) this._endJob(jobKey);
      if (this.proc !== proc) return;
      this.proc = null;
      if (!this.stopped) this.emit('exit', new Error('CodeAgent serve 已退出'));
    });
    this.proc = proc; this.port = port; this.token = token;
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline && !exited) {
      const res = await serve.request(port, token, serve.HEALTH_PATH, { timeoutMs: 2000 });
      if (res.status && res.status < 500) return this;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (this.proc === proc) this.proc = null;
    await this._endJob(jobKey, JOB_END_WAIT_MS);
    if (!exited) await serve.killTree(proc.pid);
    throw new Error(spawnError ? `启动 CodeAgent serve 失败：${spawnError}` : 'CodeAgent serve 未能就绪');
  }
  _qos() { try { return (typeof this.jobQos === 'function' ? this.jobQos() : this.jobQos) || null; } catch { return null; } }
  // timeoutMs：关闭路径最多等这么久，超时照常走原来的进程树 + 端口结束兜底（盒子在后台继续收）。
  _endJob(key = this.jobKey, timeoutMs = 0) {
    if (!key) return Promise.resolve(null);
    if (this.jobKey === key) this.jobKey = '';
    const qos = this._qos();
    return qos ? Promise.resolve(qos.terminate(key, { timeoutMs })).catch(() => null) : Promise.resolve(null);
  }
  // 只记活动时间、不唤醒（刚答完一轮：2 分钟空闲从这时算起）。
  touchActivity() { this.lastActivityAt = Date.now(); }
  // 有新请求、读额度、有会话接入：记活动时间；低开销模式下正在节能调度的话立刻恢复全速（同步抬优先级）。
  noteActivity() {
    this.lastActivityAt = Date.now();
    if (this.jobKey) { try { this._qos()?.wake(this.jobKey); } catch { /* 唤醒失败不影响请求 */ } }
  }
  retain() {
    this.noteActivity();
    this.refs += 1;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
  release() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs || this.stopped) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.refs) this.stop().catch(() => {}); }, this.idleCloseMs);
    this.idleTimer.unref?.();
  }
  // 故障恢复时用：只结束自己这个进程树，按记录的 pid 和端口找，不按命令行匹配。
  async restart() {
    const proc = this.proc, port = this.port;
    this.proc = null;
    await this._endJob(this.jobKey, JOB_END_WAIT_MS);
    if (proc) { await serve.killTree(proc.pid); const owner = await serve.portOwner(port); if (owner) await serve.killTree(owner); }
    return this.ensure();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    hosts.delete(hostKey(this.configDir));
    const proc = this.proc, port = this.port;
    this.proc = null;
    await this._endJob(this.jobKey, JOB_END_WAIT_MS);
    if (!proc) return;
    await serve.killTree(proc.pid);
    const owner = await serve.portOwner(port);
    if (owner) await serve.killTree(owner);
  }
  stopSync() {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    const proc = this.proc, port = this.port;
    this.proc = null;
    // 盒子尽力结束（异步，Hub 退出时内核关句柄同样会结束），同步结束照旧兜底。
    void this._endJob();
    if (proc) serve.killServeSync(proc.pid, port);
  }
}

const hosts = new Map();
const hostKey = configDir => path.resolve(String(configDir || '')).toLowerCase();

function acquireHost(options) {
  const key = hostKey(options.configDir);
  let host = hosts.get(key);
  if (!host || host.stopped) { host = new ServeHost(options); hosts.set(key, host); }
  host.retain();
  return host;
}

// 这个账号此刻已经在跑、可直接借用的共享 serve（读额度用）；没有或还在启动返回 null。
function runningHost(configDir) {
  const host = hosts.get(hostKey(configDir));
  if (!(host && !host.stopped && host.running)) return null;
  host.noteActivity();
  return host;
}
// 所有共享 serve 的进程号：关会话补杀进程树时放进保护名单，同账号其他会话还在用的 serve 绝不误杀。
function livePids() {
  return [...hosts.values()].map(host => Number(host.pid)).filter(pid => pid > 0);
}

// 低开销模式 EcoQoS 判断用的只读元数据。
function listHosts() {
  return [...hosts.values()].map(host => ({ key: hostKey(host.configDir), configDir: host.configDir, pid: host.pid, jobKey: host.jobKey,
    refs: host.refs, running: host.running, stopped: host.stopped, lastActivityAt: host.lastActivityAt, host }));
}

function shutdownHosts() {
  const running = [...hosts.values()];
  hosts.clear();
  for (const host of running) host.stopSync();
  return running.length;
}

module.exports = { ServeHost, acquireHost, runningHost, livePids, listHosts, hostKey, shutdownHosts, IDLE_CLOSE_MS };
