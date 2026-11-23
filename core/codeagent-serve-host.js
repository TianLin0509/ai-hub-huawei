'use strict';
// 每个 CodeAgent 账号（配置目录）一个共享 serve（2026-11-22 ACP 试点）。
// 公司真机实测：同一 serve 上多个会话、多个工作目录并发正常；关闭终端不影响会话；杀掉 serve 后新 serve 能读到完整历史。
// 最后一个会话关闭后留一小段时间再关，连续开关会话不用反复等启动；Hub 退出时全部结束。
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const serve = require('./codeagent-serve');

const IDLE_CLOSE_MS = 60_000;
const READY_TIMEOUT_MS = 45_000;

class ServeHost extends EventEmitter {
  constructor({ command, configDir, configDirEnv, cwd, env, spawnImpl, idleCloseMs = IDLE_CLOSE_MS, readyTimeoutMs = READY_TIMEOUT_MS }) {
    super();
    this.setMaxListeners(0);
    Object.assign(this, { command, configDir, configDirEnv, cwd, env, spawnImpl, idleCloseMs, readyTimeoutMs });
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
    const token = crypto.randomBytes(32).toString('hex');
    const cwd = this.cwd || this.configDir;
    fs.mkdirSync(cwd, { recursive: true });
    const spawnServe = this.spawnImpl || serve.spawnServe;
    const proc = spawnServe({ command: this.command, port, token, configDir: this.configDir, cwd,
      env: serve.serveEnv(this.env || process.env, { configDirEnv: this.configDirEnv, configDir: this.configDir }) });
    let exited = false, spawnError = '';
    proc.once('error', error => { exited = true; spawnError = error?.message || String(error); });
    proc.once('exit', () => {
      exited = true;
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
    if (!exited) await serve.killTree(proc.pid);
    throw new Error(spawnError ? `启动 CodeAgent serve 失败：${spawnError}` : 'CodeAgent serve 未能就绪');
  }
  retain() {
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
    if (proc) { await serve.killTree(proc.pid); const owner = await serve.portOwner(port); if (owner) await serve.killTree(owner); }
    return this.ensure();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    hosts.delete(hostKey(this.configDir));
    const proc = this.proc, port = this.port;
    this.proc = null;
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
  return host && !host.stopped && host.running ? host : null;
}
// 所有共享 serve 的进程号：关会话补杀进程树时放进保护名单，同账号其他会话还在用的 serve 绝不误杀。
function livePids() {
  return [...hosts.values()].map(host => Number(host.pid)).filter(pid => pid > 0);
}

function shutdownHosts() {
  const running = [...hosts.values()];
  hosts.clear();
  for (const host of running) host.stopSync();
  return running.length;
}

module.exports = { ServeHost, acquireHost, runningHost, livePids, shutdownHosts, IDLE_CLOSE_MS };
