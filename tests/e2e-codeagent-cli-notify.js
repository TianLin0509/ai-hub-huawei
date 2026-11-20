'use strict';
// CodeAgent 自带完成提醒三档（2026-11-20，用户：Hub 自己有通知或桌宠时才关 CodeAgent 的，用户可改回）的隔离实例验收：
// 全新数据目录（什么都没配），在真实设置界面里切「桌面回执」和「CodeAgent 自带的完成提醒」，每切一次新开一个 CodeAgent 会话，
// 用冒充 codeagent 的小脚本打印 Hub 交给它的 OPENTUI_NOTIFICATIONS，核对：
//   1. 默认（回执交给桌宠/小卡）→ 带 =0（只留 Hub 的）；
//   2. 回执选「关闭」、桌宠没开 → 不带（CodeAgent 自己提醒，免得两边都不提醒）；
//   3. 档位「总是关掉」→ 带 =0；4. 档位「保留」→ 不带。
// 用法：node tests/e2e-codeagent-cli-notify.js [--out <截图目录>] [--baseline]（--baseline 只记录不断言，给改前版本用）
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const fixture = path.join(__dirname, 'fixtures', 'codeagent-env-echo.cmd');
const argOut = process.argv.indexOf('--out');
const out = argOut > 0 ? path.resolve(process.argv[argOut + 1]) : null;
const baseline = process.argv.includes('--baseline');

(async () => {
  if (out) fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-clinotify-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  const hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), label: 'cli-notify', windowMode: 'hidden',
    extraEnv: { AI_HUB_CODEAGENT_COMMAND: fixture, AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'cac'), CLAUDE_HUB_HOME_DIR: path.join(root, 'home'),
      WT_SESSION: '', ...(baseline ? {} : { OPENTUI_NOTIFICATIONS: '', OPENTUI_NOTIFICATION_PROTOCOL: '' }) } });
  const c = await connectFirstPage(hub);
  const ev = { baseline, steps: [] };
  try {
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    for (let i = 0; i < 150 && !(await c.eval('typeof sessions !== "undefined" && typeof selectSession === "function"').catch(() => false)); i++) await sleep(400);
    const shot = async name => { if (!out) return; await sleep(600); fs.writeFileSync(path.join(out, `20261120-clinotify-${baseline ? 'before' : 'after'}-${name}.png`), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
    const sessionEnv = async label => {
      const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work } })})`);
      let raw = '';
      for (let i = 0; i < 180 && !/CODEAGENT-ENV/.test(raw); i++) { await sleep(500); raw = String(await c.eval(`ipcRenderer.invoke('debug:get-session-buffer', ${j(created.id)})`) || ''); }
      const m = raw.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').match(/OPENTUI_NOTIFICATIONS=\[([^\]]*)\]/);
      // cmd 里没设的变量原样回显成 %OPENTUI_NOTIFICATIONS%
      const v = m ? (m[1] === '%OPENTUI_NOTIFICATIONS%' ? '' : m[1]) : null;
      ev.steps.push({ label, OPENTUI_NOTIFICATIONS: v });
      return v;
    };
    const openSettings = async () => {
      await c.eval(`require('electron').ipcRenderer.emit('desktop-notification:open-settings', {}, {})`);
      for (let i = 0; i < 50 && !(await c.eval(`!!document.getElementById('cfg-notify-mode')?.offsetParent`).catch(() => false)); i++) await sleep(300);
      await sleep(800);
      await c.eval(`document.getElementById('cfg-notify-mode-section').scrollIntoView({block:'center'})`);
    };
    const pick = async (id, value) => { await c.eval(`(()=>{const e=document.getElementById(${j(id)});e.value=${j(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(1200); };
    const ui = () => c.eval(`(()=>{const r=document.getElementById('cfg-codeagent-cli-notify-row');const e=document.getElementById('cfg-codeagent-cli-notify');
      return {rowShown: !!(r&&r.offsetParent), control: e?e.tagName+':'+(e.type||''):null, value: e?(e.type==='checkbox'?e.checked:e.value):null,
        note: (document.getElementById('cfg-codeagent-cli-notify-note')||{}).textContent||null, notifyMode: document.getElementById('cfg-notify-mode')?.value}})()`);
    const closeSettings = () => c.eval(`[...document.querySelectorAll('#config-modal button')].filter(b=>b.offsetParent&&/^(取消|关闭|×)$/.test(b.innerText.trim())).forEach(b=>b.click())`);

    // 1. 全新用户，什么都没配
    await openSettings(); ev.ui1 = await ui(); await shot('1-默认'); await closeSettings();
    ev.env1 = await sessionEnv('默认：回执交给桌宠/小卡');
    // 2. 回执关掉、桌宠没开
    await openSettings(); await pick('cfg-notify-mode', 'off'); ev.ui2 = await ui(); await shot('2-回执关闭'); await closeSettings();
    ev.env2 = await sessionEnv('回执关闭、桌宠没开');
    if (!baseline) {
      // 3. 总是关掉
      await openSettings(); await pick('cfg-codeagent-cli-notify', 'hub'); ev.ui3 = await ui(); await shot('3-总是关掉'); await closeSettings();
      ev.env3 = await sessionEnv('档位：总是关掉');
      // 4. 保留，回执恢复默认
      await openSettings(); await pick('cfg-notify-mode', 'pet'); await pick('cfg-codeagent-cli-notify', 'own'); ev.ui4 = await ui(); await shot('4-保留'); await closeSettings();
      ev.env4 = await sessionEnv('档位：保留，回执交给桌宠');
      ev.saved = JSON.parse(fs.readFileSync(path.join(root, 'data', 'codeagent-cli-notify.json'), 'utf8')).mode;
    }
  } finally {
    if (out) fs.writeFileSync(path.join(out, `20261120-clinotify-${baseline ? 'before' : 'after'}-evidence.json`), JSON.stringify(ev, null, 2));
    try { c.close(); } catch {}
    await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch {}
  }
  console.log(JSON.stringify(ev, null, 2));
  if (!baseline) {
    assert.strictEqual(ev.ui1.rowShown, true, '设置里看得到 CodeAgent 那一行');
    assert.strictEqual(ev.ui1.value, 'auto', '全新用户默认自动');
    assert.strictEqual(ev.env1, '0', '默认：Hub 在提醒，关掉 CodeAgent 自己的');
    assert.strictEqual(ev.env2, '', '回执关闭且桌宠没开：留着 CodeAgent 自己的');
    assert.ok(/保留自带提醒/.test(ev.ui2.note), '界面写明现在保留 CodeAgent 自带提醒');
    assert.strictEqual(ev.env3, '0', '总是关掉');
    assert.strictEqual(ev.env4, '', '保留');
    assert.strictEqual(ev.saved, 'own');
    console.log('e2e-codeagent-cli-notify: OK');
  }
  setTimeout(() => process.exit(0), 300);
})().catch(error => { console.error(error); process.exit(1); });
