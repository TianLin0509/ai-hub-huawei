'use strict';
// R48（2026-11-26）真实链路计时：在隔离 Hub 的「软件更新」窗口里用鼠标点「立即重启」，分段记时间——
//   点击 → 按钮变化（界面第一次有反应）→ 替换脚本留下「已开始」标记 → 窗口关闭（页面断开）→ 旧进程退出 → 换好文件 → 新版进程起来、页面可连。
// 隔离 Hub（隐藏窗口）+ 本机更新源 + 临时安装目录 + 真实的替换脚本和进度小窗（在私有桌面上，用户屏幕看不到）。
// 用法：node tests/e2e-restart-fast-timing-cdp.js [轮数，默认 3]；R48_OUT=<json> 写每轮数字。改前对照：把本文件复制到旧代码的工作树里跑。
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

if (process.platform !== 'win32') { console.log('skip: Windows only'); process.exit(0); }
if (process.env.HUB_R48_PRIVATE_DESKTOP !== '1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r48-flash-'));
  const flash = path.join(dir, 'flash.json'), log = path.join(dir, 'inner.log');
  spawnSync('python', [path.join(__dirname, 'helpers', 'window-flash-watch.py'), '--out', flash, '--grace-ms', '1500', '--', process.execPath, __filename, ...process.argv.slice(2)],
    { env: { ...process.env, HUB_R48_PRIVATE_DESKTOP: '1', HUB_R48_LOG: log }, windowsHide: true, stdio: 'ignore', timeout: 1800000 });
  let f = {}; try { f = JSON.parse(fs.readFileSync(flash, 'utf8')); } catch (_) {}
  try { process.stdout.write(fs.readFileSync(log, 'utf8')); } catch (_) { console.log('(没有内层日志)'); }
  console.log(`私有桌面=${f.privateDesktop} 内层退出码=${f.exitCode}`);
  process.exit(f.exitCode === 0 && f.privateDesktop ? 0 : 1);
}
if (process.env.HUB_R48_LOG) { const log = process.env.HUB_R48_LOG; console.log = (...a) => fs.appendFileSync(log, a.join(' ') + '\n'); }

const { launchIsolatedHub } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { packPayload } = require('../core/app-update/payload');

const REPO = path.resolve(__dirname, '..');
const ELECTRON = require('electron');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; } };
const ps = cmd => { try { return execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim(); } catch (_) { return ''; } };
const childOf = (ppid, name) => Number(ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(ppid)} AND Name='${name}'" | Select-Object -First 1).ProcessId`)) || 0;
const median = xs => { const v = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };

