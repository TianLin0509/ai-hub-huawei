'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewOwnsEscape } = require('../renderer/preview-panel-controller.js');

// 最小假节点：closest 按选择器片段匹配 matches 列表
const node = (matches = [], parent = null) => ({
  closest: sel => (matches.some(m => sel.includes(m)) ? {} : (parent ? parent.closest(sel) : null)),
  parent,
});
const panel = { contains: n => n.inPanel === true };

test('A2-07 终端 / 对话框 / 菜单 / 输入框里的 Esc 不归预览', () => {
  for (const m of ['.xterm', 'dialog', '[role="menu"]', '.fm-context-menu', '[contenteditable]', 'input', 'textarea']) {
    assert.equal(previewOwnsEscape(node([m]), panel), false, m);
  }
});

test('A2-07 预览内或无焦点时 Esc 归预览', () => {
  assert.equal(previewOwnsEscape(null, panel), true);
  assert.equal(previewOwnsEscape({ inPanel: true, closest: () => ({}) }, panel), true);
  assert.equal(previewOwnsEscape(node([]), panel), true);
});

test('A2-07 全局 Esc 处理器在放行与全屏条件下才关预览', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'preview-panel-controller.js'), 'utf8');
  assert.match(src, /if \(event\.key !== 'Escape'\) return;\s*if \(!\(outlineState && outlineState\.isFullscreen\) && !previewOwnsEscape\(event\.target, previewPanelEl\)\) return;/);
});
