'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrayController } = require('../main/tray-controller');

function harness(enabled = true) {
  const state = { enabled, trays: [], focused: 0, quits: 0 };
  class Tray {
    constructor() { this.handlers = {}; this.destroyed = false; this.balloons = 0; state.trays.push(this); }
    setToolTip(t) { this.tip = t; }
    setContextMenu(m) { this.menu = m; }
    on(name, fn) { this.handlers[name] = fn; }
    displayBalloon() { this.balloons += 1; }
    destroy() { this.destroyed = true; }
  }
  const Menu = { buildFromTemplate: items => items };
  const win = { visible: true, destroyed: false, isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, hide() { this.visible = false; } };
  const ctl = createTrayController({
    Tray, Menu, getIcon: () => ({}), getMainWindow: () => win,
    focusWindow: () => { state.focused += 1; win.visible = true; },
    quit: () => { state.quits += 1; }, isEnabled: () => state.enabled, logger: { warn() {} },
  });
  return { state, win, ctl };
}
const closeEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

test('开关关着：关窗口照常退出，不建托盘', () => {
  const { state, ctl } = harness(false);
  const ev = closeEvent();
  assert.equal(ctl.interceptClose(ev), false);
  assert.equal(ev.prevented, false);
  assert.equal(state.trays.length, 0);
});

test('开关开着：关窗口只藏起来，单击托盘叫回，只提示一次', () => {
  const { state, win, ctl } = harness(true);
  const ev = closeEvent();
  assert.equal(ctl.interceptClose(ev), true);
  assert.equal(ev.prevented, true);
  assert.equal(win.visible, false);
  const tray = state.trays[0];
  tray.handlers.click();
  assert.equal(win.visible, true);
  ctl.interceptClose(closeEvent());
  assert.equal(tray.balloons, 1);
  assert.equal(state.trays.length, 1);
});

test('托盘菜单「退出」后关窗口不再拦截', () => {
  const { state, ctl } = harness(true);
  ctl.sync();
  const quitItem = state.trays[0].menu.find(i => /退出/.test(i.label || ''));
  quitItem.click();
  assert.equal(state.quits, 1);
  assert.equal(ctl.interceptClose(closeEvent()), false);
  ctl.resetQuitting();
  assert.equal(ctl.interceptClose(closeEvent()), true);
});

test('关掉开关时窗口藏着就先叫回来，再收起托盘图标', () => {
  const { state, win, ctl } = harness(true);
  ctl.interceptClose(closeEvent());
  state.enabled = false;
  ctl.sync();
  assert.equal(win.visible, true);
  assert.equal(state.trays[0].destroyed, true);
  assert.equal(ctl.active, false);
});
