'use strict';
// 升级不顺（第四批 O）+ 小版本更新体验（第三批 K）的真实链路：隔离 Hub（隐藏窗口、全新数据目录）+ 本机更新源 + 临时「安装目录」。
// 用法：node tests/e2e-update-flow-o-cdp.js [--only k,dismiss,protected,fail,portable] [--entry <程序目录>] [--shots <截图目录>] [--tag <文件名前缀>]
//   k         只改末位的小版本：后台下好 → 设置挂点 + 会话栏底部一行「已就绪，重启生效」→ 真实退出 → 替换脚本换上、不重开
//   dismiss   用户点了「下载更新」、下好后点「稍后」（叉掉）→ 真实退出 → 照样换上（O①）
//   protected 安装目录没有写权限（模拟装在 Program Files 又没有管理员权限，O③）→ 更新窗说明 +「下载完整安装包」
//   fail      上次升级没成（要管理员授权）→ 启动时失败提示带原因和「去内源下载完整包」（O④）
//   portable  免安装版遇到完整安装包（O②）→ 不走安装程序，给「下载新的免安装包」
// --entry 指向别的程序目录（例如改动前的 origin/main 工作区）可以截「改动前」的图；那时只截图，不判定新行为。
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { packPayload } = require('../core/app-update/payload');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
const ENTRY = path.resolve(opt('entry') || path.join(__dirname, '..'));
const SHOTS = opt('shots') ? path.resolve(opt('shots')) : null;
const TAG = opt('tag') || 'after';
const ONLY = (opt('only') || 'k,dismiss,protected,fail,portable').split(',');
const JUDGE = !opt('entry');
const ELECTRON = process.env.HUB_E2E_ELECTRON || path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const ELECTRON_PKG = path.join(path.dirname(path.dirname(ELECTRON)), 'package.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const results = [];
const check = (name, ok, detail = '') => { if (!JUDGE) return; results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); };