async function round(no) {
  const current = JSON.parse(fs.readFileSync(path.join(REPO, 'community-edition.json'), 'utf8')).version;
  const [x, y, z] = current.split('.').map(Number);
  const next = `${x}.${y}.${z + 3}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r48-e2e-'));
  const data = path.join(root, 'data'), appDir = path.join(root, 'install'), resources = path.join(appDir, 'resources'), fresh = path.join(root, 'fresh');
  for (const d of [data, resources, fresh, path.join(root, 'work')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'work', '.aiwork-root'), '');
  fs.writeFileSync(path.join(resources, 'app.asar'), 'old-asar');
  fs.writeFileSync(path.join(fresh, 'app.asar'), crypto.randomBytes(4096));
  const gzFile = path.join(root, 'update.gz');
  packPayload(fresh, gzFile);
  const gz = fs.readFileSync(gzFile);
  const electronVersion = JSON.parse(fs.readFileSync(require.resolve('electron/package.json'), 'utf8')).version;
  const manifest = { schema: 1, product: 'test', version: next, publishedAt: new Date().toISOString(), notes: ['R48 计时'],
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
  const up = path.join(data, 'app-update');
  const port = await freePort();
  const out = { round: no };
  let hub = null, c = null, helperPid = 0, relaunched = 0;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port, windowMode: 'hidden', label: `r48-${no}`, extraEnv, executablePath: ELECTRON });
    c = await connectFirstPage(hub);
    await c.eval('window.resizeTo(1440, 900); true').catch(() => {});
    const ipc = (ch, arg) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)}${arg === undefined ? '' : ', ' + JSON.stringify(arg)})`);
    await ipc('app-update:check');
    const dl = await ipc('app-update:download');
    if (!dl || dl.phase !== 'ready') throw new Error('下载没就绪：' + (dl && dl.phase));
    for (const end = Date.now() + 60000; Date.now() < end;) { if (await c.eval('!!(window.__appUpdate && window.__appUpdate.open)').catch(() => false)) break; await sleep(200); }
    await c.eval('window.__appUpdate.open(); true');
    await sleep(600);
    const rect = await c.eval(`(() => { const b = document.querySelector('dialog.app-update-dialog [data-au=apply]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: b.textContent }; })()`);
    if (!rect) throw new Error('没找到「立即重启」按钮');
    out.button = rect.text;
    // 页面里记下按钮第一次变化的时刻（主进程时钟和页面时钟同一台机器，用 Date.now 对齐）。
    await c.eval(`(() => { window.__r48 = {}; const d = document.querySelector('dialog.app-update-dialog');
      const mark = () => { const b = d.querySelector('.au-foot [data-au=apply]'); const t = b ? b.textContent + (b.disabled ? '|disabled' : '') : '(无按钮)';
        if (!window.__r48.firstChangeAt && t !== ${JSON.stringify(rect.text)}) { window.__r48.firstChangeAt = Date.now(); window.__r48.firstChange = t; }
        // 主进程进入「正在应用」（已拉起替换脚本）时界面换成这句话。
        if (!window.__r48.applyingAt && /正在保存会话并关闭窗口/.test(d.textContent || '')) window.__r48.applyingAt = Date.now(); };
      new MutationObserver(mark).observe(d, { subtree: true, childList: true, characterData: true, attributes: true }); return true; })()`);
    let closedAt = 0, exitAt = 0;
    c.ws.on('close', () => { closedAt = closedAt || Date.now(); });
    hub.child.once('exit', () => { exitAt = Date.now(); });
    // R48_SHOT=<目录>：点之前截一张，点之后录屏（每画一帧推一张，文件名带点击后毫秒数）。窗口 1 秒左右就关，单张截图来不及。
    const shotDir = process.env.R48_SHOT;
    let tClick = 0;
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true });
      const x = await c.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 20000 }).catch(e => (console.log('截图失败', e.message), null));
      if (x) fs.writeFileSync(path.join(shotDir, 'before-click.png'), Buffer.from(x.data, 'base64'));
      c.ws.on('message', raw => {
        let m; try { m = JSON.parse(String(raw)); } catch (_) { return; }
        if (m.method !== 'Page.screencastFrame') return;
        const ms = tClick ? Date.now() - tClick : -1;
        if (ms >= 0) fs.writeFileSync(path.join(shotDir, `after-click-${String(ms).padStart(5, '0')}ms.jpg`), Buffer.from(m.params.data, 'base64'));
        c.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
      });
      await c.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 }).catch(e => console.log('录屏失败', e.message));
    }
    const t0 = Date.now();
    tClick = t0;
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    let fb = null;
    for (const end = Date.now() + 30000; Date.now() < end && !closedAt;) {
      const r = await c.eval('window.__r48').catch(() => null);
      if (r && r.firstChangeAt && !fb) fb = r;
      if (r && r.applyingAt) fb = { ...(fb || r), applyingAt: r.applyingAt };
      await sleep(15);
    }
    const last = fb;
    out.feedbackMs = fb ? fb.firstChangeAt - t0 : null;
    out.applyingMs = last && last.applyingAt ? last.applyingAt - t0 : null;
    out.feedback = fb ? fb.firstChange : '（窗口关闭前按钮没变化）';
    out.windowClosedMs = closedAt ? closedAt - t0 : null;
    for (const end = Date.now() + 60000; Date.now() < end && !exitAt;) await sleep(50);
    out.oldExitMs = exitAt ? exitAt - t0 : null;
    try { out.helperStartedMs = fs.statSync(path.join(up, 'helper-started.flag')).mtimeMs - t0; } catch (_) { out.helperStartedMs = null; }
    let prog = null;
    for (const end = Date.now() + 90000; Date.now() < end;) { prog = readJson(path.join(up, 'progress.json')); if (prog && /done|failed|gave-up/.test(prog.state)) break; await sleep(100); }
    helperPid = prog ? prog.helperPid : 0;
    out.finalState = prog && prog.state;
    out.replaced = sha(fs.readFileSync(path.join(resources, 'app.asar'))) === sha(fs.readFileSync(path.join(fresh, 'app.asar')));
    // 新版进程 = 替换脚本拉起的 electron；页面能连上就算「新窗口出来了」（隐藏窗口模式）。
    for (const end = Date.now() + 60000; Date.now() < end && !relaunched;) { relaunched = helperPid ? childOf(helperPid, 'electron.exe') : 0; if (!relaunched) await sleep(200); }
    if (relaunched) {
      const c2 = await connectFirstPage({ port, label: 'r48-new', cdpHttpBase: `http://127.0.0.1:${port}`, pid: relaunched }, null, { waitMainMs: 60000 }).catch(() => null);
      if (c2) { for (const end = Date.now() + 30000; Date.now() < end;) { const ok = await c2.eval('document.readyState === "complete" && !!document.body').catch(() => false); if (ok) break; await sleep(100); } out.newReadyMs = Date.now() - t0; await c2.close().catch(() => {}); }
    }
    const log = path.join(up, 'upgrade-log.txt');
    out.upgradeLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map(l => l.replace(/^\S+ /, '')) : [];
  } catch (error) {
    out.error = error.stack || error.message;
  } finally {
    await c?.close().catch(() => {});
    for (const pid of new Set([hub && hub.child.exitCode === null ? hub.child.pid : 0, relaunched].filter(Boolean))) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} }
    if (helperPid) { const u = childOf(helperPid, 'powershell.exe'); if (u) { try { process.kill(u); } catch (_) {} } try { process.kill(helperPid); } catch (_) {} }
    server.close();
    setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }, 3000).unref();
  }
  return out;
}

(async () => {
  const n = Math.max(1, Number(process.argv[2]) || 3);
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const r = await round(i);
    rows.push(r);
    console.log(JSON.stringify({ ...r, upgradeLog: undefined }));
    if (r.upgradeLog && r.upgradeLog.length) console.log('  log: ' + r.upgradeLog.join(' / '));
    await sleep(2000);
  }
  const keys = ['feedbackMs', 'applyingMs', 'helperStartedMs', 'windowClosedMs', 'oldExitMs', 'newReadyMs'];
  const summary = Object.fromEntries(keys.map(k => [k, { median: median(rows.map(r => r[k])), all: rows.map(r => r[k] == null ? null : Math.round(r[k])) }]));
  const ok = rows.filter(r => !r.error && r.replaced && r.finalState === 'done').length;
  console.log('SUMMARY ' + JSON.stringify({ repo: REPO, rounds: n, ok, summary }));
  if (process.env.R48_OUT) fs.writeFileSync(process.env.R48_OUT, JSON.stringify({ repo: REPO, rows, summary }, null, 2));
  process.exit(ok === n ? 0 : 1);
})();
