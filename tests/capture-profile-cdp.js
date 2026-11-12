'use strict';
//   1) 全新用户、什么都没配：左栏底部「主题」上方出现头像入口，名字自动从 WeLink 登录账号认出来；点开是 1 级的个人页；
//   2) 预置约 3 个月的使用记录：等级、成就墙、热力图、桌宠伙伴一屏放完（1440×900 不出纵向滚动）；
//   3) 点成就看说明、改称呼、升级提示条、宽导航栏。
// 用法：node tests/capture-profile-cdp.js --out <新目录>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

// 用真实内核按天模拟出一份使用记录（固定随机种子，界面验收用）。
function seed(dataDir, days) {
  const { Profile } = require('../core/profile/service');
  const clock = { at: new Date() };
  const p = new Profile({ dataDir, now: () => new Date(clock.at), saveDelayMs: 1e9 });
  for (const id of ['assistant', 'rooms', 'meeting', 'ppt', 'forum', 'attendance', 'team', 'roundtable', 'aside', 'rules', 'components', 'disk', 'pet']) p.registerFeature(id);
  let s = 11; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const feats = ['assistant', 'forum', 'attendance', 'ppt', 'rooms', 'meeting', 'aside', 'rules', 'team', 'roundtable'];
  for (let back = days; back >= 1; back--) {
    const d = new Date(); d.setDate(d.getDate() - back); d.setHours(10, 0, 0, 0);
    const wd = d.getDay();
    if ((wd === 0 || wd === 6) && rnd() > 0.25) continue;
    if (rnd() < 0.08) continue;
    clock.at = d; p.record('open');
    const n = 8 + Math.floor(rnd() * 45);
    for (let i = 0; i < n; i++) { if (i === 3 && rnd() < 0.3) { const late = new Date(d); late.setHours(23, 30); clock.at = late; } p.record('prompt', { skill: rnd() < 0.05 }); p.record('turn'); clock.at = d; }
    for (let i = 0; i < 1 + Math.floor(rnd() * 5); i++) p.record('session');
    for (const f of feats) if (rnd() < (days - back) / days * 0.35) p.record('feature', { id: f });
    if (rnd() < 0.5) { p.record('pet'); p.petCompany(); }
  }
  fs.writeFileSync(path.join(dataDir, 'token-usage-ledger.json'), JSON.stringify({ version: 1, days: { '2026-11-01': [['codeagent', 'model', 'a', 41000000, 900000000, 9000000, 13400000]] } }));
  p.state.fresh = { 'streak-7': 1 }; p.state.backfill = { at: Date.now(), days: 0, sessions: 0 };
  p.save();
  return p.snapshot();
}

