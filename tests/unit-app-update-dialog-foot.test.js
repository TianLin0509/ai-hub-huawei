'use strict';
// 更新窗按钮栏常驻（2026-11-21）：发布说明很长时「下载更新」曾被挤出视口。真实界面验证见 tests/e2e-update-dialog-foot-cdp.js；
// 这里守住两条关键样式与折叠逻辑，防止有人把滚动改回整窗、或去掉折叠。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app-update.js'), 'utf8');

test('弹窗整体不滚动，只有说明区滚动，按钮栏固定且有底色', () => {
  assert.match(src, /\.app-update-dialog \{[^}]*overflow: hidden;/);
  assert.match(src, /\.app-update-dialog\[open\] \{ display: flex; flex-direction: column; \}/);
  assert.match(src, /\.app-update-dialog > \.au-body \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(src, /\.app-update-dialog > \.au-head, \.app-update-dialog > \.au-foot \{ flex: none; \}/);
  assert.match(src, /\.au-foot \{[^}]*background: var\(--surface-raised/);
});

test('发布说明默认只列前 5 条，其余折叠成「还有 N 条更新 · 展开」', () => {
  assert.match(src, /const NOTES_SHOWN = 5;/);
  assert.match(src, /还有 \$\{rest\} 条更新 · 展开/);
  assert.match(src, /本次更新<\/div>\$\{notesHtml\(latest\)\}/);
});
