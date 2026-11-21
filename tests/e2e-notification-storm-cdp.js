'use strict';
// Real settings/IPC path in a hidden, isolated Hub. No real CLI, accounts or toast.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const output = process.argv[2];
if (!output) throw Error('Specify the screenshot/evidence directory');

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-notice-storm-'));
  let hub, renderer, main;
  const evidence = {};
  try {
    const inspect = await freePort();
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), label: 'notification-storm', windowMode: 'hidden',
      extraArgs: [`--inspect=127.0.0.1:${inspect}`] });
    evidence.hubPid = hub.pid;
    renderer = await connectFirstPage(hub);
    for (let i = 0; i < 120; i++) {
      if (await renderer.eval('typeof ipcRenderer !== "undefined" && typeof sessions !== "undefined"').catch(() => false)) break;
      await sleep(500);
    }
    const targets = await (await fetch(`http://127.0.0.1:${inspect}/json/list`)).json();
    main = await connectCDP(targets[0].webSocketDebuggerUrl);
    // Observe the real main controller while keeping every test window hidden.
    // Patching only this isolated instance avoids a visible toast/card during QC.
    await main.eval(`globalThis.__noticeShows = 0; globalThis.__noticeCreates = 0;
      const bw = process.mainModule.require('electron').BrowserWindow;
      globalThis.__originalInactive = bw.prototype.showInactive;
      bw.prototype.showInactive = function() { globalThis.__noticeShows++; };
      const wc = process.mainModule.require('electron').app;
      wc.on('browser-window-created', () => globalThis.__noticeCreates++);
      process.env.CLAUDE_HUB_E2E_SHOW_NOTIFICATION = '1'; true`);
    await renderer.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await renderer.eval(`ipcRenderer.emit('desktop-notification:open-settings', {}, {})`);
    for (let i = 0; i < 60; i++) {
      if (await renderer.eval(`!!document.getElementById('cfg-notify-mode')?.offsetParent`).catch(() => false)) break;
      await sleep(300);
    }
    async function choose(value) {
      await renderer.eval(`(()=>{const el=document.getElementById('cfg-notify-mode');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      for (let i = 0; i < 60; i++) {
        if (await renderer.eval(`ipcRenderer.invoke('hub-pet:get-settings').then(x=>x.settings.notifyMode===${JSON.stringify(value)})`)) return;
        await sleep(100);
      }
      throw Error('Settings did not persist: ' + value);
    }
    async function shot(name) {
      await sleep(300);
      fs.writeFileSync(path.join(output, name + '.png'), Buffer.from((await renderer.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    }
    const send = async p => { await renderer.eval(`ipcRenderer.send('desktop-notification:show', ${JSON.stringify(p)})`); await sleep(350); };
    const stats = () => main.eval('({shows:globalThis.__noticeShows, creates:globalThis.__noticeCreates})');
    await choose('off'); await shot('通知关闭-1440');
    const normal = { sessionId: 'e2e-notice', title: 'Notification regression', body: 'Same event', completedAt: 111 };
    await send(normal); evidence.off = await stats();
    assert.deepEqual(evidence.off, { shows: 0, creates: 0 });
    await choose('popup'); await send(normal); await send(normal); await send(normal);
    evidence.repeated = await stats();
    assert.equal(evidence.repeated.shows, 1);
    await send({ ...normal, completedAt: 112 }); evidence.nextTurn = await stats();
    assert.equal(evidence.nextTurn.shows, 2);
    await choose('off'); await send({ ...normal, completedAt: 113 });
    evidence.offAgain = await stats(); assert.equal(evidence.offAgain.shows, 2);
    // Existing contract explicitly keeps important reminders even in off mode.
    await send({ ...normal, completedAt: 114, tone: 'bad' }); evidence.urgent = await stats();
    assert.equal(evidence.urgent.shows, 3);
    await choose('pet');
    await renderer.eval(`(()=>{const el=document.getElementById('cfg-hub-pet-enabled');el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    for (let i = 0; i < 60; i++) {
      if (await renderer.eval(`ipcRenderer.invoke('hub-pet:debug',{op:'state'}).then(x=>!!x.bounds)`)) break;
      await sleep(100);
    }
    await renderer.eval(`ipcRenderer.invoke('hub-pet:debug',{op:'push',notice:{id:'e2e-pet-before-off',kind:'session',notify:true,title:'Before off'}})`);
    evidence.petBeforeOff = await renderer.eval(`ipcRenderer.invoke('hub-pet:debug',{op:'state'}).then(x=>x.lastSent.bubble?.title)`);
    assert.equal(evidence.petBeforeOff, 'Before off');
    await choose('off');
    evidence.petAfterOff = await renderer.eval(`ipcRenderer.invoke('hub-pet:debug',{op:'state'}).then(x=>({bubble:x.lastSent.bubble,dots:x.lastSent.dots}))`);
    assert.equal(evidence.petAfterOff.bubble, null);
    assert.equal(evidence.petAfterOff.dots, 1);
    await shot('桌宠旧气泡收起-1440');
    evidence.visibleWindows = await main.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().filter(w=>w.isVisible()).length`);
    assert.equal(evidence.visibleWindows, 0, 'The isolated verification must not show any test window');
    await shot('关闭仍保留要紧提醒-1440');
    console.log(JSON.stringify(evidence));
  } catch (error) {
    evidence.error = error.stack;
    throw error;
  } finally {
    // Stop the pet and its hidden owner before the launcher's main-page close.
    // Otherwise that auxiliary owner can keep an isolated test process alive.
    await renderer?.eval(`ipcRenderer.invoke('hub-pet:set-settings',{enabled:false})`).catch(() => {});
    main?.close(); renderer?.close();
    try {
      if (hub) evidence.teardown = await gracefulQuit(hub);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (error) { evidence.teardownError = error.message; throw error; }
    finally { fs.writeFileSync(path.join(output, 'notification-e2e.json'), JSON.stringify(evidence, null, 2)); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
