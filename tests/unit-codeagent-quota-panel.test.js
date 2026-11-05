'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createCodeAgentQuotaPanel } = require('../core/codeagent-quota-panel');
const { panelAvailability, createAccountQuotaPanel } = require('../renderer/account-quota-panel');
const pool = require('../core/codeagent-pool');
const quota = require('../core/codeagent-quota');
const usage = require('../core/codeagent-usage-menu');
const serve = require('../core/codeagent-serve');

// Synthetic data in the serve API shape; no live accounts or network reads.
function servedRead() {
  const parsed = serve.parseProviders({ providers: [], creditUsage: { quotas: [
    { type: 'CPD_Peak', used: '0', total: '100' },
    { type: 'CPD_Valley', used: null, total: '200' },
    { type: 'CPM', used: '25', total: '500' },
  ] } });
  return { ok: true, credit: parsed.credit, models: [], details: [], quotas: {} };
}

function model({ status = { ok: true, personal: { state: 'ready' }, accounts: [] }, cached = {}, ...options } = {}) {
  return createCodeAgentQuotaPanel({ getStatus: () => status, readUsage: () => cached,
    serveEnabled: () => true, refreshAccount: async () => {}, now: () => 9000, ...options });
}

test('quota snapshot joins account, usage, screen reading and pause without promoting cache timestamps', async () => {
  const credit = serve.toUsageSnapshot(servedRead()).credit;
  const snapshot = await model({ status: { ok: true,
    personal: { state: 'ready', activeSessions: 2, dir: 'private-path', accessToken: 'private-token' },
    accounts: [{ id: 'pool-1', note: 'Example', state: 'ready', avoid: { source: 'manual', until: null },
      credit: { remaining: 7, at: 3000, observedAt: 2000 }, dir: 'private-path' }],
  }, cached: { personal: { credit, at: 5000, creditAt: 1000 }, 'pool-1': { models: [], at: 6000 }, removed: { credit, at: 8000 } },
    refreshAccount: () => assert.fail('a read must not refresh'),
  }).snapshot();
  assert.deepEqual(snapshot.rows.map(row => row.id), ['personal', 'pool-1']);
  const [personal, account] = snapshot.rows;
  assert.equal(personal.label, '个人账号'); assert.equal(personal.activeSessions, 2);
  assert.deepEqual(personal.credit, credit); assert.equal(personal.creditAt, 1000); assert.equal(personal.usageAt, 5000);
  assert.equal(account.paused, true); assert.equal(account.avoid.source, 'manual');
  assert.equal(account.credit, null); assert.equal(account.creditAt, null); assert.equal(account.creditReadingAt, 2000);
  assert.deepEqual(Object.keys(snapshot.creditReadings), ['pool-1']);
  assert.deepEqual(Object.keys(snapshot.usage), ['personal', 'pool-1']);
  assert.equal(snapshot.checkedAt, 9000);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-path|private-token|removed/);
});

test('no reading remains unknown and a legacy ISO reading time is preserved', async () => {
  const empty = (await model().snapshot()).rows[0];
  assert.equal(empty.credit, null); assert.equal(empty.creditReading, null);
  assert.equal(empty.creditAt, null); assert.equal(empty.hasReading, false);
  const iso = '2026-01-01T00:00:00.000Z';
  const legacy = (await model({ cached: { personal: { credit: { monthly: { used: null, total: '500', pct: null } }, at: iso } } }).snapshot()).rows[0];
  assert.equal(legacy.creditAt, Date.parse(iso)); assert.equal(legacy.credit.monthly.used, null);
});

