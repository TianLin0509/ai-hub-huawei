'use strict';
// 账号页 · 风控标记（2026-10-31）：改动后广播给所有界面，账号标签和启动中心即时更新。

function registerAccountRiskIpc(ipcMain, { store, sendToRenderer }) {
  const wrap = fn => async (_event, payload = {}) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (error) { return { ok: false, error: error.message }; }
  };
  const changed = snapshot => { sendToRenderer('account-risk:changed', snapshot); return snapshot; };
  ipcMain.handle('account-risk:list', wrap(() => store.snapshot()));
  ipcMain.handle('account-risk:flag', wrap(payload => changed(store.flag(payload))));
  ipcMain.handle('account-risk:clear', wrap(payload => changed(store.clear(payload))));
}

module.exports = { registerAccountRiskIpc };
