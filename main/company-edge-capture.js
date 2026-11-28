'use strict';
//   - 公司电脑上的安全客户端会替页面完成单点登录：页面先跳到登录页、几秒后自动跳回，全新的浏览器资料也能登录；
//     仍把本机 Edge 默认用户的登录状态复制进临时目录作双保险，复制不到也照常继续；
//   - 等页面落到 readyUrl 后执行 script（页面内的异步表达式，只发同源查询），把返回值带回来；
//     accept 判定返回值还不算数时（登录跳转途中）留在原页稍后重试；
//   - 不改用户自己的 Edge 资料，不弹窗（--headless=new + windowsHide），结束按进程号收掉整棵进程树并删临时目录。
// 考勤的取数（company-attendance-edge.js）是「旁路截接口」的做法，和这里互不影响。
const fs = require('fs');
const path = require('path');
const { launchHeadlessEdge, findEdge } = require('./edge-headless');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// 正在跑的无头 Edge（Hub 退出时 killAll 一并收掉，不留进程和临时目录）。起停、名额、超时强收都在 edge-headless.js + core/child-lifecycle.js。
const running = new Set();
function killAll() { for (const h of running) { try { h.closeSync(); } catch { /* 已退 */ } } running.clear(); }
// 登录页常要十几秒才自动跳回（真机见过登录页自身加载 25 秒），连续停留这么久才算真的要登录。
const LOGIN_GRACE_MS = 45000;
const START_WAIT_MS = 45000;
const PAGE_STATE = `(() => { const t = document.body ? document.body.innerText : '';
  return { host: location.host, href: location.origin + location.pathname, ready: document.readyState,
    hasPassword: !!document.querySelector('input[type=password]'), hasQr: /扫码登录|二维码/.test(t.slice(0, 3000)),
    errorPage: location.protocol === 'chrome-error:' || location.host === 'chromewebdata',
    netError: (location.protocol === 'chrome-error:' || location.host === 'chromewebdata') ? ((t.match(/(?:^|[^A-Z_])((?:ERR|DNS_PROBE)_[A-Z_]+)/) || [])[1] || '') : '' }; })()`;
// 停在 Edge 自己的「无法访问此页面」错误页（地址是 chrome-error://chromewebdata）：网络、代理、DNS、证书出了问题。
// 先隔几秒重新打开一次（公司 VPN、代理偶尔闪断），还不行就直接报，不再空等到 2 分钟（2026-11-24 同事反馈「停在 chromewebdata」）。
const ERROR_PAGE_MS = 8000;
const ERROR_PAGE_RETRIES = 1;
const netCode = (t) => String(t || '').replace(/^net::/, '').trim();

