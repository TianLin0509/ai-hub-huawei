'use strict';

// 「员工助手 Beta」页的主进程一侧（2026-11-26）：一键把 HUB-H 公司模型接进员工助手、断开、自动维护。
// 接入后：HUB-H 公司模型代理常驻（main.js 的 isEnabled 读 weclaw-link.json）；每分钟看一次员工助手，
// 员工助手刚打开、HUB-H 重启后端口或钥匙变了、模型清单变了，就自动重写那一条模型配置，用户不用再点。
const link = require('../core/weclaw-link');

const SYNC_MS = 60 * 1000;

// 安装包核对：Windows 自带的 Authenticode 校验。安装包和已装的员工助手主程序都要签名有效，且签名方相同才装。
// 路径经环境变量传给 PowerShell（不拼进命令文本，避免引号注入）。
function verifySameSigner(file, installedExe, { execFile = require('node:child_process').execFile } = {}) {
  const script = '$a=Get-AuthenticodeSignature -LiteralPath $env:WECLAW_INSTALLER; $b=Get-AuthenticodeSignature -LiteralPath $env:WECLAW_INSTALLED;'
    + ' [Console]::Out.Write([string]$a.Status + "|" + [string]$b.Status + "|" + [string]$a.SignerCertificate.Subject + "|" + [string]$b.SignerCertificate.Subject)';
  return new Promise(resolve => {
    if (!installedExe) { resolve({ ok: false, detail: '没找到已装的员工助手，无法比对签名' }); return; }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: 30000, env: { ...process.env, WECLAW_INSTALLER: String(file), WECLAW_INSTALLED: String(installedExe) } }, (error, stdout) => {
        const [st1, st2, sub1 = '', sub2 = ''] = String(stdout || '').trim().split('|');
        const ok = !error && st1 === 'Valid' && st2 === 'Valid' && !!sub1 && sub1 === sub2;
        resolve({ ok, detail: error ? error.message : ok ? 'Valid' : `安装包 ${st1 || '未知'}${sub1 && sub2 && sub1 !== sub2 ? '，签名方和已装的员工助手不一致' : ''}` });
      });
  });
}
// 静默升级：员工助手安装包支持 --upgrade --silent（11-26 公司真机：员工助手开着也能装，约 1 分钟，装完不会自己重开）。
// 要管理员权限时（740 / EACCES）改用 RunAs 再试一次，由 Windows 弹确认框；用户点「否」或启动失败都如实返回非 0。
function runSilentInstaller(file, { spawn = require('node:child_process').spawn, execFile = require('node:child_process').execFile } = {}) {
  const viaRunAs = () => new Promise(resolve => {
    const script = "$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath $env:WECLAW_INSTALLER -ArgumentList '--upgrade','--silent' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: 15 * 60 * 1000, env: { ...process.env, WECLAW_INSTALLER: String(file) } },
      error => resolve(error ? (typeof error.code === 'number' && error.code !== 0 ? error.code : 1) : 0));
  });
  return new Promise(resolve => {
    let child;
    try { child = spawn(file, ['--upgrade', '--silent'], { windowsHide: true, stdio: 'ignore' }); } catch { resolve(viaRunAs()); return; }
    child.once('error', error => resolve(error.code === 'EACCES' || error.errno === 740 || /740|elevation/i.test(error.message) ? viaRunAs() : 1));
    child.once('exit', code => resolve(code === 740 ? viaRunAs() : (code ?? 1)));
  });
}
// 防「核对后被换掉」：先把安装包复制到 HUB-H 自己的临时目录，核对和执行都用这份副本。
function stageInstaller(file, dataDir) {
  const fs = require('node:fs'), path = require('node:path');
  const dir = path.join(dataDir, 'weclaw-upgrade');
  fs.mkdirSync(dir, { recursive: true });
  for (const old of fs.readdirSync(dir)) { try { fs.rmSync(path.join(dir, old), { force: true }); } catch { /* 上次的副本还被占用就留着 */ } }
  const copy = path.join(dir, `${Date.now()}-${path.basename(file)}`);
  fs.copyFileSync(file, copy);
  return copy;
}

