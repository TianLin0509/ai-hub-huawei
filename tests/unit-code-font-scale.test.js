'use strict';
// 代码块字号跟随正文字号（2026-11-19 反馈：只显示前台对话时代码字号固定、无法缩放）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { applyCardDisplaySettings, codeFontScale } = require('../renderer/card-display-settings.js');
const { DEFAULT_CARD_FONT_SIZE } = require('../core/card-display-config.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok ${name}`); }

function fakeDoc() {
  const vars = {};
  return { vars, documentElement: { style: { setProperty: (k, v) => { vars[k] = v; } } } };
}

test('没调过正文字号时倍率为 1，代码块仍是原来的大小', () => {
  const doc = fakeDoc();
  applyCardDisplaySettings(doc, {});
  assert.strictEqual(doc.vars['--card-code-scale'], '1.000');
  assert.strictEqual(codeFontScale(DEFAULT_CARD_FONT_SIZE), '1.000');
});

test('正文字号调大，代码块倍率同比变大；超范围按上下限截断', () => {
  const doc = fakeDoc();
  applyCardDisplaySettings(doc, { cardFontSize: DEFAULT_CARD_FONT_SIZE + 5 });
  assert.ok(Number(doc.vars['--card-code-scale']) > 1.2);
  applyCardDisplaySettings(doc, { cardFontSize: 999 });
  assert.strictEqual(doc.vars['--card-code-scale'], codeFontScale(22));
});

test('会话卡片和群聊的代码块字号都乘倍率与 Ctrl 缩放（--main-zoom）', () => {
  const card = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles', 'card-view.css'), 'utf8');
  const block = card.match(/\.code-block-wrap pre \{([^}]+)\}/)[1];
  assert.match(block, /font-size:\s*calc\(11\.5px \* var\(--card-code-scale, 1\) \* var\(--main-zoom, 1\)\)/);
  const gc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles', 'meeting-room-chat-flow.css'), 'utf8');
  const gcBlock = gc.match(/\.mr-gc-md pre code \{([^}]+)\}/)[1];
  assert.match(gcBlock, /font-size:\s*calc\(12px \* var\(--card-code-scale, 1\) \* var\(--main-zoom, 1\)\)/);
});

console.log(`unit-code-font-scale: ${passed} passed`);
