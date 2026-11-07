'use strict';
// 还没绑定原生身份的 CodeAgent 会话，点关闭要直接结束，而不是被"尚未绑定原生会话 ID"拒绝。
const test = require('node:test');
const assert = require('node:assert');
const { SessionManager } = require('../core/session-manager');

function make(info) {
  const sm = new SessionManager();
  const terminated = [];
  sm._terminatePty = entry => { terminated.push(entry); };
  sm.sessions.set('s1', { info: { id: 's1', agentRuntime: 'pty', status: 'idle', ...info }, pty: { pid: 1, kill() {} }, pendingTimers: [] });
  return { sm, terminated };
}

test('unbound CodeAgent session closes directly', () => {
  const { sm, terminated } = make({ kind: 'codeagent', codeagentIdentityPending: true });
  const result = sm.closeSessionRecoverably('s1', { reason: 'user-close' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'closed');
  assert.strictEqual(terminated.length, 1);
});

test('bound CodeAgent session still takes the recoverable-suspend path', () => {
  const { sm } = make({ kind: 'codeagent', codeagentIdentityPending: false, ccSessionId: '11111111-1111-4111-8111-111111111111' });
  let closed = 0;
  sm.closeSession = () => { closed += 1; };
  sm.suspendSession = () => ({ ok: true });
  const result = sm.closeSessionRecoverably('s1', { reason: 'user-close' });
  assert.strictEqual(result.action, 'suspended');
  assert.strictEqual(closed, 0);
});