async function shot(c, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await sleep(600);
  const s = await c.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, `${TAG}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
  console.log('SHOT ' + file);
}

async function scenario(name, { bump = 'patch', runtimeChange = false, extraEnv = {}, prepare = () => {}, body }) {
  const current = JSON.parse(fs.readFileSync(path.join(ENTRY, 'community-edition.json'), 'utf8')).version;
  const [x, y, z] = current.split('.').map(Number);
  const next = bump === 'patch' ? `${x}.${y}.${z + 1}` : `${x}.${y + 1}.0`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hub-upd-o-${name}-`));
  const data = path.join(root, 'data'), resources = path.join(root, 'install', 'resources'), fresh = path.join(root, 'fresh');
  for (const d of [data, resources, fresh, path.join(root, 'work')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'work', '.aiwork-root'), '');
  fs.writeFileSync(path.join(resources, 'app.asar'), 'old-asar');
  fs.mkdirSync(path.join(resources, 'app.asar.unpacked'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar.unpacked', 'marker.txt'), 'old');
  fs.writeFileSync(path.join(fresh, 'app.asar'), crypto.randomBytes(4096));
  fs.mkdirSync(path.join(fresh, 'app.asar.unpacked'), { recursive: true });
  fs.writeFileSync(path.join(fresh, 'app.asar.unpacked', 'marker.txt'), 'new');
  const gzFile = path.join(root, 'update.gz');
  packPayload(fresh, gzFile);
  const gz = fs.readFileSync(gzFile);
  const installer = crypto.randomBytes(4096);
  const electronVersion = JSON.parse(fs.readFileSync(ELECTRON_PKG, 'utf8')).version;
  const manifest = { schema: 1, product: 'test', version: next, publishedAt: new Date().toISOString(), notes: ['测试版本：' + name],
    runtime: { electron: runtimeChange ? '99.0.0' : electronVersion, native: {} },
    incremental: { file: `AIHubHuawei-${next}-update.gz`, bytes: gz.length, sha256: sha(gz) },
    installer: { file: `AIHubHuawei-Setup-${next}.exe`, bytes: installer.length, sha256: sha(installer) } };
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/latest.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(manifest)); return; }
    if (req.url.endsWith('-update.gz')) { res.setHeader('content-length', gz.length); res.end(gz); return; }
    if (req.url.endsWith('.exe')) { res.setHeader('content-length', installer.length); res.end(installer); return; }
    res.statusCode = 404; res.end('nope');
  });
  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const ctx = { root, data, resources, fresh, next, current, requests, gz };
  await prepare(ctx);
  let hub = null, c = null;
  try {
    hub = await launchIsolatedHub({ entryPath: ENTRY, cwd: ENTRY, executablePath: ELECTRON, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'upd-o-' + name, extraEnv: {
      AI_HUB_WORKSPACE_ROOT: path.join(root, 'work'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0', AI_HUB_OPENX: '0',
      AI_HUB_UPDATE_SOURCES: JSON.stringify([{ id: 'local', name: '本机', manifest: `http://127.0.0.1:${port}/latest.json`, files: `http://127.0.0.1:${port}/v{version}/` }]),
      AI_HUB_UPDATE_RESOURCES: resources, AI_HUB_UPDATE_FORCE_APPLY: '1', AI_HUB_UPDATE_STARTUP_DELAY_MS: '1000', ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}), ...extraEnv } });
    c = await connectFirstPage(hub, null, { waitMainMs: 20000 });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    ctx.c = c;
    ctx.state = () => c.eval('window.__appUpdate && window.__appUpdate.state()').catch(() => null);
    ctx.waitPhase = async (phases, ms = 90000) => {
      let st = null;
      for (const end = Date.now() + ms; Date.now() < end;) { st = await ctx.state(); if (st && phases.includes(st.phase)) return st; await sleep(400); }
      return st;
    };
    ctx.quit = async () => { await c.close().catch(() => {}); c = null; await gracefulQuit(hub); hub = null; };
    ctx.waitResult = async () => {
      const f = path.join(data, 'app-update', 'last-result.json');
      for (const end = Date.now() + 60000; Date.now() < end && !fs.existsSync(f);) await sleep(500);
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) : null;
    };
    ctx.replaced = () => sha(fs.readFileSync(path.join(resources, 'app.asar'))) === sha(fs.readFileSync(path.join(fresh, 'app.asar')));
    await body(ctx);
  } catch (error) {
    check(`${name}：运行没有异常`, false, (error.stack || error.message) + (error.logTail ? '\nLOG:\n' + error.logTail : ''));
  } finally {
    if (c) await c.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    server.close();
    if (ctx.cleanup) { try { ctx.cleanup(); } catch (_) {} }
  }
}

const dot = c => c.eval(`!!document.getElementById('btn-options')?.classList.contains('update-has-unread')`);
const readyLine = c => c.eval(`document.getElementById('hub-update-ready')?.textContent || ''`);
const dialogText = c => c.eval(`document.querySelector('dialog.app-update-dialog[open]')?.innerText || ''`);

