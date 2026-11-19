'use strict';
// WeLink 扫码登录可靠性（2026-11-19，反馈 15d0af6b / 00408358）真实界面回归：
// 隔离 Hub（全新 data 目录、无头）+ welink-cli 替身（tests/fixtures/welink-cli-standin.js，失败原文取自黄区真机 1.0.20），
// 真实鼠标点击走「扫码登录 → 失败原因 → 重新获取 → 成功 → 设置里退出登录」。不连公司网络、不调模型。
// 用法：node tests/e2e-welink-login-20261119-cdp.js <截图目录> [标签]
//   HUB_E2E_ELECTRON 指向 electron.exe（worktree 没有 node_modules 时借成员库的），NODE_PATH 同理。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..'), OUT = path.resolve(process.argv[2] || 'artifacts/welink-login-20261119'), TAG = process.argv[3] || 'after';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-login-c-')), dataDir = path.join(root, 'data'), stdin = path.join(root, 'standin');
  for (const d of [path.join(dataDir, 'company-assistant'), stdin, OUT]) fs.mkdirSync(d, { recursive: true });
  const stateFile = path.join(stdin, 'state'), modeFile = path.join(stdin, 'welink-login-mode');
  fs.writeFileSync(stateFile, 'expired');
  // 替身要旁边有 welink-login-qr.json（成员库没带）：复制替身到临时目录，配一份合成的 25×25 图样（只为界面显示，不可扫）。
  const cli = path.join(stdin, 'welink-cli-standin.js');
  fs.copyFileSync(path.join(REPO, 'tests/fixtures/welink-cli-standin.js'), cli);
  const size = 25, rows = Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => {
    const finder = (fx, fy) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7 && (x === fx || x === fx + 6 || y === fy || y === fy + 6 || (x >= fx + 2 && x <= fx + 4 && y >= fy + 2 && y <= fy + 4));
    if ([[0, 0], [size - 7, 0], [0, size - 7]].some(([fx, fy]) => x >= fx - 1 && x <= fx + 7 && y >= fy - 1 && y <= fy + 7)) return [[0, 0], [size - 7, 0], [0, size - 7]].some(([fx, fy]) => finder(fx, fy)) ? '1' : '0';
    return (x * 7 + y * 13 + x * y) % 3 === 0 ? '1' : '0';
  }).join(''));
  fs.writeFileSync(path.join(stdin, 'welink-login-qr.json'), JSON.stringify({ size, rows, url: 'https://welink.standin.invalid/qrcode/login?uuid=standin-20261119' }));
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: true, forum: false }));
  const result = { provenance: '真实隔离 Hub + CDP 鼠标 + welink-cli 替身（合成输出，原文取自真机 1.0.20 字符串）；非公司环境', tag: TAG, checks: [], shots: [], notes: [] };
  const save = () => fs.writeFileSync(path.join(OUT, `20261119-welink-login-${TAG}-c.json`), JSON.stringify(result, null, 2));
  let hub, c;
  const wait = async (expr, label, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(250); } throw new Error('timeout: ' + label + ' | ' + await c.eval(`document.querySelector('.ca-login')?.innerText || document.querySelector('#company-assistant-page')?.innerText?.slice(0,400) || ''`)); };
  const click = async selector => {
    await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled&&e.getBoundingClientRect().width>0})()`, 'clickable ' + selector);
    const xy = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...xy, button: 'left', clickCount: 1 });
  };
  const shot = async name => { const img = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, `20261119-welink-login-${name}-${TAG}-c.png`); fs.writeFileSync(f, Buffer.from(img.data, 'base64')); result.shots.push(f); };
  const vscroll = () => c.eval(`(()=>{const e=document.scrollingElement;return e.scrollHeight>e.clientHeight+2})()`);
  const panelText = () => c.eval(`document.querySelector('.ca-login')?.innerText || ''`);
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir, port: await freePort(), windowMode: 'hidden', label: 'welink-login-c',
      ...(process.env.HUB_E2E_ELECTRON ? { executablePath: process.env.HUB_E2E_ELECTRON } : {}),
      extraEnv: { CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
        CLAUDE_HUB_WELINK_CLI: cli, WELINK_STANDIN_STATE: stateFile,
        CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'),
        ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}) } });
    c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait(`!!document.getElementById('btn-company-assistant')`, 'assistant nav', 60000);
    await click('#btn-company-assistant');
    await sleep(1000);
    await c.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='开启助理'&&x.getBoundingClientRect().width);if(b)b.click();})()`);
    await wait(`!!document.querySelector('#company-assistant-page [data-ca="login"]')`, 'login button', 60000);

    // 1. 扫码后本机 WeLink 桌面端没开
    fs.writeFileSync(modeFile, 'pc-missing scan=2500');
    await click('#company-assistant-page [data-ca="login"]');
    await wait(`!!document.querySelector('.ca-login .ca-qr')`, 'QR shown');
    await shot('01-qr');
    await wait(`(document.querySelector('.ca-login')?.innerText||'').includes('登录没成功')`, 'pc-missing failure', 30000);
    await sleep(600);
    const t1 = await panelText();
    result.notes.push({ step: 'pc-missing', text: t1 });
    await shot('02-pc-missing');
    if (TAG !== 'after') {
      // 改前基线：同样的「要二维码卡住后失败」，看旧面板怎么说。
      fs.writeFileSync(modeFile, 'qr-fail=4000');
      await click('.ca-login [data-ca="login"]');
      await sleep(1500);
      await shot('04-qr-pending');
      await wait(`(document.querySelector('.ca-login')?.innerText||'').includes('登录没成功')`, 'before qr-fail', 30000);
      await sleep(400);
      result.notes.push({ step: 'qr-fail', text: await panelText() });
      await shot('05-qr-request-failed');
    } else {
      assert.match(t1, /WeLink 桌面端没开/); assert.match(t1, /打开这台电脑上的 WeLink 桌面端/); assert.match(t1, /原文：.*WeLink PC/);
      assert.equal(await vscroll(), false, '1440×900 无纵向滚动');
      result.checks.push('扫码后桌面端没开：写明原因和下一步、附原文，按钮「重新获取二维码」');

      // 2. 登录在另一台电脑（服务器不回 sign/nonce）
      fs.writeFileSync(modeFile, 'other-device scan=1500');
      await click('.ca-login [data-ca="login-retry"]');
      await wait(`(document.querySelector('.ca-login')?.innerText||'').includes('另一台电脑')`, 'other-device failure', 30000);
      await sleep(400);
      result.notes.push({ step: 'other-device', text: await panelText() });
      await shot('03-other-device');
      result.checks.push('服务器没回 sign/nonce：提示多半是 WeLink 登录在另一台电脑、同一时间只能一台');

      // 3. 要二维码卡住后失败（「点了扫码不弹二维码」）
      fs.writeFileSync(modeFile, 'qr-fail=8000');
      await click('.ca-login [data-ca="login-retry"]');
      await wait(`(document.querySelector('.ca-login')?.innerText||'').includes('正在向 WeLink 服务器要二维码')`, 'obtaining state', 15000);
      assert.ok(await c.eval(`!!document.querySelector('.ca-login [data-ca="login-retry"]')`), '没出码时也有「重新获取」');
      await shot('04-qr-pending');
      await wait(`(document.querySelector('.ca-login')?.innerText||'').includes('没能从 WeLink 服务器拿到二维码')`, 'qr-request failure', 30000);
      await sleep(400);
      result.notes.push({ step: 'qr-fail', text: await panelText() });
      await shot('05-qr-request-failed');
      result.checks.push('二维码迟迟不出：显示「正在要二维码」+「还没出来？重新获取」；失败后说明多半是网络/代理');

      // 4. 安全说明展开
      await click('.ca-login .ca-login-safety summary');
      await sleep(2500); // 等几轮状态刷新重画面板：展开状态要保持住
      assert.equal(await c.eval(`document.querySelector('.ca-login .ca-login-safety')?.open`), true, '重画后仍展开');
      assert.match(await panelText(), /credentials\.json/);
      result.notes.push({ step: 'assist-buttons', rects: await c.eval(`[...document.querySelectorAll('.ca-login .hub-err-assist-host button')].map(b=>{const r=b.getBoundingClientRect();return {t:b.textContent,w:r.width,h:r.height,x:r.x,y:r.y}})`) });
      assert.equal(await vscroll(), false, '展开说明后 1440×900 仍无纵向滚动');
      await shot('06-safety-note');
      result.checks.push('扫码安全说明：授权给谁、Hub 用它做什么、凭据存哪、怎么撤销、同一时间只能一台');

      // 5. 正常扫码成功 → 设置里退出登录
      fs.writeFileSync(modeFile, 'scan=1500');
      await click('.ca-login [data-ca="login-retry"]');
      await wait(`!document.querySelector('.ca-login')`, 'login ok', 40000);
      await c.eval(`(()=>{const b=document.querySelector('[data-ca="settings-tab:welink"]')||[...document.querySelectorAll('[data-ca]')].find(x=>/^settings/.test(x.dataset.ca));b&&b.click();})()`);
      await wait(`!!document.querySelector('[data-ca="welink-logout"]')`, 'logout button', 30000);
      await shot('07-settings-online');
      await click('[data-ca="welink-logout"]');
      await wait(`document.querySelector('[data-ca="welink-logout"]')?.textContent.includes('再点一次')`, 'logout armed');
      await click('[data-ca="welink-logout"]');
      await wait(`(document.querySelector('#company-assistant-page')?.innerText||'').includes('已退出 WeLink 登录')`, 'signed out', 30000);
      await sleep(400);
      await shot('08-signed-out');
      assert.equal(fs.readFileSync(stateFile, 'utf8'), 'expired', '替身凭据已清除');
      const st = await c.eval(`require('electron').ipcRenderer.invoke('company-assistant:status',{})`);
      assert.equal(st.auth.state, 'signed-out');
      result.checks.push('设置里「退出 WeLink 登录」两次确认后清掉凭据，状态显示「已退出」，自动续期停');
    }
    result.passed = true;
  } catch (error) { result.error = String(error.stack || error) + (error.logTail ? '\n--- hub log ---\n' + error.logTail : ''); process.exitCode = 1; }
  finally { save(); try { c?.close?.(); } catch {} if (hub) await gracefulQuit(hub).catch(() => {}); console.log(JSON.stringify({ passed: !!result.passed, error: result.error, shots: result.shots.length, checks: result.checks }, null, 1)); }
})();
