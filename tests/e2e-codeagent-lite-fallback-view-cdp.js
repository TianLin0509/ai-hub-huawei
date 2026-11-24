'use strict';
// CodeAgent-Lite 改回终端时的界面（2026-11-24 R2）：隔离真实 Electron，按主进程真实发出的两条事件顺序
// （session-suspended[suspendReason=serve-fallback] → 同 ID session-created[openInBackground]）驱动渲染层，检查：
//   A. 用户正看着这个会话：不被踢回首页，显示「正在切换到终端方式…」，新会话到来后原地挂回；
//   B. 用户已切去别的会话：不抢焦点，仍停在原来的会话。
// 事件内容用真实 PowerShell 会话的元数据；不访问真实模型、不改生产数据。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const out = path.resolve(process.env.LITE_PRESET_OUTPUT || 'D:/AI-Artifacts/20261124-lite-guard');
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-fallback-view-')), data = path.join(root, 'data'), work = path.join(root, 'work');
  fs.mkdirSync(data); fs.mkdirSync(work);
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
  const result = { ok: false, checks: [], shots: [], fixture: '隔离 Hub、真实渲染层事件处理；事件按主进程改回终端时的真实顺序注入' };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port, windowMode: 'hidden', label: 'lite-fallback-view', extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const j = JSON.stringify;
    const wait = async (expression, label = expression) => { for (let i = 0; i < 150; i++) { const v = await c.eval(expression); if (v) return v; await sleep(200); } throw Error('等待失败：' + label); };
    const shot = async name => { await sleep(250); const file = path.join(out, `20261124-lite-fallback-${name}-1440x900.png`); fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(file); };
    await wait(`typeof ipcRenderer!=='undefined' && typeof selectSession==='function' && document.readyState==='complete'`, '渲染层就绪');
    const create = async () => {
      const s = await c.eval(`(async()=>{ const s = await ipcRenderer.invoke('create-session', { kind:'powershell', opts:{ cwd:${j(work)} } }); return s && s.id; })()`);
      await wait(`sessions.has(${j(s)})`, '会话出现');
      return s;
    };
    // 主进程改回终端时发出的两条事件（字段取自这个会话的真实元数据）
    const suspend = id => c.eval(`(()=>{ const s = sessions.get(${j(id)}); ipcRenderer.emit('session-suspended', {}, { sessionId:${j(id)}, session:{ ...s, status:'dormant', suspendReason:'serve-fallback', suspendedAt:Date.now() } }); return true; })()`);
    const recreate = id => c.eval(`(()=>{ const s = sessions.get(${j(id)}); ipcRenderer.emit('session-created', {}, { session:{ ...s, status:'idle', suspendReason:null, suspendedAt:null, codeagentRunMode:'pty', openInBackground:true } }); return true; })()`);

    // A. 正看着它
    const a = await create();
    await c.eval(`(async()=>{ await selectSession(${j(a)}); return true; })()`);
    await wait(`activeSessionId===${j(a)}`, 'A 选中');
    await suspend(a);
    await sleep(200);
    result.a = await c.eval(`({ active: activeSessionId, home: terminalPanelEl.classList.contains('home-active'), text: document.querySelector('.session-resume-pending')?.textContent || '' })`);
    assert.equal(result.a.active, a, '没有被踢回首页');
    assert.equal(result.a.home, false);
    assert.match(result.a.text, /正在切换到终端方式/);
    result.checks.push('正看着时：保持选中、显示「正在切换到终端方式…」'); await shot('a-switching');
    await recreate(a);
    await wait(`activeSessionId===${j(a)} && !document.querySelector('.session-resume-pending') && !terminalPanelEl.classList.contains('home-active')`, 'A 原地挂回');
    result.checks.push('新会话到来后原地挂回，不回首页'); await shot('a-mounted');

    // B. 已切走
    const b = await create();
    await c.eval(`(async()=>{ await selectSession(${j(b)}); return true; })()`);
    await wait(`activeSessionId===${j(b)}`, 'B 选中');
    await suspend(a);
    await sleep(200);
    await recreate(a);
    await sleep(600);
    result.b = await c.eval(`({ active: activeSessionId, aStatus: sessions.get(${j(a)})?.status })`);
    assert.equal(result.b.active, b, '不抢焦点');
    assert.notEqual(result.b.aStatus, 'dormant', '后台的会话已接上');
    result.checks.push('已切去别的会话：不抢焦点，后台接上'); await shot('b-background');
    result.ok = true;
    console.log('GUI PASS: ' + result.checks.join('；'));
  } catch (error) {
    result.error = error.stack;
    if (c) try { const file = path.join(out, '20261124-lite-fallback-failure-1440x900.png'); fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(file); } catch {}
    throw error;
  } finally {
    if (c) await c.close(); if (hub) result.teardown = await gracefulQuit(hub).catch(error => ({ error: error.message }));
    fs.writeFileSync(path.join(out, '20261124-lite-fallback-view-gui.json'), JSON.stringify(result, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 句柄稍后释放 */ }
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
