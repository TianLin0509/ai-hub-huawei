'use strict';
// 规则页提示条不能挡住后面的按钮（用户反馈：提示挡住按钮、消息发不出去，只能等它消失）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'rules.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'rules.js'), 'utf8');

function rule(selector) {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, `缺少规则 ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

test('提示条点击穿透：出现时下面的发送按钮、开关照样能点', () => {
  assert.match(rule('.rl-toast'), /pointer-events:\s*none/);
});

test('提示条叠放从底部状态栏之上开始，不盖住状态栏按钮', () => {
  const base = Number((js.match(/const TOAST_BOTTOM = (\d+);/) || [])[1]);
  assert.ok(base >= 40, `起始高度 ${base}px 太低`);
  assert.match(js, /TOAST_BOTTOM \+ i \* 52/);
  assert.match(rule('.rl-toast'), new RegExp('bottom:\\s*' + base + 'px'));
});

test('提示内容不丢：仍是可读的状态播报，错误提示比普通提示停留更久', () => {
  assert.match(js, /role: 'status', text: msg/);
  assert.match(js, /bad \? 7000 : 3200/);
});
