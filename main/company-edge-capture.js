'use strict';
//   - 公司电脑上的安全客户端会替页面完成单点登录：页面先跳到登录页、几秒后自动跳回，全新的浏览器资料也能登录；
//     仍把本机 Edge 默认用户的登录状态复制进临时目录作双保险，复制不到也照常继续；
//   - 等页面落到 readyUrl 后执行 script（页面内的异步表达式，只发同源查询），把返回值带回来；
//     accept 判定返回值还不算数时（登录跳转途中）留在原页稍后重试；
//   - 不改用户自己的 Edge 资料，不弹窗（--headless=new + windowsHide），结束按进程号收掉整棵进程树并删临时目录。
// 考勤的取数（company-attendance-edge.js）是「旁路截接口」的做法，和这里互不影响。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { findEdge } = require('./company-attendance-edge');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// 正在跑的无头 Edge（Hub 退出时 killAll 一并收掉，不留进程和临时目录）。
const running = new Set();
function killTree(pid) { try { spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch { /* 已退 */ } }
function killAll() { for (const p of running) { if (p.pid && p.exitCode === null) killTree(p.pid); } running.clear(); }
// 登录页常要十几秒才自动跳回（真机见过登录页自身加载 25 秒），连续停留这么久才算真的要登录。
const LOGIN_GRACE_MS = 45000;
const PAGE_STATE = `(() => { const t = document.body ? document.body.innerText : '';
  return { host: location.host, href: location.origin + location.pathname, ready: document.readyState,
    hasPassword: !!document.querySelector('input[type=password]'), hasQr: /扫码登录|二维码/.test(t.slice(0, 3000)) }; })()`;

function copyLogin(tmp, env = process.env) {
  const src = path.join(env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
  if (!fs.existsSync(src)) return 0;
  let copied = 0;
  for (const f of ['Local State', 'Default/Network/Cookies', 'Default/Preferences']) {
    try {
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      fs.copyFileSync(path.join(src, f), path.join(tmp, f));
      copied += 1;
    } catch { /* 复制不到就靠安全客户端登录 */ }
  }
  return copied;
}

function looksLikeLogin(st, onTarget) { return !!(st && (st.hasPassword || (st.hasQr && !onTarget))); }

async function getJson(url) { const r = await fetch(url); return r.json(); }

/* 返回 { ok, value, needsLogin, error, finalHost, tookMs, via:'edge' } */
async function runInEdge({ url, readyUrl, script, accept = null, signal = null, timeoutMs = 120000, loginGraceMs = LOGIN_GRACE_MS, pollMs = 700, tag = 'hub-edge', logger = console, env = process.env } = {}) {
  const started = Date.now();
  const result = { ok: false, via: 'edge', value: null, needsLogin: false, error: '', finalHost: '', tookMs: 0 };
  const edge = findEdge(env);
  if (!edge) { result.error = '本机没有找到 Edge'; return result; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), tag + '-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  copyLogin(tmp, env);
  let proc = null, ws = null;
  const deadline = started + timeoutMs;
  try {
    proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tmp}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let spawnError = null;
    proc.on('error', (e) => { spawnError = e; });
    running.add(proc);
    let page = null;
    for (let i = 0; i < 60 && !page && !spawnError; i += 1) {
      await delay(400);
      try { page = (await getJson(`http://127.0.0.1:${port}/json/list`)).find((t) => t.type === 'page'); } catch { /* 还没起来 */ }
    }
    if (!page) throw new Error(spawnError ? `无头 Edge 启动失败（${spawnError.code || spawnError.message}）` : '无头 Edge 没有启动');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('连接无头 Edge 失败')); });
    let id = 0;
    const pending = new Map();
    // 每个请求最多等到总期限；连接断开时，所有在等的请求立刻以 closed 收尾。
    let closed = false;
    const send = (method, params = {}) => {
      if (closed) return Promise.resolve({ closed: true });
      id += 1; const n = id;
      const p = new Promise((resolve) => { pending.set(n, resolve); try { ws.send(JSON.stringify({ id: n, method, params })); } catch { pending.delete(n); resolve({ closed: true }); } });
      return Promise.race([p, delay(Math.max(1000, deadline - Date.now())).then(() => { pending.delete(n); return { timeout: true }; })]);
    };
    ws.onclose = () => { closed = true; for (const r of pending.values()) r({ closed: true }); pending.clear(); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    await send('Page.enable');
    await send('Page.navigate', { url });
    // accept(value) 返回假表示页面还没准备好（比如单点登录还没跳完），过一会儿在同一页再执行一次。
    let st = {}, loginSince = 0, lastError = '';
    while (Date.now() < deadline && !result.ok) {
      await delay(pollMs);
      if (signal?.aborted) { lastError = '已取消'; break; }
      if (closed) { lastError = '和无头 Edge 的连接断了'; break; }
      st = (await send('Runtime.evaluate', { expression: PAGE_STATE, returnByValue: true }))?.result?.result?.value || {};
      result.finalHost = st.host || result.finalHost;
      // 到了目标页就不再按「二维码」字样判登录：门户首页顶栏自己就有二维码入口（真机上因此误判过）。
      const onTarget = readyUrl.test(String(st.href || ''));
      if (looksLikeLogin(st, onTarget)) {
        loginSince = loginSince || Date.now();
        if (Date.now() - loginSince >= loginGraceMs) break;
        continue;
      }
      loginSince = 0;
      if (!onTarget || st.ready !== 'complete') continue;
      const r = await Promise.race([
        send('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: true }),
        delay(Math.max(5000, deadline - Date.now())).then(() => ({ timeout: true })),
      ]);
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
    try { ws?.close(); } catch { /* 已关 */ }
    if (proc?.pid && proc.exitCode === null) killTree(proc.pid);
    if (proc) running.delete(proc);
    await delay(800);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch (e) { logger.warn?.(`[${tag}] 临时目录未删净`, e.code || e.message); }
  }
  result.tookMs = Date.now() - started;
  return result;
}

module.exports = { runInEdge, looksLikeLogin, killAll, LOGIN_GRACE_MS };
