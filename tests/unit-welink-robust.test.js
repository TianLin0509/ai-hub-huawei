'use strict';
// welink-cli 对接加固（2026-11-06）：报错说人话、令牌作废按过期、exe 被占用自动重试、
// 提问复用刚核实的登录、已提示扫码后仍悄悄重试、手动登录成功即时显示。全部为合成输出。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../core/company-assistant/welink');
const { AuthKeeper, SCAN_LIMIT, SLOW_RETRY_MS } = require('../core/company-assistant/auth-keeper');
const { CompanyAssistant } = require('../core/company-assistant/service');

const NOW = Date.parse('2026-11-06T10:00:00+08:00');
const reply = (stdout, code = 0) => ({ code, stdout, stderr: '' });

function assistant(t, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-robust-'));
  let clock = NOW;
  const a = new CompanyAssistant({ dataDir: root, now: () => clock, sleep: async ms => { clock += ms; }, noTools: true, bus: { latest: () => [] }, spawnRetryMs: 0, welinkRun: run });
  a.cli = () => 'fixture-cli';
  t.after(() => { a.welinkGate.flush(); a.auth.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { a, advance: ms => { clock += ms; } };
}

test('报错说人话：超时、exe 被占用、登录过期、网络换成中文原因；认不出的保留原文', () => {
  assert.match(W.friendlyError(Object.assign(new Error('welink-cli 超过 30 秒没返回：im query-history-message'), { code: 'WELINK_TIMEOUT' })), /响应太慢（超过 30 秒）.*自动重试/);
  assert.match(W.friendlyError(Object.assign(new Error('spawn EBUSY'), { code: 'EBUSY', syscall: 'spawn' })), /暂时打不开.*升级/);
  assert.match(W.friendlyError('Token expired, please run: welink-cli auth login'), /登录已过期.*自动续期/);
  assert.match(W.friendlyError('connect ECONNRESET 10.0.0.1:443'), /网络暂时不通/);
  assert.equal(W.friendlyError('meeting query-list 查询业务码 401：参数错误'), 'meeting query-list 查询业务码 401：参数错误');
});

test('令牌 INVALID / REVOKED 即使带 UID 也按过期处理', () => {
  assert.deepEqual(W.loginState('UID: u1\nToken: INVALID'), { ok: false, reason: 'expired', uid: 'u1' });
  assert.equal(W.loginState('UID: u1\nToken: REVOKED').ok, false);
  assert.equal(W.loginState('UID: u1\nToken: VALID (expires in 20m)').ok, true);
});

test('exe 正被升级替换（EBUSY）时隔一会儿自动再起一次；登录命令不重放', async t => {
  let calls = 0, logins = 0;
  const { a } = assistant(t, async args => {
    if (args[0] === 'auth' && args[1] === 'login') { logins += 1; throw Object.assign(new Error('spawn EBUSY'), { code: 'EBUSY' }); }
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('spawn EBUSY'), { code: 'EBUSY', syscall: 'spawn' });
    return reply('{"code":0}');
  });
  const result = await a.rawWelink(['im', 'query-recent-conversation']);
  assert.equal(result.code, 0); assert.equal(calls, 2);
  await assert.rejects(a.rawWelink(['auth', 'login'], { allowSetup: true }), /EBUSY/);
  assert.equal(logins, 1);
});

test('提问时 5 分钟内刚核实过在线就不再排一条 auth status；过了 5 分钟照常核实', async t => {
  const calls = [];
  const { a, advance } = assistant(t, async args => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'auth') return reply('UID: owner\nToken: VALID');
    if (args[1] === 'query-list') return reply(JSON.stringify({ code: 200, data: { total: 0, page: 1, size: 30 } }));
    if (args[0] === 'calendar') return reply('[]');
    throw new Error('unexpected ' + args.join(' '));
  });
  a.write('settings.json', { email: 'fixture@example.invalid' });
  const login = { ok: true, uid: 'owner' };
  a.auth.status = () => ({ state: 'online', login, lastCheckAt: NOW });
  a.auth.check = async () => ({ state: 'online', login });
  const range = { start: NOW - 3600000, end: NOW + 3600000 };
  const snap = await a.collectQuery('meetings', range);
  assert.equal(snap.login.ok, true);
  assert.equal(calls.filter(c => c === 'auth status').length, 0);
  advance(6 * 60000); calls.length = 0;
  await a.collectQuery('meetings', range);
  assert.equal(calls.filter(c => c === 'auth status').length, 1);
});

