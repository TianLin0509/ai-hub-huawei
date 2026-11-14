'use strict';
// 升级体验的真实链路（2026-11-13）：隔离 Hub（隐藏窗口）+ 本机更新源 + 临时安装目录。
//   1. 用户点「立即重启」→ 替换脚本启动、Hub 真实保存退出；
//   2. 安装目录里有个程序还没退（模拟终端宿主残留），升级要等一会儿——这段时间用户又点了一次图标：
//      新启动的 Hub 应在几秒内自己退出、不建窗口，并留下「又点了」的标记给进度小窗；
//   3. 替换完成后重新打开的 Hub 照常启动（守卫不误拦），并读到「更新成功」。
// 进度小窗本身会显示窗口，这里用 AI_HUB_UPDATE_PROGRESS_UI=0 关掉（它的画面由单测 -Snapshot 覆盖）。
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, buildIsolatedHubEnv } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { packPayload } = require('../core/app-update/payload');

const REPO = path.resolve(__dirname, '..');
const ELECTRON = require('electron');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const check = (results, name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; } };
// 替换脚本拉起的新 Hub = 父进程是替换脚本的 electron 主进程（按父进程号认，不按命令行认）。
const childOf = ppid => { try { return Number(execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(ppid)} AND Name='electron.exe'" | Select-Object -First 1).ProcessId`], { encoding: 'utf8', windowsHide: true }).trim()) || 0; } catch (_) { return 0; } };
const pidOnPort = port => { try { const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }); const m = out.split(/\r?\n/).find(l => new RegExp(`127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING`).test(l)); return m ? Number(m.trim().split(/\s+/).pop()) : 0; } catch (_) { return 0; } };

