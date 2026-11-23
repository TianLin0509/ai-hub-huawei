'use strict';
// 低开销模式真实界面验收（隔离 Hub、后台窗口、1440×900）：
//   A. 新装：日志判定 fresh；底栏显示「网速 关」、GPU「关」；点「网速 关」直达设置「资源与后台」并标出那一行；
//      页面一屏放下（无纵向滚动）；总开关显示已开；占用读数出来（总内存、进程数、第二次读到 CPU）；
//      在页面上打开「底栏网速与显卡读数」后底栏恢复网速读数；再打开总开关又全关。
//   B. 老用户升级（数据目录里预置 state.json）：开关不变（会议室照开），右下角提示一次；点「不用了」后重开不再提示。
// 截图写到 HUB_CAPTURE_DIR（默认系统临时目录），不进仓库。
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function until(label, read, ms = 45000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await read().catch(() => null); if (v) return v; await wait(250); } throw Error('Timeout: ' + label); }
const outDir = process.env.HUB_CAPTURE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'low-overhead-shots-'));

async function launch(root, label, { seedState = false } = {}) {
  const data = path.join(root, 'data'), home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  if (seedState) { fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, sessions: [] })); }
  const hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label, extraEnv: {
    CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: home, HOME: home, USERPROFILE: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', CLAUDE_HUB_E2E_FRESH_INSTALL: '1' } });
  const c = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url));
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await until('renderer ready', () => c.eval('typeof sessions!=="undefined" && !!window.__hubBackgroundFeatures && !!window.__optionalFeatures'), 60000);
  return { hub, c, data };
}
async function shot(c, name) {
  const file = path.join(outDir, `20261123-低开销模式-${name}.png`);
  fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log('  📷 ' + file);
  return file;
}
async function clickSel(c, sel) {
  const p = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('missing '+${JSON.stringify(sel)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
}

(async () => {
  const ok = (cond, label, detail) => { assert.ok(cond, label + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); console.log('  ✓ ' + label); };
  let run = null;
  try {
    console.log('A. 新装');
    run = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'low-overhead-fresh-')), 'lo-fresh');
    const { c } = run;
    const stored = JSON.parse(fs.readFileSync(path.join(run.data, 'optional-features.json'), 'utf8'));
    ok(stored.lowOverhead === true && stored.rooms === false && stored.liveMeter === false, '新装判定写进文件：模式开、会议室和底栏读数关', stored);
    const offChip = await until('底栏显示网速关', () => c.eval(`(()=>{const e=document.querySelector('.strip-transfer [data-open-resources="liveMeter"]');const g=document.querySelector('.strip-gpu');return e&&g?{net:e.textContent,gpu:g.textContent}:null})()`), 30000);
    ok(offChip.net.includes('关') && offChip.gpu.includes('关'), '底栏网速和 GPU 显示「关」', offChip);
    await shot(c, '1-新装底栏');
    await clickSel(c, '.strip-transfer [data-open-resources="liveMeter"]');
    await until('资源与后台页显示', () => c.eval(`(()=>{const s=document.getElementById('cfg-background-section');return !!s&&s.offsetParent!==null&&!document.getElementById('config-modal').classList.contains('hidden')})()`));
    const flash = await c.eval(`!!document.querySelector('#cfg-background-section tr.bg-flash[data-bg-row="liveMeter"]')`);
    ok(flash, '从底栏进来标出「底栏网速与显卡读数」那一行');
    await until('占用读数出来（含 CPU）', () => c.eval(`(()=>{const t=document.querySelector('#cfg-background-section .bg-total');return t&&/内存 \\d+ MB/.test(t.textContent)&&/CPU [\\d.]+%/.test(t.textContent)?t.textContent:null})()`), 20000);
    const page = await c.eval(`(()=>{const s=document.getElementById('cfg-background-section');const mode=s.querySelector('input[data-bg="mode"]');
      const box=[...document.querySelectorAll('#config-modal *')].filter(e=>e.scrollHeight>e.clientHeight+2&&['auto','scroll'].includes(getComputedStyle(e).overflowY)).map(e=>({id:e.id,cls:e.className,sh:e.scrollHeight,ch:e.clientHeight}));
      return {mode:mode.checked,rows:[...s.querySelectorAll('tr[data-bg-row]')].map(r=>r.dataset.bgRow),state:s.querySelector('.bg-mode-state').textContent,total:s.querySelector('.bg-total').textContent,scrollers:box,
        checked:[...s.querySelectorAll('input[data-bg-id]')].filter(i=>i.checked).map(i=>i.dataset.bgId)}})()`);
    ok(page.mode === true && page.checked.length === 0, '总开关已开、所有后台功能都关着', page);
    ok(page.rows.includes('liveMeter') && page.rows.includes('searchIndex') && page.rows.includes('rooms'), '列出后台功能（含三项新开关和会议室）', page.rows);
    ok(page.scrollers.length === 0, '1440×900 下设置页无纵向滚动', page.scrollers);
    await wait(1200);
    await shot(c, '2-资源与后台-新装');
    // 打开底栏读数：底栏回到网速读数
    await clickSel(c, '#cfg-background-section input[data-bg-id="liveMeter"]');
    await until('底栏读数开了', () => c.eval(`window.__optionalFeatures.get('liveMeter')?.on===true`));
    const state2 = await c.eval(`document.querySelector('#cfg-background-section .bg-mode-state').textContent`);
    ok(/按需开了 1 项/.test(state2), '模式仍开、显示按需开了 1 项', state2);
    await until('底栏网速恢复', () => c.eval(`!document.querySelector('.strip-transfer [data-open-resources]') && !!document.querySelector('.strip-download')`), 20000);
    ok(true, '底栏恢复网速读数');
    await shot(c, '3-按需开了底栏读数');
    // 关掉总开关：三项老行为恢复为开
    await clickSel(c, '#cfg-background-section input[data-bg="mode"]');
    await until('总开关关了', () => c.eval(`!document.querySelector('#cfg-background-section input[data-bg="mode"]').checked && window.__optionalFeatures.get('searchIndex')?.on===true`));
    ok(true, '关掉低开销模式：搜索索引、额度刷新恢复为开');
    // 再打开总开关：全部关掉
    await clickSel(c, '#cfg-background-section input[data-bg="mode"]');
    await until('总开关又开', () => c.eval(`document.querySelector('#cfg-background-section input[data-bg="mode"]').checked && window.__optionalFeatures.list().filter(f=>f.background&&f.on).length===0`));
    const navHidden = await c.eval(`document.documentElement.dataset.ofNavHidden||''`);
    ok(!/liveMeter|searchIndex/.test(navHidden), '模式替用户关的不收起入口', navHidden);
    await c.close(); await gracefulQuit(run.hub); run = null;

    console.log('B. 老用户升级');
    const upRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'low-overhead-upgrade-'));
    run = await launch(upRoot, 'lo-upgrade', { seedState: true });
    const s2 = JSON.parse(fs.readFileSync(path.join(run.data, 'optional-features.json'), 'utf8'));
    ok(s2.lowOverhead === false && s2.rooms === true && s2.liveMeter === true && s2.lowOverheadHint === true, '升级：开关不变（会议室、底栏读数照开），留一次提示', s2);
    await until('右下角提示出现', () => run.c.eval(`!!document.querySelector('.bg-hint-bar')`), 30000);
    await shot(run.c, '4-老用户升级提示');
    await clickSel(run.c, '.bg-hint-bar [data-bg-hint="no"]');
    await until('提示收起', () => run.c.eval(`!document.querySelector('.bg-hint-bar')`));
    await wait(500);
    const s3 = JSON.parse(fs.readFileSync(path.join(run.data, 'optional-features.json'), 'utf8'));
    ok(s3.lowOverheadHint === false && s3.lowOverhead === false, '点「不用了」：记住不再提示，模式仍关', s3);
    await run.c.close(); await gracefulQuit(run.hub); run = null;
    run = await launch(upRoot, 'lo-upgrade-2');
    await wait(10000);
    ok(!(await run.c.eval(`!!document.querySelector('.bg-hint-bar')`)), '重开后不再提示');
    console.log('全部通过；截图目录：' + outDir);
  } catch (error) {
    console.error('失败：', error && error.stack || error);
    if (run?.c) try { await shot(run.c, 'x-失败现场'); } catch {}
    process.exitCode = 1;
  } finally {
    if (run) { try { run.c.close(); } catch {} await gracefulQuit(run.hub).catch(e => console.warn('quit:', e.message)); }
  }
})();
