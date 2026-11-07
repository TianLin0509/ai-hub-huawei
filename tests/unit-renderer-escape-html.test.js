'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function loadEscapeHtml() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const m = src.match(/\nfunction escapeHtml\(text\) \{[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(m, 'renderer.js 中找不到 escapeHtml');
  return new Function(`${m[0]}; return escapeHtml;`)();
}

test('escapeHtml 转义 & < > " \' 五个字符', () => {
  const esc = loadEscapeHtml();
  assert.equal(esc(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&#39;f');
});

test('escapeHtml 对 null/undefined 返回空串，数字照常转字符串', () => {
  const esc = loadEscapeHtml();
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
});

test('属性注入载荷被中和', () => {
  const esc = loadEscapeHtml();
  const out = `<span data-path="${esc('D:\\work\\a"onmouseover="alert(1)')}">`;
  assert.ok(!/"\s*onmouseover=/.test(out));
});
