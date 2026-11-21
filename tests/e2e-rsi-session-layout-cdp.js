'use strict';
// Isolated GUI regression: synthetic sessions, no provider requests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/rsi-session-layout');
const probe = process.argv.includes('--probe');
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-layout-'));
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  let hub, c;
  const report = [];
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, windowMode: 'hidden', label: 'session-layout', extraEnv: { HUB_SESSION_SEARCH_DISABLE_NATIVE: '1' } });
    c = await connectFirstPage(hub);
    for (let i = 0; i < 150; i++) { if (await c.eval('typeof renderSessionList === "function"')) break; await sleep(200); }
    console.log('isolated Hub ready');
    for (const theme of ['codex', 'dark', 'frost']) {
      await c.eval(`localStorage.setItem('hub.theme', ${JSON.stringify(theme)})`);
      await c.send('Page.reload'); await sleep(1800);
      await c.eval(`(() => {
        window.hubWorkspaces?.close();
        document.getElementById('app-container').classList.remove('workspace-active');
        sessions.clear();
        for(let i=0;i<8;i++) sessions.set('layout-'+i,{id:'layout-'+i, title:'布局验证会话 '+(i+1),kind:'codeagent',status:'idle',cwd:'C:/test',createdAt:Date.now(),lastMessageTime:Date.now(),updatedAt:Date.now()});
        activeSessionId='layout-0';activeMeetingId=null;renderSessionList();
      })()`);
      for (const width of [1440, 900, 720]) {
        await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await sleep(500);
        const stats = await c.eval(`(() => {
          const rect = e => {const r=e.getBoundingClientRect();const s=getComputedStyle(e);return {x:r.x,y:r.y,w:r.width,h:r.height,bg:s.backgroundColor,shadow:s.boxShadow,min:s.minWidth,padding:s.padding,overflow:s.overflow,scroll:e.scrollWidth,client:e.clientWidth}};
          const side=document.getElementById('session-sidebar'),row=document.querySelector('.session-item.selected'),other=document.querySelector('.session-item:not(.selected)');
          return {theme:document.documentElement.dataset.theme,width:innerWidth,side:rect(side),row:row&&rect(row),other:other&&rect(other),body:rect(document.body),html:document.documentElement.outerHTML.slice(0,400)};
        })()`);
        report.push(stats);
        fs.writeFileSync(path.join(out, `${probe?'before':'after'}-${theme}-${width}.png`), Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
        if (!probe) {
          assert.ok(stats.row, 'current session has the selected class');
          assert.ok(stats.row.h <= 30, 'session rows stay compact');
          assert.notEqual(stats.row.bg, stats.other.bg, 'current session has a distinct background');
          assert.ok(stats.side.x >= 0 && stats.side.x + stats.side.w <= width, 'sidebar fits the viewport');
          assert.ok(stats.side.scroll <= stats.side.client + 1, 'sidebar content is not horizontally clipped');
        }
      }
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const railWidth of [44, 36, 64]) {
        await c.eval(`(() => {const input=document.querySelector('[data-display-field="railWidth"]');input.value=${railWidth};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await sleep(500);
        const nav = await c.eval(`(() => {
          const rail=document.getElementById('scene-rail'),button=document.getElementById('btn-home');
          const r=rail.getBoundingClientRect(),b=button.getBoundingClientRect();
          return {theme:document.documentElement.dataset.theme,railWidth:${railWidth},rail:{left:r.left,right:r.right,width:r.width},button:{left:b.left,right:b.right,width:b.width},hit:button.contains(document.elementFromPoint(b.right-2,b.y+b.height/2))};
        })()`);
        report.push(nav);
        fs.writeFileSync(path.join(out, `${probe?'before':'after'}-${theme}-rail-${railWidth}.png`), Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
        if(!probe) {
          assert.ok(nav.button.right <= nav.rail.right, 'navigation button fits the custom rail width');
          assert.ok(nav.hit, 'right side of the navigation button remains clickable');
        }
      }
      await c.eval(`(() => {const input=document.querySelector('[data-display-field="zoomLevel"]');input.value=2;input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(500);
      const scaled = await c.eval(`(() => {const s=document.getElementById('session-sidebar').getBoundingClientRect();return {width:innerWidth,left:s.left,right:s.right,zoom:require('electron').webFrame.getZoomFactor()};})()`);
      assert.ok(scaled.zoom > 1.4, 'overall UI zoom is applied');
      assert.ok(scaled.left >= 0 && scaled.right <= scaled.width, 'sidebar fits after overall zoom');
      report.push({theme,scaled});
      await c.eval(`(() => {const input=document.querySelector('[data-display-field="zoomLevel"]');input.value=0;input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      const fonts = await c.eval(`(() => {
        const fixture=document.createElement('div');
        fixture.id='layout-code-fixture';fixture.style.cssText='position:fixed;right:40px;top:120px;width:450px;z-index:10000;background:var(--bg-primary);padding:20px';
        fixture.innerHTML='<div class="msg-overlay"><div class="turn-body"><div class="code-block-wrap"><pre><code>const value = 42;</code></pre></div></div></div><div class="mr-gc-md"><pre><code>const value = 42;</code></pre></div>';
        document.body.append(fixture);
        const read=()=>[...fixture.querySelectorAll('pre code')].map(e=>parseFloat(getComputedStyle(e).fontSize));
        const apply=require('../renderer/card-display-settings.js').applyCardDisplaySettings;
        document.documentElement.style.setProperty('--main-zoom','1');apply(document,{cardFontSize:16});const before=read();
        apply(document,{cardFontSize:22});const setting=read();
        document.documentElement.style.setProperty('--main-zoom','1.25');const zoom=read();
        apply(document,{cardFontSize:16});document.documentElement.style.setProperty('--main-zoom','1');fixture.remove();
        return {theme:document.documentElement.dataset.theme,before,setting,zoom};
      })()`);
      report.push({fonts});
      for(let i=0;i<fonts.before.length;i++) {
        assert.ok(fonts.setting[i] > fonts.before[i]*1.3, 'code follows the font-size setting');
        assert.ok(fonts.zoom[i] > fonts.setting[i]*1.2, 'code follows main-area zoom');
      }
    }
  } finally {
    fs.writeFileSync(path.join(out, probe?'before.json':'after.json'), JSON.stringify(report,null,2));
    try { if(hub) await gracefulQuit(hub); } finally { await c?.close(); }
  }
  console.log(JSON.stringify({passed:true,checks:report.length}));
}
main().catch(error => { console.error(error.stack); process.exitCode=1; });
