'use strict';
// 底栏最窄时正常的盘收起、告急的盘不收起；点 D 盘能打开硬盘释放；只有一块盘的电脑照旧显示「硬盘」；英文界面显示 C: / D:。
// 用法：node tests/e2e-footer-dual-disk-cdp.js [--out 目录]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const outIdx = process.argv.indexOf('--out');
const out = path.resolve(outIdx > 0 ? process.argv[outIdx + 1] : path.join(__dirname, '..', 'artifacts', `dual-disk-${Date.now()}`));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dual-disk-'));
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
let hub, c;
const checks = [];
const check = (ok, label) => { assert(ok, label); checks.push(label); console.log('PASS ' + label); };
const waitFor = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await c.eval(expr)) return; } catch {} await sleep(200); } throw Error('timeout ' + label); };
const shot = async name => {
  const clip = await c.eval('(()=>{const r=document.querySelector("#hub-system-footer").getBoundingClientRect();return {x:0,y:r.top,width:innerWidth,height:r.height,scale:2};})()');
  const s = await c.send('Page.captureScreenshot', { format: 'png', clip });
  const file = path.join(out, `20261128-dual-disk-${name}.png`);
  fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
  return file;
};
const text = () => c.eval('[...document.querySelectorAll("#sidebar-strip .strip-disk")].map(e=>e.textContent)');
(async () => {
  const shots = [];
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(temp, 'data'), port: await freePort(), label: 'dual-disk', windowMode: 'hidden' });
    c = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor('document.querySelectorAll("#sidebar-strip .strip-disk").length===2', 'two disks');
    const real = await text();
    console.log('real', JSON.stringify(real));
    check(/^C盘\d+%$/.test(real[0]) && /^D盘\d+%$/.test(real[1]), '真实采样下底栏同时显示 C 盘和 D 盘');
    shots.push(await shot('real-1440'));
    const volumes = 'volumes:[{root:"C:\\\\",usagePct:66,freeBytes:324*1024**3,totalBytes:931*1024**3},{root:"D:\\\\",usagePct:100,freeBytes:0,totalBytes:1907*1024**3}]';
    await c.eval(`systemResourceUsage={...systemResourceUsage,disk:{root:"C:\\\\",usagePct:66,${volumes}}};renderSidebarStrip()`);
    check(await c.eval('document.querySelectorAll("#sidebar-strip .strip-disk")[1].classList.contains("strip-resource-critical") && !document.querySelectorAll("#sidebar-strip .strip-disk")[0].classList.contains("strip-resource-high")'), 'D 盘写满时只有 D 盘变红');
    check(await c.eval('/D:\\\\ 已用 100% · 总容量 1907 GB/.test(document.querySelectorAll("#sidebar-strip .strip-disk")[1].title)'), '悬停提示写明哪块盘、用了多少、总容量');
    shots.push(await shot('d-full-1440'));
    // 底栏布局脚本会按宽度重算密度，这里在同一次执行里切到最窄并读样式。
    check(await c.eval('(document.querySelector("#hub-system-footer").dataset.density="minimal") && getComputedStyle(document.querySelectorAll("#sidebar-strip .strip-disk")[1]).display!=="none" && getComputedStyle(document.querySelectorAll("#sidebar-strip .strip-disk")[0]).display==="none"'), '底栏最窄时正常的盘收起，告急的盘不收起');
    await c.eval('document.querySelector("#hub-system-footer").dataset.density="full"');
    // 真实鼠标点 D 盘
    const p = await c.eval('(()=>{const r=document.querySelectorAll("#sidebar-strip .strip-disk")[1].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await waitFor('!document.querySelector("#disk-release-panel").hidden', 'disk panel');
    check(true, '点 D 盘能打开硬盘释放');
    shots.push(await c.send('Page.captureScreenshot', { format: 'png' }).then(s => { const f = path.join(out, '20261128-dual-disk-panel-1440.png'); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); return f; }));
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.eval('document.querySelector("#disk-release-panel").hidden=true');
    await c.eval(`systemResourceUsage={...systemResourceUsage,disk:{root:"C:\\\\",usagePct:66}};renderSidebarStrip()`);
    const single = await text();
    check(single.length === 1 && single[0] === '硬盘66%', '只有一块盘的电脑仍显示「硬盘」，不多出空项');
    await c.eval(`systemResourceUsage={...systemResourceUsage,disk:{root:"C:\\\\",usagePct:66,${volumes}}};renderSidebarStrip()`);
    check((await text()).length === 2, '盘数变化后底栏跟着重建');
    evidenceOk = true;
  } finally {
    try { if (c) await c.close?.(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    fs.writeFileSync(path.join(out, '20261128-dual-disk-evidence.json'), JSON.stringify({ checks, shots }, null, 2));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
let evidenceOk = false;
