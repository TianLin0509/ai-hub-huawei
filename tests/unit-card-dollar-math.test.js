'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { convertInlineDollars } = require('../renderer/card-math-dollars.js');

test('A2-12 成对的 $ 不被当公式', () => {
  for (const text of ['这台服务器 $5 一个月，那台 $10 一个月', '$env:HOME 和 $env:PATH 都要设置', 'echo $HOME/$USER', 'cost is $5 and $x', '价格 $ 5 和 $ 6']) {
    assert.equal(convertInlineDollars(text), text, text);
  }
});

test('A2-12 保留 $x$ 这类行内公式，改写成 \\(x\\)', () => {
  assert.equal(convertInlineDollars('设 $x$ 为实数'), '设 \\(x\\) 为实数');
  assert.equal(convertInlineDollars('能量 $E = mc^2$，质量 $m$。'), '能量 \\(E = mc^2\\)，质量 \\(m\\)。');
  assert.equal(convertInlineDollars('令$\\alpha+\\beta$成立'), '令\\(\\alpha+\\beta\\)成立');
});

test('A2-12 $$ 块公式和转义的 \\$ 保持原样', () => {
  assert.equal(convertInlineDollars('$$a+b$$'), '$$a+b$$');
  assert.equal(convertInlineDollars('价格 \\$5 和 \\$x\\$'), '价格 \\$5 和 \\$x\\$');
});

test('A2-12 单 $ 分隔符已移除，用户卡不做公式', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'turn-card-renderer.js'), 'utf8');
  assert.ok(!/\{ left: '\$', right: '\$'/.test(src));
  assert.match(src, /cardEl\.classList\?\.contains\('user'\)\) return false/);
  assert.match(src, /convertInlineDollarsIn\(body\)/);
});
