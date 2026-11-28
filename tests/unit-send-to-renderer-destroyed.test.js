'use strict';
// 关 Hub 时界面进程先销毁：sendToRenderer 不能再抛「Object has been destroyed」打断调用方（2026-11-28 黄区真机）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('sendToRenderer 先看 webContents 是否已销毁，且吞掉销毁类错误', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const at = main.indexOf('function sendToRenderer(channel, data) {');
  assert.ok(at > 0);
  const body = main.slice(at, at + 1200);
  assert.match(body, /!mainWindow\.webContents\.isDestroyed\(\)/);
  assert.match(body, /catch \(error\) \{ if \(!\/destroyed\/i\.test/);
});
