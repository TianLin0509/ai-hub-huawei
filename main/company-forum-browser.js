'use strict';
// 「论坛」页的浏览器（2026-10-18，公司真机回执 Q-1018-01）：两个公司社区都是前端渲染的单页应用，内网单点登录记在浏览器里，
// 直接请求只拿到空壳、接口回「未登录」。所以 Hub 开一个看不见的窗口去打开首页，像人打开浏览器一样：
//   - 登录状态存在 Hub 自己的浏览器分区 persist:company-forum（数据目录里），不碰用户的 Chrome / Edge，也不和 CodeAgent 的抓取工具抢同一个浏览器资料；
//   - 用调试协议截下页面取数据的 JSON 响应（帖子编号、阅读、回复都在里面），再收页面上的帖子链接和指定板块的文字；
//   - 等页面「安定」（正文长度连续两次不变）再收，不是固定等几秒——固定等待在公司实测过同一页一次 3122 字、一次 189 字；
//   - 没登录时由用户点「登录」弹出同一分区的可见窗口，回到站点首页且不再是登录页就自动关掉。
// 后台抓取窗口挂在隐藏宿主下（同桌宠）；用户主动打开的登录窗口独立显示并取得焦点。
const LOGIN_WORDS = /账号登录|扫码登录|密码登录|统一身份认证|统一认证|请输入(?:账号|密码|工号)|忘记密码/;
const delay = ms => new Promise(r => setTimeout(r, ms));
// 页面在哪、是不是登录页（备用路线 evaluate 用；判法同无头 Edge 那条）。
const PAGE_STATE = `(() => { const t = document.body ? document.body.innerText : '';
  return { host: location.host, href: location.origin + location.pathname, ready: document.readyState,
    hasPassword: !!document.querySelector('input[type=password]'), hasQr: /扫码登录|二维码/.test(t.slice(0, 3000)) }; })()`;

// 在页面里执行：收帖子链接、指定板块的链接和文字行。
function collectScript(sections) {
  return `(() => {
    const wanted = ${JSON.stringify(sections || [])};
    const txt = el => (el && (el.innerText || el.textContent) || '').replace(/[ \\t\\u00a0]+/g, ' ').trim();
    const one = s => s.replace(/\\s+/g, ' ').trim();
    const abs = a => { try { return new URL(a.getAttribute('href'), location.href).href; } catch (e) { return ''; } };
    const linkOf = a => ({ href: abs(a), text: one(txt(a)).slice(0, 300) });
    const links = [...document.querySelectorAll('a[href]')].map(linkOf).filter(l => l.href && l.text.length >= 4);
    const all = [...document.querySelectorAll('body *')];
    const heads = wanted.map(heading => all.find(e => e.children.length <= 3 && one(txt(e)) === heading) || all.find(e => e.children.length <= 3 && one(txt(e)).startsWith(heading) && one(txt(e)).length <= heading.length + 10));
    const sections = wanted.map((heading, index) => {
      const head = heads[index];
      if (!head) return { heading, found: false, links: [], lines: [] };
      let box = head;
      for (let i = 0; i < 6 && box && box.parentElement; i += 1) {
        const next = box.parentElement;
        // 少于五条时也不能爬到另一个排行的共同祖先，否则两榜会收成同一批链接。
        if (heads.some(other => other && other !== head && next.contains(other))) break;
        box = next;
        if (box.querySelectorAll('a[href]').length >= 5 || txt(box).split('\\n').filter(Boolean).length >= 8) break;
      }
      const boxLinks = box ? [...box.querySelectorAll('a[href]')].map(linkOf).filter(l => l.href && l.text.length >= 4) : [];
      const lines = box ? txt(box).split('\\n').map(one).filter(s => s && s !== heading).slice(0, 60) : [];
      return { heading, found: true, links: boxLinks.slice(0, 60), lines };
    });
    const body = one(txt(document.body));
    return { finalUrl: location.href, title: document.title, textLength: body.length, text: body.slice(0, 6000), links: links.slice(0, 400), sections };
  })()`;
}
// 点页面上文字正好是 text 的那个元素（稼先首页的「热点」tab）。
function clickScript(text) {
  return `(() => {
    const want = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll('a,button,li,span,div,[role=tab]')].filter(e => (e.innerText || '').trim() === want);
    const el = els.find(e => e.offsetParent !== null) || els[0];
    if (!el) return false;
    el.scrollIntoView({ block: 'center' }); el.click(); return true;
  })()`;
}
// 帖子详情：取正文块（字数最多、又不是整页的那个元素）。
const DETAIL_SCRIPT = `(() => {
  const txt = el => (el && (el.innerText || '') || '').replace(/\\s+/g, ' ').trim();
  const body = txt(document.body);
  let best = null, bestLen = 0;
  for (const el of document.querySelectorAll('article,main,section,div')) {
    const n = txt(el).length;
    if (n > bestLen && n < body.length * 0.95 && el.querySelectorAll('a').length < n / 40) { best = el; bestLen = n; }
  }
  const text = bestLen > 200 ? txt(best) : body;
  return { finalUrl: location.href, title: document.title, textLength: body.length, text: text.slice(0, 8000) };
})()`;

