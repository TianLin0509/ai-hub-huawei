'use strict';
// 两个发行版用真实 Main/renderer/IPC，在隐藏的隔离 Hub 中点击设置 → 检查更新。
// 外网清单使用本地夹具；公开版内源探测使用实际网络（公司外通常为连接失败）。不下载、不调用模型。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'D:/Temp/r55-e2e');
const publicRoot = process.argv[process.argv.indexOf('--public-root') + 1];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function runEdition(entryPath, edition) {
  const version = JSON.parse(fs.readFileSync(path.join(entryPath, 'package.json'), 'utf8')).version;
  const manifest = { schema: 1, product: 'Hub', version, notes: [], runtime: { electron: '41.2.0', native: {} },
    installer: { file: 'fixture.exe', bytes: 50000, sha256: 'a'.repeat(64) } };
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(manifest)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  let hub, cdp;
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(output, `${edition}-${Date.now()}`, 'data'), port: await freePort(),
      entryPath, cwd: entryPath, windowMode: 'hidden', label: 'update-sources-' + edition,
      extraEnv: { AI_HUB_UPDATE_SOURCES: JSON.stringify([{ id: 'fixture', name: '外网源（本地夹具）', manifest: address + '/latest.json', files: address + '/v{version}/' }]) } });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const wait = async expr => {
      const until = Date.now() + 30000;
      while (Date.now() < until) { if (await cdp.eval(expr)) return; await pause(150); }
      throw new Error('等待超时：' + expr);
    };
    await wait('!!document.getElementById("options-check-update")');
    await cdp.eval('document.querySelectorAll("dialog[open]").forEach(d => d.close())');
    async function click(selector) {
      const pt = await cdp.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pt });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pt });
    }
    await click('#btn-options');
    await click('#options-check-update');
    await wait('document.querySelector(".app-update-dialog[open] [data-source=openx]")');
    const evidence = await cdp.eval(`(() => { const d=document.querySelector('.app-update-dialog[open]'); const row=d.querySelector('[data-source=openx]'); return { subtitle:d.querySelector('.au-title span').textContent, first:d.querySelector('.au-sources li').dataset.source, row:row.textContent, color:getComputedStyle(row.querySelector('.au-st')).color, phase:window.__appUpdate.state().phase, edition:window.__appUpdate.state().sourceEdition, viewport:innerWidth, pid:null }; })()`);
    assert.equal(evidence.first, 'openx');
    assert.equal(evidence.viewport, 1440);
    // R35：副标题不再带「公开版 / 成员版」；更新窗只有一行「公司内源」，文案见 core/app-update/source-view.js internalLine。
    assert.ok(evidence.subtitle.endsWith('内测先锋版'), evidence.subtitle);
    assert.ok(evidence.row.startsWith('公司内源'), evidence.row);
    assert.match(evidence.row, /可用，最新 v|连不上公司内源|缺包：|公司内源上暂时没有|内源已关闭|未生效/);
    assert.equal(await cdp.eval(`document.querySelectorAll('.app-update-dialog[open] .au-sources li').length`), 1);
    assert.doesNotMatch(await cdp.eval(`document.querySelector('.app-update-dialog[open]').textContent`), /外网源|阿里云|GitHub|放行下载服务器|抢先版/);
    assert.ok(!evidence.row.includes('暂不走内源'));
    evidence.pid = hub.pid;
    evidence.isolation = hub.identityVerified;
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, `20261119-r55-${edition}-update.png`), Buffer.from(screenshot.data, 'base64'));
    await click('[data-au=close]');
    const health = await cdp.eval(`require('electron').ipcRenderer.invoke('env-check:run')`);
    const update = health.items.find(item => item.id === 'app-update');
    assert.match(update.detail, /\n内源（公司内网）：/);
    evidence.health = { status: update.status, detail: update.detail };
    fs.writeFileSync(path.join(output, `20261119-r55-${edition}-evidence.json`), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } finally {
    if (cdp) await cdp.close();
    if (hub) { fs.writeFileSync(path.join(output, `20261119-r55-${edition}-hub.log`), hub.log().join('\n')); await gracefulQuit(hub); }
    await new Promise(resolve => server.close(resolve));
  }
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  await runEdition(root, 'member');
  if (process.argv.includes('--public-root')) await runEdition(path.resolve(publicRoot), 'public');
})().catch(error => { console.error(error.stack, error.logTail || ''); process.exitCode = 1; });
