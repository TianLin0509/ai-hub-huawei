'use strict';
// 11-28 真机透明窗排查：没开过桌宠的用户，启动、更新播报、桌面通知转给桌宠时，都不该建出桌宠窗口（哪怕是空的穿透窗）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

test('全新数据目录（公司版）：桌宠默认关，start / 更新播报 / 通知都不建窗口', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-off-'));
  let windows = 0;
  class FakeWindow extends EventEmitter {
    constructor(o) { super(); windows++; this.bounds = { x: 0, y: 0, width: o.width || 1, height: o.height || 1 }; this.webContents = new EventEmitter(); this.webContents.send = () => {}; }
    isDestroyed() { return false; } getBounds() { return this.bounds; } setBounds(b) { this.bounds = { ...b }; }
    setIgnoreMouseEvents() {} setAlwaysOnTop() {} showInactive() {} focus() {} hide() {} show() {}
    loadFile() { return Promise.resolve(); } isVisible() { return true; } destroy() { this.emit('closed'); }
  }
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const display = { workArea: { x: 0, y: 0, width: 1600, height: 1000 } };
  const { createHubPetController } = require('../main/hub-pet-controller');
  const c = createHubPetController({ BrowserWindow: FakeWindow, BaseWindow: FakeWindow, ipcMain, dataDir: root, company: true,
    assetsDir: path.join(__dirname, '../renderer/assets/hub-pet'), htmlPath: 'fixture.html', preloadPath: 'fixture-preload.js',
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    powerMonitor: { getSystemIdleTime: () => 0 }, watchFullscreen: false, logger: { warn() {}, info() {} },
    sendToRenderer: () => {}, focusPrimaryWindow: () => {} });
  t.after(() => { c.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(c.getSettings().enabled, false, '默认关');
  assert.equal(c.start(), false);
  try { c.announceUpdate('9.9.9'); } catch (_) {}
  try { c.routeDesktopNotice({ title: 't', body: 'b' }); } catch (_) {}
  try { c.notify({ title: 't' }); } catch (_) {}
  assert.equal(windows, 0, '没开桌宠就不建任何窗口');
  assert.equal(c.isActive?.() || false, false);
});
