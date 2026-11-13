'use strict';

// 公司模型反代的起停（随 Hub 起停）：独立的 ELECTRON_RUN_AS_NODE 子进程、隐藏窗口、只听 127.0.0.1。
// - 「自有 API」里任一工具选了「公司模型」才启动；Hub 退出时先请它自己停，再兜底结束进程。
// - 进程意外退出自动拉起一次；再退出就停下，在界面上用人话说明原因，日志在 diagnostics/company-model-proxy.log。
// - 每 5 秒读一次状态：号被限流时同步到账号页的「避让」。
// - 换号、退回个人号的提示是要手动关掉的常驻提示条（2.6 秒的轻提示来不及看），同一类原因本次 Hub 运行只弹第一次，
//   之后的换号照常记在日志和账号页，不再打扰。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const POLL_MS = 5_000;
const READY_TIMEOUT_MS = 15_000;
const READY_WAIT_MS = 90_000; // 新建会话时最多等上游准备 90 秒（首次签名初始化实测约 11 秒）
const DRAIN_POLL_MS = 2_000;
const DRAIN_MAX_MS = 10 * 60_000;

function serverScript() {
  const file = path.join(__dirname, '..', 'core', 'company-proxy', 'server.mjs');
  // 打包后 ESM 模块放在 app.asar.unpacked（package.json asarUnpack），子进程直接从磁盘加载。
  return file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

// 公司内网的 HTTPS 证书由公司根证书签发，只在 Windows 系统证书库里，Node 自带的证书表没有。
// 反代进程（Electron 内置 Node，ELECTRON_RUN_AS_NODE）用 --use-system-ca 读系统证书库（Electron 41 / Node 24 已实测支持）；
// 运行时不认这个参数时不加，由 server.mjs 启动时把系统根证书并进默认证书表兜底。
function systemCaArgs(flags = process.allowedNodeEnvironmentFlags) {
  try { return flags && flags.has('--use-system-ca') ? ['--use-system-ca'] : []; } catch { return []; }
}

const NOTICE = {
  fallback_personal: e => e.reason === 'model'
    ? `公司模型：号池里没有对 ${e.model || '这个模型'} 有权限的号（各号能用的模型见「账号」页），这个会话已改用你的个人 CodeAgent 账号。`
    : '公司模型：号池里的号暂时都用不了，这个会话已改用你的个人 CodeAgent 账号。',
  credential_failed: e => e.account === 'personal' ? '公司模型：你自己的 CodeAgent 登录读不出来（可能已过期），请打开 CodeAgent 命令行登录一下，登录后自动恢复。'
    : `公司模型：号池账号 ${e.account} 的登录信息读不出来（可能已过期），已换号；请到「账号」页重新登录这个号。`,
  rate_limited: e => `公司模型：${e.account === 'personal' ? '个人账号' : '号池账号 ' + e.account}${e.model ? ' 的 ' + e.model : ''} 被限流，冷却后再用${e.model ? '（这个号的其他模型照常可用）' : ''}，会话已自动换号。`,
};

// 「同一类」：限流换号一类；退回个人号按原因分（缺模型权限再按模型分）；登录读不出按号分。
function noticeKey(event) {
  if (event.type === 'fallback_personal') return `fallback:${event.reason === 'model' ? 'model:' + String(event.model || '').toLowerCase() : 'pool'}`;
  if (event.type === 'credential_failed') return `credential:${event.account || ''}`;
  return event.type;
}

class CompanyProxyService {
  constructor({ dataDir, isEnabled, onNotice = () => {}, onStatus = () => {}, logger = console, mock = process.env.AI_HUB_COMPANY_PROXY_MOCK === '1' } = {}) {
    this.dataDir = dataDir;
    this.isEnabled = isEnabled;
    this.onNotice = onNotice;
    this.onStatus = onStatus;
    this.logger = logger;
    this.mock = mock;
    this.okCounts = new Map(); // account id -> 反代里成功请求数，涨了就标记这个号的额度读数待刷新
    this.child = null;
    this.endpoint = null;
    this.state = 'stopped';
    this.message = '';
    this.restarts = 0;
    this.stopping = false;
    this.starting = null;
    this.timer = null;
    this.seenEvents = new Set();
    this.noticeKeys = new Set();
    this.lastStatus = null;
    this.draining = null;
    this.drainCancelled = false;
    this.polling = null;
  }

  proxy() { return require('../core/company-model-proxy'); }
  logPath() { return path.join(this.dataDir, 'diagnostics', 'company-model-proxy.log'); }

  status() {
    const s = this.lastStatus;
    return { state: this.state, message: this.message, pid: this.child?.pid || null, port: this.endpoint?.port || null,
      mock: this.mock, restarts: this.restarts, accounts: s?.router?.accounts || [], events: (s?.router?.events || []).slice(-10),
      stats: s?.stats || null, log: this.logPath(), code: s?.code || null,
      zone: s?.zone || null, chosenZone: this.proxy().chosenZone(this.dataDir), firstInit: s?.firstInit || null,
      sessionAccounts: this.sessionAccounts(s?.router?.assignments),
      // 会话 → 号 id：侧栏额度按反代会话实际用的号显示（renderer/company-route-view.js quotaTarget），不显示在界面文字里。
      sessionAccountIds: s?.router?.assignments && typeof s.router.assignments === 'object' ? { ...s.router.assignments } : {} };
  }

  // session tag -> account alias（个人 / 号 N，same numbering as the account page; never the account id）.
  sessionAccounts(assignments) {
    if (!assignments || typeof assignments !== 'object') return {};
    let aliases = new Map();
    try { aliases = require('../core/codeagent-quota').aliasMap(this.dataDir); } catch { aliases = new Map(); }
    const out = {};
    for (const [tag, id] of Object.entries(assignments)) out[tag] = aliases.get(id) || (id === 'personal' ? '个人' : '号池账号');
    return out;
  }

  // 设置里选区域（'' = 自动识别）：写进 upstream.json，再重启反代让它按新区域拼上游地址。
  async setZone(zone) {
    this.proxy().setUpstreamZone(this.dataDir, zone);
    let enabled = false;
    try { enabled = !!this.isEnabled(); } catch { enabled = false; }
    return enabled ? this.restart() : this.status();
  }

  setState(state, message = '') {
    this.state = state; this.message = message;
    try { this.onStatus(this.status()); } catch { /* UI only */ }
  }

  async syncWithConfig() {
    let enabled = false;
    try { enabled = !!this.isEnabled(); } catch { enabled = false; }
    if (enabled) {
      this.cancelDrain();
      return this.ensureRunning().catch(error => { this.logger.warn?.('[company-proxy] ' + error.message); return this.status(); });
    }
    if (this.child) await this.stopWhenIdle();
    return this.status();
  }

  // The last tool using the company model was switched off: requests already on their way finish first, then the
  // proxy stops. Sessions opened earlier with the company model stop answering afterwards, which the notice says.
  async stopWhenIdle({ pollMs = DRAIN_POLL_MS, maxMs = DRAIN_MAX_MS } = {}) {
    if (this.draining) return this.draining;
    const inFlight = async () => {
      try { const s = await this.request('/admin/status'); this.lastStatus = s; return Number(s?.stats?.inFlight || 0) + Number(s?.stats?.queued || 0); }
      catch { return 0; }
    };
    let busy = await inFlight();
    if (!busy) { await this.stop(); return this.status(); }
    const deadline = Date.now() + maxMs;
    this.drainCancelled = false;
    this.setState('draining', `已没有工具选「公司模型」：等正在进行的 ${busy} 个公司模型请求结束后再停下反代。之前用公司模型开的会话之后再发消息会失败，需要时请在「自有 API」里重新选回公司模型。`);
    try { this.onNotice({ type: 'proxy_draining', text: this.message, persistent: true }); } catch { /* UI only */ }
    this.draining = (async () => {
      while (!this.drainCancelled && busy && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        busy = await inFlight();
      }
      if (!this.drainCancelled) await this.stop();
      return this.status();
    })().finally(() => { this.draining = null; });
    return this.draining;
  }

  cancelDrain() {
    if (!this.draining) return;
    this.drainCancelled = true;
    if (this.child) this.setState('running', '公司模型反代运行中');
  }

  // 新建公司模型会话前用：反代刚启动、还在准备上游（含首次签名初始化，约 10–20 秒）时等它准备好，
  // 而不是直接报「创建失败」（2026-11-07 公司真机：首次用公司模型点「创建会话」就失败）。
  // 只等「准备中」；区域未知、登录缺失这类要用户处理的情况立即返回，由调用方报原因。
  async ensureReady({ timeoutMs = READY_WAIT_MS, stepMs = 500 } = {}) {
    let status = await this.ensureRunning();
    const deadline = Date.now() + timeoutMs;
    const preparing = s => s.state === 'starting' || (s.state === 'not-ready' && (!s.code || s.code === 'INITIALIZING'));
    while (preparing(status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, stepMs));
      if (this.child && this.state !== 'starting') await this.poll();
      status = this.status();
    }
    return status;
  }

  async ensureRunning() {
    // 已在跑（含「上游未就绪」）就不再起第二个进程；要重读上游配置请用 restart()。
    if (this.child && (this.state === 'running' || this.state === 'not-ready')) return this.status();
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async start() {
    this.stopping = false;
    this.endpoint = null;
    const endpoint = this.proxy().ensureEndpoint(this.dataDir);
    fs.mkdirSync(path.dirname(this.logPath()), { recursive: true });
    const stateFile = path.join(this.proxy().proxyDir(this.dataDir), 'proxy-state.json');
    const env = { ...process.env, AI_HUB_COMPANY_PROXY_KEY: endpoint.key };
    // Hub 认定的 CodeAgent 安装目录（自动发现 / 手选的那份，能跟进 npm 转发入口）交给反代，作为它查找安装目录的第一个候选。
    delete env.AI_HUB_CODEAGENT_INSTALL_DIR;
    try { const dir = require('../core/codeagent-config').codeagentInstallDir(process.env); if (dir) env.AI_HUB_CODEAGENT_INSTALL_DIR = dir; }
    catch (error) { this.logger.warn?.('[company-proxy] CodeAgent install dir not found: ' + error.message); }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    delete env.NODE_OPTIONS;
    this.proxy().applyNoProxy(env);
    const args = [...systemCaArgs(), serverScript(), '--data-dir', this.dataDir, '--port', String(endpoint.port || 0), '--parent-pid', String(process.pid)];
    if (this.mock) args.push('--mock-upstream');
    this.setState('starting', '公司模型反代正在启动…');
    const logFd = fs.openSync(this.logPath(), 'a');
    let child;
    try {
      child = spawn(process.execPath, args, { env, windowsHide: true, detached: false, stdio: ['ignore', logFd, logFd] });
    } finally { fs.closeSync(logFd); }
    this.child = child;
    child.once('error', error => this.logger.warn?.('[company-proxy] launch failed: ' + error.message));
    child.once('exit', (code, signal) => this.onExit(child, code, signal));
    const ready = await this.waitForState(child, stateFile);
    if (!ready) {
      // Stopped while starting (stop() or the setting switched off): stay "stopped", it is not a failure.
      if (this.stopping) return this.status();
      // Our own kill of a process that never came up is not an "unexpected exit": no automatic restart for it.
      if (this.child === child) { this.child = null; try { child.kill(); } catch { /* gone */ } }
      this.setState('failed', '公司模型反代没能启动，详情见日志：' + this.logPath());
      throw new Error(this.message);
    }
    if (this.stopping || this.child !== child) return this.status();
    this.endpoint = { ...endpoint, port: ready.port, pid: child.pid };
    this.proxy().setEndpointPort(this.dataDir, ready.port);
    await this.poll();
    if (!this.timer) { this.timer = setInterval(() => void this.poll(), POLL_MS); this.timer.unref?.(); }
    return this.status();
  }

  async waitForState(child, stateFile) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || this.child !== child) return null;
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (state.pid === child.pid && state.port) return state;
      } catch { /* not yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  }

  onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    if (this.stopping) { this.setState('stopped'); return; }
    this.logger.warn?.(`[company-proxy] exited unexpectedly (code ${code}, signal ${signal})`);
    if (this.restarts < 1) {
      this.restarts++;
      this.setState('starting', '公司模型反代意外退出，正在自动重启…');
      void this.ensureRunning().catch(() => {});
      return;
    }
    this.setState('failed', '公司模型反代反复退出，已停止自动重启。请在「自有 API」里点「重新启动反代」；详情见日志：' + this.logPath());
  }

  async request(pathname, { method = 'GET', timeoutMs = 3000 } = {}) {
    const endpoint = this.endpoint;
    if (!endpoint?.port || endpoint.pid !== this.child?.pid) throw new Error('no endpoint');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}${pathname}`, { method, signal: controller.signal,
        headers: { authorization: `Bearer ${endpoint.key}` } });
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  // 同一时刻只跑一次读状态（自动重试会让一次读状态拉长到几秒，不能和下一次定时读叠起来）。
  poll() {
    if (this.polling) return this.polling;
    this.polling = this.pollOnce().finally(() => { this.polling = null; });
    return this.polling;
  }

  async pollOnce() {
    if (!this.child) return;
    let status;
    // 就绪探测：GET /admin/status 只读反代自己的状态，重复读没有副作用；反代刚起、本机端口一时连不上（ECONNREFUSED/ECONNRESET）
    // 这类偶发错误隔一秒再读一次（core/transient-retry.js），免得「上游准备中」的状态晚 5 秒才更新。关停（POST /admin/shutdown）不重试。
    try { status = await require('../core/transient-retry').retryOnce(() => this.request('/admin/status'), { label: 'company-proxy-status', budgetMs: 4500, ...(this.retryOptions || {}) }); }
    catch { return; }
    this.lastStatus = status;
    if (this.draining) { /* keep the draining message */ }
    else if (!status.ready) this.setState('not-ready', status.message || '公司模型反代已启动，但公司上游还没准备好');
    else this.setState('running', status.mock ? '公司模型反代运行中（模拟上游，仅用于测试）' : '公司模型反代运行中');
    this.noteUsage(status.router?.accounts);
    for (const event of status.router?.events || []) {
      const id = `${event.at}:${event.type}:${event.account || event.to || ''}:${event.session || ''}`;
      if (this.seenEvents.has(id)) continue;
      this.seenEvents.add(id);
      if (this.seenEvents.size > 500) this.seenEvents = new Set([...this.seenEvents].slice(-200));
      // 带模型的限流只冷却这个号的这个模型（反代自己按模型冷却）；不再把整个号标成暂停，免得 GLM 也显示用不了。
      if (event.type === 'rate_limited' && event.account && !event.model) {
        try {
          require('../core/codeagent-quota').markAvoid(this.dataDir, event.account, { source: 'error', kind: 'rate-limit',
            reason: '公司模型反代：上游限流（HTTP 429）', until: event.until || undefined });
        } catch { /* account page only */ }
      }
      const text = NOTICE[event.type]?.(event);
      const key = noticeKey(event);
      if (text && !this.noticeKeys.has(key)) {
        this.noticeKeys.add(key);
        try { this.onNotice({ type: event.type, text, account: event.account || event.to || null, persistent: true }); } catch { /* UI only */ }
      }
    }
  }

  // 反代每成功跑完请求，就把这个号的额度读数标成待刷新：和 CodeAgent 每轮结束一样（main.js markUsageDirty），
  // 打开额度面板时按 10 分钟冷却重读。反代重启后计数归零，只重新记基线。
  noteUsage(accounts) {
    if (!Array.isArray(accounts)) return;
    for (const a of accounts) {
      if (!a || typeof a.id !== 'string') continue;
      const ok = Number(a.ok) || 0, before = this.okCounts.get(a.id);
      this.okCounts.set(a.id, ok);
      if (before === undefined || ok <= before) continue;
      try { require('../core/codeagent-usage-menu').markUsageDirty(this.dataDir, a.id); } catch { /* 读数标记失败不影响反代 */ }
    }
  }

  async restart() {
    this.restarts = 0;
    await this.stop();
    return this.ensureRunning();
  }

  async stop() {
    this.stopping = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const child = this.child;
    if (!child) { this.setState('stopped'); return; }
    try { await this.request('/admin/shutdown', { method: 'POST', timeoutMs: 1500 }); } catch { /* fall through to kill */ }
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, 2500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (this.child === child) this.child = null;
    this.setState('stopped');
  }

  // Synchronous last resort for process exit paths.
  killNow() {
    this.stopping = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.child?.kill(); } catch { /* gone */ }
  }
}

module.exports = { CompanyProxyService, serverScript, systemCaArgs, noticeKey, NOTICE };
