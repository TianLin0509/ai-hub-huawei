'use strict';
// 公司版新外观（--hw-*）要跟随全部 6 个主题：每个主题下把令牌按真实层叠解析成颜色，
// 检查① 主要文字在面板/画布上的对比度够读；② 深色主题里不会留下浅色底（反之亦然）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { THEMES } = require('../core/theme-config');

const STYLES = path.join(__dirname, '..', 'renderer', 'styles');
const read = f => fs.readFileSync(path.join(STYLES, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// 取出「只由 :root / :root[data-theme=...] 组成的选择器」的块里的自定义属性声明，按源码顺序。
function tokenBlocks(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sels = m[1].split(',').map(s => s.trim()).filter(Boolean);
    if (!sels.every(s => /^:root(\[data-theme='[a-z]+'\])?$/.test(s))) continue;
    const decls = {};
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) decls[d[1]] = d[2].trim();
    out.push({ sels, decls });
  }
  return out;
}

// 按 index.html 的层叠：同一主题下 :root[data-theme] (0,2,0) 压过 :root (0,1,0)，同级按文件先后、块先后。
const FILES = ['base.css', 'hw-tokens.css', 'd4-workspace.css'];
function tokensFor(theme) {
  const blocks = FILES.flatMap(f => tokenBlocks(read(f)));
  const vars = {};
  for (const spec of [0, 1]) {
    for (const b of blocks) {
      const hit = b.sels.some(s => (spec === 0 ? s === ':root' : s === `:root[data-theme='${theme}']`));
      if (hit) Object.assign(vars, b.decls);
    }
  }
  return vars;
}

function parseColor(str, vars, depth = 0) {
  if (depth > 20) throw Error('var loop: ' + str);
  str = str.trim();
  const v = str.match(/^var\((--[\w-]+)(?:\s*,\s*(.+))?\)$/);
  if (v) {
    if (vars[v[1]] != null) return parseColor(vars[v[1]], vars, depth + 1);
    if (v[2]) return parseColor(v[2], vars, depth + 1);
    throw Error('undefined ' + v[1]);
  }
  const expanded = str.replace(/var\((--[\w-]+)\)/g, (_, n) => { if (vars[n] == null) throw Error('undefined ' + n); return vars[n]; });
  if (expanded !== str) return parseColor(expanded, vars, depth + 1);
  let h = str.match(/^#([0-9a-f]{3,8})$/i);
  if (h) {
    let x = h[1];
    if (x.length <= 4) x = [...x].map(c => c + c).join('');
    const n = [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16));
    return { r: n[0], g: n[1], b: n[2], a: x.length === 8 ? parseInt(x.slice(6), 16) / 255 : 1 };
  }
  const rgb = str.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const p = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  }
  const mix = str.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+)\)$/);
  if (mix) {
    const a = parseColor(mix[1], vars, depth + 1), b = parseColor(mix[3], vars, depth + 1), t = Number(mix[2]) / 100;
    const k = c => a[c] * t + b[c] * (1 - t);
    return { r: k('r'), g: k('g'), b: k('b'), a: k('a') };
  }
  throw Error('unparsed colour: ' + str);
}
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const IDS = THEMES.map(t => t.id);

test('the theme list still has the six themes the new look must follow', () => {
  assert.deepEqual([...IDS].sort(), ['claude', 'codex', 'dark', 'frost', 'hub', 'slate']);
});

