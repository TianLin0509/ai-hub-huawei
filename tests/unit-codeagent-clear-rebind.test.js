'use strict';
// CodeAgent 没有 SessionEnd：/clear、/resume 的顶层 SessionStart 在位置核对通过后可直接改绑。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { createClaudeIdentitySwitch } = require('../core/claude-identity-switch');
const { HOOK_EVENTS } = require('../core/codeagent-config');

const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';
const start = (sw, extra) => sw.observe('hub-1', { event: 'session-start', boundId: OLD, incomingId: NEW, ...extra });

test('without endOptional the old strict behaviour is kept', () => {
  assert.strictEqual(HOOK_EVENTS.includes('SessionEnd'), false);
  assert.strictEqual(start(createClaudeIdentitySwitch(), { source: 'clear' }).action, 'ignore');
});

test('endOptional rebinds on clear and resume only', () => {
  assert.strictEqual(start(createClaudeIdentitySwitch(), { source: 'clear', endOptional: true }).action, 'rebind');
  assert.strictEqual(start(createClaudeIdentitySwitch(), { source: 'resume', endOptional: true }).action, 'rebind');
  // 嵌套进程是 startup；compact 不换身份
  assert.strictEqual(start(createClaudeIdentitySwitch(), { source: 'startup', endOptional: true }).action, 'ignore');
  assert.strictEqual(start(createClaudeIdentitySwitch(), { source: 'compact', endOptional: true }).action, 'ignore');
  assert.strictEqual(start(createClaudeIdentitySwitch(), { source: null, endOptional: true }).action, 'ignore');
});

test('subagent never rebinds even with endOptional', () => {
  assert.strictEqual(start(createClaudeIdentitySwitch(), { source: 'clear', endOptional: true, agentId: 'a1' }).action, 'ignore');
});

test('main.js passes endOptional only for CodeAgent with verified location', () => {
  const src = fs.readFileSync(require.resolve('../main.js'), 'utf8');
  assert.match(src, /endOptional: event === 'session-start' && isCodeAgentKind\(hookTargetSession\.kind\)/);
  assert.match(src, /function codeAgentSwitchLocationOk/);
});
