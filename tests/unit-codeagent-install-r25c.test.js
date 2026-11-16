'use strict';
// r25c 复审返工回归（2026-11-17，rsi/r25审-结论.md 末段 m42 复审）：撤掉任一修复，对应用例会红。
//   P1-a 超时定局：结束进程树期间包装进程先退出，close 不能把超时改判为普通失败；确认整棵树退出后才清理、释放占用。
//   P1-b 升级强停失败：没确认更新器退出就保持占用，不启动第二次升级/安装，给人话提示。
//   P2   官方来源只认显式主机名单，不放行公司根域及全部子域；跳转后的最终地址、下载最终地址也校验。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createCodeAgentInstaller, runHidden, isAlive } = require('../core/codeagent-install');
const { registerCodeAgentInstallIpc, isOfficialUrl, buildOfficialHosts } = require('../main/ipc/codeagent-install-handlers');

const GOOD_SIG = { status: 'Valid', subject: 'CN=CodeAgentCLI3.0, O=Huawei, C=CN' };
const made = [];
const procs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-r25c-')); made.push(d); return d; };
test.after(() => {
  for (const c of procs) if (isAlive(c.pid)) { try { process.kill(c.pid); } catch { /* 已退出 */ } }
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 无害替身进程：隐藏窗口，ms 后自行退出，不会遗留。
const standIn = (ms = 15000) => { const c = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { windowsHide: true, stdio: 'ignore' }); procs.push(c); return c; };
const waitExitReal = pid => new Promise(r => { const t = setInterval(() => { if (!isAlive(pid)) { clearInterval(t); r(); } }, 100); });
const deny = async () => ({ ok: false, output: 'simulated Access is denied' });
function fakeInstaller(dir) {
  const file = path.join(dir, 'Cli3.0-Setup.exe');
  fs.writeFileSync(file, 'MZ'); fs.truncateSync(file, 25 * 1024 * 1024);
  return file;
}
const pidFileOf = args => (String(args[args.length - 1]).match(/-LiteralPath '([^']+installer\.pid)'/) || [])[1];
// m42 的时序：计时器触发后包装进程先退出（close 抢先到达），结束进程树的结果随后才回来、且报失败。
const wrapperExitsFirst = async pid => { process.kill(pid); await sleep(300); return { ok: false, output: 'simulated access denied' }; };

// ---- P1-a：超时一旦触发就定局 ----
test('P1-a runHidden：结束进程树期间包装进程先退出，结果仍是超时，并报回没退出的后代', async () => {
  const kept = standIn();
  const r = await runHidden(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeout: 200, kill: wrapperExitsFirst, tree: async pid => [pid, kept.pid], settleMs: 200,
  });
  assert.equal(r.timedOut, true, `close 抢先把超时改判成了 ${JSON.stringify(r)}`);
  assert.equal(r.code, 'timeout');
  assert.equal(r.killed, false);
  assert.deepEqual(r.survivors, [kept.pid], '结束前记下的后代仍活着，要报回');
});

test('P1-a runHidden：树能结束时，确认全部退出后才返回 killed=true', async () => {
  const kid = standIn();
  const r = await runHidden(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeout: 200, tree: async pid => [pid, kid.pid], settleMs: 2000,
    kill: async pid => { process.kill(pid); setTimeout(() => process.kill(kid.pid), 100); return { ok: true }; },
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.killed, true, JSON.stringify(r));
  assert.deepEqual(r.survivors, []);
  assert.equal(isAlive(kid.pid), false);
});

test('P1-a runHidden：没超时的正常退出照常返回退出码', async () => {
  const r = await runHidden(process.execPath, ['-e', 'process.exit(3)'], { timeout: 5000 });
  assert.equal(r.timedOut, false); assert.equal(r.code, 3);
});

test('P1-a 安装超时 + close 抢先 + 安装器结束不了：保留任务目录与占用，安装器退出后才清理释放', async () => {
  const dir = tmp();
  const inst = standIn(1500);
  let pidFile, runs = 0;
  const installer = createCodeAgentInstaller({
    dataDir: dir, platform: 'win32', resolveCommand: () => '', localInstallers: () => [{ path: fakeInstaller(tmp()) }],
    signature: async () => GOOD_SIG, kill: deny, settleMs: 200, waitExit: waitExitReal,
    run: async (_f, args) => {
      runs++; pidFile = pidFileOf(args); fs.writeFileSync(pidFile, String(inst.pid));
      return runHidden(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 200, kill: wrapperExitsFirst, tree: async pid => [pid], settleMs: 200 });
    },
  });
  const r = await installer.start();
  assert.equal(r.code, 'CA_INSTALL_STILL_RUNNING', r.message);
  assert.equal(fs.existsSync(path.dirname(pidFile)), true, '安装器还活着，任务目录不能删');
  assert.equal(installer.busy(), true, '安装器还活着，不能释放占用');
  assert.equal((await installer.start()).code, 'CA_INSTALL_STILL_RUNNING');
  assert.equal(runs, 1, '不会启动第二个安装');
  await waitExitReal(inst.pid); await sleep(300);
  assert.equal(fs.existsSync(path.dirname(pidFile)), false, '安装器退出后清理任务目录');
  assert.equal(installer.busy(), false);
});

