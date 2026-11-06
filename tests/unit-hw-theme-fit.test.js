'use strict';
// 新外观 × 6 个主题：业务样式一侧的静态守护（5.5.10，s2）。令牌本身的覆盖由 unit-hw-theme-tokens.test.js（s1）守。
// ① 新外观样式里不再写死品牌蓝 / 品牌红 / 默认主题的面色与字色（一律走 --hw-*，换主题才跟得上）。
// ② 深色主题专用样式 d4-workspace.css 不再作用到新外观接管的元素上（公司外壳下）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = css => [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));

test('new-look stylesheets hold no hard-coded brand blue, brand red or default-palette surfaces', () => {
  const files = ['renderer/styles/hw-mid.css', 'renderer/styles/hw-sweep.css', 'renderer/styles/hw-type.css', 'renderer/styles/hw-shell.css',
    'renderer/styles/ask-aside.css', 'renderer/styles/company-meeting.css', 'renderer/styles/company-assistant-page.css', 'renderer/styles/codeagent-accounts-page.css'];
  for (const f of files) {
    const css = stripComments(read(f));
    assert.doesNotMatch(css, /rgba?\(\s*10\s*,\s*89\s*,\s*247|#0A59F7\b|rgba?\(\s*207\s*,\s*10\s*,\s*44|#CF0A2C\b/i, `${f} hard-codes the default brand colours`);
    assert.doesNotMatch(css, /#(?:F1F3F5|F7F8FA|EDEFF2|182431)\b/i, `${f} hard-codes a default-palette surface or text colour`);
  }
});

test('the dark theme stylesheet leaves the elements the new look owns to the company shell', () => {
  const owned = ['.scene-rail', '#scene-rail', '.rail-', '#new-session-wrapper', '.sidebar-header', '#session-list', '.session-sidebar', '.composer', '.terminal-panel', '.app-toolbar', '.home-'];
  const offenders = [];
  for (const r of rules(read('renderer/styles/d4-workspace.css'))) {
    for (const s of r.sel.split(',')) {
      if (s.includes("[data-theme='dark']") && !s.includes(':not([data-hw-shell])') && owned.some(o => s.includes(o))) offenders.push(s.trim());
    }
  }
  assert.deepEqual(offenders, []);
});

test('text and icons on module tints use --hw-on-tint, which stays white in every theme', () => {
  const files = ['renderer/styles/account-quota-panel.css', 'renderer/styles/codeagent-accounts-page.css'];
  const selectors = ['.qp-av{', '.caa-avatar{', '.caa-hero-icon{', '.caa-auto-ico{'];
  const css = files.map(read).join('\n');
  for (const sel of selectors) {
    const i = css.indexOf(sel); assert.ok(i >= 0, sel);
    assert.match(css.slice(i, css.indexOf('}', i)), /color:\s*var\(--hw-on-tint\)/, sel);
  }
});

test('optional-feature gate, badge and dialog state take the theme accent in the company shell', () => {
  const src = f => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8');
  const gate = src('optional-feature-gate.js');
  assert.match(gate, /:root\[data-hw-shell\] \.of-gate-box button \{[^}]*background: var\(--hw-brand\)[^}]*color: var\(--hw-text-on\)/);
  assert.match(gate, /:root\[data-hw-shell\] \.of-badge b \{ color: var\(--hw-brand\)/);
  // 遮罩和卡片原先引用不存在的 --bg / --surface，深色主题下落到浅色兜底值
  assert.match(gate, /:root\[data-hw-shell\] \.of-gate \{ background: var\(--hw-bg\)/);
  assert.match(gate, /:root\[data-hw-shell\] \.of-gate-box \{ background: var\(--hw-surface\);[^}]*color: var\(--hw-text-1\)/);
  assert.match(src('optional-features.js'), /:root\[data-hw-shell\] \.optional-features-dialog \.of-state\.on \{ color: var\(--hw-brand\)/);
});

test('launch-center submit, shortcut legend and status-strip arrows follow the theme in the company shell', () => {
  const css = f => fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles', f), 'utf8');
  assert.match(css('hw-mid.css'), /:root\[data-hw-shell\] body #new-session-submit \{[^}]*background: var\(--hw-brand\);[^}]*color: var\(--hw-text-on\)/);
  const type = css('hw-type.css');
  assert.match(type, /:root\[data-hw-shell\] \.launch-center-shortcuts,\s*:root\[data-hw-shell\] #sidebar-strip :is\(\.strip-download, \.strip-upload\) \.strip-transfer-label \{ color: var\(--hw-text-2\); font-size: var\(--hw-fs-12\); \}/);
});

test('the meeting stage frame stays dark in the dark themes instead of borrowing the near-white text colour', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles', 'company-meeting.css'), 'utf8');
  assert.match(css, /:root:is\(\[data-theme='dark'\],\[data-theme='frost'\]\) \.meeting-stage:not\(\[data-view=evidence\]\)\{background:var\(--hw-surface-3\)\}/);
});
