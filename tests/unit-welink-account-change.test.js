'use strict';
// R32（2026-11-24）：换过工号的同事——WeLink 桌面端是新工号，welink-cli 还登着旧工号，助理报 proxy failed、一键反馈也发不出去。
// 全部用临时目录和替身，不碰本机真实的 welink-cli 登录态、WeLink 桌面端文件和用户配置。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../core/company-assistant/welink-account');
const W = require('../core/company-assistant/welink');
const { AuthKeeper } = require('../core/company-assistant/auth-keeper');
const { connectionState } = require('../renderer/company-assistant-connection');
const { createHubFeedbackService } = require('../main/hub-feedback-service');
const FW = require('../core/hub-feedback-welink');
const identity = require('../core/profile/identity');
const { runReadOnly } = require('../core/company-assistant/welink-ro');

const NEW = 'x00200002', OLD = 'x00100001';

// 按真机布局摆一个假的用户目录：%APPDATA%\WeLink_Desktop\appdata\logininfo.txt、UserData\<账号>\user.db、~\.welink-cli\credentials.json。
function fakeHome(t, { client = NEW, cli = OLD, logininfo = true, userData = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-acct-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { USERPROFILE: root, APPDATA: path.join(root, 'AppData', 'Roaming') };
  const desk = path.join(env.APPDATA, 'WeLink_Desktop');
  fs.mkdirSync(path.join(desk, 'appdata'), { recursive: true });
  if (logininfo && client) fs.writeFileSync(path.join(desk, 'appdata', 'logininfo.txt'), `loginAccount=${client}\r\n`);
  userData.forEach(([name, ageMs]) => {
    const dir = path.join(desk, 'UserData', name); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'user.db'); fs.writeFileSync(f, ''); const at = new Date(Date.now() - ageMs); fs.utimesSync(f, at, at);
  });
  if (cli) { fs.mkdirSync(path.join(root, '.welink-cli')); fs.writeFileSync(path.join(root, '.welink-cli', 'credentials.json'), JSON.stringify({ uid: cli, w3Account: '', userToken: 'secret-token-never-read' })); }
  return env;
}

test('客户端新工号、welink-cli 旧工号：读出两边账号并判定对不上', t => {
  const env = fakeHome(t);
  const r = A.read({ env });
  assert.equal(r.client.account, NEW); assert.equal(r.client.via, 'logininfo');
  assert.equal(r.cli.account, OLD);
  assert.equal(r.mismatch.client, NEW); assert.equal(r.mismatch.cli, OLD);
  assert.match(r.mismatch.text, new RegExp(`WeLink 命令行还登着旧账号 ${OLD}`));
  assert.ok(!JSON.stringify(r).includes('secret-token'), '只取账号，不带出令牌');
  // auth status 读到的 UID 优先于文件；大小写不同算同一个账号
  assert.equal(A.read({ env, cliUid: NEW.toUpperCase() }).mismatch, null);
});

test('没有 logininfo 时按 UserData 里最新的账号目录认桌面端；任一边读不到不下结论', t => {
  const env = fakeHome(t, { logininfo: false, userData: [[OLD, 86400000], [NEW, 1000]] });
  assert.equal(A.clientAccount({ env }).account, NEW);
  assert.equal(A.clientAccount({ env }).via, 'userdata');
  const bare = fakeHome(t, { client: '', logininfo: false });
  assert.equal(A.read({ env: bare }).mismatch, null, '没装桌面端不拦人');
  assert.equal(A.read({ env: fakeHome(t, { cli: '' }) }).mismatch, null, 'welink-cli 没登录过不算对不上');
});

function keeper({ uid = OLD, mismatch = A.mismatch({ client: NEW, cli: OLD }) } = {}) {
  const calls = { login: 0, published: [] };
  let store = {};
  const a = {
    read: (_n, d) => store.auth || d, write: (_n, v) => { store.auth = v; }, changed() {}, now: () => 1_000_000,
    publish: n => { calls.published.push(n); return true; }, loginFlow: null, refresh: async () => ({}),
    accountMismatch: cliUid => (cliUid === uid ? mismatch : null),
    rawWelink: async args => {
      if (args[1] === 'login') { calls.login++; return { code: 0, stdout: '', stderr: '' }; }
      return { code: 0, stdout: `UID: ${uid}\nUser Token: VALID (expires in 20h)`, stderr: '' };
    },
  };
  return { k: new AuthKeeper(a), calls };
}

