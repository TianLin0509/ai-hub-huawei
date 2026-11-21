'use strict';
// 开场动画（2026-11-22）的主进程入口：偏好、启动时播哪一套、目录与下载。下载源标识与 boot-splash.js download() 查内源的
// 版本名、文件名一致（boot-splash-<包版本>）。隔离测试实例（CLAUDE_HUB_DATA_DIR）默认不播，免得盖住界面挡住自动化点击；
// 要测开场动画本身的用例设 AI_HUB_BOOT_SPLASH=1。
const { createBootSplashStore } = require('../../core/boot-splash');

function registerBootSplashIpc(ipcMain, { dataDir, sendToRenderer = () => {}, env = process.env, isolated = false, electron = require('electron') }) {
  const sources = env.AI_HUB_BOOT_SPLASH_SOURCES ? JSON.parse(env.AI_HUB_BOOT_SPLASH_SOURCES) : undefined;
  const store = createBootSplashStore({ dataDir, ...(sources ? { sources } : {}), fetchImpl: (...args) => electron.net.fetch(...args), emit: sendToRenderer });
  let catalogTried = false;
  require('../../core/app-update/download-points').register('boot-splash', async () => {
    let catalog = store.catalog;
    if (!catalog && !catalogTried) { catalogTried = true; try { await store.check(); } catch (_) {} catalog = store.catalog; }
    const packs = catalog && Array.isArray(catalog.packs) ? catalog.packs : [];
    return packs.length ? { items: packs.map(p => ({ file: p.file, release: `boot-splash-${p.version}`, version: p.version })) } : null;
  });
  const enabled = !isolated || env.AI_HUB_BOOT_SPLASH === '1';
  ipcMain.handle('boot-splash:startup', () => (enabled ? store.startup() : null));
  ipcMain.handle('boot-splash:get', () => store.snapshot());
  ipcMain.handle('boot-splash:save', (_e, prefs) => store.savePreferences(prefs));
  ipcMain.handle('boot-splash:check', () => store.check());
  ipcMain.handle('boot-splash:download', (_e, id) => store.download(String(id || '')));
  ipcMain.handle('boot-splash:cancel', () => store.cancel());
  return store;
}
module.exports = { registerBootSplashIpc };
