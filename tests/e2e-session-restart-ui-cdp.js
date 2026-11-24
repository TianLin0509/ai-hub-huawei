'use strict';
// 右键「重启」当前打开的会话后，聊天框、左栏必须还在，而且仍停在这个会话上（2026-11-18 反馈 5.6.43）。
//
// 以前：重启 = 先休眠再恢复。渲染层收到「已休眠」时把当前会话取消选中，只给主区挂上 home-active 和空状态
// （没走真正的回主页），恢复完成时又因为「当前选中的不是它」不再切回来——主区空白、聊天框和左侧功能栏都没了，
// 切到别处再切回来才正常。
// 这里用替身 Claude CLI（tests/fixtures/fake-claude.ps1）在隔离 Hub 的真实 PTY 里跑，鼠标右键点「重启」，
// 断言：CLI 真的重启了同一个原生会话；重启期间显示「正在唤醒」而不是空白；重启后仍选中它、聊天框可见可输入。
// 不连任何模型。用法：node tests/e2e-session-restart-ui-cdp.js
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/session-restart-ui');
const shotPrefix = process.env.HUB_E2E_SHOT_PREFIX || '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-restart-ui-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const fakeBin = path.join(home, 'fake-bin');
  for (const dir of [home, data, out, fakeBin, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.resolve('tests/fixtures/fake-claude.ps1'), path.join(fakeBin, 'fake-claude.ps1'));
  fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fake-claude.ps1" %*\r\n');
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = {
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
    [pathKey]: [fakeBin, system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
  };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) env[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const report = { checks: [], root };
  const trace = path.join(home, 'fake-claude-trace.log');
  const traceText = () => { try { return fs.readFileSync(trace, 'utf8'); } catch { return ''; } };
  const starts = () => (traceText().match(/SessionStart exit=0/g) || []).length;
  let hub, cdp;
  const until = async (expression, label, timeout = 40000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { try { if (await cdp.eval(expression)) return; } catch {} await sleep(200); }
    throw new Error('Timeout: ' + label);
  };
  async function point(selector) {
    return cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  }
  async function click(selector, button = 'left') {
    const p = await point(selector);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...p });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...p });
  }
  async function shot(name) {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, shotPrefix + name + '.png');
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    return file;
  }
  // 主区「看得见聊天框」：当前会话的输入框挂在终端面板里且有尺寸；左栏也有尺寸。
  const uiState = id => cdp.eval(`(()=>{const q=${JSON.stringify(id)};const bar=document.querySelector('.terminal-panel .floating-input-bar[data-session-id="'+q+'"]');
    const box=bar&&bar.querySelector('.floating-input-box');const r=box&&box.getBoundingClientRect();const side=document.getElementById('session-list');const sr=side&&side.getBoundingClientRect();
    const tp=document.getElementById('terminal-panel');
    return {active:activeSessionId,status:sessions.get(q)?.status,composer:!!(r&&r.width>0&&r.height>0),sidebar:!!(sr&&sr.width>0&&sr.height>0),
      homeActive:!!tp?.classList.contains('home-active'),highlighted:!!document.querySelector('.session-item.selected[data-session-id="'+q+'"]'),pending:!!document.querySelector('.session-resume-pending')};})()`);
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'restart-ui', extraEnv: env });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof ipcRenderer !== "undefined" && typeof sessions !== "undefined" && !!document.querySelector("#home-create-session")', 'renderer ready', 60000);
    // 建会话不是本用例要测的路径，直接走与启动中心同一个 create-session 接口。
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    await cdp.eval(`ipcRenderer.invoke('create-session', ${JSON.stringify({ kind: 'claude', opts: { cwd: project } })})`);
    await until('[...sessions.values()].some(s => s.kind === "claude")', 'Claude session created');
    const id = await cdp.eval('[...sessions.values()].find(s => s.kind === "claude").id');
    const q = JSON.stringify(id);
    for (let i = 0; i < 450 && !starts(); i++) await sleep(200); // 替身 CLI 的 SessionStart 钩子在忙机器上可能要几十秒
    assert.ok(starts() >= 1, 'the CLI ran SessionStart');
    const composer = `.floating-input-bar[data-session-id="${id}"]`;
    await until(`document.querySelector(${JSON.stringify(composer + ' .floating-input-box')})`, 'composer ready');
    await click(composer + ' .floating-input-box');
    await cdp.send('Input.insertText', { text: 'restart e2e hello' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    for (let i = 0; i < 200 && !traceText().includes('Stop exit=0'); i++) await sleep(200);
    await until(`!!sessions.get(${q}).ccSessionId`, 'native session bound');
    const native = await cdp.eval(`sessions.get(${q}).ccSessionId`);
    await sleep(800);
    const before = await uiState(id);
    assert.equal(before.composer, true, 'composer visible before restart');
    report.shotBefore = await shot('01-before-restart');

    // 用户的真实路径：左栏右键当前会话 →「重启」。
    const startsBefore = starts();
    await click(`.session-item[data-session-id="${id}"]`, 'right');
    await until('document.querySelector("#context-menu [data-action=restart]")?.getBoundingClientRect().width > 0', 'context menu');
    // 页面内观察器记录重启中间态（重启很快，轮询抓不到）：是否出现过「正在唤醒」、是否挂过半截主页、是否取消过选中。
    await cdp.eval(`(()=>{const q=${q};const tp=document.getElementById('terminal-panel');window.__restartSeen={pending:false,home:false,deselected:false};
      const check=()=>{const s=window.__restartSeen;if(document.querySelector('.session-resume-pending'))s.pending=true;if(tp.classList.contains('home-active'))s.home=true;if(activeSessionId!==q)s.deselected=true;};
      window.__restartObserver=new MutationObserver(check);window.__restartObserver.observe(tp,{attributes:true,childList:true,subtree:false});return true;})()`);
    await click('#context-menu [data-action="restart"]');
    // 重启过程中（已休眠、尚未恢复）主区应显示「正在唤醒」，不是空白主页。
    const during = [];
    for (let i = 0; i < 150; i++) {
      const s = await uiState(id);
      if (s.status === 'dormant') during.push(s);
      if (s.status !== 'dormant' && starts() > startsBefore) break;
      await sleep(100);
    }
    for (let i = 0; i < 150 && starts() <= startsBefore; i++) await sleep(200);
    assert.ok(starts() > startsBefore, 'the CLI started again after restart');
    await until(`sessions.get(${q})?.status !== 'dormant'`, 'session live again');
    await sleep(1500);
    const after = await uiState(id);
    report.shotAfter = await shot('02-after-restart');
    report.during = during.slice(0, 3);
    report.seen = await cdp.eval('(window.__restartObserver.disconnect(), window.__restartSeen)');
    report.after = after;
    assert.equal(await cdp.eval(`sessions.get(${q}).ccSessionId`), native, 'restart resumed the same native session');
    assert.ok(during.every(s => s.active === id && s.pending && !s.homeActive), 'while restarting the session stays selected with a wake placeholder: ' + JSON.stringify(during.slice(0, 3)));
    assert.deepEqual(report.seen, { pending: true, home: false, deselected: false }, 'during restart: wake placeholder shown, never a half-mounted home, never deselected');
    assert.equal(after.active, id, 'the restarted session is still the selected one');
    assert.equal(after.homeActive, false, 'main area is not left on a half-mounted home');
    assert.equal(after.composer, true, 'composer is visible after restart');
    assert.equal(after.sidebar, true, 'sidebar is visible after restart');
    assert.equal(after.highlighted, true, 'the sidebar row is still highlighted');
    // 聊天框能真的输入、发出去。
    await click(composer + ' .floating-input-box');
    await cdp.send('Input.insertText', { text: 'after restart ok' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    for (let i = 0; i < 150 && !traceText().includes('prompt: after restart ok'); i++) await sleep(200);
    assert.match(traceText(), /prompt: after restart ok/, 'composer still sends prompts to the restarted CLI');
    report.checks.push('Right-click restart keeps the session selected (wake placeholder during restart), resumes the same native session, composer and sidebar visible and the next prompt reaches the CLI');
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    if (cdp) {
      report.failureShot = await shot('failure').catch(() => '');
      fs.writeFileSync(path.join(out, shotPrefix + 'failure-dom.txt'), String(await cdp.eval('document.body.innerText').catch(() => '')));
    }
    throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      try { report.teardown = await gracefulQuit(hub); } catch (error) { report.teardownError = error.stack; }
      fs.writeFileSync(path.join(out, shotPrefix + 'hub.log'), hub.log().join('\n'));
    }
    fs.writeFileSync(path.join(out, shotPrefix + 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: !!report.passed, after: report.after, seen: report.seen, error: report.error && report.error.split('\n')[0] }, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
