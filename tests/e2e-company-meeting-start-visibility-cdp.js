'use strict';
// Real isolated renderer geometry and mouse input; no WeLink, model or recording calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('会议在非全屏两档窗口中开始按钮始终可见且能点到，长转写状态不挤走操作', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-start-layout-'));
  const out = process.env.HUB_MEETING_LAYOUT_ARTIFACTS;
  if (out) fs.mkdirSync(out, { recursive: true });
  const dataDir = path.join(root, 'data'), cli = path.join(root, 'welink-disabled.js');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
  fs.writeFileSync(cli, 'process.stdout.write("{}");');
  let hub, c;
  t.after(async () => { await c?.close(); if (hub) await gracefulQuit(hub); fs.rmSync(root, { recursive: true, force: true }); });
  hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'meeting start layout', extraEnv: {
    CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_WELINK_CLI: cli,
  } });
  c = await connectFirstPage(hub);
  for (let n = 0; n < 200 && !await c.eval(`!!document.querySelector('#btn-company-meeting')`); n++) await _waitMs(100);
  await c.eval(`(() => {
    const original = ipcRenderer.invoke.bind(ipcRenderer);
    ipcRenderer.invoke = async (channel, payload) => {
      if (channel === 'company-assistant:meeting-status') return { ok: true, meetings: [], asr: { ready: false }, models: [] };
      if (channel === 'company-assistant:meeting-sources') return { ok: true, sources: Array.from({length: 20}, (_, i) => ({ id: 'fixture-' + i, name: '共享窗口夹具 ' + i, thumbnail: '' })) };
      return original(channel, payload);
    };
    document.querySelector('#btn-company-meeting').click();
  })()`);
  for (let n = 0; n < 100 && !await c.eval(`!!document.querySelector('.meeting-setup-go [data-act="start"]')`); n++) await _waitMs(100);
  const evidence = [];
  for (const [width, height] of [[1280, 720], [1440, 900]]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const long of [false, true]) {
      await c.eval(`(() => {
        document.querySelector('[data-m="setup-asr"]').textContent = ${JSON.stringify('本地转写：未安装（约 300 MB）')};
        if (${long}) document.querySelector('[data-m="setup-asr"]').textContent = '正在下载本地转写组件，等待网络恢复，稍后会自动继续。'.repeat(30);
        document.querySelector('.meeting-setup-main').scrollTop = 0;
        const fields = document.querySelector('.meeting-setup-fields'); if (fields) fields.scrollTop = 0;
      })()`);
      await _waitMs(80);
      const rect = await c.eval(`(() => {
        const e = document.querySelector('.meeting-setup-go [data-act="start"]'), r = e.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { width: innerWidth, height: innerHeight, x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height,
          hit: !!hit && (hit === e || e.contains(hit)), hidden: e.hidden, disabled: e.disabled };
      })()`);
      evidence.push({ width, height, long, ...rect });
      if (out) {
        const shot = await c.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, `meeting-start-${width}x${height}-${long ? 'long' : 'normal'}.png`), Buffer.from(shot.data, 'base64'));
        fs.writeFileSync(path.join(out, 'geometry.json'), JSON.stringify(evidence, null, 2));
      }
      assert.ok(rect.y >= 0 && rect.bottom <= rect.height && rect.x >= 0 && rect.right <= rect.width && rect.w > 0 && rect.h > 0 && rect.hit && !rect.hidden && !rect.disabled,
        `start button must be visible and clickable without scrolling: ${JSON.stringify(evidence.at(-1))}`);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
      await _waitMs(80);
      assert.equal(await c.eval(`document.querySelector('[data-m="record-only-confirm"]').hidden`), false, 'real click opens the record-only confirmation');
      await c.eval(`document.querySelector('[data-act="cancel-record-only"]').click()`);
    }
  }
});
