'use strict';
// 负责人组队的界面接口（2026-11-01）：列团队、用户批准或驳回招人计划。
// 批准只从这里进来——会话里的模型只能提交计划，不能自己批准。
function registerTeamIpc(ipcMain, getService) {
  const call = fn => async (_event, args = {}) => {
    const service = getService();
    if (!service) return { ok: false, error: '组队服务尚未就绪' };
    try { return { ok: true, result: await fn(service, args || {}) }; }
    catch (error) { return { ok: false, error: error.message }; }
  };
  ipcMain.handle('team:list', call(s => s.listTeams()));
  ipcMain.handle('team:accounts', call(s => s.accounts()));
  ipcMain.handle('team:decide', call((s, a) => s.decide({
    leadSid: String(a.leadSid || ''), planId: String(a.planId || ''), approve: a.approve === true,
    note: String(a.note || '').slice(0, 2000), edits: Array.isArray(a.edits) ? a.edits.slice(0, 16) : null,
  })));
}
module.exports = { registerTeamIpc };
