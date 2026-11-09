'use strict';
// 首次启动准备的主进程入口（core/first-run-prep.js）。
//   first-run:state → { mode }；first-run:start { mode } → 跑一遍，进度经 first-run:event 推给页面。
// 隔离实例（测试）默认不显示，设 AI_HUB_FIRST_RUN_PREP=1 才显示，免得盖住其他界面测试。
const path = require('node:path');
const fs = require('node:fs');

function cliFile(env = process.env) {
  const config = require('../../core/codeagent-config');
  let command = '';
  try { command = config.resolveCodeAgentConfig(env).command; } catch { return ''; }
  const file = config.commandFile(command, env);
  if (!file) return '';
  // 启动壳（codeagent.cmd）升级时不一定变，优先比安装目录里的主程序。
  const dir = path.dirname(file);
  const root = path.basename(dir).toLowerCase() === 'bin' ? path.dirname(dir) : dir;
  const main = path.join(root, 'bin', 'codeagentcli.exe');
  return fs.existsSync(main) ? main : file;
}

function registerFirstRunIpc(ipcMain, { dataDir, isCompany, send, envCheck, toolDiscovery, proxyService, lanPool, netPass, systemProxy, fetchImpl }) {
  const prep = require('../../core/first-run-prep');
  const proxy = () => require('../../core/company-model-proxy');
  const usesOwnProxy = () => { try { return !!proxyService?.isEnabled() && !lanPool?.()?.client()?.enabled; } catch { return false; } };

  const deps = {
    discover: async () => { if (toolDiscovery?.()) await toolDiscovery().list('codeagent', { force: true }); },
    codeagentFile: () => cliFile(),
    fingerprint: () => prep.fingerprint(cliFile()),
    readState: () => prep.readState(dataDir()),
    saveState: state => prep.writeState(dataDir(), state),
    envCheck: () => envCheck(),
    loginState: async () => {
      const pool = require('../../core/codeagent-pool');
      const config = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env);
      return pool.accountState(pool.readCredentials(config.configDir));
    },
    readModels: async () => {
      const serve = require('../../core/codeagent-serve');
      if (!serve.serveEnabled(dataDir())) return { skipped: true };
      const pool = require('../../core/codeagent-pool'), probe = require('../../core/codeagent-model-probe');
      const config = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env);
      const served = await serve.readAccount({ command: config.command, configDirEnv: config.configDirEnv, configDir: config.configDir,
        dataDir: dataDir(), cwd: pool.probeCwd(dataDir()), readyTimeoutMs: 20000 });
      if (served?.ok && served.models?.length) {
        const current = pool.readSettingsModel(config.configDir);
        probe.writeProbed(pool.personalModelsFile(dataDir()), { ...served, source: 'serve',
          defaultModel: served.models.find(model => model.toLowerCase() === String(current || '').toLowerCase()) || '' });
      }
      return served?.ok ? served : { ok: false, error: served?.error || '未知原因' };
    },
    proxyEnabled: usesOwnProxy,
    proxyReady: () => proxyService.ensureReady({ timeoutMs: 35000 }),
    proxyReload: async () => { await proxyService.restart(); return proxyService.ensureReady({ timeoutMs: 35000 }); },
    hello: async () => {
      const endpoint = proxy().readEndpoint(dataDir());
      if (!endpoint?.port || !endpoint?.key) return { ok: false, error: '读不到本机连接信息' };
      return prep.helloAny({ port: endpoint.port, key: endpoint.key, models: proxy().MODEL_IDS });
    },
    netPass: async () => {
      const pass = netPass();
      if (!pass) return null;
      await pass.refresh({ force: true }).catch(() => {});
      let status = pass.status();
      if (status.hosts.some(h => h.state === 'blocked')) { await pass.passAll().catch(() => {}); status = pass.status(); }
      return status;
    },
    systemProxy: () => systemProxy(),
    clockSkew: async () => {
      const page = netPass()?.status()?.hosts?.[0]?.page;
      if (!page || !fetchImpl) return null;
      const response = await fetchImpl(page, { method: 'HEAD' });
      const server = Date.parse(response.headers.get('date') || '');
      return Number.isFinite(server) ? Date.now() - server : null;
    },
  };

  let running = null;
  const runner = prep.createPrep({ isCompany: isCompany(), deps, emit: event => send('first-run:event', event) });
  const start = mode => {
    if (!running) running = runner.run(mode).finally(() => { running = null; });
    return running;
  };
  function mode() {
    const isolated = require('../../core/data-dir').isIsolatedHub();
    if (isolated && process.env.AI_HUB_FIRST_RUN_PREP !== '1') return 'none';
    return prep.decide(prep.readState(dataDir()), deps.fingerprint());
  }
  ipcMain.handle('first-run:state', () => { try { return { mode: mode(), layout: prep.layout({ isCompany: isCompany() }) }; } catch { return { mode: 'none' }; } });
  ipcMain.handle('first-run:start', (_event, request = {}) => {
    const wanted = request.mode === 'changed' ? 'changed' : 'full';
    if (wanted === 'changed') { try { require('../../core/codeagent-version-probe').forgetCodeAgentVersion(); } catch { /* 下次会重读 */ } }
    void start(wanted).catch(error => console.warn('[first-run] 准备没跑完：' + error.message));
    return { ok: true };
  });
}

module.exports = { registerFirstRunIpc, cliFile };
