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

function ipcFixture(t, { serveRead = async () => servedRead(), enabled = '1', now = Date.now, app = null, autoMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quota-panel-'));
  const personal = path.join(dir, 'fake-cli');
  const vars = { CLAUDE_HUB_DATA_DIR: dir, AI_HUB_CODEAGENT_CONFIG_DIR: personal,
    AI_HUB_CODEAGENT_SERVE: enabled, CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0', CLAUDE_HUB_CODEAGENT_QUOTA_AUTO_MS: String(autoMs) };
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
    app,
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
  assert.match(incomplete.rows[0].refresh.error, /未读到额度/);
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

function timerFixture(t) {
  const auto = require('../core/codeagent-quota-auto-refresh');
  const create = auto.createQuotaAutoRefresh, timers = [], instances = [];
  t.mock.method(auto, 'createQuotaAutoRefresh', options => {
    const instance = create({ ...options, freeBytes: () => 4e9,
      setTimeoutFn: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
      clearTimeoutFn: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); } });
    instances.push(instance);
    return instance;
  });
  t.after(() => instances.forEach(instance => instance.stop()));
  return { timers, instances };
}

function tableRead() {
  return { ...servedRead(), models: ['Example-A', 'Example-B'],
    details: [{ id: 'Example-A' }, { id: 'Example-B' }],
    quotas: { 'Example-A': [{ type: 'TPD', used: 10, total: 100 }], 'Example-B': [{ type: 'TPD', used: 20, total: 100 }] } };
}

for (const first of ['timer', 'popup']) test(`real timer and popup share queued serve reads and publish once (${first} first)`, async t => {
  const timer = timerFixture(t);
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  let active = 0, maximum = 0;
  const fixture = ipcFixture(t, { autoMs: 10, serveRead: async args => {
    maximum = Math.max(maximum, ++active);
    if (args.configDir === fixture.personal) { started(); await held; }
    active--;
    return tableRead();
  } });
  t.after(release);
  const id = fixture.add();
  for (const key of ['personal', id]) {
    usage.recordUsage(fixture.dir, key, serve.toUsageSnapshot(tableRead()), { now: 1000, source: 'serve' });
    usage.markUsageDirty(fixture.dir, key);
  }
  const open = () => fixture.handlers.get('codeagent:usage-refresh')(null, { key: 'personal', open: true, force: true });
  let popup;
  if (first === 'timer') { timer.timers.shift().fn(); await reading; popup = open(); }
  else { popup = open(); await reading; timer.timers.shift().fn(); }
  const sidebar = fixture.snapshot({ key: 'personal', refresh: true });
  await new Promise(setImmediate);
  assert.equal(fixture.calls.length, 1, 'queued and running reads for the same account must be shared');
  release();
  const [opened, side] = await Promise.all([popup, sidebar, timer.instances[0].whenIdle()]);
  assert.equal(opened.ok, true); assert.equal(side.rows[0].refresh.status, 'updated');
  assert.equal(fixture.calls.length, 2); assert.equal(maximum, 1, 'different accounts remain serial');
  const cached = usage.readUsage(fixture.dir);
  for (const key of ['personal', id]) {
    assert.equal(cached[key].cleanVersion, cached[key].dirtyVersion);
    assert.ok(cached[key].fullModelsAt > 1000);
    assert.deepEqual(cached[key].models.map(model => model.name), ['Example-A', 'Example-B']);
    assert.equal(fixture.events.filter(([event, data]) => event === 'codeagent-usage-changed' && data.key === key).length, 1);
  }
  assert.deepEqual(require('../core/codeagent-models').readModelCatalog(fixture.dir, { configDir: fixture.personal }).models, tableRead().models);
  assert.equal((await fixture.handlers.get('codeagent:usage-refresh')(null, { key: 'personal', open: true })).outcome, 'current');
  assert.equal(fixture.calls.length, 2, 'a timer read also satisfies a later popup open');
  assert.equal(fixture.menus(), 0);
});

for (const partial of [false, true]) test(`timer quotas preserve a reply completed during the read (partial=${partial})`, async t => {
  const timer = timerFixture(t);
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  const fixture = ipcFixture(t, { autoMs: 10, serveRead: async args => {
    if (args.configDir !== fixture.personal) return tableRead();
    started(); await held;
    const result = tableRead();
    if (partial) delete result.quotas['Example-B'];
    return result;
  } });
  t.after(release); fixture.add();
  const saved = usage.recordUsage(fixture.dir, 'personal', serve.toUsageSnapshot(tableRead()), { now: 1000, source: 'serve' });
  usage.markUsageDirty(fixture.dir, 'personal');
  timer.timers.shift().fn(); await reading;
  usage.markUsageDirty(fixture.dir, 'personal');
  release(); await timer.instances[0].whenIdle();
  const cached = usage.readUsage(fixture.dir).personal;
  assert.equal(cached.dirtyVersion, 2); assert.equal(cached.cleanVersion, partial ? 0 : 1);
  assert.deepEqual(cached.models[1].day, saved.models[1].day);
  if (partial) {
    assert.equal(cached.fullModelsAt, saved.fullModelsAt);
    assert.equal(cached.models[1].at, saved.models[1].at); assert.equal(cached.models[1].quotaUnavailable, true);
  } else {
    assert.ok(cached.fullModelsAt > saved.fullModelsAt);
    assert.ok(cached.models[1].at > saved.models[1].at);
  }
  const logs = fs.readFileSync(path.join(fixture.dir, 'logs', 'codeagent-model.log'), 'utf8').trim().split('\n');
  assert.ok(logs.some(line => /event=serve-read\b/.test(line) && /account=personal\b/.test(line) && /reason=quota\b/.test(line)));
  assert.equal((await fixture.handlers.get('codeagent:usage-refresh')(null, { key: 'personal', open: true })).outcome, 'skipped');
  assert.equal(fixture.calls.length, 2); assert.equal(fixture.menus(), 0);
});

test('a manual popup refresh joins the same account while its sidebar read is still queued', async t => {
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  const fixture = ipcFixture(t, { serveRead: async args => {
    if (args.configDir !== fixture.personal) { started(); await held; }
    return tableRead();
  } });
  t.after(release);
  const id = fixture.add();
  const poolRead = fixture.snapshot({ key: id, refresh: true });
  await reading;
  const sidebar = fixture.snapshot({ key: 'personal', refresh: true });
  const popup = fixture.handlers.get('codeagent:usage-refresh')(null, { key: 'personal', force: true });
  await new Promise(setImmediate);
  assert.equal(fixture.calls.length, 1);
  release();
  const [, side, opened] = await Promise.all([poolRead, sidebar, popup]);
  assert.equal(side.rows[0].refresh.status, 'updated'); assert.equal(opened.ok, true);
  assert.equal(fixture.calls.length, 2, 'one pool read and one shared personal read');
  assert.equal(fixture.events.filter(([event, data]) => event === 'codeagent-usage-changed' && data.key === 'personal').length, 1);
});

test('registered quota cleanup uses the supplied app and waits until will-quit', t => {
  const timer = timerFixture(t), app = new (require('node:events').EventEmitter)();
  let shutdowns = 0;
  t.mock.method(serve, 'shutdownTempServes', () => { shutdowns++; });
  ipcFixture(t, { app, autoMs: 10 });
  assert.equal(timer.timers.length, 1);
  app.emit('before-quit');
  assert.equal(timer.timers.length, 1); assert.equal(shutdowns, 0);
  app.emit('will-quit');
  assert.equal(timer.timers.length, 0); assert.equal(shutdowns, 1);
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

test('automatic reading is serial, skips duplicates and single accounts, and backs off after failures', async () => {
  const { createCodeAgentQuotaPanel } = require('../core/codeagent-quota-panel');
  let clock = 1_000_000, active = 0, peak = 0;
  const calls = [];
  let failing = new Set();
  let status = { ok: true, personal: { state: 'ready', present: true }, accounts: [
    { id: 'a1', state: 'ready' }, { id: 'a2', state: 'login-required' }, { id: 'a3', state: 'ready', sameAsPersonal: true }, { id: 'a4', state: 'ready', duplicateOf: 'a1' }] };
  const panel = createCodeAgentQuotaPanel({ getStatus: () => status, readUsage: () => ({}), serveEnabled: () => true, now: () => clock,
    refreshAccount: async key => {
      calls.push(key); active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      if (failing.has(key)) throw new Error('boom');
    } });
  assert.deepEqual(await panel.refreshDue(), { read: 2, failed: 0, waiting: 0 });
  assert.deepEqual(calls, ['personal', 'a1']);
  assert.equal(peak, 1);
  // 失败后第一轮等 30 分钟，到点再试；手动刷新不受这个等待影响
  failing = new Set(['a1']);
  calls.length = 0; clock += 15 * 60000;
  assert.deepEqual(await panel.refreshDue(), { read: 1, failed: 1, waiting: 0 });
  calls.length = 0; clock += 15 * 60000;
  assert.deepEqual(await panel.refreshDue(), { read: 1, failed: 0, waiting: 1 });
  assert.deepEqual(calls, ['personal']);
  calls.length = 0; clock += 15 * 60000; failing = new Set();
  assert.deepEqual(await panel.refreshDue(), { read: 2, failed: 0, waiting: 0 });
  // 去重后只剩一个号：不显示额度栏，也不读
  status = { ok: true, personal: { state: 'ready', present: true }, accounts: [{ id: 'a3', state: 'ready', sameAsPersonal: true }] };
  calls.length = 0;
  assert.deepEqual(await panel.refreshDue(), { skipped: 'single-account' });
  assert.deepEqual(calls, []);
  // 没登录的个人账号不算一个号
  status = { ok: true, personal: { state: 'login-required', present: false }, accounts: [{ id: 'a1', state: 'ready' }] };
  assert.deepEqual(await panel.refreshDue(), { skipped: 'single-account' });
});

test('auto refresh waits for the previous round and skips a round when memory is low', { timeout: 10000 }, async () => {
  const { createQuotaAutoRefresh } = require('../core/codeagent-quota-auto-refresh');
  const timers = [], logs = [];
  let free = 4e9, runs = 0, finish;
  const auto = createQuotaAutoRefresh({ intervalMs: 100, firstDelayMs: 10, freeBytes: () => free, log: entry => logs.push(entry),
    run: () => { runs += 1; return runs > 1 ? Promise.resolve({ read: 1 }) : new Promise(resolve => { finish = resolve; }); },
    setTimeoutFn: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, clearTimeoutFn: () => {} });
  auto.start();
  assert.equal(timers.length, 1); assert.equal(timers[0].delay, 10);
  timers.shift().fn();
  await new Promise(setImmediate);
  assert.equal(runs, 1); assert.equal(timers.length, 0, 'next round is not scheduled while one is running');
  finish({ read: 2 }); await auto.whenIdle(); await new Promise(setImmediate);
  assert.equal(timers.length, 1); assert.equal(timers[0].delay, 100);
  assert.equal(logs[0].read, 2);
  free = 1e8;
  timers.shift().fn(); await auto.whenIdle(); await new Promise(setImmediate);
  assert.equal(runs, 1, 'a low-memory round must not start reading'); assert.equal(logs[1].skipped, 'low-memory');
  // 内存回来后下一轮照常读
  free = 4e9;
  timers.shift().fn(); await auto.whenIdle(); await new Promise(setImmediate);
  assert.equal(runs, 2); assert.equal(logs[2].read, 1);
  auto.stop();
  assert.equal(timers.length, 1);
  timers.shift().fn(); await auto.whenIdle(); await new Promise(setImmediate);
  assert.equal(timers.length, 0, 'stopped refresher does not schedule again');
});

test('automatic reading backs off up to six hours and no further', async () => {
  const { createCodeAgentQuotaPanel } = require('../core/codeagent-quota-panel');
  let clock = 1_000_000;
  const calls = [];
  const panel = createCodeAgentQuotaPanel({ getStatus: () => ({ ok: true, personal: { state: 'ready', present: true }, accounts: [{ id: 'bad', state: 'ready' }] }),
    readUsage: () => ({}), serveEnabled: () => true, now: () => clock,
    refreshAccount: async key => { calls.push(key); if (key === 'bad') throw new Error('boom'); } });
  const attempts = () => calls.filter(key => key === 'bad').length;
  const MIN = 60000, gaps = [];
  // 每轮失败后找到下一次真正重试的间隔
  await panel.refreshDue();
  for (let round = 0; round < 8; round += 1) {
    const before = attempts();
    let waited = 0;
    while (attempts() === before) { clock += 15 * MIN; waited += 15; await panel.refreshDue(); if (waited > 24 * 60) assert.fail('never retried'); }
    gaps.push(waited);
  }
  assert.deepEqual(gaps, [30, 60, 120, 240, 360, 360, 360, 360]);
});

function killLoggedServes(log) {
  let rows = [];
  try { rows = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { /* 还没起来 */ }
  for (const pid of rows.flatMap(row => [row.pid, row.child])) {
    if (!pid) continue;
    try { require('node:child_process').execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已退出 */ }
  }
}

test('a slow taskkill hands the rest to a background kill instead of giving up', async () => {
  const { killServeSync, killTree } = require('../core/codeagent-serve');
  const timedOut = Object.assign(new Error('spawnSync taskkill ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const calls = [], background = [];
  const exec = (file, args) => {
    calls.push(`${file} ${args.at(-1)}`);
    if (file === 'netstat') return '  TCP    127.0.0.1:5555   0.0.0.0:0   LISTENING   222\r\n';
    throw timedOut;
  };
  killServeSync(111, 5555, { exec, background: pid => background.push(pid) });
  assert.equal(calls[0], 'netstat TCP', 'the port owner is looked up before the tree is broken');
  assert.deepEqual(background, [111, 222]);
  // 已经退出（taskkill 报错但不是超时、进程也不在）不用再杀
  background.length = 0;
  killServeSync(999999, 5555, { exec: file => { if (file === 'netstat') return ''; throw new Error('not found'); }, background: pid => background.push(pid) });
  assert.deepEqual(background, []);
  // netstat 超时也不影响杀进程树
  const killed = [];
  killServeSync(111, 5555, { exec: (file, args) => { if (file === 'netstat') throw timedOut; killed.push(args.at(-1)); return ''; }, background: pid => background.push(pid) });
  assert.deepEqual(killed, ['111']);
  // 读完额度时的异步结束也一样
  background.length = 0;
  await killTree(333, { runner: async () => ({ error: { killed: true } }), background: pid => background.push(pid) });
  assert.deepEqual(background, [333]);
  background.length = 0;
  await killTree(333, { runner: async () => ({ error: { killed: false } }), background: pid => background.push(pid) });
  assert.deepEqual(background, []);
});

test('quitting ends the running temporary serve, its child and refuses new ones', { timeout: 240000 }, async t => {
  const serve = require('../core/codeagent-serve');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-serve-quit-'));
  const log = path.join(dir, 'fake.jsonl'), command = path.join(dir, 'fake-serve.cmd');
  let release = () => {};
  t.after(() => { release(); killLoggedServes(log); serve.resetTempServeShutdownForTest(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 进程刚退出时可能还占着 */ } });
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${path.join(__dirname, 'fixtures/codeagent-serve-fake/codeagent-serve-fake.js')}" %*\r\n`);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (check, what) => { const end = Date.now() + 90000; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } assert.fail(what); };
  const held = new Promise(resolve => { release = resolve; });
  const running = serve.withTempServe({ command, configDirEnv: 'CODEAGENT3_CONFIG_DIR', configDir: dir, cwd: dir, readyTimeoutMs: 120000, env: { ...process.env, SERVE_FAKE_LOG: log } }, async () => { await held; return { ok: true }; });
  await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim(), 'temporary serve started');
  const { pid, child, opts } = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
  assert.equal(opts.host, '127.0.0.1');
  assert.equal(alive(pid), true); assert.equal(alive(child), true);
  assert.equal(serve.shutdownTempServes(), 1);
  await waitFor(() => !alive(pid), 'serve process ended');
  await waitFor(() => !alive(child), 'serve child ended');
  release();
  await running;
  assert.equal(serve.shutdownTempServes(), 0, 'nothing is left to end');
  const refused = await serve.withTempServe({ command, configDirEnv: 'CODEAGENT3_CONFIG_DIR', configDir: dir, cwd: dir }, async () => assert.fail('must not start'));
  assert.deepEqual(refused, { ok: false, error: 'Hub 正在退出' });
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'no new serve was started after quitting');
});

// main.js 的 before-quit 会先拦下做会话收尾，收尾失败时窗口恢复、Hub 继续跑（restoreWindowAfterFailedShutdown）。
test('a failed shutdown leaves quota reading working; only will-quit stops it', { timeout: 240000 }, async t => {
  const { EventEmitter } = require('node:events');
  const { createCodeAgentQuotaPanel } = require('../core/codeagent-quota-panel');
  const { installQuotaQuitCleanup } = require('../core/codeagent-quota-auto-refresh');
  const serve = require('../core/codeagent-serve');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-serve-retry-'));
  const log = path.join(dir, 'fake.jsonl');
  t.after(() => { killLoggedServes(log); serve.resetTempServeShutdownForTest(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 进程刚退出时可能还占着 */ } });
  const command = path.join(dir, 'fake-serve.cmd');
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${path.join(__dirname, 'fixtures/codeagent-serve-fake/codeagent-serve-fake.js')}" %*\r\n`);
  const read = () => serve.withTempServe({ command, configDirEnv: 'CODEAGENT3_CONFIG_DIR', configDir: dir, cwd: dir, readyTimeoutMs: 120000, env: { ...process.env, SERVE_FAKE_LOG: log } }, async ({ get }) => ({ ok: (await get('/api/v1/global/health')).ok }));
  const app = new EventEmitter();
  let stopped = 0, clock = 1000;
  installQuotaQuitCleanup({ app, stopAutoRefresh: () => { stopped += 1; }, shutdownServes: () => serve.shutdownTempServes() });
  const panel = createCodeAgentQuotaPanel({ getStatus: () => ({ ok: true, personal: { state: 'ready', present: true }, accounts: [] }), readUsage: () => ({}), serveEnabled: () => true, now: () => clock,
    refreshAccount: async () => { const result = await read(); if (!result.ok) throw new Error(result.error); } });
  // 收尾失败：before-quit 来过，will-quit 没来，刷新额度和读模型都还能用
  app.emit('before-quit', { preventDefault() {} });
  assert.equal(stopped, 0);
  const after = await panel.snapshot({ refresh: true, key: 'personal' });
  assert.equal(after.rows[0].refresh.status, 'updated', after.rows[0].refresh.error || '');
  // 真的退出
  app.emit('will-quit', { preventDefault() {} });
  assert.equal(stopped, 1);
  assert.deepEqual(await read(), { ok: false, error: 'Hub 正在退出' });
});

test('a real serve still ends when every synchronous kill times out', { timeout: 240000 }, async t => {
  const serve = require('../core/codeagent-serve');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-serve-starved-'));
  const log = path.join(dir, 'fake.jsonl'), command = path.join(dir, 'fake-serve.cmd');
  let release = () => {};
  t.after(() => { release(); killLoggedServes(log); serve.resetTempServeShutdownForTest(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 进程刚退出时可能还占着 */ } });
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${path.join(__dirname, 'fixtures/codeagent-serve-fake/codeagent-serve-fake.js')}" %*\r\n`);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (check, what) => { const end = Date.now() + 90000; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } assert.fail(what); };
  const held = new Promise(resolve => { release = resolve; });
  const running = serve.withTempServe({ command, configDirEnv: 'CODEAGENT3_CONFIG_DIR', configDir: dir, cwd: dir, readyTimeoutMs: 120000, env: { ...process.env, SERVE_FAKE_LOG: log } }, async () => { await held; return { ok: true }; });
  await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim(), 'temporary serve started');
  const { pid, child } = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
  assert.equal(serve.shutdownTempServes({ killSync: (target, port) => serve.killServeSync(target, port, { timeoutMs: 1 }) }), 1);
  await waitFor(() => !alive(pid), 'serve process ended by the background kill');
  await waitFor(() => !alive(child), 'serve child ended by the background kill');
  release();
  await running;
});