async function session(out, evidence, name, prepare, steps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-profile-cap-')), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  prepare(data);
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'profile-capture-' + name, extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js'),
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(name + ': ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); } catch { /* 不是异常消息 */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* 页面还没好 */ } await sleep(200); } throw Error('Timeout ' + label); };
    const shot = async file => { await sleep(700); fs.writeFileSync(path.join(out, file + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); evidence.steps.push('shot ' + file); };
    const clickSel = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
    await steps({ c, wait, shot, clickSel, data });
  } finally {
    try { c?.close?.(); } catch { /* 已断开 */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}

async function run() {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i > 0 ? process.argv[i + 1] : path.join(REPO, 'artifacts', 'profile-' + Date.now()));
  fs.mkdirSync(out, { recursive: true });
  const evidence = { steps: [], rendererErrors: [], checks: {} };
  const fits = `(()=>{const b=document.querySelector('#profile-page .pf-body');return {scroll:b.scrollHeight,client:b.clientHeight,fits:b.scrollHeight<=b.clientHeight+1}})()`;

  // 1) 全新用户
  await session(out, evidence, 'fresh', () => {}, async ({ c, wait, shot, clickSel, data }) => {
    await wait(`!!document.getElementById('btn-profile')`, 'entry button');
    const order = await c.eval(`(()=>{const u=[...document.querySelectorAll('#scene-rail .rail-utilities > *')].filter(e=>e.offsetParent!==null);return u.map(e=>e.id||e.className)})()`);
    evidence.checks.utilitiesOrder = order;
    evidence.checks.freshNameAtStart = await c.eval(`document.querySelector('#btn-profile [data-slot="name"]').textContent`);
    // 名字从 WeLink 认出来（启动 4 秒后开始问，三条命令各隔 3 秒）
    evidence.checks.freshName = await wait(`(()=>{const t=document.querySelector('#btn-profile [data-slot="name"]').textContent;return t==='用户甲'?t:''})()`, 'welink name', 40000);
    await shot('01-全新用户-左栏入口');
    await clickSel('#btn-profile');
    await wait(`document.querySelector('#profile-page .pf-badges')`, 'page');
    evidence.checks.freshFits = await c.eval(fits);
    evidence.checks.freshIdentity = JSON.parse(fs.readFileSync(path.join(data, 'profile', 'profile.json'), 'utf8')).identity;
    await shot('02-全新用户-个人页');
  });

  // 2) 用了约 3 个月的用户
  let seeded;
  await session(out, evidence, 'seeded', data => { seeded = seed(data, 96); }, async ({ c, wait, shot, clickSel }) => {
    evidence.checks.seeded = { level: seeded.level, xp: seeded.xp, unlocked: seeded.unlocked, total: seeded.achievements.length };
    await wait(`(()=>{const t=document.querySelector('#btn-profile [data-slot="lv"]');return t&&/Lv\\.\\d+/.test(t.textContent)&&t.textContent!=='Lv.1'})()`, 'entry level');
    await wait(`document.querySelector('#btn-profile [data-slot="name"]').textContent==='用户甲'`, 'welink name', 40000);
    await shot('03-左栏入口-有新成就红点');
    await clickSel('#btn-profile');
    await wait(`document.querySelector('#profile-page .pf-badges')`, 'page');
    evidence.checks.seededFits = await c.eval(fits);
    evidence.checks.badgeCount = await c.eval(`document.querySelectorAll('#profile-page .pf-badge').length`);
    evidence.checks.badgeImagesLoaded = await c.eval(`[...document.querySelectorAll('#profile-page img')].every(i=>i.complete&&i.naturalWidth>0)`);
    await shot('04-个人页-首屏');
    await clickSel('#profile-page .pf-badge:not(.on)');
    await shot('05-点未解锁成就看进度');
    // 另外三个页签：成就、足迹、名片，各自一屏放完
    evidence.checks.tabs = {};
    for (const [tab, sel, file] of [['wall', '.pf-wall-page', '05b-成就页'], ['trail', '.pf-trail', '05c-足迹页'], ['card', '.pf-cardpage', '05d-名片页']]) {
      await clickSel(`#profile-page .pf-tabs [data-pf-tab="${tab}"]`);
      await wait(`document.querySelector('#profile-page ${sel}')`, 'tab ' + tab);
      const fit = await c.eval(fits);
      // 列表类的卡片内部也不能被裁掉
      fit.clipped = await c.eval(`[...document.querySelectorAll('#profile-page :is(.pf-group-list,.pf-rows,.pf-fields,.pf-rulegrid,.pf-ranks)')].filter(e=>e.scrollHeight>e.clientHeight+1).map(e=>e.className+':'+e.scrollHeight+'>'+e.clientHeight)`);
      evidence.checks.tabs[tab] = fit;
      await shot(file);
    }
    evidence.checks.cardFields = await c.eval(`[...document.querySelectorAll('#profile-page .pf-fields dt')].map(e=>e.textContent)`);
    await clickSel('#profile-page .pf-tabs [data-pf-tab="home"]');
    await wait(`document.querySelector('#profile-page [data-pf="rename"]')`, 'home tab');
    await clickSel('#profile-page [data-pf="rename"]');
    await wait(`document.querySelector('#profile-page .pf-name-input')`, 'rename input');
    await c.eval(`(()=>{const i=document.querySelector('#profile-page .pf-name-input');i.value='小北';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`);
    evidence.checks.renamed = await wait(`(()=>{const t=document.querySelector('#btn-profile [data-slot="name"]').textContent;return t==='小北'?t:''})()`, 'renamed');
    await c.eval(`ipcRenderer.emit('profile:event', {}, { type: 'level-up', level: 15, rank: 4, title: '升到 Lv.15 · 晋升资深驾驭者', text: '桌宠解锁「光环」' })`);
    await shot('06-改称呼后-升级提示');
    // 关页后「新」标记清掉
    await clickSel('#btn-home'); await sleep(600);
    evidence.checks.dotClearedAfterClose = await c.eval(`!document.querySelector('#btn-profile .pf-entry-dot')`);
    evidence.checks.closedByHome = await c.eval(`document.getElementById('profile-page').hidden`);
    // 宽导航栏
    await c.eval(`localStorage.setItem('hub.hwRailWide','1')`);
    await c.send('Page.reload'); await sleep(2500);
    await wait(`!!document.getElementById('btn-profile')`, 'entry after reload');
    await clickSel('#btn-profile');
    await wait(`document.querySelector('#profile-page .pf-badges')`, 'page wide');
    evidence.checks.wideRail = await c.eval(`document.documentElement.dataset.hwRail`);
    evidence.checks.wideFits = await c.eval(fits);
    await shot('07-宽导航栏');
  });

  // 3) 真实计分链路：全新用户点开两个功能 → 经验到 Lv.2 → 窗口顶部弹升级提示、入口变 Lv.2、桌宠拿到等级；摸一下桌宠 → 解锁「初次相遇」。
  //    桌宠窗口在隐藏模式下不显示，举卡片和撒花由单测与离屏真渲染覆盖，这里只核对桌宠收到的等级。
  await session(out, evidence, 'live', () => {}, async ({ c, wait, shot, clickSel }) => {
    await wait(`!!document.getElementById('btn-profile')`, 'entry button');
    const live = evidence.checks.live = {};
    await c.eval(`ipcRenderer.invoke('hub-pet:set-settings', { enabled: true }).then(() => true)`);
    live.before = await c.eval(`ipcRenderer.invoke('profile:state').then(r => ({ level: r.snapshot.level, xp: r.snapshot.xp, feats: r.snapshot.stats.featuresAvail }))`);
    await c.eval(`ipcRenderer.invoke('env-check:run').then(() => true, () => true)`);
    await c.eval(`ipcRenderer.invoke('company-forum:ensure-today').then(() => true, () => true)`);
    live.toast = await wait(`(()=>{const t=document.querySelector('#profile-toast.show b');return t?t.textContent:''})()`, 'level-up toast', 8000);
    live.entryLv = await wait(`(()=>{const t=document.querySelector('#btn-profile [data-slot="lv"]').textContent;return t==='Lv.2'?t:''})()`, 'entry Lv.2', 8000);
    await shot('08-真实计分-升级提示');
    live.after = await c.eval(`ipcRenderer.invoke('profile:state').then(r => ({ level: r.snapshot.level, xp: r.snapshot.xp, used: r.snapshot.features.filter(f => f.count).map(f => f.id) }))`);
    live.petGrowth = await wait(`ipcRenderer.invoke('hub-pet:debug', { op: 'state' }).then(s => s && s.lastSent && s.lastSent.growth ? JSON.stringify(s.lastSent.growth) : '')`, 'pet growth', 10000);
    live.petted = await c.eval(`ipcRenderer.invoke('hub-pet:debug', { op: 'pet' })`);
    live.petToast = await wait(`(()=>{const t=document.querySelector('#profile-toast.show b');return t&&/初次相遇/.test(t.textContent)?t.textContent:''})()`, 'pet achievement toast', 8000);
    live.pets = await c.eval(`ipcRenderer.invoke('profile:state').then(r => r.snapshot.pet.pets)`);
    // 点提示条打开个人页
    await clickSel('#profile-toast');
    await wait(`document.querySelector('#profile-page .pf-badges')`, 'page via toast');
    await shot('09-真实计分-个人页');
    // 桌宠菜单里有「摸摸它」并带等级
    live.menuPet = await c.eval(`ipcRenderer.invoke('hub-pet:debug', { op: 'menu-state' }).then(m => JSON.stringify((m.quick || []).find(q => q.type === 'pet') || null))`);
    await c.eval(`ipcRenderer.invoke('hub-pet:set-settings', { enabled: false }).then(() => true)`);
  });

  evidence.ok = evidence.rendererErrors.length === 0 && evidence.checks.freshName === '用户甲' && evidence.checks.freshFits.fits && evidence.checks.seededFits.fits && evidence.checks.badgeImagesLoaded && evidence.checks.renamed === '小北' && evidence.checks.dotClearedAfterClose && Object.values(evidence.checks.tabs).every(t => t.fits && !t.clipped.length)
    && evidence.checks.live.entryLv === 'Lv.2' && evidence.checks.live.pets === 1 && /"level":2/.test(evidence.checks.live.petGrowth);
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 1));
  console.log(JSON.stringify(evidence, null, 1));
  if (!evidence.ok) process.exitCode = 1;
}

run().catch(error => { console.error(error); process.exitCode = 1; });