function keeper(state, loginResult) {
  let clock = NOW;
  const store = { 'auth.json': state }, runs = [];
  const k = new AuthKeeper({ now: () => clock, read: (n, d) => store[n] ?? d, write: (n, v) => { store[n] = v; }, changed: () => {}, publish: () => true, refresh: async () => {},
    rawWelink: async (args, opts) => {
      runs.push(args.join(' '));
      if (args[1] === 'status') return reply('UID: owner\nToken: EXPIRED');
      const r = loginResult(); opts.onData?.(r.stdout); return r;
    } });
  return { k, runs, advance: ms => { clock += ms; } };
}

test('已提示扫码后每 30 分钟悄悄重试一次登录，界面仍显示「扫码登录」；不到 30 分钟不试', async () => {
  const recent = keeper({ state: 'needs-scan', scanAttempts: SCAN_LIMIT, lastAttemptAt: NOW - 5 * 60000, notified: true }, () => reply('请使用 WeLink 扫码'));
  await recent.k.check({ force: true });
  assert.deepEqual(recent.runs, ['auth status']);
  const due = keeper({ state: 'needs-scan', scanAttempts: SCAN_LIMIT, lastAttemptAt: NOW - SLOW_RETRY_MS - 1000, notified: true }, () => reply('请使用 WeLink 扫码'));
  const st = await due.k.check({ force: true });
  assert.deepEqual(due.runs, ['auth status', 'auth login']);
  assert.equal(st.state, 'needs-scan');
});

test('夜里桌面端没开、早上开了：悄悄重试成功就直接回到在线', async () => {
  let n = 0;
  const { k } = keeper({ state: 'needs-scan', scanAttempts: SCAN_LIMIT, lastAttemptAt: NOW - SLOW_RETRY_MS - 1000, notified: true }, () => reply('login ok'));
  k.a.rawWelink = async args => { if (args[1] === 'status') return reply(n++ === 0 ? 'UID: owner\nToken: EXPIRED' : 'UID: owner\nToken: VALID'); return reply('login ok'); };
  const st = await k.check({ force: true, refresh: false });
  assert.equal(st.state, 'online'); assert.equal(st.scanAttempts, 0);
});

test('手动登录命令一退出、登录状态核实成功就显示成功，不等整轮取数', async t => {
  let release;
  const { a } = assistant(t, async args => {
    if (args[1] === 'login') return reply('登录成功');
    if (args[1] === 'status') return reply('UID: owner\nToken: VALID');
    throw new Error('unexpected');
  });
  a.refresh = () => new Promise(r => { release = r; });
  await a.startLogin();
  await a.loginDone;
  assert.equal(a.loginFlow.state, 'ok');
  assert.equal(a.auth.status().state, 'online');
  release?.({});
});

test('设置页显示 welink-cli 版本：首次后台读一次，之后用缓存', async t => {
  let n = 0;
  const { a } = assistant(t, async args => { if (args[0] === '--version') { n += 1; return reply('welink-cli version 1.0.19\n'); } throw new Error('unexpected'); });
  assert.equal(a.cliVersion(), null);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(a.cliVersion(), '1.0.19');
  assert.equal(a.status().cliVersion, '1.0.19');
  assert.equal(n, 1);
});

// 1.0.20（Q-1106-06 公司真机实测）：未登录时 auth status 退出码 0、输出「Status: not authenticated」；查询报 Not logged in；
// mail / calendar 去掉了 --format（传了退出码 109）。以下输出按回执原文的措辞合成。
test('1.0.20 的登录状态措辞：未登录、刷新令牌失效判为要登录；「User Token: valid (expires in …)」判为在线', () => {
  assert.equal(W.loginState('Status: not authenticated').reason, 'expired');
  assert.equal(W.loginState('Error: Token expired and refresh token invalid. Please run: welink-cli auth login').reason, 'expired');
  assert.equal(W.loginState('Something new. Please run: welink-cli auth login').reason, 'expired');
  assert.deepEqual(W.loginState('Account: ***\nUID: u1\nUser Token: valid (expires in 29m)'), { ok: true, uid: 'u1' });
  // 只看 User Token 这一行：别的行写着 expired 不算
  assert.equal(W.loginState('UID: u1\nUser Token: valid (expires in 29m)\nRefresh Token: expired').ok, true);
  assert.equal(W.AUTH_FAILURE.test('Error: Not logged in. Please run: welink-cli auth login'), true);
});

test('1.0.20 未登录（退出码 0）会触发自动续期，不再停在「无法识别登录状态」', async () => {
  const runs = [];
  let clock = NOW;
  const store = { 'auth.json': { scanAttempts: 0 } };
  const k = new AuthKeeper({ now: () => clock, read: (n, d) => store[n] ?? d, write: (n, v) => { store[n] = v; }, changed: () => {}, publish: () => true, refresh: async () => {},
    rawWelink: async args => { runs.push(args.join(' ')); return args[1] === 'status' ? reply(runs.length > 2 ? 'UID: u1\nUser Token: valid (expires in 29m)' : 'Status: not authenticated') : reply('login ok'); } });
  const st = await k.check({ force: true, refresh: false });
  assert.deepEqual(runs, ['auth status', 'auth login', 'auth status']);
  assert.equal(st.state, 'online');
});

