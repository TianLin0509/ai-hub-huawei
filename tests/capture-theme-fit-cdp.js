'use strict';
// 新外观 × 6 个主题：逐个主题冷启动（写 hub.theme 再重载，与用户重开应用一致），拍主要页面并在页面内统计
// ① 正文文字（颜色等于该主题 --hw-text-1 / --hw-text-2 的文字）与实际背景的对比度；
// ② 深色主题里落在新外观区域的大块浅色背景（写死的浅色）。
// 隔离数据、后台离屏窗口、假 CodeAgent，不调模型。--entry 可指向改前的检出（如 v5.5.6）拍对照。
// 用法：node tests/capture-theme-fit-cdp.js [--entry <检出>] [--out <目录>] [--themes codex,dark] [--pages home,session]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const THEMES = ['codex', 'hub', 'claude', 'slate', 'dark', 'frost'];
const PAGES = ['home', 'session', 'accounts', 'meeting', 'progress', 'settings'];
const DARK = new Set(['dark', 'frost']);

function parseArgs(argv) {
  const opt = { entry: REPO, out: path.join(REPO, 'artifacts', 'theme-fit-' + Date.now()), themes: THEMES, pages: PAGES, width: 1440, height: 900 };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, ''), v = argv[i + 1];
    if (k === 'themes' || k === 'pages') opt[k] = v.split(','); else if (k === 'width' || k === 'height') opt[k] = Number(v); else opt[k] = path.resolve(v);
  }
  return opt;
}

