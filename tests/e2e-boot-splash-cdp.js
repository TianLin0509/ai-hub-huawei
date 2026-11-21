'use strict';
// 开场动画（2026-11-22）真实 Hub 端到端：隔离数据目录 + 本地资源源。按用户路径走：
// 第一次启动播群星（带「更换」提示）→ 播完弹提示 → 点提示打开面板 → 用内置 Codex 18 → 下载并使用 DeepSeek 05 →
// 改成每次启动 → 预览后 Esc 跳过 → 重启后播 DeepSeek 05 → 不开测试开关的隔离实例不播。截图写到 HUB_E2E_ARTIFACT_DIR。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'D:/Temp/boot-splash-e2e');
const packs = path.join(root, 'tools', 'boot-splash-packs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const served = [];
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(req.url.split('?')[0]));
    const file = path.join(packs, name);
    served.push(name);
    if (!/^[a-z0-9.-]+\.json$/.test(name) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const dataDir = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'boot-splash-e2e-')), 'data');
  const env = { AI_HUB_BOOT_SPLASH: '1', AI_HUB_BOOT_SPLASH_SOURCES: JSON.stringify([{ id: 'fixture', name: '本地夹具', manifest: base + 'catalog.json', files: base }]) };
  const shots = [];
  let hub, cdp;
  const open = async (extraEnv, label) => {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label, extraEnv });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  };
  const wait = async (expr, ms = 30000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await cdp.eval(expr)) return; await pause(80); }
    throw new Error('等待超时：' + expr);
  };
  const shot = async name => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(output, `${name}.png`); fs.writeFileSync(file, Buffer.from(data, 'base64')); shots.push(file);
  };
  const click = async selector => {
    const pt = await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    assert.ok(pt, '找不到 ' + selector);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pt });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pt });
  };
  const prefs = () => cdp.eval(`require('electron').ipcRenderer.invoke('boot-splash:get').then(s => s.preferences)`);
  try {
    // 1. 全新用户第一次启动：播群星，带「更换」提示
    await open(env, 'boot-splash-1');
    await wait('!!document.getElementById("boot-splash-layer")', 20000);
    assert.ok(await cdp.eval('!!document.querySelector(".boot-splash-hint")'), '播放时要有「点这里更换开场动画」');
    await pause(1500); await shot('01-群星播放中');
    await wait('!document.getElementById("boot-splash-layer")', 8000);
    await wait('!!document.getElementById("boot-splash-toast")', 3000);
    await shot('02-播完提示可更换');
    // 2. 点提示打开面板（一屏放下）
    await click('#boot-splash-toast');
    await wait('!!document.querySelector("#boot-splash-dialog[open] .bsp-card")');
    await pause(300); await shot('03-面板-群星');
    const fit = await cdp.eval('(() => { const c = document.querySelector("#boot-splash-dialog .bsp-content"); return [c.scrollHeight, c.clientHeight]; })()');
    // 3. 用内置 Codex 18
    await click('#boot-splash-dialog [data-tab="codex"]');
    await wait('!!document.querySelector("#boot-splash-dialog [data-use=\\"codex-18\\"]")');
    const fitCodex = await cdp.eval('(() => { const c = document.querySelector("#boot-splash-dialog .bsp-content"); return [c.scrollHeight, c.clientHeight]; })()');
    await shot('04-面板-Codex');
    await click('#boot-splash-dialog [data-use="codex-18"]');
    await wait('document.querySelector("#boot-splash-dialog .appearance-feedback")?.textContent.includes("已换好")');
    assert.equal((await prefs()).selected, 'codex-18');
    // 4. 一键下载并使用 DeepSeek 05
    await click('#boot-splash-dialog [data-tab="deepseek"]');
    await wait('!!document.querySelector("#boot-splash-dialog [data-get=\\"deepseek-05\\"].appearance-btn")');
    await click('#boot-splash-dialog .appearance-btn[data-get="deepseek-05"]');
    await wait('document.querySelector("#boot-splash-dialog .appearance-feedback")?.textContent.includes("已下载并设为开场动画")', 30000);
    assert.equal((await prefs()).selected, 'deepseek-05');
    assert.ok(served.includes('deepseek-05-1.0.0.json'), '应从资源源下载包');
    await shot('05-面板-下载并使用DeepSeek05');
    // 5. 改成每次启动
    await click('#boot-splash-dialog [data-tab="settings"]');
    await wait('!!document.querySelector("#boot-splash-dialog input[value=always]")');
    await click('#boot-splash-dialog input[value=always]');
    await wait(`require('electron').ipcRenderer.invoke('boot-splash:get').then(s => s.preferences.frequency === 'always')`);
    await shot('06-播放设置');
    // 6. 预览后 Esc 跳过
    await click('#boot-splash-dialog .bsp-row [data-preview]');
    await wait('!!document.getElementById("boot-splash-layer")');
    await pause(700); await shot('07-预览DeepSeek05');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait('!document.getElementById("boot-splash-layer")', 1500);
    await gracefulQuit(hub); cdp = null; hub = null;
    // 7. 重启：每次启动 → 播 DeepSeek 05，不再弹首次提示
    await open(env, 'boot-splash-2');
    await wait('!!document.getElementById("boot-splash-layer")', 20000);
    await pause(1600); await shot('08-重启后播DeepSeek05');
    await wait('!document.getElementById("boot-splash-layer")', 8000);
    await pause(400);
    assert.ok(!(await cdp.eval('!!document.getElementById("boot-splash-toast")')), '提示过一次就不再弹');
    await gracefulQuit(hub); cdp = null; hub = null;
    // 8. 不开测试开关的隔离实例不播（不挡其他自动化测试）
    await open({}, 'boot-splash-3');
    await wait('!!document.getElementById("options-boot-splash")', 20000);
    await pause(1500);
    assert.ok(!(await cdp.eval('!!document.getElementById("boot-splash-layer")')), '隔离实例默认不播');
    console.log(JSON.stringify({ ok: true, fit, fitCodex, shots }, null, 1));
  } finally {
    if (hub) await gracefulQuit(hub).catch(() => {});
    server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
