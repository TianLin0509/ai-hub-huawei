'use strict';
// 公司版「考勤」页的主进程入口（2026-11-07）：页面只经这些 IPC 读状态、手动刷新、改设置；
// 登录窗口只在用户点「登录」时弹出。
function registerCompanyAttendanceIpc(ipcMain, getService) {
  const svc = () => { const s = getService(); if (!s) throw new Error('考勤功能没有开启'); return s; };
  const handlers = {
    status: () => svc().status(),
    sync: async () => { await svc().sync({ reason: 'manual' }); return svc().status(); },
    // 打开考勤页：今天还没成功、且允许每天自动取时，开始取一次（不等结果）。
    'ensure-today': () => { const s = svc(); if (s.shouldRun()) void s.sync({ reason: 'open' }).catch(() => {}); return s.status(); },
    login: async () => { const r = await svc().login(); if (r && r.ok) void svc().sync({ reason: 'login' }).catch(() => {}); return r; },
    'set-settings': (request) => ({ ok: true, settings: svc().setSettings(request || {}) }),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('company-attendance:' + name, async (_event, request = {}) => {
      try { return await handler(request); } catch (error) { return { ok: false, error: error.message }; }
    });
  }
}

module.exports = { registerCompanyAttendanceIpc };