test('quota refresh deduplicates simultaneous requests and reports in-flight without refreshing a read', async () => {
  let finish, calls = 0;
  const service = model({ refreshAccount: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const first = service.snapshot({ refresh: true, key: 'personal' });
  const second = service.snapshot({ refresh: true, key: 'personal' });
  await new Promise(setImmediate);
  assert.equal((await service.snapshot()).rows[0].refresh.status, 'in-flight');
  finish();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.ok(results.every(result => result.rows[0].refresh.status === 'updated'));
});

test('failed refresh retains its cause and original read time on subsequent cache reads', async () => {
  const service = model({ cached: { personal: { at: 8000, creditAt: 1000, credit: { monthly: null } } },
    refreshAccount: async () => { throw new Error('read unavailable'); } });
  const first = await service.snapshot({ refresh: true });
  const next = await service.snapshot();
  for (const result of [first, next]) {
    const row = result.rows[0];
    assert.equal(row.refresh.status, 'failed'); assert.equal(row.refresh.error, 'read unavailable');
    assert.equal(row.refresh.attemptedAt, 9000); assert.equal(row.creditAt, 1000); assert.equal(row.cached, true);
  }
});

test('removed accounts disappear even if a pending refresh writes an old cache entry', async () => {
  const status = { ok: true, personal: {}, accounts: [{ id: 'pool-1' }] };
  const service = model({ status, cached: { 'pool-1': { at: 1000 } },
    refreshAccount: async () => { status.accounts = []; } });
  const result = await service.snapshot({ refresh: true, key: 'pool-1' });
  assert.deepEqual(result.rows.map(row => row.id), ['personal']);
  assert.deepEqual(result.usage, {});
});

test('panel cooldown shares saved serve/probe attempts, but live screen reads do not block a refresh', async () => {
  let clock = 9000, calls = 0;
  const cached = { personal: { at: 8000, source: 'serve', creditAt: 1000, credit: { monthly: null } } };
  const service = model({ cached, now: () => clock, refreshAccount: async () => { calls++; } });
  const skipped = await service.snapshot({ refresh: true });
  assert.equal(skipped.rows[0].refresh.status, 'cooldown'); assert.equal(calls, 0);
  assert.equal(skipped.rows[0].nextRefreshAt, 8000 + usage.CODEAGENT_SERVE_MAX_AGE_MS);
  assert.equal(skipped.rows[0].creditAt, 1000); assert.equal(skipped.rows[0].cached, true);
  clock = skipped.rows[0].nextRefreshAt;
  assert.equal((await service.snapshot({ refresh: true })).rows[0].refresh.status, 'updated');
  assert.equal(calls, 1);
  assert.equal((await service.snapshot({ refresh: true })).rows[0].refresh.status, 'cooldown');
  assert.equal(calls, 1);
  cached.personal.source = 'screen';
  const screen = model({ cached, refreshAccount: async () => { calls++; } });
  assert.equal((await screen.snapshot({ refresh: true })).rows[0].refresh.status, 'updated');
  assert.equal(calls, 2);
});

test('serve-disabled reads do not consume the refresh window and a new saved probe can extend it', async () => {
  let enabled = false, calls = 0, clock = 9000;
  const cached = {};
  const service = model({ cached, now: () => clock, serveEnabled: () => enabled, refreshAccount: async () => { calls++; } });
  assert.equal((await service.snapshot({ refresh: true })).rows[0].nextRefreshAt, 0);
  enabled = true;
  assert.equal((await service.snapshot({ refresh: true })).rows[0].refresh.status, 'updated');
  clock += 2000; cached.personal = { source: 'probe', at: clock };
  assert.equal((await service.snapshot()).rows[0].nextRefreshAt, clock + usage.CODEAGENT_SERVE_MAX_AGE_MS);
  assert.equal(calls, 1);
});

test('invalid request or account fails before starting any refresh', async () => {
  const service = model({ refreshAccount: () => assert.fail('must not refresh') });
  for (const payload of [null, [], 'personal', { key: '' }, { key: 1 }, { key: 'missing', refresh: true }]) {
    await assert.rejects(service.snapshot(payload), /请求无效|找不到/);
  }
});

function ipcFixture(t, { serveRead = async () => servedRead(), enabled = '1', now = Date.now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quota-panel-'));
  const personal = path.join(dir, 'fake-cli');
  const vars = { CLAUDE_HUB_DATA_DIR: dir, AI_HUB_CODEAGENT_CONFIG_DIR: personal,
    AI_HUB_CODEAGENT_SERVE: enabled, CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0' };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('hub-quota-panel-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  function login(configDir, accountId) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({ idaasOAuth: {
      accountId, xAuthToken: 'synthetic-secret-not-for-use', expiresAt: Date.now() + 3600000,
    } }));
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: 'Example-Model' }));
  }
  login(personal, 'fixture-personal');
  const add = () => {
    const id = pool.addAccount(dir, { note: 'Example pool', personalDir: personal });
    login(pool.accountDir(dir, id), id);
    return id;
  };
  const handlers = new Map(), events = [], calls = [];
  let menus = 0;
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { codeagentPoolActiveCounts: () => ({}), getAllSessions: () => [{ kind: 'codeagent', status: 'idle' }] },
    sendToRenderer: (...args) => events.push(args),
    codeagentServeRead: async args => { calls.push(args); return serveRead(args); },
    codeagentQuotaNow: now,
    codeagentProbeModels: async () => { menus++; throw new Error('quota panel must not open a menu'); },
  });
  return { dir, personal, add, handlers, events, calls, menus: () => menus,
    snapshot: payload => handlers.get('codeagent:quota-panel')(null, payload) };
}

