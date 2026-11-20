'use strict';
//   - 先向 core/child-lifecycle.js 申请 edge 名额（默认同时 1 个，CLAUDE_HUB_EDGE_MAX 可调），多出的排队；内存紧张时先等、等不到这次不开；
//   - 起来就登记 PID、启动时间、用途和临时目录，带最长运行时间：超时由登记层按 PID 结束整棵树并删目录，调用方卡住也收得掉；
//   - 调试端口用 --remote-debugging-port=0 + DevToolsActivePort 文件，不再随机挑端口撞车；
//   - 不弹窗（--headless=new + windowsHide），不改用户自己的 Edge 资料。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { getChildLifecycle, pidAlive, defaultKillTree } = require('../core/child-lifecycle');

const delay = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
const OWNER_FILE = 'hub-owner.json';

function findEdge(env = process.env) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, 'C:/Program Files (x86)', 'C:/Program Files'].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (fs.existsSync(p)) return p;
  }
  return '';
}
function markOwner(tmp, pid = process.pid) {
  try { fs.writeFileSync(path.join(tmp, OWNER_FILE), JSON.stringify({ pid, at: Date.now() })); } catch { /* 少一层保护：回收前还有改名探测 */ }
}

// 等 DevToolsActivePort 出现并能连上。启动进程自己先退出不算失败（2026-11-20 同事真机：5.6.64/65 上门户取数全在 1.4–1.6 秒报
// 「无头 Edge 没有启动」——拉起的 msedge.exe 一秒左右就退出、由它交给另一个进程接着跑浏览器；5.6.61 以前只看端口不看进程，所以没事）。
// 只有拉起本身出错（找不到文件、拒绝访问）才立刻放弃；其余等到期限。launcher 记下启动进程何时、以什么退出码退出，写进失败原因。
// 尽早失败：启动进程以非 0 码退出、过了 EXIT_GRACE_MS 还没有端口，并且问 anyRunning() 确认本次专用目录下已没有 Edge 进程，就不再占满 20 秒名额。
const EXIT_GRACE_MS = 5000;
async function readPort(tmp, proc, waitMs, launcher = {}, anyRunning = null) {
  const until = Date.now() + waitMs;
  let probed = false;
  while (Date.now() < until) {
    if (proc.spawnError) return 0;
    if (proc.exitCode !== null && !launcher.exitedAt) { launcher.exitedAt = Date.now(); launcher.code = proc.exitCode; }
    if (!probed && anyRunning && launcher.exitedAt && launcher.code !== 0 && Date.now() - launcher.exitedAt >= EXIT_GRACE_MS) {
      probed = true;
      try { if (!(await anyRunning())) { launcher.nobody = true; return 0; } } catch { /* 查不到就照常等到期限 */ }
    }
    try {
      const port = Number(fs.readFileSync(path.join(tmp, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
      if (port > 0) { await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).json(); return port; }
    } catch { /* 还没起来 */ }
    await delay(300);
  }
  return 0;
}

// 真正在跑浏览器的进程号：问调试协议（SystemInfo.getProcessInfo 里 type=browser 的那个）。查不到返回 0。
async function browserPidOf(port) {
  let cdp = null;
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
    cdp = await connectCdp(v.webSocketDebuggerUrl, { openMs: 5000, sendMs: 5000 });
    const r = await cdp.send('SystemInfo.getProcessInfo');
    const b = (r?.result?.processInfo || []).find(p => p.type === 'browser');
    return Number.isInteger(b?.id) && b.id > 0 ? b.id : 0;
  } catch { return 0; } finally { cdp?.close(); }
}
// 命令行里带着本次专用临时目录（--user-data-dir 指向的 mkdtemp 随机路径）的进程号。只认这个每次新建、随机命名的路径，从不按进程名批量结束。
// image 只是缩小查询范围（默认 msedge.exe）；查询失败返回 null（和「一个都没有」区分开）。
function findByUserDataDir(dir, { image = 'msedge.exe', timeoutMs = 15000 } = {}) {
  if (process.platform !== 'win32' || !dir) return Promise.resolve(null);
  const want = dir; // 只认路径本身：用户名带空格时 Edge 会给参数加引号，--user-data-dir=<路径> 整串就对不上了
  const script = `$w = $env:HUB_EDGE_DIR_ARG; Get-CimInstance Win32_Process -Filter "Name='${image.replace(/'/g, '')}'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($w) } | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }`;
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, HUB_EDGE_DIR_ARG: want } }, (error, stdout) => {
      if (error) return resolve(null);
      const out = [];
      for (const line of String(stdout).split(/\r?\n/)) { const [pid, ppid] = line.trim().split(/\s+/).map(Number); if (pid > 0) out.push({ pid, ppid: ppid || 0 }); }
      resolve(out);
    });
  });
}

