'use strict';
// 分身页跟随主题（2026-11-24 反馈：深色主题下分身页仍是白底）：样式只引用 --hw-* 变量，不写颜色值、不写主题分支。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('分身页样式不写死颜色，全部转引 hw-tokens', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles', 'avatar-page.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], '不出现 #rrggbb 颜色值');
  assert.doesNotMatch(css, /rgba?\(\s*(?:2[0-5]\d|1\d\d)\s*,/, '不出现浅色 rgb 值');
  assert.doesNotMatch(css, /\[data-theme/, '不写主题分支，换主题只在 hw-tokens.css');
  assert.match(css, /\.avatar-page\{[^}]*background:var\(--hw-bg\)/);
  // 填充色上的字用面板色：浅色主题即白字，深色主题即深字；深色下白字在浅红、浅绿底上只有 1.7–2.7:1（2026-11-24 实测）。
  for (const sel of ['.avx-st.now i', '.avx-st.ok i', '.avx-btn.dd', '.avx-row .n b']) {
    const rule = css.slice(css.indexOf(sel + '{'));
    assert.ok(css.includes(sel + '{') && /^[^}]*color:var\(--hw-surface\)/.test(rule), sel);
  }
});
