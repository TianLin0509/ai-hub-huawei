'use strict';
// 顶部常驻概览条（来源 de959e5e 只借界面，数据用在跑一览）：只放「等你」「卡住」两个数，0 的不画，都为 0 时整条不显示；
// 不放「刚完成」（和「待你看」重复）；「在跑」只进悬停提示；收起后只剩「一览」和合计。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { stripHtml } = require('../renderer/overview-strip');

test('expanded strip shows only non-zero waiting and stuck counts', () => {
  const h = stripHtml({ counts: { waiting: 2, suspect: 1, running: 9, done: 4 } }, false);
  assert.match(h, /ov-strip-waiting[^>]*>等你<b>2<\/b>/);
  assert.match(h, /ov-strip-suspect[^>]*>卡住<b>1<\/b>/);
  assert.doesNotMatch(h, /刚完成|>在跑</);
  assert.match(h, /在跑 9 个/, '在跑数写进悬停提示');
  assert.match(h, /data-strip-fold="1"/);
  assert.doesNotMatch(stripHtml({ counts: { waiting: 0, suspect: 3, running: 1 } }, false), /等你/);
});

test('nothing to act on hides the whole strip; collapsed strip shows the total', () => {
  assert.equal(stripHtml({ counts: { waiting: 0, suspect: 0, running: 5, done: 7 } }, false), '');
  assert.equal(stripHtml(null, false), '');
  assert.equal(stripHtml({ counts: { running: 5 } }, true), '');
  const c = stripHtml({ counts: { waiting: 1, suspect: 2, running: 5 } }, true);
  assert.match(c, />一览<i class="ov-strip-dot hot">3<\/i>/);
  assert.match(c, /data-strip-fold="0"/);
  assert.doesNotMatch(c, /等你|卡住/);
});

test('strip reads the running overview over IPC and opens the existing dialog; mounted with the sidebar', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/overview-strip.js'), 'utf8');
  assert.match(src, /invoke\('running-overview:get'\)/);
  assert.match(src, /__runningOverview\?\.open\(\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '../renderer/session-list-renderer.js'), 'utf8'), /require\('\.\/overview-strip\.js'\)\.mountOverviewStripUi\(window\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '../renderer/running-overview.css'), 'utf8'), /\.ov-strip\[hidden\] \{ display: none; \}/);
});
