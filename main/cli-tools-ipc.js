'use strict';
// CLI 一键安装的 IPC（2026-11-07）：界面查状态、点「一键安装」、取消；进度推送 cli-tools:state。
// installer 为 null（发行版没有下载源）时也注册，界面据 available:false 显示原来的手动安装说明。
function registerCliToolsIpc(ipcMain, { installer = null } = {}) {
  const unavailable = () => ({ available: false, busy: null, tools: {}, installed: {}, catalog: null });
  ipcMain.handle('cli-tools:state', () => installer ? installer.snapshot() : unavailable());
  ipcMain.handle('cli-tools:install', async (_event, request = {}) => {
    if (!installer) return { ok: false, error: '这个版本暂不支持一键安装', state: unavailable() };
    try {
      const state = await installer.install(String(request.id || ''));
      const tool = state.tools[request.id] || {};
      return { ok: tool.phase === 'done', error: tool.error || null, state };
    } catch (error) { return { ok: false, error: error.message, state: installer.snapshot() }; }
  });
  ipcMain.handle('cli-tools:cancel', () => installer ? installer.cancel() : unavailable());
}

module.exports = { registerCliToolsIpc };
