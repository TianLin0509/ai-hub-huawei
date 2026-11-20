'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Marked } = require('marked');
const { parseCardMarkdown } = require('../renderer/card-markdown');
const { installCjkEmphasis } = require('../renderer/markdown-cjk-emphasis');

// 用独立实例，不污染其他测试共用的 marked 单例。
const fresh = () => new Marked();
const render = text => parseCardMarkdown(fresh(), text);

test('bold closes when ** sits between Chinese punctuation and a Chinese character', () => {
  // 2026-11-20 截图里的原句：收尾 ** 前是全角标点、后面紧跟汉字。
  const cases = [
    ['**权限：**实测你在主仓级别是 40', '<strong>权限：</strong>实测'],
    ['- **解释上一条的疑点：**它说的是主仓', '<strong>解释上一条的疑点：</strong>它说的'],
    ['📌 **内源贡献值有进展，不用再找任何人。**这是负责人自述。', '<strong>内源贡献值有进展，不用再找任何人。</strong>这是'],
    ['前文**（括号）**后文', '前文<strong>（括号）</strong>后文'],
    ['**「引号」**里', '<strong>「引号」</strong>里'],
    ['两次全会：**TSG#113（马德里）**与会', '<strong>TSG#113（马德里）</strong>与会'],
  ];
  for (const [src, want] of cases) {
    const html = render(src);
    assert(html.includes(want), `${src}\n=> ${html}`);
    assert(!html.includes('**'), `${src}\n=> ${html}`);
  }
});

test('stock marked fails the same input, so the test guards the real bug', () => {
  assert(fresh().parse('**权限：**实测').includes('**权限：**'));
});

test('single *, _ and ~ keep the original rules (stock names, regex, snake_case, approx)', () => {
  const html = render('同行业：*ST精伦、江钨装备、*ST华嵘；正则 每用户.*1.?2|两用户.*尚未；scenes/_history 与 _plan；约~80行（~30行）');
  assert(!html.includes('<em>'), html);
  assert(!html.includes('<del>'), html);
});

test('ordinary Markdown is unchanged', () => {
  const plain = fresh();
  const patched = installCjkEmphasis(fresh());
  for (const src of ['**加粗**正常', '前文**加粗**后文', '**a**b', 'a * b * c', '`**代码**`',
    '***both***', '*em* and **strong**', '2**10 和 3**2']) {
    assert.equal(patched.parse(src), plain.parse(src), src);
  }
});

test('install is idempotent and the global renderer singleton gets it', () => {
  const m = fresh();
  installCjkEmphasis(m);
  installCjkEmphasis(m);
  assert(m.parse('**权限：**实测').includes('<strong>权限：</strong>'));
  const src = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  assert(/installCjkEmphasis\(marked\)/.test(src));
});
