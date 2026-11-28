'use strict';
// 真机压测：会议页与会议室页的「全新用户第一次打开」（2026-11-28）。隔离 Hub（隐藏窗口、全新数据目录）。
// 会议：不开会、不录屏录音；只看首屏提示、可选画面来源的数量（只记个数和是否有会议窗口，不留缩略图）、
// 语音识别组件从公司内源一键安装的耗时与结果。会议室：不登录、不抢订，只核对首屏与「抢不到换下一间」说明。
//   <Hub 程序> 以 ELECTRON_RUN_AS_NODE=1 运行：node tests/e2e-company-meeting-rooms-fresh-real.js --exe <AI Hub Community.exe> [--out <证据目录>] [--no-asr]
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

delete process.env.ELECTRON_RUN_AS_NODE;
const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const exe = arg('--exe');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-rooms-real-'));
const out = arg('--out') || path.join(root, 'out'), dataDir = path.join(root, 'data');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const report = { startedAt: new Date().toISOString(), root, checks: [], metrics: {}, screenshots: [], timeline: [] };
const t0 = Date.now();
const save = () => { try { fs.writeFileSync(path.join(out, 'report.json'), j(report, null, 1)); } catch {} };
const log = (msg, extra) => { const line = { s: Math.round((Date.now() - t0) / 1000), msg, ...(extra ? { extra } : {}) }; report.timeline.push(line); console.log(j(line)); save(); };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); log((ok ? '通过 ' : '失败 ') + name, detail); return !!ok; };
let hub, c;
const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return true; await sleep(500); } throw Error('超时：' + label); };
const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }); const file = path.join(out, name + '.jpg'); fs.writeFileSync(file, Buffer.from(s.data, 'base64')); report.screenshots.push(file); };
const click = async selector => {
  const point = await c.eval(`(() => {const e=document.querySelector(${j(selector)});if(!e)throw Error('找不到 '+${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
};
const ipc = (action, data) => c.eval(`require('electron').ipcRenderer.invoke(${j('company-assistant:' + action)}, ${j(data || {})})`);
const visibleText = () => c.eval(`(() => { const p = [...document.querySelectorAll('main, section, .page, [class*="page"]')].find(e => e.offsetParent && e.innerText.length > 40); return (p || document.body).innerText.slice(0, 600); })()`).catch(() => '');
const pageScroll = () => c.eval(`({ scrollH: document.scrollingElement.scrollHeight, clientH: document.scrollingElement.clientHeight })`).catch(() => null);

async function main() {
  // 隔离副本会被内源静默升级写回 app.asar，那时实际跑的是原包而不是要测的代码：发现就停，不测。
  // --released：有意测已发布的原包（如按真实路径升到 v5.6.149 的副本），这时 app.asar 本来就该在。
  if (!process.argv.includes('--released') && fs.existsSync(path.join(path.dirname(exe), 'resources', 'app.asar'))) throw new Error('隔离副本的 resources 下又出现了 app.asar（可能被静默升级写回），实际会跑原包；请先改名或重建副本再测');
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), j({ assistant: true, forum: false }));
  // 不让隔离实例用本机真实 WeLink 登录去拉消息、整理助理（2026-11-28 真机压测踩到：后台读了几百次历史消息并占住 CodeAgent）。
  const welinkStub = path.join(root, 'welink-disabled.js');
  fs.writeFileSync(welinkStub, 'process.stdout.write(JSON.stringify({ authenticated: false, loggedIn: false }));');
  hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'meeting rooms real', executablePath: exe,
    entryPath: path.resolve(__dirname, '..'), cwd: path.dirname(exe), extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_WELINK_CLI: welinkStub, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'),
      AI_HUB_QUIET_UPDATE: '0', AI_HUB_UPDATE_STARTUP_DELAY_MS: String(24 * 3600 * 1000), DEEPSEEK_API_KEY: '' } });
  await require('./helpers/isolation-guard').guardIsolatedHub(hub, root);   // 5 秒内发现用到生产数据目录就只结束这个主进程并报错
  for (let i = 0; !c; i++) { try { c = await connectFirstPage(hub, target => /index\.html/.test(target.url), { waitMainMs: 15000 }); } catch (error) { if (i >= 8) throw error; await sleep(3000); } }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // 账号默认模型在公司侧不可用时，Hub 建会话会弹「新建会话需要换个模型」并等用户选。脚本不替用户点（红队审核：代点会掩盖卡死），
  // 只记下出现的时刻和原文，收尾时记为失败；要测功能本身，请用 --codeagent-model 给测试用的配置副本指定一个可用模型。
  let swapBusy = false;
  const swapTimer = setInterval(async () => {
    if (swapBusy || !c || report.modelSwapCard) return; swapBusy = true;
    try {
      const hit = await c.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '换成它并创建' && x.getBoundingClientRect().width > 0); if (!b) return null; const card = b.closest('[role=dialog], [role=alertdialog], [class*=hmn]') || b.parentElement; return (card?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300); })()`).catch(() => null);
      if (hit) { report.modelSwapCard = { s: Math.round((Date.now() - t0) / 1000), text: hit }; log('出现「新建会话需要换个模型」卡片（未代点）', hit.slice(0, 120)); }
    } finally { swapBusy = false; }
  }, 3000);
  swapTimer.unref?.();
  await until('!!document.getElementById("btn-company-meeting")', '会议入口', 120000);
  report.hubVersion = await c.eval(`require('../package.json').version`).catch(() => null);

  // ---- F08 会议：全新用户首屏 ----
  await click('#btn-company-meeting'); await sleep(5000);
  report.metrics.meetingFirst = await visibleText(); report.metrics.meetingScroll = await pageScroll();
  await shot('f08-meeting-first').catch(() => {});
  log('会议首屏', report.metrics.meetingFirst.slice(0, 300));
  const src = await ipc('meeting-sources').catch(e => ({ error: String(e) }));
  const names = (src.sources || []).map(s => s.name);
  report.metrics.sources = { count: names.length, screens: names.filter(n => /screen|屏幕|整个/i.test(n)).length, welinkMeeting: names.some(n => /WeLink|会议|Meeting/i.test(n)), error: src.error };
  log('画面来源', report.metrics.sources);
  check('F08 能列出可选画面来源（无会议时也不报错）', !src.error && names.length > 0, report.metrics.sources);
  const st = await ipc('meeting-status', {}).catch(e => ({ error: String(e) }));
  report.metrics.asrBefore = st.asr || st.meetingAsr || null;
  if (!argv.includes('--no-asr')) {
    const t = Date.now();
    const r = await ipc('meeting-asr-install').catch(e => ({ error: String(e) }));
    let asr = r.asr || {}, last = '';
    const end = Date.now() + 15 * 60000;
    const phases = [];
    while (Date.now() < end) {
      const s = await ipc('meeting-status', {}).catch(() => ({}));
      asr = s.asr || asr;
      const key = `${asr.phase}|${asr.error || ''}`;
      if (key !== last) { last = key; phases.push({ s: Math.round((Date.now() - t) / 1000), phase: asr.phase, progress: asr.progress, error: asr.error, size: asr.sizeText }); }
      if (asr.ready || asr.error || ['done', 'error', 'ready'].includes(asr.phase)) break;
      await sleep(3000);
    }
    report.metrics.asrInstall = { seconds: Math.round((Date.now() - t) / 1000), final: asr, phases: phases.slice(0, 20), startError: r.error };
    await shot('f08-asr-install').catch(() => {});
    check('F08 全新用户一键安装语音识别组件（公司内源）成功', !!asr.ready && !asr.error, report.metrics.asrInstall);
  }

  // ---- F12 会议室：全新用户首屏与换间说明 ----
  await click('#btn-company-rooms'); await sleep(5000);
  report.metrics.roomsFirst = await visibleText(); report.metrics.roomsScroll = await pageScroll();
  await shot('f12-rooms-first').catch(() => {});
  const html = await c.eval(`document.body.innerHTML.includes('约 20–30 秒') ? 'old' : document.body.innerHTML.includes('不到 1 秒') ? 'new' : 'none-visible'`).catch(() => 'err');
  const src2 = await c.eval(`(async () => { const r = await fetch('company-rooms-page.js').then(x => x.text()).catch(() => ''); return r.includes('约 20–30 秒') ? 'old' : r.includes('不到 1 秒') ? 'new' : 'unknown'; })()`).catch(() => 'err');
  report.metrics.roomsCopy = { dom: html, source: src2 };
  check('F12 「抢不到换下一间」说明不再是「约 20–30 秒」', html !== 'old' && src2 !== 'old', report.metrics.roomsCopy);
}