test('令牌有效但账号和桌面端对不上：不续期、标成 account-mismatch、只提醒一次', async () => {
  const { k, calls } = keeper();
  const st = await k.check({ force: true });
  assert.equal(st.state, 'account-mismatch');
  assert.equal(st.login.ok, false, '查询不再拿旧账号去取数');
  assert.equal(st.login.reason, 'account-mismatch');
  assert.equal(calls.login, 0, '不跑 auth login——续的还是旧账号');
  assert.equal(calls.published.length, 1);
  assert.match(calls.published[0].text, /重新登录/);
  await k.check({ force: true });
  assert.equal(calls.published.length, 1, '同一对账号不重复提醒');
  // 本人用旧账号扫回来也不算登好
  k.manualSucceeded({ ok: true, uid: OLD });
  assert.equal(k.status().state, 'account-mismatch');
  k.manualSucceeded({ ok: true, uid: NEW });
  assert.equal(k.status().state, 'online', '用新账号登好后恢复在线');
});

test('助理页 WeLink 一行：写明旧账号，按钮是「重新登录」（先清旧登录再扫码）', async () => {
  const { k } = keeper();
  const auth = await k.check({ force: true });
  const c = connectionState({ cliFound: true, auth });
  assert.equal(c.action, 'login-clean');
  assert.equal(c.label, '重新登录');
  assert.match(c.title, new RegExp(`WeLink 命令行还登着旧账号 ${OLD}.*点这里重新登录`));
});

test('查询被拒成 proxy failed：报错说人话；助理会话的只读包装附上原因', async () => {
  assert.match(W.friendlyError(new Error('Error: proxy failed')), /旧账号/);
  const run = async () => ({ code: 1, stdout: '', stderr: 'proxy failed' });
  const wrong = A.mismatch({ client: NEW, cli: OLD });
  const r = await runReadOnly(['im', 'query-recent-conversation'], { run, cli: 'fake.js', welinkAccounts: () => ({ mismatch: wrong }) });
  assert.match(r.stderr, /^proxy failed\n\[Hub\] WeLink 命令行还登着旧账号 x00100001/);
  const ok = await runReadOnly(['im', 'query-recent-conversation'], { run: async () => ({ code: 0, stdout: '{}', stderr: '' }), cli: 'fake.js', welinkAccounts: () => ({ mismatch: wrong }) });
  assert.equal(ok.stderr, '', '正常结果不加话');
});

test('Hub 存过的旧身份：桌面端换了账号就作废重认；welink-cli 还是旧账号时不把旧账号的信息认成本人', async () => {
  const cached = { name: '旧名字', uid: OLD, workId: '00100001', from: 'welink', at: Date.now() };
  const asked = [];
  const welinkOld = async args => { asked.push(args.join(' ')); return { stdout: JSON.stringify({ loginName: OLD, name: '旧名字' }) }; };
  const r = await identity.resolveIdentity({ cached, local: { name: 'git名', workId: '' }, welink: welinkOld, clientAccount: NEW });
  assert.ok(asked.length > 0, '7 天缓存对换号无效，重新问');
  assert.equal(r.uid, NEW); assert.notEqual(r.name, '旧名字'); assert.equal(r.staleCli, OLD);
  const welinkNew = async () => ({ stdout: JSON.stringify({ loginName: NEW, name: '新名字' }) });
  const fresh = await identity.resolveIdentity({ cached, local: { name: 'git名' }, welink: welinkNew, clientAccount: NEW });
  assert.equal(fresh.name, '新名字'); assert.equal(fresh.from, 'welink');
  // 账号没变：照旧用缓存，不多问
  const same = await identity.resolveIdentity({ cached, local: {}, welink: async () => { throw new Error('不该问'); }, clientAccount: OLD });
  assert.equal(same.name, '旧名字');
});

