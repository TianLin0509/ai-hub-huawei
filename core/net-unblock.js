'use strict';
// 公司网络放行页自动点击：公司代理隔一段时间要求在网页上点一次「继续访问 / 我已知晓」，
// 在那之前 AI HUB 访问自家阿里云服务（检查更新、一键反馈等）只能拿到放行页。
// 由 Hub 在本机开一个看不见的窗口打开放行页，找到放行按钮点一下，再立即重试；全程不弹窗、不抢焦点。
// 只对自家服务的地址使用（见 core/own-hosts.js）；每次尝试写日志并存一份放行页样本。
// 2026-10-15 首版做在公司联动里；2026-10-29 抽成公共模块（默认开启、完全无感，只对自家阿里云）。
// 2026-11-08 用户：放行按钮不灵敏、常要连点几次（公司 HIS 代理点完 20–30 秒才生效），原来「连点 3 次不成就停 30 分钟」太早放弃。
// 改成所有放行入口共用一份点击额度：1 分钟内最多 10 次、30 分钟内最多 15 次；同一时刻只开一个放行窗口。
const fs = require('node:fs');
const path = require('node:path');

const MAX_TRIES = 3; // 旧版的连续上限，仅留作兼容导出
const COOLDOWN_MS = 30 * 60000;
// 点击额度（滚动窗口）：用户 2026-11-08 定「1 分钟内 10 次，30 分钟内最多 15 次」。
const CLICK_LIMITS = Object.freeze([{ windowMs: 60000, max: 10 }, { windowMs: 30 * 60000, max: 15 }]);
const SAMPLE_LIMIT = 200 * 1024;
// 按优先级排列：越靠前越像「放行」本身。同一个词命中多个按钮时取页面上靠前的那个。
const GATE_WORDS = ['继续访问', '我已知晓', '知晓风险', '已知晓', '继续', '接受', '同意', '允许', '确定', 'continue', 'proceed', 'i understand', 'accept', 'allow', 'agree', 'ok'];
// 带这些字的是「不同意 / 返回 / 取消」，不点。
const NEGATIVE = /不|取消|拒绝|返回|关闭|cancel|back|decline|deny|close|reject/i;
// 没被拦时打开的就是自家页面：标题里带这些字就不点任何按钮（调用方可追加自己的页面标题）。
const OWN_PAGE_TITLES = ['AI HUB 服务'];

