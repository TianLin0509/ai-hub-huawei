'use strict';

// 鼠标拖选卡片文字后按 Ctrl+C，剪贴板必须拿到选中的文字（右键复制一直正常）。
// 2026-10-26 根因：ToDesk 在用户按 Ctrl+C 后约 0.3 秒把系统剪贴板改回复制前的旧内容。
// 最后两例用另一个进程写剪贴板：「改回旧内容」时 Hub 必须把这次复制写回去；别的程序写入新内容时仍要让位。
// 隔离 Hub + 真实 CDP 鼠标/键盘事件 + 真实系统剪贴板（测前逐格式备份，测完恢复）；不调模型。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ctrlc-'));
const out = process.env.HUB_E2E_ARTIFACT_DIR || path.join(root, 'artifacts');
fs.mkdirSync(out, { recursive: true });
const guard = path.join(__dirname, 'helpers', 'clipboard-guard.ps1');
const backupDir = path.join(root, 'clipboard-backup');
const SENTINEL = 'CTRL_C_SENTINEL';
const NEWER = 'CTRL_C_NEWER_COPY';
const evidence = { root, cases: [], passed: false, model: 'none; real clipboard and UI, simulated external writer' };
const testTexts = new Set([SENTINEL, NEWER]);
let hub, c, backedUp = false;
let hubOutput = '';
const ps = args => execFileSync('powershell.exe', ['-NoProfile', '-STA', '-File', guard, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
async function until(expr) {
  for (let n = 0; n < 120; n++) { if (await c.eval(expr)) return; await sleep(100); }
  throw new Error('timeout: ' + expr);
}
async function mouse(type, x, y, buttons = 1) {
  await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
}
async function ctrlC() {
  for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
  await sleep(250);
}
const readClipboard = () => c.eval("require('electron').clipboard.readText()");
async function dragSelect(selector) {
  const r = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}})()`);
  const y = r.y + Math.min(12, r.h / 2);
  await mouse('mousePressed', r.x + 4, y);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', r.x + 4 + (r.w * 0.6) * i / 6, y);
  await mouse('mouseReleased', r.x + 4 + r.w * 0.6, y, 0);
  await sleep(120);
  const text = await c.eval('String(window.getSelection())');
  testTexts.add(text);
  return text;
}
async function prepare(prep) {
  await c.eval(`require('electron').clipboard.writeText(${JSON.stringify(SENTINEL)})`);
  await c.eval('window.getSelection().removeAllRanges()');
  if (prep) await c.eval(prep);
}
async function runCase(name, prep) {
  await prepare(prep);
  const selected = await dragSelect('#msg-overlay .turn-card.assistant .turn-body p');
  const active = await c.eval("(()=>{const a=document.activeElement;return a?(a.tagName+'.'+a.className):''})()");
  await ctrlC();
  const read = await readClipboard();
  evidence.cases.push({ name, selected, active, read, ok: !!selected && read === selected });
}
// 另一个进程在 Hub 复制成功后约 0.3 秒写剪贴板：value=SENTINEL 是「改回旧内容」，其他是新的复制。
async function runExternalWriteCase(name, value, expectHub) {
  await prepare();
  const beforeRepairs = (hubOutput.match(/\[clipboard\]/g) || []).length;
  const trigger = path.join(root, `${name}.trigger`);
  const writer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
    `$ErrorActionPreference='Stop'; $until=(Get-Date).AddSeconds(20); while(-not (Test-Path '${trigger}')){if((Get-Date)-gt $until){exit 2}; Start-Sleep -Milliseconds 20}; Start-Sleep -Milliseconds 300; Set-Clipboard -Value '${value}'; 'write-submitted:${value}'`], { windowsHide: true });
  let writerOut = ''; writer.stdout.on('data', d => { writerOut += d; });
  const writerDone = new Promise(r => writer.on('exit', r));
  await sleep(1500); // PowerShell 启动
  const selected = await dragSelect('#msg-overlay .turn-card.assistant .turn-body p');
  await ctrlC();
  fs.writeFileSync(trigger, '1');
  const writerExit = await writerDone;
  await sleep(2500); // 等过 Hub 的约 2 秒守护窗口
  const read = await readClipboard();
  const expected = expectHub ? selected : value;
  const repairs = (hubOutput.match(/\[clipboard\]/g) || []).length - beforeRepairs;
  evidence.cases.push({ name, selected, writer: writerOut.trim(), writerExit, repairs, read,
    ok: !!selected && writerExit===0 && writerOut.includes(`write-submitted:${value}`) && read === expected && (!expectHub || repairs>0) });
}
async function main() {
  try {
    evidence.backup = ps(['backup', backupDir]); backedUp = true;
    const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, label: 'ctrl-c', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_E2E_REAL_CLIPBOARD: '1', CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    } });
    hub.child.stdout.on('data', chunk=>{ hubOutput += chunk.toString(); });
    hub.child.stderr.on('data', chunk=>{ hubOutput += chunk.toString(); });
    c = await connectFirstPage(hub);
    await until('!!window.__hubE2E');
    await c.eval("window.__copyResizeEvents=[];window.addEventListener('resize',()=>window.__copyResizeEvents.push([innerWidth,innerHeight]))");
    const before = await c.eval('({width:innerWidth,height:innerHeight})');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    if(before.width!==1400||before.height!==1000) await until('window.__copyResizeEvents.some(v=>v[0]===1400&&v[1]===1000)');
    await c.eval("window.__hubE2E.cardQuestionNavigator.mountFixture({sessionId:'ctrl-c-fixture',count:2,clear:true})");
    await sleep(300);
    await runCase('body-focus', "document.activeElement&&document.activeElement.blur&&document.activeElement.blur()");
    await runCase('composer-focus', "(()=>{const e=document.querySelector('.floating-input-box');if(e)e.focus();})()");
    await runCase('xterm-focus', "(()=>{const e=document.querySelector('.xterm-helper-textarea');if(e)e.focus();})()");
    await runExternalWriteCase('external-revert-to-old', SENTINEL, true);
    await runExternalWriteCase('external-newer-copy-wins', NEWER, false);
    for (const r of evidence.cases) assert.ok(r.ok, `${r.name}: ${JSON.stringify(r)}`);
    evidence.uiChecksPassed = true;
  } catch (error) { evidence.error = error.stack; process.exitCode = 1;
    if(c) {
      evidence.viewport = await c.eval('({width:innerWidth,height:innerHeight,events:window.__copyResizeEvents,ready:!!window.__hubE2E})').catch(()=>null);
      await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(out,'failure.png'),Buffer.from(r.data,'base64'))).catch(e=>{evidence.screenshotError=String(e);});
    } }
  finally {
    if (c) await c.close().catch(error => { evidence.cdpCloseError = String(error); process.exitCode = 1; });
    if (hub) {
      evidence.exit = await gracefulQuit(hub).catch(error => { evidence.quitError = String(error); process.exitCode = 1; });
      fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'),'utf8');
      hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); hub.child.stdin?.destroy();
    }
    if (backedUp) {
      const files = [...testTexts].filter(Boolean).map((text, i) => { const f = path.join(root, `text-${i}.txt`); fs.writeFileSync(f, text, 'utf8'); return f; });
      try { evidence.restore = ps(['restore', backupDir, '-TextFile', files.join(';')]);
        if(evidence.restore.startsWith('RESTORED')) evidence.restoreVerified = ps(['verify', backupDir]); }
      catch (error) { evidence.restoreError = String(error); process.exitCode = 1; }
    }
    evidence.passed = evidence.uiChecksPassed === true && !process.exitCode;
    fs.writeFileSync(path.join(out,'20261104-clipboard-evidence-m3.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence, null, 2));
  }
}
main();
