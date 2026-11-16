'use strict';
// 真实 Electron 页面 + 鼠标操作；服务使用临时合成数据，目录选择器返回值模拟。
// 系统选择器的 IPC 接线另外由 unit-company-assistant-data-root 覆盖。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-storage-gui-'));
  const out = path.resolve('artifacts/assistant-data-root'); fs.mkdirSync(out, { recursive: true });
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'hub'), port, label: 'assistant-data-root', extraArgs: ['--enable-features=SharedArrayBuffer'] });
    c = await connectFirstPage(hub);
    for (let i = 0; i < 100; i++) {
      if (await c.eval(`document.readyState === 'complete' && !!document.head && !!document.getElementById('btn-company-assistant')`)) break;
      await sleep(100);
    }
    await c.eval(`(() => {
      window.__companyAssistantHide?.();
      document.querySelector('#company-assistant-page')?.remove();
      window.__optionalFeatures = null;
      const { CompanyAssistant } = require('../core/company-assistant/service');
      const path = require('node:path');
      const root = ${JSON.stringify(root)};
      const deps = { dataDir: path.join(root, 'fixture'), noTools: true, noTimer: true, bus: { latest: () => [] }, welinkRun: async () => ({ code: 0, stdout: '{}' }), getSession: () => null };
      window.storageFixture = { make() { const a = new CompanyAssistant(deps); a.cli = () => ''; a.changed = () => {}; return a; }, next: path.join(root, '新目录 with spaces'), cancel: false, messages: [] };
      const f = window.storageFixture; f.a = f.make();
      const ipc = { on() {}, async invoke(channel, args) {
        if (channel === 'company-assistant:status') return f.a.status();
        if (channel === 'company-assistant:memory') return { ok: true, items: [] };
        if (channel === 'company-assistant:pick-data-root') {
          if (f.cancel) return { ok: true, canceled: true };
          try { return { ok: true, settings: f.a.setSettings({ dataRoot: f.next }) }; } catch(e) { return { ok: false, error: e.message }; }
        }
        if (channel === 'company-assistant:set-settings') return { ok: true, settings: f.a.setSettings(args) };
        throw Error('unexpected fixture IPC ' + channel);
      } };
      f.page = require('../renderer/company-assistant-page').createCompanyAssistantPage({ document, window, ipcRenderer: ipc, showMessage: msg => f.messages.push(msg) });
      return f.page.open();
    })()`);
    const until = async expr => { for (let i = 0; i < 80; i++) { if (await c.eval(expr)) return; await sleep(100); } const shot = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'failure.png'), Buffer.from(shot.data, 'base64')); throw Error('GUI timeout: ' + expr + '\n' + await c.eval(`document.querySelector('.ca-settings')?.innerText`)); };
    const click = async selector => {
      if (selector.includes('settings-tab:')) selector = '.ca-settings ' + selector;
      const point = await c.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x+r.width/2, y:r.y+r.height/2 }; })()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      await sleep(200);
    };
    await until(`!!document.querySelector('[data-ca="settings"]')`);
    await click('[data-ca="settings"]'); await click('[data-ca="settings-tab:welink"]');
    await until(`document.querySelector('.ca-settings').innerText.includes('助理数据目录')`);
    assert.ok(await c.eval(`document.querySelector('.ca-settings').innerText.includes(storageFixture.a.dir)`));
    await c.eval('storageFixture.cancel = true'); await click('[data-ca="pick-data-root"]');
    assert.equal(await c.eval('storageFixture.a.settings().dataRoot'), '');
    await c.eval('storageFixture.cancel = false'); await click('[data-ca="pick-data-root"]');
    await until(`document.querySelector('.ca-settings').innerText.includes('重启 Hub 后生效')`);
    assert.equal(await c.eval('storageFixture.a.dir === storageFixture.next'), false);
    await c.eval(`storageFixture.a.write('chat.json', []); storageFixture.a = storageFixture.make(); storageFixture.page.close(); storageFixture.page.open()`);
    await click('[data-ca="settings"]'); await click('[data-ca="settings-tab:welink"]');
    await until(`document.querySelector('.ca-settings').innerText.includes('当前目录：' + storageFixture.next)`);
    assert.equal(await c.eval('storageFixture.a.dir === storageFixture.next'), true);
    await click('[data-ca="reset-data-root"]');
    await until(`storageFixture.a.settings().dataRoot === ''`);
    assert.equal(await c.eval('storageFixture.a.dir === storageFixture.next'), true);
    await c.eval(`storageFixture.next = 'relative'`); await click('[data-ca="pick-data-root"]');
    await until(`document.querySelector('[data-slot="action-error"]').innerText.includes('绝对路径')`);
    await c.eval(`storageFixture.a.write('settings.json', { dataRoot: 'relative' }); storageFixture.a = storageFixture.make(); storageFixture.page.close(); storageFixture.page.open()`);
    await click('[data-ca="settings"]'); await click('[data-ca="settings-tab:welink"]');
    await until(`document.querySelector('.ca-settings').innerText.includes('本次使用默认目录')`);
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'settings.png'), Buffer.from(shot.data, 'base64'));
    fs.writeFileSync(path.join(out, 'gui-result.json'), JSON.stringify({ ok: true, root, simulatedPicker: true, checks: ['default', 'cancel', 'save-needs-restart', 'restart-migrates', 'reset', 'invalid-path', 'startup-error'] }, null, 2));
    console.log('GUI PASS: 7 checks; simulated picker, real renderer and temporary service data');
  } finally { if (c) await c.close(); if (hub) await gracefulQuit(hub); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
