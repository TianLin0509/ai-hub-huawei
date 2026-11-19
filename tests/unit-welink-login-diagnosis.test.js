'use strict';
// WeLink 扫码登录可靠性（2026-11-19，反馈 15d0af6b / 00408358）：失败时按原因说人话、二维码迟迟不出可重开、
// 凭据损坏一键清除重扫、本人退出登录后不再自动续期。CLI 原文取自黄区真机 welink-cli 1.0.20 exe 里的字符串，全部为合成输出。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../core/company-assistant/welink');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { connectionState } = require('../renderer/company-assistant-connection');

const NOW = Date.parse('2026-11-19T10:00:00+08:00');
const reply = (stdout, code = 0) => ({ code, stdout, stderr: '' });
function assistant(t, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-login-diag-'));
  let clock = NOW;
  const a = new CompanyAssistant({ dataDir: root, now: () => clock, sleep: async ms => { clock += ms; }, noTools: true, bus: { latest: () => [] }, spawnRetryMs: 0, welinkRun: run });
  a.cli = () => 'fixture-cli';
  a.refresh = async () => ({});
  t.after(() => { a.welinkGate.flush(); a.auth.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { a, advance: ms => { clock += ms; } };
}
const SCANNED = 'Obtaining QR code...\nWaiting for scan... (elapsed 6 seconds)\nScan successful! Obtaining login credentials...\n';

test('扫码后取签名失败的几种真机原文都认得出原因，且算作失败', () => {
  const cases = [
    ['Error: Cannot connect to WeLink PC.\nPlease ensure WeLink PC is running.', 'pc'],
    ['WebSocket Connect Timeout', 'pc'],
    ['Response missing required fields (sign/nonce/timestamp).', 'other-device'],
    ['WebSocket returned invalid sign data (sign/nonce/timestamp empty).', 'other-device'],
    ['WeLink PC version may be incompatible. Please update to the latest version.', 'pc-version'],
    ['WeLink PC may be busy, please try again later.', 'pc-busy'],
    ['授权码已过期，请重新扫码', 'code'],
    ['Agent login failed (status 403)', 'agent'],
    ['Credential signature verification failed! The credentials file may have been tampered. Please run: welink-cli auth logout, then welink-cli auth login', 'credentials'],
  ];
  for (const [line, id] of cases) {
    const text = SCANNED + line + '\n';
    assert.equal(W.loginDiagnosis(text)?.id, id, line);
    assert.equal(W.loginProgress(text)?.phase, 'failed', line);
  }
  assert.equal(W.loginDiagnosis('Credentials corrupted').action, 'relogin-clean');
});

test('要二维码失败、超时、网络断各有说法', () => {
  assert.equal(W.loginDiagnosis('Obtaining QR code...\nQR code request failed (status 302)').id, 'qr-request');
  assert.equal(W.loginDiagnosis('Waiting for scan...\nQR code scan timeout, please try again').id, 'timeout');
  assert.equal(W.loginDiagnosis('Polling error: Timeout was reached').id, 'network');
  assert.equal(W.loginDiagnosis(SCANNED + 'Login successful. Credentials cached.'), null);
});

test('登录开头的令牌刷新、取签名进度行不算失败', () => {
  const text = 'Token expired, refreshing...\nToken refresh failed: 401\nProceeding with QR code login...\nObtaining QR code...\n';
  assert.notEqual(W.loginProgress(text)?.phase, 'failed');
  assert.equal(W.loginProgress(SCANNED + '  Obtaining sign via WebSocket...\nSign data expired or missing, obtaining sign via WebSocket...\n').phase, 'scanned');
});

test('扫码通过但本机 WeLink 桌面端没开：面板失败原因写桌面端，不再只说「没查到已登录」', async t => {
  const { a } = assistant(t, async args => {
    if (args[1] === 'login') return reply(SCANNED + 'Error: Cannot connect to WeLink PC.\n', 1);
    if (args[1] === 'status') return reply('Error: Not logged in. Please run: welink-cli auth login', 1);
    throw new Error('unexpected ' + args.join(' '));
  });
  await a.startLogin();
  await a.loginDone;
  await new Promise(r => setTimeout(r, 20));
  assert.equal(a.loginFlow.state, 'failed');
  assert.equal(a.loginFlow.cause.id, 'pc');
  assert.match(a.loginFlow.error, /WeLink 桌面端没开/);
});

test('认不出原因时附上 CLI 最后一行', async t => {
  const { a } = assistant(t, async args => {
    if (args[1] === 'login') return reply('Obtaining QR code...\nsomething odd happened here\n', 1);
    if (args[1] === 'status') return reply('Error: Not logged in. Please run: welink-cli auth login', 1);
    throw new Error('unexpected');
  });
  await a.startLogin();
  await a.loginDone;
  await new Promise(r => setTimeout(r, 20));
  assert.equal(a.loginFlow.state, 'failed');
  assert.match(a.loginFlow.error, /没查到已登录.*something odd happened here/);
});

test('二维码 20 秒还没出来、或本人点「重新获取」：结束旧登录命令重开一个', async t => {
  let launches = 0;
  const { a, advance } = assistant(t, (args, opts) => {
    if (args[1] === 'login') {
      launches += 1;
      return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('已停止这次 WeLink 登录'), { code: 'WELINK_ABORTED' })), { once: true }));
    }
    if (args[1] === 'status') return Promise.resolve(reply('Error: Not logged in. Please run: welink-cli auth login', 1));
    return Promise.reject(new Error('unexpected'));
  });
  a.startLogin(); await new Promise(r => setTimeout(r, 10));
  assert.equal(launches, 1);
  await a.startLogin().catch(() => {}); // 还不到 20 秒：复用这一次
  assert.equal(launches, 1);
  advance(21000);
  a.startLogin(); await new Promise(r => setTimeout(r, 30));
  assert.equal(launches, 2);
  a.startLogin({ restart: true }); await new Promise(r => setTimeout(r, 30));
  assert.equal(launches, 3);
  a.loginStop?.abort();
});

