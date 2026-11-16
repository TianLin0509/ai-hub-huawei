'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'node-pty') return { spawn() { throw Error('No real PTY in capability preflight tests'); } };
  return load.call(this, id, ...args);
};
let SessionManager, _private;
try { ({ SessionManager, _private } = require('../core/session-manager')); }
finally { Module._load = load; }
const caps = require('../core/cli-capabilities');
const probes = require('../core/codeagent-capabilities');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-capability-preflight-'));
  const prior = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = root;
  require('../core/hub-config').clearConfigCache();
  probes._helpCache.clear();
  t.mock.method(require('../core/company-ai-policy'), 'assertKind', () => {});
  t.mock.method(require('../core/community-provider'), 'assertProviderAvailable', () => {});
  t.mock.method(require('../core/company-api-config'), 'assertLaunchConfigured', () => {});
  t.after(() => {
    probes._helpCache.clear();
    if (prior === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prior;
    require('../core/hub-config').clearConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const manager = Object.create(SessionManager.prototype), commands = [];
  manager.sessions = new Map();
  manager._openOwners = () => null;
  manager._createSession = (kind, opts) => {
    const launch = _private.buildClaudePtyLaunch(opts.id, kind,
      { ...opts, fastMode: false, mcpProfile: 'full' }, root, { USERPROFILE: root, HOME: root }, {});
    commands.push(launch.cmd);
    return { id: opts.id, kind, purpose: opts.purpose };
  };
  return { root, manager, commands };
}

for (const purpose of ['hub-assistant', 'team-member']) test(`cold ${purpose} direct create waits for Claude 2.1.50 help before building effort`, async t => {
  const f = fixture(t);
  let release, prepares = 0;
  const help = fs.readFileSync(path.join(__dirname, 'fixtures/cli-help/claude-2.1.50.txt'), 'utf8');
  t.mock.method(caps, 'prepareForKind', kind => {
    prepares++;
    assert.equal(kind, 'claude');
    return new Promise(resolve => { release = async () => {
      await probes.prepare('claude', { platform: 'linux', exec: (_file, args, _options, callback) => {
        setImmediate(() => callback(null, args.at(-1) === '--help' ? help : '2.1.50'));
        return { on() {} };
      } });
      resolve();
    }; });
  });
  const pending = f.manager.createSession('claude', { id: purpose, purpose, effort: 'max', model: 'claude-opus-4-8' });
  await new Promise(setImmediate);
  assert.equal(prepares, 1);
  assert.deepEqual(f.commands, [], 'No command may be built while cold help is pending');
  await release();
  assert.equal((await pending).purpose, purpose);
  assert.match(f.commands[0], /--effort high\b/);
  assert.doesNotMatch(f.commands[0], /--effort max\b/);
  const hot = f.manager.createSession('claude', { id: purpose + '-hot', effort: 'max', model: 'claude-opus-4-8' });
  assert.equal(hot.id, purpose + '-hot', 'Hot creation retains its synchronous contract');
  assert.equal(prepares, 1, 'Hot creation does not repeat preflight');
});

test('failed internal prepare preserves launch behavior and a failed launch releases its lease', async t => {
  const f = fixture(t);
  t.mock.method(caps, 'prepareForKind', async () => { throw Error('CLI probe unavailable'); });
  const result = await f.manager.createSession('claude', { id: 'unknown', effort: 'max', model: 'claude-opus-4-8' });
  assert.equal(result.id, 'unknown');
  assert.match(f.commands[0], /--effort max\b/);
  let released;
  f.manager._releaseOpenSession = id => { released = id; };
  f.manager._createSession = () => { throw Error('launch failed'); };
  await assert.rejects(f.manager.createSession('claude', { id: 'failed' }), /launch failed/);
  assert.equal(released, 'failed');
});

test('shell creation remains synchronous and does not probe', t => {
  const f = fixture(t);
  t.mock.method(caps, 'prepareForKind', () => assert.fail('Shell must not probe'));
  f.manager._createSession = (kind, opts) => ({ id: opts.id, kind });
  assert.deepEqual(f.manager.createSession('powershell', { id: 'shell' }), { id: 'shell', kind: 'powershell' });
});

test('cancelled cold resume reservation never launches or releases a newer reservation', async t => {
  const f = fixture(t);
  const lease = { nonce: 'old' }, newer = { nonce: 'new' };
  f.manager.openLeases = new Map([['resume', lease]]);
  let release;
  t.mock.method(caps, 'prepareForKind', () => new Promise(resolve => { release = resolve; }));
  const pending = f.manager.createSession('claude', { id: 'resume', _openLeaseNonce: 'old' });
  await new Promise(setImmediate);
  f.manager.openLeases.set('resume', newer);
  release();
  await assert.rejects(pending, /预约已失效/);
  assert.deepEqual(f.commands, []);
  assert.equal(f.manager.openLeases.get('resume'), newer);
});
