'use strict';
// r43（2026-11-18）真实链路：升级进度小窗被叉掉、Hub 退出被取消之后，一键更新还能接着用。
// 隔离 Hub（隐藏窗口）+ 本机更新源 + 临时安装目录 + 真实的进度小窗（WPF，在私有桌面上显示）。
//   场景一：点「立即重启」后 Hub 退出被拦（界面有未保存内容，beforeunload）。以前小窗停在第 1 步干等 90 秒、旧 Hub 停在「正在应用」；
//           期望 Hub 立刻回到「已下载好」并说明原因、替换脚本结束、小窗自己关掉、检查更新照常。
//   场景二：替换时程序文件被别的程序占着，换不上已还原，小窗问「结束占用的程序并重试 / 先用原来的版本」时用户叉掉小窗
//           （发 WM_CLOSE，与点 × 同一个关闭事件）。期望按「先用原来的版本」重开旧版；重开的 Hub 没被守卫拦下、读到没升级的原因，
//           检查更新照常并重新提醒（只改末位的小版本也提醒）；占用解除后再升级成功并自动重开。
//   「别的 Hub 开着时叉掉小窗」要冒充装在安装目录里的 Hub，由 unit-app-update-upgrade-experience.test.js 覆盖。
// 必须在私有桌面上跑（进度小窗是真实窗口）：直接 node 运行时自动转到私有桌面（tests/helpers/window-flash-watch.py），用户屏幕上看不到任何窗口。
// 工作树没有自己的 node_modules 时设 NODE_PATH 指向主仓库的 node_modules。
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

if (process.platform !== 'win32') { console.log('skip: Windows only'); process.exit(0); }
if (process.env.HUB_R43_PRIVATE_DESKTOP !== '1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r43-flash-'));
  const flash = path.join(dir, 'flash.json'), log = path.join(dir, 'inner.log');
  spawnSync('python', [path.join(__dirname, 'helpers', 'window-flash-watch.py'), '--out', flash, '--grace-ms', '1500', '--', process.execPath, __filename],
    { env: { ...process.env, HUB_R43_PRIVATE_DESKTOP: '1', HUB_R43_LOG: log }, windowsHide: true, stdio: 'ignore', timeout: 900000 });
  let f = {}; try { f = JSON.parse(fs.readFileSync(flash, 'utf8')); } catch (_) {}
  try { process.stdout.write(fs.readFileSync(log, 'utf8')); } catch (_) { console.log('(没有内层日志)'); }
  const shown = [...new Set((f.visible || []).map(v => `${v.process}:${v.class}`))];
  console.log(`私有桌面=${f.privateDesktop} 内层退出码=${f.exitCode} 私有桌面上出现过的窗口（用户屏幕看不到）=${shown.join(', ') || '无'}`);
  process.exit(f.exitCode === 0 && f.privateDesktop ? 0 : 1);
}
if (process.env.HUB_R43_LOG) { const log = process.env.HUB_R43_LOG; console.log = (...a) => fs.appendFileSync(log, a.join(' ') + '\n'); }

const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { packPayload } = require('../core/app-update/payload');
const guard = require('../core/app-update/launch-guard');

const REPO = path.resolve(__dirname, '..');
const ELECTRON = require('electron');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const check = (results, name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; } };
const ps = cmd => { try { return execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim(); } catch (_) { return ''; } };
const alivePid = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (_) { return false; } };
// 进度小窗 = 父进程是替换脚本的 powershell；替换脚本拉起的新 Hub = 父进程是替换脚本的 electron（都按父进程号认，不按命令行认）。
// 一次 PowerShell 内部每 100 ms 看一次，小窗的窗口句柄出来就返回「进程号|句柄|标题」。
const findUi = (helper, seconds = 10) => ps(`$end=(Get-Date).AddSeconds(${seconds}); while((Get-Date) -lt $end){ $c = Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(helper)} AND Name='powershell.exe'" | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [string]$p.Id + '|' + $p.MainWindowHandle + '|' + $p.MainWindowTitle; break } }; Start-Sleep -Milliseconds 100 }`);
const childOf = ppid => Number(ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(ppid)} AND Name='electron.exe'" | Select-Object -First 1).ProcessId`)) || 0;
const pidOnPort = port => { try { const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }); const m = out.split(/\r?\n/).find(l => new RegExp(`127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING`).test(l)); return m ? Number(m.trim().split(/\s+/).pop()) : 0; } catch (_) { return 0; } };