// 候选按钮的文字 → 该点哪一个（下标，没有返回 -1）。纯函数：页面里注入的脚本和单测用的是同一份。
function pickGateButton(texts) {
  const norm = (texts || []).map(t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase());
  for (const word of GATE_WORDS) {
    const i = norm.findIndex(t => t && t.length <= 40 && !NEGATIVE.test(t) && (word === 'ok' ? t === 'ok' : t.includes(word)));
    if (i >= 0) return i;
  }
  return -1;
}
// 文字都没认出来时的兜底（2026-11-08 用户：放行页是两个蓝色大按钮，左边那个是放行）：
// 在「像按钮、够大、不是取消/返回」的元素里取最靠左的（同列取靠上）。items: [{ text, x, y, w, h, button }]。
function pickGateFallback(items) {
  let best = -1;
  (items || []).forEach((it, i) => {
    const t = String(it && it.text || '').replace(/\s+/g, ' ').trim();
    if (!it || !it.button || !t || t.length > 40 || NEGATIVE.test(t) || !(it.w * it.h >= 1500)) return;
    const b = best >= 0 ? items[best] : null;
    if (!b || it.x < b.x - 4 || (Math.abs(it.x - b.x) <= 4 && it.y < b.y)) best = i;
  });
  return best;
}
// 注入放行页执行：收集可点击元素，选出放行按钮。mode='click' 直接点（DOM 点击）；mode='locate' 只回位置，由主进程做真实鼠标点击。
// clickIndex + expectText 给定时是真实点击没反应后的补点：只有那个位置上的按钮文字仍和定位时一样才点（页面变了就不点，审查 2026-11-08）。
// 「最左大按钮」兜底只在页面像代理拦截页时启用（标题或正文带风险 / 安全 / 代理 / 访问提示等字样）。
const GATE_PAGE_HINT = /风险|安全|代理|拦截|访问提示|未分类|proxy|warn|risk|secur|uncategor|blocked|notification/i;
function gateClickScript(ownTitles = OWN_PAGE_TITLES, mode = 'click', clickIndex = -1, expectText = null) {
  return `(() => {
    // 打开的其实是自家页面（这时已经不拦了）：不点任何按钮。
    if (${JSON.stringify(ownTitles)}.some(t => String(document.title || '').includes(t))) return { clicked: false, notGate: true, text: null, candidates: [] };
    const GATE_WORDS = ${JSON.stringify(GATE_WORDS)}, NEGATIVE = ${NEGATIVE.toString()};
    const pickGateButton = ${pickGateButton.toString()};
    const pickGateFallback = ${pickGateFallback.toString()};
    const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const raw = [...document.querySelectorAll('button, a, input[type=submit], input[type=button], [role=button], [onclick], [class*="btn" i], [class*="button" i]')];
    const list = [...new Set(raw)].filter(visible);
    const texts = list.map(e => e.innerText || e.value || (e.getAttribute && e.getAttribute('aria-label')) || e.title || '');
    let i = ${Number(clickIndex) | 0}, how = 'index';
    const expectText = ${JSON.stringify(expectText)};
    if (i >= 0) {
      if (i >= list.length || expectText === null || String(texts[i]).trim().slice(0, 60) !== expectText) return { clicked: false, changed: true, text: null, candidates: texts.slice(0, 20) };
    } else {
      i = pickGateButton(texts); how = 'word';
      const gateLike = ${GATE_PAGE_HINT.toString()}.test(String(document.title || '') + ' ' + String(document.body ? document.body.innerText : '').slice(0, 2000));
      if (i < 0 && gateLike) {
        const items = list.map((e, k) => { const r = e.getBoundingClientRect(); const tag = String(e.tagName || '').toLowerCase();
          return { text: texts[k], x: r.left, y: r.top, w: r.width, h: r.height, button: tag === 'button' || tag === 'input' || (e.getAttribute && e.getAttribute('role') === 'button') || /btn|button/i.test(String(e.className || '')) }; });
        i = pickGateFallback(items); how = 'left';
      }
    }
    if (i < 0) return { clicked: false, text: null, candidates: texts.slice(0, 20) };
    const el = list[i], r = el.getBoundingClientRect();
    const rect = { x: (r.left || 0) + r.width / 2, y: (r.top || 0) + r.height / 2, w: r.width, h: r.height };
    if (${JSON.stringify(mode)} === 'locate') return { clicked: false, found: true, index: i, how, rect, text: String(texts[i]).trim().slice(0, 60), candidates: texts.slice(0, 20) };
    el.click();
    return { clicked: true, index: i, how, rect, text: String(texts[i]).trim().slice(0, 60), candidates: texts.slice(0, 20) };
  })()`;
}

// 另一个入口这时也要放行就等这一次的结果，不另开窗口、不另算一次。
class ClickBudget {
  constructor({ limits = CLICK_LIMITS, now } = {}) { this.limits = limits; this.now = now || (() => Date.now()); this.clicks = []; this.pending = new Map(); this.tail = null; }
  prune() { const keep = Math.max(...this.limits.map(l => l.windowMs)); const t = this.now(); this.clicks = this.clicks.filter(at => t - at < keep); }
  // 现在还能不能再点一次；不能时给出最早什么时候能点。
  check() {
    this.prune();
    const t = this.now();
    let until = 0;
    for (const l of this.limits) {
      const inWin = this.clicks.filter(at => t - at < l.windowMs);
      if (inWin.length >= l.max) until = Math.max(until, inWin[inWin.length - l.max] + l.windowMs);
    }
    return until ? { ok: false, until } : { ok: true, until: null };
  }
  take() { const at = this.now(); this.clicks.push(at); return at; }
  // 这次开了放行页但没点到按钮：把占的那一格还回去。额度只算真正点下去的次数。
  refund(at) { const i = this.clicks.lastIndexOf(at); if (i >= 0) this.clicks.splice(i, 1); }
  used(windowMs) { const t = this.now(); return this.clicks.filter(at => t - at < windowMs).length; }
  status() { const c = this.check(); return { limits: this.limits.map(l => ({ ...l, used: this.used(l.windowMs) })), blockedUntil: c.until }; }
  // 互斥：同一时刻只开一个放行窗口。同一台主机、同一种请求（key 相同）正在放行时直接共用那次结果；
  // 别的主机排在后面，等前一个结束再自己放行（审查 2026-11-08：两台主机不能共用一个结果）。
  exclusive(fn, key = '') {
    this.pending = this.pending || new Map();
    if (this.pending.has(key)) return this.pending.get(key).then(r => ({ ...r, shared: true }));
    const prev = this.tail || Promise.resolve();
    const run = prev.catch(() => {}).then(fn)
      .finally(() => { if (this.pending.get(key) === run) this.pending.delete(key); if (this.tail === run) this.tail = null; });
    this.pending.set(key, run);
    this.tail = run;
    return run;
  }

}
const sharedBudget = new ClickBudget();

