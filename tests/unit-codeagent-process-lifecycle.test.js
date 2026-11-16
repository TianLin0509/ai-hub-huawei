'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { SessionManager } = require('../core/session-manager');
const { createSessionAutoSuspendScheduler } = require('../main/session-auto-suspend');

const MIN = 60 * 1000;
test('only a settled recoverable CodeAgent with no input since completion can use the shorter idle limit', () => {
  const sm = new SessionManager(), now = 1000 * MIN;
  const add = (id, patch = {}) => {
    const entry = { info: { id, kind: 'codeagent', agentRuntime: 'pty', status: 'idle', ccSessionId: 'native-' + id },
      startedAt: now - 40 * MIN, lastInputAt: now - 40 * MIN, lastOutputAt: now - 35 * MIN,
      agentTurnFinishedAt: now - 35 * MIN, agentTurnActive: false, ...patch };
    sm.sessions.set(id, entry); return entry;
  };
  add('done'); add('active', { agentTurnActive: true });
  add('dirty', { lastInputAt: now - 34 * MIN });
  add('unbound').info.ccSessionId = undefined;
  add('running').info.status = 'running';
  add('unconfirmed', { agentTurnFinishedAt: 0 });
  add('claude').info.kind = 'claude';
  add('pinned').info.pinned = true;
  add('meeting').info.meetingId = 'room';
  const scheduler = createSessionAutoSuspendScheduler({ sessionManager: sm, now: () => now, logger: { log() {} } });
  const preview = scheduler.preview();
  assert.deepEqual(preview.items.filter(item => item.eligible).map(item => item.sessionId), ['done']);
  const requested = [];
  sm.suspendSession = (id, options) => {
    const verdict = sm._evaluateSuspendEligibility(id, options);
    if (verdict.ok) requested.push(id);
    return verdict;
  };
  scheduler.sweep();
  assert.deepEqual(requested, ['done']);
});

test('a matching finished hook records completion evidence for idle reclaim', () => {
  const sm = new SessionManager();
  const entry = { info: { kind: 'codeagent' }, agentTurnActive: true, agentTurnStartedAt: 100, agentTurnId: 'turn' };
  sm.sessions.set('s', entry);
  assert.equal(sm.noteAgentTurnFinished('s', { completedAt: 200, turnId: 'other' }), false);
  assert.equal(entry.agentTurnFinishedAt, undefined);
  assert.equal(sm.noteAgentTurnFinished('s', { completedAt: 200, turnId: 'turn' }), true);
  assert.equal(entry.agentTurnFinishedAt, 200);
});
const signerModule = () => import(pathToFileURL(path.join(__dirname, '../core/company-proxy/signer-init.mjs')).href);
const cli = 'C:\\Fixture\\CodeAgent\\bin\\codeagentcli.exe';
const signerOptions = (loadSigner, delegate) => ({ codeagentDir: 'C:\\Fixture\\CodeAgent', allowStampProbe: true,
  loadSigner, testOnly: true, testOnlySpawnDelegate: delegate });

test('signer initialization reclaims its still-running CLI on success and failure', async () => {
  const { initializeCacheOnlySigner } = await signerModule();
  for (const fails of [false, true]) {
    let kills = 0;
    const child = new EventEmitter(); child.kill = () => { kills++; child.emit('exit', 0); };
    const options = signerOptions(async () => ({
      async init() { require('node:child_process').spawn(cli, ['-p'], {}); if (fails) throw new Error('fixture'); return true; },
      async isAvailable() { return true; },
    }), () => child);
    if (fails) await assert.rejects(initializeCacheOnlySigner(options), { code: 'SIGNER_INIT_FAILED' });
    else assert.ok(await initializeCacheOnlySigner(options));
    assert.equal(kills, 1);
  }
});

test('signer cleanup leaves an already exited CLI alone', async () => {
  const { initializeCacheOnlySigner } = await signerModule();
  let kills = 0;
  const child = new EventEmitter(); child.kill = () => { kills++; };
  await initializeCacheOnlySigner(signerOptions(async () => ({
    async init() { require('node:child_process').spawn(cli, ['-p'], {}); child.emit('exit', 0); return true; },
    async isAvailable() { return true; },
  }), () => child));
  assert.equal(kills, 0);
});

test('signer initialization timeout also reclaims its registry helper', async t => {
  const { initializeCacheOnlySigner } = await signerModule();
  let kills = 0;
  const child = new EventEmitter(); child.kill = () => { kills++; };
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  await assert.rejects(initializeCacheOnlySigner({ ...signerOptions(async () => ({
    async init() {
      require('node:child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'fixture'], { windowsHide: true });
      return new Promise(() => {});
    }, async isAvailable() { return true; },
  }), () => child), timeoutMs: 10 }), { code: 'SIGNER_INIT_TIMEOUT' });
  assert.equal(kills, 1);
});
