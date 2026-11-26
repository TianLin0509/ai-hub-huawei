'use strict';
// 「WeLink (Beta)」公共黑板页真界面验收（隔离数据目录、隐藏窗口，1440×900）：
//   1) 左栏「WeLink」入口带 Beta 角标；正常时没有圆点，异常时橙点 / 红点（含 welink-blackboard:changed 推送）；
//   2) 三个子页签各自一屏：页面与内容区都没有纵向滚动、没有横向溢出；
//   3) 多种状态：在线正常、命令行未装、旧版、代理 407、429 冷却倒计时（本地每秒走字）、需扫码＋红区提示、扫码二维码；
//   4) 流水筛选与分页、策略切换、退出登录二次确认（取消不调用，确认才带 { confirmed: true }）；
//   5) 与社区页、主页互斥切换；六套主题逐一截图，核对底色确实取自 --hw-* 变量、关键文字对比度；
//   6) 英文界面（另起一个 ui.language=en 的隔离 Hub）：三个页签与几种异常状态没有漏翻的中文、仍是一屏。
// 数据来源（--mode）：
//   stub —— 主进程已接上 welink-blackboard:* 时，用 WELINK_BLACKBOARD_STUB_FILE 写受控快照（集成后的真实链路）；
// 用法：node tests/e2e-welink-blackboard-cdp.js [--out <目录>] [--mode auto|stub|mock]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const fx = require('./fixtures/welink-blackboard-snapshots');
const REPO = path.resolve(__dirname, '..');
const THEME_CONFIG = require('../core/theme-config');
const THEMES = THEME_CONFIG.THEMES || [];
const DARK = THEME_CONFIG.DARK_THEME_IDS || [];
const DEFAULT_OUT = 'D:\\AIWork\\20261126-hubh-welink-beta\\shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };

// 受控快照里的时间都以 fx.NOW 为基准；写出前整体平移到当前时间，倒计时与「上次同步」才对得上。
const TIME_KEYS = new Set(['updatedAt', 'checkedAt', 'lastAt', 'at', 'until', 'lastSuccessAt']);
function shift(value, delta) {
  if (Array.isArray(value)) return value.map(v => shift(v, delta));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = TIME_KEYS.has(k) && typeof v === 'number' && v > 0 ? v + delta : shift(v, delta);
  return out;
}
const live = snap => shift(snap, Date.now() - fx.NOW);

// 页面里：记录所有 welink-blackboard:* 调用；mock 模式下由替身回答，stub 模式下照常交给主进程。
const installBridge = (mode, snap) => `(()=>{
  const { ipcRenderer } = require('electron');
  if (!ipcRenderer.__wbbOrig) ipcRenderer.__wbbOrig = ipcRenderer.invoke.bind(ipcRenderer);
  window.__wbbCalls = window.__wbbCalls || [];
  window.__wbbSnap = ${JSON.stringify(snap || null)};
  window.__wbbScanning = ${JSON.stringify(live(fx.scanning()))};
  const mock = ${JSON.stringify(mode === 'mock')};
  const clone = o => JSON.parse(JSON.stringify(o));
  ipcRenderer.invoke = (ch, ...a) => {
    if (!String(ch).startsWith('welink-blackboard:')) return ipcRenderer.__wbbOrig(ch, ...a);
    window.__wbbCalls.push([ch, a[0] === undefined ? null : clone(a[0])]);
    if (!mock) return ipcRenderer.__wbbOrig(ch, ...a);
    const name = ch.slice('welink-blackboard:'.length), s = window.__wbbSnap;
    const done = extra => Promise.resolve({ ok: true, snapshot: clone(window.__wbbSnap), ...(extra || {}) });
    if (name === 'snapshot' || name === 'refresh') return done();
    if (name === 'start-login') { window.__wbbSnap = clone(window.__wbbScanning); return done({ flow: window.__wbbSnap.loginFlow }); }
    if (name === 'logout') { if (!a[0] || a[0].confirmed !== true) return Promise.resolve({ ok: false, error: '需要确认后才能退出' }); s.auth.state = 'signed_out'; s.health = 'warning'; s.advice = null; s.loginFlow = null; return done(); }
    if (name === 'update-policy') { s.policy.groupReadMode = a[0].groupReadMode; return done(); }
    if (name === 'clear-cooldown') { s.cooldown = { until: 0, reason: '', caller: '', consecutive: 0 }; s.cooldownRemainingSec = 0; s.advice = null; s.health = 'healthy'; s.auth.state = 'online'; return done(); }
    if (name === 'clear-events') { s.events = []; return done(); }
    if (name === 'install-cli') return done({ result: { ok: true } });
    if (name === 'find-cli') return done({ search: { state: 'found', path: s.cli.path } });
    return Promise.resolve({ ok: false, error: 'mock: unknown ' + ch });
  };
  // 不写系统剪贴板：复制按钮只记下要复制的文字
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: t => { window.__wbbCopied = t; return Promise.resolve(); } } }); } catch {}
  return true;
})()`;

