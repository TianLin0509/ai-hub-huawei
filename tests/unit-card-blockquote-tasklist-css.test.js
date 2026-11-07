'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles', 'card-view.css'), 'utf8');
const base = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles', 'base.css'), 'utf8');

function rule(selector) {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, `缺少规则 ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

test('A2-20 卡片引用块有左竖线和次要文字色，颜色走主题变量', () => {
  const block = rule('.msg-overlay .turn-body blockquote');
  assert.match(block, /border-left:\s*3px solid var\(--border-mid\)/);
  assert.match(block, /color:\s*var\(--fg-muted\)/);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(block), '不应写死颜色');
});

test('A2-20 任务列表项去掉圆点', () => {
  assert.match(rule('.msg-overlay .turn-body li:has(> input[type="checkbox"])'), /list-style:\s*none/);
});

test('A2-20 所用主题变量在 6 个主题里都有定义', () => {
  for (const name of ['--border-mid', '--fg-muted']) {
    const defined = base.split('\n').filter(line => line.trim().startsWith(name + ':')).length;
    assert.ok(defined >= 6, name);
  }
});
