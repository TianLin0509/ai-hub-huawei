'use strict';
// 会话启动失败前 3 个原因（R25，2026-11-24）：自动新建的退避与失败原因落日志、刷新未确认的自动复核与跳过、协调库忙时重试。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-start-failures-'));
process.env.CLAUDE_HUB_DATA_DIR = path.join(tmpRoot, 'data');
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// ---------- 1. 自动新建会话的退避 ----------
const { createSessionStartBackoff } = require('../core/session-start-backoff');

test('自动新建：连续 3 次失败暂停，暂停中不再尝试；到期试探再失败等待翻倍；只提示一次；成功即解除', () => {
  let clock = 1_000_000;
  const paused = [];
  const backoff = createSessionStartBackoff({ now: () => clock, onPause: info => paused.push(info) });
  const boom = new Error('个人基础规则超过 32 KB，请先精简');
  for (let i = 0; i < 2; i++) { backoff.assertAllowed('claude'); backoff.failed('claude', boom); }
  backoff.assertAllowed('claude'); // 两次失败还不暂停
  backoff.failed('claude', boom);
  assert.equal(paused.length, 1);
  assert.equal(paused[0].waitMs, 60_000);
  assert.throws(() => backoff.assertAllowed('claude-resume'), error => error.code === 'SESSION_START_BACKOFF' && /32 KB/.test(error.message));
  backoff.assertAllowed('codex'); // 别的种类不受影响
  clock += 60_001;
  backoff.assertAllowed('claude'); // 到期放行一次试探
  backoff.failed('claude', boom);
  assert.throws(() => backoff.assertAllowed('claude'), /暂停 120 秒/);
  assert.equal(paused.length, 1, '同一段连续失败只提示一次');
  for (let i = 0; i < 10; i++) { clock += 16 * 60_000; backoff.failed('claude', boom); }
  assert.ok(backoff.snapshot().get('claude').until - clock <= 15 * 60_000, '最长暂停 15 分钟');
  backoff.succeeded('claude');
  backoff.assertAllowed('claude');
  assert.equal(backoff.snapshot().has('claude'), false);
});