test('real IPC returns personal and pool data, model/manual pauses, and screen Credit in one read', async t => {
  const fixture = ipcFixture(t), id = fixture.add(), modelPaused = fixture.add();
  usage.recordUsage(fixture.dir, 'personal', serve.toUsageSnapshot(servedRead()), { now: 1000, source: 'screen' });
  quota.recordCredit(fixture.dir, id, { remaining: 45, pct: 45, bucket: 'busyDay', total: 100 }, { observedAt: 2000 }, 3000);
  quota.markAvoid(fixture.dir, id, { source: 'manual', until: null });
  quota.markModelAvoid(fixture.dir, modelPaused, { model: 'Example-Model', reason: 'model unavailable' });
  const result = await fixture.snapshot();
  assert.equal(result.ok, true); assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0].activeSessions, 1); assert.equal(result.rows[0].creditAt, 1000);
  assert.equal(result.rows[0].credit.busyDay.used, '0');
  assert.equal(result.rows[0].credit.idleDay.used, null);
  assert.equal(result.rows[0].credit.monthly.total, '500');
  assert.equal(result.rows[1].paused, true); assert.equal(result.rows[1].creditReadingAt, 2000);
  assert.equal(result.rows[2].paused, true); assert.equal(result.rows[2].avoid.kind, 'model-config');
  assert.deepEqual(result.creditReadings, quota.creditReadings(fixture.dir));
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.menus(), 0);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret-not-for-use|configDir|xAuthToken/);
});

test('real IPC refreshes each account with its own directory, preserves pauses, and isolates failures', async t => {
  const fixture = ipcFixture(t, { serveRead: async args => {
    if (args.configDir === fixture.personal) return { ok: false, error: 'unavailable https://example.invalid/private?token=synthetic-token' };
    return servedRead();
  } });
  const id = fixture.add();
  usage.recordUsage(fixture.dir, 'personal', serve.toUsageSnapshot(servedRead()), { now: 1000, source: 'screen' });
  quota.recordCredit(fixture.dir, id, { remaining: 0, pct: 0, bucket: 'busyDay', total: 100 });
  const beforePause = quota.activeAvoid(fixture.dir)[id], beforeReading = quota.creditReadings(fixture.dir)[id];
  const result = await fixture.snapshot({ refresh: true });
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].refresh.status, 'failed'); assert.equal(result.rows[0].creditAt, 1000);
  assert.equal(result.rows[0].usage.source, 'screen'); assert.equal(result.rows[0].cached, true);
  assert.doesNotMatch(result.rows[0].refresh.error, /example\.invalid|synthetic-token/);
  assert.equal(result.rows[1].refresh.status, 'updated'); assert.equal(result.rows[1].cached, false);
  assert.equal(result.rows[1].usage.source, 'serve'); assert.ok(result.rows[1].creditAt > 1000);
  assert.deepEqual(quota.activeAvoid(fixture.dir)[id], beforePause);
  assert.deepEqual(quota.creditReadings(fixture.dir)[id], beforeReading);
  assert.deepEqual(fixture.calls.map(call => call.configDir), [fixture.personal, pool.accountDir(fixture.dir, id)]);
  assert.ok(fixture.calls.every(call => call.dataDir === fixture.dir && call.cwd === pool.probeCwd(fixture.dir)));
  assert.deepEqual(fixture.events, [['codeagent-usage-changed', { key: id }]]);
  assert.equal(fixture.menus(), 0);
});

test('serve-disabled IPC returns the saved read time without invoking serve or menu', async t => {
  const fixture = ipcFixture(t, { enabled: '0' });
  usage.recordUsage(fixture.dir, 'personal', serve.toUsageSnapshot(servedRead()), { now: 1000 });
  const result = await fixture.snapshot({ refresh: true });
  assert.equal(result.serveEnabled, false); assert.equal(result.rows[0].refresh.status, 'disabled');
  assert.equal(result.rows[0].creditAt, 1000); assert.equal(result.rows[0].cached, true);
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.menus(), 0);
});

