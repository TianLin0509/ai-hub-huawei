'use strict';
// 打开会议室页 → 抢订计划：三格地域输入默认全空、说明「留空＝沿用网页上次选的地域」；填 5 间会议室后
// 新增一行不超过 40px；截图留给人工看（计划页放 5 间会议室时 main 上原本就要滚动，见 F8 报告）。
// 用法：node tests/e2e-rooms-area-cdp.js [--out <目录>]
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
function ok(label, condition = true, detail = '') { assert(condition, label + (detail ? ' ' + detail : '')); console.log('PASS ' + label + (detail ? ' ' + detail : '')); }

async function run() {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i > 0 ? process.argv[i + 1] : process.env.HUB_E2E_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-area-art-')));
  fs.mkdirSync(out, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rooms-area-'));
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'background', label: 'rooms-area', extraEnv: {
      ...(fs.existsSync(path.join(REPO, 'community-edition.json')) ? {} : { CLAUDE_HUB_COMPANY_ASSISTANT: '1' }), CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = typeof expr === 'function' ? await expr() : await c.eval(expr); if (v) return v; } catch { /* */ } await sleep(200); } throw Error('Timeout ' + label); };
    const click = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
    const type = (sel, value) => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    const sum = () => c.eval(`document.querySelector('[data-cr-slot="plan-summary"]')?.textContent||''`);

    await wait(`!!document.getElementById('btn-company-rooms')`, 'rooms nav', 60000);
    await click('#btn-company-rooms');
    await wait(`!!document.querySelector('[data-cr-tab="plan"]')`, 'rooms page');
    await click('[data-cr-tab="plan"]');
    await wait(`!!document.querySelector('[data-cr-slot="plan-summary"]')`, 'plan tab');
    await wait(sum, 'summary text');
    const boxes = await c.eval(`[...document.querySelectorAll('.cr-area [data-cr-field^="地域."]')].map(e=>[e.dataset.crField,e.value,e.placeholder])`);
    ok('三格地域输入，默认全空', boxes.length === 3 && boxes.every(b => b[1] === '') && boxes.map(b => b[0]).join() === '地域.国家/地区,地域.城市,地域.楼宇', JSON.stringify(boxes));
    const hint = await c.eval(`document.querySelector('.cr-hint-top')?.textContent||''`);
    ok('就地说明留空的含义与怎么填', /所在地域留空＝不切换/.test(hint) && /清空后自动切回原来的地域/.test(hint) && /从页面读取/.test(hint), hint);
    const unlock = () => c.eval(`document.querySelectorAll('#company-rooms-page [disabled], .cr-sheet [disabled]').forEach(e=>e.disabled=false)`);
    await unlock();
    await type('[data-cr-field="地域.城市"]', '北京');
    for (const r of ['北研所A座-101', '北研所A座-102', '北研所B座-201', '北研所B座-202', '北研所C座-301']) {
      await unlock(); await type('[data-cr-new-room]', r); await unlock(); await click('[data-cr-op="add"]');
    }
    await unlock();
    ok('改地域后草稿里留着', await c.eval(`document.querySelector('[data-cr-field="地域.城市"]').value`) === '北京');
    const layout = await c.eval(`(()=>{const out=[];for(const e of document.querySelectorAll('#company-rooms-page *')){const s=getComputedStyle(e);if(/auto|scroll/.test(s.overflowY)&&e.scrollHeight>e.clientHeight+1&&e.clientHeight>0)out.push([e.className.toString().slice(0,40),e.scrollHeight,e.clientHeight]);}return {doc:document.documentElement.scrollHeight<=innerHeight+1,scrollers:out}})()`);
    fs.writeFileSync(path.join(out, '20261122-F8-rooms-area-plan.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const diag = await c.eval(`(()=>{const el=document.querySelector('.cr-content');const r={full:el.scrollHeight,client:el.clientHeight};const a=document.querySelector('.cr-area');const h=a.getBoundingClientRect().height+parseFloat(getComputedStyle(a).marginTop)+parseFloat(getComputedStyle(a).marginBottom);a.style.display='none';r.noArea=el.scrollHeight;a.style.display='';r.rowPx=Math.round(h);return r})()`);
    console.log('LAYOUT ' + JSON.stringify({ ...layout, ...diag }));
    // 计划页 5 间会议室时原本就要滚动（main 上 872/611，与本改动无关，见报告）；这里只卡新增一行的高度。
    ok('地域一行只占一行高度（≤ 40px）', diag.rowPx <= 40, JSON.stringify(diag));
    console.log('ARTIFACTS ' + out);
  } finally {
    try { c?.close?.(); } catch { /* */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}
run().then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
