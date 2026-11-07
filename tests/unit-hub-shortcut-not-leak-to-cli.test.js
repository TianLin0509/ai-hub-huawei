'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { createKeyboardShortcuts } = require(path.join(ROOT, 'renderer', 'keyboard-shortcuts.js'));

test('Hub 全局快捷键对 Ctrl+3 / Ctrl+K 等会 preventDefault', () => {
  const sessions = new Map(['A', 'B', 'C'].map((id, i) => [id, { id, kind: 'codeagent', lastMessageTime: 100 - i }]));
  const fakeDoc = { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} };
  const sc = createKeyboardShortcuts({ document: fakeDoc, ipcRenderer: {}, clipboard: {}, sessions, terminalCache: new Map(),
    getActiveSessionId: () => 'A', getCurrentFontSize: () => 14, selectSession() {}, escapeToHome() {}, toggleSidebar() {},
    openTerminalSearch() {}, openPreviewQuickOpen() {}, setFontSize() {}, closeSession() {}, createWorkspaceSession() {}, copyText() {} });
  for (const [key, keyCode] of [['3', 51], ['b', 66], ['f', 70]]) {
    let prevented = false;
    try {
      sc.handleKeydown({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key, keyCode, target: { closest: () => null },
        preventDefault() { prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} });
    } catch { /* 部分动作依赖真实 DOM */ }
    assert.equal(prevented, true, `Ctrl+${key} 应被 Hub 接管`);
  }
});

test('终端按键处理器对已 preventDefault 的按键返回 false，不再写入 CLI', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  const i = src.indexOf('terminal.attachCustomKeyEventHandler((e) => {');
  assert.ok(i > 0);
  const head = src.slice(i, i + 700);
  assert.match(head, /if \(e\.type !== 'keydown'\) return true;\s*(\/\/[^\n]*\n\s*)?if \(e\.defaultPrevented\) return false;/);
});
