'use strict';
// r25b 审查返工回归（2026-11-16，rsi/r25审-结论.md 的 1 项 P1、3 项 P2）：撤掉任一修复，对应用例会红。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createCodeAgentInstaller, runHidden } = require('../core/codeagent-install');
const { registerCodeAgentInstallIpc, isOfficialUrl } = require('../main/ipc/codeagent-install-handlers');
const { runOneClick } = require('../renderer/codeagent-install-client');

const GOOD_SIG = { status: 'Valid', subject: 'CN=CodeAgentCLI3.0, O=Huawei, C=CN' };
const PAGE = 'https://csop.example.com/csop/index.html#/ToolInfo?toolId=1';
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-r25b-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fakeInstaller(dir, name = 'Cli3.0-Setup.exe') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'MZ'); fs.truncateSync(file, 25 * 1024 * 1024);
  return file;
}
const pidFileOf = args => (String(args[args.length - 1]).match(/-LiteralPath '([^']+installer\.pid)'/) || [])[1];

// ---- P1：超时要结束整棵进程树，不能只结束最外层包装进程 ----
test('P1 runHidden 超时：按 PID 结束整棵进程树，孙进程不再继续写文件', { skip: process.platform !== 'win32' && '仅 Windows' }, async () => {
  // 和真实安装一样由 PowerShell 拉起子进程（Node 自己 spawn 的子进程会随父进程一起退出，测不出问题）。
  // 孙进程每 200 ms 追加一个字节当心跳，15 秒后自行退出，不会遗留。
  const dir = tmp();
  const beat = path.join(dir, 'heartbeat.txt');
  const script = path.join(dir, 'grandchild.js');
  fs.writeFileSync(script, `const fs = require('fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(beat)}, 'x'), 200); setTimeout(() => process.exit(0), 15000);`);
  const ps = `Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList '"${script}"' -NoNewWindow; Start-Sleep -Seconds 60`;
  const t0 = Date.now();
  const r = await runHidden('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { timeout: 5000 });
  assert.equal(r.code, 'timeout'); assert.equal(r.timedOut, true);
  assert.equal(r.killed, true, r.killOutput);
  assert.ok(Date.now() - t0 < 9000, '超时后及时返回');
  assert.ok(fs.existsSync(beat), '孙进程确实起来过');
  await sleep(500);
  const size = fs.statSync(beat).size;
  await sleep(1500);
  assert.equal(fs.statSync(beat).size, size, '超时后孙进程仍在运行');
});

function installHarness({ run, alive = () => false, kill = async () => ({ ok: true }), waitExit } = {}) {
  const dataDir = tmp();
  const dl = tmp();
  const calls = { runs: 0, kills: [] };
  const installer = createCodeAgentInstaller({
    dataDir, platform: 'win32', downloadPage: PAGE,
    resolveCommand: () => '', probeVersion: async () => null,
    run: async (file, args, opts) => { calls.runs++; return run(file, args, opts); },
    signature: async () => GOOD_SIG,
    localInstallers: () => [{ path: fakeInstaller(dl) }],
    alive, kill: async pid => { calls.kills.push(pid); return kill(pid); },
    ...(waitExit ? { waitExit } : {}),
  });
  return { installer, calls, jobs: () => { const root = path.join(dataDir, 'codeagent-install'); return fs.existsSync(root) ? fs.readdirSync(root) : []; } };
}

test('P1 安装超时且安装器还没起来（管理员确认框一直没点）：给出「等管理员确认」的人话，清理任务目录', async () => {
  const h = installHarness({ run: async () => ({ code: 'timeout', timedOut: true, killed: true }) });
  const r = await h.installer.start();
  assert.equal(r.phase, 'error'); assert.equal(r.code, 'CA_INSTALL_UAC_PENDING');
  assert.match(r.message, /管理员确认框/);
  assert.deepEqual(h.jobs(), []);
  await sleep(10);
  assert.equal(h.installer.busy(), false);
});

test('P1 安装超时、管理员安装器 Hub 无权强停：保留任务目录与占用，不再启动新安装，安装器退出后才清理释放', async () => {
  let exited; const exitPromise = new Promise(r => { exited = r; });
  let installerAlive = true;
  const h = installHarness({
    run: async (_f, args) => { fs.writeFileSync(pidFileOf(args), '4242'); return { code: 'timeout', timedOut: true, killed: true }; },
    alive: pid => pid === 4242 && installerAlive,
    kill: async () => ({ ok: false, output: 'Access is denied' }),
    waitExit: () => exitPromise,
  });
  const r = await h.installer.start();
  assert.equal(r.code, 'CA_INSTALL_STILL_RUNNING', r.message);
  assert.deepEqual(h.calls.kills, [4242], '按已知 PID 尝试结束安装器');
  assert.equal(h.jobs().length, 1, '安装器还在用任务目录，不能删');
  assert.equal(h.installer.busy(), true, '安装器没退出前保持占用');
  const again = await h.installer.start();
  assert.equal(again.code, 'CA_INSTALL_STILL_RUNNING');
  assert.equal(h.calls.runs, 1, '不会再启动第二个安装');
  installerAlive = false; exited();
  await sleep(50);
  assert.deepEqual(h.jobs(), [], '安装器退出后清理任务目录');
  assert.equal(h.installer.busy(), false);
});

test('P1 安装超时、安装器能被结束：结束后清理并说明已停止', async () => {
  let installerAlive = true;
  const h = installHarness({
    run: async (_f, args) => { fs.writeFileSync(pidFileOf(args), '77'); return { code: 'timeout', timedOut: true, killed: true }; },
    alive: () => installerAlive,
    kill: async () => { installerAlive = false; return { ok: true }; },
  });
  const r = await h.installer.start();
  assert.equal(r.code, 'CA_INSTALL_TIMEOUT');
  assert.match(r.message, /20 分钟/);
  assert.deepEqual(h.jobs(), []);
  await sleep(10);
  assert.equal(h.installer.busy(), false);
});

// ---- P3：忙时下载完成的新安装包要排队，不能拿别的任务结果顶替、被提前删掉 ----
test('P3 升级进行中又来一份下载：排队单独核签名安装，不拿升级结果顶替', async () => {
  let release; const gate = new Promise(r => { release = r; });
  let installed = false; const sigFiles = [];
  const dl = tmp();
  const file = fakeInstaller(dl);
  const installer = createCodeAgentInstaller({
    dataDir: tmp(), platform: 'win32', downloadPage: PAGE,
    resolveCommand: () => (installed ? 'C:\\CodeAgent\\codeagent.bat' : 'codeagent'),
    probeVersion: async () => '1.0.0',
    run: async file => { if (file === 'cmd.exe') { await gate; return { code: 0, stdout: '', stderr: '' }; } installed = true; return { code: 0, stdout: '', stderr: '' }; },
    signature: async f => { sigFiles.push(f); return GOOD_SIG; },
    localInstallers: () => [],
  });
  const upgrade = installer.start();
  const fromDownload = installer.installFile(file, { source: 'download' });
  const missing = installer.installFile(path.join(dl, 'not-there.exe'), { source: 'download' });
  assert.notStrictEqual(fromDownload, upgrade, '不同操作不得合并');
  let downloadDone = false; void fromDownload.then(() => { downloadDone = true; });
  await sleep(20);
  assert.equal(downloadDone, false, '升级没结束前，下载的安装包在排队（文件保留）');
  release();
  const [u, d, m] = await Promise.all([upgrade, fromDownload, missing]);
  assert.equal(u.phase, 'done');
  assert.equal(d.phase, 'done');
  assert.ok(sigFiles.some(f => f === file), '下载的安装包本身核过签名');
  assert.match(d.message, /安装完成/);
  assert.equal(m.phase, 'error'); assert.equal(m.code, 'CA_INSTALL_MISSING', '不存在的文件得到它自己的失败，不是升级结果');
});

// ---- P2：官方下载窗口只允许官方域名，下载只接管官方来源；P3：同一时刻只接管一个下载 ----
function fakeElectron() {
  const windows = [];
  const ses = new EventEmitter();
  class BrowserWindow extends EventEmitter {
    constructor() { super(); this.loaded = []; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; }; windows.push(this); }
    loadURL(u) { this.loaded.push(u); return Promise.resolve(); }
    isDestroyed() { return false; } show() {} focus() {} close() { this.closed = true; }
  }
  return { windows, ses, electron: { BrowserWindow, session: { fromPartition: () => ses } } };
}
function fakeItem({ name = 'Cli3.0-Setup.exe', chain }) {
  const item = new EventEmitter();
  Object.assign(item, { getFilename: () => name, getURLChain: () => chain, getURL: () => chain[chain.length - 1], getTotalBytes: () => 1, getReceivedBytes: () => 1, setSavePath(p) { this.savePath = p; }, cancel() { this.cancelled = true; } });
  return item;
}
function handlerHarness() {
  const handles = {};
  const reports = [], installs = [];
  let state = { phase: 'idle' };
  const installer = { snapshot: () => state, report: p => { state = p; reports.push(p); return p; }, start: async () => state, installFile: (f, o) => { installs.push(f); return new Promise(() => {}); } };
  const fe = fakeElectron();
  registerCodeAgentInstallIpc({ handle: (ch, fn) => { handles[ch] = fn; } }, { dataDir: tmp(), send: () => {}, electron: fe.electron, installer, downloadPage: PAGE, officialHosts: ['csop.example.com', 'sso.example.com'] });
  handles['codeagent-install:open-official']();
  return { ...fe, reports, installs, win: fe.windows[0] };
}