(async () => {
  if (ONLY.includes('k')) await scenario('k', { body: async ({ c, waitPhase, quit, waitResult, replaced, requests }) => {
    const st = await waitPhase(['ready']);
    check('K：只改末位的小版本启动后自动后台下好', st && st.phase === 'ready' && st.quiet === true, st ? st.phase : 'no state');
    await sleep(800);
    check('K：没有弹更新窗', !(await c.eval(`!!document.querySelector('dialog.app-update-dialog[open]')`)));
    check('K：设置图标挂小点', await dot(c));
    const line = await readyLine(c);
    check('K：会话栏底部一行「已就绪，重启生效」', /已就绪，重启生效/.test(line), line);
    await shot(c, 'K-小版本已就绪-挂点与底栏');
    await quit();
    const r = await waitResult();
    check('K：关 Hub 后替换脚本换上新版、不重开', r && r.ok === true && r.quiet === true && replaced(), JSON.stringify(r));
    check('K：只下了增量包', requests.some(u => u.endsWith('-update.gz')) && !requests.some(u => u.endsWith('.exe')));
  } });

  if (ONLY.includes('dismiss')) await scenario('dismiss', { bump: 'minor', body: async ({ c, waitPhase, quit, waitResult, replaced }) => {
    const st = await waitPhase(['available']);
    check('①：大一点的版本照常弹窗提醒', st && st.phase === 'available' && st.latest && st.latest.notify === true);
    await sleep(800);
    await c.eval(`document.querySelector('dialog.app-update-dialog [data-au="download"]')?.click()`);
    const r1 = await waitPhase(['ready'], 60000);
    check('①：用户点「下载更新」后下好', r1 && r1.phase === 'ready', r1 ? r1.phase : '');
    await sleep(500);
    await shot(c, '①-下好后更新窗-提示稍后也会换上');
    await c.eval(`document.querySelector('dialog.app-update-dialog [data-au="close"]')?.click()`);
    await sleep(500);
    const line = await readyLine(c);
    check('①：点「稍后」后底栏仍有「已就绪，重启生效」', /已就绪，重启生效/.test(line), line);
    await shot(c, '①-点稍后后-底栏一行');
    await quit();
    const r = await waitResult();
    check('①：没点重启、直接关 Hub：照样换上新版（以前这个包被丢掉）', r && r.ok === true && replaced(), JSON.stringify(r));
  } });

  if (ONLY.includes('protected')) await scenario('protected', {
    prepare: ctx => {
      const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
      execFileSync('icacls', [ctx.resources, '/deny', `${user}:(OI)(CI)(W)`], { windowsHide: true, stdio: 'ignore' });
      ctx.cleanup = () => execFileSync('icacls', [ctx.resources, '/remove:d', user], { windowsHide: true, stdio: 'ignore' });
    },
    body: async ({ c, waitPhase, requests }) => {
      const st = await waitPhase(['available']);
      check('③：受保护目录查到小版本，标出 protectedDir、不后台下载', st && st.plan && st.plan.protectedDir === true && !requests.some(u => u.endsWith('.gz')), JSON.stringify(st && st.plan));
      await sleep(800);
      check('③：设置挂小点（以前小版本整版隐藏）', await dot(c));
      await c.eval(`window.__appUpdate.open()`);
      await sleep(600);
      const text = await dialogText(c);
      check('③：更新窗说明「仅为我安装」并给「下载完整安装包」', /仅为我安装/.test(text) && /下载完整安装包/.test(text), text.slice(0, 200));
      await shot(c, '③-受保护目录-更新窗说明与完整包按钮');
    } });

  if (ONLY.includes('fail')) await scenario('fail', {
    prepare: ctx => {
      const dir = path.join(ctx.data, 'app-update');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'last-result.json'), JSON.stringify({ ok: false, version: ctx.next, from: ctx.current, rolledBack: false, quiet: false, elevated: false,
        reason: '程序装在受保护目录（C:\\Program Files\\AI Hub），替换文件需要管理员授权；这次没有授权，没有替换任何文件。再次更新时在 Windows 弹出的确认框里点「是」即可', at: new Date().toISOString() }));
    },
    extraEnv: { AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000' },
    body: async ({ c }) => {
      let text = '';
      for (const end = Date.now() + 20000; Date.now() < end && !text;) { text = await c.eval(`[...document.querySelectorAll('.au-toast')].map(e => e.innerText).join('\\n')`).catch(() => ''); if (!text) await sleep(300); }
      check('④：启动时失败提示写清原因', /管理员授权/.test(text), text.slice(0, 160));
      check('④：失败提示里就地给「去内源下载完整包」', /去内源下载完整包/.test(text));
      await shot(c, '④-升级失败提示-原因与内源完整包按钮');
    } });

  if (ONLY.includes('portable')) await scenario('portable', { runtimeChange: true, extraEnv: { AI_HUB_UPDATE_PORTABLE: '1' }, body: async ({ c, waitPhase, requests }) => {
    const st = await waitPhase(['available']);
    check('②：免安装版遇到完整安装包：标 portable，不下载安装程序', st && st.plan && st.plan.kind === 'full' && st.plan.portable === true && !requests.some(u => u.endsWith('.exe')), JSON.stringify(st && st.plan));
    await sleep(800);
    await c.eval(`window.__appUpdate.open()`);
    await sleep(600);
    const text = await dialogText(c);
    check('②：更新窗说明原因并给「下载新的免安装包」', /免安装版/.test(text) && /下载新的免安装包/.test(text), text.slice(0, 200));
    await shot(c, '②-免安装版-完整包更新给免安装包');
  } });

  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({ pass: results.length - failed.length, fail: failed.length }));
  process.exit(failed.length ? 1 : 0);
})();
