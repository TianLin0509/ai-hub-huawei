'use strict';
// 主进程记录回合进行中、画面认不出时，停止仍要发 Esc。
const test = require('node:test');
const assert = require('node:assert');
const { createCodeAgentInputGuard } = require('../core/codeagent-input-guard');

function setup(turnActive) {
  const writes = [];
  const entry = { pty: {}, agentTurnActive: turnActive, info: { id: 's', kind: 'codeagent', agentRuntime: 'pty', status: 'idle' } };
  const manager = {
    sessions: new Map([['s', entry]]), getSession: () => ({ ...entry.info }), writeToSession: (_id, d) => writes.push(d), emit() {},
    isAgentTurnActive: () => entry.agentTurnActive,
  };
  const unknownFrame = ['答案第 1 行', '正在调用工具 xxx', '（没有认得出的输入框和 Running 字样）'];
  const guard = createCodeAgentInputGuard(manager, {
    openScreen: async () => ({ lines: async () => unknownFrame, dispose() {} }),
    sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 5))), diagnose() {}, stopDiagnose() {},
  });
  return { guard, writes };
}

test('unknown frame + agentTurnActive sends Esc', async () => {
  const { guard, writes } = setup(true);
  await guard.stop('s', { branch: 'running', rendererState: 'running' });
  assert.ok(writes.includes('\x1b'));
});

test('unknown frame + no active turn still refuses', async () => {
  const { guard, writes } = setup(false);
  const result = await guard.stop('s', { branch: 'running', rendererState: 'running' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'codeagent-running-unknown');
  assert.deepStrictEqual(writes, []);
});
