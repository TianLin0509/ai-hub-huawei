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
  return { rows };
}

function registerAvatarIpc(ipcMain, getService, { dialog = null, getWindow = () => null } = {}) {
  const id = r => String(r?.avatarId || ''), item = r => String(r?.itemId || '');
  const handlers = {
    status: s => s.status(),
    targets: s => s.targets(),
    create: (s, r) => s.create(r || {}),
    update: (s, r) => s.update(id(r), r?.patch || {}),
    remove: (s, r) => s.remove(id(r)),
    'pause-all': (s, r) => s.pauseAll(r?.paused !== false),
    persona: (s, r) => s.regeneratePersona(id(r)),
    send: (s, r) => s.send(id(r), item(r), String(r?.text || ''), { ackRisk: r?.ackRisk === true }),
    recall: (s, r) => s.recall(id(r), item(r)),
    drop: (s, r) => s.drop(id(r), item(r)),
    done: (s, r) => s.done(id(r), item(r)),
    'remind-only': (s, r) => s.remindOnly(id(r), item(r)),
    redraft: (s, r) => s.redraft(id(r), item(r)),
    relogin: s => s.recheckLogin(),
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

module.exports = { registerAvatarIpc, listAvatarBackends };