// 页面内：对比度与浅色块普查（只看新外观区域：左栏、会话栏、对话区、输入区、问一下、额度栏、各公司页面主体）。
function census({ dark }) {
  const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  // 计算样式里的颜色有两种写法：rgb()/rgba()（0–255），以及 color-mix 推导出的 color(srgb r g b / a)（0–1）；透明度可能写成百分比。
  const num = t => (t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t));
  const parse = s => {
    s = s || '';
    let m = /rgba?\(([^)]+)\)/.exec(s);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(num); return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]]; }
    m = /color\(srgb\s+([^)]+)\)/.exec(s);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(num); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] == null ? 1 : p[3]]; }
    return null;
  };
  const probe = document.createElement('i'); document.body.append(probe);
  const resolve = v => { probe.style.color = `var(${v})`; const c = getComputedStyle(probe).color; return c; };
  // 主题里两个角色颜色相同时（如深色主题主文字与按钮字都是白），按钮字记作 text-on。
  const roles = { [resolve('--hw-text-2')]: 'text-2', [resolve('--hw-text-on')]: 'text-on', [resolve('--hw-text-1')]: 'text-1' };
  probe.remove();
  const blend = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const bgOf = el => {
    const stack = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) { stack.push(c); if (c[3] >= 1) break; } }
    let col = [255, 255, 255, 1]; if (dark) col = [0, 0, 0, 1];
    for (let i = stack.length - 1; i >= 0; i--) col = blend(stack[i], col);
    return col;
  };
  const scopes = ['.scene-rail,#scene-rail', '#sidebar,.sidebar', '#terminal-panel', '.ask', '#account-quota-panel', '#codeagent-accounts-page', '#company-meeting-page,.company-meeting', '#progress-panel', '#options-panel,.options-panel,#options-modal', '.status-footer,#status-footer'];
  const inScope = el => scopes.some(s => el.closest(s));
  const low = [], light = [];
  let checked = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (!el.getClientRects().length || !inScope(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect(); if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    // 头像首字：白字落在模块色上，是装饰性标签，模块色不随主题变，不计。
    const avatar = /(^|[\s-])(avatar|qp-av|model-logo)|-av(\s|$)/.test(String(el.className));
    if (own && roles[cs.color] && !avatar) {
      checked++;
      const fg = parse(cs.color), bg = bgOf(el), f = fg[3] < 1 ? blend(fg, bg) : fg;
      const L1 = lum(f), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      if (ratio < 4.5) low.push({ role: roles[cs.color], ratio: +ratio.toFixed(2), text: el.textContent.trim().slice(0, 24), cls: String(el.className).slice(0, 60), fg: cs.color, bg: `rgb(${bg.slice(0, 3).map(Math.round)})` });
    }
    if (dark) {
      const c = parse(cs.backgroundColor);
      // 只抓灰白类浅色（饱和度低）：品牌色按钮、状态色进度条是有意的彩色填充，不算写死的浅色。
      const sat = c ? (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / Math.max(1, Math.max(c[0], c[1], c[2])) : 0;
      if (c && c[3] > 0.6 && lum(c) > 0.45 && sat < 0.25 && r.width * r.height > 1500 && !/^(IMG|svg|VIDEO|CANVAS)$/i.test(el.tagName)) light.push({ cls: String(el.className).slice(0, 60), id: el.id, bg: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  return { checked, low: low.slice(0, 40), lowCount: low.length, light: light.slice(0, 40), lightCount: light.length };
}

async function run(opt) {
  fs.mkdirSync(opt.out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-theme-fit-')), data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal');
  for (const dir of [data, work, personal, path.join(root, 'scan')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'theme-personal', expiresAt: Date.now() + 86400000 } }));
  try {
    const pool = require(path.join(opt.entry, 'core/codeagent-pool')), quota = require(path.join(opt.entry, 'core/codeagent-quota'));
    for (const [note, pct] of [['算法研发', 83], ['日常工作', 42], ['额度暂停', 0]]) {
      const id = pool.addAccount(data, { note }); const dir = pool.accountDir(data, id); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: id, expiresAt: Date.now() + 86400000 } }));
      quota.recordCredit(data, id, { remaining: pct * 10, total: 1000, pct, bucket: 'monthly' });
      if (pct === 0) quota.markAvoid(data, id, { source: 'quota', kind: 'credit', reason: '额度用完', until: Date.now() + 3600000 });
    }
  } catch (error) { console.warn('pool seed skipped:', error.message); }
  const result = { entry: opt.entry, themes: opt.themes, pages: opt.pages, shots: [], errors: [] };
  const save = () => fs.writeFileSync(path.join(opt.out, 'theme-fit.json'), JSON.stringify(result, null, 2));
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: opt.entry, cwd: opt.entry, dataDir: data, port: await freePort(), windowMode: 'background', label: 'theme-fit', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'), CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'),
      CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    const wait = async (expr, label, timeout = 30000) => {
      for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* reload */ } await sleep(150); }
      throw Error('Timeout ' + label);
    };
    const ready = 'typeof selectSession === "function"';
    await wait(ready, 'renderer ready');
    let sessionId = null;
    for (const theme of opt.themes) {
      await c.eval(`localStorage.setItem('hub.theme',${JSON.stringify(theme)})`);
      await c.send('Page.reload', {}); await sleep(1200);
      await wait(ready + ` && document.documentElement.dataset.theme===${JSON.stringify(theme)}`, 'theme ' + theme);
      await c.send('Emulation.setDeviceMetricsOverride', { width: opt.width, height: opt.height, deviceScaleFactor: 1, mobile: false });
      await sleep(800);
      for (const page of opt.pages) {
        try {
          await c.eval(`(()=>{document.querySelector('#btn-home')?.click();try{window.__askAsideUi&&window.__askAsideUi.hide()}catch{}})()`); await sleep(300);
          if (page === 'session') {
            if (!sessionId) { const created = await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind: 'codeagent', opts: { cwd: work, title: '周期方案重构', codeagentAccount: 'personal' } })})`); sessionId = created.id; }
            const sid = JSON.stringify(sessionId);
            await c.eval(`selectSession(${sid})`);
            await wait(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'session visible');
            await c.eval(`(()=>{try{window.isSessionCardWorking=()=>true;_updateStreamingIndicator(${sid})}catch{}})()`);
            if (await c.eval('!!window.__askAsideUi')) {
              await c.eval('window.__askAsideUi.open()'); await sleep(1200);
              const at = new Date(Date.now() - 120000).toISOString();
              await c.eval(`ipcRenderer.emit('ask-aside:changed',{},${JSON.stringify({ sessionId, supported: true, account: 'personal', items: [
                { id: 'q0', q: '现在卡在哪？', a: '没有卡住。正在跑 `npm test` 的第二组，前面 412 条都过了。\n\n剩下的是会议页的端到端测试，通常 2 分钟左右。', status: 'done', at, wall_s: 41 },
                { id: 'q1', q: '还要多久？', status: 'running', at, startedAt: at }] })})`);
            }
          } else if (page === 'accounts') { await c.eval(`document.querySelector('#btn-rail-accounts')?.click()`); }
          else if (page === 'meeting') { await c.eval(`document.querySelector('#btn-company-meeting')?.click()`); }
          else if (page === 'progress') { await c.eval(`document.querySelector('#btn-progress')?.click()`); }
          else if (page === 'settings') { await c.eval(`document.querySelector('#btn-options')?.click()`); }
          await sleep(1200);
          const file = `${theme}-${page}-${opt.width}.png`;
          fs.writeFileSync(path.join(opt.out, file), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
          const stats = await c.eval(`(${census.toString()})(${JSON.stringify({ dark: DARK.has(theme) })})`);
          result.shots.push({ theme, page, file, ...stats });
          console.log(theme, page, 'checked', stats.checked, 'low', stats.lowCount, 'light', stats.lightCount);
          if (page === 'settings') { for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); }
        } catch (error) { result.errors.push({ theme, page, error: error.message }); console.log(theme, page, 'ERROR', error.message); }
        save();
      }
    }
    result.ok = true;
  } catch (error) { result.error = error.stack; console.error(error.stack); process.exitCode = 1; }
  finally {
    if (hub) { try { await gracefulQuit(hub); } catch { /* best effort */ } hub.child?.stdout?.destroy(); hub.child?.stderr?.destroy(); hub.child?.stdin?.destroy(); }
    try { await c?.close(); } catch { /* closed */ }
    save(); console.log('OUT ' + opt.out);
  }
  return result;
}

module.exports = { census, run, THEMES, PAGES };
if (require.main === module) run(parseArgs(process.argv.slice(2)));
