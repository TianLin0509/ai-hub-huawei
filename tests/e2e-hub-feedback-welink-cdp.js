'use strict';
// 一键反馈 WeLink 模式（2026-11-21）的真实界面验收：隔离 Hub + 假 welink-cli（只把参数记到文件，不发任何消息）。
// 走用户真实路径：设置菜单 → 一键反馈 → 写描述 → 点「一键发到 WeLink」；核对两个按钮、旧「发送」隐藏、收信账号与白名单参数。
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(os.tmpdir(), 'hub-feedback-welink-e2e'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-feedback-wl-'));
  const home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  for (const p of [home, dataDir, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(p, { recursive: true });
  const callLog = path.join(root, 'welink-calls.jsonl');
  const fakeCli = path.join(root, 'welink-cli-fake.js');
  fs.writeFileSync(fakeCli, `const a=process.argv.slice(2);require('fs').appendFileSync(${JSON.stringify(callLog)},JSON.stringify(a)+'\\n');
if(a[0]==='auth')console.log('User Token:   valid\\nUID:          mock.user');else console.log(JSON.stringify({code:0,data:{msgId:'1'}}));`);
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const extraEnv = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
    CLAUDE_HUB_WELINK_CLI: fakeCli, [pathKey]: [system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';') };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) extraEnv[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const report = { checks: [], screenshots: [] };
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
  async function shot(name) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, name); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); report.screenshots.push(file);
  }
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'feedback-welink', extraEnv });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!document.getElementById("options-feedback") && !!window.__hubFeedback', 'feedback menu');
    // 复制按钮会写系统剪贴板、打开 WeLink：本测试不点它，只核对它在。
    await click('#btn-options'); await click('#options-feedback');
    await until('document.querySelector(".hub-feedback-dialog")?.open', 'feedback dialog');
    await until('!document.querySelector("[data-hf=wl-send]").hidden', 'WeLink mode buttons');
    const ui = await cdp.eval(`(()=>{const q=n=>document.querySelector('[data-hf="'+n+'"]');return {to:q('to').textContent,send:q('send').hidden,copy:q('wl-copy').hidden,auto:q('wl-send').hidden,autoText:q('wl-send').textContent,copyText:q('wl-copy').textContent,marker:!!document.getElementById('hub-feedback-outbox-marker')};})()`);
    assert.match(ui.to, /WeLink（账号 l00807938）/);
    assert.deepEqual([ui.send, ui.copy, ui.auto], [true, false, false]);
    report.checks.push(`弹窗标题「${ui.to}」；旧「发送」隐藏；出现「${ui.copyText}」「${ui.autoText}」两个按钮；底栏无待发标记=${!ui.marker}`);
    await click('[data-hf="desc"]'); await cdp.send('Input.insertText', { text: '示例：CodeAgent 会话启动后没有显示回答。（隔离界面测试，假 welink-cli 不发消息）' });
    await shot('20261121-feedback-welink-before-1440.png');
    await click('[data-hf="wl-send"]');
    await until('/已发到维护人的 WeLink/.test(document.querySelector("[data-hf=msg]").textContent)', 'send ok message', 40000);
    await shot('20261121-feedback-welink-sent-1440.png');
    const calls = fs.readFileSync(callLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(a => a[0] === 'im');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 5), ['im', 'send-to-user', '--receiver', 'l00807938', '--text']);
    assert.match(calls[0][5], /CodeAgent 会话启动后没有显示回答/);
    report.checks.push(`点「一键发到 WeLink」后 welink-cli 收到 im send-to-user --receiver l00807938，正文 ${calls[0][5].length} 字；界面提示已发送`);
    await click('[data-hf="cancel"]'); await click('#btn-options'); await click('#options-feedback-mine');
    await until('/已发到维护人 WeLink/.test(document.querySelector("#hub-feedback-mine")?.textContent||"")', 'mine list shows welink');
    report.checks.push('「我的反馈」里这条显示「已发到维护人 WeLink」');
    await shot('20261121-feedback-welink-mine-1440.png');
  } finally {
    if (hub) await gracefulQuit(hub);
    if (cdp) await cdp.close();
    fs.writeFileSync(path.join(out, '20261121-feedback-welink-e2e.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
