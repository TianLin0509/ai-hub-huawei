'use strict';
// Local-only Electron/Hub acceptance; never connects to an AI provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { launchIsolatedHub, gracefulQuit, buildIsolatedHubEnv } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/web-verification');
function freePort() {
  return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-web-verification-e2e-'));
  const dataDir = path.join(root, 'data');
  let mode = 'challenge', hub, ui, page;
  const report = { providerNetworkTested: false, checks: [], root };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/frame')) {
      res.setHeader('Set-Cookie', 'frame_cookie=kept; Max-Age=3600; Path=/; SameSite=None; Secure');
      res.end('<!doctype html><title>Verification iframe</title><body>Verification frame<script>localStorage.setItem("frame_storage","kept");parent.postMessage({fixture:true,cookie:document.cookie,storage:localStorage.getItem("frame_storage"),webdriver:navigator.webdriver},"*");</script>'); return;
    }
    res.end(`<!doctype html><meta charset="utf-8"><title>${mode === 'challenge' ? 'Just a moment...' : 'Ready'}</title><style>body{font:18px Arial;padding:48px;color:#333}iframe{display:block;width:400px;height:80px}</style><h1>${mode === 'challenge' ? 'Verify you are human' : 'Conversation ready'}</h1><p>Local verification fixture</p><iframe src="http://localhost:${server.address().port}/frame"></iframe><script>
      window.addEventListener('message',e=>{if(e.origin==='http://localhost:${server.address().port}'&&e.data.fixture)window.frameObserved=e.data;});
      window.observed={ua:navigator.userAgent,webdriver:navigator.webdriver,cookie:document.cookie,storage:localStorage.getItem('roundtrip')};
      document.cookie='roundtrip=kept; Max-Age=3600; path=/';localStorage.setItem('roundtrip','kept');
      </script>`);
  });
  // Listen on both loopback names to exercise an actual cross-site iframe.
  await new Promise(resolve => server.listen(0, resolve));
  const fixture = `http://127.0.0.1:${server.address().port}/`;
  async function until(fn, label, timeout = 45000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await sleep(200); }
    throw new Error('Timeout: ' + label);
  }
  async function click(selector) {
    await until(() => ui.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&e.getClientRects().length>0;})()`), 'visible ' + selector);
    await sleep(250);
    const point = await ui.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing element');const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden element');return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await ui.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await ui.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(250);
  }
  const invoke = (channel, payload = {}) => ui.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
  async function shot(name) {
    const image = await ui.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
  }
  async function launch() {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'web-verification', windowMode: 'background',
      entryPath: path.join(__dirname, 'fixtures/web-verification-main.js'),
      extraEnv: { HUB_WEB_SESSIONS_FIXTURE_URL: fixture, CLAUDE_HUB_E2E_FAKE_HOME: '1',
        USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home'),
        APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
        AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces') } });
    ui = await connectFirstPage(hub);
    await until(() => ui.eval(`typeof window.LaunchCenter==='object' && !!document.querySelector('[data-ws-site="deepseek"]')`), 'web UI ready');
    await invoke('verification-test:window', { resize: true });
    await ui.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
  async function connectSite() {
    page = await until(() => connectFirstPage(hub, t => t.type === 'page' && t.url.startsWith(fixture)), 'local webpage target');
    await until(() => page.eval('window.observed'), 'first page script');
  }
  try {
    const probeDir = path.join(root, 'automation-probe');
    fs.mkdirSync(probeDir, { recursive: true });
    await promisify(execFile)(require('electron'), [path.join(__dirname, 'fixtures/web-verification-automation-probe.js')], {
      windowsHide: true, timeout: 55000,
      env: buildIsolatedHubEnv(probeDir, { HUB_WEB_SESSIONS_FIXTURE_URL: fixture }),
    });
    const automation = JSON.parse(fs.readFileSync(path.join(probeDir, 'automation-probe.json'), 'utf8'));
    assert.equal(automation.before, true); assert.equal(automation.after, false);
    report.checks.push('actual production port=0 flag reproduced: webdriver true before, false after');
    await launch();
    // First-use path: no web sessions, account configuration, or cookies pre-seeded.
    await click('#btn-new'); await click('[data-launch-intent="web"]'); await click('[data-ws-site="deepseek"]');
    await connectSite();
    const observed = await page.eval('window.observed');
    const runtime = JSON.parse(fs.readFileSync(path.join(dataDir, 'verification-runtime.json'), 'utf8'));
    assert.equal(observed.webdriver, false); assert.match(observed.ua, new RegExp('Chrome/' + runtime.chrome.replaceAll('.', '\\.')));
    assert.doesNotMatch(observed.ua, /Electron|ai-hub/i);
    report.checks.push('runtime Chrome UA and navigator.webdriver=false on initial document');
    const frame = await until(() => page.eval('window.frameObserved'), 'cross-site frame script');
    assert.equal(frame.webdriver, false); assert.equal(frame.storage, 'kept'); assert.match(frame.cookie, /frame_cookie=kept/);
    report.checks.push('cross-site iframe executed with third-party cookie, localStorage and webdriver=false');
    await until(() => ui.eval(`!document.querySelector('.ws-status').hidden && !!document.querySelector('.ws-status [data-ws-nav="external"]')`), '30-second challenge rescue', 42000);
    const bounds = await invoke('web-sessions:list');
    const banner = await ui.eval(`(()=>{const r=document.querySelector('.ws-status').getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom,width:r.width,text:document.querySelector('.ws-status').innerText};})()`);
    assert.ok(bounds.view.bounds.y >= banner.bottom - 1); assert.ok(banner.width > 600);
    await shot('verification-1440');
    await click('.ws-status [data-ws-nav="external"]');
    assert.ok((await invoke('verification-test:external'))[0].startsWith(fixture));
    report.checks.push('30-second inline banner and one-click system-browser navigation, 1440px screenshot');
    mode = 'ready'; await page.send('Page.reload');
    await until(() => ui.eval(`document.querySelector('.ws-status').hidden`), 'warning clears after verification');
    const items = (await invoke('web-sessions:list')).items;
    const id = items[0].id;
    await invoke('verification-test:flush');
    await page.close(); page = null; await ui.close(); ui = null; await gracefulQuit(hub); hub = null;
    await launch();
    await click('[data-session-days="web"]');
    await until(() => ui.eval(`!!document.querySelector('[data-ws-id="${id}"]')`), 'restored sidebar');
    await click(`[data-ws-id="${id}"]`); await connectSite();
    const restored = await page.eval('window.observed');
    assert.match(restored.cookie, /roundtrip=kept/); assert.equal(restored.storage, 'kept'); assert.equal(restored.webdriver, false);
    await shot('ready-after-restart-1440');
    report.checks.push('persistent cookie and localStorage survive actual isolated Hub restart; normal page has no warning');
    report.ok = true;
  } catch (error) {
    report.ok = false; report.error = error.stack; report.hubLog = hub?.log().slice(-35);
    if (ui) { try { await shot('failure-1440'); } catch {} }
    throw error;
  } finally {
    if (page) await page.close(); if (ui) await ui.close(); if (hub) await gracefulQuit(hub);
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(out, 'e2e-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, error: report.error, out }));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