class WeclawLinkService {
  constructor({ dataDir, proxy, readEndpoint, listModels, fetchImpl = (...args) => fetch(...args), onChanged = () => {}, findInstall = link.findInstall, log = console,
    openPath = async () => '不支持', openExternal = async () => {}, readVersion = () => link.readInstalledVersion(), findInstaller = () => link.findDownloadedInstaller(),
    verifySignature = verifySameSigner, runInstaller = runSilentInstaller, stage = stageInstaller, probe = link.probeModel, relaunchDelayMs = 3000 }) {
    Object.assign(this, { dataDir, proxy, readEndpoint, listModels, fetchImpl, onChanged, findInstall, log, openPath, openExternal, readVersion, findInstaller, verifySignature, runInstaller, stage, probe, relaunchDelayMs });
    this.upgrading = null; this.lastUpgrade = null; this.lastTest = null; this.testing = false; this.upgradeDone = null;
    // 测试用：AI_HUB_WECLAW_BASE 指向假的员工助手本机服务（tests/e2e-weclaw-page-cdp.js）。
    this.base = process.env.AI_HUB_WECLAW_BASE || '';
    this.lastError = '';
    this.lastSyncAt = 0;
    this.timer = null;
    this.syncing = null;
    this.queue = Promise.resolve();
  }