// 复制本机 Edge 的登录状态。用 Edge 最近用的那个用户资料（Local State 里的 profile.last_used，公司账号常在「Profile 1」），
// 找不到再用 Default；复制进临时目录的 Default。返回复制了哪个资料、Cookies 拿没拿到（Edge 开着时 Cookies 可能被占用），写进诊断。
function edgeProfileOf(src) {
  try {
    const last = JSON.parse(fs.readFileSync(path.join(src, 'Local State'), 'utf8'))?.profile?.last_used;
    if (typeof last === 'string' && /^(Default|Profile \d{1,4})$/.test(last) && fs.existsSync(path.join(src, last, 'Network', 'Cookies'))) return last;
  } catch { /* 读不到就用 Default */ }
  return 'Default';
}
function copyLogin(tmp, env = process.env) {
  const src = path.join(env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
  const info = { profile: '', copied: 0, cookies: false };
  if (!fs.existsSync(src)) return info;
  info.profile = edgeProfileOf(src);
  for (const [from, to] of [['Local State', 'Local State'], [info.profile + '/Network/Cookies', 'Default/Network/Cookies'], [info.profile + '/Preferences', 'Default/Preferences']]) {
    try {
      fs.mkdirSync(path.dirname(path.join(tmp, to)), { recursive: true });
      fs.copyFileSync(path.join(src, from), path.join(tmp, to));
      info.copied += 1;
      if (/Cookies$/.test(to)) info.cookies = true;
    } catch { /* 复制不到就靠安全客户端登录 */ }
  }
  return info;
}

function looksLikeLogin(st, onTarget) { return !!(st && (st.hasPassword || (st.hasQr && !onTarget))); }

async function getJson(url) { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.json(); }

/* 返回 { ok, value, needsLogin, error, finalHost, tookMs, via:'edge' } */
async function runInEdge({ url, readyUrl, script, accept = null, signal = null, timeoutMs = 120000, loginGraceMs = LOGIN_GRACE_MS, pollMs = 700, tag = 'hub-edge', logger = console, env = process.env } = {}) {
  const started = Date.now();
  const result = { ok: false, via: 'edge', value: null, needsLogin: false, error: '', finalHost: '', netError: '', tookMs: 0, loginCopy: null };
  if (!findEdge(env)) { result.error = '本机没有找到 Edge'; return result; }
  let edge = null, ws = null, deadline = started + timeoutMs, onAbort = null;
  try {
    if (signal?.aborted) throw new Error('已取消');
    // 起 Edge 最多等 45 秒（默认 20 秒）：公司真机上全新资料第一次冷启动，调试端口 36 秒才出来（2026-11-24 探针）。
    edge = await launchHeadlessEdge({ startWaitMs: START_WAIT_MS, purpose: tag === 'hub-w3' ? '门户待办取数' : '内网页面取数', tag, env, logger, signal, maxLifeMs: timeoutMs + 60000, prepare: tmp => { result.loginCopy = copyLogin(tmp, env); } });
    running.add(edge);
    deadline = Date.now() + timeoutMs; // 排队等名额的时间不算进取数期限（审查 #4）
    let page = null;
    for (let i = 0; i < 20 && !page; i += 1) {
      if (signal?.aborted) throw new Error('已取消');
      try { page = (await getJson(`http://127.0.0.1:${edge.port}/json/list`)).find((t) => t.type === 'page'); } catch { /* 还没起来 */ }
      if (!page) await delay(300);
    }
    if (signal?.aborted) throw new Error('已取消');
    if (!page) throw new Error('无头 Edge 没有启动');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连接无头 Edge 超时')), 10000);
      ws.onopen = () => { clearTimeout(t); resolve(); }; ws.onerror = () => { clearTimeout(t); reject(new Error('连接无头 Edge 失败')); };
    });
    let id = 0;
    const pending = new Map();
    // 每个请求最多等到总期限；连接断开时，所有在等的请求立刻以 closed 收尾。
    let closed = false;
    const send = (method, params = {}) => {
      if (closed || signal?.aborted) return Promise.resolve({ closed: true });
      id += 1; const n = id;
      const p = new Promise((resolve) => { pending.set(n, resolve); try { ws.send(JSON.stringify({ id: n, method, params })); } catch { pending.delete(n); resolve({ closed: true }); } });
      return Promise.race([p, delay(Math.max(1000, deadline - Date.now())).then(() => { pending.delete(n); return { timeout: true }; })]);
    };
    ws.onclose = () => { closed = true; for (const r of pending.values()) r({ closed: true }); pending.clear(); };
    onAbort = () => {
      closed = true;
      for (const r of pending.values()) r({ closed: true });
      pending.clear();
      try { ws?.close(); } catch { /* 已关 */ }
      try { edge?.closeSync(); } catch { /* 已关 */ }
    };
    if (signal) {
      if (signal.aborted) { onAbort(); throw new Error('已取消'); }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    await send('Page.enable');
    if (signal?.aborted) throw new Error('已取消');
    const nav = await send('Page.navigate', { url });
    result.netError = netCode(nav?.result?.errorText);
    // accept(value) 返回假表示页面还没准备好（比如单点登录还没跳完），过一会儿在同一页再执行一次。
    let st = {}, loginSince = 0, lastError = '', errorSince = 0, renav = 0;
    while (Date.now() < deadline && !result.ok) {
      await delay(pollMs);
      if (signal?.aborted) { lastError = '已取消'; break; }
      if (closed || edge.closed) { lastError = '和无头 Edge 的连接断了'; break; }
      st = (await send('Runtime.evaluate', { expression: PAGE_STATE, returnByValue: true }))?.result?.result?.value || {};
      if (signal?.aborted) { lastError = '已取消'; break; }
      if (closed || edge.closed) { lastError = '和无头 Edge 的连接断了'; break; }
      result.finalHost = st.host || result.finalHost;
      if (st.errorPage) {
        if (st.netError) result.netError = st.netError;
        errorSince = errorSince || Date.now();
        if (Date.now() - errorSince < ERROR_PAGE_MS) continue;
        if (renav < ERROR_PAGE_RETRIES) { renav += 1; errorSince = 0; await send('Page.navigate', { url }); continue; }
        lastError = `页面没有打开（停在 Edge 的错误页${result.netError ? '，' + result.netError : ''}）`;
        break;
      }
      errorSince = 0;
      // 到了目标页就不再按「二维码」字样判登录：门户首页顶栏自己就有二维码入口（真机上因此误判过）。
      const onTarget = readyUrl.test(String(st.href || ''));
      if (looksLikeLogin(st, onTarget)) {
        loginSince = loginSince || Date.now();
        if (Date.now() - loginSince >= loginGraceMs) break;
        continue;
      }
      loginSince = 0;
      if (!onTarget || st.ready !== 'complete') continue;
      if (signal?.aborted || closed || edge.closed) { lastError = signal?.aborted ? '已取消' : '和无头 Edge 的连接断了'; break; }
      const r = await Promise.race([
        send('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: true }),
        delay(Math.max(5000, deadline - Date.now())).then(() => ({ timeout: true })),
      ]);
      if (signal?.aborted) { lastError = '已取消'; break; }
      if (r.timeout) { lastError = '页面里的查询超时'; break; }
      if (r.closed) { lastError = '和无头 Edge 的连接断了'; break; }
      if (r.result?.exceptionDetails) { lastError = '页面里的查询出错：' + String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 160); continue; }
      const value = r.result?.result?.value ?? null;
      if (value == null) { lastError = '页面里的查询没有返回内容'; continue; }
      if (typeof accept === 'function' && !accept(value)) { lastError = '页面还没登录好'; continue; }
      result.value = value; result.ok = true;
    }
    if (!result.ok) {
      result.needsLogin = !!loginSince;
      result.error = loginSince ? `需要登录（停在 ${st.host || '登录页'}）` : (lastError || `页面没有打开（停在 ${st.host || '空白页'}）`);
    }
  } catch (e) {
    result.error = /^spawn /.test(String(e.message)) ? `无头 Edge 启动失败（${e.code || e.message}）` : e.message;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    try { ws?.close(); } catch { /* 已关 */ }
    if (edge) { running.delete(edge); await edge.close(); }
  }
  result.tookMs = Date.now() - started;
  return result;
}

module.exports = { runInEdge, looksLikeLogin, killAll, copyLogin, edgeProfileOf, LOGIN_GRACE_MS, PAGE_STATE };
