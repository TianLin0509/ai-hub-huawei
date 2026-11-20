'use strict';
// 更新窗按钮栏常驻（2026-11-21）：发布说明很长（15 条）时，「下载更新」必须不用滚动就在视口里；
// 说明默认只列前 5 条，其余折叠成「还有 N 条更新 · 展开」。真实 Main/renderer/IPC，隐藏的隔离 Hub + 本机更新源夹具。
// 用法：node tests/e2e-update-dialog-foot-cdp.js [--shots <截图目录>] [--tag <文件名前缀>] [--no-judge]
//   在 1440x900 与 1280x720、浅色（codex）与深色（dark）主题下各截一张；--no-judge 只截图不判定（截「改动前」用）。
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.join(__dirname, '..');
const SHOTS = opt('shots') ? path.resolve(opt('shots')) : null;
const TAG = opt('tag') || 'after';
const JUDGE = !args.includes('--no-judge');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); };

// 按钮是否完整落在视口里、且没有被别的元素盖住（点得到）。
const FOOT_PROBE = `(() => {
  const d = document.querySelector('dialog.app-update-dialog[open]');
  const b = d && d.querySelector('[data-au="download"]');
  if (!b) return { found: false };
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  const foot = d.querySelector('.au-foot');
  return { found: true, top: r.top, bottom: r.bottom, vh: innerHeight, vw: innerWidth,
    inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
    clickable: !!hit && (hit === b || b.contains(hit)),
    dialogScrolls: d.scrollHeight > d.clientHeight + 1,
    notes: d.querySelectorAll('.au-notes > li:not(.au-notes-more)').length,
    more: (d.querySelector('.au-notes-more') || {}).innerText || '',
    footBg: foot ? getComputedStyle(foot).backgroundColor : '', btnColor: getComputedStyle(b).color, btnBg: getComputedStyle(b).backgroundColor,
    theme: document.documentElement.getAttribute('data-theme') };
})()`;

(async () => {
  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'community-edition.json'), 'utf8')).version;
  const [x, y] = current.split('.').map(Number);
  const next = `${x}.${y + 1}.0`;
  const notes = Array.from({ length: 15 }, (_, i) => `第 ${i + 1} 条更新说明：修复与改进若干，这一条故意写得稍长一点，模拟真实发布说明的长度与换行。`);
  const manifest = { schema: 1, product: 'test', version: next, publishedAt: new Date().toISOString(), notes,
    runtime: { electron: '99.0.0', native: {} }, installer: { file: `AIHubHuawei-Setup-${next}.exe`, bytes: 50 * 1024 * 1024, sha256: 'a'.repeat(64) } };
  const server = http.createServer((req, res) => {
    if (req.url === '/latest.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(manifest)); return; }
    res.statusCode = 404; res.end('nope');
  });
  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upd-foot-'));
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work', '.aiwork-root'), '');
  let hub = null, c = null;
  try {
    hub = await launchIsolatedHub({ entryPath: ROOT, cwd: ROOT, dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'hidden', label: 'upd-foot', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: path.join(root, 'work'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0', AI_HUB_OPENX: '0',
      AI_HUB_UPDATE_SOURCES: JSON.stringify([{ id: 'local', name: '本机', manifest: `http://127.0.0.1:${port}/latest.json`, files: `http://127.0.0.1:${port}/v{version}/` }]),
      AI_HUB_UPDATE_STARTUP_DELAY_MS: '1000' } });
    c = await connectFirstPage(hub, null, { waitMainMs: 20000 });
    let st = null;
    for (const end = Date.now() + 60000; Date.now() < end;) { st = await c.eval('window.__appUpdate && window.__appUpdate.state()').catch(() => null); if (st && st.phase === 'available') break; await sleep(400); }
    check('查到新版本（available）', st && st.phase === 'available', st ? st.phase : 'no state');
    // 关掉启动时可能弹出的其他窗（新手引导等），只留更新窗。
    await c.eval(`document.querySelectorAll('dialog[open]').forEach(d => { if (!d.classList.contains('app-update-dialog')) d.close(); })`);
    await c.eval('window.__appUpdate.open()');
    await sleep(800);
    const shot = async name => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await sleep(500);
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOTS, `${TAG}-${name}.png`);
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
      console.log('SHOT ' + file);
    };
    const evidence = [];
    for (const [w, h] of [[1440, 900], [1280, 720]]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      for (const theme of ['codex', 'dark']) {
        await c.eval(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
        await sleep(400);
        const p = await c.eval(FOOT_PROBE);
        evidence.push({ viewport: `${w}x${h}`, ...p });
        if (JUDGE) {
          check(`${w}x${h} ${theme}：「下载更新」不用滚动就在视口里且点得到`, p.found && p.inView && p.clickable, JSON.stringify({ top: p.top, bottom: p.bottom, vh: p.vh, clickable: p.clickable }));
          check(`${w}x${h} ${theme}：弹窗整体不滚动（只有说明区滚动）`, p.found && !p.dialogScrolls);
          check(`${w}x${h} ${theme}：按钮栏有实底色`, p.footBg && !/rgba\(0, 0, 0, 0\)|transparent/.test(p.footBg), p.footBg);
          check(`${w}x${h} ${theme}：说明默认 5 条 + 「还有 10 条更新 · 展开」`, p.notes === 5 && /还有 10 条更新 · 展开/.test(p.more), `${p.notes} 条 · ${p.more}`);
        }
        await shot(`${w}x${h}-${theme}`);
      }
    }
    // 展开后：15 条全列出，按钮仍在视口里（最小的 1280x720 + 深色）。
    await c.eval(`document.querySelector('dialog.app-update-dialog [data-au="notes-more"]')?.click()`);
    await sleep(400);
    const p = await c.eval(FOOT_PROBE);
    evidence.push({ viewport: '1280x720-expanded', ...p });
    if (JUDGE) {
      check('展开后 15 条全列出、出现「收起」', p.notes === 15 && /收起/.test(p.more), `${p.notes} 条 · ${p.more}`);
      check('展开后「下载更新」仍在视口里且点得到', p.found && p.inView && p.clickable && !p.dialogScrolls, JSON.stringify({ top: p.top, bottom: p.bottom, vh: p.vh }));
    }
    await shot('1280x720-dark-expanded');
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${TAG}-evidence.json`), JSON.stringify(evidence, null, 2));
  } catch (error) {
    check('运行没有异常', false, (error.stack || error.message) + (error.logTail ? '\nLOG:\n' + error.logTail : ''));
  } finally {
    if (c) await c.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    server.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({ pass: results.length - failed.length, fail: failed.length }));
  process.exit(failed.length ? 1 : 0);
})();