// 关 Hub：优雅退出失败就记进报告并保留 hub 引用，再只结束这个脚本自己拉起、核实过的主进程（hub.child），不按进程树或进程名收。
async function closeHub(why) {
  if (!hub) return true;
  try { await gracefulQuit(hub); hub = null; return true; }
  catch (e) {
    (report.quitErrors ||= []).push({ why, error: String(e && e.message || e).slice(0, 300) });
    try { if (hub.child && hub.child.pid === hub.pid && hub.child.exitCode == null) hub.child.kill(); } catch (k) { report.quitErrors.push({ why: why + ' kill', error: String(k) }); }
    await sleep(3000);
    if (hub.isAlive && !hub.isAlive()) { hub = null; return false; }
    report.hubLeft = { pid: hub.pid };   // 仍在：报告里写明 PID，交给人工核实后处理
    return false;
  }
}

main().catch(e => { report.error = String(e && e.stack || e); log('出错', report.error); })
  .finally(async () => {
    const closed = await closeHub('收尾');
    report.finishedAt = new Date().toISOString();
    if (report.modelSwapCard) report.checks.push({ name: '没有出现需要用户去点的换模型卡片', ok: false, detail: report.modelSwapCard });
    report.passed = require('./helpers/e2e-verdict').e2ePassed(report, closed);
    save();
    console.log('REPORT ' + path.join(out, 'report.json'));
    process.exit(report.passed ? 0 : 1);
  });
