'use strict';
// 小版本静默送达的真实链路：隔离 Hub（隐藏窗口）+ 本机更新源 + 临时安装目录。
// 启动后自动查到只改末位的新版 → 后台下载校验 → 界面不打扰 → 真实退出 Hub → 替换脚本隐藏替换、不重开 → 结果文件可读。
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { packPayload } = require('../core/app-update/payload');

const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const check = (results, name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); };

(async () => {
  const current = JSON.parse(fs.readFileSync(path.join(REPO, 'community-edition.json'), 'utf8')).version;
  const [x, y, z] = current.split('.').map(Number);
  const next = `${x}.${y}.${z + 1}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quiet-update-'));
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
  const installer = crypto.randomBytes(2048);
  const electronVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  const manifest = { schema: 1, product: 'test', version: next, publishedAt: new Date().toISOString(), notes: ['测试小版本'],
    runtime: { electron: electronVersion, native: {} },
    incremental: { file: `H-${next}-update.gz`, bytes: gz.length, sha256: sha(gz) },
    installer: { file: `H-Setup-${next}.exe`, bytes: installer.length, sha256: sha(installer) } };
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/latest.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(manifest)); return; }
    if (req.url.endsWith('-update.gz')) { res.setHeader('content-length', gz.length); res.end(gz); return; }
    res.statusCode = 404; res.end('nope');
  });
  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const results = [];
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'quiet-update', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: path.join(root, 'work'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0',
      AI_HUB_UPDATE_SOURCES: JSON.stringify([{ id: 'local', name: '本机', manifest: `http://127.0.0.1:${port}/latest.json`, files: `http://127.0.0.1:${port}/v{version}/` }]),
      AI_HUB_UPDATE_RESOURCES: resources, AI_HUB_QUIET_UPDATE: '1', AI_HUB_UPDATE_FORCE_APPLY: '1', AI_HUB_UPDATE_STARTUP_DELAY_MS: '1000' } });
    c = await connectFirstPage(hub);
    let state = null;
    for (const end = Date.now() + 90000; Date.now() < end;) {
      state = await c.eval('window.__appUpdate && window.__appUpdate.state()').catch(() => null);
      if (state && state.phase === 'ready') break;
      await sleep(500);
    }
    check(results, '启动后自动查到新版并下载校验', state && state.phase === 'ready', state ? state.phase + ' ' + (state.error || '') : 'no state');
    check(results, '标记为静默', state && state.quiet === true);
    check(results, '只请求了清单和增量包', requests.includes('/latest.json') && requests.some(u => u.endsWith('-update.gz')), requests.join(' '));
    check(results, '没有弹更新窗口', !(await c.eval(`!!document.querySelector('dialog.app-update-dialog[open]')`)));
    check(results, '标题栏没有更新提示', !(await c.eval(`!!document.getElementById('hub-update-pill')`)));
    check(results, '设置按钮没有红点', !(await c.eval(`document.getElementById('btn-options')?.classList.contains('update-has-unread')`)));
    check(results, '安装目录还没动', fs.readFileSync(path.join(resources, 'app.asar'), 'utf8') === 'old-asar');
    await c.close().catch(() => {});
    await gracefulQuit(hub);
    hub = null;
    const resultFile = path.join(data, 'app-update', 'last-result.json');
    for (const end = Date.now() + 60000; Date.now() < end && !fs.existsSync(resultFile);) await sleep(500);
    const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^﻿/, '')) : null;
    check(results, '退出后替换脚本写了结果', !!result, JSON.stringify(result));
    check(results, '替换成功且标记静默', result && result.ok === true && result.quiet === true);
    check(results, 'app.asar 已换成新文件', sha(fs.readFileSync(path.join(resources, 'app.asar'))) === sha(fs.readFileSync(path.join(fresh, 'app.asar'))));
    check(results, '解包目录也换了', fs.readFileSync(path.join(resources, 'app.asar.unpacked', 'marker.txt'), 'utf8') === 'new');
    const plan = JSON.parse(fs.readFileSync(path.join(data, 'app-update', 'plan.json'), 'utf8'));
    check(results, '计划里写明不重开程序', plan.relaunch === false);
  } catch (error) {
    check(results, '运行没有异常', false, error.stack || error.message);
  } finally {
    if (hub) await gracefulQuit(hub).catch(() => {});
    server.close();
  }
  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({ pass: results.length - failed.length, fail: failed.length, root }));
  process.exit(failed.length ? 1 : 0);
})();
