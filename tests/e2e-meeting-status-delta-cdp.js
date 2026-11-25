'use strict';
// 会议页增量拉取与切走停拉（2026-11-25 m3）：真实隔离 HUB-H、真实会议后端（不替换 IPC），用鼠标切页。
// 1. 会议页显示、会议采集中（经 IPC 每秒送心跳、每 2 秒一条重点）：轮询照常 2.5 秒一次，第一次全量、之后增量（每次 < 20 KB），时间流跟上新重点；
// 2. 切到主页：会议页隐藏期间 meeting-status 0 次，采集照常（重点继续写进会议）；
// 3. 切回：立即一次全量，时间流里出现隐藏期间新增的重点；回放与证据定位不受影响由其它会议 e2e 覆盖。
// 用法：node tests/e2e-meeting-status-delta-cdp.js [输出目录]
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve(process.argv[2] || 'artifacts/meeting-status-delta-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-status-delta-')), dataDir = path.join(testRoot, 'data'), stub = path.join(testRoot, 'welink-disabled.js');
  fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false })); fs.writeFileSync(stub, 'process.exit(1)\n');
  const result = { checks: [] }; let hub;
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'm3 status delta', extraEnv: { CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_WELINK_CLI: stub } });
    const c = await connectFirstPage(hub, null, { waitMainMs: 30000, commandTimeoutMs: 60000 });
    const ev = async expression => { const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
    const q = s => `document.querySelector(${JSON.stringify(s)})`;
    const until = async (expr, label, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await ev(expr)) return; } catch {} await _waitMs(150); } throw Error('timeout: ' + label); };
    const click = async selector => {
      const p = await ev(`(()=>{const e=${q(selector)};const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p });
    };
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`!!${q('#btn-company-meeting')}`, 'meeting nav', 60000);
    // 只记账、不改行为：数一数页面发出的 meeting-status 和回包大小。
    await ev(`(()=>{const {ipcRenderer}=require('electron'),orig=ipcRenderer.invoke.bind(ipcRenderer);window.__m3=[];window.__inv=(n,a={})=>orig('company-assistant:'+n,a);
      ipcRenderer.invoke=async(ch,a)=>{const r=await orig(ch,a);if(ch==='company-assistant:meeting-status')window.__m3.push({at:Date.now(),since:!!a?.since,delta:!!r?.meetingDelta,bytes:JSON.stringify(r).length});return r;};return true;})()`);
    const started = await ev(`__inv('meeting-start',{title:'增量拉取验收',audio:[]})`); assert.ok(started.ok, JSON.stringify(started));
    const id = started.meeting.id;
    // 先放 1500 条重点，让全量够大（约几百 KB），增量与全量的差别看得清。
    await ev(`(async()=>{for(let i=1;i<=1500;i++){const r=await __inv('meeting-capture',{id:${JSON.stringify(id)},kind:'mark',at:i*100,text:'预置重点 '+i+' 调度算法吞吐收益百分之三到五'});if(r.ok===false)throw Error(r.error);}return true;})()`);
    await click('#btn-company-meeting'); await until(`${q('[data-m="history"]')}?.querySelector('option[value="${id}"]')`, 'history option');
    await ev(`(()=>{const s=${q('[data-m="history"]')};s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change'));return true;})()`);
    await until(`document.querySelectorAll('[data-m="timeline"] .meeting-flow-event').length>=1500`, 'timeline loaded', 30000);
    let at = 200000, n = 0;
    const feed = async seconds => { for (let s = 0; s < seconds; s++) { at += 1000; await ev(`__inv('meeting-capture',{id:${JSON.stringify(id)},kind:'heartbeat',at:${at}})`); if (s % 2 === 0) { n++; await ev(`__inv('meeting-capture',{id:${JSON.stringify(id)},kind:'mark',at:${at},text:'新重点 ${n}'})`); } await _waitMs(1000); } };
    // 1. 显示中
    await ev('window.__m3.length=0'); await feed(15);
    const shown = await ev('window.__m3.slice()');
    result.visible = { polls: shown.length, deltas: shown.filter(x => x.delta).length, maxDeltaBytes: Math.max(0, ...shown.filter(x => x.delta).map(x => x.bytes)), fullBytes: Math.max(0, ...shown.filter(x => !x.delta).map(x => x.bytes)) };
    assert.ok(shown.length >= 5, '显示时照常轮询：' + shown.length);
    assert.ok(result.visible.deltas >= shown.length - 1, '显示时几乎全是增量'); assert.ok(result.visible.maxDeltaBytes < 20000, '每次增量 < 20 KB：' + result.visible.maxDeltaBytes);
    await until(`[...document.querySelectorAll('[data-m="timeline"] .meeting-flow-event')].some(e=>e.textContent.includes('新重点 ${n}'))`, 'timeline follows deltas', 6000);
    result.checks.push(`显示中 15 秒：${shown.length} 次拉取、${result.visible.deltas} 次增量，最大增量 ${result.visible.maxDeltaBytes} 字节，时间流跟上「新重点 ${n}」`);
    // 2. 切走
    await click('#btn-home'); await until(`${q('#company-meeting-page')}?.hidden!==false||${q('.company-meeting')}?.hidden`, 'left meeting page');
    await ev('window.__m3.length=0'); const nBefore = n; await feed(15);
    const hidden = await ev('window.__m3.length'); result.hidden = { polls: hidden, marksAdded: n - nBefore };
    assert.equal(hidden, 0, '隐藏时不拉');
    const stored = await ev(`__inv('meeting-status',{id:${JSON.stringify(id)}}).then(s=>s.meeting.events.filter(e=>e.text?.startsWith('新重点')).length)`);
    assert.equal(stored, n, '隐藏期间采集照常写进会议');
    result.checks.push(`隐藏 15 秒：meeting-status 0 次，期间新增 ${n - nBefore} 条重点照常写进会议`);
    // 3. 切回
    await ev('window.__m3.length=0'); await click('#btn-company-meeting');
    await until(`window.__m3.length>=1`, 'refresh on return', 5000);
    const back = await ev('window.__m3[0]'); assert.equal(back.delta, false, '切回第一次是全量'); assert.equal(back.since, false);
    await until(`[...document.querySelectorAll('[data-m="timeline"] .meeting-flow-event')].some(e=>e.textContent.includes('新重点 ${n}'))`, 'timeline shows hidden-period marks', 6000);
    result.checks.push(`切回：立即全量（${back.bytes} 字节），时间流里有隐藏期间的「新重点 ${n}」`);
    const image = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '20261125-m3-status-delta-back.png'), Buffer.from(image.data, 'base64'));
    await ev(`__inv('meeting-control',{id:${JSON.stringify(id)},op:'stop'})`);
    result.passed = true;
  } catch (error) { result.error = error.stack || error.message; process.exitCode = 1; }
  finally {
    if (hub?.isAlive?.()) { try { await gracefulQuit(hub, { timeoutMs: 30000 }); } catch (e) { result.quitError = e.message; } }
    try { fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch {}
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  }
})();
