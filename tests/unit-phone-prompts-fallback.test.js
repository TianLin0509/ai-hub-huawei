'use strict';
// 公司版关掉助理服务时，会话卡片取「手机发过的原文」的 IPC 也要有答复（2026-11-28 黄区真机：每开一个会话主进程报一次 No handler registered）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('助理服务没起时注册空的 assistant:phone-session-prompts', () => {
  const gate = main.indexOf(['if (require(', "'./core/distribution'", ").featureEnabled('assistant')) try {"].join(''));
  const fallback = main.indexOf("if (!phoneService) {");
  assert.ok(gate > 0, '找不到助理服务的发行开关');
  assert.ok(fallback > gate, '空答复必须在助理服务注册之后判断');
  const block = main.slice(fallback, fallback + 300);
  assert.match(block, /ipcMain\.handle\('assistant:phone-session-prompts', \(\) => \[\]\)/);
});

test('渲染端取不到时照常继续（有 catch）', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = renderer.indexOf("ipcRenderer.invoke('assistant:phone-session-prompts'");
  assert.ok(at > 0);
  assert.match(renderer.slice(at, at + 200), /catch \(err\)/);
});