  enabled() { return link.readState(this.dataDir).enabled; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sync(); }, SYNC_MS);
    this.timer.unref?.();
    const state = link.readState(this.dataDir);
    if (state.enabled || state.pendingRemove) setTimeout(() => { void this.sync(); }, 15000).unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  async locate() {
    this.base = await link.findAgentBase(this.fetchImpl, { hint: this.base });
    return this.base;
  }

  async proxyEndpoint({ wait = false } = {}) {
    let status = this.proxy.status();
    if (wait) status = await this.proxy.ensureReady();
    const endpoint = this.readEndpoint() || {};
    // 代理没在跑时 endpoint.json 里的端口只是「下次想用的」，不能拿去写员工助手的配置。
    const live = status?.state === 'running' || status?.state === 'not-ready';
    const port = live ? (Number(status?.port) || Number(endpoint.port) || 0) : 0;
    return { port, key: endpoint.key || '', state: status?.state || 'stopped', message: status?.message || '' };
  }

  // 改员工助手配置的操作（接入、断开、改号池、定时同步）一个接一个做：
  // 定时同步正在写的时候点「断开」，断开排在它后面、最后生效，不会被旧的写入盖回去。
  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
  patchState(patch) { const next = { ...link.readState(this.dataDir), ...patch }; link.writeState(this.dataDir, next); return next; }

  expectedProvider(proxy, allowPool) {
    return link.buildProvider({ port: proxy.port, key: proxy.key, models: this.listModels(), allowPool })[link.PROVIDER_ID];
  }

  // 给页面看的状态：只给「对不对得上」的结论，不把钥匙送到页面。
  async status() {
    const state = link.readState(this.dataDir);
    const install = this.findInstall();
    const base = await this.locate();
    const proxy = await this.proxyEndpoint();
    let linked = { present: false, port: 0, models: [] }, current = true, preview = { mine: [], others: [] }, online = { healthy: false, loggedIn: false };
    if (base) {
      try {
        const all = await link.readModels(this.fetchImpl, base);
        linked = link.describeLinked({ providers: all.mine ? [all.mine] : [] });
        preview = { mine: all.mineNames, others: all.others };
        if (all.mine && proxy.port > 0 && proxy.key) current = link.matchesExpected(all.mine, this.expectedProvider(proxy, state.allowPool));
      } catch (error) { this.lastError = error.message; }
      online = await link.readHealth(this.fetchImpl, base);
    }
    const installed = install ? await Promise.resolve(this.readVersion()).catch(() => '') : '';
    const pkg = this.findInstaller();
    const latest = pkg?.version || '';
    const models = this.listModels().map(m => ({ id: m.id, label: m.label || m.id }));
    return { ok: true, available: true, installed: !!install, running: !!base, online, enabled: state.enabled, allowPool: state.allowPool,
      version: { installed, latest, upgradeAvailable: !!(installed && latest && link.compareVersions(latest, installed) > 0) },
      upgrading: !!this.upgrading, lastUpgrade: this.lastUpgrade, lastTest: this.lastTest, testing: !!this.testing,
      pendingRemove: state.pendingRemove, linked, preview, proxy: { port: proxy.port, state: proxy.state, message: proxy.message }, models,
      stale: state.enabled && linked.present && !current,
      appliedAt: state.appliedAt, lastSyncAt: this.lastSyncAt, lastError: this.lastError };
  }

  // ---- 跳转：打开员工助手（开着就切到前台）、在员工助手里新建对话（它自己注册的 weclaw:// 协议）
  async open() {
    const exe = this.findInstall();
    if (!exe) throw new Error('这台电脑上没找到员工助手');
    const error = await this.openPath(exe);
    if (error) throw new Error(`打不开员工助手：${error}`);
    return { ok: true };
  }
  async newChat() {
    if (!this.findInstall()) throw new Error('这台电脑上没找到员工助手');
    await this.openExternal('weclaw://home/chat');
    return { ok: true };
  }

  // ---- 一键升级：用员工助手自己下载好的安装包（核对签名与已装的员工助手同一签名方）静默升级；安装包会先关掉员工助手，装完由这里重新打开。
  async upgrade() {
    if (this.upgrading) return { ok: true, started: false, running: true };
    // 第一次 await 之前就占位，连点两下也只会起一个安装程序。
    this.upgrading = { startedAt: Date.now(), version: '' };
    let staged = '';
    try {
      const pkg = this.findInstaller();
      if (!pkg) throw new Error('没有找到员工助手下载好的新版安装包');
      this.upgrading.version = pkg.version;
      staged = this.stage(pkg.file, this.dataDir);
      const sig = await this.verifySignature(staged, this.findInstall());
      if (!sig.ok) throw new Error(`安装包签名核对没通过（${sig.detail || '未知'}），没有安装`);
      this.onChanged();
      this.upgradeDone = Promise.resolve().then(() => this.runInstaller(staged)).then(async code => {
        if (code !== 0) { this.lastUpgrade = { ok: false, at: Date.now(), version: pkg.version, error: code === 1223 ? '没有获得管理员权限，升级已取消' : `安装程序退出码 ${code}` }; return; }
        this.lastUpgrade = { ok: true, at: Date.now(), version: pkg.version };
        await new Promise(r => setTimeout(r, this.relaunchDelayMs));
        if (!(await this.locate())) {
          try { await this.open(); } catch (error) { this.lastUpgrade.relaunchError = `升级完成，但没能自动重新打开员工助手：${error.message}`; }
        }
      }).catch(error => { this.lastUpgrade = { ok: false, at: Date.now(), version: pkg.version, error: error.message }; })
        .finally(() => { this.upgrading = null; this.onChanged(); });
      return { ok: true, started: true, version: pkg.version };
    } catch (error) {
      this.upgrading = null;
      this.lastUpgrade = { ok: false, at: Date.now(), version: this.lastUpgrade?.version || '', error: error.message };
      this.onChanged();
      throw error;
    }
  }

  // ---- 试一次：按员工助手同样的方式经 HUB-H 代理发一句话，量首字时间（不进员工助手的历史记录）
  async test() {
    const state = link.readState(this.dataDir);
    if (!state.enabled) throw new Error('先完成第 3 步「接入 HUB-H」');
    const proxy = await this.proxyEndpoint({ wait: true });
    if (!(proxy.port > 0) || !proxy.key) throw new Error(proxy.message || 'HUB-H 公司模型代理没有启动');
    const list = this.listModels();
    const model = (list.find(m => /glm-5\.3/i.test(m.id)) || list[0])?.id;
    if (!model) throw new Error('还没有可用的公司模型');
    this.testing = true; this.onChanged();
    try {
      const r = await this.probe({ fetchImpl: this.fetchImpl, port: proxy.port, key: link.apiKey(proxy.key, state.allowPool), model });
      const label = list.find(m => m.id === model)?.label || model;
      this.lastTest = { ...r, label, at: Date.now(), port: proxy.port };
      return { ok: true, ...this.lastTest };
    } finally { this.testing = false; this.onChanged(); }
  }

  // 合入（或覆盖）员工助手里的 HUB-H 模型来源；员工助手没开时返回 not-running，打开后由定时同步合入。只在 exclusive 里调用。
  async apply({ wait = true } = {}) {
    const proxy = await this.proxyEndpoint({ wait });
    if (!(proxy.port > 0) || !proxy.key) throw new Error(proxy.message || 'HUB-H 公司模型代理没有启动，请确认已登录 CodeAgent 账号');
    const base = await this.locate();
    if (!base) return { ok: true, applied: false, reason: 'not-running' };
    const state = link.readState(this.dataDir);
    if (!state.enabled) return { ok: true, applied: false, reason: 'disabled' };
    const provider = this.expectedProvider(proxy, state.allowPool);
    const result = await link.applyProvider(this.fetchImpl, base, { [link.PROVIDER_ID]: provider });
    if (result && result.ok === false) throw new Error(result.error || '员工助手没有接受这份配置');
    this.patchState({ port: proxy.port, appliedAt: Date.now(), models: Object.keys(provider.models) });
    this.lastError = '';
    return { ok: true, applied: true, pendingReload: !!result?.pendingReload };
  }

  // 删掉员工助手里的这一条；本来就没有也算删掉。只在 exclusive 里调用。
  async remove(base) {
    try { await link.removeProvider(this.fetchImpl, base); return true; } catch (error) {
      let gone = false;
      try { gone = !(await link.readProvider(this.fetchImpl, base)); } catch { /* 读不到就照实报 */ }
      if (!gone) throw error;
      return true;
    }
  }

  connect({ allowPool } = {}) {
    return this.exclusive(async () => {
      this.patchState({ enabled: true, pendingRemove: false, ...(typeof allowPool === 'boolean' ? { allowPool } : {}) });
      // 让 main.js 的 isEnabled 立刻看到 enabled，代理按配置常驻。
      await this.proxy.syncWithConfig?.();
      try { return await this.apply({ wait: true }); } catch (error) { this.lastError = error.message; throw error; } finally { this.onChanged(); }
    });
  }

  // 断开：员工助手开着就当场删；没开（或这次没删掉）就记下「待移除」，员工助手打开后由定时同步补删。
  disconnect() {
    return this.exclusive(async () => {
      this.patchState({ enabled: false, pendingRemove: true });
      let removed = false;
      try {
        const base = await this.locate();
        if (base) { removed = await this.remove(base); this.patchState({ pendingRemove: false }); }
      } catch (error) { this.lastError = error.message; }
      await this.proxy.syncWithConfig?.();
      this.onChanged();
      return { ok: true, removed, pending: !removed };
    });
  }

  setAllowPool(allowPool) {
    return this.exclusive(async () => {
      const state = this.patchState({ allowPool: allowPool === true });
      const result = state.enabled ? await this.apply({ wait: false }).catch(error => { this.lastError = error.message; return { ok: false, error: error.message }; }) : { ok: true };
      this.onChanged();
      return result;
    });
  }

  // 每分钟：已接入时，员工助手里没有这一条、或地址/钥匙/模型清单对不上，就重写；断开后还没删掉的，员工助手一打开就补删。
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.exclusive(async () => {
      const state = link.readState(this.dataDir);
      if (!state.enabled && !state.pendingRemove) return { ok: true, skipped: 'disabled' };
      const base = await this.locate();
      this.lastSyncAt = Date.now();
      if (!base) return { ok: true, skipped: 'not-running' };
      if (!state.enabled) {
        await this.remove(base);
        this.patchState({ pendingRemove: false });
        this.onChanged();
        return { ok: true, removed: true };
      }
      const proxy = await this.proxyEndpoint();
      if (!(proxy.port > 0) || !proxy.key) return { ok: true, skipped: 'proxy-not-ready' };
      if (link.matchesExpected(await link.readProvider(this.fetchImpl, base), this.expectedProvider(proxy, state.allowPool))) return { ok: true, fresh: true };
      const result = await this.apply({ wait: false });
      this.log.info?.(`[weclaw-link] 已更新员工助手里的 HUB-H 配置（端口 ${proxy.port}）`);
      this.onChanged();
      return result;
    }).catch(error => { this.lastError = error.message; return { ok: false, error: error.message }; })
      .finally(() => { this.syncing = null; });
    return this.syncing;
  }
}

module.exports = { WeclawLinkService, verifySameSigner, runSilentInstaller, stageInstaller };