(async () => {
  const current = JSON.parse(fs.readFileSync(path.join(REPO, 'community-edition.json'), 'utf8')).version;
  const [x, y, z] = current.split('.').map(Number);
  const next = `${x}.${y}.${z + 4}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r43-e2e-'));
  const data = path.join(root, 'data'), appDir = path.join(root, 'install'), resources = path.join(appDir, 'resources'), fresh = path.join(root, 'fresh');
  for (const d of [data, resources, fresh, path.join(root, 'work')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'work', '.aiwork-root'), '');
  fs.writeFileSync(path.join(resources, 'app.asar'), 'old-asar');
  fs.writeFileSync(path.join(fresh, 'app.asar'), crypto.randomBytes(4096));
  const gzFile = path.join(root, 'update.gz');
  packPayload(fresh, gzFile);
  const gz = fs.readFileSync(gzFile);
  const electronVersion = JSON.parse(fs.readFileSync(require.resolve('electron/package.json'), 'utf8')).version;
  const manifest = { schema: 1, product: 'test', version: next, publishedAt: new Date().toISOString(), notes: ['r43 关小窗测试'],
    runtime: { electron: electronVersion, native: {} }, incremental: { file: `H-${next}-update.gz`, bytes: gz.length, sha256: sha(gz) },
    installer: { file: `H-Setup-${next}.exe`, bytes: 2048, sha256: sha(crypto.randomBytes(2048)) } };
  const server = http.createServer((req, res) => {
    if (req.url === '/latest.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(manifest)); return; }
    if (req.url.endsWith('-update.gz')) { res.setHeader('content-length', gz.length); res.end(gz); return; }
    res.statusCode = 404; res.end('nope');
  });
  const srvPort = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const extraEnv = {
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'work'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0',
    AI_HUB_UPDATE_SOURCES: JSON.stringify([{ id: 'local', name: '本机', manifest: `http://127.0.0.1:${srvPort}/latest.json`, files: `http://127.0.0.1:${srvPort}/v{version}/` }]),
    AI_HUB_UPDATE_RESOURCES: resources, AI_HUB_UPDATE_FORCE_APPLY: '1', AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000', AI_HUB_UPDATE_PROGRESS_UI: '1' };
  const results = [];
  const ipc = (c, ch, arg) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)}${arg === undefined ? '' : ', ' + JSON.stringify(arg)})`);
  const up = path.join(data, 'app-update');
  const progressFile = path.join(up, 'progress.json');
  const waitProgress = async (pred, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end;) { const s = readJson(progressFile); if (s && pred(s)) return s; await sleep(100); } return null; };
  let hub = null, c = null, holder = null, firstRelaunch = 0, relaunchedPid = 0, helperPid = 0, helperPid2 = 0, helperPid3 = 0;
  const port = await freePort();
  // 没有自己 node_modules 的工作树（依赖经 NODE_PATH 指向主仓库）：Electron 主进程不认 NODE_PATH，
  // 用一个只补模块搜索路径、再加载本工作树 main-bootstrap.js 的入口启动，不建目录链接。
  let entry = REPO;
  if (!fs.existsSync(path.join(REPO, 'node_modules')) && process.env.NODE_PATH) {
    entry = path.join(root, 'entry'); fs.mkdirSync(entry);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ ...pkg, main: 'entry.js' }));
    fs.writeFileSync(path.join(entry, 'entry.js'), `process.env.NODE_PATH = ${JSON.stringify(process.env.NODE_PATH)}; require('module')._initPaths(); require(${JSON.stringify(path.join(REPO, 'main-bootstrap.js'))});\n`);
  }
  const launch = (label, dataDir, p, env = extraEnv) => launchIsolatedHub({ entryPath: entry, cwd: REPO, dataDir, port: p, windowMode: 'hidden', label, extraEnv: env, executablePath: ELECTRON });
  try {
    hub = await launch('r43-a', data, port);
    c = await connectFirstPage(hub);
    // 截图按 1440 宽：把（隐藏的）主窗口本身调到 1440×900。
    try { await c.eval('window.resizeTo(1440, 900); true'); await sleep(500); console.log('window:', await c.eval('[innerWidth, innerHeight].join("x")')); } catch (e) { console.log('resize failed:', e.message); }
    await ipc(c, 'app-update:check');
    const dl = await ipc(c, 'app-update:download');
    check(results, '下载校验完成', dl && dl.phase === 'ready', dl && dl.phase);

    // ── 场景一：点「立即重启」后 Hub 退出被拦 ──
    await c.eval(`window.__r43Block = e => { e.preventDefault(); e.returnValue = ''; return ''; }; window.addEventListener('beforeunload', window.__r43Block); true`);
    await ipc(c, 'app-update:apply', { mode: 'now' }).catch(() => null);
    const s1 = await waitProgress(s => s.state === 'running');
    helperPid = s1 ? s1.helperPid : 0;
    const ui1 = helperPid ? findUi(helperPid, 10) : '';
    check(results, '一·点了「立即重启」：替换脚本开始，弹出真实的进度小窗', s1 && s1.step === 1 && /^\d+\|[1-9]/.test(ui1), `${s1 && s1.label} ui=${ui1}`);
    let st = null;
    for (const end = Date.now() + 30000; Date.now() < end && !(st && st.phase === 'ready' && st.applyCancelled);) { st = await ipc(c, 'app-update:get-state').catch(() => null); if (!(st && st.applyCancelled)) await sleep(300); }
    check(results, '一·退出被拦后 Hub 没退出，立刻回到「已下载好」并说明原因', st && st.phase === 'ready' && st.applyCancelled && hub.child.exitCode === null,
      st && st.applyCancelled && s1 && `${Date.parse(st.applyCancelled.at) - Date.parse(s1.startedAt)}ms ${st.applyCancelled.reason}`);
    const uiPid1 = Number(ui1.split('|')[0]) || 0;
    for (const end = Date.now() + 10000; Date.now() < end && (alivePid(helperPid) || alivePid(uiPid1));) await sleep(200);
    const pr = readJson(progressFile);
    check(results, '一·替换脚本随即结束、进度小窗自己关掉（不再在第 1 步干等 90 秒）', !alivePid(helperPid) && !alivePid(uiPid1) && pr && pr.state === 'cancelled',
      `${pr && pr.state} 第 1 步停留 ${pr && (Date.parse(pr.updatedAt) - Date.parse(pr.startedAt))}ms`);
    check(results, '一·没替换文件；升级锁已放开（再点图标不会被拦）', fs.readFileSync(path.join(resources, 'app.asar'), 'utf8') === 'old-asar' && !guard.lockHeld(path.join(up, 'helper.lock')) && guard.runningUpgrade(data) === null);
    const dlg = await c.eval(`(() => { const d = document.querySelector('dialog.app-update-dialog'); return d && d.open ? (d.querySelector('[data-au-cancelled]')?.textContent || '') + ' | ' + [...d.querySelectorAll('[data-au=apply]')].map(b => b.textContent).join(',') : ''; })()`);
    check(results, '一·更新窗口自动打开：说明没升级的原因，「立即重启」还在', /没有升级/.test(dlg) && /立即重启/.test(dlg), dlg);
    try {
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      const out = process.env.R43_SHOT || path.join(root, 'r43-cancelled-dialog.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log('screenshot:', out, await c.eval('[innerWidth, innerHeight].join("x")'));
    } catch (e) { console.log('screenshot failed:', e.message); }
    const ck = await ipc(c, 'app-update:check');
    check(results, '一·「检查更新」照常可用（已下好的新版仍就绪）', ck && ck.phase === 'ready' && ck.latest && ck.latest.version === next, ck && ck.phase);

    // ── 场景二：替换时文件被占着、换不上已还原，小窗问要不要重试时用户叉掉小窗 ──
    const held = path.join(root, 'holder.flag');
    const asarPath = path.join(resources, 'app.asar').replace(/'/g, "''");
    holder = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', `$f=[IO.File]::Open('${asarPath}','Open','Read','Read');Set-Content -LiteralPath '${held.replace(/'/g, "''")}' -Value x;Start-Sleep -Seconds 600;$f.Close()`], { windowsHide: true, stdio: 'ignore' });
    for (const end = Date.now() + 15000; Date.now() < end && !fs.existsSync(held);) await sleep(100);
    await c.eval(`window.removeEventListener('beforeunload', window.__r43Block); true`);
    const ar2 = await ipc(c, 'app-update:apply', { mode: 'now' }).catch(e => ({ error: e.message }));
    console.log('apply#2:', JSON.stringify(ar2 && { phase: ar2.phase, error: ar2.error, needsConfirm: ar2.needsConfirm }));
    await c.close().catch(() => {});
    const s2 = await waitProgress(s => s.need === 'retry' && s.helperPid !== helperPid, 90000);
    helperPid2 = s2 ? s2.helperPid : 0;
    const ui2 = helperPid2 ? findUi(helperPid2, 10) : '';
    check(results, '二·换不上已还原：小窗问「结束占用的程序并重试 / 先用原来的版本」', s2 && /^\d+\|[1-9]/.test(ui2) && hub.child.exitCode !== null, `${s2 && s2.reason} ui=${ui2}`);
    hub = null;
    const uiPid2 = Number(ui2.split('|')[0]) || 0;
    ps(`$p = Get-Process -Id ${uiPid2} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`);
    const gave = await waitProgress(s => s.helperPid === helperPid2 && s.state === 'gave-up', 15000);
    for (const end = Date.now() + 40000; Date.now() < end && !(firstRelaunch = pidOnPort(port));) await sleep(300);
    check(results, '二·叉掉小窗 = 先用原来的版本：不换文件、重新打开原来的 Hub', gave && !alivePid(uiPid2) && firstRelaunch > 0 && fs.readFileSync(path.join(resources, 'app.asar'), 'utf8') === 'old-asar',
      `${gave && gave.state} pid=${firstRelaunch}`);
    const hubR = { port, label: 'r43-relaunched', cdpHttpBase: `http://127.0.0.1:${port}`, pid: firstRelaunch };
    c = await connectFirstPage(hubR, null, { waitMainMs: 30000 });
    // 界面一打开就读走「上次结果」并弹右下角提示（renderer/app-update.js），所以看提示文字。
    let toastText = '';
    for (const end = Date.now() + 20000; Date.now() < end && !/没有完成/.test(toastText);) { toastText = await c.eval(`[...document.querySelectorAll('.au-toast')].map(e => e.textContent).join(' | ')`).catch(() => ''); if (!/没有完成/.test(toastText)) await sleep(300); }
    check(results, '二·重新打开的 Hub 没被升级守卫拦下，提示这次没升级的原因', /没有完成/.test(toastText), toastText);
    holder.kill(); holder = null;
    await sleep(1500);
    const ck2 = await ipc(c, 'app-update:check');
    await sleep(800);
    const prompted = await c.eval(`(() => { const d = document.querySelector('dialog.app-update-dialog'); return !!(d && d.open) + '|' + (document.getElementById('options-check-update')?.textContent || ''); })()`);
    check(results, '二·检查更新照常查到新版，并重新弹出更新提醒（只改末位的小版本也提醒）', ck2 && ck2.phase === 'available' && /^true\|.*有新版本/.test(prompted), `${ck2 && ck2.phase} ${prompted}`);
    const dl2 = await ipc(c, 'app-update:download');
    check(results, '二·再次下载完成', dl2 && dl2.phase === 'ready', dl2 && dl2.phase);
    await ipc(c, 'app-update:apply', { mode: 'now' }).catch(() => null);
    await c.close().catch(() => {});
    const s3 = await waitProgress(s => s.state === 'running' && s.helperPid !== helperPid2, 30000);
    helperPid3 = s3 ? s3.helperPid : 0;
    for (const end = Date.now() + 60000; Date.now() < end && alivePid(firstRelaunch);) await sleep(200);
    const fin = await waitProgress(s => /done|gave-up|failed/.test(s.state) && s.helperPid === helperPid3, 90000);
    check(results, '二·占用解除后再点「立即重启」：换上新版（第 4 步完成）', fin && fin.state === 'done' && sha(fs.readFileSync(path.join(resources, 'app.asar'))) === sha(fs.readFileSync(path.join(fresh, 'app.asar'))), fin && fin.state);
    // 新开的 Hub = 父进程是这次替换脚本的 electron（调试端口的监听会被继承，netstat 仍记在旧进程名下，所以不按端口认）。
    for (const end = Date.now() + 40000; Date.now() < end && !(relaunchedPid && alivePid(relaunchedPid));) { relaunchedPid = childOf(helperPid3); if (!(relaunchedPid && alivePid(relaunchedPid))) await sleep(500); }
    const ui3 = Number(ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(helperPid3)} AND Name='powershell.exe'" | Select-Object -First 1).ProcessId`)) || 0;
    for (const end = Date.now() + 20000; Date.now() < end && alivePid(ui3);) await sleep(300);
    check(results, '二·升级完成后进度小窗自己关掉', ui3 > 0 && !alivePid(ui3), `ui=${ui3}`);
    check(results, '二·换完后自动重新打开', relaunchedPid > 0 && alivePid(relaunchedPid) && relaunchedPid !== firstRelaunch, `pid=${relaunchedPid}`);
    const log = path.join(up, 'upgrade-log.txt');
    console.log('--- upgrade-log.txt ---\n' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '(none)'));
  } catch (error) {
    check(results, '运行没有异常', false, error.stack || error.message);
  } finally {
    if (hub) { try { await c?.eval(`window.removeEventListener('beforeunload', window.__r43Block); true`); } catch (_) {} await gracefulQuit(hub).catch(() => {}); }
    if (holder) { try { holder.kill(); } catch (_) {} }
    // 本测试拉起的进度小窗按进程号收尾（父进程是本测试的替换脚本），不按名字结束进程。
    for (const h of [helperPid, helperPid2, helperPid3].filter(Boolean)) { const u = Number(ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(h)} AND Name='powershell.exe'" | Select-Object -First 1).ProcessId`)) || 0; if (u && alivePid(u)) { console.log(`进度小窗 ${u} 测试结束时还在，结束它`); try { process.kill(u); } catch (_) {} } }
    for (const pid of new Set([helperPid2 && childOf(helperPid2), helperPid3 && childOf(helperPid3), relaunchedPid, firstRelaunch].filter(Boolean))) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} }
    server.close();
  }
  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({ pass: results.length - failed.length, fail: failed.length, root }));
  process.exit(failed.length ? 1 : 0);
})();
