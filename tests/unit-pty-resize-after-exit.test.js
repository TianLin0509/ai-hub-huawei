'use strict';
// 终端进程已退出、会话还没清掉时，界面发来改大小不能让 Hub 崩溃（v5.5.50 公司电脑崩溃记录）；
// 跳过时把会话和终端怎么结束的记进诊断日志，便于查「终端为什么已经退出」。
const test = require('node:test');
const assert = require('node:assert');
const { SessionManager } = require('../core/session-manager');

const EXITED = 'Cannot resize a pty that has already exited';

function make(resize, extra = {}) {
  const sm = new SessionManager();
  const snapshotCalls = [];
  const rewriterCalls = [];
  const logs = [];
  sm._appendDiagnosticLog = (file, entry) => logs.push({ file, entry });
  const pty = { pid: 1, resize };
  sm.sessions.set('s1', {
    info: { id: 's1', agentRuntime: 'pty', status: 'idle', kind: 'codeagent', purpose: 'company-assistant', title: '公司助理', createdAt: Date.parse('2026-11-09T06:40:00Z') },
    pty,
    terminalSnapshot: { resize: (...args) => snapshotCalls.push(args) },
    terminalOutputRewriter: { resize: (...args) => rewriterCalls.push(args) },
    pendingTimers: [],
    ...extra,
  });
  const events = [];
  sm.on('terminal-resized', event => events.push(event));
  return { sm, pty, events, snapshotCalls, rewriterCalls, logs };
}

const throwExited = () => { throw new Error(EXITED); };

test('resize on an exited pty is skipped instead of throwing', (t) => {
  t.mock.method(console, 'warn', () => {});
  const { sm, events, snapshotCalls, rewriterCalls } = make(throwExited);
  const seqBefore = sm._outputSeq;
  const lastSeqBefore = sm.sessions.get('s1').lastOutputSeq;
  assert.doesNotThrow(() => sm.resizeSession('s1', 120, 30));
  assert.strictEqual(events.length, 0);
  assert.strictEqual(snapshotCalls.length, 0);
  assert.strictEqual(rewriterCalls.length, 0);
  assert.strictEqual(sm._outputSeq, seqBefore);
  assert.strictEqual(sm.sessions.get('s1').lastOutputSeq, lastSeqBefore);
});

test('skipped resize logs which session it was and how its CLI ended, once per terminal', (t) => {
  t.mock.method(console, 'warn', () => {});
  const { sm, logs } = make(throwExited, { confirmedExit: { exitCode: 3221225786, signal: 0 } });
  sm.resizeSession('s1', 120, 30);
  sm.resizeSession('s1', 121, 30);
  sm.resizeSession('s1', 122, 31);
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(console.warn.mock.callCount(), 1);
  const { file, entry } = logs[0];
  assert.strictEqual(file, 'pty-resize-skipped.log');
  assert.strictEqual(entry.event, 'resize-skipped');
  assert.strictEqual(entry.sessionId, 's1');
  assert.strictEqual(entry.purpose, 'company-assistant');
  assert.strictEqual(entry.kind, 'codeagent');
  assert.strictEqual(entry.error, EXITED);
  assert.strictEqual(entry.exitConfirmed, true);
  assert.strictEqual(entry.exitCode, 3221225786);
  assert.strictEqual(entry.closeRequestedAt, null);
  assert.strictEqual(entry.suspendRequestedAt, null);
  assert.strictEqual(entry.hubKillRequested, false);
  assert.strictEqual(entry.createdAt, '2026-11-09T06:40:00.000Z');
});

test('a terminal Hub itself closed is told apart from one whose CLI exited on its own', (t) => {
  t.mock.method(console, 'warn', () => {});
  const closedAt = Date.parse('2026-11-09T06:45:37Z');
  const { sm, pty, logs } = make(throwExited, { closeRequestedAt: closedAt });
  pty._agent = { _exitCode: 1 };
  sm._ptyTerminationRequests.add(pty);
  sm.resizeSession('s1', 120, 30);
  assert.strictEqual(logs.length, 1);
  const { entry } = logs[0];
  assert.strictEqual(entry.hubKillRequested, true);
  assert.strictEqual(entry.closeRequestedAt, '2026-11-09T06:45:37.000Z');
  assert.strictEqual(entry.exitConfirmed, false);
  assert.strictEqual(entry.exitCode, null);
  assert.strictEqual(entry.agentExitCode, 1);
});

test('resize on a live pty still updates snapshot and emits terminal-resized, without logging', () => {
  const ptyCalls = [];
  const { sm, events, snapshotCalls, rewriterCalls, logs } = make((...args) => ptyCalls.push(args));
  sm.resizeSession('s1', 40, 20);
  assert.deepStrictEqual(ptyCalls, [[60, 20]]);
  assert.strictEqual(snapshotCalls.length, 1);
  assert.strictEqual(rewriterCalls.length, 1);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].cols, 60);
  assert.strictEqual(events[0].rows, 20);
  assert.strictEqual(logs.length, 0);
});

test('the diagnostic line lands in <data dir>/logs/pty-resize-skipped.log as one JSON line', (t) => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-resize-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = previous; });
  const sm = new SessionManager();
  sm._appendDiagnosticLog('pty-resize-skipped.log', { event: 'resize-skipped', sessionId: 's1' });
  const lines = fs.readFileSync(path.join(dir, 'logs', 'pty-resize-skipped.log'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.event, 'resize-skipped');
  assert.strictEqual(parsed.sessionId, 's1');
  assert.ok(!Number.isNaN(Date.parse(parsed.at)));
});