// ---- 一键反馈 ----
function feedback(t, welink) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-acct-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs'); fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'main.log'), 'Error: proxy failed\n');
  return createHubFeedbackService({ edition: 'member', endpoint: 'https://me.example.invalid/x', info: () => ({ version: '5.6.102' }), logsDir: logs,
    downloadsDir: () => path.join(root, 'downloads'), logger: { warn() {} }, fetchImpl: async () => { throw new Error('不该走阿里云'); },
    receiverAddress: { resolve: async () => ({ urls: ['http://10.0.0.1:18767'] }) }, intranetFetch: async () => { throw new Error('不该走内网'); }, welink });
}
function fakeWelink({ accounts = null, sendStderr = '' } = {}) {
  const sent = [];
  return { sent, w: { to: 'fixture-maintainer', hasCli: () => true, parseJson: W.parseJson, accounts: () => accounts,
    run: async (args, opts) => {
      if (args[0] === 'auth') return { code: 0, stdout: `UID: ${OLD}\nUser Token: VALID` };
      sent.push(args); W.checkArgs(args, { sendUser: opts.sendUser });
      return sendStderr ? { code: 1, stdout: '', stderr: sendStderr } : { code: 0, stdout: '{"code":0}', stderr: '' };
    },
    writeClipboard: async () => ({ ok: true }), openDesktop: async () => ({ ok: true }) } };
}

test('一键反馈：账号对不上时不白发，直说原因并带上可复制的内容；窗口一打开就提示', async t => {
  const fk = fakeWelink({ accounts: A.read({ env: fakeHome(t) }) });
  const svc = feedback(t, fk.w);
  const state = await svc.welinkState();
  assert.deepEqual(state.accountMismatch, { client: NEW, cli: OLD });
  const r = await svc.sendWelink({ description: '助理一直报 proxy failed' });
  assert.equal(r.ok, false);
  assert.equal(fk.sent.length, 0, '对不上就不去发');
  assert.deepEqual(r.accountMismatch, { client: NEW, cli: OLD });
  assert.match(r.reason, /旧账号 x00100001/);
  assert.match(r.text, /助理一直报 proxy failed/, '兜底「复制内容」有东西可复制');
  assert.ok(fs.existsSync(r.savedTo));
  const mine = await svc.mine({});
  assert.ok(JSON.stringify(mine).includes('旧账号'), '「我的反馈」里记下失败原因，不静默');
});

test('一键反馈：发送被拒成 proxy failed 时写清原因、标出可重新登录，不静默失败', async t => {
  const fk = fakeWelink({ accounts: { client: null, cli: null, mismatch: null }, sendStderr: 'proxy failed' });
  const svc = feedback(t, fk.w);
  const r = await svc.sendWelink({ description: '反馈发不出去' });
  assert.equal(r.ok, false);
  assert.equal(fk.sent.length, 1);
  assert.equal(r.gateway, true);
  assert.match(r.reason, /proxy failed/); assert.match(r.reason, /旧账号/);
  assert.match(r.text, /反馈发不出去/);
  assert.equal(FW.friendlySendError('proxy failed').gateway, true);
});

test('一键反馈：「是不是维护人自己」以桌面端当前账号为准，换号后不沿用旧结论', async t => {
  const fk = fakeWelink({ accounts: { client: { account: 'fixture-maintainer' }, cli: null, mismatch: null } });
  const svc = feedback(t, fk.w);
  assert.equal((await svc.sendWelink({ description: 'x' })).selfSend, true);
  fk.w.accounts = () => ({ client: { account: NEW }, cli: null, mismatch: null });
  assert.equal((await svc.sendWelink({ description: 'y' })).ok, true, '换成别的账号后照常发出');
});

// ---- 审查补丁（Antigravity 审 #1–#6）----
test('同一工号的不同写法不算对不上：纯数字与带字母前缀、wx 与 lwx、大小写', () => {
  assert.equal(A.mismatch({ client: '00200002', cli: 'x00200002' }), null);
  assert.equal(A.mismatch({ client: 'lwx1234567', cli: 'wx1234567' }), null);
  assert.equal(A.mismatch({ client: 'X00200002', cli: 'x00200002' }), null);
  assert.ok(A.mismatch({ client: 'x00200002', cli: 'x00100001' }), '数字不同才是换了号');
  assert.ok(A.mismatch({ client: 'ab1234567', cli: 'cd1234567' }), '前缀互不包含不算同一人');
});

test('同号不同写法：扫码登好后不再被判回 account-mismatch（不死循环）', () => {
  const { k } = keeper({ uid: 'x00200002', mismatch: A.mismatch({ client: '00200002', cli: 'x00200002' }) });
  k.manualSucceeded({ ok: true, uid: 'x00200002' });
  assert.equal(k.status().state, 'online');
});

