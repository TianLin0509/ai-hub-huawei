'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createScreenErrorWatch, findScreenErrors, describeScreenError } = require('../core/codeagent-screen-error');
const { classifyModelRevocation } = require('../core/codeagent-model-revoked');

// 2026-11-17 反馈里的真实屏幕（CodeAgent 1.2615.02.03），节选。
const SAMPLE = [
  ' ┃  、bot测试群 的群 ID 是多少',
  ' ┃  1分钟前',
  '',
  '  ✗ SessionRequestError',
  '  部门已启用外部模型管控，外部模型不可用。请联系部门管理员关闭管控，或申请开通内部模型。 [SessionRequestError_002]',
  '',
  '   Select model',
];

test('finds the session-level error and its message', () => {
  const found = findScreenErrors(SAMPLE);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].name, 'SessionRequestError');
  assert.match(found[0].message, /外部模型管控.*\[SessionRequestError_002\]$/);
  assert.match(describeScreenError(found[0]), /公司侧的模型管控/);
});

test('ordinary output is not an error', () => {
  assert.deepStrictEqual(findScreenErrors(['✗ 1 test failed', 'Error: boom', '  ✗ SessionRequestError']), []);
});

function fake(screen) {
  const entry = { info: { id: 's1', kind: 'codeagent', agentRuntime: 'pty', status: 'idle' }, agentTurnActive: false, lastOutputAt: 1 };
  const state = { rows: screen, text: 'x' };
  const finished = [], errors = [];
  const manager = {
    sessions: new Map([['s1', entry]]),
    noteAgentTurnFinished: (id, ev) => { if (!entry.agentTurnActive) return false; entry.agentTurnActive = false; finished.push([id, ev]); return true; },
  };
  const watch = createScreenErrorWatch({ manager, readScreen: () => ({ text: state.text }), renderRows: async () => state.rows,
    onError: e => errors.push(e), now: () => 7000 });
  return { entry, state, watch, finished, errors };
}

test('a new error during a turn ends it with the original text', async () => {
  const { entry, state, watch, finished, errors } = fake(SAMPLE.slice(0, 2));
  await watch.tick(); // baseline, no error yet
  entry.agentTurnActive = true; entry.lastOutputAt = 2;
  state.rows = SAMPLE; state.text = 'raw SessionRequestError raw';
  await watch.tick();
  assert.strictEqual(finished.length, 1);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /SessionRequestError_002/);
  assert.strictEqual(errors[0].failedAt, 7000);
});

test('an old error still on screen does not end the next turn', async () => {
  const { entry, state, watch, finished } = fake(SAMPLE);
  state.text = 'SessionRequestError';
  await watch.tick(); // baseline already contains the error
  entry.agentTurnActive = true; entry.lastOutputAt = 2; // redraw, same error
  await watch.tick();
  assert.strictEqual(finished.length, 0);
  // the same error shows up a second time: that is new
  state.rows = [...SAMPLE, ...SAMPLE]; entry.lastOutputAt = 3;
  await watch.tick();
  assert.strictEqual(finished.length, 1);
});

test('raw output without the error word is not replayed', async () => {
  const { entry, state, watch, finished } = fake(SAMPLE.slice(0, 2));
  await watch.tick();
  entry.agentTurnActive = true; entry.lastOutputAt = 2;
  state.rows = SAMPLE; state.text = 'nothing relevant';
  await watch.tick();
  assert.strictEqual(finished.length, 0);
});

test('main and renderer route the screen error like a CLI exit', () => {
  const fs = require('node:fs');
  assert.match(fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8'), /payload\.signalSource === 'codeagent-screen-error'/);
  assert.match(fs.readFileSync(require.resolve('../main.js'), 'utf8'), /signalSource: 'codeagent-screen-error'/);
});

// r38b 审查 P1：新会话发出去 10 秒内就报错，第一次读屏已经带着这条错（之前没有「空屏」那次读屏）。
test('first read of an active new session already shows the error: it ends the turn', async () => {
  const { entry, state, watch, finished, errors } = fake(SAMPLE);
  entry.agentTurnActive = true; entry.info.status = 'running';
  state.text = '✗ SessionRequestError';
  await watch.tick();
  assert.strictEqual(finished.length, 1);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /SessionRequestError_002/);
  // 之后的读屏和重绘不重复报
  await watch.tick(); entry.lastOutputAt = 2; entry.agentTurnActive = true; await watch.tick();
  assert.strictEqual(finished.length, 1);
});

test('an error first seen while idle stays baseline for the next turn', async () => {
  const { entry, state, watch, finished } = fake(SAMPLE);
  state.text = 'SessionRequestError';
  await watch.tick(); // idle first read
  entry.agentTurnActive = true; entry.lastOutputAt = 2;
  await watch.tick();
  assert.strictEqual(finished.length, 0);
});

test('model permission revocation rules cover Chinese and English CLI wording', () => {
  const samples = [
    'SessionRequestError 当前模型 GLM-5.2-WX-Auto 可能已经升级或被调整了权限，请更换模型',
    'SessionRequestError model GLM-5.2-WX-Auto is no longer available for this account: permission denied',
    'SessionRequestError 模型 GLM-5.2-WX-Auto 已下线，请选择可用模型',
  ];
  for (const text of samples) assert.equal(classifyModelRevocation(text, { source: 'codeagent-screen-error' })?.kind, 'model-revoked');
});

test('ordinary assistant text quoting the warning cannot trigger model recovery', () => {
  assert.equal(classifyModelRevocation('用户粘贴：当前模型可能已经升级或被调整了权限。', { source: 'assistant', role: 'assistant' }), null);
  assert.equal(classifyModelRevocation('当前模型可能已经升级或被调整了权限。', { source: 'transcript', role: 'assistant' }), null);
  assert.equal(classifyModelRevocation('SessionRequestError 工具配置失败，请检查工作区。', { source: 'codeagent-screen-error' }), null);
});