// 放行窗口里的任何下载一律取消（2026-11-08 公司网络：放行页点完跳到更新包地址，变成下载了文件）。放行只看网页，不要文件。
function blockDownloads(win) {
  const ses = win.webContents && win.webContents.session;
  if (!ses || typeof ses.on !== 'function') return () => {};
  const onDownload = (event, _item, contents) => { if (contents === win.webContents) event.preventDefault(); };
  ses.on('will-download', onDownload);
  return () => { try { ses.removeListener('will-download', onDownload); } catch (_) {} };
}

const timeout = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(what + '超时')), ms))]);
// 真实鼠标点击（经 Chromium 调试协议发鼠标事件，网页收到的是 isTrusted 的点击，和人手点一样；看不见的窗口里也能点）。
// 有些放行页只认真实点击、不认脚本里的 el.click()（2026-11-08 用户反映按钮「不灵敏」）。挂不上调试器就返回 false，由调用方退回 DOM 点击。
async function trustedClick(webContents, x, y) {
  const dbg = webContents && webContents.debugger;
  if (!dbg) return false;
  let attached = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true; }
    const send = (type, extra = {}) => dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...extra });
    await send('mouseMoved', { button: 'none' });
    await send('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
    await send('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
    return true;
  } catch { return false; }
  finally { if (attached) { try { dbg.detach(); } catch {} } }
}
// 等主页面开始跳转并加载完（最多 ms 毫秒）；返回是否跳转了。
const waitNavigation = (wc, ms) => new Promise(resolve => {
  if (!wc || typeof wc.on !== 'function') { setTimeout(() => resolve(false), ms); return; }
  let navigated = false, finished = false;
  const done = () => { if (finished) return; finished = true; clearTimeout(timer); wc.removeListener('did-start-navigation', onNav); wc.removeListener('did-stop-loading', done); resolve(navigated); };
  const onNav = (_e, _url, _inPlace, isMainFrame) => { if (isMainFrame !== false && !navigated) { navigated = true; wc.once('did-stop-loading', done); } };
  const timer = setTimeout(done, ms);
  wc.on('did-start-navigation', onNav);
});
// 放行按钮可能在内嵌页（iframe）里：主页面没有就逐个内嵌页找。返回 { frame, main, found }。
async function locateInFrames(wc, js, ownTitles) {
  const main = wc.mainFrame;
  const subs = main && Array.isArray(main.framesInSubtree) ? main.framesInSubtree.filter(f => f !== main) : [];
  let first = null;
  for (const frame of [main, ...subs]) {
    const isMain = frame === main;
    let r;
    try { r = isMain ? await js(gateClickScript(ownTitles, 'locate')) : await timeout(frame.executeJavaScript(gateClickScript(ownTitles, 'locate'), true), 5000, '读取放行页'); }
    catch { continue; }
    if (isMain && r && r.notGate) return { frame, main: true, found: r };
    if (r && r.found) return { frame, main: isMain, found: r };
    if (!first) first = { frame, main: isMain, found: r };
  }
  return first || { frame: main, main: true, found: null };
}
// 在已打开的放行页上找按钮并点：先真实鼠标点击；1.5 秒内页面没跳转再补一次 DOM 点击（按钮只发请求、本来不跳转时多点一次也无害）。
// 结果写进 result：clicked / text / candidates / how / method / notGate / inFrame。
async function clickGateIn(wc, js, ownTitles, settleMs, result) {
  const hit = await locateInFrames(wc, js, ownTitles);
  const f = hit.found;
  Object.assign(result, { notGate: !!f?.notGate, text: f?.text || null, candidates: f?.candidates || [], how: f?.how || null, inFrame: !hit.main });
  if (!f || !f.found) return result;
  const dom = () => (hit.main ? js(gateClickScript(ownTitles, 'click', f.index, f.text))
    : timeout(hit.frame.executeJavaScript(gateClickScript(ownTitles, 'click', f.index, f.text), true), 5000, '点放行页'));
  let navigated = false;
  if (hit.main && f.rect) {
    // 先挂上跳转监听再点：点完立刻跳转的也能看到，不会误以为没反应去补点。
    const nav = waitNavigation(wc, 1500);
    if (await trustedClick(wc, f.rect.x, f.rect.y)) { result.method = 'trusted'; result.clicked = true; }
    navigated = await nav;
  }
  if (!navigated) {
    const d = await dom().catch(() => null);
    if (d && d.clicked) { result.clicked = true; result.method = result.method ? 'trusted+dom' : 'dom'; }
    // 点完等页面跳走并加载完；没有跳转（按钮只发了个请求）就等满 settleMs。
    if (result.clicked) await waitNavigation(wc, settleMs);
  }
  return result;
}
const hiddenWindow = BrowserWindow => new BrowserWindow({ show: false, skipTaskbar: true, focusable: false, width: 1100, height: 780,
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });

