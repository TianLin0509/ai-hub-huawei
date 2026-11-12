'use strict';
// 底栏「一键放行」真实隔离 Hub 验证：按钮出现在底栏右侧、1440 宽下不挤出、能读状态、点一下跑完全局放行并给出结果。
// 用法：node tests/e2e-net-pass-global-cdp.js [截图输出目录]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

(async () => {
  const out = process.argv[2] || path.join(__dirname, '..', 'artifacts');
  fs.mkdirSync(out, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubh-npg-'));
  const hub = await launchIsolatedHub({ dataDir, port: 9400 + Math.floor(Math.random() * 400), label: 'net-pass-global' });
  let page, ok = false;
  try {
    page = await connectFirstPage(hub, null, { waitMainMs: 30000 });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    let info = null;
    for (let i = 0; i < 60; i++) {
      info = await page.eval(`(() => { const b = document.getElementById('net-pass-global'); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(); const f = document.getElementById('hub-system-footer').getBoundingClientRect();
        return { text: b.innerText, state: b.dataset.state, title: b.title, x: r.x, right: r.right, y: r.y, h: r.height, footerTop: f.top, footerRight: f.right, inFooter: b.parentElement.id }; })()`);
      if (info) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('button', JSON.stringify(info));
    if (!info) throw new Error('底栏没有出现「一键放行」按钮');
    if (info.right > info.footerRight + 1 || info.y < info.footerTop - 1) throw new Error('按钮不在底栏可见范围内');
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, '20261112-net-pass-global-before-claude.png'), Buffer.from(shot.data, 'base64'));
    const t0 = Date.now();
    const result = await page.eval(`(async () => { document.getElementById('net-pass-global').click(); for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 500)); const b = document.getElementById('net-pass-global'); if (b.dataset.state !== 'running') return { state: b.dataset.state, text: b.innerText, title: b.title }; } return null; })()`, { timeoutMs: 90000 });
    console.log('after click', Date.now() - t0, 'ms', JSON.stringify(result));
    const shot2 = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, '20261112-net-pass-global-after-claude.png'), Buffer.from(shot2.data, 'base64'));
    ok = !!result;
  } finally {
    try { await page?.close(); } catch {}
    await gracefulQuit(hub);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
