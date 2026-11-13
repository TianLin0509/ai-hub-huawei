'use strict';
// 公司版「门户待办」的主进程入口（2026-11-12）：页面只经这些 IPC 读状态、手动刷新、改设置。
function registerCompanyW3Ipc(ipcMain, getService) {
  const svc = () => { const s = getService(); if (!s) throw new Error('门户待办功能没有开启'); return s; };
  const handlers = {
    status: () => svc().status(),
    sync: async () => { await svc().sync({ reason: 'manual' }); return svc().status(); },
    // 打开页面：到了该取的时刻还没取、或从没取到过时，开始取一次（不等结果）。
    'ensure-fresh': () => { const s = svc(); if (s.shouldRun() || !s.status().lastSuccessAt) void s.sync({ reason: 'open' }).catch(() => {}); return s.status(); },
    'set-settings': (request) => ({ ok: true, settings: svc().setSettings(request || {}) }),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('company-w3:' + name, async (_event, request = {}) => {
      try { return await handler(request); } catch (error) { return { ok: false, error: error.message }; }
    });
  }
}

module.exports = { registerCompanyW3Ipc };