test('P1-a 安装超时、没有安装器 PID 但包装进程结束不了：不当成「管理员确认没点」清理，继续占用', async () => {
  const wrapper = standIn(1500);
  const installer = createCodeAgentInstaller({
    dataDir: tmp(), platform: 'win32', resolveCommand: () => '', localInstallers: () => [{ path: fakeInstaller(tmp()) }],
    signature: async () => GOOD_SIG, kill: deny, settleMs: 100, waitExit: waitExitReal,
    run: async () => ({ code: 'timeout', timedOut: true, killed: false, pid: wrapper.pid, survivors: [wrapper.pid] }),
  });
  const r = await installer.start();
  assert.equal(r.code, 'CA_INSTALL_STILL_RUNNING', r.message);
  assert.equal(installer.busy(), true);
  await waitExitReal(wrapper.pid); await sleep(300);
  assert.equal(installer.busy(), false);
});

// ---- P1-b：升级强停失败要继续占用 ----
test('P1-b 升级超时且更新器结束不了：保持占用、不启动第二次升级，给人话；退出后重新查找并释放', async () => {
  const updater = standIn(1500);
  let runs = 0, rediscovered = 0;
  const up = createCodeAgentInstaller({
    platform: 'win32', resolveCommand: () => 'codeagent', probeVersion: async () => '1.0.0', rediscover: async () => { rediscovered++; },
    kill: deny, settleMs: 100, waitExit: waitExitReal,
    run: async () => { runs++; return { code: 'timeout', timedOut: true, killed: false, pid: updater.pid, killOutput: 'Access is denied' }; },
  });
  const first = await up.start();
  assert.equal(first.code, 'CA_UPDATE_STILL_RUNNING', first.message);
  assert.match(first.message, /升级 20 分钟还没结束.*不会再启动新的升级或安装/);
  assert.equal(up.busy(), true, '更新器没退出前保持占用');
  const second = await up.start();
  assert.equal(second.code, 'CA_UPDATE_STILL_RUNNING');
  assert.equal(runs, 1, '不会启动第二次升级');
  await waitExitReal(updater.pid); await sleep(300);
  assert.equal(up.busy(), false);
  assert.equal(rediscovered, 1, '更新器退出后重新查找 CodeAgent');
});

test('P1-b 升级超时但确认已结束：照常报超时失败并释放占用', async () => {
  const up = createCodeAgentInstaller({
    platform: 'win32', resolveCommand: () => 'codeagent', probeVersion: async () => '1.0.0', alive: () => false, settleMs: 0,
    run: async () => ({ code: 'timeout', timedOut: true, killed: true, pid: 1, survivors: [] }),
  });
  const r = await up.start();
  assert.equal(r.code, 'CA_UPDATE_FAILED');
  await sleep(10);
  assert.equal(up.busy(), false);
});

// ---- P2：官方来源精确到主机 ----
test('P2 官方主机名单：取已批准配置里的具体主机，不含根域和未确认子域', () => {
  const cfg = require('../core/codeagent-upgrade.json');
  const hosts = buildOfficialHosts({ downloadPage: cfg.downloadPage, extraUrls: [cfg.yellowZoneDownload], extraHosts: cfg.officialHosts });
  const pageHost = new URL(cfg.downloadPage).hostname;
  assert.ok(hosts.includes(pageHost));
  const root = pageHost.split('.').slice(-2).join('.');
  assert.equal(hosts.includes(root), false);
  assert.equal(isOfficialUrl(`https://unconfirmed.${root}/anything.exe`, hosts), false, '未确认的公司子域不得放行');
  assert.equal(isOfficialUrl(`https://${root}/x`, hosts), false);
  assert.equal(isOfficialUrl(`https://${pageHost}/csop/x`, hosts), true);
  assert.equal(isOfficialUrl(`https://${pageHost}.evil.invalid/x`, hosts), false);
  assert.equal(isOfficialUrl(`http://${pageHost}/x`, hosts), false);
  assert.deepEqual(buildOfficialHosts({ downloadPage: 'https://a.example.com/p', extraHosts: ['SSO.Example.com', '', 'bad host'] }), ['a.example.com', 'sso.example.com']);
});

