'use strict';
// CodeAgent 一键安装 / 升级（core/codeagent-install.js）：已装走 update、未装走官方安装包静默安装、各类失败给人话提示。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodeAgentInstaller, acceptSignature, findLocalInstallers, explainFailure, verifyInstaller } = require('../core/codeagent-install');

const GOOD_SIG = { status: 'Valid', subject: 'CN=CodeAgentCLI3.0, O=Huawei, C=CN', issuer: 'CN=Enterprise CA 1' };
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-install-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function fakeInstaller(dir, name = 'Cli3.0-Setup.exe', { size = 25 * 1024 * 1024, head = 'MZ' } = {}) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, head);
  fs.truncateSync(file, size);
  return file;
}
function harness({ command = '', versions = [], runResults = [], sig = GOOD_SIG, local = [], afterInstallCommand = 'C:\\Program Files\\CodeAgentCLI\\codeagent.bat' } = {}) {
  const dataDir = tmp();
  const calls = { run: [], rediscover: 0, states: [] };
  let cmd = command;
  const installer = createCodeAgentInstaller({
    dataDir, platform: 'win32', downloadPage: 'https://example.invalid/csop',
    resolveCommand: () => cmd,
    rediscover: async () => { calls.rediscover++; if (!cmd) cmd = afterInstallCommand; },
    probeVersion: async () => versions.length ? versions.shift() : null,
    run: async (file, args, opts) => {
      const snapshotDir = fs.existsSync(path.join(dataDir, 'codeagent-install')) ? fs.readdirSync(path.join(dataDir, 'codeagent-install')) : [];
      calls.run.push({ file, args, opts, jobs: snapshotDir });
      return runResults.length ? runResults.shift() : { code: 0, stdout: '', stderr: '' };
    },
    signature: async () => sig,
    localInstallers: () => local,
    onState: s => calls.states.push(s.phase),
  });
  return { installer, calls, dataDir };
}

test('已装：隐藏运行 codeagent update --force，读出升级前后版本', async () => {
  const { installer, calls } = harness({ command: 'C:\\Program Files\\CodeAgentCLI\\codeagent.bat', versions: ['1.2615.02.01', '1.2615.02.03'] });
  const r = await installer.start();
  assert.equal(r.phase, 'done');
  assert.equal(r.version, '1.2615.02.03');
  assert.equal(r.previous, '1.2615.02.01');
  assert.match(r.message, /升级完成 v1\.2615\.02\.03（原来 v1\.2615\.02\.01）/);
  assert.equal(calls.run.length, 1);
  assert.equal(calls.run[0].file, 'cmd.exe');
  assert.match(calls.run[0].args.join(' '), /call "C:\\Program Files\\CodeAgentCLI\\codeagent\.bat" update --force/);
  assert.equal(calls.rediscover, 1);
  assert.deepEqual(calls.states.slice(0, 2), ['upgrading', 'rediscovering']);
});

test('已装且已是最新：如实说已是最新版', async () => {
  const { installer } = harness({ command: 'codeagent', versions: ['1.2615.02.03', '1.2615.02.03'] });
  const r = await installer.start();
  assert.equal(r.phase, 'done'); assert.equal(r.upToDate, true);
  assert.match(r.message, /已是最新版/);
});

test('未装 + 下载文件夹里有官方安装包：核签名、拷进一次性目录、管理员静默安装 /S、装完重新查找并清理', async () => {
  const dl = tmp();
  const file = fakeInstaller(dl);
  const { installer, calls, dataDir } = harness({ local: [{ path: file }], versions: ['1.2615.02.03'] });
  const r = await installer.start();
  assert.equal(r.phase, 'done', r.message);
  assert.match(r.message, /安装完成 v1\.2615\.02\.03/);
  const ps = calls.run.find(c => c.file === 'powershell.exe');
  assert.ok(ps, '要经 PowerShell 申请管理员运行安装器');
  const script = ps.args[ps.args.length - 1];
  assert.match(script, /Start-Process -FilePath '.+codeagent-install\\job-[0-9a-f-]+\\Cli3\.0-Setup\.exe' -ArgumentList '\/S' -Verb RunAs -PassThru/);
  assert.match(script, /Set-Content -LiteralPath '.+\\installer\.pid' -Value \$p\.Id/, '安装器进程号写进任务目录，超时时才能按 PID 判断和结束');
  assert.ok(ps.args.includes('-WindowStyle') && ps.args.includes('Hidden'));
  assert.equal(ps.jobs.length, 1, '运行时安装包在 Hub 自己的一次性目录里');
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'codeagent-install')), [], '装完删掉一次性目录');
  assert.ok(fs.existsSync(file), '不动用户下载文件夹里的原文件');
  assert.equal(calls.rediscover, 1);
  assert.deepEqual(calls.states.slice(0, 3), ['verifying', 'installing', 'rediscovering']);
});

test('未装 + 本机没有安装包：提示打开官方下载页（不自己乱下）', async () => {
  const { installer, calls } = harness();
  const r = await installer.start();
  assert.equal(r.phase, 'need-download');
  assert.equal(r.downloadPage, 'https://example.invalid/csop');
  assert.match(r.message, /打开官方下载页/);
  assert.equal(calls.run.length, 0);
});

