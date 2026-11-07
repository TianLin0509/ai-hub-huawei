'use strict';
// 2026-11-06 用户：等 CodeAgent 时要看到在哪一步、等了多久。助理一问分三段：排队 → CodeAgent 准备中 → 正在查。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { waitPhase, secondsText } = require('../renderer/company-assistant-page.js');

test('三段各自从自己的起点计时', () => {
  assert.deepEqual(waitPhase({ state: 'queued', askedAt: 1000 }), { label: '排队中', verb: '已等', from: 1000, hint: '' });
  const prep = waitPhase({ state: 'running', askedAt: 1000, startedAt: 3000 });
  assert.equal(prep.label, 'CodeAgent 准备中…'); assert.equal(prep.from, 3000); assert.match(prep.hint, /10–20 秒/);
  const run = waitPhase({ state: 'running', askedAt: 1000, startedAt: 3000, answeringAt: 15000 });
  assert.equal(run.label, '正在查…'); assert.equal(run.verb, '已用'); assert.equal(run.from, 15000);
  assert.equal(run.hint, `准备用了 ${secondsText(12000)}`);
});

test('旧记录没有 answeringAt 时仍按原来的起点显示', () => {
  const old = waitPhase({ state: 'running', askedAt: 1000, startedAt: 3000, answeringAt: undefined });
  assert.equal(old.from, 3000);
});

test('服务在问题送进 CodeAgent 后记下 answeringAt，进入准备阶段时立刻通知界面', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'company-assistant', 'service.js'), 'utf8');
  assert.match(src, /startedAt: this\.now\(\) \}\); this\.changed\(\);/);
  const sendAt = src.indexOf('await this.deps.sendPrompt(id, prompt');
  const markAt = src.indexOf("patchChat(job.chatId, { answeringAt: this.now() })");
  assert.ok(sendAt > 0 && markAt > sendAt);
});
