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
// 原作视频不进仓库：从仓库外的目录取（没有就跳过原作那一段）。
const videoPacks = process.env.BOOT_SPLASH_VIDEO_DIR || path.resolve(root, '..', 'video-packs');
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
    const file = path.join(name.endsWith('.mp4') ? videoPacks : packs, name);
    served.push(name);
    if (!/^[a-z0-9.-]+\.(json|mp4)$/.test(name) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': name.endsWith('.mp4') ? 'video/mp4' : 'application/json', 'content-length': body.length }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const dataDir = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'boot-splash-e2e-')), 'data');
  const env = { AI_HUB_BOOT_SPLASH: '1', AI_HUB_OPENX_ONLY: '0', // 本地夹具源：关掉只走内源（R29）
    AI_HUB_BOOT_SPLASH_SOURCES: JSON.stringify([{ id: 'fixture', name: '本地夹具', manifest: base + 'catalog.json', files: base }]) };
  const shots = [];
  let hub, cdp;
  const open = async (extraEnv, label) => {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label, extraEnv, extraArgs: ['--mute-audio'] });
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
    const shape = () => cdp.eval(`require('electron').ipcRenderer.invoke('debug:window-shape')`);
    await wait('document.getElementById("boot-splash-layer")?.dataset.renderer === "worker"');
    assert.notEqual((await shape()).overlay?.symbolColor, '#040405', '播放时保留标题栏按钮的主题颜色');
    assert.ok(await cdp.eval(`(() => { const r = document.getElementById('boot-splash-layer').getBoundingClientRect(); return r.top >= 44 && r.bottom <= innerHeight + 1 && !document.elementFromPoint(innerWidth - 20, 20)?.closest('.boot-splash-layer'); })()`), '动画不覆盖标题栏控制区');
    await pause(1500); await shot('01-群星播放中');
    await wait('!document.getElementById("boot-splash-layer")', 8000);
    await wait('!!document.getElementById("boot-splash-toast")', 3000);
    assert.notEqual((await shape()).overlay?.symbolColor, '#040405', '播完窗口按钮还原成主题颜色');
    await shot('02-播完提示可更换');
    // 2. 点提示打开面板（一屏放下）
    await click('#boot-splash-toast');
    await wait('!!document.querySelector("#boot-splash-dialog[open] .bsp-card")');
    await pause(300); await shot('03-面板-已下载');
    // 打开面板默认停在第一个页签「已下载」：群星·星座 + 三套掌心魔法阵
    assert.equal(await cdp.eval('document.querySelector("#boot-splash-dialog .appearance-tabs button").dataset.tab'), 'mine');
    assert.equal(await cdp.eval('document.querySelector("#boot-splash-dialog [aria-selected=true]").dataset.tab'), 'mine');
    assert.deepEqual(await cdp.eval('[...document.querySelectorAll("#boot-splash-dialog .bsp-card [data-preview]")].filter(b => b.classList.contains("bsp-thumb")).map(b => b.dataset.preview)'),
      ['galaxy-constellation', 'claude-18', 'codex-18', 'deepseek-18']);
    assert.equal((await prefs()).frequency, 'daily', '默认每天第一次启动播放');
    // 「作者推荐」：三家各自 3 秒有声开场（排每家第一）+ 原作/深海
    await click('#boot-splash-dialog [data-tab="picks"]');
    await wait('document.querySelectorAll("#boot-splash-dialog .bsp-grid.mine .bsp-card").length === 6');
    assert.deepEqual(await cdp.eval('[...document.querySelectorAll("#boot-splash-dialog .bsp-grid.mine .bsp-thumb")].map(b => b.dataset.get || b.dataset.preview)'),
      ['claude-omni', 'claude-orig', 'codex-omni', 'codex-orig', 'deepseek-omni', 'deepseek-dive']);
    const fitPicks = await cdp.eval('(() => { const c = document.querySelector("#boot-splash-dialog .bsp-content"); return [c.scrollHeight, c.clientHeight]; })()');
    assert.ok(fitPicks[0] <= fitPicks[1] + 1, '作者推荐 6 张一屏放下：' + fitPicks);
    await shot('03b-作者推荐');
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
    // 5. 播放设置：默认「每天第一次」，改成每次启动
    await click('#boot-splash-dialog [data-tab="settings"]');
    await wait('!!document.querySelector("#boot-splash-dialog input[value=daily]:checked")');
    await click('#boot-splash-dialog input[value=always]');
    await wait(`require('electron').ipcRenderer.invoke('boot-splash:get').then(s => s.preferences.frequency === 'always')`);
    await shot('06-播放设置');
    // 6. 预览后 Esc 跳过
    await click('#boot-splash-dialog .bsp-row [data-preview]');
    await wait('!!document.getElementById("boot-splash-layer")');
    assert.ok(!(await cdp.eval('document.getElementById("boot-splash-dialog").open')), '预览时面板先收起，不挡动画');
    await pause(700); await shot('07-预览DeepSeek05');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait('!document.getElementById("boot-splash-layer")', 1500);
    await wait('document.getElementById("boot-splash-dialog").open', 1500);
    await pause(300); await shot('07b-预览完面板回来');
    // 已下载页签里多了刚下的 DeepSeek 05
    await click('#boot-splash-dialog [data-tab="mine"]');
    await wait('!!document.querySelector("#boot-splash-dialog .bsp-grid.mine [data-preview=\\"deepseek-05\\"]")');
    await shot('07c-已下载多了DeepSeek05');
    // 6b. 原作视频：Claude 页签第一张是「原作」，一键下载并使用，预览时视频真的在走
    const hasVideo = fs.existsSync(videoPacks) && fs.readdirSync(videoPacks).some(f => f.startsWith('claude-orig-'));
    if (hasVideo) {
      await click('#boot-splash-dialog [data-tab="claude"]');
      await wait('document.querySelector("#boot-splash-dialog .bsp-grid .bsp-card")?.classList.contains("orig")');
      await shot('07d-Claude页签原作在前');
      await click('#boot-splash-dialog .appearance-btn[data-get="claude-orig"]');
      await wait('document.querySelector("#boot-splash-dialog .appearance-feedback")?.textContent.includes("已下载并设为开场动画")', 60000);
      assert.equal((await prefs()).selected, 'claude-orig');
      await click('#boot-splash-dialog .appearance-btn[data-preview="claude-orig"]');
      await wait('(document.querySelector("#boot-splash-layer video")?.currentTime || 0) > 7.5', 15000);
      assert.equal(await cdp.eval('document.querySelector("#boot-splash-layer video").muted'), false, '原作带原声');
      // 片段直接从「I am Claude」前（7.5 秒）起播；字幕照原作出现
      await wait('(document.querySelector("#boot-splash-layer video")?.currentTime || 0) > 9.3', 15000);
      assert.equal(await cdp.eval('document.querySelector("#boot-splash-layer .boot-splash-sub").textContent'), 'I am Claude. Ask me anything.');
      assert.ok(Number(await cdp.eval('getComputedStyle(document.querySelector("#boot-splash-layer .boot-splash-sub")).opacity')) > 0.9, '字幕看得见');
      assert.ok(Number(await cdp.eval('getComputedStyle(document.querySelector("#boot-splash-layer .boot-splash-brand")).opacity')) > 0.9, 'AI HUB 角标叠在原作画面上');
      await shot('07e-原作预览中-字幕');
      // 片段到 11 秒左右淡出结束，面板回来（不播到 22 秒，后面不再接别的）
      await wait('!document.getElementById("boot-splash-layer")', 4000);
      await wait('document.getElementById("boot-splash-dialog").open', 1500);
      await click('#boot-splash-dialog .appearance-btn[data-preview="claude-orig"]');
      await wait('(document.querySelector("#boot-splash-layer video")?.currentTime || 0) > 7.6', 15000);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await wait('!document.getElementById("boot-splash-layer")', 2000);
      await wait('document.getElementById("boot-splash-dialog").open', 1500);
    }
    await gracefulQuit(hub); cdp = null; hub = null;
    // 7. 重启：改成了每次启动 → 播 DeepSeek 05，不再弹首次提示
    await open(env, 'boot-splash-2');
    await wait('!!document.getElementById("boot-splash-layer")', 20000);
    if (hasVideo) {
      await wait('(document.querySelector("#boot-splash-layer video")?.currentTime || 0) > 8', 20000);
      await shot('08-重启后播原作');
      await click('#boot-splash-layer');
    } else { await pause(1600); await shot('08-重启后播DeepSeek05'); }
    await wait('!document.getElementById("boot-splash-layer")', 8000);
    await pause(400);
    assert.ok(!(await cdp.eval('!!document.getElementById("boot-splash-toast")')), '提示过一次就不再弹');
    await gracefulQuit(hub); cdp = null; hub = null;
    // 8. 不开测试开关的隔离实例不播（不挡其他自动化测试）
    await open({}, 'boot-splash-3');
    await wait('!!document.getElementById("options-boot-splash")', 20000);
    await pause(1500);
    assert.ok(!(await cdp.eval('!!document.getElementById("boot-splash-layer")')), '隔离实例默认不播');
    // 9. 设置 → 外观与输入：频率直接可见，关掉自动播放后仍可重播，Esc 回到原页签。
    await click('#btn-options');
    await wait('document.getElementById("options-settings").getBoundingClientRect().width > 0');
    await click('#options-settings');
    await wait('!document.getElementById("config-modal").classList.contains("hidden")');
    await click('#cfg-tab-display');
    await wait('!document.getElementById("cfg-boot-splash-frequency").disabled');
    assert.equal(await cdp.eval('document.getElementById("cfg-boot-splash-frequency").value'), 'always', '沿用已保存的频率');
    assert.ok(await cdp.eval('!!document.querySelector("#cfg-boot-splash-label .field-hint-icon[aria-label]")'), '说明用 ⓘ');
    // 同时检查桌面与公司笔记本的小分辨率，频率行不挤出横向滚动。
    for (const [width, height] of [[1440, 900], [1024, 640]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await pause(150);
      const overflow = await cdp.eval(`(() => { const view = document.getElementById('config-main-view'); const row = document.querySelector('.cfg-boot-splash-row'); return [view.scrollHeight - view.clientHeight, row.scrollWidth - row.clientWidth]; })()`);
      await shot(`09-设置外观-${width}x${height}`);
      assert.ok(overflow.every(n => n <= 2), `外观页一屏且不横向溢出 ${width}×${height}: ${overflow}`);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.eval(`(() => { const s = document.getElementById('cfg-boot-splash-frequency'); s.value = 'off'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(`require('electron').ipcRenderer.invoke('boot-splash:get').then(s => s.preferences.frequency === 'off')`);
    const beforeReplay = await prefs();
    await click('#cfg-boot-splash-play');
    await wait('!!document.getElementById("boot-splash-layer")');
    await shot('10-设置手动重播');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait('!document.getElementById("boot-splash-layer")', 2000);
    assert.deepEqual(await prefs(), beforeReplay, '重播不改变频率、当前款式、日期或首次提示');
    assert.equal(await cdp.eval('window.__hubSettingsTabs.active'), 'display');
    await click('#cfg-boot-splash-picker');
    await wait('document.getElementById("boot-splash-dialog").open');
    await click('#boot-splash-dialog [data-action="close"]');
    await gracefulQuit(hub); cdp = null; hub = null;
    await open(env, 'boot-splash-off');
    await wait('!!document.getElementById("cfg-boot-splash-frequency") && !document.getElementById("cfg-boot-splash-frequency").disabled');
    assert.equal((await prefs()).frequency, 'off');
    assert.ok(!(await cdp.eval('!!document.getElementById("boot-splash-layer")')), '关闭频率在重启后保留，不自动播放');
    console.log(JSON.stringify({ ok: true, fit, fitCodex, shots }, null, 1));
  } finally {
    if (hub) await gracefulQuit(hub).catch(() => {});
    server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
