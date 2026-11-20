'use strict';
// welink-cli 使用统计上报失败的告警行（2026-11-21，群里多人「扫码一直报 Telemetry 错误」「不弹二维码」「邮件日历配置失败」）：
// 「[WARN] Telemetry: report error: HTTP request failed …」只说明 welink-cli 自己的统计没报上去，和登录、查询成败无关。
// 以前它含 fail/error，扫码面板据此判「登录没成功」并藏起二维码；配置邮件日历、手机对话的报错也拿它当原因。
// 告警原文取自同事贴出的报错，同类 5 种写法取自黄区真机 welink-cli 1.0.20 exe 字符串；输出全部为合成。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../core/company-assistant/welink');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { AuthKeeper } = require('../core/company-assistant/auth-keeper');
const { connectionState } = require('../renderer/company-assistant-connection');

const TELE = '[WARN] Telemetry: report error: HTTP request failed: Could not connect to server (code=7) | detail: Failed to connect to proxy.example port 8080 after 1 ms: Could not connect to server';
const TELE2 = '[WARN] Telemetry: report error: HTTP request failed: Failure when receiving data from the peer';
// 21×21 的随机矩阵（只用来走字符画→二维码的解析，不需要能扫）。
const MATRIX = Array.from({ length: 21 }, (_, y) => Array.from({ length: 21 }, (_, x) => (x * 7 + y * 3 + x * y) % 5 < 2));
const ART = W.qrBlocksFromMatrix(MATRIX);

test('告警行夹在二维码前后：仍按等待扫码显示，不判失败、不出错误原因', () => {
  const text = `${TELE}\nObtaining QR code...\n${ART}\nWaiting for scan... (elapsed 3 seconds)\n${TELE2}\n`;
  assert.equal(W.loginProgress(text).phase, 'waiting');
  assert.equal(W.loginDiagnosis(text), null);
  assert.ok(W.qrFromLoginOutput(text));
});

test('告警行和真原因同在：说真原因（桌面端没开），不说 Telemetry', () => {
  const text = `Obtaining QR code...\nWaiting for scan... (elapsed 6 seconds)\nScan successful!\n${TELE}\nError: Cannot connect to WeLink PC.\n`;
  const p = W.loginProgress(text), c = W.loginDiagnosis(text);
  assert.equal(p.phase, 'failed');
  assert.doesNotMatch(p.reason, /Telemetry/);
  assert.equal(c.id, 'pc');
});

test('只去掉行首的告警行：查询结果 JSON 里的同样文字原样保留，其他告警也保留', () => {
  const json = '{\n  "content": "[WARN] Telemetry: report error: 这是一条聊天内容"\n}';
  assert.equal(W.dropNoise(json), json);
  assert.equal(W.dropNoise('[WARN] Token will expire soon\n'), '[WARN] Token will expire soon\n');
  for (const line of ['Telemetry: posting to https://example', 'Telemetry: report failed, status=502', 'Telemetry: unknown error in async report', '2026-11-21 10:00:01 [WARN] Telemetry: report error: x'])
    assert.equal(W.dropNoise(line + '\nnext\n'), 'next\n', line);
});

