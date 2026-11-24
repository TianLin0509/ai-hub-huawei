'use strict';
// R34「只允许 AI 改工作目录内的文件」端到端（2026-11-24）：全新数据目录、隔离 Hub、无头 CDP、替身 Claude CLI。
// 鼠标点选：Claude 显示勾选框与说明、Codex 只显示提示；勾上建会话后本次启动的叠加设置带拦截 hook，用户 settings.json 不动。
// 不连任何 AI 服务。用法：node tests/e2e-workspace-guard-cdp.js（截图与报告写到 HUB_E2E_ARTIFACT_DIR 或 artifacts/workspace-guard-gui）
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/workspace-guard-gui');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub ws guard '));
  const home = path.join(root, 'home dir');
  const data = path.join(root, 'data');
  const fakeBin = path.join(home, 'fake-bin');
  for (const dir of [home, data, out, fakeBin, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.resolve('tests/fixtures/fake-claude.ps1'), path.join(fakeBin, 'fake-claude.ps1'));
  fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fake-claude.ps1" %*\r\n');
  // 替身 Codex（tests/fixtures/fake-codex.ps1）：只记下 Hub 传的启动参数，看权限模式有没有到 CLI。
  fs.copyFileSync(path.resolve('tests/fixtures/fake-codex.ps1'), path.join(fakeBin, 'fake-codex.ps1'));
  fs.writeFileSync(path.join(fakeBin, 'codex.cmd'), '@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fake-codex.ps1" %*\r\n');
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = {
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
    [pathKey]: [fakeBin, system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
  };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) env[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const trace = path.join(home, 'fake-claude-trace.log');
  const traceText = () => { try { return fs.readFileSync(trace, 'utf8'); } catch { return ''; } };
  const modeLines = () => traceText().split(/\r?\n/).filter(line => line.startsWith('permission-mode:'));
  const report = { checks: [], root, providerNetworkTested: false };
  let hub;
  let cdp;
  const until = async (expression, label, timeout = 40000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { try { if (await cdp.eval(expression)) return; } catch {} await sleep(200); }
    throw new Error('Timeout: ' + label);
  };
  const waitFor = async (predicate, label, timeout = 40000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (predicate()) return; await sleep(200); }
    throw new Error('Timeout: ' + label);
  };
  async function click(selector) {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
  }
  async function launch(label) {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label, extraEnv: env });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
  async function quit() {
    if (cdp) await cdp.close().catch(() => {});
    cdp = null;
    if (hub) { report.teardown = await gracefulQuit(hub); fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); }
    hub = null;
  }
  const permSeg = value => `.lcc-seg[data-for="new-session-permission"] [data-lcc-value="${value}"]`;
  const selected = 'document.getElementById("new-session-permission").value';
  async function pickPermission(value) {
    if (await cdp.eval(`!!document.querySelector(${JSON.stringify(permSeg(value))})?.getBoundingClientRect().width`)) { await click(permSeg(value)); return 'segment'; }
    await click('#new-session-permission');
    await until(`!!document.querySelector('.launch-select-option[data-value="${value}"]')`, 'permission dropdown open');
    await click(`.launch-select-option[data-value="${value}"]`);
    return 'dropdown';
  }
  // 2026-11-21 起账号、MCP、权限模式等次要项默认收在「更多选项」里（renderer/launch-more-options.js），先用鼠标点开。
  async function expandMore() {
    if (await cdp.eval('(()=>{const b=document.getElementById("new-session-more-toggle");return !!b&&!b.hidden&&b.getBoundingClientRect().width>0&&b.getAttribute("aria-expanded")!=="true"})()')) await click('#new-session-more-toggle');
  }
  async function openLauncher() {
    if (!(await cdp.eval('document.getElementById("home-create-session")?.getBoundingClientRect().width > 0'))) await click('#btn-home');
    await until('document.getElementById("home-create-session")?.getBoundingClientRect().width > 0', 'home visible');
    await click('#home-create-session');
    await until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', 'launch center open');
    await click('.new-session-option[data-kind="claude"]');
    await until('!document.getElementById("new-session-permission-field").hidden', 'permission field shown for Claude');
    await expandMore();
  }
  const guardNote = 'document.getElementById("new-session-workspace-guard-note").textContent';
  const guardBoxShown = '!document.getElementById("new-session-workspace-guard-field").hidden && document.getElementById("new-session-workspace-guard-field").getBoundingClientRect().width > 0';
  const settingsDir = path.join(data, 'native-agent-settings');
  const guardOverlays = () => { try { return fs.readdirSync(settingsDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(settingsDir, f), 'utf8'))).filter(s => s.hooks && s.hooks.PreToolUse && s.hooks.PreToolUse.some(g => /hub-workspace-guard/.test(JSON.stringify(g)))); } catch { return []; } };
  try {
    await launch('ws-guard');
    await until('[...document.querySelectorAll(".community-provider")].some(e => e.dataset.provider === "claude" && e.dataset.installed === "1") ', 'Claude detected');
    await openLauncher();
    // 1. 全新用户：Claude 显示勾选框，默认不勾，小字说明只是提示
    await until(guardBoxShown, 'guard checkbox visible for Claude');
    assert.equal(await cdp.eval('document.getElementById("new-session-workspace-guard-input").checked'), false);
    assert.match(await cdp.eval(guardNote), /只是提示 AI，拦不住它改别处的文件；重要代码请先提交或备份/);
    await shot('01-claude-unticked');
    // 2. 鼠标勾上：说明换成「已限制只能改工作区内的文件」
    await click('#new-session-workspace-guard-input');
    await until('document.getElementById("new-session-workspace-guard-input").checked', 'ticked');
    assert.match(await cdp.eval(guardNote), /^已限制只能改工作区内的文件/);
    const scrollers = await cdp.eval(`(()=>{const m=document.getElementById('new-session-menu');return [m,...m.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e);return /(auto|scroll)/.test(s.overflowY)&&e.scrollHeight>e.clientHeight+2&&e.getBoundingClientRect().height>0;}).map(e=>(e.id||e.className)+':'+e.scrollHeight+'/'+e.clientHeight);})()`);
    report.launchCenterScrollers = scrollers;
    await shot('02-claude-ticked');
    // 「更多选项」收起时（全新用户的默认样子）再看一次纵向滚动
    if (await cdp.eval('document.getElementById("new-session-more-toggle")?.getAttribute("aria-expanded") === "true"')) await click('#new-session-more-toggle');
    await sleep(300);
    report.collapsedScrollers = await cdp.eval(`(()=>{const m=document.getElementById('new-session-menu');return [m,...m.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e);return /(auto|scroll)/.test(s.overflowY)&&e.scrollHeight>e.clientHeight+2&&e.getBoundingClientRect().height>0;}).map(e=>(e.id||e.className)+':'+e.scrollHeight+'/'+e.clientHeight);})()`);
    await shot('02b-claude-ticked-collapsed');
    // 对照：把这一行藏起来时的高度，看纵向滚动是不是这次加出来的
    report.collapsedWithoutGuard = await cdp.eval(`(()=>{const g=document.getElementById('new-session-workspace-guard');const b=document.querySelector('.session-create-body');const was=g.hidden;g.hidden=true;const h=b.scrollHeight+'/'+b.clientHeight;g.hidden=was;return h;})()`);
    report.checks.push('Claude：勾选框可见、默认不勾；勾上后说明变为「已限制只能改工作区内的文件…」；1440×900 有纵向滚动的区域：' + (scrollers.length ? scrollers.join(', ') : '无'));
    // 3. Codex：没有勾选框，只有一行如实提示
    const kinds = await cdp.eval('[...document.querySelectorAll(".new-session-option[data-kind]")].filter(b => b.getBoundingClientRect().width > 0).map(b => b.dataset.kind)');
    if (kinds.includes('codex')) {
      await click('.new-session-option[data-kind="codex"]');
      await sleep(400);
      assert.equal(await cdp.eval(guardBoxShown), false, 'Codex 不给勾选框');
      assert.match(await cdp.eval(guardNote), /^只是提示 AI，拦不住它改别处的文件/);
      await shot('03-codex-hint');
      report.checks.push('Codex：不给勾选框，只显示「只是提示 AI，拦不住它改别处的文件；重要代码请先提交或备份。」');
      await click('.new-session-option[data-kind="claude"]');
      await until(guardBoxShown, 'back to Claude');
    }
    assert.equal(await cdp.eval('document.getElementById("new-session-workspace-guard-input").checked'), true, '切回 Claude 仍是勾上的');
    // 4. 建会话：本次启动的 --settings 叠加文件里有拦截 hook，会话元数据记下 workspaceGuard
    if (await cdp.eval(`!!document.querySelector('[data-model-card="own"]')?.getBoundingClientRect().width`)) await click('[data-model-card="own"]');
    await click('#new-session-submit');
    await until('[...sessions.values()].some(s => s.kind === "claude")', 'Claude session created');
    const id = await cdp.eval('[...sessions.values()].find(s => s.kind === "claude").id');
    await waitFor(() => guardOverlays().length > 0, 'guard overlay written');
    const overlay = guardOverlays()[0];
    report.overlayMatcher = overlay.hooks.PreToolUse[0].matcher;
    assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(id)}).workspaceGuard`), true);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')) ? /hub-workspace-guard/.test(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')) : false, false, '用户 settings.json 不含拦截');
    report.checks.push('勾上后建 Claude 会话：本次启动的叠加设置里有 PreToolUse 拦截（matcher ' + report.overlayMatcher + '），会话记下 workspaceGuard=true；用户自己的 settings.json 不含拦截');
    // 5. 重开启动中心：记住上次勾选
    await openLauncher();
    await until(guardBoxShown, 'guard visible again');
    assert.equal(await cdp.eval('document.getElementById("new-session-workspace-guard-input").checked'), true);
    report.checks.push('重开启动中心：记住上次勾选');
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    if (cdp) {
      await shot('failure').catch(() => {});
      fs.writeFileSync(path.join(out, 'failure-dom.txt'), String(await cdp.eval('document.body.innerText').catch(() => '')));
    }
    throw error;
  } finally {
    let teardownError;
    try { await quit(); } catch (error) { teardownError = error; report.teardownError = error.stack; report.passed = false; }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (teardownError) throw teardownError;
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