// 认不出进程号时的兜底：经调试协议让浏览器自己整个关掉，不留一个按 PID 收不掉的 Edge。
async function closeBrowserViaCdp(port) {
  let cdp = null;
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
    cdp = await connectCdp(v.webSocketDebuggerUrl, { openMs: 5000, sendMs: 3000 });
    await cdp.send('Browser.close');
    return true;
  } catch { return false; } finally { cdp?.close(); }
}

// 返回 { proc, port, tmp, close(), closeSync() }；失败抛错（名额、内存、启动失败）。
// prepare(tmp) 在启动前调用（复制登录状态等），抛错即放弃且已收尾。
async function launchHeadlessEdge({ purpose, owner = '', tag = 'hub-edge', env = process.env, prepare = null, extraArgs = [], maxLifeMs = 10 * 60000,
  startWaitMs = 20000, waitMs, signal = null, logger = console, lifecycle = getChildLifecycle(), edgePath = '', spawnFn = spawn,
  findBrowserPid = browserPidOf, closeViaCdp = closeBrowserViaCdp, isAlive = pidAlive, findByDir = findByUserDataDir, killTree = defaultKillTree } = {}) {
  const edge = edgePath || findEdge(env);
  if (!edge) throw new Error('本机没有找到 Edge');
  const release = await lifecycle.acquire('edge', { purpose, waitMs, signal });
  // browserPid：真正在跑浏览器的进程（启动进程交给别的进程接着跑时与 proc.pid 不同），登记、结束、判活都认它。
  let tmp = '', proc = null, regId = '', closed = false, released = false, waitingExit = false, browserPid = 0;
  const cleanupDir = () => { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch (e) { logger.warn?.(`[${tag}] Edge 临时目录未删净，下次启动时再清`, e.code || e.message); } } };
  const releaseOnce = () => { if (!released) { released = true; release(); } };
  const launcherAlive = () => !!(proc && proc.pid && !proc.spawnError && proc.exitCode === null && proc.signalCode == null);
  const procAlive = () => (browserPid && browserPid !== proc?.pid ? isAlive(browserPid) : launcherAlive());
  function closeSync() {
    if (released) return;
    closed = true;
    // 按 PID 结束整棵树 + 删目录 + 注销；进程已自己退出并注销过时只删目录。
    const reclaimed = !!regId && lifecycle.reclaim(regId, '用完已关');
    // 改认了浏览器进程、启动进程却还没走：它不在登记里，顺手按它自己的 PID 结束，不留残余。
    if (browserPid && browserPid !== proc?.pid && launcherAlive()) { try { proc.kill(); } catch { /* 已退 */ } }
    if (!reclaimed && procAlive()) {
      // 结束失败（拒绝访问、taskkill 超时）且进程还活着：名额不交还，否则下一个功能又能开一个新 Edge，越积越多（审查 P2-3）。
      // 登记仍在，看门狗会接着收；进程真正退出时再删目录、交还名额。调用方再 close 一次也会重试结束。
      if (!waitingExit) {
        waitingExit = true;
        const done = () => { cleanupDir(); releaseOnce(); };
        if (browserPid && browserPid !== proc.pid) { const t = setInterval(() => { if (!isAlive(browserPid)) { clearInterval(t); done(); } }, 1000); t.unref?.(); }
        else proc.once('exit', done);
      }
      logger.warn?.(`[${tag}] 无头 Edge 结束失败，名额先不交还，等它退出（pid=${browserPid || proc.pid}）`);
      return;
    }
    if (!reclaimed) cleanupDir();
    releaseOnce();
  }
  async function close() {
    if (released) return;
    closeSync();
    if (!released) return;
    await delay(300);
    if (tmp && fs.existsSync(tmp)) { await delay(800); cleanupDir(); }
  }
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), tag + '-'));
    markOwner(tmp);
    if (prepare) await prepare(tmp);
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORT_ERR' });
    const startedAt = Date.now();
    proc = spawnFn(edge, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-mode', ...extraArgs, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    proc.on('error', e => { proc.spawnError = e; });
    const launcherRegId = proc.pid ? lifecycle.register({ pid: proc.pid, kind: 'edge', purpose, owner, userDataDir: tmp, maxLifeMs, startedAt }) : '';
    regId = launcherRegId;
    // Edge 自己退出就立刻注销：之后这个 PID 被别的进程复用，也不会再按它去结束（审查 #1）。只注销启动进程那条，改认的浏览器进程不受影响。
    proc.once('exit', () => { if (launcherRegId && regId === launcherRegId) lifecycle.unregister(launcherRegId, '进程已退出'); });
    const launcher = {};
    const port = await readPort(tmp, proc, startWaitMs, launcher, async () => { const l = await findByDir(tmp); return l === null ? true : l.length > 0; });
    if (!launcher.exitedAt && proc.exitCode !== null) { launcher.exitedAt = Date.now(); launcher.code = proc.exitCode; }
    if (!port) {
      if (proc.spawnError) throw new Error(`无头 Edge 启动失败（${proc.spawnError.code || proc.spawnError.message}）`);
      throw new Error(launcher.exitedAt ? `无头 Edge 没有启动（启动进程 ${((launcher.exitedAt - startedAt) / 1000).toFixed(1)} 秒后退出，退出码 ${launcher.code}${launcher.nobody ? '，没有进程接手' : ''}）` : '无头 Edge 没有启动');
    }
    // 认准真正跑浏览器的进程：启动进程已退出或很快会退出时，名额、超时强收、Hub 退出收尾都要落在它身上，否则就是一个没人管的 Edge。
    const real = await findBrowserPid(port);
    if (real && real !== proc.pid) {
      if (!isAlive(real)) throw new Error('无头 Edge 没有启动（浏览器进程已退出）');
      browserPid = real;
      if (launcherRegId && lifecycle.unregister) lifecycle.unregister(launcherRegId, '改认浏览器进程');
      regId = lifecycle.register({ pid: real, kind: 'edge', purpose, owner, userDataDir: tmp, maxLifeMs, startedAt: Math.min(Date.now(), launcher.exitedAt || startedAt) });
      logger.info?.(`[${tag}] 无头 Edge 由启动进程 ${proc.pid} 交给 ${real} 运行，已改按 ${real} 管理`);
    } else if (!real && !launcherAlive()) {
      // 启动进程已退出、又认不出接手的进程号：让浏览器自己关掉，宁可这次失败也不留收不掉的 Edge。
      const shut = await closeViaCdp(port);
      throw new Error(`无头 Edge 没有启动（启动进程已退出，认不出接手的进程${shut ? '，已让它自行关闭' : ''}）`);
    } else browserPid = proc.pid;
    return { proc, port, tmp, close, closeSync, get pid() { return browserPid; }, get closed() { return closed || !regId || !procAlive(); } };
  } catch (error) {
    // 启动进程已退出、又没认准接手的浏览器进程时，按 PID 的回收落不到它身上：交还名额之前先把本次专用目录下可能还在跑的 Edge 收掉。
    if (proc && !launcherAlive() && !(browserPid && browserPid !== proc.pid)) await sweepLeftover();
    await close();
    throw error;
  }
  // 兜底收尾：先读一次端口、经调试协议让它自己关；等一会儿还有，就按命令行含本次专用目录的进程逐棵结束。
  async function sweepLeftover() {
    try {
      let port = 0;
      try { port = Number(fs.readFileSync(path.join(tmp, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]) || 0; } catch { /* 没写端口 */ }
      if (port > 0 && await closeViaCdp(port)) { for (let i = 0; i < 5; i += 1) { const l = await findByDir(tmp); if (l && !l.length) return; await delay(300); } }
      const left = await findByDir(tmp);
      if (!left || !left.length) return;
      const pids = new Set(left.map(x => x.pid));
      const roots = left.filter(x => !pids.has(x.ppid)).map(x => x.pid);
      for (const pid of roots.length ? roots : [...pids]) killTree(pid);
      logger.warn?.(`[${tag}] 无头 Edge 启动没成功，按本次专用目录收掉残留进程 ${[...pids].join(',')}`);
    } catch (e) { logger.warn?.(`[${tag}] 无头 Edge 残留收尾出错`, e.message); }
  }
}

