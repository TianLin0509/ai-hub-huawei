'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getConfigPath, getConfig, clearConfigCache } = require('../../core/hub-config');
const { ACP_KINDS, PLAN_BASE_URL } = require('../../core/acp-profiles');
function publicSettings(config) {
  const value = config.acp || {};
  return { nodePath: value.nodePath || '', baseURL: value.baseURL || PLAN_BASE_URL,
    apiKeySet: !!value.apiKey, providers: value.providers || {} };
}
function registerAcpIpc(ipcMain, {sessionManager} = {}) {
  ipcMain.handle('acp:queue', (_event, {sessionId,id,action,epoch} = {}) => {
    const session=sessionManager?.getNativeSession(sessionId);
    if(session?.isCliProvider)throw new Error('请在 CLI 中管理待发送消息');
    if(!session?.promptQueue)throw new Error('ACP 会话不可用');
    if(epoch!==session.runtime.epoch)throw new Error('待发送消息来自旧连接');
    if(action==='read') {
      const record=session.promptQueue.records.find(r=>r.id===id);
      if(!record)throw new Error('消息已发送或移除');
      return {ok:true,text:record.text};
    }
    return session.promptQueue.action(id,action,epoch);
  });
  ipcMain.handle('acp:tool-result', async (_event, reference = {}) => {
    const session = sessionManager?.getNativeSession(reference.hubSessionId);
    if (!session?.readToolResult || session.options?.kind && !require('../../core/acp-profiles').isAcpKind(session.options.kind)) throw new Error('原生工具来源不可用，请重新载入会话');
    await session.start();
    return session.readToolResult(reference);
  });
  ipcMain.handle('acp:settings:get', () => publicSettings(getConfig()));
  // pi（r39）：装没装、能用哪些模型线路。只读文件，不起进程；钥匙不出主进程。
  ipcMain.handle('pi:status', () => {
    const pi = require('../../core/pi-cli-profile');
    const config = getConfig(), dataDir = require('../../core/data-dir').getHubDataDir();
    return { diagnosis: pi.diagnosePi(process.env), models: pi.piModelOptions(config, process.env, { dataDir }),
      defaultModel: pi.defaultPiModel(config, process.env, { dataDir }),
      routes: pi.availableRoutes(config, process.env, { dataDir }).map(route => ({ id: route.id, label: pi.routeLabel(route) })) };
  });
  // opencode（2026-11-26）：装没装、能用哪些模型线路（一键安装走 cli-tools:install，只从内源下载）。钥匙不出主进程。
  // Hermes（2026-11-28）：装没装、能用哪些模型线路（一键安装走 cli-tools:install，只从内源下载）。钥匙不出主进程。
  ipcMain.handle('hermes:status', () => {
    const hm = require('../../core/hermes-cli-profile');
    const config = getConfig(), dataDir = require('../../core/data-dir').getHubDataDir();
    return { diagnosis: hm.diagnoseHermes(process.env), models: hm.hermesModelOptions(config, process.env, { dataDir }),
      defaultModel: hm.defaultHermesModel(config, process.env, { dataDir }),
      routes: hm.availableRoutes(config, process.env, { dataDir }).map(route => ({ id: route.id, label: hm.routeLabel(route) })) };
  });
  ipcMain.handle('opencode:status', () => {
    const oc = require('../../core/opencode-cli-profile');
    const config = getConfig(), dataDir = require('../../core/data-dir').getHubDataDir();
    return { diagnosis: oc.diagnoseOpencode(process.env), models: oc.opencodeModelOptions(config, process.env, { dataDir }),
      defaultModel: oc.defaultOpencodeModel(config, process.env, { dataDir }),
      routes: oc.availableRoutes(config, process.env, { dataDir }).map(route => ({ id: route.id, label: oc.routeLabel(route) })) };
  });
  // pi 会话存的模型这次能不能用（r39 审查 P1）：缺钥匙时返回线路和要补的 Key，界面就地给输入框。不返回钥匙本身。
  ipcMain.handle('pi:route-check', (_event, { model, profileId } = {}) => {
    const pi = require('../../core/pi-cli-profile');
    const dataDir = require('../../core/data-dir').getHubDataDir();
    const result = pi.piRouteCheck(String(model || ''), getConfig(), process.env, { dataDir, profileId: String(profileId || '') });
    return result.ok ? { ok: true } : { ok: false, route: result.route, label: result.label, keyField: result.keyField, model: result.model, message: result.message };
  });
  ipcMain.handle('acp:settings:save', (_event, request = {}) => {
    try {
      const configPath = getConfigPath();
      let config = {};
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('现有配置无法读取，未覆盖'); }
      const previous = config.acp || {};
      const providers = {};
      for (const kind of ACP_KINDS) {
        const value = request.providers?.[kind] || previous.providers?.[kind] || {};
        providers[kind] = {};
        for (const key of ['entryPath','backendPath','bridgePath','cliRoot','model','mcpConfigPath']) {
          if (value[key] != null && typeof value[key] !== 'string') throw new Error('配置字段必须是文字');
          providers[kind][key] = (value[key] || '').trim();
        }
      }
      if (request.apiKey != null && typeof request.apiKey !== 'string') throw new Error('Key 格式无效');
      config.acp = { nodePath: String(request.nodePath || previous.nodePath || '').trim(),
        baseURL: PLAN_BASE_URL, providers, apiKey: request.apiKey?.trim() || previous.apiKey || '' };
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const temp = configPath + '.' + randomUUID() + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, configPath);
      clearConfigCache();
      return { ok: true, settings: publicSettings(config) };
    } catch (error) { return { ok: false, message: error.message }; }
  });
}
module.exports = { registerAcpIpc, publicSettings };