test('logininfo.txt：值为空时不跨行取下一行的词；UTF-16 存的也能读', t => {
  const env = fakeHome(t, { logininfo: false, userData: [[NEW, 1000]] });
  const file = path.join(env.APPDATA, 'WeLink_Desktop', 'appdata', 'logininfo.txt');
  fs.writeFileSync(file, 'loginAccount=\r\nloginType = 1\r\n');
  assert.deepEqual(A.clientAccount({ env }), { account: NEW, via: 'userdata' }, '空值时落到 UserData 兜底');
  fs.writeFileSync(file, 'loginAccount=null\r\n');
  assert.equal(A.clientAccount({ env }).via, 'userdata');
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`loginAccount = "${NEW}"\r\n`, 'utf16le')]));
  assert.deepEqual(A.clientAccount({ env }), { account: NEW, via: 'logininfo' });
});

test('用 .js 替身 welink-cli 时不读本机真实的桌面端文件（真机跑 E2E 不串号）', async () => {
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const fakeThis = { deps: {}, cli: () => 'D:/x/welink-cli-standin.js' };
  assert.deepEqual(CompanyAssistant.prototype.welinkAccounts.call(fakeThis), { client: null, cli: null, mismatch: null });
  const r = await runReadOnly(['im', 'query-recent-conversation'], { run: async () => ({ code: 1, stdout: '', stderr: 'proxy failed' }), cli: 'D:/x/welink-cli-standin.js' });
  assert.match(r.stderr, /WeLink 服务器拒绝了这次请求/, '替身下只给通用说法，不按本机账号下结论');
});

test('查询被网关拒成 proxy failed：马上核对一次登录（不重放）', async () => {
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const checks = [];
  const fakeThis = { auth: { pending: null, check: async o => { checks.push(o); return {}; } }, rawWelink: async () => ({ code: 1, stdout: '', stderr: 'proxy failed' }) };
  const r = await CompanyAssistant.prototype.welinkUnlocked.call(fakeThis, ['im', 'query-recent-conversation'], {});
  assert.equal(r.stderr, 'proxy failed');
  assert.deepEqual(checks, [{ force: true, refresh: false }]);
});

test('手机对话「本人」：账号对不上时暂停；刚重新登录后以新账号为准，不用旧快照和旧缓存', async () => {
  const { PhoneChannel } = require('../core/company-assistant/phone');
  let auth = { state: 'account-mismatch', login: { ok: false } }, store = { 'phone.json': { me: OLD, meAt: 1_000_000 } };
  const a = { now: () => 1_000_100, settings: () => ({}), read: (n, d) => store[n] || d, write: (n, v) => { store[n] = v; },
    auth: { status: () => auth }, snapshot: () => ({ login: { ok: true, uid: OLD } }), welink: async () => { throw new Error('不该再问 CLI'); } };
  const p = new PhoneChannel(a, { noTimer: true });
  await assert.rejects(p.me(), /旧账号/);
  auth = { state: 'online', login: { ok: true, uid: NEW } };
  assert.equal(await p.me(), NEW);
  assert.equal(store['phone.json'].me, NEW, '缓存改成新账号');
});

test('反馈默认联系方式：换号未重登时取桌面端新账号；个人页认 welink-client 来源', t => {
  const { localWelinkAccount } = require('../core/welink-account');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-contact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'company-assistant')); fs.mkdirSync(path.join(dir, 'profile'));
  fs.writeFileSync(path.join(dir, 'company-assistant', 'auth.json'), JSON.stringify({ state: 'account-mismatch', login: { ok: false, uid: OLD, clientAccount: NEW } }));
  fs.writeFileSync(path.join(dir, 'profile', 'profile.json'), JSON.stringify({ identity: { from: 'welink', uid: OLD } }));
  assert.equal(localWelinkAccount(dir), NEW);
  fs.writeFileSync(path.join(dir, 'company-assistant', 'auth.json'), '{}');
  fs.writeFileSync(path.join(dir, 'profile', 'profile.json'), JSON.stringify({ identity: { from: 'welink-client', uid: NEW } }));
  assert.equal(localWelinkAccount(dir), NEW);
});