// 在看不见的窗口里打开放行页并点按钮。只在 Electron 主进程里调用（BrowserWindow 由调用方传入，测试可换）。
async function openHiddenGateWindow(BrowserWindow, url, { loadTimeoutMs = 20000, settleMs = 5000, ownTitles = OWN_PAGE_TITLES } = {}) {
  const result = { loaded: false, clicked: false, text: null, candidates: [], html: null, finalUrl: null, error: null, method: null };
  if (!/^https?:\/\//i.test(String(url || ''))) return { ...result, error: '放行页地址无效' };
  const win = hiddenWindow(BrowserWindow);
  const wc = win.webContents;
  const js = (code, ms = 5000) => timeout(wc.executeJavaScript(code, true), ms, '读取放行页');
  const stopBlockingDownloads = blockDownloads(win);
  try {
    // 放行页常常再跳转一次，loadURL 会因中途跳转报错：报错后仍按页面最终停下的样子继续。
    try { await timeout(win.loadURL(url), loadTimeoutMs, '打开放行页'); }
    catch (error) { result.loadError = error.message; if (wc.isLoading()) await timeout(new Promise(r => wc.once('did-stop-loading', r)), loadTimeoutMs, '打开放行页').catch(() => {}); }
    result.loaded = true;
    result.html = String(await js('document.documentElement ? document.documentElement.outerHTML : ""') || '');
    await clickGateIn(wc, js, ownTitles, settleMs, result);
    result.finalUrl = wc.getURL();
  } catch (error) { result.error = error.message; }
  finally { stopBlockingDownloads(); if (!win.isDestroyed()) win.destroy(); }
  return result;
}

// 后台放行没成功时的第二步（2026-11-08 用户定：要么自动放行，要么在 Hub 里弹出网页）：在 Hub 自己的窗口里打开放行页，
// 继续自动点放行按钮，用户也可以手动点。看到自家页面（已放行）就自动关窗。只在用户动手触发的流程里用，后台检查不弹窗。
async function openVisibleGateWindow(BrowserWindow, url, { parent = null, show = true, timeoutMs = 180000, pollMs = 1500, afterClickMs = 3000, maxClicks = 3,
  ownTitles = OWN_PAGE_TITLES, title = '放行下载服务器（页面上点「继续访问」或「接受」，放行后自动关闭）' } = {}) {
  const result = { passed: false, clicked: false, closed: false, timedOut: false, text: null, error: null };
  if (!/^https?:\/\//i.test(String(url || ''))) return { ...result, error: '放行页地址无效' };
  const win = new BrowserWindow({ show, width: 1000, height: 720, title, autoHideMenuBar: true,
    ...(parent && !(parent.isDestroyed && parent.isDestroyed()) ? { parent } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const stopBlockingDownloads = blockDownloads(win);
  win.on('page-title-updated', event => event.preventDefault());
  return new Promise(resolve => {
    let done = false, timer = null, clicks = 0;
    const finish = patch => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(deadline); Object.assign(result, patch); stopBlockingDownloads();
      try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
      resolve(result);
    };
    const deadline = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    win.on('closed', () => finish({ closed: true }));
    const onlyCheckOwn = `(() => ({ notGate: ${JSON.stringify(ownTitles)}.some(t => String(document.title || '').includes(t)) }))()`;
    const tick = async () => {
      if (done || win.isDestroyed()) return;
      let wait = pollMs;
      try {
        if (!win.webContents.isLoading()) {
          const js = (code, ms = 3000) => timeout(win.webContents.executeJavaScript(code, true), ms, '读取放行页');
          // 和看不见的窗口同一种点法：真实鼠标点击，页面没反应再补 DOM 点击（2026-11-08 按钮不灵敏）。
          const r = clicks < maxClicks ? await clickGateIn(win.webContents, js, ownTitles, 0, {}) : await js(onlyCheckOwn);
          if (r && r.notGate) return finish({ passed: true });
          if (r && r.clicked) { clicks += 1; result.clicked = true; result.text = r.text || null; wait = afterClickMs; }
        }
      } catch (_) { /* 页面正在跳转：下一轮再看 */ }
      if (!done) timer = setTimeout(tick, wait);
    };
    win.loadURL(url).catch(() => {});
    timer = setTimeout(tick, pollMs);
  });
}

// 在看不见的窗口里直接 POST 一份 JSON（2026-10-30 公司真机：放行页的 GET 早已放行、只拿到自家页面，反馈的 POST 仍被拦成网页，
// 打开放行页的办法管不到提交本身）。走的是浏览器网络栈，被拦时拦截页就显示在这个窗口里：找到放行按钮点一下，返回让调用方隔一会儿再提交。
// 返回 { json, clicked, text, candidates, title, html, status, error }：json 不为空就是服务端的回答。
async function postInHiddenWindow(BrowserWindow, url, body, { loadTimeoutMs = 30000, settleMs = 5000, ownTitles = OWN_PAGE_TITLES } = {}) {
  const result = { json: null, clicked: false, text: null, candidates: [], title: null, html: null, error: null, method: null };
  if (!/^https?:\/\//i.test(String(url || ''))) return { ...result, error: '提交地址无效' };
  const win = hiddenWindow(BrowserWindow);
  const wc = win.webContents;
  const js = (code, ms = 5000) => timeout(wc.executeJavaScript(code, true), ms, '读取提交结果');
  const stopBlockingDownloads = blockDownloads(win);
  try {
    wc.once('did-navigate', (_e, _url, code) => { result.status = code; });
    const postData = [{ type: 'rawData', bytes: Buffer.from(JSON.stringify(body), 'utf8') }];
    try { await timeout(win.loadURL(url, { postData, extraHeaders: 'Content-Type: application/json\n' }), loadTimeoutMs, '提交'); }
    catch (error) { result.loadError = error.message; if (wc.isLoading()) await timeout(new Promise(r => wc.once('did-stop-loading', r)), loadTimeoutMs, '提交').catch(() => {}); }
    const page = await js('({ title: document.title || "", text: document.body ? document.body.innerText : "", html: document.documentElement ? document.documentElement.outerHTML : "" })');
    result.title = String(page?.title || '').slice(0, 120);
    result.html = String(page?.html || '');
    try { const parsed = JSON.parse(String(page?.text || '').trim()); if (parsed && typeof parsed === 'object') result.json = parsed; } catch {}
    if (!result.json) await clickGateIn(wc, js, ownTitles, settleMs, result);
  } catch (error) { result.error = error.message; }
  finally { stopBlockingDownloads(); if (!win.isDestroyed()) win.destroy(); }
  return result;
}

const NO_CLICK_IDLE_MS = 60000;
class GatePasser {
  // open(url) → openHiddenGateWindow 的结果；logDir 放日志和放行页样本。
  // budget：点击额度与互斥（ClickBudget）。main 里各入口传同一个 sharedBudget；不传就各用各的（单测用）。
  constructor({ open, logDir, now, notify, manualHint, logName = 'company-gate', budget }) {
    this.open = open; this.logDir = logDir; this.now = now || (() => Date.now()); this.notify = notify || (() => {});
    this.manualHint = manualHint || '请用浏览器打开被拦的网址手动放行'; this.logName = logName;
    this.budget = budget || new ClickBudget({ now: this.now });
    this.tries = 0; this.cooldownUntil = 0; this.notifiedUntil = 0; this.last = null;
    this.idleUntil = new Map(); // 主机|请求方法 → 上次打开放行页没找到按钮，这之前不再开窗
  }
  status() {
    const b = this.budget.status();
    return { tries: this.tries, limits: b.limits, cooldownUntil: b.blockedUntil && b.blockedUntil > this.now() ? b.blockedUntil : null, last: this.last };
  }
  log(entry) {
    this.last = { at: this.now(), ...entry };
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.appendFileSync(path.join(this.logDir, this.logName + '.log'), JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry }) + '\n');
    } catch {}
  }
  // 仍被拦：在额度内点一次。返回 true 表示点到了按钮，调用方应隔几秒重试连接。
  // 额度用完（1 分钟 10 次 / 30 分钟 15 次）就不点，提示一次人工放行，等额度恢复后自动接着点。
  // opts 原样交给 open（心跳用它说明是 GET 还是 POST 被拦）。
  async attempt(url, opts) {
    // 上次打开没找到可点的按钮：一分钟内不重复开窗（没点击不占额度，这里只防空转）。
    // 按主机 + 请求方法分开记（和互斥的键一致）：GET 没找到按钮不该耽误 POST 被拦时去点。
    const key = `${hostOf(url)}|${(opts && opts.method) || 'GET'}`;
    if ((this.idleUntil.get(key) || 0) > this.now()) return false;
    const c = this.budget.check();
    if (!c.ok) {
      if (this.notifiedUntil < c.until) {
        this.notifiedUntil = c.until;
        const longWait = c.until - this.now() > 2 * 60000;
        this.log({ host: hostOf(url), result: 'gave-up', note: `点击额度用完，${new Date(c.until).toLocaleTimeString('zh-CN', { hour12: false })} 后再试` });
        if (longWait) this.notify('自动放行没成功', `30 分钟内已自动点了 ${this.budget.used(30 * 60000)} 次放行页仍被拦：${this.manualHint}；额度恢复后会再自动试。`);
      }
      return false;
    }
    const r0 = await this.budget.exclusive(async () => {
      if (!this.budget.check().ok) return { skipped: true };
      const taken = this.budget.take();
      let r;
      try { r = await this.open(url, opts); } catch (error) { r = { error: error.message }; }
      r = r || {};
      // 没点到按钮（不是放行页、找不到按钮、打不开）不算一次点击：还回额度，否则误报会把真正要放行时的额度占光
      // （2026-11-11 公司真机：约 300 次「点击额度用完」都是被没点击的空跑挤掉的）。
      // tries 只在真的点到后才加：开窗期间别的主机可能刚 passed() 清零，先加后减会减成负数。
      if (!r.clicked) { this.budget.refund(taken); this.idleUntil.set(key, this.now() + NO_CLICK_IDLE_MS); }
      else { this.tries += 1; this.idleUntil.delete(key); }
      return r;
    }, key);
    const r = r0;
    if (r.skipped) return false;
    if (r.shared) return !!r.clicked; // 别的入口刚点过，共用它的结果，不重复记
    if (r.html) {
      try { fs.mkdirSync(this.logDir, { recursive: true }); fs.writeFileSync(path.join(this.logDir, this.logName + '-sample.html'), Buffer.from(r.html, 'utf8').subarray(0, SAMPLE_LIMIT)); } catch {}
    }
    this.log({ host: hostOf(url), try: r.clicked ? this.tries : this.tries + 1, clicked: !!r.clicked, button: r.text || null, method: r.method || null, how: r.how || null,
      result: r.error ? 'error' : r.clicked ? 'clicked' : r.notGate ? 'not-gate' : 'no-button', error: r.error || null, candidates: r.clicked ? undefined : (r.candidates || []).slice(0, 10) });
    return !!r.clicked;
  }
  // 已恢复访问：清零计数；之前自动点过就记一笔成功。
  passed() {
    if (!this.tries) return false;
    this.log({ result: 'passed', tries: this.tries });
    this.tries = 0; this.cooldownUntil = 0; this.notifiedUntil = 0;
    return true;
  }
}
function hostOf(url) { try { return new URL(url).host; } catch { return null; } }

module.exports = { OWN_PAGE_TITLES, GatePasser, ClickBudget, sharedBudget, CLICK_LIMITS, pickGateButton, pickGateFallback, gateClickScript, openHiddenGateWindow, openVisibleGateWindow, postInHiddenWindow, trustedClick, GATE_WORDS, MAX_TRIES, COOLDOWN_MS };
