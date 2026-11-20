'use strict';
// 历史会话页（昨日之我）在深色两套皮肤下跟随宿主主题；归档页签不被「最近 7 天」筛空（rsi-g，5.6.65 反馈）。
// 实际观感由 tests/capture-history-theme-cdp.js 在隔离 Hub 里拍图并统计对比度。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { filterSearchEntries, timeRangeForScope } = require('../renderer/global-session-search.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer/styles/global-session-search.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].replace(/\s+/g, ' ').trim(), body: m[2] }));
const darkRules = rules.filter(r => r.sel.includes("[data-theme='dark']") && r.sel.includes("[data-theme='frost']"));

test('switching the history page to the archive or pinned tab drops the time window', () => {
  assert.equal(timeRangeForScope('dormant', '7d'), 'all');
  assert.equal(timeRangeForScope('pinned', '24h'), 'all');
  assert.equal(timeRangeForScope('user', '7d'), '7d');
  assert.equal(timeRangeForScope('all', '3d'), '3d');
  const now = Date.UTC(2026, 10, 20);
  const old = { title: '两周前归档的会话', archived: true, updatedAt: now - 14 * 86400000, provider: 'claude' };
  assert.equal(filterSearchEntries([old], { scope: 'dormant', timeRange: '7d', now }).length, 0, 'the 7-day window hides older archives');
  assert.equal(filterSearchEntries([old], { scope: 'dormant', timeRange: timeRangeForScope('dormant', '7d'), now }).length, 1);
});

test('dark and frost hand the overlay colour variables back to the host theme', () => {
  const root = darkRules.find(r => /\.session-search-overlay$/.test(r.sel));
  assert.ok(root, 'dark/frost overlay rule exists');
  for (const v of ['--fg-default', '--fg-muted', '--fg-strong', '--text-primary', '--bg-secondary', '--border']) {
    assert.match(root.body, new RegExp(`${v}\\s*:\\s*inherit`), `${v} follows the host theme`);
  }
  assert.match(root.body, /color-scheme\s*:\s*dark/);
});

test('dark and frost repaint the white list, toolbar and reader surfaces', () => {
  const surfaces = darkRules.filter(r => /background\s*:\s*var\(--surface-raised\)/.test(r.body)).map(r => r.sel).join(' ');
  for (const cls of ['.session-search-command', '.session-search-result', '.session-search-reader-sheet', '.session-search-toolbar', '.session-search-footer']) {
    assert.ok(surfaces.includes(cls), `${cls} uses the host raised surface in dark themes`);
  }
  const strong = darkRules.filter(r => /(^|;)\s*color\s*:\s*var\(--fg-strong\)/.test(r.body)).map(r => r.sel).join(' ');
  for (const cls of ['.session-search-result-title', '.session-search-preview-heading h3', '.session-search-native-card .turn-body']) {
    assert.ok(strong.includes(cls), `${cls} uses the host strong text colour in dark themes`);
  }
});
