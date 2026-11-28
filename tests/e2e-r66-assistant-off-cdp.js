'use strict';
// R66-1 真实界面验收（2026-11-28）：隔离数据目录 + 空 HOME + 无头隐藏窗口的真实 AI Hub，1440×900，鼠标键盘操作。
// 路径：助理页输入框问一句（替身 CodeAgent，一直在忙、不调模型）→ 设置「资源与后台」取消勾选「助理」
// → 这一问写明「助理已关闭」、答这一问的后台会话被关掉 → 助理页显示「未开启」（两处开关一致）
// → 在助理页点「开启助理」→「资源与后台」勾上 → 助理页页头点「关闭」→「资源与后台」取消勾选。
// 用法：node tests/e2e-r66-assistant-off-cdp.js（截图与结果（20261128-r66-assistant-off.json）写到 HUB_E2E_ARTIFACT_DIR 或 artifacts/r66-assistant-off）
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/r66-assistant-off');
const repo = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub r66 off '));
  const home = path.join(root, 'home'), data = path.join(root, 'data'), config = path.join(root, 'codeagent-config');
  for (const dir of [home, data, out, config, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const nodeDir = path.dirname(process.execPath);
  const env = {
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
    [pathKey]: [nodeDir, system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
    CLAUDE_HUB_COMPANY_ASSISTANT: '1',
    AI_HUB_CODEAGENT_COMMAND: path.join(repo, 'tests/fixtures/codeagent-busy-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: config,
    AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), BUSY_FAKE_TOOL_MS: '4000',
  };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) env[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const report = { fixture: '真实 Electron 界面 + 鼠标键盘；助理后台会话用替身 CodeAgent（一直在忙，不调用模型、不连公司接口）', checks: [], shots: [] };
  const check = (name, detail = '') => { report.checks.push({ name, ok: true, detail }); console.log('✔', name, detail); };
  let hub, cdp;
  const until = async (expression, label, timeout = 40000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) { try { last = await cdp.eval(expression); if (last) return last; } catch (error) { last = error.message; } await sleep(300); }
    throw new Error('Timed out: ' + label + (last ? ' · last=' + JSON.stringify(last).slice(0, 300) : ''));
  };
  async function click(selector) {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    report.shots.push(file);
  }
  const ipc = (channel, arg) => cdp.eval(`require("electron").ipcRenderer.invoke(${JSON.stringify(channel)}${arg === undefined ? '' : ', ' + JSON.stringify(arg)})`);
  const featureOn = async () => ((await ipc('optional-features:list')) || []).find(f => f.id === 'assistant')?.on;
  async function openResources() {
    await click('#btn-options');
    await until('document.getElementById("options-settings")?.getBoundingClientRect().width > 0', 'options menu');
    await click('#options-settings');
    await until('!document.getElementById("config-modal").classList.contains("hidden") && !document.getElementById("config-save").disabled', 'settings open');
    await sleep(400);
    await click('#cfg-tabs [data-cfg-tab-btn="resources"]');
    await until('!!document.querySelector("#cfg-background-section input[data-bg-id=\\"assistant\\"]")', 'assistant row');
  }
  async function closeSettings() {
    await cdp.eval('document.getElementById("config-cancel")?.click() || document.querySelector("#config-modal .config-close, #config-modal [data-close]")?.click()');
    await until('document.getElementById("config-modal").classList.contains("hidden")', 'settings closed', 10000).catch(async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await until('document.getElementById("config-modal").classList.contains("hidden")', 'settings closed (esc)', 10000);
    });
  }

  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'r66-assistant-off', extraEnv: env, windowMode: 'hidden' });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('document.readyState === "complete" && !!document.getElementById("btn-company-assistant") && !!window.__optionalFeatures', 'renderer ready', 60000);
    assert.equal(await featureOn(), true);

    // 1. 助理页问一句
    await click('#btn-company-assistant');
    await until('!!document.querySelector("#company-assistant-page [data-slot=form] textarea") && document.querySelector("#company-assistant-page .of-gate")?.hidden === true', 'assistant page open');
    await click('#company-assistant-page [data-slot=form] textarea');
    await cdp.send('Input.insertText', { text: '今天下午有哪些会？' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const asked = await until(`require("electron").ipcRenderer.invoke("company-assistant:status").then(s => { const c = (s.chat || []).find(x => x.q === '今天下午有哪些会？'); return c && c.state === 'running' ? c : null; })`, 'question running', 60000);
    // 等助理为这一问起好后台会话
    const before = await until(`require("electron").ipcRenderer.invoke("get-sessions").then(list => { const a = (list || []).filter(s => s.purpose === 'company-assistant'); return a.length ? a.map(s => s.id) : null; })`, 'assistant session created', 60000);
    check('助理页提问后，后台起了助理会话', `${before.length} 个`);
    await sleep(1500);
    await shot('01-asked');

    // 2. 设置「资源与后台」取消勾选助理
    await openResources();
    await shot('02-resources-before');
    await click('#cfg-background-section input[data-bg-id="assistant"]');
    await until(`!document.querySelector('#cfg-background-section input[data-bg-id="assistant"]').checked && !document.querySelector('#cfg-background-section input[data-bg-id="assistant"]').disabled`, 'unchecked');
    assert.equal(await featureOn(), false);
    check('「资源与后台」取消勾选后，主进程记成关');
    await shot('03-resources-off');
    const stopped = await until(`require("electron").ipcRenderer.invoke("company-assistant:status").then(s => { const c = (s.chat || []).find(x => x.id === ${JSON.stringify(asked.id)}); return c && c.state === 'error' && c.stopped ? c : null; })`, 'question stopped', 15000);
    assert.match(stopped.error, /助理已关闭/);
    check('正在答的这一问当场停下并写明原因', stopped.error);
    const left = await until(`require("electron").ipcRenderer.invoke("get-sessions").then(list => { const ids = ${JSON.stringify(before)}; const alive = (list || []).filter(s => ids.includes(s.id)); return alive.length ? null : 'gone'; })`, 'assistant sessions closed', 20000);
    check('答这一问的后台会话被关掉（不再占进程）', left);
    await closeSettings();

    // 3. 亲手关掉的功能按既有设计收起左侧入口（2026-11-18 用户定）；助理页若开着也随之盖上「未开启」
    await until('getComputedStyle(document.getElementById("btn-company-assistant")).display === "none"', 'nav entry hidden', 10000);
    check('关掉后左侧「助理」入口收起（既有设计）');
    await shot('04-nav-hidden');

    // 4. 在「资源与后台」重新勾上 → 入口回来、助理页显示「已开启」
    await openResources();
    await click('#cfg-background-section input[data-bg-id="assistant"]');
    await until(`document.querySelector('#cfg-background-section input[data-bg-id="assistant"]').checked && !document.querySelector('#cfg-background-section input[data-bg-id="assistant"]').disabled`, 'checked again');
    assert.equal(await featureOn(), true);
    await closeSettings();
    await until('getComputedStyle(document.getElementById("btn-company-assistant")).display !== "none"', 'nav entry back', 10000);
    await click('#btn-company-assistant');
    await until('document.querySelector("#company-assistant-page .of-gate")?.hidden === true && /已开启/.test(document.querySelector("#company-assistant-page .of-badge")?.textContent || "")', 'page shows on');
    check('「资源与后台」重新勾上后，助理页同步显示「已开启」');

    // 5. 助理页页头点「关闭」→ 设置里取消勾选
    await click('#btn-company-assistant');
    await until('document.querySelector("#company-assistant-page .of-badge [data-of-gate=off]")?.getBoundingClientRect().width > 0', 'badge off button');
    await click('#company-assistant-page .of-badge [data-of-gate="off"]');
    await until('document.querySelector("#company-assistant-page .of-gate")?.hidden === false', 'page off again');
    assert.equal(await featureOn(), false);
    await openResources();
    assert.equal(await cdp.eval(`document.querySelector('#cfg-background-section input[data-bg-id="assistant"]').checked`), false);
    check('助理页关闭后，「资源与后台」同步取消勾选');
    await shot('05-resources-off-again');
    await closeSettings();
    const after = await ipc('get-sessions');
    const assistantLeft = (after || []).filter(s => s.purpose === 'company-assistant').map(s => s.id);
    assert.deepEqual(assistantLeft, []);
    check('关着时没有任何助理后台会话', '0 个');
    report.ok = true;
  } catch (error) {
    report.ok = false; report.error = error.stack || error.message;
    try { if (cdp) await shot('99-failure'); } catch { /* 截不到图照样报告 */ }
    process.exitCode = 1;
  } finally {
    try { if (hub) await gracefulQuit(hub); } catch (error) { report.quitError = error.message; }
    fs.writeFileSync(path.join(out, '20261128-r66-assistant-off.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(report.ok ? 'E2E OK' : 'E2E FAILED: ' + report.error);
  }
}

main();