test('凭据损坏：「清除并重新扫码」先 auth logout 再 auth login', async t => {
  const calls = [];
  const { a } = assistant(t, async args => {
    calls.push(args.join(' '));
    if (args[1] === 'logout') return reply('All credentials and configuration have been cleared.');
    if (args[1] === 'login') return reply('Login successful. Credentials cached.');
    if (args[1] === 'status') return reply('UID: owner\nUser Token: valid (expires in 2h)');
    throw new Error('unexpected');
  });
  await a.startLogin({ clean: true });
  await a.loginDone;
  assert.deepEqual(calls.slice(0, 2), ['auth logout', 'auth login']);
});

test('本人退出 WeLink 登录：清凭据、不再自动续期也不提醒；再扫码成功后恢复', async t => {
  const calls = [];
  const { a } = assistant(t, async args => {
    calls.push(args.join(' '));
    if (args[1] === 'logout') return reply('All credentials and configuration have been cleared.');
    if (args[1] === 'status') return reply('Error: Not logged in. Please run: welink-cli auth login', 1);
    if (args[1] === 'login') throw new Error('不该自动登录');
    throw new Error('unexpected');
  });
  const r = await a.logout();
  assert.equal(r.ok, true);
  assert.equal(a.auth.status().state, 'signed-out');
  const st = await a.auth.check({ force: true, refresh: false });
  assert.equal(st.state, 'signed-out');
  assert.equal(calls.includes('auth login'), false);
  assert.equal(connectionState({ cliFound: true, auth: st }).title, '已退出 WeLink 登录');
  a.auth.manualSucceeded({ ok: true, uid: 'owner' });
  assert.equal(a.auth.status().state, 'online');
});

test('auth logout 只在主进程维护登录时放行，会话只读包装不放行', () => {
  assert.deepEqual(W.checkArgs(['auth', 'logout'], { allowSetup: true }), ['auth', 'logout']);
  assert.throws(() => W.checkArgs(['auth', 'logout']), /只能用 welink-cli 的查询命令/);
});