test('P2 官方来源按 hostname 判定：只认显式名单里的主机，第三方、相似域名、http 都不行', () => {
  assert.equal(isOfficialUrl('https://csop.example.com/a', PAGE), true);
  assert.equal(isOfficialUrl('https://sso.example.com/login', ['csop.example.com', 'sso.example.com']), true);
  assert.equal(isOfficialUrl('https://example.com/x', PAGE), false, 'r25c：不再放行整个根域');
  assert.equal(isOfficialUrl('https://example.invalid/credential-form', PAGE), false);
  assert.equal(isOfficialUrl('https://evilexample.com/x', PAGE), false);
  assert.equal(isOfficialUrl('https://example.com.evil.net/x', PAGE), false);
  assert.equal(isOfficialUrl('http://csop.example.com/a', PAGE), false);
  assert.equal(isOfficialUrl('https://csop.example.com/a', ''), false);
});

test('P2 官方下载窗口：第三方页面的跳转、重定向、新窗口都被拦下并告知', () => {
  const h = handlerHarness();
  for (const ev of ['will-navigate', 'will-redirect']) {
    let prevented = false;
    h.win.webContents.emit(ev, { url: 'https://example.invalid/credential-form', isMainFrame: true, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, ev + ' 未拦截第三方站点');
    let ok = true;
    h.win.webContents.emit(ev, { url: 'https://sso.example.com/login', isMainFrame: true, preventDefault: () => { ok = false; } });
    assert.equal(ok, true, ev + ' 误拦了官方 SSO');
  }
  assert.deepEqual(h.win.openHandler({ url: 'https://example.invalid/x' }), { action: 'deny' });
  assert.equal(h.win.loaded.includes('https://example.invalid/x'), false, '第三方新窗口不得加载');
  h.win.openHandler({ url: 'https://csop.example.com/next' });
  assert.ok(h.win.loaded.includes('https://csop.example.com/next'));
  assert.match(h.reports[h.reports.length - 1].message, /不是 CodeAgent 官方来源（example\.invalid）/);
});

test('P2 下载接管：重定向链里有非官方地址的 exe 一律拒，不交给安装流程', () => {
  const h = handlerHarness();
  const bad = fakeItem({ name: 'Unrelated.exe', chain: ['https://csop.example.com/dl', 'https://cdn.example.invalid/Unrelated.exe'] });
  h.ses.emit('will-download', {}, bad);
  assert.equal(bad.cancelled, true);
  assert.equal(bad.savePath, undefined);
  bad.emit('done', {}, 'completed');
  assert.deepEqual(h.installs, []);
  assert.match(h.reports[h.reports.length - 1].message, /不是 CodeAgent 官方来源/);
});

test('P3 同一时刻只接管一个下载：第二个明确取消并提示，第一个照常交给安装', () => {
  const h = handlerHarness();
  const a = fakeItem({ chain: ['https://csop.example.com/Cli3.0-Setup.exe'] });
  const b = fakeItem({ name: 'Cli3.1-Setup.exe', chain: ['https://csop.example.com/Cli3.1-Setup.exe'] });
  h.ses.emit('will-download', {}, a);
  h.ses.emit('will-download', {}, b);
  assert.ok(a.savePath && !a.cancelled);
  assert.equal(b.cancelled, true);
  assert.match(h.reports[h.reports.length - 1].message, /已经在接管一个下载/);
  a.emit('done', {}, 'completed');
  assert.deepEqual(h.installs, [a.savePath]);
  const c = fakeItem({ chain: ['https://csop.example.com/Cli3.0-Setup.exe'] });
  h.ses.emit('will-download', {}, c);
  assert.ok(c.savePath && !c.cancelled, '前一个下载结束后可以再接管');
});

// ---- P4：账号页从「一键安装」到下载后的终态全程订阅 ----
function fakeClient(startResult) {
  const listeners = new Set();
  return {
    emit: s => { for (const fn of listeners) fn(s); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    listeners,
    start: async () => startResult,
    openOfficial: async () => ({ ok: true }),
  };
}

test('P4 账号页一键安装：要先下载时继续订阅，下载后的管理员确认取消原因能显示出来', async () => {
  const client = fakeClient({ phase: 'need-download', downloadPage: PAGE, message: '这台电脑上还没有 CodeAgent 安装包' });
  const messages = []; let waiting = null, settled = null;
  runOneClick(client, { onMessage: m => messages.push(m), onWaiting: m => { waiting = m; }, onSettled: s => { settled = s; } });
  await sleep(10);
  assert.match(waiting, /官方下载页/);
  assert.equal(settled, null, '打开官方页不是终态');
  assert.equal(client.listeners.size, 1, '等下载期间保持订阅');
  client.emit({ phase: 'installing', message: '正在静默安装 CodeAgent…' });
  client.emit({ phase: 'error', code: 'CA_INSTALL_UAC', message: '系统授权（管理员确认）被取消了' });
  assert.equal(settled.phase, 'error');
  assert.match(settled.message, /管理员确认/);
  assert.ok(messages.some(m => /静默安装/.test(m)));
  assert.equal(client.listeners.size, 0, '到终态才退订');
});

test('P4 直接完成或失败：一次就到终态；页面关闭时 stop() 退订', async () => {
  const done = fakeClient({ phase: 'error', message: '升级没有成功（退出码 1）' });
  let settled = null;
  runOneClick(done, { onSettled: s => { settled = s; } });
  await sleep(10);
  assert.match(settled.message, /退出码 1/);
  assert.equal(done.listeners.size, 0);
  const waitingClient = fakeClient({ phase: 'need-download', downloadPage: PAGE });
  const run = runOneClick(waitingClient, {});
  await sleep(10);
  run.stop();
  assert.equal(waitingClient.listeners.size, 0);
});