function registerHandlers({ ensureLaunchAuth, createSession = (kind, opts) => ({ id: opts.id || crypto.randomUUID(), kind }) }) {
  const handlers = new Map(), sent = [];
  const operations = require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { createSession, getSession: () => null, getAllSessions: () => [], codeagentPoolActiveCounts: () => ({}) },
    sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
    ensureLaunchAuth,
  });
  return { user: arg => handlers.get('create-session')(null, arg), auto: arg => operations.createSession(arg), sent };
}
const launchLog = () => {
  const file = path.join(process.env.CLAUDE_HUB_DATA_DIR, 'diagnostics', 'launch-timings.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
};
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
// 启动日志是异步追加：轮询到条件满足（最长 3 秒），机器忙时 50 毫秒不够。
async function waitLog(ready) { for (let i = 0; i < 60 && !ready(launchLog()); i++) await settle(); return launchLog(); }

test('主进程：后台自动新建连续失败 3 次就停，第 4 次不再碰登录检查；失败行带原因；手动新建不受影响', async () => {
  let checks = 0;
  const env = registerHandlers({ ensureLaunchAuth: async () => { checks++; throw new Error('个人基础规则超过 32 KB，请先精简'); } });
  const before = launchLog().length;
  for (let i = 0; i < 3; i++) await assert.rejects(env.auto({ kind: 'powershell', opts: { id: 'fixed-task-session' } }), /32 KB/);
  await assert.rejects(env.auto({ kind: 'powershell', opts: { id: 'fixed-task-session' } }), error => error.code === 'SESSION_START_BACKOFF');
  assert.equal(checks, 3, '暂停期间不再走登录检查和建会话');
  const notices = env.sent.filter(item => item.channel === 'session-notice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].payload.noticeKind, 'blocking');
  assert.match(notices[0].payload.message, /连续 3 次失败.*32 KB/);
  // 用户手动新建照常尝试（这里同样失败，但会真的去检查）
  await assert.rejects(env.user({ kind: 'powershell', opts: {} }), /32 KB/);
  assert.equal(checks, 4);
  const rows = (await waitLog(all => all.length >= before + 4)).slice(before);
  assert.equal(rows.length, 4, '暂停期间被拦下的不记成新的启动失败');
  for (const row of rows) {
    assert.equal(row.ok, false);
    assert.equal(row.code, null);
    assert.match(row.message, /个人基础规则超过 32 KB/, '没有错误码的失败也记下原因');
  }
  assert.deepEqual(rows.map(row => row.source).sort(), ['auto', 'auto', 'auto', 'user']);
});

test('主进程：手动新建成功一次就解除后台暂停', async () => {
  let fail = true;
  const env = registerHandlers({ ensureLaunchAuth: async () => { if (fail) throw new Error('暂时不行'); } });
  for (let i = 0; i < 3; i++) await assert.rejects(env.auto({ kind: 'powershell', opts: {} }));
  await assert.rejects(env.auto({ kind: 'powershell', opts: {} }), error => error.code === 'SESSION_START_BACKOFF');
  fail = false;
  const session = await env.user({ kind: 'powershell', opts: {} });
  assert.ok(session.id);
  assert.ok((await env.auto({ kind: 'powershell', opts: {} })).id);
});

test('个人基础规则超过 32 KB 照样能同步进会话（11-11 自动重建循环的起因）', () => {
  const home = path.join(tmpRoot, 'person'), nativeHome = path.join(tmpRoot, 'native-claude');
  const source = path.join(home, '.agents', 'USER_CONTEXT.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const big = '# Long person rules\n' + '规则'.repeat(20000);
  assert.ok(Buffer.byteLength(big) > 32768);
  fs.writeFileSync(source, big);
  fs.mkdirSync(nativeHome, { recursive: true });
  const { syncNativeUserContext } = require('../core/agent-user-context');
  syncNativeUserContext({ kind: 'claude', nativeHome, env: { CLAUDE_HUB_HOME_DIR: home } });
  assert.equal(fs.readFileSync(path.join(nativeHome, 'CLAUDE.md'), 'utf8'), big);
});

// ---------- 2. Claude 登录刷新未确认 ----------
const { createClaudeCredentialBroker, RECHECK_GAP_MS } = require('../core/claude-account-credentials');

function brokerFixture(t, { expiresIn = -1000 } = {}) {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'broker-'));
  const home = path.join(root, 'acct'); fs.mkdirSync(home, { recursive: true });
  const stateDir = path.join(root, 'refresh');
  let clock = 2_000_000_000_000;
  const writeCredentials = (refreshToken, accessToken = 'old-access', expiresAt = clock + expiresIn) => fs.writeFileSync(path.join(home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes: ['user:inference'] } }));
  writeCredentials('rt-1');
  const calls = [];
  let reply = () => ({ status: 200, data: { access_token: 'new-access', refresh_token: 'rt-2', expires_in: 3600 } });
  const broker = createClaudeCredentialBroker({ stateDir, now: () => clock,
    request: async (url, options) => { calls.push(JSON.parse(options.body || '{}')); return reply(); } });
  const profile = { id: 'acct-8', home };
  const markerFile = () => fs.readdirSync(stateDir).map(name => path.join(stateDir, name))[0];
  return { broker, profile, calls, writeCredentials, markerFile, stateDir,
    setReply: fn => { reply = fn; }, advance: ms => { clock += ms; }, now: () => clock,
    readCredentials: () => JSON.parse(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8')) };
}

test('刷新被登录服务拒绝（400）：明确报需要重新登录，之后不再报「未确认」，也不再重复发请求', async t => {
  const f = brokerFixture(t);
  f.setReply(() => ({ status: 400, data: null, errorCode: 'invalid_grant' }));
  await assert.rejects(f.broker.getCredentials(f.profile), error => error.code === 'CLAUDE_RELOGIN_REQUIRED');
  await assert.rejects(f.broker.getCredentials(f.profile), error => error.code === 'CLAUDE_RELOGIN_REQUIRED' && /重新登录/.test(error.message));
  assert.equal(f.calls.length, 1, '被拒的凭据不再重发');
  assert.equal(f.broker.authBlocked(f.profile).code, 'CLAUDE_RELOGIN_REQUIRED');
  const log = fs.readFileSync(f.stateDir + '-log.jsonl', 'utf8');
  assert.match(log, /"error":"invalid_grant"/);
  // 重新登录后新的凭据不受旧标记影响
  f.writeCredentials('rt-new');
  assert.equal(f.broker.authBlocked(f.profile), null);
  f.setReply(() => ({ status: 200, data: { access_token: 'a2', refresh_token: 'rt-3', expires_in: 3600 } }));
  assert.equal((await f.broker.getCredentials(f.profile)).claudeAiOauth.accessToken, 'a2');
});

test('刷新被拒但凭据已在别处换新：直接用新凭据，不提示重登', async t => {
  const f = brokerFixture(t);
  f.setReply(() => { f.writeCredentials('rt-other', 'other-access', f.now() + 3600_000); return { status: 400, data: null }; });
  const credentials = await f.broker.getCredentials(f.profile);
  assert.equal(credentials.claudeAiOauth.accessToken, 'other-access');
  assert.equal(fs.readdirSync(f.stateDir).length, 0, '标记已清除');
});

test('请求发出后没拿到答复：访问令牌没过期照常用；过期后 5 分钟内说明会自动复核，到点自动复核成功', async t => {
  const f = brokerFixture(t, { expiresIn: 60_000 }); // 还有 1 分钟过期，处在提前刷新窗口内
  f.setReply(() => { throw new Error('socket hang up'); });
  await assert.rejects(f.broker.getCredentials(f.profile), error => error.code === 'CLAUDE_AUTH_NETWORK');
  assert.equal((await f.broker.getCredentials(f.profile)).claudeAiOauth.accessToken, 'old-access', '旧令牌还能用就不拦');
  assert.equal(f.broker.authBlocked(f.profile), null);
  f.advance(90_000); // 令牌已过期
  await assert.rejects(f.broker.getCredentials(f.profile), error => error.code === 'CLAUDE_REFRESH_UNCONFIRMED' && /自动复核/.test(error.message));
  assert.equal(f.broker.authBlocked(f.profile).code, 'CLAUDE_REFRESH_UNCONFIRMED');
  assert.equal(f.calls.length, 1);
  f.advance(RECHECK_GAP_MS);
  f.setReply(() => ({ status: 200, data: { access_token: 'rechecked', refresh_token: 'rt-2', expires_in: 3600 } }));
  const fresh = await f.broker.getCredentials(f.profile);
  assert.equal(fresh.claudeAiOauth.accessToken, 'rechecked');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].refresh_token, 'rt-1', '复核用的是同一张刷新凭据');
  assert.equal(f.readCredentials().claudeAiOauth.refreshToken, 'rt-2');
  assert.equal(f.broker.authBlocked(f.profile), null);
});

