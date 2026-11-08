'use strict';
// 「一键安装 Git for Windows」真实界面链路（2026-11-07）：隔离 Hub（隐藏窗口），本机 http 当下载源，提供发布机打好的真组件目录
// （GIT_E2E_COMPONENTS 指向 <out>/components）。把本机真实装的 Git 藏起来（Program Files 指到空目录、PATH 去掉 Git、关掉深度查找），
// 打开 Claude Code 的安装弹窗 → 看到「一键安装 Git for Windows」→ 点它 → 下载、校验、解压、试跑 → 显示已装好；
// 再用装好的 bash 跑一条命令、确认会话环境会把它交给 Claude。截图存 1440 宽。
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const COMPONENTS = process.env.GIT_E2E_COMPONENTS;
const OUT = process.env.GIT_E2E_SHOTS || path.join(os.tmpdir(), 'git-install-shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const check = (results, name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); };

(async () => {
  if (!COMPONENTS || !fs.existsSync(path.join(COMPONENTS, 'components.json'))) { console.error('请用 GIT_E2E_COMPONENTS 指到打好的 components 目录'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-git-e2e-'));
  const data = path.join(root, 'data'), tools = path.join(root, 'tools'), fakePf = path.join(root, 'pf');
  for (const d of [data, tools, fakePf, path.join(root, 'work'), OUT]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'work', '.aiwork-root'), '');
  let served = 0;
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/hub-update\/components\//, '');
    const file = path.join(COMPONENTS, ...rel.split('/'));
    if (!file.startsWith(COMPONENTS) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end('nf'); return; }
    if (!rel.endsWith('.json')) served++;
    res.writeHead(200, { 'content-length': fs.statSync(file).size, 'content-type': rel.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const PATH = String(process.env.PATH || '').split(';').filter(d => !/\\git\\|\\git$/i.test(d)).join(';');
  const results = [];
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'git-install', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: path.join(root, 'work'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0', AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000',
      AI_HUB_CLI_COMPONENTS_SOURCES: JSON.stringify([{ id: 'local', name: '本机测试源', manifest: `http://127.0.0.1:${port}/hub-update/components/components.json` }]),
      AI_HUB_CLI_TOOLS_DIR: tools, AI_HUB_GIT_DEEP_SEARCH: '0', ProgramFiles: fakePf, ProgramW6432: fakePf, 'ProgramFiles(x86)': fakePf, PATH } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const shot = async name => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); };
    for (const end = Date.now() + 40000; Date.now() < end && !(await c.eval(`!!document.querySelector('.new-session-option[data-kind="claude"][data-installed]')`).catch(() => false));) await sleep(400);
    const opened = await c.eval(`(() => { const b = document.querySelector('.new-session-option[data-kind="claude"]'); if (!b) return 'no-option'; b.dataset.installed = '0'; b.click(); return 'clicked'; })()`);
    const dialogText = () => c.eval(`[...document.querySelectorAll('dialog')].filter(d => d.open).map(d => d.innerText).join('\\n')`);
    let text = '';
    for (const end = Date.now() + 30000; Date.now() < end;) { text = await dialogText(); if (text.includes('一键安装 Git for Windows')) break; await sleep(400); }
    check(results, 'Claude 安装弹窗里出现「一键安装 Git for Windows」', text.includes('一键安装 Git for Windows'), `${opened} · ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    check(results, '说明是建议、不是必须（会改用 PowerShell）', /改用 PowerShell/.test(text) && !/同时需要 Git for Windows/.test(text));
    await shot('20261107-git-install-1-before.png');
    await c.eval(`[...document.querySelectorAll('dialog')].find(d => d.open)?.querySelector('[data-cli-action="install-git"]')?.click()`);
    let sawProgress = false;
    for (const end = Date.now() + 8 * 60000; Date.now() < end;) {
      text = await dialogText();
      if (/下载中|正在安装|正在校验|正在试运行|正在全局查找/.test(text)) { if (!sawProgress) await shot('20261107-git-install-2-progress.png'); sawProgress = true; }
      if (/Git for Windows 已装好|安装没有成功/.test(text)) break;
      await sleep(700);
    }
    check(results, '安装过程有进度', sawProgress);
    check(results, '界面显示 Git for Windows 已装好', text.includes('Git for Windows 已装好'), text.slice(0, 300).replace(/\s+/g, ' '));
    await shot('20261107-git-install-3-done.png');
    check(results, '从测试源下载了 1 个包', served === 1, `served=${served}`);
    const installed = JSON.parse(fs.readFileSync(path.join(tools, 'installed.json'), 'utf8'));
    const g = installed.tools.git || {};
    check(results, 'installed.json 记下 git', g.version === '2.56.0+windows.4' && g.bin === 'cmd/git.exe', JSON.stringify(g));
    const dir = path.join(tools, ...String(g.dir || 'x').split('/'));
    const bash = path.join(dir, 'bin', 'bash.exe');
    let bashOut = '';
    try { bashOut = execFileSync(bash, ['-lc', 'git --version && ls /usr/bin | grep -c "" && echo hardlink-ok $(cmp -s /ucrt64/bin/git-receive-pack.exe /ucrt64/bin/git-upload-pack.exe && echo same)'], { encoding: 'utf8', windowsHide: true, timeout: 60000 }); } catch (error) { bashOut = 'ERR ' + error.message; }
    check(results, '装好的 bash 能跑 git、ls、grep，硬链接文件内容一致', /git version 2\.56\.0/.test(bashOut) && /hardlink-ok same/.test(bashOut), bashOut.replace(/\s+/g, ' ').slice(0, 160));
    // 会话环境：Hub 装的 Git 经 CLAUDE_CODE_GIT_BASH_PATH 交给 Claude（直接用同一套模块和同样的环境算一遍）。
    const registry = require('../core/cli-tools/registry');
    const sessionEnv = { AI_HUB_CLI_TOOLS_DIR: tools, ProgramFiles: fakePf, ProgramW6432: fakePf, PATH, SystemRoot: process.env.SystemRoot };
    registry.applySessionPath(sessionEnv, { platform: 'win32' });
    check(results, '新会话拿到 CLAUDE_CODE_GIT_BASH_PATH', sessionEnv.CLAUDE_CODE_GIT_BASH_PATH === bash, sessionEnv.CLAUDE_CODE_GIT_BASH_PATH || '');
    // 再点一次：已经装了就不再下载。
    const again = await c.eval(`require('electron').ipcRenderer.invoke('cli-tools:install', { id: 'git' }).then(r => r.state.tools.git)`).catch(e => ({ error: String(e) }));
    check(results, '再装一次不重复下载', served === 1 && again && again.phase === 'done' && !!again.found, JSON.stringify(again).slice(0, 200));
  } catch (error) {
    check(results, '流程跑完', false, error.stack || String(error));
  } finally {
    if (c) await c.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    server.close();
  }
  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failed: failed.map(f => f.name), shots: OUT, root }));
  process.exit(failed.length ? 1 : 0);
})();
