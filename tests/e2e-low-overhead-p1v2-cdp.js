'use strict';
// 低开销模式 P1 v2 真实界面验收（2026-11-23）：隔离数据目录 + 空 HOME + 无头隐藏窗口的真实 AI Hub，1440×900。
// 按用户真实操作路径走：底栏点内存 → 内存与进程面板（关闭态、无「省」）→ 点开关开启 → 「省」徽章与保活下拉出现
// → 回车键打开面板 → 设置「资源与后台」顶行同行保活下拉（1440×900、1024×640 都不滚动）→ 改保活数只改保活数
// → 「常用」页原样不滚动、没有新控件 → 重启后界面直接是「开」（Codex R2）→ 在「资源与后台」关掉，徽章消失。
// 用法：node tests/e2e-low-overhead-p1v2-cdp.js（截图写到 HUB_E2E_ARTIFACT_DIR 或 artifacts/low-overhead-p1v2）
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/low-overhead-p1v2');
const SCROLLERS = root => `(()=>{const r=document.querySelector(${JSON.stringify(root)});if(!r)return ['missing ${root}'];return [r,...r.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e);const b=e.getBoundingClientRect();return /(auto|scroll)/.test(s.overflowY)&&b.width>0&&b.height>0&&s.visibility!=='hidden'&&e.scrollHeight>e.clientHeight+2;}).map(e=>(e.id?'#'+e.id:(e.className||e.tagName))+' '+e.scrollHeight+'/'+e.clientHeight);})()`;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub lo p1v2 '));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  for (const dir of [home, data, out, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = {
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
    [pathKey]: [system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
  };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) env[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const report = { checks: [], measures: {}, shots: [] };
  let hub, cdp;
  const until = async (expression, label, timeout = 40000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { try { if (await cdp.eval(expression)) return; } catch {} await sleep(200); }
    throw new Error('Timed out: ' + label);
  };
  async function click(selector) {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function key(name, code) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
  }
  // 原生下拉在无头下展不开：按用户选中某项的效果设值并派发 change。
  const choose = (selector, value) => cdp.eval(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});s.value=${JSON.stringify(String(value))};s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  async function shot(name) {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    report.shots.push(file);
  }
  async function noScroll(label, rootSel) {
    const list = await cdp.eval(SCROLLERS(rootSel));
    report.measures[label] = list;
    assert.deepEqual(list, [], `${label} 出现纵向滚动：${list.join(', ')}`);
  }
  const mainState = () => cdp.eval('require("electron").ipcRenderer.invoke("low-overhead:state")');
  const viewport = (width, height) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  async function launch() {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'low-overhead-p1v2', extraEnv: env, windowMode: 'hidden' });
    cdp = await connectFirstPage(hub);
    await viewport(1440, 900);
    await until('typeof window.__hubOpenConfigModal === "function" && !!window.__hubLowOverhead', 'renderer ready', 60000);
    await until('!!document.querySelector("#sidebar-strip [data-resource-kind=\\"memory\\"]")', 'strip memory metric', 30000);
  }
  async function openSettingsTab(tab) {
    await click('#btn-options');
    await until('document.getElementById("options-settings")?.getBoundingClientRect().width > 0', 'options menu');
    await click('#options-settings');
    await until('!document.getElementById("config-modal").classList.contains("hidden") && !document.getElementById("config-save").disabled', 'settings open');
    await sleep(500);
    await click(`#cfg-tabs [data-cfg-tab-btn="${tab}"]`);
    await sleep(500);
  }

  try {
    await launch();
    // 1. 关闭态（隔离实例按老用户行为：模式关）
    assert.equal((await mainState()).on, false);
    assert.equal(await cdp.eval('!!document.querySelector(".strip-low-overhead")'), false, '关闭态底栏没有「省」');
    await click('#sidebar-strip [data-resource-kind="memory"]');
    await until('!!document.querySelector("[data-mr-lowoverhead]") && !document.querySelector("[data-mr-lowoverhead]").closest("[hidden]")', 'memory panel');
    await sleep(600);
    assert.equal(await cdp.eval('document.querySelector("[data-mr-lo-toggle]").checked'), false);
    assert.equal(await cdp.eval('!!document.querySelector("[data-mr-lo-keep]")'), false, '关闭态不显示保活下拉');
    await shot('20261123-p1v2-1-内存面板-关闭态-无省徽章-1440');
    report.checks.push('内存与进程面板关闭态：开关未勾、无保活下拉、底栏无「省」');

    // 2. 在面板里点开关开启
    await click('[data-mr-lowoverhead] .lo-switch');
    await until('!!document.querySelector("[data-mr-lo-keep]") && !!document.querySelector("#sidebar-strip .strip-low-overhead")', 'low overhead on', 30000);
    const on = await mainState();
    assert.equal(on.on, true); assert.equal(on.enabled, true); assert.equal(on.keepAlive, 2);
    assert.equal(await cdp.eval('document.querySelector("[data-mr-lo-keep]").value'), '2');
    await sleep(400);
    await shot('20261123-p1v2-2-内存面板-开启态-保活下拉与省徽章-1440');
    report.checks.push('面板里点开关：主进程真值 on=true、保活 2；面板出现「保活会话数 2 个」、底栏内存旁出现「省」');
    // 键盘：Esc 关面板，焦点到「省」按回车重新打开
    await key('Escape', 27);
    await until('document.querySelector("[data-mr-lowoverhead]")?.closest("[hidden]") != null || !document.querySelector("[data-mr-lowoverhead]")?.offsetParent', 'panel closed');
    await cdp.eval('document.querySelector("#sidebar-strip .strip-low-overhead").focus()');
    await key('Enter', 13);
    await until('!!document.querySelector("[data-mr-lowoverhead]")?.offsetParent', 'panel reopened by Enter');
    report.checks.push('「省」徽章获得焦点后按回车打开内存面板');
    await key('Escape', 27);
    await sleep(300);

    // 3. 设置「资源与后台」：同行保活下拉，不滚动
    await openSettingsTab('resources');
    await until('!!document.querySelector("#cfg-background-section .bg-head .bg-keep select")', 'bg keep select');
    const sameRow = await cdp.eval('(()=>{const m=document.querySelector("#cfg-background-section .bg-mode").getBoundingClientRect();const k=document.querySelector("#cfg-background-section .bg-keep").getBoundingClientRect();return Math.abs((m.top+m.bottom)/2-(k.top+k.bottom)/2)<6;})()');
    assert.ok(sameRow, '保活下拉与模式开关同一行');
    await noScroll('1440x900-resources-on', '#config-modal');
    await shot('20261123-p1v2-3-设置资源与后台-开启态-同行保活下拉-1440');
    await choose('#cfg-background-section [data-bg="keep"]', 3);
    await until('window.__hubLowOverhead.get().keepAlive === 3', 'keepAlive synced');
    const kept = await mainState();
    assert.deepEqual([kept.on, kept.keepAlive], [true, 3], '只改保活数，模式不变');
    assert.equal(await cdp.eval('window.__hubLowOverhead.get().keepAlive'), 3, '内存面板共享状态同步到 3');
    await viewport(1024, 640);
    await sleep(500);
    await noScroll('1024x640-resources-on', '#config-modal');
    await shot('20261123-p1v2-3b-设置资源与后台-开启态-1024x640');
    await viewport(1440, 900);
    await sleep(400);
    report.checks.push('「资源与后台」开启态：保活下拉与模式开关同一行；1440×900、1024×640 均无纵向滚动；改成 3 个只改保活数');

    // 4. 「常用」原样
    await click('#cfg-tabs [data-cfg-tab-btn="general"]');
    await sleep(500);
    assert.equal(await cdp.eval('!!document.getElementById("cfg-low-overhead-field")'), false, '常用页不加控件');
    await noScroll('1440x900-general', '#config-modal');
    await shot('20261123-p1v2-4-设置常用-原样无滚动-1440');
    await viewport(1024, 640); await sleep(400);
    await noScroll('1024x640-general', '#config-modal');
    await viewport(1440, 900); await sleep(300);
    report.checks.push('「常用」页没有新增控件，1440×900 与 1024×640 均无纵向滚动');
    await click('#config-close');
    await sleep(400);

    // 5. 重启：不碰任何开关，界面直接是「开」（R2）
    await gracefulQuit(hub); hub = null;
    await launch();
    await until('window.__hubLowOverhead.isEnabled() === true && !!document.querySelector("#sidebar-strip .strip-low-overhead")', 'restart shows on', 30000);
    assert.equal(await cdp.eval('window.__hubLowOverhead.get().keepAlive'), 3);
    report.checks.push('重启后不碰开关：界面开关、「省」徽章、保活 3 个与主进程一致');

    // 6. 在「资源与后台」关掉：徽章消失、模式关
    await openSettingsTab('resources');
    await click('#cfg-background-section .bg-mode');
    await until('window.__hubLowOverhead.isEnabled() === false && !document.querySelector("#sidebar-strip .strip-low-overhead")', 'off again', 30000);
    assert.equal((await mainState()).on, false);
    assert.equal(await cdp.eval('!!document.querySelector("#cfg-background-section .bg-keep")'), false, '关闭后同行保活下拉收起');
    report.checks.push('「资源与后台」关闭模式：底栏「省」消失、内存面板共享状态同步为关、保活下拉收起');
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error && error.stack || String(error);
    try { await shot('20261123-p1v2-failure'); } catch {}
  } finally {
    try { if (hub) await gracefulQuit(hub); } catch {}
    fs.writeFileSync(path.join(out, '20261123-p1v2-cdp-report.json'), JSON.stringify(report, null, 2), 'utf8');
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, error: report.error }, null, 2));
  process.exit(report.passed ? 0 : 1);
}

main();
