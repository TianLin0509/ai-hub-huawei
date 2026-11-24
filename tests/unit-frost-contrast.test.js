'use strict';
// 冷杉主题对比度（2026-11-24 反馈：冷杉下字看不清）：次要文字、说明文字和蓝底按钮上的字都要 ≥4.5:1。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// 取最后一个同名块：hw-tokens 里冷杉先和深色共用一块，主题差值写在后面。
const block = (css, selector) => { const at = css.lastIndexOf(selector + ' {'); assert.ok(at >= 0, selector); return css.slice(at, css.indexOf('\n}', at)); };
const hex = (body, name) => { const m = body.match(new RegExp('--' + name + ':\\s*#([0-9a-fA-F]{6})')); assert.ok(m, name); return m[1].match(/../g).map(x => parseInt(x, 16)); };
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a, b, t) => a.map((v, i) => v * t + b[i] * (1 - t));

test('冷杉：次要文字在各层底（含输入槽、选中浅底）上 ≥4.5', () => {
  const frost = block(read('renderer/styles/base.css'), ":root[data-theme='frost']");
  const muted = hex(frost, 'fg-muted'), strong = hex(frost, 'fg-strong'), brand = hex(frost, 'brand'), raised = hex(frost, 'surface-raised');
  const grounds = { canvas: hex(frost, 'surface-canvas'), raised, overlay: hex(frost, 'surface-overlay'), slot: mix(strong, raised, 0.07), selected: mix(brand, raised, 0.14) };
  for (const [name, bg] of Object.entries(grounds)) assert.ok(ratio(muted, bg) >= 4.5, `${name} ${ratio(muted, bg).toFixed(2)}`);
  assert.match(frost, /--cta-fg:\s*var\(--surface-canvas\)/, '蓝渐变按钮上不用白字');
  assert.match(frost, /--turn-meta-fg:\s*var\(--fg-muted\)/);
});

test('冷杉：说明文字不再掺 --fg-faint；蓝底开关上的字跟随主题', () => {
  const tokens = block(read('renderer/styles/hw-tokens.css'), ":root[data-theme='frost']");
  assert.match(tokens, /--hw-text-3:\s*var\(--fg-muted\)/);
  const rules = read('renderer/rules.css');
  assert.match(rules, /\.rl-chip\.on b \{[^}]*color: var\(--hw-text-on/);
  assert.match(rules, /\.rl-seg button\.on \{[^}]*color: var\(--hw-text-on/);
  assert.doesNotMatch(rules, /\.rl-version \{[^}]*--fg-faint/);
});
