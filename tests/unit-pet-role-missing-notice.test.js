'use strict';
// 桌宠「设成没下载的形象静默不生效」（11-28 真机 O-09）：主进程不换没装上的形象时，告诉设置页原因和下一步，不当成保存成功。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { saveFailureText } = require('../renderer/hub-pet/pet-save-status');

function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-role-missing-'));
  class FakeWindow extends EventEmitter {
    constructor(o) { super(); this.bounds = { x: 0, y: 0, width: o.width, height: o.height }; this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.send = () => {}; }
    isDestroyed() { return this.destroyed; } getBounds() { return this.bounds; } setBounds(b) { this.bounds = { ...b }; }
    setIgnoreMouseEvents() {} setAlwaysOnTop() {} showInactive() {} focus() {} hide() {} show() {}
    loadFile() { return Promise.resolve(); } isVisible() { return true; } destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const handlers = {};
  const ipcMain = new EventEmitter(); ipcMain.handle = (ch, fn) => { handlers[ch] = fn; }; ipcMain.removeHandler = () => {};
  const main = { webContents: {}, isDestroyed: () => false };
  const display = { workArea: { x: 0, y: 0, width: 1600, height: 1000 } };
  const { createHubPetController } = require('../main/hub-pet-controller');
  const c = createHubPetController({ BrowserWindow: FakeWindow, ipcMain, dataDir: root,
    assetsDir: path.join(__dirname, '../renderer/assets/hub-pet'), htmlPath: 'fixture.html', preloadPath: 'fixture-preload.js',
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    powerMonitor: { getSystemIdleTime: () => 0 }, watchFullscreen: false, logger: { warn() {}, info() {} },
    sendToRenderer: () => {}, focusPrimaryWindow: () => {}, getMainWindow: () => main });
  t.after(() => { c.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { set: patch => handlers['hub-pet:set-settings']({ sender: main.webContents }, patch) };
}

test('设成没下载的形象：形象不换，返回 roleMissing，设置页写出原因和「下载」这一步', t => {
  const r = rig(t);
  const res = r.set({ role: '07-shiba' });
  assert.equal(res.settings.role, '01-cat', '没装上的形象不换');
  assert.equal(res.roleMissing.id, '07-shiba');
  const text = saveFailureText(res, null);
  assert.match(text, /还没下载，形象没换/);
  assert.match(text, /点它旁边的「下载」，下好会自动换上/);
});

test('换成已装好的形象照常生效，不带提示', t => {
  const r = rig(t);
  const res = r.set({ role: '03-penguin' });
  assert.equal(res.settings.role, '03-penguin');
  assert.equal(res.roleMissing, undefined);
  assert.equal(saveFailureText(res, null), '');
});