// 一屏检查：页面、内容区都不出纵向滚动与横向溢出；列出被横向挤出的卡片。
const fitsExpr = `(()=>{const p=document.getElementById('welink-blackboard-page');const b=p.querySelector('.wbb-body');const over=[...p.querySelectorAll('.wbb-metric,.wbb-caller,.wbb-card,.wbb-advice,.wbb-head,.wbb-evbar')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className);
  return {pageV:p.scrollHeight-p.clientHeight,bodyV:b?b.scrollHeight-b.clientHeight:0,pageH:p.scrollWidth-p.clientWidth,bodyH:b?b.scrollWidth-b.clientWidth:0,clipped:over,ok:p.scrollHeight<=p.clientHeight+1&&(!b||b.scrollHeight<=b.clientHeight+1)&&p.scrollWidth<=p.clientWidth+1&&(!b||b.scrollWidth<=b.clientWidth+1)&&!over.length,
  bottomGap:b?Math.round(b.getBoundingClientRect().bottom-Math.max(...[...b.children].map(e=>e.getBoundingClientRect().bottom))):null}})()`;

// 主题：页面底色、卡片底色必须等于 --hw-bg / --hw-surface 在当前主题下的值；关键文字对比度。
const themeExpr = `(()=>{
  const probe = v => { const d = document.createElement('i'); d.style.cssText = 'position:fixed;left:-9px;width:1px;height:1px;background:var(' + v + ')'; document.body.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
  const p = document.getElementById('welink-blackboard-page'), card = p.querySelector('.wbb-metric,.wbb-card');
  const rgb = s => { const m = s.match(/[\\d.]+/g).map(Number); const k = /^color\\(srgb/.test(s) ? 255 : 1; return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m.length > 3 ? m[3] : 1 }; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = el => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.a > 0) layers.push(c); if (c.a >= 1) break; }
    let base = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop() : (${JSON.stringify(DARK)}.includes(document.documentElement.dataset.theme) ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 });
    for (const c of layers.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) }; return base; };
  const contrast = {};
  for (const sel of ['.wbb-title h1', '.wbb-status span', '.wbb-tabs button.on', '.wbb-tabs button:not(.on)', '.wbb-k', '.wbb-v', '.wbb-sub', '.wbb-chip.ok', '.wbb-chip.warn', '.wbb-chip.err', '.wbb-caller-h b', '.wbb-caller-s', '.wbb-advice b', '.wbb-btn', '.wbb-btn.p', '.wbb-soft']) {
    const el = p.querySelector(sel); if (!el) continue;
    const a = lum(rgb(getComputedStyle(el).color)), b = lum(bgOf(el));
    contrast[sel] = Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
  }
  return { theme: document.documentElement.dataset.theme, pageBg: getComputedStyle(p).backgroundColor, hwBg: probe('--hw-bg'), cardBg: card ? getComputedStyle(card).backgroundColor : '', hwSurface: probe('--hw-surface'), contrast };
})()`;