test('复核时被拒：确定需要重新登录', async t => {
  const f = brokerFixture(t);
  f.setReply(() => ({ status: 200, data: { refresh_token: 'lost' } })); // 返回不完整，结果未确认
  await assert.rejects(f.broker.getCredentials(f.profile), error => error.code === 'CLAUDE_REFRESH_UNCONFIRMED');
  f.advance(RECHECK_GAP_MS + 1);
  f.setReply(() => ({ status: 400, data: null }));
  await assert.rejects(f.broker.getCredentials(f.profile), error => error.code === 'CLAUDE_RELOGIN_REQUIRED');
  assert.equal(f.broker.authBlocked(f.profile).code, 'CLAUDE_RELOGIN_REQUIRED');
});

test('登录服务 5xx：不当成要重登，保留未确认，到点自动复核', async t => {
  const f = brokerFixture(t);
  f.setReply(() => ({ status: 503, data: null }));
  await assert.rejects(f.broker.getCredentials(f.profile), error => error.code === 'CLAUDE_REFRESH_UNCONFIRMED' && /503/.test(error.message));
  f.advance(RECHECK_GAP_MS + 1);
  f.setReply(() => ({ status: 200, data: { access_token: 'ok', refresh_token: 'rt-2', expires_in: 3600 } }));
  assert.equal((await f.broker.getCredentials(f.profile)).claudeAiOauth.accessToken, 'ok');
});

test('闲置的未确认号：等满 5 分钟由后台巡检代为复核，不会一直停在等待', async t => {
  const f = brokerFixture(t);
  f.setReply(() => ({ status: 503, data: null }));
  await assert.rejects(f.broker.getCredentials(f.profile), error => error.code === 'CLAUDE_REFRESH_UNCONFIRMED');
  assert.equal(await f.broker.prefresh([f.profile]), null, '5 分钟内巡检不碰它');
  assert.equal(f.calls.length, 1);
  f.advance(RECHECK_GAP_MS + 1);
  f.setReply(() => ({ status: 200, data: { access_token: 'by-prefresh', refresh_token: 'rt-2', expires_in: 3600 } }));
  assert.deepEqual(await f.broker.prefresh([f.profile]), { id: 'acct-8', ok: true });
  assert.equal(f.calls.length, 2);
  assert.equal(f.readCredentials().claudeAiOauth.accessToken, 'by-prefresh');
  assert.equal(f.broker.authBlocked(f.profile), null);
});

