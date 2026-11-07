'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { extractVisibleCardText } = require(path.join(__dirname, '..', 'renderer', 'visible-card-text.js'));

test('卡片复制保留代码块行首缩进', () => {
  const code = 'def main():\n    for i in range(3):\n        if i:\n            print(i)\n\nmain()';
  const clone = { innerText: code, textContent: code, querySelectorAll: () => [] };
  const doc = { body: { appendChild() {} }, createElement: () => ({ setAttribute() {}, style: {}, appendChild() {}, remove() {} }) };
  const root = { cloneNode: () => clone, ownerDocument: doc, closest: () => null, getBoundingClientRect: () => ({ width: 720 }) };
  const out = extractVisibleCardText(root);
  assert.equal(out, code);
});
