'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { CompanyAssistant } = require('../core/company-assistant/service');
const bg = require('../renderer/session-background-tasks');

const item = (id, purpose, title, extra = {}) => ({ id, purpose, title, lastMessageTime: 1, ...extra });

test('all background purposes are listed; resident and ordinary sessions are not', () => {
  const r = bg.selectBackgroundTasks([
    item('resident', 'company-assistant', '助理问答 · 今天的会'),
    item('ppt', 'company-assistant', 'PPT 找页 · SRS 原理'),
    item('brief', 'company-assistant', '公司助理 · 简报'),
    item('team', 'company-assistant', '团队关注分析'),
    item('ai', 'company-ai', '公司 AI · 摘要'),
    item('forum', 'company-forum', '论坛热帖整理'),
    item('wireless', 'wireless-proposal', '无线提案'),
    item('mine', undefined, '我的会话'),
  ], { residentId: 'resident' });
  assert.deepEqual(r.items.map(x => x.id).sort(), ['ai', 'brief', 'forum', 'ppt', 'team']);
});

test('prewarmed empty sessions stay out, running ones always show', () => {
  const empty = { id: 'warm', purpose: 'company-assistant', title: '公司助理' };
  const startingUp = { id: 'run', purpose: 'company-assistant', title: 'PPT 找页 · x' };
  const r = bg.selectBackgroundTasks([empty, startingUp], { isRunning: x => x.id === 'run' });
  assert.deepEqual(r.items.map(x => x.id), ['run']);
});

test('finished tasks are capped at the newest 20, running tasks are not capped', () => {
  const finished = Array.from({ length: 30 }, (_, i) => item('f' + i, 'company-ai', 'x', { at: i }));
  const running = Array.from({ length: 25 }, (_, i) => item('r' + i, 'company-ai', 'x', { at: 100 + i }));
  const r = bg.selectBackgroundTasks([...finished, ...running], { isRunning: x => x.id[0] === 'r', activityTime: x => x.at });
  assert.equal(r.running.length, 25);
  assert.equal(r.finished.length, 20);
  assert.equal(r.finished[0].id, 'f29');
  assert.equal(r.finished[19].id, 'f10');
});

test('the group follows run state until the user toggles it, and the toggle lasts until run state changes', () => {
  assert.equal(bg.backgroundExpanded(true, null), true);
  assert.equal(bg.backgroundExpanded(false, null), false);
  assert.equal(bg.backgroundExpanded(true, { anyRunning: true, expanded: false }), false);
  assert.equal(bg.backgroundExpanded(false, { anyRunning: false, expanded: true }), true);
  assert.equal(bg.backgroundExpanded(false, { anyRunning: true, expanded: true }), false);
});

test('only assistant Q&A sessions can occupy the resident slot', () => {
  for (const title of ['公司助理', '公司助理 · 手机', '助理问答 · a', '手机问答 · a']) assert.equal(bg.isResidentCandidate({ purpose: 'company-assistant', title }), true, title);
  for (const title of ['PPT 找页 · a', 'PPT 素材助理', '公司助理 · 简报', '团队关注分析', '开会助手 · 周会']) assert.equal(bg.isResidentCandidate({ purpose: 'company-assistant', title }), false, title);
});

test('task titles say which feature the session is doing and what it is about', () => {
  const titleFor = (q, toolset, extra = {}) => CompanyAssistant.prototype.taskTitleFor.call(
    { chat: () => [{ id: 'c', q, ...extra }] }, { type: 'chat', chatId: 'c' }, toolset);
  assert.equal(titleFor('SRS 信道估计\n本次只找素材目录「D:/a」中的页面。', 'ppt'), 'PPT 找页 · SRS 信道估计');
  assert.equal(titleFor('今天有什么会', 'desk'), '助理问答 · 今天有什么会');
  assert.equal(titleFor('今天有什么会', 'phone'), '手机问答 · 今天有什么会');
  assert.equal(titleFor('长提示词', 'ppt', { taskTitle: 'PPT 看图修正 · a.png' }), 'PPT 看图修正 · a.png');
  assert.equal(CompanyAssistant.prototype.taskTitleFor.call({ chat: () => [] }, { type: 'brief' }, 'brief'), '');
});
