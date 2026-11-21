'use strict';
// 「设置 → 一键反馈」连点必弹（2026-11-21）：隔离 Hub，真实鼠标事件，点开设置菜单后不等动画、立刻点「一键反馈」，连做 12 次。
// 修之前设置菜单弹入动画放完会整块跳到屏幕正中，点早了落点不在菜单上，9 次里 4 次不弹（tests/unit-options-menu-stable.test.js 说明根因）。
// 另外核对：菜单项在点开后第一帧和 400ms 后位置相同；不发送任何反馈。
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(os.tmpdir(), 'hub-feedback-open-repeat-e2e'));
const ROUNDS = Number(process.env.HUB_FEEDBACK_OPEN_ROUNDS) || 12;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-feedback-open-'));
  const home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  for (const p of [home, dataDir, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(p, { recursive: true });
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const extraEnv = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
    [pathKey]: [system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';') };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) extraEnv[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const report = { rounds: [], screenshot: null, feedbackSendAttempts: 0 };
  let hub, cdp;
  const rect = sel => cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);
  async function press(point) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function until(expression, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { if (await cdp.eval(expression)) return true; } catch {} await sleep(50); }
    return false;
  }
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'feedback-open-repeat', extraEnv });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.ok(await until('!!document.getElementById("options-feedback") && !!window.__hubFeedback', 30000), 'feedback menu entry');
    await cdp.eval(`(()=>{const ipc=require('electron').ipcRenderer;const invoke=ipc.invoke.bind(ipc);window.__feedbackSendAttempts=0;ipc.invoke=(channel,...args)=>{if(channel==='hub-feedback:send'||channel==='hub-feedback:welink-send'){window.__feedbackSendAttempts++;return Promise.reject(Error('Test forbids outbound feedback'));}return invoke(channel,...args);};return true})()`);
    // 位置稳定：点开后第一帧和 400ms 后，「一键反馈」在同一处（修之前动画放完会跳约 120×230px）。
    await press(await rect('#btn-options'));
    const a = await rect('#options-feedback'); await sleep(400); const b = await rect('#options-feedback');
    report.position = { first: a, after400ms: b };
    assert.ok(Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2, `menu item moved after opening: ${JSON.stringify(report.position)}`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.ok(await until('document.getElementById("options-menu").style.display === "none"', 2000), 'Esc closes the menu');
    for (let i = 0; i < ROUNDS; i++) {
      await press(await rect('#btn-options'));
      const first = await rect('#options-feedback');   // 菜单刚出来、动画还没放完
      assert.ok(first, `round ${i}: menu item visible`);
      await press(first);
      const opened = await until('!!document.querySelector(".hub-feedback-dialog")?.open', 4000);
      report.rounds.push({ i, opened });
      assert.ok(opened, `round ${i}: feedback dialog opened`);
      if (i === 0) {
        await sleep(900);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        report.screenshot = path.join(out, '20261121-feedback-open-repeat-1440-rsi-o.png');
        fs.writeFileSync(report.screenshot, Buffer.from(shot.data, 'base64'));
      }
      await press(await rect('[data-hf="cancel"]'));
      assert.ok(await until('!document.querySelector(".hub-feedback-dialog")?.open', 3000), `round ${i}: dialog closed`);
    }
    report.feedbackSendAttempts = await cdp.eval('window.__feedbackSendAttempts');
    assert.equal(report.feedbackSendAttempts, 0);
    report.ok = true;
  } finally {
    if (hub) await gracefulQuit(hub).catch(() => {});
    if (cdp) await cdp.close().catch(() => {});
    fs.writeFileSync(path.join(out, '20261121-feedback-open-repeat-result.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ ok: report.ok, opened: report.rounds.filter(r => r.opened).length, rounds: report.rounds.length, position: report.position, screenshot: report.screenshot }));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