// 连上一个页面的调试协议：带打开超时；send 每个请求都有上限，连接断了在等的请求立刻收尾。
async function connectCdp(wsUrl, { openMs = 10000, sendMs = 15000, onEvent = null } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { try { ws.close(); } catch { /* 已关 */ } reject(new Error('连接无头 Edge 超时')); }, openMs);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = () => { clearTimeout(t); reject(new Error('连接无头 Edge 失败')); };
  });
  let id = 0, closed = false;
  const pending = new Map();
  ws.onclose = () => { closed = true; for (const r of pending.values()) r({ closed: true }); pending.clear(); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); return; }
    if (onEvent) { try { onEvent(m); } catch { /* 事件处理出错不影响连接 */ } }
  };
  function send(method, params = {}, ms = sendMs) {
    if (closed) return Promise.resolve({ closed: true });
    id += 1; const n = id;
    return new Promise(resolve => {
      const t = setTimeout(() => { pending.delete(n); resolve({ timeout: true }); }, ms);
      pending.set(n, m => { clearTimeout(t); resolve(m); });
      try { ws.send(JSON.stringify({ id: n, method, params })); } catch { clearTimeout(t); pending.delete(n); resolve({ closed: true }); }
    });
  }
  return { ws, send, get closed() { return closed; }, close() { try { ws.close(); } catch { /* 已关 */ } } };
}

module.exports = { launchHeadlessEdge, connectCdp, findEdge, markOwner, browserPidOf, findByUserDataDir, OWNER_FILE };
