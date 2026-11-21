'use strict';
// E2E-only entry: capture external navigation instead of opening the user's browser.
// No production IPC or production environment switch is added.
const { shell, ipcMain, app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const captured = [];
shell.openExternal = async url => { captured.push(url); };
ipcMain.handle('verification-test:external', () => captured);
ipcMain.handle('verification-test:window', (_event, request = {}) => {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) if (/renderer[\\/]index\.html/.test(win.webContents.getURL())) {
    if (request.resize) win.setContentSize(1440, 900);
    return { bounds: win.getBounds(), focused: win.isFocused(), windows: windows.length };
  }
  return null;
});
ipcMain.handle('verification-test:flush', async () => {
  const { session } = require('electron');
  await session.fromPartition('persist:aiweb-deepseek-main').cookies.flushStore();
  return true;
});
// Record app version without touching global package metadata for a repair build.
app.once('ready', () => fs.writeFileSync(path.join(process.env.CLAUDE_HUB_DATA_DIR, 'verification-runtime.json'),
  JSON.stringify({ chrome: process.versions.chrome, electron: process.versions.electron })));
require(path.join(root, 'main-bootstrap'));
