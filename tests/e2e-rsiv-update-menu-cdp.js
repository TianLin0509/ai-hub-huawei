'use strict';
// Isolated UI with deterministic network fixtures; no company access or downloads.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

(async () => {
  const out = process.argv[2];
  const label = process.argv[3] || 'after';
  fs.mkdirSync(out, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rsiv-'));
  const hub = await launchIsolatedHub({ dataDir, port: 9600 + Math.floor(Math.random() * 300),
    windowMode: 'hidden', label: 'rsiv-update-menu' });
  let page;
  const results = {};
  try {
    page = await connectFirstPage(hub, null, { waitMainMs: 30000 });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    async function click(selector) {
      const point = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    }
    await page.eval(`new Promise(resolve => { const wait = () => document.getElementById('options-feedback-mine') && document.getElementById('options-check-update') ? resolve(true) : setTimeout(wait, 100); wait(); })`);
    await click('#btn-options');
    await new Promise(resolve => setTimeout(resolve, 250));
    results.menu = await page.eval(`(() => { const m = document.getElementById('options-menu'), item = document.getElementById('options-feedback-mine'); const r = m.getBoundingClientRect(), i = item.getBoundingClientRect();
      return { scrollHeight: m.scrollHeight, clientHeight: m.clientHeight, top: r.top, bottom: r.bottom, itemTop: i.top, itemBottom: i.bottom, fullyVisible: i.top >= r.top && i.bottom <= r.bottom && i.bottom <= innerHeight }; })()`);
    async function screenshot(name) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, `${label}-${name}.png`), Buffer.from(shot.data, 'base64'));
    }
    await screenshot('settings-menu');
    await page.eval(`(() => { const ipc = require('electron').ipcRenderer; const invoke = ipc.invoke.bind(ipc); window.__rsivInvoke = invoke;
      const { createNetPass } = require('../core/net-pass');
      window.__rsivSetup = mode => {
        let accessible = mode === 'already';
        window.__rsivPass = createNetPass({ hosts: ['fast', 'legacy'].map((id, i) => ({ host: id + '.example.test', name: i ? '阿里云' : '阿里云高速', page: 'https://' + id + '.example.test/pass' })),
          fetchImpl: async () => ({ status: 200, text: async () => accessible ? '<title>AI HUB 服务</title>' : '<html>HIS Proxy Notification</html>' }),
          openGate: async () => { accessible = mode === 'success'; return { clicked: accessible, timedOut: mode === 'timeout' }; },
          onChange: s => ipc.emit('net-pass:state', {}, s) });
      };
      window.__rsivSetup('already');
      ipc.invoke = (channel, ...args) => channel === 'net-pass:status' ? Promise.resolve(window.__rsivPass.status())
        : channel === 'net-pass:run' ? (window.__rsivRun = window.__rsivPass.passAll())
        : channel === 'app-update:check' ? Promise.resolve(null) : invoke(channel, ...args);
      ipc.emit('app-update:state', {}, { phase: 'none', current: '5.6.77' });
    })()`);
    await click('#options-check-update');
    // Reproduce the automatic pass path: only state events reach the dialog.
    await page.eval(`window.__rsivPass.passAll()`);
    results.update = await page.eval(`(() => { const b = document.querySelector('.app-update-dialog [data-np="run"]'); return { disabled: b.disabled, text: b.textContent, body: b.parentElement.textContent }; })()`);
    await screenshot('check-update');
    fs.writeFileSync(path.join(out, `${label}-ui.json`), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
    if (label !== 'before') {
      assert.equal(results.update.disabled, false);
      assert.doesNotMatch(results.update.text, /正在放行/);
      assert.equal(results.menu.fullyVisible, true);
      await click('.app-update-dialog [data-np="run"]');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.match(await page.eval(`document.querySelector('.app-update-dialog').textContent`), /本来就可以访问/);
      for (const [mode, expected] of [['success', '放行成功'], ['failure', '放行失败'], ['timeout', '放行超时']]) {
        await page.eval(`window.__rsivSetup(${JSON.stringify(mode)})`);
        await click('.app-update-dialog [data-np="run"]');
        await page.eval(`window.__rsivRun`);
        const text = await page.eval(`document.querySelector('.app-update-dialog').textContent`);
        assert.ok(text.includes(expected), text);
        assert.equal(await page.eval(`document.querySelector('.app-update-dialog [data-np="run"]').disabled`), false);
        await screenshot(`update-${mode}`);
      }
      await page.eval(`window.__rsivSetup('success'); window.__rsivPass.passAll()`);
      assert.match(await page.eval(`document.querySelector('.app-update-dialog').textContent`), /放行成功/);
      assert.equal(await page.eval(`document.querySelectorAll('.app-update-dialog [data-np="open"]').length`), 0);
    }
  } finally {
    await page?.close();
    console.log('teardown', JSON.stringify(await gracefulQuit(hub)));
  }
  console.log('PASS', label);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