test('新版不认 --format 时给出中文原因，不把 109 的英文原文抛给用户', async () => {
  const Q = require('../core/company-assistant/queries');
  const run = async args => args.includes('--format') ? { code: 109, stdout: '', stderr: 'The following arguments were not expected: json --format' } : reply('Subject  From\n-------  ----\nx  y');
  await assert.rejects(Q.readJson(run, ['mail', 'list', '--max', '10']), err => err.code === 'WELINK_FORMAT_UNSUPPORTED' && /新版去掉了 --format/.test(err.message));
});

test('认不出登录状态时，界面在「重新检查」旁边也给「扫码登录」', () => {
  const { connectionState } = require('../renderer/company-assistant-connection');
  const c = connectionState({ cliFound: true, auth: { state: 'unknown', login: { ok: false, reason: 'unknown' } } });
  assert.equal(c.kind, 'unknown'); assert.equal(c.alt, 'login'); assert.equal(c.altLabel, '扫码登录');
});

test('1.0.20 真机未登录原文（Q-1106-03 第 2 轮）按要登录处理', () => {
  const text = "Configuration:\n  Environment:  pro\n\nCredentials:\n  Status:       not authenticated\n  Hint:         Run 'welink-cli auth login' to authenticate.\n";
  assert.equal(W.loginState(text).reason, 'expired');
  assert.equal(W.loginState("Hint: Run 'welink-cli auth login' to continue").reason, 'expired');
  assert.equal(W.loginState('Credentials:\n  UID:          u1\n  User Token:   valid (expires in 25m10s)').ok, true);
});

test('点「重新检查并取数」时自己上一轮还没完：只插队查一次登录就返回，不陪整轮干等', async t => {
  let release;
  const { a } = assistant(t, async () => reply('UID: u1\nUser Token: valid (expires in 20m)'));
  a.refreshing = new Promise(r => { release = r; }); a.refreshStartedAt = NOW - 60000; a.refreshTrigger = 'manual';
  let checked = 0; a.auth.check = async () => { checked += 1; return { state: 'online' }; };
  const r = await a.manualRefresh();
  assert.deepEqual(r, { joined: true, since: NOW - 60000 }); assert.equal(checked, 1);
  release(); a.refreshing = null;
});

test('点刷新时后台定时那一轮正在补会话：让它收尾，马上换成用户这一轮', async t => {
  const { a } = assistant(t, async () => reply('{}'));
  let finish; const seen = [];
  a.refreshing = new Promise(r => { finish = r; }); a.refreshTrigger = 'timer';
  a.refresh = async opts => { seen.push(opts.trigger); return {}; };
  const p = a.manualRefresh();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(a.yieldToUser, true);
  finish(); a.refreshing = null;
  assert.deepEqual(await p, { joined: false, preempted: true });
  assert.deepEqual(seen, ['manual']); assert.equal(a.yieldToUser, false);
});

test('认不出的过渡输出（令牌刷新进度行）：隔一下再查；仍认不出但 10 分钟内在线过，就先按在线继续', async () => {
  let clock = NOW; const store = { 'auth.json': {} }; const outputs = ['Token refresh complete', 'Credentials:\n  User Token:   valid (expires in 29m)\n  UID:          u1'];
  const k = new AuthKeeper({ now: () => clock, read: (n, d) => store[n] ?? d, write: (n, v) => { store[n] = v; }, changed: () => {}, publish: () => true, refresh: async () => {}, unknownRetryMs: 0,
    rawWelink: async () => reply(outputs.shift() ?? 'Sign data expired or missing, obtaining sign via WebSocket...') });
  let st = await k.check({ force: true, refresh: false });
  assert.equal(st.state, 'online'); assert.equal(st.login.uid, 'u1');
  clock += 2 * 60000;
  st = await k.check({ force: true, refresh: false });
  assert.equal(st.state, 'online'); assert.equal(st.login.unverified, true); assert.equal(st.login.uid, 'u1');
  clock += 11 * 60000;
  st = await k.check({ force: true, refresh: false });
  assert.equal(st.state, 'unknown');
});

test('Credentials corrupted 按要重新登录处理', () => { assert.equal(W.loginState('Error: Credentials corrupted').reason, 'expired'); });

test('「Sign data expired …」这类令牌刷新进度行不算过期', () => {
  assert.equal(W.loginState('Sign data expired or missing, obtaining sign via WebSocket...').reason, 'unknown');
  assert.equal(W.loginState('Sign data expired or missing, obtaining sign via WebSocket...\nCredentials:\n  User Token:   valid (expires in 29m)\n  UID:          u1').ok, true);
});