function createForumBrowser({ BrowserWindow, BaseWindow = null, session = null, partition = 'persist:company-forum', logger = console, loginCheck = null } = {}) {
  let owner = null, loginWin = null, loginSite = '', busy = Promise.resolve();
  // 登录体检（core/company-forum/cookie-health.js）：只记 cookie 个数与剩余有效期；不等它、出错也不影响取数和登录。
  const checkLogin = (stage, url, opts) => { try { if (loginCheck && session) void loginCheck.record(session.fromPartition(partition), stage, url, opts); } catch { /* 体检不影响主流程 */ } };
  function ensureOwner() {
    if (!BaseWindow) return null;
    if (owner && !owner.isDestroyed?.()) return owner;
    try {
      owner = new BaseWindow({ show: false, width: 1, height: 1, frame: false, skipTaskbar: true, focusable: false, resizable: false, title: 'AI Hub 论坛宿主' });
      owner.on?.('closed', () => { owner = null; });
    } catch (error) { owner = null; logger.warn?.('[company-forum] owner window failed:', error && error.message); }
    return owner;
  }
  function makeWindow({ show = false, title = 'AI Hub 论坛' } = {}) {
    const parent = show ? null : ensureOwner();
    const win = new BrowserWindow({
      ...(parent ? { parent } : {}), show, width: 1400, height: 900, title, autoHideMenuBar: true,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    win.webContents.setAudioMuted?.(true);
    // 站点弹新窗口（比如帖子在新标签打开）：在同一个窗口里跳过去，不另开。
    win.webContents.setWindowOpenHandler?.(({ url }) => { if (/^https?:/i.test(url)) void win.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    if (show) { win.show(); win.focus(); }
    return win;
  }
  // 截下页面取数据的 JSON 响应（只收网址匹配 api 的，单个最多 3MB）。
  function tap(win, api) {
    const out = [], pending = new Map(), dbg = win.webContents.debugger;
    const ownsDebugger = !dbg.isAttached();
    try { if (ownsDebugger) dbg.attach('1.3'); } catch (error) { logger.warn?.('[company-forum] debugger attach failed:', error.message); return { out, ready: Promise.resolve(), stop() {} }; }
    const onMessage = (_e, method, params) => {
      if (method === 'Network.responseReceived') {
        const r = params.response || {};
        if (/json/i.test(r.mimeType || '') && (!api || api.test(r.url || ''))) pending.set(params.requestId, { url: r.url, status: r.status });
      } else if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
        const meta = pending.get(params.requestId); pending.delete(params.requestId);
        if (params.encodedDataLength > 3e6) return;
        dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then(({ body, base64Encoded }) => {
          const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
          try { out.push({ ...meta, json: JSON.parse(text) }); } catch { /* 不是 JSON */ }
        }).catch(() => {});
      }
    };
    dbg.on('message', onMessage);
    const ready = dbg.sendCommand('Network.enable').catch(() => {});
    return { out, ready, stop() { try { dbg.removeListener('message', onMessage); if (ownsDebugger) dbg.detach(); } catch { /* 窗口已关 */ } } };
  }
  // 页面在跳转（比如单点登录的重定向）时，正在执行的脚本可能永远不返回（Electron 已知行为）：每次最多等 5 秒，当作没取到。
  const within = (p, ms, fallback) => Promise.race([p, delay(ms).then(() => fallback)]);
  async function run(win, script) { try { return await within(win.webContents.executeJavaScript(script, true), 5000, null); } catch { return null; } }
  // 等页面安定：正文长度连续两次（间隔 1.5 秒）不变且不为空，最多 maxMs。
  async function settle(win, { minMs = 2500, maxMs = 25000 } = {}) {
    const start = Date.now();
    let last = -1, same = 0;
    await delay(minMs);
    while (Date.now() - start < maxMs) {
      const n = await run(win, 'document.body ? document.body.innerText.length : 0');
      if (typeof n === 'number' && n > 0 && n === last) { same += 1; if (same >= 2) return; } else same = 0;
      last = n;
      await delay(1500);
    }
  }
  async function load(win, url) {
    // 单页应用的跳转、单点登录的重定向常让 loadURL 报 ERR_ABORTED，页面其实在继续加载：不当失败。
    // 一直没加载完（网络卡住）也不无限等：30 秒后照常往下，页面安定与否由 settle 判断。
    try { await within(win.loadURL(url), 30000, null); } catch (error) { if (!/ERR_ABORTED|ERR_FAILED \(-2\)/.test(String(error.message))) throw error; }
  }
  // 一次只开一个窗口，排队执行。
  function serial(fn) { const p = busy.then(fn, fn); busy = p.catch(() => {}); return p; }

  // loginGraceMs：单点登录常先显示几秒登录页再自动跳回（公司考勤约 5–10 秒），登录页要连续停留这么久才判「需要登录」。
  function capture({ url, base = '', clickText = '', clickUnless = null, sections = [], api = null, maxMs = 25000, loginGraceMs = 0 }) {
    return serial(async () => {
      const win = makeWindow();
      const t = tap(win, api);
      try {
        await within(t.ready, 5000, null);
        await load(win, url);
        await settle(win, { maxMs });
        let page = await run(win, collectScript(sections));
        const onLogin = (p) => !!p && LOGIN_WORDS.test(String(p.text).slice(0, 3000)) && p.textLength < 4000;
        if (onLogin(page) && loginGraceMs > 0) {
          const since = Date.now();
          while (onLogin(page) && Date.now() - since < loginGraceMs) { await delay(2000); page = await run(win, collectScript(sections)) || page; }
          if (!onLogin(page)) { await settle(win, { minMs: 1000, maxMs }); page = await run(win, collectScript(sections)) || page; }
        }
        // 论坛经统一登录入口进站时 url 是登录入口、base 才是目标站：体检按目标站分组（审查 P2）。
        if (onLogin(page)) { checkLogin('needs-login', base || url); return { ...page, needsLogin: true, json: [] }; }
        const haveData = clickUnless && t.out.some(r => clickUnless.test(String(r.url)));
        if (clickText && !haveData && await run(win, clickScript(clickText))) { await settle(win, { minMs: 2000, maxMs: 15000 }); page = await run(win, collectScript(sections)) || page; }
        await delay(300); // 最后几个接口的响应体
        return { ...(page || { finalUrl: win.webContents.getURL(), textLength: 0, text: '', links: [], sections: [] }), needsLogin: false, json: t.out.slice(0, 80) };
      } finally { t.stop(); if (!win.isDestroyed()) win.destroy(); }
    });
  }
  function detail({ url, api = null, maxMs = 20000 }) {
    return serial(async () => {
      const win = makeWindow();
      const t = tap(win, api);
      try {
        await within(t.ready, 5000, null);
        await load(win, url);
        await settle(win, { maxMs });
        const page = await run(win, DETAIL_SCRIPT) || { text: '', textLength: 0 };
        return { ...page, needsLogin: LOGIN_WORDS.test(String(page.text).slice(0, 2000)) && page.textLength < 4000, json: t.out.slice(0, 20) };
      } finally { t.stop(); if (!win.isDestroyed()) win.destroy(); }
    });
  }
  // 在隐藏窗口里打开 url，落到 readyUrl 且加载完后执行页面内的异步脚本 script，accept 通过才算数（门户待办的备用路线，2026-11-20）。
  // 返回值和无头 Edge 那条（company-edge-capture.js 的 runInEdge）同形：{ ok, value, needsLogin, error, finalHost, tookMs, via:'hub' }。
  // 用 Hub 自己的窗口和登录分区，不拉起任何浏览器进程；和论坛、考勤同一个排队，同一时刻只有一个窗口，结束即销毁。
  function evaluate({ url, readyUrl, script, accept = null, signal = null, maxMs = 90000, loginGraceMs = 15000, pollMs = 700 }) {
    return serial(async () => {
      const started = Date.now();
      if (signal?.aborted) return { ok: false, via: 'hub', value: null, needsLogin: false, error: '已取消', finalHost: '', tookMs: 0 };
      const result = { ok: false, via: 'hub', value: null, needsLogin: false, error: '', finalHost: '', tookMs: 0 };
      const win = makeWindow();
      // 取消（功能被关掉）：立刻销毁窗口，正在等的加载或查询也不再等（复审 #1）。
      const CANCEL = Symbol('cancel');
      let onAbort = null;
      const cancelled = new Promise((r) => { onAbort = () => { if (!win.isDestroyed()) win.destroy(); r(CANCEL); }; signal?.addEventListener?.('abort', onAbort, { once: true }); });
      const step = (p) => Promise.race([p, cancelled]);
      try {
        if (await step(load(win, url)) === CANCEL) throw CANCEL;
        let loginSince = 0, lastError = '';
        while (Date.now() - started < maxMs && !result.ok) {
          await delay(pollMs);
          if (win.isDestroyed()) { lastError = 'Hub 窗口被关掉了'; break; }
          const st0 = await step(run(win, PAGE_STATE));
          if (st0 === CANCEL) throw CANCEL;
          const st = st0 || {};
          if (st.host) result.finalHost = st.host;
          const onTarget = readyUrl.test(String(st.href || ''));
          if (st.hasPassword || (st.hasQr && !onTarget)) {
            loginSince = loginSince || Date.now();
            if (Date.now() - loginSince >= loginGraceMs) break;
            continue;
          }
          loginSince = 0;
          if (!onTarget || st.ready !== 'complete') continue;
          let value;
          try { value = await step(within(win.webContents.executeJavaScript(script, true), Math.max(5000, maxMs - (Date.now() - started)), undefined)); } catch (error) { lastError = '页面里的查询出错：' + String(error.message).slice(0, 160); continue; }
          if (value === CANCEL || signal?.aborted) throw CANCEL;
          if (value === undefined) { lastError = '页面里的查询超时'; break; }
          if (value == null) { lastError = '页面里的查询没有返回内容'; continue; }
          if (typeof accept === 'function' && !accept(value)) { lastError = '页面还没登录好'; continue; }
          result.value = value; result.ok = true;
        }
        if (signal?.aborted) throw CANCEL;
        if (!result.ok) {
          result.needsLogin = !!loginSince || lastError === '页面还没登录好';
          if (result.needsLogin) checkLogin('needs-login', url);
          result.error = result.needsLogin ? `需要登录（停在 ${result.finalHost || '登录页'}）` : (lastError || `页面没有打开（停在 ${result.finalHost || '空白页'}）`);
        }
      } catch (error) {
        // 取消不是「要登录」：不能让服务层据此作废保存的登录（复审 #2）。
        if (error === CANCEL) Object.assign(result, { ok: false, value: null, needsLogin: false, cancelled: true, error: '已取消' });
        else result.error = error.message;
      } finally { signal?.removeEventListener?.('abort', onAbort); if (!win.isDestroyed()) win.destroy(); }
      result.tookMs = Date.now() - started;
      return result;
    });
  }
  // 登录：可见窗口，用户自己登录；回到站点且页面不再是登录页（连续 3 秒）就关掉并返回 ok。用户关窗返回 ok:false。
  // doneScript（可选）：页面内脚本返回 true 才算登录好（门户用账号查询判定，比看页面文字准）；不传时按页面文字判，和原来一样。
  function login({ url, base, site = '', title = '登录（AI Hub 论坛）', timeoutMs = 10 * 60000, doneScript = '' }) {
    if (loginWin && !loginWin.isDestroyed()) { loginWin.show(); loginWin.focus(); return Promise.resolve({ ok: false, reason: 'already-open', site: loginSite }); }
    const want = (() => { try { return new URL(base || url).host; } catch { return ''; } })();
    const win = loginWin = makeWindow({ show: true, title });
    loginSite = site;
    return new Promise(resolve => {
      let done = false, okSince = 0, checking = false;
      const finish = (ok, error = '') => { if (done) return; done = true; clearInterval(timer); if (!win.isDestroyed()) win.destroy(); loginWin = null; loginSite = ''; resolve(error ? { ok, error } : { ok }); };
      win.on('closed', () => finish(false));
      win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) finish(false, '登录页面没打开：' + description);
      });
      const started = Date.now();
      // 每秒查一次；上一次还没查完（机器忙时页面脚本可能要几秒）就跳过这一拍，不叠着查（2026-11-20 压测：重叠的检查互相把「连续 3 秒」清零）。
      const timer = setInterval(async () => {
        if (checking) return;
        checking = true;
        try { await tick(); } finally { checking = false; }
      }, 1000);
      async function tick() {
        if (win.isDestroyed()) return finish(false);
        if (Date.now() - started > timeoutMs) return finish(false, '登录超时，请重试');
        let host = '';
        try { host = new URL(win.webContents.getURL()).host; } catch { /* 还没加载 */ }
        let fine;
        if (doneScript) fine = host === want && await run(win, doneScript) === true;
        else {
          const page = host === want ? await run(win, '({ n: document.body ? document.body.innerText.length : 0, t: document.body ? document.body.innerText.slice(0, 3000) : "" })') : null;
          fine = page && page.n > 60 && !(LOGIN_WORDS.test(page.t) && page.n < 4000);
        }
        if (win.isDestroyed() || done) return;
        if (!fine) { okSince = 0; return; }
        if (!okSince) okSince = Date.now();
        if (Date.now() - okSince >= 3000) { checkLogin('login-ok', base || url, { flush: true }); finish(true); }
      }
      void load(win, url).catch(error => { logger.warn?.('[company-forum] login load', error.message); finish(false, '登录页面没打开：' + error.message); });
    });
  }
  function close() { try { if (loginWin && !loginWin.isDestroyed()) loginWin.destroy(); } catch { /* 已关 */ } try { if (owner && !owner.isDestroyed?.()) owner.destroy?.(); } catch { /* 已关 */ } }
  // 退出登录：清掉这个分区里的登录状态。
  async function clearLogin() { if (!session) return; await session.fromPartition(partition).clearStorageData(); }
  return { capture, detail, evaluate, login, close, clearLogin };
}

module.exports = { createForumBrowser, collectScript, clickScript, DETAIL_SCRIPT };
