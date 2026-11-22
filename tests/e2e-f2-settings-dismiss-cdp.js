'use strict';
// r7 F2 回归（隔离 Hub、无头 CDP）：设置各页签逐个点输入框不关；在输入框里拖选拖到框外松开不关；
// 自有 API 弹窗同样；关掉自有 API 回到设置；真 Electron nativeImage 把 3840×2160 缩到 2000×1125。
// 用法：node tests/e2e-f2-settings-dismiss-cdp.js（截图写 HUB_E2E_ARTIFACT_DIR 或 artifacts/f2-probe）
const fs = require('fs'); const os = require('os'); const net = require('net'); const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = process.env.HUB_E2E_ARTIFACT_DIR || path.resolve('artifacts/f2-probe');
function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub f2 ')); const data = path.join(root, 'data'); const home = path.join(root, 'home');
  for (const d of [data, home, out]) fs.mkdirSync(d, { recursive: true });
  const env = { USERPROFILE: home, HOME: home, CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(root, 'ws') };
  let hub, cdp; const log = [];
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'f2-probe', extraEnv: env, windowMode: 'hidden' });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    const until = async (expr, label, t = 40000) => { const end = Date.now() + t; while (Date.now() < end) { try { if (await cdp.eval(expr)) return; } catch {} await sleep(200); } throw new Error('Timeout ' + label); };
    const mouse = async p => { await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p }); };
    const click = async sel => { const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`); await mouse(p); };
    await until('document.getElementById("btn-options")', 'boot');
    await sleep(3000);
    await click('#btn-options'); await until('document.getElementById("options-settings")?.getBoundingClientRect().width>0', 'menu');
    await click('#options-settings'); await until('!document.getElementById("config-modal").classList.contains("hidden")', 'settings');
    const open = () => cdp.eval('!document.getElementById("config-modal").classList.contains("hidden")');
    // 真 Electron 的 nativeImage：3840×2160 位图按长边缩到 2000（保存粘贴图片时用的同一个函数）
    log.push('nativeImage ' + await cdp.eval(`(()=>{const {nativeImage}=require('electron');const path=require('path');const m=require(path.join(${JSON.stringify(path.resolve(__dirname, '..'))},'main/ipc/app-utility-handlers.js'));const buf=Buffer.alloc(3840*2160*4,200);const img=nativeImage.createFromBitmap(buf,{width:3840,height:2160});const r=m.fitImageToMaxEdge(img);const png=r.image.toPNG();const back=nativeImage.createFromBuffer(png).getSize();return JSON.stringify({resized:r.resized,to:r.to,png:back})})()`));
    const tabs = await cdp.eval('[...document.querySelectorAll("[data-cfg-tab-btn]:not([hidden])")].map(b=>b.dataset.cfgTabBtn)');
    for (const tab of tabs) {
      if (!(await open())) { await click('#btn-options'); await sleep(300); await click('#options-settings'); await sleep(500); }
      await click(`[data-cfg-tab-btn="${tab}"]`); await sleep(300);
      const fields = await cdp.eval(`[...document.querySelectorAll('#config-main-view input:not([type=hidden]), #config-main-view textarea, #config-main-view select')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height}).map((e,i)=>{e.dataset.f2probe=${JSON.stringify(tab)}+i;const r=e.getBoundingClientRect();return {k:e.dataset.f2probe,id:e.id||e.name||e.type,x:r.x+Math.min(r.width/2,20),y:r.y+r.height/2,type:e.type}})`);
      for (const f of fields) {
        if (f.type === 'checkbox' || f.type === 'radio' || f.type === 'file') continue;
        if (!(await open())) break;
        await mouse({ x: f.x, y: f.y }); await sleep(400);
        const still = await open();
        log.push(`${tab} ${f.id} -> ${still ? 'open' : 'CLOSED'}`);
        if (!still) { await click('#btn-options'); await sleep(300); await click('#options-settings'); await sleep(500); await click(`[data-cfg-tab-btn="${tab}"]`); await sleep(300); }
      }
    }

    // 拖选：在输入框里按下、拖到弹窗外松开（选中旧 Key 替换时常见）
    const drag = async (from, to) => { await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...from }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', ...to }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...to }); };
    await click('[data-cfg-tab-btn="server"]'); await sleep(300);
    const inp = await cdp.eval(`(()=>{const r=document.getElementById('cfg-aliyun-label').getBoundingClientRect();const c=document.querySelector('#config-modal .config-modal-content').getBoundingClientRect();return {from:{x:r.x+10,y:r.y+r.height/2},to:{x:Math.max(5,c.x-30),y:r.y+r.height/2}}})()`);
    await drag(inp.from, inp.to); await sleep(400);
    log.push('settings drag-select out -> ' + ((await open()) ? 'open' : 'CLOSED'));
    if (!(await open())) { await click('#btn-options'); await sleep(300); await click('#options-settings'); await sleep(500); }
    // 自有 API 弹窗
    await click('[data-cfg-tab-btn="general"]'); await sleep(300);
    await click('#company-api-settings-open'); await sleep(1500);
    log.push('after open API: settings=' + (await open()) + ' apiDialog=' + (await cdp.eval('!!document.getElementById("company-api-dialog")?.open')));
    const apiFields = await cdp.eval(`[...document.querySelectorAll('#company-api-dialog input:not([type=hidden]), #company-api-dialog textarea, #company-api-dialog select')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&e.type!=='checkbox'&&e.type!=='radio'}).map(e=>{const r=e.getBoundingClientRect();return {id:e.name||e.id||e.type,x:r.x+Math.min(r.width/2,20),y:r.y+r.height/2}})`);
    for (const f of apiFields) { await mouse({ x: f.x, y: f.y }); await sleep(400); log.push(`api ${f.id} -> dialog ${await cdp.eval('!!document.getElementById("company-api-dialog")?.open')}`); }

    const ak = await cdp.eval(`(()=>{const e=document.querySelector('#company-api-dialog [name=apiKey]');const r=e.getBoundingClientRect();const c=document.getElementById('company-api-dialog').getBoundingClientRect();return {from:{x:r.x+10,y:r.y+r.height/2},to:{x:Math.min(innerWidth-5,c.right+30),y:r.y+r.height/2}}})()`);
    await drag(ak.from, ak.to); await sleep(400);
    log.push('api drag-select out -> dialog ' + (await cdp.eval('!!document.getElementById("company-api-dialog")?.open')));
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'f2-api-dialog.png'), Buffer.from(png.data, 'base64'));
    if (await cdp.eval('!!document.getElementById("company-api-dialog")')) { await click('#company-api-dialog .company-api-close'); await sleep(600); if (await cdp.eval('!!document.getElementById("company-api-dialog")')) { await click('#company-api-dialog .company-api-close'); await sleep(600); } }
    log.push('after close API: settings=' + (await open()) + ' cls=' + (await cdp.eval('document.getElementById("config-modal").className')) + ' dlg=' + (await cdp.eval('!!document.getElementById("company-api-dialog")')));
  } catch (e) { log.push('ERROR ' + e.stack); }
  finally { if (cdp) cdp.close?.(); if (hub) await gracefulQuit(hub).catch(() => {}); }
  console.log(log.join('\n'));
  const text = log.join('\n');
  const must = [/settings drag-select out -> open/, /api drag-select out -> dialog true/, /after close API: settings=true/, /"to":\{"width":2000,"height":1125\}/];
  const bad = must.filter(re => !re.test(text)).map(String).concat(/CLOSED|ERROR/.test(text) ? ['出现 CLOSED/ERROR'] : []);
  if (bad.length) { console.error('FAIL', bad); process.exitCode = 1; } else console.log('PASS');
})();