async function run() {
  const out = path.resolve(arg('--out', DEFAULT_OUT));
  let mode = arg('--mode', 'auto');
  fs.mkdirSync(out, { recursive: true });
  const evidence = { mode, steps: [], rendererErrors: [], checks: {}, failures: [] };
  const expect = (ok, msg) => { if (!ok) evidence.failures.push(msg); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-welink-bb-')), data = path.join(root, 'data'), stubFile = path.join(root, 'welink-blackboard-stub.json');
  fs.mkdirSync(data, { recursive: true });
  const writeStub = snap => fs.writeFileSync(stubFile, JSON.stringify({ snapshot: live(snap) }, null, 2));
  writeStub(fx.online());
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'welink-blackboard-e2e', extraEnv: {
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js'),
      WELINK_BLACKBOARD_STUB_FILE: stubFile,
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* 不是异常消息 */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* 页面还没好 */ } await sleep(200); } throw Error('Timeout ' + label); };
    const shot = async file => { await sleep(500); fs.writeFileSync(path.join(out, file + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); evidence.steps.push('shot ' + file); };
    const clickSel = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e||e.disabled)return false;e.click();return true})()`);
    const isOpen = () => c.eval(`(()=>{const p=document.getElementById('welink-blackboard-page');return !!p&&!p.hidden})()`);
    const calls = ch => c.eval(`(window.__wbbCalls||[]).filter(x=>x[0]===${JSON.stringify('welink-blackboard:' + ch)})`);
    const tab = async id => { await clickSel(`#welink-blackboard-page [data-wbb-tab="${id}"]`); await wait(`document.querySelector('#welink-blackboard-page .wbb-root[data-tab="${id}"]')`, 'tab ' + id); await sleep(150); };
    // 换一份受控快照并重新打开页面（stub 写文件，mock 换替身数据）
    const show = async (snap, untilSel = '.wbb-root[data-tab]') => {
      if (mode === 'stub') writeStub(snap);
      await c.eval(installBridge(mode, mode === 'mock' ? live(snap) : null));
      if (await isOpen()) await clickSel('#btn-welink-blackboard');
      await clickSel('#btn-welink-blackboard');
      await wait(`document.querySelector('#welink-blackboard-page ${untilSel}')`, 'page ' + untilSel);
      await sleep(200);
    };

    await wait(`!!document.getElementById('btn-welink-blackboard')`, 'entry button');
    if (mode === 'auto') {
      const probe = await c.eval(`require('electron').ipcRenderer.invoke('welink-blackboard:snapshot',{}).then(r=>!!(r&&r.ok&&r.snapshot)).catch(()=>false)`);
      mode = probe ? 'stub' : 'mock';
    }
    evidence.mode = mode;

    // 1) 左栏入口 + 员工助手 Beta / WeLink Beta / 分身 Beta 同屏时在 1440×900 与 1440×800 均完整可见、零滚动
    await wait(`(()=>{const av=document.getElementById('btn-avatar'),wc=document.getElementById('btn-weclaw');return (!av||!av.hidden)&&(!wc||!wc.hidden)})()`, 'async beta rail buttons', 10000).catch(() => {});
    await sleep(300);
    const measureRail = () => c.eval(`(()=>{const b=document.getElementById('btn-welink-blackboard'),r=b.getBoundingClientRect(),cm=document.getElementById('btn-community'),av=document.getElementById('btn-avatar'),wc=document.getElementById('btn-weclaw'),rail=document.getElementById('scene-rail'),nav=rail.querySelector('.rail-navigation'),util=rail.querySelector('.rail-utilities'),rr=rail.getBoundingClientRect(),nr=nav.getBoundingClientRect(),ar=av&&av.offsetParent?av.getBoundingClientRect():null;const visNav=[...nav.querySelectorAll(':scope > .btn-shell-nav, :scope > .rail-group > .rail-group-trigger')].filter(e=>e.offsetParent);const visUtil=[...util.querySelectorAll('button')].filter(e=>e.offsetParent);const clipped=visNav.filter(e=>e.getBoundingClientRect().bottom>nr.bottom+1||e.getBoundingClientRect().top<nr.top-1).map(e=>e.id);const clippedUtil=visUtil.filter(e=>e.getBoundingClientRect().bottom>rr.bottom+1).map(e=>e.id);const pfa=document.querySelector('#btn-profile .pf-avatar'),pfn=document.querySelector('#btn-profile .pf-entry-name');const profileOverlap=pfa&&pfn&&pfn.offsetParent?Math.round(pfa.getBoundingClientRect().bottom-pfn.getBoundingClientRect().top):0;return {visible:r.width>0&&r.height>0,label:b.querySelector('.btn-label').textContent,beta:b.querySelector('.rail-beta')?.textContent,inRail:!!b.closest('#scene-rail .rail-navigation'),weclawVisible:!!(wc&&wc.offsetParent),avatarVisible:!!(av&&av.offsetParent),navCount:visNav.length,utilCount:visUtil.length,top:Math.round(r.top),communityTop:cm&&cm.offsetParent?Math.round(cm.getBoundingClientRect().top):null,avatarClipped:ar?Math.round(ar.bottom-nr.bottom):null,navOverflow:nav.scrollHeight-nav.clientHeight,railOverflow:rail.scrollHeight-rail.clientHeight,profileOverlap,clipped,clippedUtil}})()`);
    evidence.checks.entry = await measureRail();
    expect(evidence.checks.entry.visible && evidence.checks.entry.inRail, '左栏入口不可见：' + JSON.stringify(evidence.checks.entry));
    expect(evidence.checks.entry.label === 'WeLink' && evidence.checks.entry.beta === 'Beta', '入口文字或 Beta 角标不对：' + JSON.stringify(evidence.checks.entry));
    expect(evidence.checks.entry.navOverflow <= 0 && evidence.checks.entry.clipped.length === 0 && evidence.checks.entry.clippedUtil.length === 0 && evidence.checks.entry.profileOverlap <= 0, '1440×900 左栏出现滚动、裁切或重叠：' + JSON.stringify(evidence.checks.entry));
    await shot('00-左栏-1440x900');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    evidence.checks.entry800 = await measureRail();
    expect(evidence.checks.entry800.navOverflow <= 0 && evidence.checks.entry800.clipped.length === 0 && evidence.checks.entry800.clippedUtil.length === 0 && evidence.checks.entry800.profileOverlap <= 0, '1440×800 左栏出现滚动、裁切或重叠：' + JSON.stringify(evidence.checks.entry800));
    await shot('00-左栏-1440x800');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    if (!process.argv.includes('--rail-only')) {

    // 2) 在线正常：三页签一屏
    await show(fx.withEvents(20));
    evidence.checks.dotOnline = await c.eval(`document.querySelector('#btn-welink-blackboard .wbb-dot').hidden`);
    expect(evidence.checks.dotOnline, '正常状态左栏仍有圆点');
    evidence.checks.navCurrent = await c.eval(`(()=>{const b=document.getElementById('btn-welink-blackboard');return b.classList.contains('active')||b.classList.contains('cw-current')})()`);
    expect(evidence.checks.navCurrent, '打开后左栏入口没有高亮');
    evidence.checks.headline = await c.eval(`document.querySelector('#welink-blackboard-page [data-slot="headline"]').textContent`);
    expect(/^一切正常/.test(evidence.checks.headline), '正常状态的状态一句不是「一切正常」：' + evidence.checks.headline);
    evidence.checks.overviewCounts = await c.eval(`({metrics:document.querySelectorAll('#welink-blackboard-page .wbb-metric').length,callers:document.querySelectorAll('#welink-blackboard-page .wbb-caller').length,advice:!!document.querySelector('#welink-blackboard-page .wbb-advice')})`);
    expect(evidence.checks.overviewCounts.metrics === 4 && evidence.checks.overviewCounts.callers === 7 && !evidence.checks.overviewCounts.advice, '总览内容不对：' + JSON.stringify(evidence.checks.overviewCounts));
    evidence.checks.fit = {};
    evidence.checks.fit.overview = await c.eval(fitsExpr);
    await shot('01-总览-在线正常');
    await tab('events');
    evidence.checks.fit.events = await c.eval(fitsExpr);
    evidence.checks.eventsPage1 = await c.eval(`({rows:document.querySelectorAll('#welink-blackboard-page tbody tr').length,pager:document.querySelector('#welink-blackboard-page .wbb-pager span').textContent})`);
    expect(evidence.checks.eventsPage1.rows === 8 && evidence.checks.eventsPage1.pager === '第 1/3 页', '流水第 1 页不对：' + JSON.stringify(evidence.checks.eventsPage1));
    await shot('02-流水-第1页');
    await clickSel('#welink-blackboard-page [data-wbb="page-next"]'); await sleep(150);
    evidence.checks.eventsPage2 = await c.eval(`document.querySelector('#welink-blackboard-page .wbb-pager span').textContent`);
    expect(evidence.checks.eventsPage2 === '第 2/3 页', '下一页没翻过去：' + evidence.checks.eventsPage2);
    await clickSel('#welink-blackboard-page [data-wbb-filter="rate_limited"]'); await sleep(150);
    evidence.checks.eventsLimited = await c.eval(`[...document.querySelectorAll('#welink-blackboard-page tbody .wbb-chip')].map(e=>e.textContent)`);
    expect(evidence.checks.eventsLimited.length > 0 && evidence.checks.eventsLimited.every(t => t === '限流'), '限流筛选不对：' + JSON.stringify(evidence.checks.eventsLimited));
    evidence.checks.fit.eventsFiltered = await c.eval(fitsExpr);
    await shot('03-流水-只看限流');
    await tab('policy');
    evidence.checks.fit.policy = await c.eval(fitsExpr);
    await shot('04-策略与工具');
    for (const [k, v] of Object.entries(evidence.checks.fit)) expect(v.ok, `${k} 页签出现滚动或溢出：` + JSON.stringify(v));

    // 3) 策略切换
    await clickSel('#welink-blackboard-page [data-wbb-policy="conservative_30s"]');
    await wait(`document.querySelector('#welink-blackboard-page [data-wbb-policy="conservative_30s"][aria-checked="true"]')`, 'policy saved');
    evidence.checks.policyCall = await calls('update-policy');
    expect(evidence.checks.policyCall.length === 1 && evidence.checks.policyCall[0][1].groupReadMode === 'conservative_30s', '策略切换没调 update-policy：' + JSON.stringify(evidence.checks.policyCall));
    await clickSel('#welink-blackboard-page [data-wbb="copy-path"]'); await sleep(150);
    evidence.checks.copied = await c.eval(`window.__wbbCopied||''`);
    expect(/welink-blackboard\.json$/.test(evidence.checks.copied), '复制路径没拿到黑板文件路径：' + evidence.checks.copied);
    await shot('05-策略-已切保守模式');

    // 4) 退出登录二次确认：取消不调用，确认才带 confirmed
    await clickSel('#welink-blackboard-page [data-wbb="logout-ask"]');
    await wait(`document.querySelector('#welink-blackboard-page .wbb-dialog')`, 'logout dialog');
    evidence.checks.logoutText = await c.eval(`document.querySelector('#welink-blackboard-page .wbb-dialog p').textContent`);
    expect(/暂停读写 WeLink[\s\S]*邮件和日历/.test(evidence.checks.logoutText), '退出确认文字不对：' + evidence.checks.logoutText);
    evidence.checks.fit.dialog = await c.eval(fitsExpr);
    await shot('06-退出登录-二次确认');
    await clickSel('#welink-blackboard-page .wbb-dialog [data-wbb="logout-cancel"]'); await sleep(150);
    evidence.checks.logoutAfterCancel = (await calls('logout')).length;
    expect(evidence.checks.logoutAfterCancel === 0 && !(await c.eval(`!!document.querySelector('#welink-blackboard-page .wbb-dialog')`)), '取消后仍调用了退出或确认框没收起');

    // 5) 异常状态逐个看：自救条、左栏圆点、一屏
    const STATES = [
      ['cliMissing', fx.cliMissing(), 'err', '07-命令行未安装'],
      ['cliOutdated', fx.cliOutdated(), 'warn', '08-命令行旧版'],
      ['proxy407', fx.proxy407(), 'err', '09-代理407'],
      ['needsScan', fx.needsScan(), 'warn', '10-需要扫码-红区提示'],
    ];
    evidence.checks.states = {};
    for (const [name, snap, dot, file] of STATES) {
      await show(snap);
      const st = await c.eval(`(()=>{const p=document.getElementById('welink-blackboard-page'),a=p.querySelector('.wbb-advice'),d=document.querySelector('#btn-welink-blackboard .wbb-dot');return {advice:a?a.textContent.replace(/\\s+/g,' ').trim():'',kind:a?a.dataset.kind:'',primary:a?.querySelector('.wbb-btn.p')?.textContent||'',dot:d.hidden?'':d.className.replace('wbb-dot','').trim()}})()`);
      st.fit = await c.eval(fitsExpr);
      evidence.checks.states[name] = st;
      expect(!!st.advice && !!st.primary, name + ' 没有自救条或主按钮：' + JSON.stringify(st));
      expect(st.dot === dot, `${name} 左栏圆点应为 ${dot}：` + st.dot);
      expect(st.fit.ok, name + ' 出现滚动或溢出：' + JSON.stringify(st.fit));
      await shot(file);
    }
    expect(/红区无摄像头暂不支持扫码/.test(evidence.checks.states.needsScan.advice), '需扫码时没有红区提示');

    // 6) 扫码：点「扫码登录」后就地展开真实 base64 SVG 二维码并校验图片真正加载（C01）
    await clickSel('#welink-blackboard-page .wbb-advice [data-wbb="act:start-login"]');
    await wait(`document.querySelector('#welink-blackboard-page .wbb-login img')`, 'login panel img');
    evidence.checks.login = await c.eval(`(()=>{const l=document.querySelector('#welink-blackboard-page .wbb-login');const img=l.querySelector('img');return {text:l.textContent.replace(/\\s+/g,' ').trim(),img:!!img,loaded:img?img.complete&&img.naturalWidth>0:null}})()`);
    evidence.checks.loginCall = (await calls('start-login')).length;
    expect(evidence.checks.loginCall >= 1, '扫码登录没调 start-login');
    expect(evidence.checks.login.img && evidence.checks.login.loaded, '二维码图片未真正加载：' + JSON.stringify(evidence.checks.login));
    expect(/红区无摄像头暂不支持扫码/.test(evidence.checks.login.text), '二维码面板没有红区提示');
    evidence.checks.fit.login = await c.eval(fitsExpr);
    expect(evidence.checks.fit.login.ok, '二维码展开后出现滚动：' + JSON.stringify(evidence.checks.fit.login));
    await shot('11-扫码-二维码就地展开');

    // 7) 429 冷却：本地每秒走字，不轮询主进程；主按钮是「重新检测」，点次要按钮弹确认框后才清除
    await show(fx.rateLimited(), '.wbb-advice[data-kind="rate_limited"]');
    const before = await c.eval(`({cd:Number((document.querySelector('#welink-blackboard-page [data-slot="cd"]').textContent.match(/[0-9]+/)||[])[0]),snap:(window.__wbbCalls||[]).filter(x=>/:(snapshot|refresh)$/.test(x[0])).length})`);
    await sleep(2300);
    const after = await c.eval(`({cd:Number((document.querySelector('#welink-blackboard-page [data-slot="cd"]').textContent.match(/[0-9]+/)||[])[0]),snap:(window.__wbbCalls||[]).filter(x=>/:(snapshot|refresh)$/.test(x[0])).length,head:document.querySelector('#welink-blackboard-page [data-slot="headline"]').textContent,dot:document.querySelector('#btn-welink-blackboard .wbb-dot').className})`);
    evidence.checks.cooldown = { before, after };
    expect(before.cd >= 18 && before.cd <= 22 && after.cd <= before.cd - 2, '倒计时没在本地走字：' + JSON.stringify(evidence.checks.cooldown));
    expect(after.snap === before.snap, '冷却期间轮询了主进程：' + JSON.stringify(evidence.checks.cooldown));
    expect(/^限流冷静中 · 剩余 \d+ 秒$/.test(after.head) && /warn/.test(after.dot), '冷却时状态一句或圆点不对：' + JSON.stringify(after));
    evidence.checks.fit.cooldown = await c.eval(fitsExpr);
    await shot('12-429冷却-倒计时');
    await clickSel('#welink-blackboard-page .wbb-advice [data-wbb="act:clear-cooldown"]');
    await wait(`document.querySelector('#welink-blackboard-page .wbb-dialog [data-wbb="cooldown-confirm"]')`, 'cooldown confirm dialog');
    await clickSel('#welink-blackboard-page .wbb-dialog [data-wbb="cooldown-confirm"]');
    await wait(`(window.__wbbCalls||[]).some(x=>x[0]==='welink-blackboard:clear-cooldown')`, 'clear cooldown');
    await shot('13-解除本地冷却后');

    // 8) 推送：changed 事件只改左栏圆点，不打开页面
    await clickSel('#btn-home'); await sleep(300);
    evidence.checks.closedByHome = !(await isOpen());
    expect(evidence.checks.closedByHome, '点主页后黑板页没收起');
    await c.eval(`require('electron').ipcRenderer.emit('welink-blackboard:changed', {}, { health: 'error', badgeCount: 1, cooldownRemainingSec: 0, authState: 'cli_missing' })`);
    await sleep(150);
    evidence.checks.pushDot = await c.eval(`(()=>{const d=document.querySelector('#btn-welink-blackboard .wbb-dot');return {hidden:d.hidden,cls:d.className}})()`);
    expect(!evidence.checks.pushDot.hidden && /err/.test(evidence.checks.pushDot.cls), '推送报错后左栏没有红点：' + JSON.stringify(evidence.checks.pushDot));
    await shot('14-左栏红点');
    await c.eval(`require('electron').ipcRenderer.emit('welink-blackboard:changed', {}, { health: 'healthy', badgeCount: 0, cooldownRemainingSec: 0, authState: 'online' })`);
    await sleep(150);
    expect(await c.eval(`document.querySelector('#btn-welink-blackboard .wbb-dot').hidden`), '恢复正常后左栏圆点没消失');

    // 9) 与社区页互斥
    if (await c.eval(`!!document.getElementById('btn-community')`)) {
      await show(fx.online());
      await clickSel('#btn-community'); await sleep(400);
      evidence.checks.exclusive = await c.eval(`({wbbHidden:document.getElementById('welink-blackboard-page').hidden,community:!!document.getElementById('community-page')&&!document.getElementById('community-page').hidden,bodyCls:document.body.className.includes('welink-blackboard-page-open')})`);
      expect(evidence.checks.exclusive.wbbHidden && !evidence.checks.exclusive.bodyCls, '打开社区后黑板页没收起：' + JSON.stringify(evidence.checks.exclusive));
      await clickSel('#btn-welink-blackboard'); await sleep(400);
      evidence.checks.exclusiveBack = await c.eval(`({wbb:!document.getElementById('welink-blackboard-page').hidden,communityHidden:!document.getElementById('community-page')||document.getElementById('community-page').hidden})`);
      expect(evidence.checks.exclusiveBack.wbb && evidence.checks.exclusiveBack.communityHidden, '打开黑板后社区页没收起：' + JSON.stringify(evidence.checks.exclusiveBack));
    }

    // 10) 六套主题：底色取自变量、对比度、一屏
    evidence.checks.themes = {};
    await show(fx.rateLimited());
    for (const t of THEMES) {
      await c.eval(`document.querySelector('[data-theme-id="${t.id}"]')?.click()`);
      await sleep(400);
      if (!(await isOpen())) await clickSel('#btn-welink-blackboard');
      await wait(`document.querySelector('#welink-blackboard-page .wbb-metric')`, 'theme page');
      const th = await c.eval(themeExpr);
      const min = Math.min(...Object.values(th.contrast));
      th.minContrast = min; th.low = Object.entries(th.contrast).filter(([, v]) => v < 4.5); th.fit = (await c.eval(fitsExpr)).ok;
      evidence.checks.themes[t.id] = th;
      expect(th.theme === t.id, '主题没切过去：' + t.id);
      expect(th.pageBg === th.hwBg && th.cardBg === th.hwSurface, `${t.id} 底色不是 --hw-bg / --hw-surface：` + JSON.stringify({ pageBg: th.pageBg, hwBg: th.hwBg, cardBg: th.cardBg, hwSurface: th.hwSurface }));
      expect(min >= 3, `${t.id} 有文字对比度低于 3：` + JSON.stringify(th.low));
      expect(th.fit, `${t.id} 主题下出现滚动或溢出`);
      await shot('15-主题-' + t.id);
    }
    evidence.checks.toastsOutside = await c.eval(`[...document.querySelectorAll('.toast,.hub-toast,#toast')].filter(e=>e.offsetParent&&/WeLink/.test(e.textContent)).length`);
    }
  } finally {
    try { c?.close?.(); } catch { /* 已断开 */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录留给系统清 */ }
  }
  if (!process.argv.includes('--rail-only')) await englishPass(out, evidence, expect);
  if (evidence.rendererErrors.length) evidence.failures.push('页面脚本报错：' + evidence.rendererErrors.length + ' 条');
  evidence.ok = evidence.failures.length === 0;
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: evidence.ok, mode: evidence.mode, out, entry: evidence.checks.entry, entry800: evidence.checks.entry800, failures: evidence.failures }, null, 2));
  process.exitCode = evidence.ok ? 0 : 1;
}