test('被拒的号后台巡检不再发请求', async t => {
  const f = brokerFixture(t);
  f.setReply(() => ({ status: 400, data: null }));
  await assert.rejects(f.broker.getCredentials(f.profile), error => error.code === 'CLAUDE_RELOGIN_REQUIRED');
  f.advance(RECHECK_GAP_MS + 1);
  assert.equal(await f.broker.prefresh([f.profile]), null);
  assert.equal(f.calls.length, 1);
});

test('复核请求没发出去或被限流：未确认不丢，退避期间不推荐，退避结束接着复核', async t => {
  for (const blockReply of [() => { throw Object.assign(new Error('proxy down'), { notSent: true }); }, () => ({ status: 429, data: null })]) {
    const f = brokerFixture(t);
    f.setReply(() => ({ status: 503, data: null }));
    await assert.rejects(f.broker.getCredentials(f.profile));
    f.advance(RECHECK_GAP_MS + 1);
    f.setReply(blockReply);
    await assert.rejects(f.broker.getCredentials(f.profile));
    assert.equal(f.broker.authBlocked(f.profile).code, 'CLAUDE_AUTH_RATE_LIMIT', '退避中的过期号不当成可用');
    const marker = JSON.parse(fs.readFileSync(f.markerFile(), 'utf8'));
    assert.ok(marker.tokenHash && marker.startedAt, '未确认标记保留');
    f.advance(30 * 60_000);
    assert.equal(f.broker.authBlocked(f.profile).code, 'CLAUDE_REFRESH_UNCONFIRMED');
    f.setReply(() => ({ status: 400, data: null }));
    await assert.rejects(f.broker.getCredentials(f.profile), error => error.code === 'CLAUDE_RELOGIN_REQUIRED', '接着复核并确定需要重登');
  }
});

test('后台提前续期被拒：正在用的旧访问令牌照常用到过期前 2 分钟，新会话和自动分号立即跳过', async t => {
  const f = brokerFixture(t, { expiresIn: 29 * 60_000 }); // 已进提前续期窗口（30–60 分钟），访问令牌仍有效
  f.setReply(() => ({ status: 400, data: null, errorCode: 'invalid_grant' }));
  assert.equal((await f.broker.prefresh([f.profile])).code, 'CLAUDE_RELOGIN_REQUIRED');
  assert.equal(f.broker.authBlocked(f.profile).code, 'CLAUDE_RELOGIN_REQUIRED', '新会话、推荐号、自动换号都看这一项');
  assert.equal((await f.broker.getCredentials(f.profile)).claudeAiOauth.accessToken, 'old-access', '运行中的会话不提前拦');
  f.advance(28 * 60_000);
  await assert.rejects(f.broker.getCredentials(f.profile), error => error.code === 'CLAUDE_RELOGIN_REQUIRED');
  assert.equal(f.calls.length, 1);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /blocked\?\.code === 'CLAUDE_RELOGIN_REQUIRED'\) throw/);
});

test('会话内手动换号下拉框：登录失效的号标不可用并写明原因', () => {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'switch-'));
  const profiles = ['acct-a', 'acct-b'].map(id => {
    const home = path.join(root, id); fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } }));
    return { id, label: id, home };
  });
  const sw = require('../main/claude-account-switch').createClaudeAccountSwitch({
    sessionManager: { getSession: () => ({ id: 's1', kind: 'claude', claudeProfile: 'acct-a' }), getAllSessions: () => [], on() {}, updateSessionMeta() {} },
    broker: { authBlocked: profile => profile.id === 'acct-b' ? { code: 'CLAUDE_RELOGIN_REQUIRED', message: '登录已失效，需要重新登录' } : null },
    profiles: () => profiles, scopeFor: () => null, sendToPty() {}, saveSession() {}, relaunch: () => {}, verifyRoute: () => ({ ok: true }),
  });
  const rows = sw.accountOptions('s1').accounts;
  assert.equal(rows.find(row => row.id === 'acct-a').available, true);
  const b = rows.find(row => row.id === 'acct-b');
  assert.equal(b.available, false);
  assert.match(b.reason, /重新登录/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'claude-account-switch.js'), 'utf8');
  assert.match(source, /error\?\.code !== 'CLAUDE_REFRESH_UNCONFIRMED'/, '等待自动复核期间不挂状态');
  assert.match(source, /claudeSwitchStatus\?\.source === 'refresh'.*claudeSwitchStatus: null/, '续期成功撤掉旧提示');
});

