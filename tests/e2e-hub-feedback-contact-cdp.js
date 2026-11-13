'use strict';
// Isolated real Hub UI. Cached WeLink identity is synthetic; no feedback is sent.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { Profile } = require('../core/profile/service');
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || '../artifacts/v5620/feedback-ui');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-feedback-ui-'));
  const home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  for (const p of [home, dataDir, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(p, { recursive: true });
  const profile = new Profile({ dataDir });
  profile.setIdentity({ from: 'welink', uid: 'mock.user', name: '示例用户', at: Date.now(), triedAt: Date.now() });
  profile.flush();
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const extraEnv = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
    [pathKey]: [system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';') };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) extraEnv[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const report = { checks: [], screenshots: [], dataDir, realProviderUsed: false, feedbackSent: false, feedbackSendAttempts: 0 };
  let hub, cdp;
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { if (await cdp.eval(expression)) return; } catch {} await sleep(100); }
    throw Error('Timed out: ' + label);
  }
  async function click(selector) {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing element');const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden element');return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function start() {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'feedback-ui', extraEnv });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('!!document.getElementById("options-feedback") && !!window.__hubFeedback', 'feedback menu');
    await cdp.eval(`(()=>{const ipc=require('electron').ipcRenderer;const invoke=ipc.invoke.bind(ipc);window.__feedbackSendAttempts=0;ipc.invoke=(channel,...args)=>{if(channel==='hub-feedback:send'){window.__feedbackSendAttempts++;return Promise.reject(Error('Test forbids outbound feedback'));}return invoke(channel,...args);};})()`);
  }
  async function stop() {
    if (cdp) { try { report.feedbackSendAttempts += await cdp.eval('window.__feedbackSendAttempts || 0'); } catch {} }
    if (hub) { await gracefulQuit(hub); hub = null; }
    if (cdp) { await cdp.close(); cdp = null; }
  }
  async function open() { await click('#btn-options'); await click('#options-feedback'); await until('document.querySelector(".hub-feedback-dialog")?.open', 'feedback dialog'); }
  async function typeContact(value) {
    await click('[data-hf="contact"]');
    await cdp.eval('document.querySelector("[data-hf=contact]").select()');
    if (value) await cdp.send('Input.insertText', { text: value });
    else { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); }
    const file = path.join(dataDir, 'hub-feedback-contact.json');
    const end = Date.now() + 5000;
    while (Date.now() < end) { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).contact === value) return; } catch {} await sleep(50); }
    throw Error('Contact preference was not saved');
  }
  try {
    await start(); await open();
    await until('document.querySelector("[data-hf=contact]").value === "mock.user"', 'cached WeLink prefill');
    report.checks.push('真实反馈入口自动预填模拟 WeLink 登录名，无反馈发送');
    await typeContact('示例联系人');
    await click('[data-hf="cancel"]'); await open();
    assert.equal(await cdp.eval('document.querySelector("[data-hf=contact]").value'), '示例联系人');
    report.checks.push('修改联系方式后取消并重新打开仍保留用户填写');
    await stop(); await start(); await open();
    await until('document.querySelector("[data-hf=contact]").value === "示例联系人"', 'contact after Hub restart');
    report.checks.push('隔离 Hub 完整重启后仍记住联系方式');
    await click('[data-hf="desc"]'); await cdp.send('Input.insertText', { text: '示例：CodeAgent 会话启动后没有显示回答。\n这是隔离界面的模拟反馈，不会发送。' });
    for (const [theme, name] of [['dark', 'feedback-dark-1440.png'], ['codex', 'feedback-light-1440.png']]) {
      await click('[data-hf="cancel"]'); await click('#btn-theme'); await click(`[data-theme-id="${theme}"]`); await open();
      await sleep(150);
      const metrics = await cdp.eval(`(()=>{const d=document.querySelector('.hub-feedback-dialog');return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,theme:document.documentElement.dataset.theme,inputs:[...d.querySelectorAll('textarea,input')].map(e=>({bg:getComputedStyle(e).backgroundColor,fg:getComputedStyle(e).color,value:e.value})),dialog:d.getBoundingClientRect().toJSON()};})()`);
      assert.equal(metrics.width, 1440); assert.equal(metrics.theme, theme); assert.equal(metrics.overflow, false);
      for (const input of metrics.inputs) { assert.notEqual(input.bg, input.fg); if (theme === 'dark') assert.notEqual(input.bg, 'rgb(255, 255, 255)'); }
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(out, name), Buffer.from(capture.data, 'base64'));
      report.screenshots.push({ file: path.join(out, name), ...metrics });
    }
    await typeContact(''); await stop(); await start(); await open();
    await sleep(200);
    assert.equal(await cdp.eval('document.querySelector("[data-hf=contact]").value'), '');
    report.checks.push('主动清空联系方式并重启后保持空白，不再被自动预填覆盖');
    await stop(); await start();
    await cdp.eval(`(()=>{const ipc=require('electron').ipcRenderer;const invoke=ipc.invoke.bind(ipc);let hold=true;ipc.invoke=(channel,...args)=>{if(channel==='hub-feedback:preview'&&hold){hold=false;return invoke(channel,...args).then(snapshot=>new Promise(resolve=>{window.__releaseFeedbackPreview=()=>resolve(snapshot);}));}return invoke(channel,...args);};})()`);
    await open(); await until('typeof window.__releaseFeedbackPreview === "function"', 'deferred preview');
    await typeContact('手动优先');
    await cdp.eval('window.__releaseFeedbackPreview()'); await sleep(150);
    assert.equal(await cdp.eval('document.querySelector("[data-hf=contact]").value'), '手动优先');
    report.checks.push('异步预览晚到时不覆盖用户已手动填写的联系方式');
    assert.equal(report.feedbackSendAttempts + await cdp.eval('window.__feedbackSendAttempts'), 0);
    report.ok = true;
  } finally {
    await stop();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
