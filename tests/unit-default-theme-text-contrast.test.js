'use strict';
// 默认浅色主题（codex，取 :root 的 --hw-*）的说明文字（2026-11-24 实测 .40 透明度全站只有 2.4:1）：各层浅底上都要 ≥4.5，且 text-2 比 text-3 深。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles', 'hw-tokens.css'), 'utf8');
const root = css.slice(css.indexOf(':root{'), css.indexOf('}', css.indexOf(':root{')));
const token = name => { const m = root.match(new RegExp('--' + name + ':\\s*([^;]+);')); assert.ok(m, name); return m[1].trim(); };
const parse = v => { const m = v.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/); if (m) return [+m[1], +m[2], +m[3], +m[4]]; const h = v.match(/^#([0-9a-fA-F]{6})$/); assert.ok(h, v); return [...h[1].match(/../g).map(x => parseInt(x, 16)), 1]; };
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (fg, bg) => { const a = fg[3], c = fg.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a)); const x = lum(c), y = lum(bg); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('默认浅色主题：说明文字与次要文字在画布、卡片、次级块、输入槽、选中浅底上都 ≥4.5', () => {
  const t2 = parse(token('hw-text-2')), t3 = parse(token('hw-text-3'));
  for (const bgName of ['hw-bg', 'hw-surface', 'hw-surface-2', 'hw-surface-3', 'hw-brand-soft']) {
    const bg = parse(token(bgName));
    assert.ok(ratio(t3, bg) >= 4.5, `text-3 on ${bgName}: ${ratio(t3, bg).toFixed(2)}`);
    assert.ok(ratio(t2, bg) > ratio(t3, bg), `text-2 比 text-3 深 on ${bgName}`);
  }
});
