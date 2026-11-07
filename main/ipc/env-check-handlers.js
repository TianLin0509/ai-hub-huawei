'use strict';
// 环境体检的主进程入口（5.5.24）：env-check:run 汇总各项检测（core/env-check.js），env-check:fix 执行修复按钮里要主进程做的那几件事。
// 修复只做用户点了才做的、可撤回的小动作：再找一次 welink-cli、重启公司模型反代、打开下载页/数据目录。
// 打开网址只认上一次体检结果里这一项自己带的地址，页面传不进任意网址。
function registerEnvCheckIpc(ipcMain, deps) {
  const envCheck = require('../../core/env-check');
  let last = null, running = null;

  const context = () => ({
    env: process.env,
    platform: process.platform,
    dataDir: deps.dataDir(),
    version: deps.version(),
    isCompany: deps.isCompany(),
    kindAllowed: kind => require('../../core/distribution').kindAllowed(kind),
    assistant: deps.assistant,
    proxy: deps.proxy,
    appUpdate: deps.appUpdate,
    getConfig: deps.getConfig,
    codeagentCommand: () => require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).command,
  });

  async function run() {
    // 连点「重新体检」时共用进行中的那一次。
    if (running) return running;
    running = envCheck.runEnvCheck(context()).then(result => {
      last = result;
      return { ok: true, ...result, report: envCheck.formatReport(result) };
    }).catch(error => ({ ok: false, error: error.message })).finally(() => { running = null; });
    return running;
  }

  ipcMain.handle('env-check:run', () => run());

  ipcMain.handle('env-check:fix', async (_event, request = {}) => {
    const id = String(request.id || ''), act = String(request.act || '');
    const item = last?.items?.find(x => x.id === id) || null;
    try {
      if (act === 'welink-find') {
        const assistant = deps.assistant();
        if (!assistant) throw new Error('这个版本没有助理');
        const search = await assistant.findCli({ force: true });
        return { ok: true, message: search?.state === 'found' ? '找到了 welink-cli' : '还是没找到，可以到助理页手动选择程序位置', search };
      }
      if (act === 'proxy-restart') {
        const restart = deps.proxyRestart;
        if (!restart) throw new Error('这个版本没有公司模型反代');
        await restart();
        return { ok: true, message: '已重新启动反代' };
      }
      if (act === 'ppt-download') {
        // 镜像不可用时退到 GitHub 备用入口（和 PPT 页的两个下载按钮同一套地址）。
        const { downloadDoctor } = require('../../core/company-assistant/ppt-doctor-download');
        try { await downloadDoctor('mirror'); } catch { await downloadDoctor('github'); }
        return { ok: true, message: '已在浏览器里打开下载地址' };
      }
      if (act === 'open-url') {
        const fix = item?.fixes?.find(f => f.act === 'open-url' && f.url === request.url) || item?.fixes?.find(f => f.act === 'open-url');
        if (!fix || !/^https:\/\//.test(String(fix.url || ''))) throw new Error('这一项没有可打开的网址');
        await deps.openExternal(fix.url);
        return { ok: true };
      }
      if (act === 'open-data-dir') {
        const error = await deps.openPath(deps.dataDir());
        if (error) throw new Error(error);
        return { ok: true };
      }
      throw new Error('不认识的操作');
    } catch (error) { return { ok: false, error: error.message }; }
  });

  return { run };
}

module.exports = { registerEnvCheckIpc };