test('未装 + 本机安装包签名不对：跳过它，不运行，转为请用户到官方页下载', async () => {
  const dl = tmp();
  const { installer, calls } = harness({ local: [{ path: fakeInstaller(dl) }], sig: { status: 'NotSigned', subject: '' } });
  const r = await installer.start();
  assert.equal(r.phase, 'need-download');
  assert.equal(calls.run.length, 0);
});

test('官方页下载回来的文件被代理换成网页：大小不对，停止安装并说明', async () => {
  const dl = tmp();
  const page = path.join(dl, 'Cli3.0-Setup.exe');
  fs.writeFileSync(page, '<html>HIS Proxy Notification</html>');
  const { installer, calls } = harness();
  const r = await installer.installFile(page);
  assert.equal(r.phase, 'error'); assert.equal(r.code, 'CA_INSTALL_SIZE');
  assert.match(r.message, /代理的提示网页/);
  assert.match(r.message, /打开官方下载页/, '失败时给官方页兜底');
  assert.equal(calls.run.length, 0);
});

test('下载回来的不是程序（没有 MZ 头）：拒绝安装', async () => {
  const dl = tmp();
  const { installer } = harness();
  const r = await installer.installFile(fakeInstaller(dl, 'Cli3.0-Setup.exe', { head: '<!' }));
  assert.equal(r.code, 'CA_INSTALL_FORMAT');
});

test('升级被代理拦 / 没登录 / 无权限 / 用户取消管理员确认：各给一句能照做的话', async () => {
  const cases = [
    [{ code: 1, stdout: '', stderr: 'Error: connect ETIMEDOUT 10.1.1.1:443' }, /连不上 CodeAgent 的升级服务器.*公司代理/],
    [{ code: 1, stdout: 'Request failed with status code 401', stderr: '' }, /还没登录或登录已过期.*账号/],
    [{ code: 1, stdout: '', stderr: 'Access is denied.' }, /没有权限写入安装目录/],
  ];
  for (const [result, re] of cases) {
    const { installer } = harness({ command: 'codeagent', runResults: [result] });
    const r = await installer.start();
    assert.equal(r.phase, 'error'); assert.equal(r.code, 'CA_UPDATE_FAILED');
    assert.match(r.message, re);
    assert.match(r.message, /打开官方下载页/);
  }
  const dl = tmp();
  const { installer } = harness({ local: [{ path: fakeInstaller(dl) }], runResults: [{ code: 1223, stdout: '', stderr: 'The operation was canceled by the user.' }] });
  const r = await installer.start();
  assert.equal(r.code, 'CA_INSTALL_UAC');
  assert.match(r.message, /管理员确认.*被取消.*选「是」/);
});

test('同一时间只跑一次：连点两下共用同一个过程', async () => {
  const { installer, calls } = harness({ command: 'codeagent', versions: ['1', '2'] });
  const [a, b] = await Promise.all([installer.start(), installer.start()]);
  assert.deepEqual(a, b);
  assert.equal(calls.run.length, 1);
});

test('签名规则：只认有效且签名者是 CodeAgent 官方', () => {
  assert.equal(acceptSignature(GOOD_SIG).ok, true);
  assert.equal(acceptSignature({ ...GOOD_SIG, status: 'HashMismatch' }).ok, false);
  assert.equal(acceptSignature({ status: 'Valid', subject: 'CN=Other Tool, O=Huawei, C=CN' }).ok, false);
  assert.equal(acceptSignature({ status: 'Valid', subject: 'CN=CodeAgentCLI3.0, O=Someone Else' }).ok, false);
  assert.equal(acceptSignature(null).ok, false);
});

test('本机安装包查找：只认官方文件名、新的在前、太小的不算', () => {
  const dl = tmp();
  const a = fakeInstaller(dl, 'Cli3.0-Setup.exe');
  const b = fakeInstaller(dl, 'Cli3.0-Setup-1793155776571.exe');
  fakeInstaller(dl, 'Cli3.0-Setup (1).exe', { size: 4000 });
  fakeInstaller(dl, 'other-Setup.exe');
  const t = Date.now() / 1000;
  fs.utimesSync(a, t - 100, t - 100); fs.utimesSync(b, t, t);
  assert.deepEqual(findLocalInstallers({ dirs: [dl] }).map(x => path.basename(x.path)), ['Cli3.0-Setup-1793155776571.exe', 'Cli3.0-Setup.exe']);
});

test('超时也给人话', () => {
  assert.match(explainFailure({ timedOut: true }, 'update'), /20 分钟/);
});

test('verifyInstaller 用传入的签名读取器，签名不对抛 CA_INSTALL_SIGNATURE', async () => {
  const dl = tmp();
  await assert.rejects(verifyInstaller(fakeInstaller(dl), { signature: async () => ({ status: 'Valid', subject: 'CN=x' }) }), e => e.code === 'CA_INSTALL_SIGNATURE');
});

test('子进程一律隐藏窗口，不用 detached 或可见控制台', () => {
  for (const file of ['core/codeagent-install.js', 'main/ipc/codeagent-install-handlers.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(text, /detached\s*:\s*true|-NoExit|DETACHED_PROCESS|pythonw/, file);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '../core/codeagent-install.js'), 'utf8'), /windowsHide: true/);
});