test('自动续期的 auth login 正在跑时本人点退出：续期被停下，状态保持「已退出」', async t => {
  const { a } = assistant(t, (args, opts) => {
    if (args[1] === 'status') return Promise.resolve(reply('Error: Not logged in. Please run: welink-cli auth login', 1));
    if (args[1] === 'logout') return Promise.resolve(reply('All credentials and configuration have been cleared.'));
    if (args[1] === 'login') return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('已停止这次 WeLink 登录'), { code: 'WELINK_ABORTED' })), { once: true }));
    return Promise.reject(new Error('unexpected'));
  });
  const renewing = a.auth.check({ force: true, refresh: false });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(a.auth.status().state, 'renewing');
  await a.logout();
  await renewing;
  assert.equal(a.auth.status().state, 'signed-out');
});

test('登录原文显示前抹掉令牌、签名、Bearer 和长编码', () => {
  const s = W.scrubLine('Agent login failed: {"access_token":"abc.def","sign":"s1","nonce":"n1"} Authorization: Bearer xyz ' + 'A'.repeat(40));
  assert.doesNotMatch(s, /abc\.def|"s1"|"n1"|xyz|AAAA/);
  assert.equal(W.loginDiagnosis('Agent login failed (status 403): token=secret123').line.includes('secret123'), false);
});

test('退出没跑完时点了扫码：等退出完再开登录，退出不会抹掉新的登录', async t => {
  const order = [];
  let releaseLogout;
  const { a } = assistant(t, async args => {
    order.push(args.join(' '));
    if (args[1] === 'logout') { await new Promise(r => { releaseLogout = r; }); return reply('cleared'); }
    if (args[1] === 'login') return reply('Login successful. Credentials cached.');
    if (args[1] === 'status') return reply('UID: owner\nUser Token: valid (expires in 2h)');
    throw new Error('unexpected');
  });
  const out = a.logout();
  await new Promise(r => setTimeout(r, 10));
  const login = a.login();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(order.includes('auth login'), false, '退出完成前不开登录');
  releaseLogout();
  await out; await login; await a.loginDone;
  assert.ok(order.indexOf('auth login') > order.indexOf('auth logout'));
  assert.equal(a.auth.status().state, 'online');
});

test('退出后查登录状态出错：仍保持「已退出」，不转成自动续期', async t => {
  const { a } = assistant(t, async args => {
    if (args[1] === 'logout') return reply('cleared');
    if (args[1] === 'status') throw Object.assign(new Error('spawn failed'), { code: 'WELINK_TIMEOUT' });
    throw new Error('unexpected');
  });
  await a.logout();
  const st = await a.auth.check({ force: true, refresh: false });
  assert.equal(st.state, 'signed-out');
});

test('清除并重扫：后台核对说在线也不跳过扫码', async t => {
  const calls = [];
  let release;
  const { a } = assistant(t, async args => {
    calls.push(args.join(' '));
    if (args[1] === 'status') { if (!release) await new Promise(r => { release = r; }); return reply('UID: owner\nUser Token: valid (expires in 1m)'); }
    if (args[1] === 'logout') return reply('cleared');
    if (args[1] === 'login') return reply('Login successful. Credentials cached.');
    throw new Error('unexpected');
  });
  const pending = a.auth.check({ force: true, refresh: false });
  await new Promise(r => setTimeout(r, 10));
  const started = a.startLogin({ clean: true });
  await new Promise(r => setTimeout(r, 10));
  release(); await pending; await started; await a.loginDone;
  assert.ok(calls.includes('auth logout') && calls.lastIndexOf('auth login') > calls.indexOf('auth logout'), calls.join(' | '));
});

test('扫码面板显示的原样输出也脱敏，二维码边框不受影响', async t => {
  const { a } = assistant(t, async () => reply(''));
  const flow = a.loginFlowFrom('+' + '-'.repeat(40) + '+\nAgent login failed: {"access_token":"leak-me-123"}\n');
  assert.doesNotMatch(flow.text, /leak-me-123/);
  assert.match(flow.text, /\+-{40}\+/);
});