for (const theme of IDS) {
  test(`theme ${theme}: new-look surfaces sit on the same side (light/dark) as the theme canvas`, () => {
    const vars = tokensFor(theme);
    const canvas = parseColor('var(--surface-canvas)', vars);
    const darkTheme = lum(canvas) < 0.2;
    for (const name of ['--hw-bg', '--hw-surface', '--hw-surface-2', '--hw-surface-3']) {
      const c = over(parseColor(`var(${name})`, vars), canvas);
      assert.equal(lum(c) < 0.2, darkTheme, `${theme} ${name} is ${darkTheme ? 'light on a dark theme' : 'dark on a light theme'}`);
    }
  });

  test(`theme ${theme}: body and secondary text stay readable (>= 4.5) on every new-look surface`, () => {
    const vars = tokensFor(theme);
    const canvas = parseColor('var(--surface-canvas)', vars);
    // surface-3 是输入槽和分段控件底，未选中的分段按钮、标签用 text-2 写在上面
    for (const surf of ['--hw-bg', '--hw-surface', '--hw-surface-2', '--hw-surface-3']) {
      const bg = over(parseColor(`var(${surf})`, vars), canvas);
      for (const fg of ['--hw-text-1', '--hw-text-2']) {
        const r = ratio(over(parseColor(`var(${fg})`, vars), bg), bg);
        assert.ok(r >= 4.5, `${theme} ${fg} on ${surf} = ${r.toFixed(2)}`);
      }
      if (surf === '--hw-surface-3') continue; // 选中浅底不会叠在输入槽上
      // 当前页名字用品牌色写在选中底上
      const sel = over(parseColor('var(--hw-brand-soft)', vars), bg);
      const r = ratio(over(parseColor('var(--hw-brand)', vars), sel), sel);
      // 左栏当前页名、标签、链接都是 12–13px 的品牌色字写在选中浅底上，按正文要求 4.5
      assert.ok(r >= 4.5, `${theme} brand text on brand-soft over ${surf} = ${r.toFixed(2)}`);
    }
  });
}

// 新外观的样式文件不写颜色值，一律 var(--hw-*)（s2 5.5.10 加入 hw-mid / hw-sweep / hw-type / 问一下 / 助理页）。
for (const file of ['hw-shell.css', 'hw-mid.css', 'hw-sweep.css', 'hw-type.css', 'ask-aside.css', 'company-assistant-page.css']) {
  test(`${file} carries no fixed colour values`, () => {
    const hits = read(file).match(/#[0-9a-f]{3,8}\b|rgba?\(\s*\d/gi) || [];
    assert.deepEqual(hits, []);
  });
}

test('outside the default theme the new look takes each theme\'s own accent and canvas instead of the fixed blue', () => {
  for (const theme of IDS.filter(id => id !== 'codex')) {
    const vars = tokensFor(theme);
    const same = (a, b) => JSON.stringify(parseColor(`var(${a})`, vars)) === JSON.stringify(parseColor(`var(${b})`, vars));
    // claude 的陶土色上白字不够 4.5，用本主题自己深一档的 --brand-hover
    assert.ok(same('--hw-brand', '--brand') || (['claude', 'slate'].includes(theme) && same('--hw-brand', '--brand-hover')), `${theme} --hw-brand`);
    assert.ok(same('--hw-text-1', '--fg-strong'), `${theme} --hw-text-1`);
  }
});

for (const theme of IDS) {
  test(`theme ${theme}: button text reads on the accent and module-colour tiles keep white marks`, () => {
    const vars = tokensFor(theme);
    const brand = parseColor('var(--hw-brand)', vars);
    const r = ratio(parseColor('var(--hw-text-on)', vars), brand);
    assert.ok(r >= 4.5, `${theme} --hw-text-on on --hw-brand = ${r.toFixed(2)}`);
    const onTint = parseColor('var(--hw-on-tint)', vars);
    for (const tint of ['chat', 'assist', 'meet', 'room', 'forum', 'acct']) {
      const t = ratio(onTint, parseColor(`var(--hw-tint-${tint})`, vars));
      assert.ok(t >= 3, `${theme} --hw-on-tint on --hw-tint-${tint} = ${t.toFixed(2)}`);
    }
  });
}

test('the current rail tile draws its icon with the module-colour ink, not the theme button ink', () => {
  const css = read('hw-shell.css');
  const rule = css.match(/\.rail-group-trigger\.rail-group-current\) \.btn-icon \{([^}]*)\}/);
  assert.ok(rule, 'current tile rule');
  assert.match(rule[1], /color:\s*var\(--hw-on-tint\)/);
});

test('the rail theme menu writes its description lines and selected tick with new-look tokens', () => {
  const css = read('hw-shell.css');
  assert.match(css, /\.theme-menu :is\(\.options-theme-copy small, \.options-theme-note\) \{ font-size: var\(--hw-fs-12\); color: var\(--hw-text-2\); \}/);
  assert.match(css, /\.theme-menu \.options-theme-check \{ color: var\(--hw-brand\); \}/);
});
