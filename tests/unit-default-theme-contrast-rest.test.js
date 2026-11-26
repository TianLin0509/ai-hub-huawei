'use strict';
// 默认浅色主题剩余低对比（2026-11-24 实扫）：搜索页紫灰字、账号页琥珀色提示、两条链接，都要 ≥4.5:1。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const rgb = h => h.match(/[0-9a-fA-F]{2}/g).map(x => parseInt(x, 16));
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(rgb(a)), y = lum(rgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('搜索页浅色面板：次要字在各层浅底上 ≥4.5，零散的紫灰字都改引用它', () => {
  const css = read('renderer/styles/global-session-search.css');
  const muted = css.match(/--text-muted:(#[0-9a-fA-F]{6});/)[1];
  assert.match(css, new RegExp('--fg-muted:' + muted + ';'));
  for (const bg of ['ffffff', 'fbfcfd', 'f8f6fb', 'f1edf7', 'e7eefb', 'eeedf4']) assert.ok(ratio(muted, bg) >= 4.5, `${muted} on #${bg}: ${ratio(muted, bg).toFixed(2)}`);
  for (const sel of ['.session-search-box input::placeholder', '.session-search-chip b', '.session-search-filter-toggle', '.session-search-footer kbd']) {
    const rule = css.slice(css.indexOf(sel + ' {'));
    assert.match(rule, /^[^}]*color:var\(--text-muted\)/, sel);
  }
});

test('默认主题琥珀色作字色 ≥4.5；问问 Hub 与 API key 链接不再偏淡', () => {
  const amber = read('renderer/styles/hw-tokens.css').match(/--hw-amber:\s*(#[0-9a-fA-F]{6});/)[1];
  for (const bg of ['FFFFFF', 'FDF0E3', 'F1F3F5', 'F7F8FA']) assert.ok(ratio(amber, bg) >= 4.5, `${amber} on #${bg}`);
  const community = read('renderer/community.css');
  assert.doesNotMatch(community, /\.community-help-ask \{[^}]*opacity:\.85/);
  // 2026-11-26 主题错配 #13：「用 API key 开始」改跟主题强调色（默认主题 #3065bd），与同行「问问 Hub」一致
  assert.ok(ratio('3065bd', 'f7f8fa') >= 4.5 && community.includes('#api-gateway-start .api-gw-link {border:0 !important; background:none !important; padding:0 2px !important; color:var(--brand) !important;'));
});
