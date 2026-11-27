'use strict';
//   1) 左栏「帖子」下方出现入口；按确认过的 mock 布局渲染（四格、领奖台、4–20 名、我的位置），不出横向溢出；
//   2) 切榜单、改昵称、收件机本机趋势与版本、人数不足、内网外、已关闭（重新参与）、连不上各状态；底栏「社区 ● 在线 N」与左栏绿点；
//   3) 六套主题逐一截图，量关键文字对比度；英文界面截图并检查没有漏翻的中文。
// 用法：node tests/e2e-community-board-cdp.js --out <新目录>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const mock = require('./fixtures/community-board-mock');
const REPO = path.resolve(__dirname, '..');
const THEMES = require('../core/theme-config').THEMES || [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

const installMock = board => `(()=>{
  const { ipcRenderer } = require('electron');
  if (!ipcRenderer.__cmyOrig) ipcRenderer.__cmyOrig = ipcRenderer.invoke.bind(ipcRenderer);
  window.__cmyBoard = ${JSON.stringify(board)}; window.__cmyCalls = window.__cmyCalls || [];
  ipcRenderer.invoke = (ch, ...a) => {
    if (!String(ch).startsWith('community:')) return ipcRenderer.__cmyOrig(ch, ...a);
    window.__cmyCalls.push([ch, a[0]]);
    if (ch === 'community:get-board') return Promise.resolve(JSON.parse(JSON.stringify(window.__cmyBoard)));
    if (ch === 'community:set-nickname') return Promise.resolve({ ok: true, nick: a[0].name });
    if (ch === 'community:set-enabled') { window.__cmyBoard = ${JSON.stringify(mock.board())}; return Promise.resolve({ ok: true, enabled: a[0].enabled }); }
    if (ch === 'community:get-settings') return Promise.resolve({ ok: true, enabled: true });
    return Promise.resolve({ ok: false, error: 'mock: unknown ' + ch });
  };
  return true;
})()`;

// WCAG 对比度：文字色对它所在卡片的底色。
const contrastExpr = `(()=>{
  // color-mix() 的计算值是 color(srgb 0–1 小数)，要换回 0–255
  const rgb = s => { const m = s.match(/[\\d.]+/g).map(Number); const k = /^color\\(srgb/.test(s) ? 255 : 1; return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m.length > 3 ? m[3] : 1 }; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = el => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.a > 0) layers.push(c); if (c.a >= 1) break; }
    let base = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop() : (${JSON.stringify(require('../core/theme-config').DARK_THEME_IDS || [])}.includes(document.documentElement.dataset.theme) ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 });
    for (const c of layers.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) };
    return base;
  };
  const out = {};
  for (const sel of ['.cmy-head h1', '.cmy-meta', '.cmy-k', '.cmy-v', '.cmy-d', '.cmy-d b', '.cmy-tag', '.cmy-legend', '.cmy-vbar .n', '.cmy-hoststat', '.cmy-tabs button.on', '.cmy-tabs button:not(.on)', '.cmy-hint', '.pd .nm', '.pd .val', '.pd .lv', '.cmy-row .r', '.cmy-row .nm', '.cmy-row .lv', '.cmy-row .v', '.cmy-row.me .r', '.cmy-ranks div', '.cmy-ranks b', '.cmy-beat', '.cmy-priv', '.cmy-edit']) {
    const el = document.querySelector('#community-page ' + sel); if (!el) continue;
    const a = lum(rgb(getComputedStyle(el).color)), b = lum(bgOf(el));
    out[sel] = Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
  }
  return out;
})()`;
// mock 稿本身整页可纵向滚动；这里只要求不出横向溢出、名字和数值不被挤出格子。
const fitsExpr = `(()=>{const p=document.getElementById('community-page');const over=[...p.querySelectorAll('.cmy-row,.pd,.cmy-stat,.cmy-card')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className);return {scroll:p.scrollHeight,client:p.clientHeight,hOverflow:p.scrollWidth>p.clientWidth+1,fits:p.scrollWidth<=p.clientWidth+1&&!over.length,clipped:over}})()`;

async function session(out, evidence, name, prepare, steps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-community-cap-')), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  prepare(data);
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'community-capture-' + name, extraEnv: {
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js'),
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(name + ': ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); } catch { /* 不是异常消息 */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* 页面还没好 */ } await sleep(200); } throw Error('Timeout ' + label); };
    const shot = async file => { await sleep(600); fs.writeFileSync(path.join(out, file + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); evidence.steps.push('shot ' + file); };
    const clickSel = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
    // 换一份 mock 数据并重新打开页面
    const show = async (board, untilSel) => {
      await c.eval(installMock(board));
      if (await c.eval(`!!document.getElementById('community-page')&&!document.getElementById('community-page').hidden`)) await clickSel('#btn-community');
      await clickSel('#btn-community');
      await wait(`!!document.querySelector('#community-page .cmy-rows, #community-page .cmy-emptybox')`, 'community loaded');
      await clickSel('#community-page [data-cmy-sub="board"]');
      await wait(`document.querySelector('#community-page ${untilSel}')`, 'page ' + untilSel);
    };
    await steps({ c, wait, shot, clickSel, show });
  } finally {
    try { c?.close?.(); } catch { /* 已断开 */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}

async function run() {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i > 0 ? process.argv[i + 1] : path.join(REPO, 'artifacts', 'community-' + Date.now()));
  fs.mkdirSync(out, { recursive: true });
  const evidence = { steps: [], rendererErrors: [], checks: {}, failures: [] };
  const expect = (ok, msg) => { if (!ok) evidence.failures.push(msg); };

  await session(out, evidence, 'zh', () => {}, async ({ c, wait, shot, clickSel, show }) => {
    await wait(`!!document.getElementById('btn-community')`, 'entry button');
    // 入口位置：mock 里排在「帖子」下方
    evidence.checks.entry = await c.eval(`(()=>{const b=document.getElementById('btn-community').getBoundingClientRect(),f=document.getElementById('btn-company-forum');return {top:Math.round(b.top),visible:b.width>0,label:document.querySelector('#btn-community .btn-label').textContent,forumTop:f&&f.offsetParent?Math.round(f.getBoundingClientRect().top):null}})()`);
    expect(evidence.checks.entry.visible, '入口不可见');
    if (evidence.checks.entry.forumTop != null) expect(evidence.checks.entry.top > evidence.checks.entry.forumTop, '入口不在「帖子」下方');

    await show(mock.board(), '.cmy-rows');
    evidence.checks.ok = await c.eval(fitsExpr);
    expect(evidence.checks.ok.fits && !evidence.checks.ok.clipped.length, '正常状态出现滚动或被裁：' + JSON.stringify(evidence.checks.ok));
    evidence.checks.okRows = await c.eval(`({podium:document.querySelectorAll('#community-page .pd').length,rows:document.querySelectorAll('#community-page .cmy-row').length})`);
    // 4–20 名共 17 行；我在 20 名外时末尾再加我的一行
    const expectRows = 17 + (mock.board().me.ranks.level > 20 ? 1 : 0);
    expect(evidence.checks.okRows.podium === 3 && evidence.checks.okRows.rows === expectRows, '领奖台或列表行数不对：' + JSON.stringify(evidence.checks.okRows));
    evidence.checks.levelRight = await c.eval(`[...document.querySelectorAll('#community-page .cmy-row .v')].slice(0,3).map(e=>e.textContent)`);
    expect(evidence.checks.levelRight.every(t => !/^Lv\./.test(t)), '等级榜右列仍是 Lv');
    evidence.checks.footer = await c.eval(`(()=>{const f=document.getElementById('community-foot');return f&&!f.hidden&&f.offsetParent?f.textContent.replace(/\\s+/g,' ').trim():''})()`);
    evidence.checks.railDot = await c.eval(`(()=>{const d=document.querySelector('#btn-community .cmy-live');return !!d&&!d.hidden})()`);
    expect(/42/.test(evidence.checks.footer), '底栏没显示在线人数');
    expect(evidence.checks.railDot, '左栏入口没有绿点');
    evidence.checks.navActive = await c.eval(`document.getElementById('btn-community').classList.contains('active')`);
    evidence.checks.petImagesLoaded = await c.eval(`[...document.querySelectorAll('#community-page img')].every(i=>i.complete&&i.naturalWidth>0)`);
    await shot('01-社区页-等级榜');

    const outBoard = Object.keys(mock.board().me.ranks).find(b => mock.board().me.ranks[b] > 20) || 'wtok';
    await clickSel(`#community-page .cmy-tabs [data-cmy-board="${outBoard}"]`);
    await wait(`document.querySelector('#community-page .cmy-gap')`, 'me row after gap');
    evidence.checks.outBoard = outBoard;
    evidence.checks.wtokMine = await c.eval(`document.querySelector('#community-page .cmy-row.me').textContent`);
    expect(evidence.checks.wtokMine.includes(String(mock.board().me.ranks[outBoard])), '不在前 20 时没显示我的名次');
    evidence.checks.wtokFits = await c.eval(fitsExpr);
    await shot('02-社区页-我不在前20的榜');

    await clickSel('#community-page [data-cmy="rename"]');
    await wait(`document.querySelector('#community-page .cmy-nick-input')`, 'rename input');
    await c.eval(`(()=>{const i=document.querySelector('#community-page .cmy-nick-input');i.value='跑仿真的柴犬';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`);
    await wait(`(document.querySelector('#community-page [data-slot="nick"]')||{}).textContent==='跑仿真的柴犬'`, 'renamed');
    evidence.checks.renameCall = await c.eval(`window.__cmyCalls.filter(x=>x[0]==='community:set-nickname')`);
    evidence.checks.renameLine = await c.eval(`document.querySelector('#community-page [data-slot="line"]').textContent`);
    expect(evidence.checks.renameCall.length === 1 && evidence.checks.renameCall[0][1].name === '跑仿真的柴犬', '改昵称没调 community:set-nickname');
    await shot('03-改昵称后');

    await show(mock.hostBoard(), '.cmy-host');
    evidence.checks.host = await c.eval(fitsExpr);
    expect(evidence.checks.host.fits && !evidence.checks.host.clipped.length, '收件机状态出现滚动或被裁：' + JSON.stringify(evidence.checks.host));
    await shot('04-收件机本机-含30天趋势');

    for (const [state, sel, file] of [['few', '.cmy-emptybox', '05-人数不足5人'], ['offline', '.cmy-rows', '06-连不上-显示旧数据'], ['paused', '.cmy-rows', '07-已暂停'], ['outside', '.cmy-emptybox', '08-内网外'], ['bare', '.cmy-rows', '09b-只有基础契约字段'], ['disabled', '.cmy-locked', '09-纯离线-锁定']]) {
      await show(mock.STATES[state](), sel);
      evidence.checks['state_' + state] = { line: await c.eval(`(document.querySelector('#community-page [data-slot="line"]')||{}).textContent||document.querySelector('#community-page .cmy-emptybox')?.textContent`), fits: (await c.eval(fitsExpr)).fits, footerHidden: await c.eval(`!document.getElementById('community-foot')||document.getElementById('community-foot').hidden`) };
      if (state === 'outside' || state === 'disabled') expect(evidence.checks['state_' + state].footerHidden, state + ' 时底栏仍显示在线');
      await shot(file);
    }
    // 纯离线锁定：只有一行字，不给数字、榜单，也没有「重新参与」按钮
    evidence.checks.locked = await c.eval(`(()=>{const p=document.getElementById('community-page');return {text:p.querySelector('.cmy-locked').textContent.trim(),digits:/\d/.test(p.querySelector('.cmy-page').textContent.replace('AI HUB','')),buttons:p.querySelectorAll('button').length}})()`);
    expect(evidence.checks.locked.text === '已开启纯离线模式，社区页不可用。可在 设置 › 高级 中关闭' && !evidence.checks.locked.digits && evidence.checks.locked.buttons === 0, '纯离线锁定页不对：' + JSON.stringify(evidence.checks.locked));
    // 正常状态带 Beta：左栏入口与页标题
    await show(mock.board(), '.cmy-rows');
    evidence.checks.beta = await c.eval(`({rail:document.querySelector('#btn-community .rail-beta')?.textContent,title:document.querySelector('#community-page h1 .cmy-beta')?.textContent})`);
    expect(evidence.checks.beta.rail === 'Beta' && evidence.checks.beta.title === 'Beta', '缺 Beta 标：' + JSON.stringify(evidence.checks.beta));
    await shot('10-正常状态-带Beta');

    // 主进程推摘要：不打开页面也能更新底栏与绿点
    await clickSel('#btn-home');
    await c.eval(`require('electron').ipcRenderer.emit('community:summary', {}, { state: 'ok', online: 57, at: Date.now() })`);
    await sleep(200);
    evidence.checks.summaryEvent = await c.eval(`document.getElementById('community-foot').textContent.replace(/\\s+/g,' ').trim()`);
    expect(/57/.test(evidence.checks.summaryEvent), '摘要事件没更新底栏');
    await shot('10b-底栏在线与左栏绿点');
    // 无感：整个过程中社区页之外没有冒出提示条
    evidence.checks.toastsOutside = await c.eval(`[...document.querySelectorAll('.toast,.hub-toast,#toast,.pf-toast.show')].filter(e=>e.offsetParent&&/社区/.test(e.textContent)).length`);
    expect(evidence.checks.toastsOutside === 0, '社区页之外出现了提示');

    // 点左栏别的入口：社区页收起
    await clickSel('#btn-home');
    await sleep(300);
    evidence.checks.closedByHome = await c.eval(`document.getElementById('community-page').hidden`);
    expect(evidence.checks.closedByHome, '点主页后社区页没收起');

    // 六套主题
    evidence.checks.themes = {};
    await c.eval(installMock(mock.hostBoard()));
    for (const t of THEMES) {
      await c.eval(`document.querySelector('[data-theme-id="${t.id}"]')?.click()`);
      await sleep(400);
      if (await c.eval(`document.getElementById('community-page').hidden`)) await clickSel('#btn-community');
      await wait(`document.querySelector('#community-page .cmy-rows')`, 'theme page');
      const applied = await c.eval(`document.documentElement.dataset.theme`);
      const contrast = await c.eval(contrastExpr);
      const min = Math.min(...Object.values(contrast));
      evidence.checks.themes[t.id] = { applied, minContrast: min, low: Object.entries(contrast).filter(([, v]) => v < 4.5), fits: (await c.eval(fitsExpr)).fits };
      expect(applied === t.id, '主题没切过去：' + t.id);
      expect(min >= 3, `${t.id} 主题有文字对比度低于 3：` + JSON.stringify(evidence.checks.themes[t.id].low));
      await shot('11-主题-' + t.id);
      await c.eval(`document.getElementById('community-page').scrollTop=99999`);
      await shot('11-主题-' + t.id + '-下半屏');
      await c.eval(`document.getElementById('community-page').scrollTop=0`);
    }
  });

  await session(out, evidence, 'en', data => fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ ui: { language: 'en' } }, null, 2)), async ({ c, wait, shot, clickSel, show }) => {
    await wait(`!!document.getElementById('btn-community')`, 'entry button');
    await show(mock.board(), '.cmy-rows');
    await sleep(500);
    evidence.checks.enLeftovers = await c.eval(`(()=>{const w=document.createTreeWalker(document.getElementById('community-page'),NodeFilter.SHOW_TEXT);const out=[];let n;while((n=w.nextNode())){if(/[㐀-鿿]/.test(n.nodeValue)&&!n.parentElement.closest('[data-i18n-skip]'))out.push(n.nodeValue.trim())}const attrs=[...document.querySelectorAll('#community-page [title]')].map(e=>e.getAttribute('title')).filter(t=>/[㐀-鿿]/.test(t)&&!/·/.test(t.slice(0,0)));return {text:[...new Set(out)],attrs:[...new Set(attrs)].slice(0,10)}})()`);
    evidence.checks.enFits = await c.eval(fitsExpr);
    evidence.checks.enEntry = await c.eval(`document.querySelector('#btn-community .btn-label').textContent`);
    expect(!evidence.checks.enLeftovers.text.length, '英文界面有漏翻：' + evidence.checks.enLeftovers.text.join(' | '));
    await shot('12-英文界面');
    await clickSel('#community-page [data-cmy-board="wtok"]');
    await shot('13-英文-本周Token榜');
    await show(mock.hostBoard(), '.cmy-host');
    await shot('14-英文-收件机');
  });

  if (evidence.rendererErrors.length) evidence.failures.push('页面脚本报错：' + evidence.rendererErrors.length + ' 条');
  evidence.ok = evidence.failures.length === 0;
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: evidence.ok, out, failures: evidence.failures, themes: evidence.checks.themes }, null, 2));
  process.exitCode = evidence.ok ? 0 : 1;
}

run().catch(error => { console.error(error); process.exitCode = 1; });
