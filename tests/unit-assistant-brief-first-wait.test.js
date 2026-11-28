'use strict';
// 今日摘要首次生成要先读 WeLink（11-28 真机约 6.5 分钟）：等待期间「今天」栏说清楚在做什么、大约多久，而不是一直写「还没生成」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const page = require('../renderer/company-assistant-page');

test('生成中显示首次读 WeLink 的等待说明，不再显示「还没生成」和「现在生成」按钮', () => {
  const html = page.noBriefHtml({ running: true });
  assert.match(html, /首次整理要读 WeLink，约几分钟/);
  assert.doesNotMatch(html, /还没生成|data-ca="brief-now"/);
});

test('没在生成时照旧给「现在生成」按钮', () => {
  const html = page.noBriefHtml();
  assert.match(html, /今天的摘要还没生成/);
  assert.match(html, /data-ca="brief-now"/);
});

test('点「现在生成」和打开页面自动生成都走同一个带等待说明的入口', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-assistant-page.js'), 'utf8');
  assert.equal((src.match(/call\('brief-now'\)/g) || []).length, 1, 'brief-now 只在 generateBrief 里调用');
  assert.equal((src.match(/await generateBrief\(\)/g) || []).length, 2);
});
