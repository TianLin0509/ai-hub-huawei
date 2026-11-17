'use strict';
// Real isolated Hub renderer, synthetic failure; no company/model/login calls.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
  const port = server.address().port; server.close(() => resolve(port));
}); });
function contrast() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const color = s => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = s; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
  const over = (a, b) => a.slice(0, 3).map((v, i) => v * a[3] / 255 + b[i] * (1 - a[3] / 255));
  const luminance = a => a.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((v, c, i) => v + c * [.2126, .7152, .0722][i], 0);
  const rows = [];
  for (const el of document.querySelectorAll('#hub-sticky-notices *, #r33-card *, .hub-dialog *')) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const chain = []; let hidden = false;
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p); chain.push(s);
      if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) hidden = true;
    }
    if (hidden || !el.getBoundingClientRect().width) continue;
    let bg = [255, 255, 255];
    for (const s of chain.reverse()) bg = over(color(s.backgroundColor), bg);
    const fg = over(color(getComputedStyle(el).color), bg), l = [luminance(fg), luminance(bg)];
    const ratio = (Math.max(...l) + .05) / (Math.min(...l) + .05);
    rows.push({ text: el.textContent.trim().slice(0, 45), cls: el.className, ratio: +ratio.toFixed(2), fg, bg });
  }
  return rows;
}
async function main() {
  const { signerInitFailureMessage } = await import(pathToFileURL(path.resolve(__dirname, '../core/company-proxy/upstream-profile.mjs')).href);
  const retriedMessage = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { detail: 'CLI_INPUT_MISSING', report: { retried: true } });
  const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/r33/theme'); fs.mkdirSync(out, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r33-'));
  let hub, c;
  const report = { ok: false, syntheticFailure: true, realHubRenderer: true, shots: [] };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(tmp, 'data'), port: await freePort(), windowMode: 'background', label: 'r33-notice',
      extraEnv: { CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CODEX_HOME: path.join(tmp, 'codex'),
        CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(tmp, 'codeagent'),
        AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(tmp, 'scan'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1' } });
    c = await connectFirstPage(hub);
    for (let i = 0; i < 150 && !await c.eval('typeof selectSession === "function"'); i++) await sleep(200);
    for (const width of [1440, 1280]) for (const theme of ['dark', 'codex']) {
      await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await c.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('#btn-home')?.click()`);
      const message = '公司模型暂时用不了：CodeAgent 未收到签名初始化所需的测试输入，在生成签名日志前退出了。\n请点「重新启动反代」重试，仍未恢复时点「一键反馈」附带诊断。';
      await c.eval(`(()=>{document.getElementById('hub-sticky-notices')?.remove();document.getElementById('r33-card')?.remove();
        const notices=require('../renderer/sticky-notice');notices.showStickyNotice(document,${JSON.stringify(message)},'error');
        notices.showStickyNotice(document,'当前模型暂不可用，请选择其他模型后继续。','warning');
        const card=require('../renderer/hub-error-card');const host=document.createElement('div');host.id='r33-card';
        host.style.cssText='position:fixed;left:calc(50% - 420px);top:260px;width:520px;z-index:1000';host.innerHTML=card.html({area:'company-proxy',title:'签名初始化未完成',cause:'测试输入没有送到 CodeAgent。',details:${JSON.stringify(message)}});document.body.append(host);})()`);
      await sleep(400);
      if (width === 1440 && theme === 'dark') {
        await c.eval(`document.querySelectorAll('.hub-sticky-notice').forEach(el=>el.style.background='var(--hw-surface-1, #ffffff)')`);
        const rows = await c.eval(`(${contrast.toString()})()`);
        assert.ok(rows.some(r => r.ratio < 4.5), 'restoring the old background reproduces low contrast');
        const screenshot = path.join(out, 'dark-notices-before-1440.png');
        fs.writeFileSync(screenshot, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        report.control = { oldBackgroundOnly: true, screenshot, rows };
        await c.eval(`document.querySelectorAll('.hub-sticky-notice').forEach(el=>el.style.background='var(--hw-surface, #ffffff)')`);
      }
      const rows = await c.eval(`(${contrast.toString()})()`);
      const screenshot = path.join(out, `${theme}-notices-${width}.png`);
      fs.writeFileSync(screenshot, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      report.shots.push({ theme, width, surface: 'notices', screenshot, rows });
      assert.ok(rows.length >= 8, 'notice text inspected');
      assert.deepEqual(rows.filter(r => r.ratio < 4.5), [], 'contrast >=4.5: ' + theme);
      await c.eval(`(()=>{const old=ipcRenderer.invoke.bind(ipcRenderer);window.__r33Restarts=0;ipcRenderer.invoke=(channel,...args)=>channel==='company-proxy:restart'?(window.__r33Restarts++,Promise.resolve({ok:true})):old(channel,...args);document.querySelector('#hub-sticky-notices [data-hub-err-act="known:proxy-restart"]').click();})()`);
      await sleep(150);
      assert.equal(await c.eval('window.__r33Restarts'), 1, 'restart button invokes existing IPC');
      await c.eval(`void require('../renderer/ui-feedback').showHubAlert(${JSON.stringify(message)},{area:'company-proxy'})`, { awaitPromise: false });
      await sleep(300);
      assert.equal(await c.eval('!!document.querySelector(".hub-dialog [data-hub-err-act=\\"known:proxy-restart\\"]")'), true);
      const dialogRows = await c.eval(`(${contrast.toString()})()`);
      const dialogShot = path.join(out, `${theme}-dialog-${width}.png`);
      fs.writeFileSync(dialogShot, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      report.shots.push({ theme, width, surface: 'dialog', screenshot: dialogShot, rows: dialogRows });
      assert.deepEqual(dialogRows.filter(r => r.ratio < 4.5), [], 'dialog contrast >=4.5: ' + theme);
      await c.eval('document.querySelector(".hub-dialog .hub-dialog-actions button").click()');
      await c.eval(`void require('../renderer/ui-feedback').showHubAlert(${JSON.stringify(retriedMessage)},{area:'company-proxy'})`, { awaitPromise: false });
      await sleep(300);
      assert.equal(await c.eval('!!document.querySelector(".hub-dialog [data-hub-err-act=\\"known:proxy-restart\\"]")'), false);
      assert.equal(await c.eval('!!document.querySelector(".hub-dialog [data-hub-err-assist=\\"feedback\\"]")'), true);
      assert.equal(await c.eval('getComputedStyle(document.querySelector(".hub-dialog .hub-err-assist")).opacity'), '1', 'feedback is visible without requiring a hover');
      const retriedRows = await c.eval(`(${contrast.toString()})()`);
      const retriedShot = path.join(out, `${theme}-retried-feedback-${width}.png`);
      fs.writeFileSync(retriedShot, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      report.shots.push({ theme, width, surface: 'retried-feedback', screenshot: retriedShot, rows: retriedRows });
      assert.deepEqual(retriedRows.filter(r => r.ratio < 4.5), [], 'retried feedback contrast >=4.5: ' + theme);
      await c.eval('document.querySelector(".hub-dialog .hub-dialog-actions button").click()');
    }
    report.ok = true;
  } finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    try { if (hub) await gracefulQuit(hub); } finally { await c?.close(); }
  }
  console.log(JSON.stringify({ ok: report.ok, shots: report.shots.length, minContrast: Math.min(...report.shots.flatMap(s => s.rows.map(r => r.ratio))) }));
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });

