'use strict';

function registerTokenUsageIpc(ipcMain, service) {
  ipcMain.handle('token-usage:state', () => service.state());
  ipcMain.handle('token-usage:sync', () => { void service.sync('manual'); return service.state(); });
}

module.exports = { registerTokenUsageIpc };
