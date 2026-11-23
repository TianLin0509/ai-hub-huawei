'use strict';
// 新建会话底栏的默认工作目录（2026-11-23）：隔离 Hub、1440 宽、后台无窗口，走真实点击与真实 save-hub-config。
// 用法：node tests/e2e-default-root-footer-cdp.js（HUB_E2E_ARTIFACT_DIR 指定截图目录）
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const REPO = path.resolve(__dirname, '..');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const OUT = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(REPO, 'artifacts', 'default-root-footer')); fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
(async () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-root-footer-')), DATA = path.join(ROOT, 'data'), NEWROOT = path.join(ROOT, 'D-drive-work');
  fs.mkdirSync(DATA, { recursive: true });
  let hub, c; const log = [];
  const until = async (expr, label, t = 45000) => { const end = Date.now() + t; let last; while (Date.now() < end) { try { last = await c.eval(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(150); } throw new Error('Timeout ' + label + ' ' + JSON.stringify(last)); };
  async function click(sel) {
    const xy = await until(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();if(!r.width)return null;const x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return h&&(h===e||e.contains(h))?{x,y}:null})()`, 'clickable ' + sel);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...xy });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...xy, button: 'left', clickCount: 1 });
  }
  const shot = async n => { await sleep(400); const img = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, n + '.png'); fs.writeFileSync(f, Buffer.from(img.data, 'base64')); log.push('SHOT ' + f); };
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), label: 'root-footer', windowMode: 'hidden', extraEnv: { AI_HUB_WORKSPACE_ROOT: '', CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`typeof sessions !== 'undefined'`, 'renderer ready', 60000);
    await c.eval(`(()=>{const ipc=require('electron').ipcRenderer,orig=ipc.invoke.bind(ipc);ipc.invoke=(ch,...a)=>ch==='workspace:pick-default-root'?Promise.resolve(${JSON.stringify(NEWROOT)}):ch==='workspace:root-disk'?Promise.resolve({root:'C:/',pct:92,freeGb:18.4}):orig(ch,...a);return 1})()`);
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launcher');
    const before = await until(`(()=>{const b=document.getElementById('new-session-root-edit');return b&&!b.hidden&&b.textContent?{btn:b.textContent,title:b.title,sum:document.getElementById('new-session-summary').textContent,info:!document.getElementById('new-session-root-info').hidden,disk:document.getElementById('new-session-root-disk').textContent}:null})()`, 'root button');
    log.push('BEFORE ' + JSON.stringify(before));
    assert.ok(before.info, 'ⓘ 说明可见'); assert.match(before.disk, /盘已用 92%.*改到别的盘/);
    await shot('1-footer-before');
    await click('#new-session-root-edit');
    const after = await until(`(()=>{const b=document.getElementById('new-session-root-edit');return b&&b.textContent.includes('D-drive-work')?b.textContent:null})()`, 'root changed');
    log.push('AFTER ' + after);
    const cfg = await c.eval(`require('electron').ipcRenderer.invoke('get-hub-config-raw').then(r=>({d:r.defaultWorkspaceRoot,eff:r.workspaceRootEffective}))`);
    log.push('CONFIG ' + JSON.stringify(cfg));
    assert.equal(cfg.d, NEWROOT); assert.equal(cfg.eff, NEWROOT);
    await shot('2-footer-after');
    // 切到「临时目录」：路径按钮和提示都收起，摘要恢复原样
    await click('[data-workspace-mode="scratch"]');
    const scratch = await c.eval(`({btnHidden:document.getElementById('new-session-root-edit').hidden,disk:document.getElementById('new-session-root-disk').hidden,sum:document.getElementById('new-session-summary').textContent})`);
    log.push('SCRATCH ' + JSON.stringify(scratch));
    assert.ok(scratch.btnHidden && scratch.disk, '临时目录模式收起按钮和提示');
  } catch (e) { log.push('FAIL ' + (e.stack || e.message)); process.exitCode = 1; }
  finally { if (hub) await gracefulQuit(hub).catch(e => log.push('quit ' + e.message)); console.log(log.join('\n')); }
})();