test('启动前的同步检查失败也进启动日志；自动新建一律以 Promise 拒绝返回', async () => {
  const env = registerHandlers({ ensureLaunchAuth: async () => {} });
  assert.throws(() => env.user({ kind: 'no-such-kind', opts: {} }), /不支持此会话类型/);
  const pending = env.auto({ kind: 'no-such-kind', opts: {} });
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, /不支持此会话类型/);
  const rows = (await waitLog(all => all.filter(row => row.kind === 'no-such-kind').length >= 2)).filter(row => row.kind === 'no-such-kind'); // 日志是异步追加，别的用例的行可能晚到
  assert.equal(rows.length, 2);
  for (const row of rows) { assert.equal(row.ok, false); assert.match(row.message, /不支持此会话类型/); }
  assert.deepEqual(rows.map(row => row.source).sort(), ['auto', 'user']);
});

test('恢复会话、群聊建子会话、CodeAgent 前缀分支都接上登记库忙时重试', () => {
  for (const file of ['resume-session-handlers.js', 'meeting-create-handlers.js', 'codeagent-prefix-fork-handlers.js']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', file), 'utf8'), /retryWhenOwnershipBusy/, file);
  }
  const manager = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  assert.doesNotMatch(manager.replace(/try \{ this\._refreshOpenIdentity\(id\); \}/g, ''), /this\._refreshOpenIdentity\(id\)/, '进程已拉起后补记进程号失败不推翻整次创建');
});

test('推荐号与自动换号候选跳过登录失效的号', () => {
  const { rankClaudeAccounts } = require('../core/claude-launch-recommend');
  const full = { pct: 0, resetsAt: 0 };
  const ranking = rankClaudeAccounts({ sessions: [], accounts: [
    { profileId: 'acct-8', usage5h: full, usage7d: full, error: '登录已失效，需要重新登录' },
    { profileId: 'acct-9', usage5h: { pct: 50, resetsAt: 0 }, usage7d: { pct: 50, resetsAt: 0 } },
  ] });
  assert.equal(ranking.recommendedId, 'acct-9');
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'claude-account-switch.js'), 'utf8');
  assert.match(source, /broker\.authBlocked\?\.\(profile\)\) continue;/);
  const precompact = fs.readFileSync(path.join(__dirname, '..', 'main', 'claude-quota-precompact.js'), 'utf8');
  assert.match(precompact, /broker\.authBlocked\?\.\(profile\)/);
});

// ---------- 3. 会话登记库忙 ----------
const { retryWhenOwnershipBusy, isOwnershipBusy, SessionOpenOwnership } = require('../core/session-open-ownership');
const busyError = () => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

test('登记库忙：异步隔一会儿再试，成功就照常返回；一直忙给出人话并保留原错误', async () => {
  let tries = 0;
  const waits = [];
  const wait = ms => { waits.push(ms); return Promise.resolve(); };
  const value = await retryWhenOwnershipBusy(() => { if (++tries < 3) throw busyError(); return 'session'; }, { wait });
  assert.equal(value, 'session');
  assert.deepEqual(waits, [200, 600]);
  await assert.rejects(retryWhenOwnershipBusy(() => { throw busyError(); }, { wait }),
    error => error.code === 'SESSION_OPEN_BUSY' && error.errcode === 5 && /另一个 AI HUB/.test(error.message) && /locked/.test(error.cause));
  // 不忙时同步照旧：同步返回值、同步抛出的别的错误都不改变
  assert.equal(retryWhenOwnershipBusy(() => 'sync'), 'sync');
  assert.throws(() => retryWhenOwnershipBusy(() => { throw new Error('别的错'); }), /别的错/);
  assert.equal(isOwnershipBusy(Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR', errcode: 11 })), false);
});

test('真实场景：另一个进程连接占着写锁时登记报 SQLITE_BUSY，锁放开后重试能登记成功', async () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'owners-'));
  const holder = new SessionOpenOwnership({ directory: dir, pid: 999_001, isAlive: () => false });
  const claimer = new SessionOpenOwnership({ directory: dir, pid: process.pid, isAlive: () => false });
  claimer.db.exec('PRAGMA busy_timeout=0');
  holder.db.exec('BEGIN IMMEDIATE');
  let caught;
  try { claimer.claim('sid-busy'); } catch (error) { caught = error; }
  assert.ok(isOwnershipBusy(caught), `应是 SQLITE_BUSY：${caught && caught.message}`);
  let released = false;
  const lease = await retryWhenOwnershipBusy(() => claimer.claim('sid-busy'), {
    wait: async () => { if (!released) { holder.db.exec('COMMIT'); released = true; } } });
  assert.equal(lease.sessionId, 'sid-busy');
  holder.close(); claimer.close();
});
