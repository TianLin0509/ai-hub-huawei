'use strict';
// 「设置 → 一键反馈」偶尔点了不弹窗（2026-11-21 复现：隔离 Hub 9 次里 4 次）。
// 根因：设置菜单靠 shell-sidebar-terminal.css 的 left/top:50% + transform:translate(-50%,-50%) 居中；
// rail.css 给它的弹入动画 rail-popover-in 也写了 transform，动画期间顶掉居中的 transform，
// 放完（约 160ms）整块菜单才跳到正中（实测位移 122×229px）。这段时间里点菜单项，落点已不在菜单上，
// 菜单被当成「点了外面」关掉，反馈窗口不出来。修法：设置菜单的动画只做淡入，不碰 transform。
// 这里按样式表的层叠顺序找出设置菜单最终用的动画，确认它的关键帧里没有 transform。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STYLES = path.join(__dirname, '..', 'renderer', 'styles');
const read = name => fs.readFileSync(path.join(STYLES, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// 去掉 @media / @supports 块（减少动画等条件样式不算默认效果）和 @keyframes 块，只留顶层规则。
function topLevelRules(css) {
  const rules = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const selector = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    if (!selector.startsWith('@')) rules.push({ selector, body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return rules;
}
function keyframes(css, name) {
  const at = css.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  let depth = 1, j = open + 1;
  while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
  return css.slice(open + 1, j - 1);
}

test('设置菜单靠 transform 居中（前提：动画若再写 transform 就会顶掉居中）', () => {
  const rule = topLevelRules(read('shell-sidebar-terminal.css')).find(r => /(^|,)\s*\.options-menu\s*(,|$)/.test(r.selector) && /left:\s*50%/.test(r.body));
  assert.ok(rule, '居中规则还在');
  assert.match(rule.body, /transform:\s*translate\(-50%,\s*-50%\)/);
});

test('居中的设置菜单解除底边约束，按内容撑开而非只剩半个视口', () => {
  const rules = topLevelRules(read('rail.css')).filter(r => /\.scene-rail\s+\.options-menu/.test(r.selector));
  assert.ok(rules.some(r => /bottom:\s*auto\s*!important/.test(r.body)));
});

test('rail 里设置菜单最终用的弹入动画不改 transform，菜单从第一帧起就在最终位置', () => {
  const css = read('rail.css');
  const rules = topLevelRules(css).filter(r => /\.scene-rail\s+\.options-menu/.test(r.selector) && /animation\s*:/.test(r.body));
  assert.ok(rules.length, 'rail.css 里有给设置菜单的动画');
  const last = rules[rules.length - 1];   // 同等特异度，后写的生效
  const name = last.body.match(/animation\s*:\s*([\w-]+)/)[1];
  assert.notEqual(name, 'none');
  const frames = keyframes(css, name) || keyframes(read('shell-sidebar-terminal.css'), name);
  assert.ok(frames, `找得到关键帧 ${name}`);
  assert.doesNotMatch(frames, /transform/, `设置菜单的动画 ${name} 不能动 transform，否则放完会跳位`);
});