function harness() {
  const handles = {}, reports = [], installs = [];
  let state = { phase: 'idle' };
  const installer = { snapshot: () => state, report: p => { state = p; reports.push(p); return p; }, start: async () => state, installFile: f => { installs.push(f); return new Promise(() => {}); } };
  const windows = [];
  const ses = new EventEmitter();
  class BrowserWindow extends EventEmitter {
    constructor() { super(); this.loaded = []; this.webContents = new EventEmitter(); this.webContents.stop = () => { this.stopped = true; }; this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; }; windows.push(this); }
    loadURL(u) { this.loaded.push(u); return Promise.resolve(); }
    isDestroyed() { return false; } show() {} focus() {} close() {}
  }
  const page = 'https://csop.example.com/csop/index.html';
  registerCodeAgentInstallIpc({ handle: (ch, fn) => { handles[ch] = fn; } }, { dataDir: tmp(), send: () => {}, electron: { BrowserWindow, session: { fromPartition: () => ses } }, installer, downloadPage: page });
  handles['codeagent-install:open-official']();
  return { win: windows[0], ses, reports, installs, page };
}
const item = (chain, final = chain[chain.length - 1]) => {
  const it = new EventEmitter();
  Object.assign(it, { getFilename: () => 'Cli3.0-Setup.exe', getURLChain: () => chain, getURL: () => final, getTotalBytes: () => 1, getReceivedBytes: () => 1, setSavePath(p) { this.savePath = p; }, cancel() { this.cancelled = true; } });
  return it;
};

test('P2 官方下载窗口：同公司的未确认子域页面跳转、重定向、新窗口一律拦下', () => {
  const h = harness();
  for (const ev of ['will-navigate', 'will-redirect']) {
    let prevented = false;
    h.win.webContents.emit(ev, { url: 'https://unconfirmed.example.com/login', isMainFrame: true, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, ev + ' 放行了未确认子域');
  }
  h.win.openHandler({ url: 'https://unconfirmed.example.com/x' });
  assert.equal(h.win.loaded.includes('https://unconfirmed.example.com/x'), false);
  assert.match(h.reports[h.reports.length - 1].message, /不是 CodeAgent 官方来源（unconfirmed\.example\.com）/);
});

test('P2 跳转后的最终地址不是官方主机：停下并退回官方下载页', () => {
  const h = harness();
  const before = h.win.loaded.length;
  h.win.webContents.emit('did-navigate', {}, 'https://csop.example.com/csop/next');
  assert.equal(h.win.loaded.length, before, '官方主机不应被退回');
  h.win.webContents.emit('did-navigate', {}, 'https://other.example.com/landing');
  assert.equal(h.win.stopped, true);
  assert.equal(h.win.loaded[h.win.loaded.length - 1], h.page);
  assert.match(h.reports[h.reports.length - 1].message, /跳转后的页面不是 CodeAgent 官方来源（other\.example\.com）/);
});

test('P2 下载：重定向后的最终地址落到未确认子域，取消且不安装', () => {
  const h = harness();
  const it = item(['https://csop.example.com/dl'], 'https://cdn.example.com/Cli3.0-Setup.exe');
  h.ses.emit('will-download', {}, it);
  assert.equal(it.cancelled, true);
  assert.equal(it.savePath, undefined);
  assert.deepEqual(h.installs, []);
  const ok = item(['https://csop.example.com/dl', 'https://csop.example.com/Cli3.0-Setup.exe']);
  h.ses.emit('will-download', {}, ok);
  assert.ok(ok.savePath && !ok.cancelled, '全程官方主机的下载照常接管');
});

// ---- r25 三审：进程树列不出来、包装进程已退出，后代可能仍活 ----
test('三审 升级超时且进程树未知：包装进程已退出也保持占用、不启动第二次升级，限时后释放', async () => {
  let runs = 0;
  const up = createCodeAgentInstaller({
    platform: 'win32', resolveCommand: () => 'codeagent', probeVersion: async () => '1.0.0', rediscover: async () => {},
    alive: () => false, settleMs: 0, unknownHoldMs: 400,
    run: async () => { runs++; return { code: 'timeout', timedOut: true, killed: true, pid: 1, survivors: [], treeUnknown: true }; },
  });
  const first = await up.start();
  assert.equal(first.code, 'CA_UPDATE_STILL_RUNNING', first.message);
  assert.equal(up.busy(), true, '后代未知时保持占用');
  const second = await up.start();
  assert.equal(second.code, 'CA_UPDATE_STILL_RUNNING');
  assert.equal(runs, 1, '不会启动第二次升级');
  await sleep(700);
  assert.equal(up.busy(), false, '限时后释放');
});

test('三审 runHidden 进程树查询失败时标记 treeUnknown', async () => {
  const { runHidden } = require('../core/codeagent-install');
  const r = await runHidden(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {
    timeout: 200, settleMs: 100, tree: async pid => Object.assign([pid], { unknown: true }), kill: async () => ({ ok: true, output: '' }),
    alive: () => false,
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.treeUnknown, true);
});

test('三审补 进程树未知时默认一直占用到 Hub 重启，不会到点自动放出第二次升级', async () => {
  let runs = 0;
  const up = createCodeAgentInstaller({
    platform: 'win32', resolveCommand: () => 'codeagent', probeVersion: async () => '1.0.0', rediscover: async () => {},
    alive: () => false, settleMs: 0,
    run: async () => { runs++; return { code: 'timeout', timedOut: true, killed: true, pid: 1, survivors: [], treeUnknown: true }; },
  });
  await up.start();
  await sleep(500);
  assert.equal(up.busy(), true);
  const again = await up.start();
  assert.equal(again.code, 'CA_UPDATE_STILL_RUNNING');
  assert.match(again.message, /重启 AI HUB/);
  assert.equal(runs, 1);
});