// 真跑一条子进程：Hub 拿到的 stdout / stderr、边跑边给面板的输出里都没有告警行。
function fakeCli(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-tele-'));
  const file = path.join(dir, 'welink-cli-fake.js');
  fs.writeFileSync(file, body, 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}
test('welink.run 交回的输出不带告警行（邮件日历配置、手机对话报错都读这里）', async t => {
  const cli = fakeCli(t, `process.stderr.write(${JSON.stringify(TELE + '\n')});
process.stderr.write('Error: Exchange server domain not found. Please run first: welink-cli mail autodiscover --email <your-email>\\n');
process.stdout.write('{"ok":false}');`);
  const seen = [];
  const r = await W.run(['mail', 'autodiscover', '--email', 'a@b.c'], { cli, allowSetup: true, onData: s => seen.push(s), timeoutMs: 15000 });
  assert.equal(r.stdout, '{"ok":false}');
  assert.doesNotMatch(r.stderr, /Telemetry/);
  assert.match(r.stderr, /Exchange server domain not found/);
  assert.ok(seen.length, 'onData 应被调用'); for (const s of seen) assert.doesNotMatch(s, /Telemetry/);
});

test('扫码面板（真子进程）：告警行不再让面板判失败、藏二维码', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-tele-svc-'));
  const cli = fakeCli(t, `const args = process.argv.slice(2);
if (args[1] === 'login') {
  process.stderr.write(${JSON.stringify(TELE + '\n')});
  process.stdout.write('Obtaining QR code...\\n' + ${JSON.stringify(ART + '\n')} + 'Waiting for scan... (elapsed 1 seconds)\\n');
  process.stderr.write(${JSON.stringify(TELE2 + '\n')});
  setTimeout(() => {}, 60000);
} else { process.stdout.write('Status: not authenticated\\n'); }`);
  const a = new CompanyAssistant({ dataDir: root, noTools: true, bus: { latest: () => [] }, spawnRetryMs: 0, welinkRun: (args, o) => W.run(args, { cli, ...o }) });
  a.cli = () => cli; a.refresh = async () => ({});
  t.after(async () => { a.loginStop?.abort(); await a.loginDone?.catch(() => {}); a.welinkGate.flush(); a.auth.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 10000;
  await a.startLogin();
  while (!(a.loginFlow?.qr && a.loginFlow.progress) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 300)); // 第二条告警也到了
  assert.equal(a.loginFlow.state, 'waiting');
  assert.ok(a.loginFlow.qr, '二维码应已显示');
  assert.equal(a.loginFlow.progress.phase, 'waiting');
  assert.doesNotMatch(a.loginFlow.text, /Telemetry/);
});

// 自动续期：桌面端没开导致续期转成要扫码时，提醒说清是桌面端的事、开起来就自动续上。
function keeper(loginOutput) {
  let clock = Date.parse('2026-11-21T09:00:00+08:00');
  const published = [];
  const files = {};
  const k = new AuthKeeper({
    now: () => clock, read: (n, d) => files[n] || d, write: (n, v) => { files[n] = v; }, changed: () => {}, publish: n => { published.push(n); return true; },
    refresh: async () => ({}),
    rawWelink: async (args, o = {}) => {
      if (args[1] === 'status') return { code: 0, stdout: 'UID: owner\nUser Token: EXPIRED\n', stderr: '' };
      o.onData?.(loginOutput);
      if (W.loginNeedsScan(loginOutput)) throw Object.assign(new Error('已停止这次 WeLink 登录'), { code: 'WELINK_ABORTED' });
      return { code: 1, stdout: loginOutput, stderr: '' };
    },
  });
  return { k, published, advance: ms => { clock += ms; } };
}
test('自动续期卡在本机 WeLink 桌面端：状态与提醒写明原因，开起来就自动续上', async () => {
  const out = 'Token expired, refreshing...\nError: Cannot connect to WeLink PC.\nToken refresh failed\nProceeding with QR code login...\nObtaining QR code...\nWaiting for scan...\n';
  const { k, published, advance } = keeper(out);
  await k.check({ force: true, refresh: false });
  advance(11 * 60000);
  const st = await k.check({ force: true, refresh: false });
  assert.equal(st.state, 'needs-scan');
  assert.equal(st.renewCause.id, 'pc');
  assert.match(published[0].text, /WeLink 桌面端/);
  assert.match(published[0].text, /自动续上/);
  assert.match(connectionState({ cliFound: true, auth: st }).detail, /WeLink 桌面端/);
});
test('自动续期没认出原因时，提醒保持原来的说法', async () => {
  const { k, published, advance } = keeper('Token expired, refreshing...\nToken refresh failed: 401\nProceeding with QR code login...\nWaiting for scan...\n');
  await k.check({ force: true, refresh: false });
  advance(11 * 60000);
  const st = await k.check({ force: true, refresh: false });
  assert.equal(st.state, 'needs-scan');
  assert.equal(st.renewCause, null);
  assert.match(published[0].text, /自动续期连续两次没完成/);
});
test('自动续期直接失败（桌面端没开、没出二维码）：左栏写原因而不是笼统的「未成功」', async () => {
  const { k } = keeper('Token expired, refreshing...\nError: Cannot connect to WeLink PC.\nPlease ensure WeLink PC is running.\n');
  const st = await k.check({ force: true, refresh: false });
  assert.equal(st.state, 'unknown');
  assert.match(st.error, /WeLink 桌面端没开/);
  assert.match(connectionState({ cliFound: true, auth: st }).detail, /WeLink 桌面端没开/);
});