test('serve exception and incomplete Credit preserve prior readings and expose a retryable failure', async t => {
  let read = async () => { throw new Error('socket closed'); };
  let clock = Date.now();
  const fixture = ipcFixture(t, { serveRead: args => read(args), now: () => clock });
  const saved = usage.recordUsage(fixture.dir, 'personal', serve.toUsageSnapshot(servedRead()), { now: 1000 });
  const failed = await fixture.snapshot({ refresh: true, key: 'personal' });
  assert.equal(failed.rows[0].refresh.error, 'socket closed');
  assert.deepEqual(failed.usage.personal, saved);
  const cooling = await fixture.snapshot({ refresh: true, key: 'personal' });
  assert.equal(cooling.rows[0].refresh.status, 'cooldown');
  assert.equal(cooling.rows[0].refresh.error, 'socket closed');
  assert.equal(fixture.calls.length, 1);
  clock += usage.CODEAGENT_SERVE_MAX_AGE_MS;
  read = async () => ({ ok: true, models: [], details: [], credit: [], quotas: {} });
  const incomplete = await fixture.snapshot({ refresh: true, key: 'personal' });
  assert.equal(incomplete.rows[0].refresh.status, 'failed');
  assert.match(incomplete.rows[0].refresh.error, /未读到 Credit/);
  assert.deepEqual(incomplete.usage.personal, saved); assert.equal(fixture.menus(), 0);
  assert.equal(fixture.events.length, 0);
});

test('missing login and invalid keys cannot launch a quota probe', async t => {
  const fixture = ipcFixture(t);
  fs.unlinkSync(path.join(fixture.personal, '.credentials.json'));
  const result = await fixture.snapshot({ refresh: true, key: 'personal' });
  assert.equal(result.ok, true); assert.equal(result.rows[0].state, 'login-required');
  assert.equal(result.rows[0].refresh.status, 'failed'); assert.equal(result.rows[0].hasReading, false);
  assert.match(result.rows[0].refresh.error, /先登录/);
  assert.equal((await fixture.snapshot({ refresh: true, key: 'missing' })).ok, false);
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.menus(), 0);
});

test('real IPC overlapping refreshes share each account and serialize the probe queue', async t => {
  let active = 0, maximum = 0;
  const fixture = ipcFixture(t, { serveRead: async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise(setImmediate);
    active--;
    return servedRead();
  } });
  fixture.add();
  const results = await Promise.all([fixture.snapshot({ refresh: true }), fixture.snapshot({ refresh: true })]);
  assert.equal(fixture.calls.length, 2); assert.equal(maximum, 1);
  assert.ok(results.every(result => result.rows.every(row => row.refresh.status === 'updated')));
});

test('CodeAgent creates a panel while company subscription quota remains closed even with native CLI kinds', () => {
  const company = panelAvailability({ kindAllowed: kind => ['codeagent', 'claude', 'codex'].includes(kind), featureEnabled: () => false });
  assert.deepEqual(company, { enabled: true, codeagent: true, providers: [] });
  const home = panelAvailability({ kindAllowed: kind => ['claude', 'gemini'].includes(kind), featureEnabled: () => true });
  assert.deepEqual(home, { enabled: true, codeagent: false, providers: ['claude', 'antigravity'] });
  assert.equal(panelAvailability({ kindAllowed: () => false, featureEnabled: () => true }).enabled, false);
});

test('company panel factory cannot render subscription accounts supplied by an old snapshot', () => {
  let created = 0, lookups = 0;
  const root = { hidden: false, innerHTML: '', classList: { toggle() {} }, addEventListener() {} };
  const footerRoot = { dataset: {}, querySelector: () => ({ prepend() { created++; } }) };
  const document = { createElement: () => { created++; return {}; } };
  const panel = createAccountQuotaPanel({ root, footerRoot, document, providers: [], setIntervalFn() {},
    getSnapshot: () => ({ accounts: { claude: [{ id: 'default' }, { id: 'second' }], codex: [{ id: 'default' }] } }),
    lookupLocations: async () => { lookups++; return {}; } });
  panel.render();
  assert.equal(root.hidden, true); assert.equal(root.innerHTML, '');
  assert.equal(footerRoot.dataset.panelProviders, ''); assert.equal(created, 0); assert.equal(lookups, 0);
});