// 英文界面：另起一个隔离 Hub（config 里 ui.language=en），三个页签与几种异常状态逐个看有没有漏翻的中文（data-i18n-skip 里的账号、路径、命令除外）。
async function englishPass(out, evidence, expect) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-welink-bb-en-')), data = path.join(root, 'data'), stubFile = path.join(root, 'welink-blackboard-stub.json');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ ui: { language: 'en' } }, null, 2));
  const writeStub = snap => fs.writeFileSync(stubFile, JSON.stringify({ snapshot: live(snap) }, null, 2));
  writeStub(fx.online());
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'welink-blackboard-e2e-en', extraEnv: {
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js'), WELINK_BLACKBOARD_STUB_FILE: stubFile,
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push('en: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); } catch { /* 不是异常消息 */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* 页面还没好 */ } await sleep(200); } throw Error('Timeout ' + label); };
    const shot = async file => { await sleep(500); fs.writeFileSync(path.join(out, file + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); evidence.steps.push('shot ' + file); };
    const clickSel = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e||e.disabled)return false;e.click();return true})()`);
    await wait(`!!document.getElementById('btn-welink-blackboard')`, 'en entry button');
    const mode = evidence.mode;
    const leftovers = `(()=>{const p=document.getElementById('welink-blackboard-page');const w=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);const out=[];let n;while((n=w.nextNode())){if(/[㐀-鿿]/.test(n.nodeValue)&&!n.parentElement.closest('[data-i18n-skip]'))out.push(n.nodeValue.trim())}
      const attrs=[...p.querySelectorAll('[title],[aria-label],[alt]')].filter(e=>!e.closest('[data-i18n-skip]')).flatMap(e=>['title','aria-label','alt'].map(a=>e.getAttribute(a)||'')).filter(t=>/[㐀-鿿]/.test(t));
      const rail=document.getElementById('btn-welink-blackboard');return {text:[...new Set(out)],attrs:[...new Set(attrs)],rail:rail.querySelector('.btn-label').textContent,railTitle:rail.title}})()`;
    evidence.checks.english = {};
    const cases = [['online', fx.withEvents(20)], ['cliMissing', fx.cliMissing()], ['rateLimited', fx.rateLimited()], ['scanning', fx.scanning()]];
    for (const [name, snap] of cases) {
      if (mode === 'stub') writeStub(snap);
      await c.eval(installBridge(mode, mode === 'mock' ? live(snap) : null));
      if (await c.eval(`(()=>{const p=document.getElementById('welink-blackboard-page');return !!p&&!p.hidden})()`)) await clickSel('#btn-welink-blackboard');
      await clickSel('#btn-welink-blackboard');
      await wait(`document.querySelector('#welink-blackboard-page .wbb-root[data-tab]')`, 'en page ' + name);
      for (const tabId of name === 'online' ? ['overview', 'events', 'policy'] : ['overview']) {
        await clickSel(`#welink-blackboard-page [data-wbb-tab="${tabId}"]`);
        await wait(`document.querySelector('#welink-blackboard-page .wbb-root[data-tab="${tabId}"]')`, 'en tab ' + tabId);
        if (tabId === 'policy') { await clickSel('#welink-blackboard-page [data-wbb="logout-ask"]'); await wait(`document.querySelector('#welink-blackboard-page .wbb-dialog')`, 'en dialog'); }
        await sleep(400);
        const r = await c.eval(leftovers);
        r.fit = (await c.eval(fitsExpr)).ok;
        evidence.checks.english[name + '-' + tabId] = r;
        expect(!r.text.length && !r.attrs.length, `英文界面 ${name}/${tabId} 有漏翻：` + [...r.text, ...r.attrs].join(' | '));
        expect(r.fit, `英文界面 ${name}/${tabId} 出现滚动或溢出`);
        await shot(`16-英文-${name}-${tabId}`);
        if (tabId === 'policy') await clickSel('#welink-blackboard-page .wbb-dialog [data-wbb="logout-cancel"]');
      }
    }
  } finally {
    try { c?.close?.(); } catch { /* 已断开 */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录留给系统清 */ }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
