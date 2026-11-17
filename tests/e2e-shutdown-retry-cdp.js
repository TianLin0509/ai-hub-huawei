'use strict';
// Real Electron close refusal, retryable update IPC, then a clean second close.
// Uses only temporary Hub state; no update package is applied.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
async function waitFor(check, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await check()) return; await pause(100); }
  throw Error('Timed out: ' + label);
}
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shutdown-retry-'));
  const resources = path.join(root, 'resources');
  fs.mkdirSync(resources);
  fs.writeFileSync(path.join(resources, 'app.asar'), 'isolated-test-install');
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'hub-pet.json'), JSON.stringify({ enabled: true, optInV: 1 }));
  let hub, c;
  const results = [];
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), entryPath: path.join(__dirname, 'fixtures', 'shutdown-retry-entry.js'),
      windowMode: 'hidden', label: 'shutdown-retry', extraEnv: {
        AI_HUB_UPDATE_RESOURCES: resources, AI_HUB_UPDATE_FORCE_APPLY: '1', AI_HUB_UPDATE_STARTUP_DELAY_MS: '3600000',
        CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0',
        HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      } });
    c = await connectFirstPage(hub);
    const queryUpdate = `require('electron').ipcRenderer.invoke('app-update:apply', {mode:'cancel'})`;
    const initial = await c.eval(queryUpdate);
    assert.ok(initial && typeof initial.phase === 'string');
    results.push('更新 IPC 首次可读');
    const probe = `require('electron').ipcRenderer.invoke('test:shutdown-retry:state')`;
    await waitFor(async () => (await c.eval(probe)).petActive, 'pet enabled');
    const services = await c.eval(probe);
    await c.eval(`window.__shutdownRetryBlock = e => { e.returnValue = false; }; window.addEventListener('beforeunload', window.__shutdownRetryBlock); require('electron').ipcRenderer.send('test:shutdown-retry:quit'); true`);
    await waitFor(() => hub.log().some(line => /已取消退出|close was cancelled/.test(line)), 'renderer refused close');
    assert.ok(hub.isAlive());
    results.push('真实 beforeunload 拒绝后保留窗口');
    const after = await c.eval(probe);
    assert.equal(after.proxyStops, services.proxyStops);
    assert.equal(after.petActive, true);
    assert.equal(after.petWindowId, services.petWindowId);
    results.push('app.quit 取消后代理未停止，桌宠原窗口仍在');
    const retry = await c.eval(queryUpdate);
    assert.equal(retry.phase, initial.phase);
    results.push('拒绝关闭后更新 IPC 仍可读，数据库没有提前关闭');
    await c.eval(`window.removeEventListener('beforeunload', window.__shutdownRetryBlock); require('electron').ipcRenderer.send('test:shutdown-retry:quit'); true`).catch(error => {
      if (!/socket closed|target|detached/i.test(error.message)) throw error;
    });
    await waitFor(() => !hub.isAlive(), 'second close finished');
    assert.equal(hub.exitCode(), 0);
    assert.equal(hub.exitSignal(), null);
    results.push('解除未保存拦截后二次关闭，真实进程干净退出');
    console.log(JSON.stringify({ ok: true, pass: results.length, results, root }));
  } catch (error) {
    console.error(error.stack);
    console.error(hub?.log().slice(-35).join('\n') || 'no Hub log');
    process.exitCode = 1;
  } finally {
    if (c) {
      await c.eval(`window.removeEventListener('beforeunload', window.__shutdownRetryBlock)`).catch(() => {});
      await c.close().catch(() => {});
    }
    if (hub?.isAlive()) await gracefulQuit(hub).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
