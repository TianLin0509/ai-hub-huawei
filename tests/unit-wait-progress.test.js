'use strict';
// 2026-11-06 用户：各功能等 CodeAgent 时都显示「在哪一步 · 已等多少秒 · 通常多久」，按需开会话、不预开。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../renderer/wait-progress.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('秒数格式：秒、分秒、小时', () => {
  assert.equal(w.secondsText(12_400), '12 秒');
  assert.equal(w.secondsText(80_000), '1 分 20 秒');
  assert.equal(w.secondsText(3_725_000), '1 小时 2 分');
  assert.equal(w.secondsText(-5), '0 秒');
});

test('waitHtml 带可刷新的计时、转义文字；起点缺失只显示阶段', () => {
  const html = w.waitHtml({ label: 'CodeAgent <在处理>', verb: '已用', from: 1000, hint: '通常几分钟' }, 13_000);
  assert.match(html, /CodeAgent &lt;在处理&gt; · 已用 <span data-wait-since="1000">12 秒<\/span>/);
  assert.match(html, /（通常几分钟）/);
  assert.equal(w.waitHtml({ label: '排队' }), '<span class="wait-progress">排队</span>');
  assert.match(w.waitHtml({ label: 'x', from: '2026-11-06T10:00:00Z' }, Date.parse('2026-11-06T10:00:30Z')), /30 秒/);
  assert.equal(w.waitHtml(null), '');
});

test('tickWait 只改数字；ticker 在不活跃时跳过并可停止', () => {
  const el = { dataset: { waitSince: '1000' }, textContent: '0 秒' };
  const root = { querySelectorAll: () => [el] };
  assert.equal(w.tickWait(root, 6000), 1); assert.equal(el.textContent, '5 秒');
  let fn, cleared = false, active = false;
  const stop = w.startWaitTicker(() => root, { isActive: () => active, setIntervalFn: f => { fn = f; return 7; }, clearIntervalFn: id => { cleared = id === 7; } });
  el.textContent = 'old'; fn(); assert.equal(el.textContent, 'old');
  active = true; fn(); assert.notEqual(el.textContent, 'old');
  stop(); assert.equal(cleared, true);
});

test('助理一问的阶段：排队、准备中、正在查；已结束不显示', () => {
  assert.equal(w.assistantChatPhase({ state: 'queued', askedAt: 1 }).label, '排队中');
  assert.equal(w.assistantChatPhase({ state: 'running', startedAt: 2 }).label, 'CodeAgent 准备中…');
  assert.equal(w.assistantChatPhase({ state: 'running', startedAt: 2, answeringAt: 9 }).from, 9);
  assert.equal(w.assistantChatPhase({ state: 'done' }), null);
});

test('各功能已接上：组队批准、建群、PPT 检索、润色', () => {
  assert.match(read('renderer/team-ui.js'), /正在建 \$\{plan\.members\.length\} 个会话/);
  assert.match(read('renderer/meeting-create-modal.js'), /finally \{ stopCreateTick\(\); \}/);
  assert.match(read('renderer/company-ppt-page.js'), /assistantChatPhase\(r\.chat\)/);
  const polish = read('renderer/prompt-polish.js');
  assert.match(polish, /CodeAgent 整理中/); assert.match(polish, /clearInterval\(waitTick\)/);
});
