'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDesktopNotificationController } = require('../main/desktop-notification-controller');

function rig(options = {}) {
  const windows = [];
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.webContents = new EventEmitter(); this.sent = []; this.shows = 0; this.webContents.send = (_, payload) => this.sent.push(payload); }
    setAlwaysOnTop() {}
    setBounds() {}
    isDestroyed() { return !!this.dead; }
    loadFile() { queueMicrotask(() => this.webContents.emit('did-finish-load')); }
    hide() { this.hidden = true; }
    destroy() { this.dead = true; this.emit('closed'); }
    showInactive() { this.shows++; }
  }
  let clock = 1000;
  const controller = createDesktopNotificationController({ BrowserWindow: Window, ipcMain: new EventEmitter(),
    waitForPaint: async () => {}, setTimeoutFn: () => 1, clearTimeoutFn: () => {}, now: () => clock, ...options });
  return { controller, windows, advance: ms => { clock += ms; } };
}
const payload = { sessionId: 'session-1', title: 'Done', body: 'Result', completedAt: 123 };

test('同一回合并发/重载后重复投递只显示一次；新回合和其他会话照常显示', async () => {
  const r = rig();
  await Promise.all([r.controller.show(payload), r.controller.show(payload)]);
  await r.controller.show(payload);
  assert.equal(r.windows[0].shows, 1);
  await r.controller.show({ ...payload, completedAt: 124 });
  await r.controller.show({ ...payload, sessionId: 'session-2' });
  assert.equal(r.windows[0].shows, 3);
  r.controller.dispose();
});

test('桌宠路由前统一去重；无事件时间的重复提醒在短时间内不刷屏', async () => {
  const routed = [], r = rig({ route: p => { routed.push(p); return true; } });
  const reminder = { sessionId: 'bridge', title: 'Message', body: 'Received' };
  await r.controller.show(reminder); r.advance(100);
  await r.controller.show(reminder);
  assert.equal(routed.length, 1);
  r.advance(16000); await r.controller.show(reminder);
  assert.equal(routed.length, 2);
  assert.equal(r.windows.length, 0);
  r.controller.dispose();
});

test('禁止显示时不创建窗口、不路由桌宠，恢复后可正常提醒', async () => {
  let enabled = false, routed = 0;
  const r = rig({ canShow: () => enabled, route: () => { routed++; return false; } });
  assert.equal(await r.controller.show(payload), false);
  assert.equal(r.windows.length, 0); assert.equal(routed, 0);
  enabled = true; await r.controller.show(payload);
  assert.equal(r.windows[0].shows, 1);
  r.controller.dispose();
});

test('显示等待期间关闭/撤回提醒后，旧的异步请求不会重新弹出', async () => {
  let paint;
  const r = rig({ waitForPaint: () => new Promise(resolve => { paint = resolve; }) });
  const showing = r.controller.show(payload);
  await new Promise(resolve => setImmediate(resolve));
  r.controller.hide(); paint(); await showing;
  assert.equal(r.windows[0].shows, 0);
  r.controller.dispose();
});
