'use strict';
// 「分身」页的主进程入口。页面只能做这里列出的事；发送的收信方由服务从事项记录里取，页面传不进来。
const path = require('node:path');

// 后端选项：自动、个人账号、号池账号，和启动中心、组队用同一份账号与模型清单。
function listAvatarBackends({ dataDir, sessionManager, env = process.env }) {
  const team = require('../team/codeagent-accounts').listTeamAccounts({ dataDir, sessionManager, env });
  const rows = [{ id: 'auto', label: '自动选择', usable: true, models: [], pool: false }];
  try {
    const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(env).configDir;
    const me = require('../../core/codeagent-model-route').personalAccount({ dataDir, personalDir });
    if (me) rows.push({ id: 'personal', label: '个人账号', usable: true, models: me.defaultModel ? [me.defaultModel] : [], defaultModel: me.defaultModel || '', pool: false });
  } catch { /* 个人账号没登录时不列 */ }
  for (const r of team.rows.filter(row => !row.personal)) rows.push({ id: r.id, label: r.label, usable: r.usable, reason: r.unavailableReason, models: r.models || [], defaultModel: r.defaultModel || '', activeSessions: r.activeSessions || 0, pool: true });
  const gateway = gatewayRow(dataDir);
  if (gateway) rows.push(gateway);
  const codeagentAvailable = !!require('../../core/community-setup').findCommand('codeagent', env);
  const choice = require('../../core/feature-agent-choice'), routes = require('../../core/codeagent-assistant-route');
  let models = [];
  try { models = routes.modelOptions(dataDir, 'personal', require('../../core/codeagent-config').resolveCodeAgentConfig(env).configDir); } catch { /* 未配置模型 */ }
  const featureChoice = choice.resolve(dataDir, 'avatar', { backends: [
    { kind: 'codeagent', available: codeagentAvailable, models }, { kind: 'codeagent-lite', available: codeagentAvailable, models },
    { kind: 'api-gateway', available: !!gateway?.usable, models: (gateway?.models || []).map(id => ({ id })) },
  ] });
  return { rows, codeagentAvailable, featureChoice };
}

// 部门 API key（网关）这一行（R45，11-24 反馈「分身不能配自定义 API / 平台模型，只能用 CodeAgent」）：
// 和「设置 → 功能使用的 Agent → 分身」是同一个设置（所有分身共用），这里只是把它放到分身页能直接点到的地方。
// 模型 = key 的对话模型表 + 手填测通的；没存 key 时照样列出、置灰并写原因，同事知道有这条路。
function gatewayRow(dataDir, deps = {}) {
  try {
    const route = deps.route || require('../../core/assistant-gateway-route');
    const gw = deps.gateway || require('../../core/api-gateway');
    const pref = (deps.routes || require('../../core/codeagent-assistant-route')).featurePreference(dataDir, 'avatar');
    const view = gw.read(dataDir);
    const a = route.availability(dataDir, deps.availability || {});
    const models = [...new Set([...gw.modelChoices(dataDir).map(m => m.id), ...(view.customModels || [])])];
    // configured：存了「分身用部门 key」；selected：它此刻真的生效（key 能用、所选模型还在表里）。
    // 和会话实际走的线路同一口径（core/feature-agent-choice.js resolve）：失效时页面亮实际生效的 CodeAgent 账号，残留由点回 CodeAgent 时一并清掉（审查 P1）。
    const configured = pref?.kind === route.KIND;
    const selected = configured && a.available && (!pref.model || models.includes(pref.model));
    return { id: route.KIND, label: route.LABEL, usable: a.available, reason: a.available ? '' : `${a.reason}（设置 → 自有 API → API 网关）`,
      models, defaultModel: view.model || '', pool: false, gateway: true, configured, selected, model: selected ? pref.model || '' : '' };
  } catch { return null; }
}

function registerAvatarIpc(ipcMain, getService, { dialog = null, getWindow = () => null } = {}) {
  const id = r => String(r?.avatarId || ''), item = r => String(r?.itemId || '');
  const handlers = {
    status: (s, r) => s.status({ autoCheck: r?.autoCheck === true }),
    targets: s => s.targets({ refresh: true }),
    create: (s, r) => s.create(r || {}),
    update: (s, r) => s.update(id(r), r?.patch || {}),
    remove: (s, r) => s.remove(id(r)),
    'pause-all': (s, r) => s.pauseAll(r?.paused !== false),
    persona: (s, r) => s.regeneratePersona(id(r)),
    send: (s, r) => s.send(id(r), item(r), String(r?.text || ''), { ackRisk: r?.ackRisk === true }),
    recall: (s, r) => s.recall(id(r), item(r)),
    drop: (s, r) => s.drop(id(r), item(r)),
    done: (s, r) => r?.action === 'confirm-answered' ? s.confirmAnswered(id(r), item(r)) : s.done(id(r), item(r)),
    'remind-only': (s, r) => s.remindOnly(id(r), item(r)),
    redraft: (s, r) => s.redraft(id(r), item(r)),
    relogin: (s, r) => s.recheckLogin({ retryTick: r?.retryTick === true, avatarId: id(r), itemId: item(r) }),
    recheck: (s, r) => s.recheckLogin({ retryTick: r?.retryTick === true, avatarId: id(r), itemId: item(r) }),
    session: (s, r) => s.sessionOf(id(r)),
    'pick-source': async (s, r) => {
      const dir = r?.type === 'dir', got = await dialog.showOpenDialog(getWindow(), { title: dir ? '选择资料文件夹' : '选择资料文件', properties: [dir ? 'openDirectory' : 'openFile'] });
      if (got.canceled || !got.filePaths?.[0]) return { ok: true, source: null };
      return { ok: true, source: { path: got.filePaths[0], name: path.basename(got.filePaths[0]), type: dir ? 'dir' : 'file' } };
    },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('avatar:' + name, async (_event, request = {}) => {
      try {
        const service = getService();
        if (!service) return { ok: true, available: false, missing: true, reason: '分身只在公司电脑上可用' };
        return await handler(service, request);
      } catch (error) { return { ok: false, error: error.message }; }
    });
  }
}

module.exports = { registerAvatarIpc, listAvatarBackends, gatewayRow };
