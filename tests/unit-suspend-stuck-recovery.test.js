'use strict';
// 休眠卡住的两种情况：落盘失败要通知并继续收尾；kill 后不退出要由看门狗强制结束。
const test = require('node:test');
const assert = require('node:assert');
const store = require('../core/session-store');
const { SessionManager } = require('../core/session-manager');

test('flush failure notifies the UI and still finishes the suspend', async () => {
  const sm = new SessionManager();
  const sid = 's1';
  const events = [];
  sm.onSessionSuspended = (id, _m, info) => events.push(['suspended', id, info.status]);
  sm.onSessionClosed = id => events.push(['closed', id]);
  sm.on('session-notice', e => events.push(['notice', e.level]));
  const pty = { pid: 4242, kill() {}, emit() {} };
  const info = { id: sid, kind: 'codeagent', agentRuntime: 'pty', status: 'suspending', ccSessionId: 'x' };
  sm.sessions.set(sid, { info, pty, pendingTimers: [], suspendRequestedAt: Date.now(), suspendReason: 'user-suspend' });
  sm.openLeases = new Map([[sid, { sessionId: sid, nonce: 'n' }]]);
  sm.openOwners = { release() {}, add() {}, bindPid() {} };
  const original = store.flushSessionForRelease;
  store.flushSessionForRelease = async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
  const warn = console.warn; console.warn = () => {};
  try {
    await Promise.resolve(sm._handlePtyExit(sid, pty, { exitCode: 0 }));
    await new Promise(r => setTimeout(r, 10));
  } finally { store.flushSessionForRelease = original; console.warn = warn; }
  assert.ok(events.some(e => e[0] === 'notice' && e[1] === 'warning'), JSON.stringify(events));
  assert.ok(events.some(e => e[0] === 'suspended'), JSON.stringify(events));
  assert.strictEqual(sm.sessions.has(sid), false);
});

test('watchdog forces termination when the PTY never exits, and reports failure', async () => {
  const sm = new SessionManager();
  const sid = 's2';
  const session = { info: { id: sid, kind: 'codeagent', status: 'suspending' }, pty: { pid: 1 }, pendingTimers: [], suspendRequestedAt: Date.now() };
  sm.sessions.set(sid, session);
  const forced = [], notices = [];
  sm._forceTerminatePty = async (id) => { forced.push(id); throw new Error('归属已变化'); };
  sm.on('session-notice', e => notices.push(e));
  const warn = console.warn; console.warn = () => {};
  try {
    sm._armSuspendExitWatchdog(sid, session, 5);
    await new Promise(r => setTimeout(r, 40));
  } finally { console.warn = warn; }
  assert.deepStrictEqual(forced, [sid]);
  assert.strictEqual(notices.length, 1);
  // 已确认退出则不动手
  session.confirmedExit = { exitCode: 0 };
  sm._armSuspendExitWatchdog(sid, session, 5);
  await new Promise(r => setTimeout(r, 40));
  assert.strictEqual(forced.length, 1);
});
