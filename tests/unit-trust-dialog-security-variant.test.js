'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectTrustDialogInLines } = require('../core/claude-trust-dialog.js');

const noHint = [
  'Quick safety check: Is this a project you created or one you trust? If not, review what\'s in this folder first.',
  'These will apply without asking. Only proceed if you trust this configuration.',
  'Detected security risks (review each item before trusting):',
  '  MCP server: hub_sessions (stdio)',
  '> Yes, I trust this folder',
];

test('Hub 自己的目录：加长信任框没有底栏提示，光标在信任行时按回车', () => {
  const d = detectTrustDialogInLines(noHint, { cursorOnTrustIsEnough: true });
  assert.deepStrictEqual(d.keys, ['\r']);
});

test('普通目录：没有底栏提示时不动手，交给用户', () => {
  assert.strictEqual(detectTrustDialogInLines(noHint), null);
});

test('没有底栏提示且光标不在信任行时，绝不盲按', () => {
  const lines = ['Do you trust this?', '> No, exit', '  Yes, I trust this folder'];
  assert.strictEqual(detectTrustDialogInLines(lines, { cursorOnTrustIsEnough: true }), null);
});

test('有底栏提示的旧框行为不变：把光标移到信任行再回车', () => {
  const lines = ['Do you trust this?', '> No, exit', '  Yes, I trust this folder', 'Enter to confirm'];
  assert.deepStrictEqual(detectTrustDialogInLines(lines).keys, ['\x1b[B', '\r']);
});
