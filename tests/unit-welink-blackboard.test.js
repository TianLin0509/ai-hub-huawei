'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { WelinkBlackboard, compareVersions, proxyHint, LEASE_MS } = require('../core/company-assistant/welink-blackboard');
const { WelinkGate, withWelinkCaller, withWelinkPriority, rateLimited } = require('../core/company-assistant/welink-gate');
const { registerWelinkBlackboardIpc } = require('../main/ipc/welink-blackboard-handlers');
const reply = stdout => ({ code: 0, stdout, stderr: '' });
function fixture(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-blackboard-'));
  let clock = 2000000000000;
  const now = () => clock, sleep = async ms => { clock += ms; };
  const board = new WelinkBlackboard({ dataDir: root, now, sleep, env: {}, ...opts });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, board, now, sleep, advance: ms => { clock += ms; } };
}
function ipc(board, options = {}) {
  const handlers = new Map(), events = [];
  const registration = registerWelinkBlackboardIpc({ handle: (name, handler) => handlers.set(name, handler) }, { blackboard: board, sendToRenderer: (...args) => events.push(args), ...options });
  return { invoke: (name, request) => handlers.get('welink-blackboard:' + name)(null, request), handlers, events, registration };
}
test('isolated directories, default schema and semver boundary including prereleases', t => {
  const { board, root } = fixture(t);
  assert.equal(board.file, path.join(root, 'company-assistant', 'welink-blackboard.json'));
  for (const [v, old] of [['1.0.19', true], ['1.0.20', false], ['1.0.20-beta.1', true], ['1.1.0', false]]) { board.announceCli({ path: 'fixture.exe', version: v }); assert.equal(board.read().cli.outdated, old); }
  assert.equal(compareVersions('invalid'), null);
  assert.equal(compareVersions('v1.0.20+build', '1.0.20'), 0);
  assert.equal(Object.keys(board.read().callers).length, 7);
  assert.equal(new WelinkBlackboard({ env: { HUB_DATA_DIR: root } }).dir, board.dir);
});
test('atomic lock contention, expired lease and dead PID recovery', async t => {
  const { board, advance } = fixture(t);
  const first = board.tryAcquire('assistant', ['auth', 'login']);
  assert.ok(first); assert.equal(board.tryAcquire('phone', 'im query'), null);
  advance(LEASE_MS + 1);
  const second = board.tryAcquire('phone', 'im query'); assert.ok(second);
  board.release(first); assert.equal(board.readJson(board.lockFile).id, second.token.id);
  board.release(second);
  fs.writeFileSync(board.lockFile, JSON.stringify({ pid: 99999999, owner: 'external', expiresAt: board.now() + LEASE_MS }));
  const third = board.tryAcquire('join', 'im query'); assert.ok(third); board.release(third);
  fs.writeFileSync(board.lockFile, '{');
  fs.utimesSync(board.lockFile, new Date(board.now() - LEASE_MS * 2), new Date(board.now() - LEASE_MS * 2));
  const fourth = board.tryAcquire(); assert.ok(fourth); board.release(fourth);
});
test('a lock released between exclusive-create and stat is retried, never treated as unavailable I/O', async t => {
  const fakeFs = Object.create(fs); let first = true;
  fakeFs.openSync = (file, flags, ...rest) => {
    if (String(file).endsWith('welink-blackboard.lock') && flags === 'wx' && first) { first = false; throw Object.assign(new Error('released concurrently'), { code: 'EEXIST' }); }
    return fs.openSync(file, flags, ...rest);
  };
  const { board } = fixture(t, { fsModule: fakeFs });
  await board.withLock('assistant', ['auth', 'status'], handle => { assert.ok(handle?.token); assert.equal(board.record({ caller: 'assistant', args: ['auth', 'status'] }), true); });
  assert.equal(board.read().callers.assistant.calls1h, 1);
});
test('creation and release cannot cross the stale-lock recovery guard', t => {
  const { board, advance } = fixture(t);
  const old = board.tryAcquire('assistant', ['auth', 'status']); advance(LEASE_MS + 1);
  const guard = board.acquireGuard(); assert.ok(guard && !guard.unavailable);
  board.release(old); assert.equal(board.tryAcquire('phone', ['auth', 'status']), null);
  board.releaseGuard(guard);
  const replacement = board.tryAcquire('phone', ['auth', 'status']); assert.ok(replacement?.token);
  board.release(old); assert.equal(board.readJson(board.lockFile).id, replacement.token.id); board.release(replacement);
});
test('separate Node processes serialize command leases and retain every record', async t => {
  const { root } = fixture(t);
  const moduleFile = require.resolve('../core/company-assistant/welink-blackboard');
  const board = new WelinkBlackboard({ dataDir: root });
  fs.mkdirSync(board.dir, { recursive: true });
  fs.writeFileSync(board.lockFile, JSON.stringify({ id: 'abandoned', pid: 99999999, expiresAt: 0 }));
  const script = `const {WelinkBlackboard}=require(${JSON.stringify(moduleFile)}); const b=new WelinkBlackboard({dataDir:process.argv[1]}); (async()=>{ for(let i=0;i<6;i++) await b.withLock('welink-ro','im query',async(handle)=>{if(!handle)throw Error('lock unavailable '+JSON.stringify(b.lastIoFailure));const before=b.read().samples.length; await new Promise(r=>setTimeout(r,5)); if(b.read().samples.length!==before)throw Error('overlap'); if(!b.record({caller:'welink-ro',args:['im','query'],status:'ok'}))throw Error('metadata write failed '+JSON.stringify(b.lastIoFailure));}); })().catch(e=>{console.error(e);process.exitCode=1;});`;
  const child = () => new Promise((resolve, reject) => execFile(process.execPath, ['-e', script, root], { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
  await Promise.all([child(), child(), child()]);
  assert.equal(new WelinkBlackboard({ dataDir: root }).read().callers['welink-ro'].calls1h, 18);
});
test('shared logout stops a second keeper from automatic renewal until manual success', async t => {
  const { board, now } = fixture(t);
  const { AuthKeeper } = require('../core/company-assistant/auth-keeper');
  let logins = 0;
  const assistant = () => ({ blackboard: board, now, read: () => ({}), write: () => {}, changed: () => {}, rawWelink: async args => { if (args[1] === 'login') logins++; return reply('Status: not authenticated'); } });
  const a = new AuthKeeper(assistant()), b = new AuthKeeper(assistant());
  a.signedOut(); assert.equal(b.status().state, 'signed-out');
  await b.check({ force: true }); assert.equal(logins, 0);
  b.manualSucceeded({ ok: true, uid: 'fixture' }); assert.equal(board.read().auth.state, 'online');
  a.close(); b.close();
});
test('logout during an in-flight auth probe cannot be overwritten by its stale result', async t => {
  const { board, now } = fixture(t);
  const { AuthKeeper } = require('../core/company-assistant/auth-keeper');
  let release, logins = 0;
  const result = new Promise(resolve => { release = resolve; });
  const b = new AuthKeeper({ blackboard: board, now, read: () => ({}), write: () => {}, changed: () => {}, rawWelink: args => args[1] === 'status' ? result : (logins++, Promise.resolve(reply('done'))) });
  const check = b.check({ force: true });
  board.setAuth({ state: 'signed_out' }); release(reply('Status: not authenticated'));
  await check; assert.equal(logins, 0); assert.equal(board.read().auth.state, 'signed_out');
  assert.equal(board.setAuth({ state: 'online' }), false); assert.equal(board.read().auth.state, 'signed_out'); b.close();
});
test('conservative policy spaces shared group-history calls while default path retains its cadence', async t => {
  const { board, now, sleep } = fixture(t);
  board.updatePolicy({ groupReadMode: 'conservative_30s' });
  const first = new WelinkGate({ blackboard: board, now, sleep }), second = new WelinkGate({ blackboard: board, now, sleep });
  const times = [];
  const run = () => { times.push(now()); return reply('{}'); };
  const groupArgs = ['im', 'query-history-message', '--group-id', 'fixture'];
  await first.run(groupArgs, run); await second.run(groupArgs, run);
  assert.ok(times[1] - times[0] >= 30000);
  await first.run(['im', 'query-history-message', '--user-account', 'fixture'], run);
  assert.ok(times[2] - times[1] < 30000); first.flush(); second.flush();
});
test('explicit IPC mutations report failed persistence, with logout preserving CLI success', async t => {
  const { board } = fixture(t);
  board.atomicWrite = () => false;
  const app = ipc(board, { service: { logout: async () => ({ ok: true }) } });
  for (const [name, args] of [['update-policy', { groupReadMode: 'conservative_30s' }], ['clear-events', {}], ['clear-cooldown', {}]]) {
    const result = await app.invoke(name, args); assert.equal(result.ok, false); assert.match(result.error, /未保存/);
  }
  const out = await app.invoke('logout', { confirmed: true }); assert.equal(out.ok, true); assert.match(out.warning, /已退出/); app.registration.dispose();
});
test('login QR and installer progress changes push once while unchanged notifications remain silent', t => {
  const { board } = fixture(t);
  const service = { loginFlow: null }, app = ipc(board, { service });
  board.notify(); assert.equal(app.events.length, 0);
  service.loginFlow = { state: 'waiting', qr: { value: 'data:image/svg+xml;base64,example' } };
  board.notify(); board.notify(); assert.equal(app.events.length, 1);
  service.loginFlow = { state: 'ok' }; board.notify(); assert.equal(app.events.length, 2); app.registration.dispose();
});
test('beforeRun rechecks after lease waiting and deadline expiry prevents actual execution', async t => {
  const { board, now, advance } = fixture(t); let checked = 0, executed = 0;
  const holder = board.tryAcquire('external', ['im', 'query-group-member']);
  board.sleep = async ms => { advance(ms); board.release(holder); };
  const gate = new WelinkGate({ blackboard: board, now, sleep: board.sleep });
  await assert.rejects(gate.run(['im', 'query-group-member'], () => { executed++; return reply('{}'); }, { deadline: now() + 50, beforeRun: () => { checked++; } }), /时限/);
  assert.equal(executed, 0); assert.equal(checked, 0); gate.flush();
  const holder2 = board.tryAcquire('external', ['im', 'query-group-member']);
  board.sleep = async ms => { advance(ms); board.release(holder2); };
  const gate2 = new WelinkGate({ blackboard: board, now, sleep: board.sleep });
  await assert.rejects(gate2.run(['im', 'query-group-member'], () => { executed++; return reply('{}'); }, { beforeRun: () => { checked++; throw Error('cancelled-before-send'); } }), /cancelled-before-send/);
  assert.equal(executed, 0); assert.equal(checked, 1); gate2.flush();
});
test('Windows atomic rename retries EPERM/EBUSY three times and cleans only its temp file', t => {
  let renames = 0;
  const fakeFs = Object.create(fs);
  fakeFs.renameSync = (...args) => { if (String(args[1]).endsWith('welink-blackboard.json') && ++renames <= 3) throw Object.assign(new Error('busy'), { code: renames % 2 ? 'EPERM' : 'EBUSY' }); return fs.renameSync(...args); };
  const { board } = fixture(t, { fsModule: fakeFs, retrySleepSync: () => {} });
  assert.equal(board.announceCli({ path: 'fixture.exe' }), true); assert.equal(renames, 4);
  fakeFs.renameSync = (...args) => { if (String(args[1]).endsWith('welink-blackboard.json')) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return fs.renameSync(...args); };
  assert.equal(board.announceCli({ path: 'other.exe' }), false);
  assert.equal(board.read().cli.path, 'fixture.exe');
  assert.deepEqual(fs.readdirSync(board.dir), ['welink-blackboard.json']);
});
test('I/O failure preserves business result and sync/async callbacks', async t => {
  const fakeFs = Object.create(fs); fakeFs.mkdirSync = () => { throw new Error('readonly'); };
  const { board } = fixture(t, { fsModule: fakeFs });
  const gate = new WelinkGate({ blackboard: board });
  assert.deepEqual(await gate.run(['--version'], () => reply('1.0.20')), reply('1.0.20'));
  assert.equal(await board.withLock('assistant', 'query', () => 5), 5);
  assert.equal(board.withLockSync('assistant', 'query', () => 7), 7); gate.flush();
});
test('one-hour rolling counts, most recent 30 events and strict metadata allowlist', t => {
  const { board, advance } = fixture(t);
  for (let i = 0; i < 35; i++) {
    board.record({ caller: 'avatar', args: ['im', 'send-to-group', '--message', 'private-body', '--token', 'secret-value', '--phone', '13800000000'], durationMs: 123, status: i % 2 ? 'ok' : 'rate_limited', stdout: 'private-body' }); advance(1);
  }
  board.setAuth({ state: 'needs-scan', accountLabel: 'sensitive-id', error: 'secret-value', login: { uid: 'sensitive-id' } });
  const raw = fs.readFileSync(board.file, 'utf8');
  assert.equal(JSON.parse(raw).callers.avatar.calls1h, 35);
  for (const forbidden of ['private-body', 'secret-value', '13800000000', 'sensitive-id', '--token']) assert.equal(raw.includes(forbidden), false);
  const s = board.buildSnapshot(); assert.equal(s.events.length, 30); assert.equal(s.callers.avatar.calls1h, 35); assert.equal(s.callers.avatar.ok1h, 17); assert.equal(s.callers.avatar.rateLimited1h, 18);
  assert.equal(s.events[0].command, 'im send-to-group'); assert.ok(s.events[0].at > s.events.at(-1).at);
  const lastAt = s.callers.avatar.lastAt;
  advance(3600000); assert.equal(board.buildSnapshot().callers.avatar.calls1h, 0); assert.equal(board.read().samples.length, 0);
  assert.equal(board.buildSnapshot().callers.avatar.lastAt, lastAt); assert.equal(board.buildSnapshot().callers.avatar.lastStatus, 'rate_limited');
});
test('HTTP and business JSON 429 recognition excludes message IDs and successful retry warnings', () => {
  for (const result of [{ code: 429 }, { statusCode: 429 }, { code: 1, stderr: 'HTTP 429' }, { code: 1, stderr: 'HTTP/1.1 429 Too Many Requests' }, reply('{"status":429}'), reply('{"code":429}'), reply('{"resultCode":"429"}'), reply('{"error":{"error_code":429}}')]) assert.equal(rateLimited(result), true);
  for (const result of [reply('{"code":0,"data":{"messageId":"429","content":"HTTP 429"}}'), reply('{"msgId":1429000}'), { code: 0, stdout: '{}', stderr: 'retry HTTP 429' }]) assert.equal(rateLimited(result), false);
});
test('shared cooldown is honored before executing and shared 429 propagates between gates', async t => {
  const { board, now, sleep, advance } = fixture(t);
  board.record({ caller: 'avatar', args: ['im', 'query'], status: 'rate_limited' });
  const gate = new WelinkGate({ blackboard: board, now, sleep });
  const start = now(); let executed;
  await gate.run(['im', 'query'], () => { executed = now(); return reply('{}'); }, { caller: 'phone' });
  assert.ok(executed - start >= 30000); assert.equal(board.read().callers.phone.calls1h, 1);
  let count = 0;
  await withWelinkCaller('feedback', () => withWelinkPriority('user', () => gate.run(['mail', 'get'], () => ++count === 1 ? reply('{"resultCode":429}') : reply('{}'))));
  assert.equal(board.read().callers.feedback.rateLimited1h, 1); assert.ok(now() >= start + 60000);
  advance(1); gate.flush();
});
test('login shares critical section for full asynchronous duration and self heals abandoned authBusy', async t => {
  const { board, now, sleep, advance } = fixture(t);
  const gate = new WelinkGate({ blackboard: board, now, sleep });
  await gate.run(['auth', 'login'], async () => { assert.equal(board.read().authBusy.op, 'auth login'); assert.equal(board.tryAcquire('external', 'query'), null); return reply('done'); });
  assert.equal(board.read().authBusy, null);
  board.setAuthBusy('assistant', ['auth', 'login']); advance(360001); assert.equal(board.read().authBusy, null); gate.flush();
});
test('proxy errors classify 407, 504 and refused connections without exposing original diagnostics', () => {
  assert.match(proxyHint('407 Proxy Authentication Required'), /认证.*407/);
  assert.match(proxyHint('HTTP 504 Gateway Timeout'), /超时.*504/);
  assert.match(proxyHint({ cause: { message: 'ECONNREFUSED proxy.corp.example' } }), /代理/);
  assert.equal(proxyHint('unrelated'), '');
});
test('snapshot health, lockHolder and red-zone advice derive from shared state', t => {
  const { board } = fixture(t);
  assert.equal(board.buildSnapshot().health, 'error');
  board.announceCli({ path: 'fixture.exe', version: '1.0.20' }); board.setAuth({ state: 'online' });
  assert.equal(board.buildSnapshot().health, 'healthy');
  board.setAuth({ state: 'needs_scan' }); assert.match(board.buildSnapshot().advice.redZoneNote, /无摄像头/);
  const handle = board.tryAcquire('phone', ['im', 'query']);
  assert.equal(board.buildSnapshot().lockHolder.owner, 'phone'); board.release(handle);
});
test('nine IPC channels, confirmed logout, event-driven summary dedupe and persistent policy', async t => {
  const { board } = fixture(t); let logouts = 0;
  const app = ipc(board, { service: { blackboard: board, logout: async () => { logouts++; return { ok: true }; } } });
  assert.equal(app.handlers.size, 9); assert.equal((await app.invoke('logout', {})).ok, false); assert.equal(logouts, 0);
  assert.equal((await app.invoke('logout', { confirmed: true })).ok, true); assert.equal(logouts, 1); assert.equal(board.read().auth.state, 'signed_out');
  const count = app.events.length;
  await app.invoke('snapshot'); await app.invoke('snapshot'); assert.equal(app.events.length, count);
  assert.equal((await app.invoke('update-policy', { groupReadMode: 'conservative_30s' })).ok, true);
  assert.equal(board.read().policy.groupReadMode, 'conservative_30s'); assert.equal((await app.invoke('update-policy', { groupReadMode: 'bad' })).ok, false);
  board.record({ caller: 'phone', args: ['im', 'query'] }); await app.invoke('clear-events'); assert.equal(board.read().events.length, 0);
  const disabled = ipc(board, { enabled: false }); assert.equal((await disabled.invoke('snapshot')).ok, false); assert.equal(disabled.events.length, 0); app.registration.dispose(); disabled.registration.dispose();
});
test('read-only tool prefers announced CLI and respects shared cooldown and statistics', async t => {
  const { board, now, sleep } = fixture(t);
  board.announceCli({ path: 'announced-cli.exe', version: '1.0.20' }); board.record({ caller: 'avatar', args: ['im', 'query'], status: 'rate_limited' });
  const start = now(); let used;
  const result = await require('../core/company-assistant/welink-ro').runReadOnly(['im', 'query-group-member', '--group-id', 'example'], { blackboard: board, gateOptions: { now, sleep }, run: async (_args, opts) => { used = opts.cli; assert.ok(now() - start >= 30000); return reply('{}'); } });
  assert.equal(used, 'announced-cli.exe'); assert.equal(result.code, 0); assert.equal(board.read().callers['welink-ro'].ok1h, 1);
});
test('stub file supplies controlled snapshots and operations never call real service', async t => {
  const { root, board } = fixture(t);
  board.env.WELINK_BLACKBOARD_STUB_FILE = path.join(root, 'stub.json');
  fs.writeFileSync(board.env.WELINK_BLACKBOARD_STUB_FILE, JSON.stringify({ cli: { path: 'fixture', version: '1.0.19', outdated: true }, auth: { state: 'needs_scan' }, headline: '受控状态', health: 'warning' }));
  const app = ipc(board, { service: { login: () => { throw Error('must not execute'); }, logout: () => { throw Error('must not execute'); } } });
  assert.equal((await app.invoke('snapshot')).snapshot.headline, '受控状态');
  assert.equal((await app.invoke('start-login')).flow.active, true); assert.equal((await app.invoke('logout', {})).ok, false);
  assert.equal((await app.invoke('logout', { confirmed: true })).snapshot.auth.state, 'signed_out');
  assert.equal(fs.existsSync(board.file), false); app.registration.dispose();
});
test('C01/C02/C03/C04/C05/C07 review regressions stay fixed end-to-end', async t => {
  const { root, board, now, sleep } = fixture(t);
  const { qrSvgDataUri } = require('../core/company-assistant/welink');
  const page = require('../renderer/welink-blackboard-page');
  // C07: setAuth online does not fabricate desktopOnline=true without a desktop probe
  board.announceCli({ path: 'fixture.exe', version: '1.0.20' });
  board.setAuth({ state: 'online' });
  assert.equal(board.read().auth.desktopOnline, null);
  board.setAuth({ state: 'desktop_unavailable' });
  assert.equal(board.read().auth.desktopOnline, false);
  board.setAuth({ state: 'online' });

  // C01 & C02: real qrSvgDataUri data URL renders in online state through real IPC
  const dataUri = qrSvgDataUri(Array.from({ length: 21 }, () => Array(21).fill(true))).value;
  assert.match(dataUri, /^data:image\/svg\+xml;base64,/);
  let installs = 0, lastUpgrade = null;
  const service = {
    blackboard: board,
    loginFlow: { state: 'waiting', qr: { value: dataUri }, url: null, progress: { text: '等待扫码' } },
    installCli: async ({ upgrade = false } = {}) => { installs++; lastUpgrade = upgrade; return { ok: true }; },
    refreshWelinkBlackboard: async () => {},
  };
  const app = ipc(board, { service });
  const snap = (await app.invoke('snapshot')).snapshot;
  assert.equal(snap.health, 'healthy');
  const html = page.pageHtml(page.viewModel(snap, { now: now() }));
  assert.match(html, /class="wbb-login"[\s\S]*<img src="data:image\/svg\+xml;base64,/);

  // C03: ordinary successful record pushes changed event even while health remains healthy
  const pushesBefore = app.events.length;
  board.record({ caller: 'avatar', args: ['im', 'query-history-message'], durationMs: 80, status: 'ok' });
  assert.ok(app.events.length > pushesBefore, 'ordinary record must notify renderer');

  // C04: explicit upgrade invokes installer even when already at minimum recommended version
  const up = await app.invoke('install-cli', { upgrade: true });
  assert.equal(up.ok, true); assert.equal(installs, 1); assert.equal(lastUpgrade, true);
  app.registration.dispose();

  // C05: read-only/unwritable blackboard keeps local 30s cooldown on 429
  const roFs = { ...fs, mkdirSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, writeFileSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  const roBoard = new WelinkBlackboard({ dataDir: path.join(root, 'ro'), fsModule: roFs, now, sleep, retrySleepSync: () => {} });
  const gate = new WelinkGate({ blackboard: roBoard, now, sleep });
  let calls = 0; const start = now();
  const r = await gate.run(['im', 'query-history-message'], async () => (++calls === 1 ? reply('{"code":"429"}', 0) : reply('{"code":"0"}', 0)));
  assert.equal(r.code, 0); assert.equal(calls, 2); assert.ok(now() - start >= 30000, 'must wait 30s locally when blackboard write fails');
  gate.flush();
});

test('P1-1: network_error and unknown states use refresh primary action without red-zone note', t => {
  const { board, now } = fixture(t);
  const page = require('../renderer/welink-blackboard-page');
  board.announceCli({ path: 'fixture.exe', version: '1.0.20' });
  for (const state of ['network_error', 'unknown']) {
    board.setAuth({ state });
    const snap = board.buildSnapshot();
    assert.equal(snap.advice.primaryAction, 'refresh', `${state} primaryAction must be refresh`);
    assert.equal(snap.advice.redZoneNote, '', `${state} must not attach redZoneNote`);
    const vm = page.viewModel(snap, { now: now() });
    assert.equal(vm.advice.primary.id, 'refresh', `${state} rendered primary must be refresh`);
    assert.equal(vm.advice.redZoneNote, '', `${state} rendered advice must not show red-zone note`);
    const html = page.pageHtml(vm);
    assert.match(html, /data-wbb="act:refresh"/);
    assert.doesNotMatch(html, /class="wbb-advice[^"]*"[\s\S]*data-wbb="act:start-login"/);
    assert.doesNotMatch(html, /红区无摄像头/);
  }
});

test('P1-2: refreshWelinkBlackboard recovers from signed_out via manualSucceeded and classifies expired non-zero exit as needs_scan', async t => {
  const { root, board } = fixture(t);
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const cliFile = path.join(root, 'welink-cli.exe');
  fs.writeFileSync(cliFile, 'stub');
  let authStatusReply = { code: 1, stdout: '', stderr: 'Status: not authenticated' };
  const service = new CompanyAssistant({
    dataDir: root, blackboard: board, noTools: true,
    welinkAccounts: () => ({ client: null, cli: null, mismatch: null }),
    welinkRun: async args => args[0] === '--version' ? reply('1.0.20') : authStatusReply,
  });
  t.after(() => service.close());
  service.setSettings({ cliPath: cliFile, cliPathManual: false });

  // Non-zero exit with expired/not-authenticated output must be needs_scan, not network_error.
  await service.refreshWelinkBlackboard();
  assert.equal(board.read().auth.state, 'needs_scan');

  // After explicit logout, a manual refresh detecting a logged-in CLI must restore online on both board and AuthKeeper.
  service.auth.signedOut();
  assert.equal(board.read().auth.state, 'signed_out');
  authStatusReply = { code: 0, stdout: 'Status: authenticated\nUser ID: u1001\n', stderr: '' };
  await service.refreshWelinkBlackboard();
  assert.equal(board.read().auth.state, 'online');
  assert.equal(service.auth.status().state, 'online');
});

test('P1-3: refreshWelinkBlackboard during waiting loginFlow does not block on login lock and resolves online via direct probe', async t => {
  const { root, board } = fixture(t);
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const cliFile = path.join(root, 'welink-cli.exe');
  fs.writeFileSync(cliFile, 'stub');
  let loginAborted = false, probeOnline = false, seenDeadlines = [];
  const service = new CompanyAssistant({
    dataDir: root, blackboard: board, noTools: true, loginRefreshWaitMs: 30,
    welinkAccounts: () => ({ client: null, cli: null, mismatch: null }),
    welinkRun: async (args, opts) => {
      if (Number.isFinite(opts?.deadline)) seenDeadlines.push(opts.deadline);
      if (args[0] === '--version') return reply('1.0.20');
      if (args[0] === 'auth' && args[1] === 'login') {
        opts?.onData?.('请使用 WeLink 扫码登录\nhttps://example.invalid/qr');
        return await new Promise((resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => { loginAborted = true; reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })); }, { once: true });
        });
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        return probeOnline ? reply('Status: authenticated\nUser ID: u1002\n') : { code: 1, stdout: '', stderr: 'Not logged in' };
      }
      return reply('{}');
    },
  });
  t.after(() => service.close());
  service.setSettings({ cliPath: cliFile, cliPathManual: false });

  await service.startLogin();
  assert.equal(service.loginFlow?.state, 'waiting');
  assert.equal(board.tryAcquire('external', 'check'), null, 'login must hold blackboard lock while waiting');

  probeOnline = true;
  const startedAt = Date.now();
  await service.refreshWelinkBlackboard();
  assert.ok(Date.now() - startedAt < 3000, 'refresh during waiting login must return promptly without waiting on login lock');
  assert.equal(loginAborted, true, 'verified online probe must abort hanging login process');
  assert.equal(service.loginFlow?.state, 'ok');
  assert.equal(board.read().auth.state, 'online');
  assert.equal(service.auth.status().state, 'online');

  // Outside waiting loginFlow, refreshWelinkBlackboard passes a <=15s deadline to rawWelink.
  seenDeadlines = [];
  const before = Date.now();
  await service.refreshWelinkBlackboard();
  assert.ok(seenDeadlines.length >= 2);
  for (const d of seenDeadlines) assert.ok(d - before <= 16000 && d - before >= 10000);
});

test('P2-4/P2-5/P2-7: managed cli.source preserved, AUTH_FAILURE & --version stats rules, non-company skips disk reads', async t => {
  const { root, board } = fixture(t);
  const { CompanyAssistant } = require('../core/company-assistant/service');
  // P2-4: managed CLI install keeps cliPathManual=false and cli.source='managed' across refresh
  const service = new CompanyAssistant({
    dataDir: root, blackboard: board, noTools: true,
    resolveCli: ({ configured }) => configured || null,
    welinkAccounts: () => ({ client: null, cli: null, mismatch: null }),
    welinkRun: async args => args[0] === '--version' ? reply('1.0.20') : reply('Status: authenticated\nUser ID: u1003\n'),
  });
  t.after(() => service.close());
  const managedDir = path.join(service.dir, 'tools', 'welink-cli', '1.0.20');
  fs.mkdirSync(managedDir, { recursive: true });
  const managedExe = path.join(managedDir, 'welink-cli.exe');
  fs.writeFileSync(managedExe, 'MZstub');
  service.useCliPath(managedExe, { manual: false });
  assert.equal(service.settings().cliPathManual, false);
  await service.refreshWelinkBlackboard();
  assert.equal(board.read().cli.source, 'managed');

  // P2-5: AUTH_FAILURE recognizes 1.0.20 "Status: not authenticated"; --version/--help skip stats & lastSuccessAt
  const { board: b2, now, sleep } = fixture(t);
  const gate = new WelinkGate({ blackboard: b2, now, sleep });
  await gate.run(['--version'], () => reply('1.0.20'));
  await gate.run(['im', '--help'], () => reply('usage'));
  assert.equal(b2.read().callers.assistant.calls1h, 0);
  assert.equal(b2.read().events.length, 0);
  assert.equal(b2.buildSnapshot().lastSuccessAt, 0);
  await gate.run(['im', 'list-chats'], () => ({ code: 1, stdout: 'Status: not authenticated', stderr: '' }));
  assert.equal(b2.read().events[0].status, 'auth_error');
  gate.flush();

  // P2-7: enabled=false registers handlers without instantiating blackboard or reading disk
  let diskReads = 0;
  const fakeBoard = { read() { diskReads++; throw Error('must not read'); }, buildSnapshot() { diskReads++; throw Error('must not snapshot'); }, subscribe() { diskReads++; return () => {}; } };
  const handlers = new Map();
  const reg = registerWelinkBlackboardIpc({ handle: (n, f) => handlers.set(n, f) }, { enabled: false, blackboard: fakeBoard });
  assert.equal(diskReads, 0);
  assert.equal(handlers.size, 9);
  assert.equal((await handlers.get('welink-blackboard:snapshot')(null, {})).ok, false);
  reg.dispose();
  // Passing no blackboard at all with enabled=false also does not throw or read disk.
  const handlers2 = new Map();
  const reg2 = registerWelinkBlackboardIpc({ handle: (n, f) => handlers2.set(n, f) }, { enabled: false });
  assert.equal(reg2.snapshot(), null);
  assert.equal((await handlers2.get('welink-blackboard:snapshot')(null, {})).ok, false);
  reg2.dispose();
});
