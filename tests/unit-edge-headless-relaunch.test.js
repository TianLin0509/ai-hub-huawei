'use strict';
// 无头 Edge「启动进程先退出、由另一个进程接着跑浏览器」（2026-11-20 同事真机：5.6.64/65 门户取数全在 1.4–1.6 秒报「无头 Edge 没有启动」）。
// 用真进程模拟：fake 启动进程拉起一个「浏览器」子进程后自己退出；浏览器监听端口 0、把端口写进 DevToolsActivePort。
// 两边都要守住：能起来（不因启动进程退出就判失败），不泛滥（名额仍是 1 个、结束时按真正的浏览器进程号收掉、认不出进程号就让它自己关）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { holdEventLoop } = require('./helpers/hold-event-loop');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { launchHeadlessEdge } = require('../main/edge-headless');
const { createChildLifecycle, pidAlive } = require('../core/child-lifecycle');

const plenty = { freeMem: () => 8 * 1024 ** 3, totalMem: () => 16 * 1024 ** 3 };
const quiet = { warn() {}, info() {} };
const wait = ms => new Promise(r => setTimeout(r, ms));

// 「浏览器」：端口 0 起 HTTP，/json/version 让 readPort 认作已起来，/pid 报自己的进程号，/close 自行退出。
const BROWSER_JS = `
const http = require('http'); const fs = require('fs'); const path = require('path');
// 和真 Edge 一样，命令行带 --user-data-dir=<本次专用目录>（兜底收尾按它认进程）；noport 时只跑着、不写端口（模拟卡住的浏览器）。
const dir = process.argv[2].slice('--user-data-dir='.length);
const noport = process.argv[3] === 'noport';
if (noport) { setTimeout(() => process.exit(0), 60000); return; }
const srv = http.createServer((req, res) => {
  if (req.url === '/pid') return res.end(JSON.stringify({ pid: process.pid }));
  if (req.url === '/close') { res.end('{}'); setTimeout(() => process.exit(0), 50); return; }
  res.end(JSON.stringify({ Browser: 'fake', webSocketDebuggerUrl: '' }));
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), srv.address().port + '\\n/devtools/browser/x'));
setTimeout(() => process.exit(0), 60000);`;
// 「启动进程」：
//   relaunch 拉起浏览器后 300ms 自己退出（模拟 Edge 交接）；noport 同上但接手的浏览器一直不写端口；
//   linger 拉起浏览器后自己一直不走；die 直接以退出码 21 退出、没人接手。
const LAUNCHER_JS = `
const { spawn } = require('child_process');
const [mode, browserJs, dir] = process.argv.slice(2);
if (mode === 'die') process.exit(21);
// detached：不随启动进程的作业对象一起结束（真 Edge 交接后浏览器也独立运行）；这个假浏览器不再拉起任何命令行程序，不会弹窗。
const c = spawn(process.execPath, [browserJs, '--user-data-dir=' + dir, mode], { windowsHide: true, stdio: 'ignore', detached: true }); c.unref();
setTimeout(() => process.exit(mode === 'noport' ? 7 : 0), mode === 'linger' ? 60000 : 300);`;