(async () => {
  const current = JSON.parse(fs.readFileSync(path.join(REPO, 'community-edition.json'), 'utf8')).version;
  const [x, y, z] = current.split('.').map(Number);
  const next = `${x}.${y}.${z + 1}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upx-e2e-'));
  const data = path.join(root, 'data'), appDir = path.join(root, 'install'), resources = path.join(appDir, 'resources'), fresh = path.join(root, 'fresh');
  for (const d of [data, resources, fresh, path.join(root, 'work')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'work', '.aiwork-root'), '');
  fs.writeFileSync(path.join(resources, 'app.asar'), 'old-asar');
  fs.writeFileSync(path.join(fresh, 'app.asar'), crypto.randomBytes(4096));
  const gzFile = path.join(root, 'update.gz');
  packPayload(fresh, gzFile);
  const gz = fs.readFileSync(gzFile);
  const electronVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  const manifest = { schema: 1, product: 'test', version: next, publishedAt: new Date().toISOString(), notes: ['测试升级体验'],
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
    AI_HUB_UPDATE_RESOURCES: resources, AI_HUB_UPDATE_FORCE_APPLY: '1', AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000', AI_HUB_UPDATE_PROGRESS_UI: '0' };
  const results = [];
  const timeline = [];
  const mark = (what, t0) => { timeline.push({ what, ms: Date.now() - t0 }); };
  let hub, c, lingering, relaunchedPid = 0, helperPid = 0;
  const port = await freePort();
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port, windowMode: 'hidden', label: 'upx-a', extraEnv });
    c = await connectFirstPage(hub);
    const ck = await c.eval(`require('electron').ipcRenderer.invoke('app-update:check')`);
    console.log('check:', JSON.stringify(ck && { phase: ck.phase, error: ck.error, plan: ck.plan, current: ck.current, checks: ck.checks, latest: ck.latest && ck.latest.version }));
    const dl = await c.eval(`require('electron').ipcRenderer.invoke('app-update:download')`);
    check(results, '下载校验完成，等用户点「立即重启」', dl && dl.phase === 'ready', dl && dl.phase);
    // 安装目录里一个还没退的程序（真实里是终端宿主等），让替换脚本在第 2 步多等几秒。
    const lingerExe = path.join(appDir, 'Lingering.exe');
    fs.copyFileSync(PS, lingerExe);
    lingering = spawn(lingerExe, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 7'], { windowsHide: true, stdio: 'ignore' });
    const t0 = Date.now();
    await c.eval(`require('electron').ipcRenderer.invoke('app-update:apply', { mode: 'now' })`).catch(() => null);
    await c.close().catch(() => {});
    const progressFile = path.join(data, 'app-update', 'progress.json');
    let seenRunning = null;
    for (const end = Date.now() + 30000; Date.now() < end && !seenRunning;) { const s = readJson(progressFile); if (s && s.state === 'running') seenRunning = s; else await sleep(100); }
    mark('进度窗开始显示（第 1 步）', t0);
    helperPid = seenRunning ? seenRunning.helperPid : 0;
    check(results, '点了重启：替换脚本马上写出进度（第几步/通常多久）', seenRunning && seenRunning.step >= 1 && seenRunning.typical, JSON.stringify(seenRunning));
    // 等旧 Hub 真退出
    for (const end = Date.now() + 60000; Date.now() < end && hub.child.exitCode === null;) await sleep(200);
    mark('旧 Hub 退出', t0);
    check(results, '旧 Hub 保存后真实退出', hub.child.exitCode !== null);
    hub = null;
    // 用户又点了一次图标
    const s2 = readJson(progressFile);
    check(results, '此时升级还在进行（第 2 步等残留程序）', s2 && s2.state === 'running', s2 && `${s2.step} ${s2.label}`);
    const envB = buildIsolatedHubEnv(data, extraEnv, process.env, { windowMode: 'hidden' });
    const tB = Date.now();
    const b = spawn(ELECTRON, [REPO, `--remote-debugging-port=${await freePort()}`], { env: envB, cwd: REPO, stdio: 'ignore', windowsHide: true });
    const bExit = await Promise.race([new Promise(r => b.once('exit', code => r({ code }))), sleep(15000).then(() => null)]);
    const bMs = Date.now() - tB;
    mark(`升级途中再点图标：新进程 ${bMs}ms 后退出`, t0);
    if (!bExit) { try { b.kill(); } catch (_) {} }
    check(results, '升级途中再点图标：新启动的程序几秒内自己退出（不打开旧版）', bExit && bExit.code === 0 && bMs < 8000, `${bMs}ms code=${bExit && bExit.code}`);
    const focus = readJson(path.join(data, 'app-update', 'focus-request.flag'));
    check(results, '留下了「用户又点了」的标记给进度窗', focus && focus.pid === b.pid, JSON.stringify(focus));
    // 等替换完成
    const resultFile = path.join(data, 'app-update', 'last-result.json');
    for (const end = Date.now() + 60000; Date.now() < end && !(readJson(progressFile) || {}).state?.match(/done|gave-up|failed/);) await sleep(200);
    mark('替换完成', t0);
    const fin = readJson(progressFile);
    check(results, '进度最后是「完成」（第 4 步）', fin && fin.state === 'done' && fin.step === 4, fin && fin.state);
    check(results, 'app.asar 已换成新文件', sha(fs.readFileSync(path.join(resources, 'app.asar'))) === sha(fs.readFileSync(path.join(fresh, 'app.asar'))));
    // 重新打开的 Hub：同一个调试端口
    for (const end = Date.now() + 40000; Date.now() < end && !(relaunchedPid = pidOnPort(port));) await sleep(300);
    mark('新版重新打开（调试端口可连）', t0);
    check(results, '换完后自动重新打开，且没被守卫误拦', relaunchedPid > 0, `pid=${relaunchedPid}`);
    if (relaunchedPid) {
      const hubC = { port, label: 'upx-relaunched', cdpHttpBase: `http://127.0.0.1:${port}`, pid: relaunchedPid };
      const cc = await connectFirstPage(hubC, null, { waitMainMs: 30000 }).catch(e => ({ error: e }));
      if (!cc.error) {
        let st = null;
        for (const end = Date.now() + 20000; Date.now() < end && !(st && st.lastResult);) { st = await cc.eval(`require('electron').ipcRenderer.invoke('app-update:get-state')`).catch(() => null); if (!(st && st.lastResult)) await sleep(500); }
        check(results, '重新打开后读到「更新成功」', st && st.lastResult && st.lastResult.ok === true, JSON.stringify(st && st.lastResult));
        await cc.close().catch(() => {});
      } else check(results, '重新打开后能连上界面', false, cc.error.message);
    }
    const log = path.join(data, 'app-update', 'upgrade-log.txt');
    console.log('--- upgrade-log.txt ---\n' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '(none)'));
  } catch (error) {
    check(results, '运行没有异常', false, error.stack || error.message);
  } finally {
    if (hub) await gracefulQuit(hub).catch(() => {});
    const relaunchedMain = helperPid ? childOf(helperPid) : 0;
    for (const pid of new Set([relaunchedMain, relaunchedPid].filter(Boolean))) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} }
    if (lingering) { try { lingering.kill(); } catch (_) {} }
    server.close();
  }
  console.log('--- timeline ---\n' + timeline.map(t => `${String(t.ms).padStart(6)}ms ${t.what}`).join('\n'));
  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({ pass: results.length - failed.length, fail: failed.length, root }));
  process.exit(failed.length ? 1 : 0);
})();