function fixture(t) {
  holdEventLoop(t); // 启动进程退出后，只剩 detached 的假浏览器和 unref 的轮询定时器
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-relaunch-'));
  fs.writeFileSync(path.join(d, 'browser.js'), BROWSER_JS);
  fs.writeFileSync(path.join(d, 'launcher.js'), LAUNCHER_JS);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
// spawnFn 代替 msedge.exe：从参数里取 --user-data-dir，交给 fake 启动进程。
function spawnFake(d, mode) {
  return (exe, args, opts) => {
    const ud = args.find(a => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    // 去掉测试运行器的环境变量：带着它的 node 子进程会被当成测试子进程。
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    return spawn(process.execPath, [path.join(d, 'launcher.js'), mode, path.join(d, 'browser.js'), ud], { ...opts, env });
  };
}
const pidOfFake = async port => (await (await fetch(`http://127.0.0.1:${port}/pid`)).json()).pid;
const closeFake = async port => { try { await fetch(`http://127.0.0.1:${port}/close`); return true; } catch { return false; } };

test('启动进程先退出、浏览器由别的进程接着跑：能起来，并改按真正的浏览器进程登记、结束', async t => {
  const d = fixture(t);
  const lc = createChildLifecycle({ watchMs: 0, ...plenty, env: {}, logger: quiet });
  const edge = await launchHeadlessEdge({ purpose: '门户待办取数', tag: 'hub-rsitest', edgePath: 'fake-msedge.exe', lifecycle: lc, logger: quiet,
    spawnFn: spawnFake(d, 'relaunch'), findBrowserPid: pidOfFake, startWaitMs: 15000 });
  t.after(() => { if (pidAlive(edge.pid)) try { process.kill(edge.pid); } catch { /* 已退 */ } });
  assert.ok(edge.port > 0);
  assert.notEqual(edge.pid, edge.proc.pid, '认出的是接手的浏览器进程');
  for (let i = 0; i < 30 && edge.proc.exitCode === null; i += 1) await wait(100);
  assert.notEqual(edge.proc.exitCode, null, '启动进程已退出');
  assert.equal(edge.closed, false, '启动进程退出不算断开（修前门户取数在这里报「连接断了」）');
  assert.deepEqual(lc.status().active.map(e => e.pid), [edge.pid], '登记的是浏览器进程，不是已退出的启动进程');
  // 不泛滥：第一个还占着名额时，第二个排队拿不到。
  await assert.rejects(lc.acquire('edge', { waitMs: 200 }), e => e.code === 'CHILD_QUEUE_TIMEOUT');
  const pid = edge.pid;
  await edge.close();
  for (let i = 0; i < 150 && pidAlive(pid); i += 1) await wait(100);
  assert.equal(pidAlive(pid), false, '结束时按浏览器进程号收掉整棵树');
  assert.equal(lc.status().used.edge, 0, '名额交还');
  assert.equal(lc.status().active.length, 0);
});

test('启动进程退出、又认不出接手的进程号：让浏览器自己关掉，这次失败、名额交还，不留收不掉的 Edge', async t => {
  const d = fixture(t);
  const lc = createChildLifecycle({ watchMs: 0, ...plenty, env: {}, logger: quiet });
  let browserPid = 0, closedVia = 0;
  await assert.rejects(launchHeadlessEdge({ purpose: 't', tag: 'hub-rsitest', edgePath: 'fake-msedge.exe', lifecycle: lc, logger: quiet,
    spawnFn: spawnFake(d, 'relaunch'), startWaitMs: 15000,
    // 等启动进程退出后再回答「认不出」，固定走兜底分支。
    findBrowserPid: async port => { browserPid = await pidOfFake(port); await wait(1000); return 0; },
    closeViaCdp: async port => { closedVia += 1; return closeFake(port); } }), /认不出接手的进程，已让它自行关闭/);
  assert.ok(closedVia >= 1, '经调试协议让它自行关闭');
  for (let i = 0; i < 150 && pidAlive(browserPid); i += 1) await wait(100);
  assert.equal(pidAlive(browserPid), false, '浏览器已自行关闭');
  assert.equal(lc.status().used.edge, 0, '名额交还');
});

test('启动进程退出、确实没人接手：等到期限报「没有启动」，附退出用时和退出码，名额交还', async t => {
  const d = fixture(t);
  const lc = createChildLifecycle({ watchMs: 0, ...plenty, env: {}, logger: quiet });
  await assert.rejects(launchHeadlessEdge({ purpose: 't', tag: 'hub-rsitest', edgePath: 'fake-msedge.exe', lifecycle: lc, logger: quiet,
    spawnFn: spawnFake(d, 'die'), findBrowserPid: async () => { throw new Error('不该走到'); }, startWaitMs: 6000 }),
  e => /无头 Edge 没有启动（启动进程 [\d.]+ 秒后退出，退出码 21[，）]/.test(e.message));
  assert.equal(lc.status().used.edge, 0);
  assert.equal(lc.status().active.length, 0);
});

// 审查返工（2026-11-21）：启动进程退出、端口一直没起来，但接手的浏览器其实还在跑——按 PID 的回收落不到它身上，必须按本次专用目录收掉。
const { findByUserDataDir } = require('../main/edge-headless');
const findNodeByDir = dir => findByUserDataDir(dir, { image: 'node.exe' });

test('端口一直不出现、启动进程已退出、接手的浏览器仍在跑：按本次专用目录收掉，再报错、交还名额', { skip: process.platform !== 'win32' }, async t => {
  const d = fixture(t);
  const lc = createChildLifecycle({ watchMs: 0, ...plenty, env: {}, logger: quiet });
  let ud = '', seen = [];
  const spawnFn = (exe, args, opts) => { ud = args.find(a => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length); return spawnFake(d, 'noport')(exe, args, opts); };
  const findByDir = async dir => { const l = await findNodeByDir(dir); if (l?.length) seen = l.map(x => x.pid); return l; };
  t.after(() => { for (const pid of seen) if (pidAlive(pid)) try { process.kill(pid); } catch { /* 已退 */ } });
  await assert.rejects(launchHeadlessEdge({ purpose: 't', tag: 'hub-rsitest', edgePath: 'fake-msedge.exe', lifecycle: lc, logger: quiet,
    spawnFn, findByDir, findBrowserPid: async () => { throw new Error('不该走到'); }, startWaitMs: 7000 }), /没有启动（启动进程 [\d.]+ 秒后退出，退出码 7）/);
  assert.ok(seen.length >= 1, '期间确实有接手的浏览器在跑（非 0 退出码也没有提前放弃）');
  for (const pid of seen) assert.equal(pidAlive(pid), false, `接手的浏览器 ${pid} 已被收掉（修前会一直留着）`);
  assert.deepEqual(await findNodeByDir(ud), [], '本次专用目录下一个进程都不剩');
  assert.equal(lc.status().used.edge, 0, '收完才交还名额');
});

test('启动进程以非 0 码退出、专用目录下也没有进程：5 秒左右就报失败，不占满 20 秒名额', async t => {
  const d = fixture(t);
  const lc = createChildLifecycle({ watchMs: 0, ...plenty, env: {}, logger: quiet });
  const t0 = Date.now();
  await assert.rejects(launchHeadlessEdge({ purpose: 't', tag: 'hub-rsitest', edgePath: 'fake-msedge.exe', lifecycle: lc, logger: quiet,
    spawnFn: spawnFake(d, 'die'), findByDir: async () => [], startWaitMs: 20000 }), /退出码 21，没有进程接手/);
  assert.ok(Date.now() - t0 < 10000, `用时 ${Date.now() - t0}ms`);
  assert.equal(lc.status().used.edge, 0);
});

test('启动进程还活着、浏览器跑在另一个进程：改认浏览器进程，关闭时两个都收掉', async t => {
  const d = fixture(t);
  const lc = createChildLifecycle({ watchMs: 0, ...plenty, env: {}, logger: quiet });
  const edge = await launchHeadlessEdge({ purpose: 't', tag: 'hub-rsitest', edgePath: 'fake-msedge.exe', lifecycle: lc, logger: quiet,
    spawnFn: spawnFake(d, 'linger'), findBrowserPid: pidOfFake, startWaitMs: 15000 });
  const pid = edge.pid, launcherPid = edge.proc.pid;
  t.after(() => { for (const p of [pid, launcherPid]) if (pidAlive(p)) try { process.kill(p); } catch { /* 已退 */ } });
  assert.notEqual(pid, launcherPid);
  assert.equal(edge.proc.exitCode, null, '启动进程还在');
  assert.deepEqual(lc.status().active.map(e => e.pid), [pid], '登记改成浏览器进程');
  assert.equal(edge.closed, false);
  await edge.close();
  for (let i = 0; i < 150 && (pidAlive(pid) || pidAlive(launcherPid)); i += 1) await wait(100);
  assert.equal(pidAlive(pid), false, '浏览器进程已结束');
  assert.equal(pidAlive(launcherPid), false, '启动进程也顺手结束');
  assert.equal(lc.status().used.edge, 0);
});
