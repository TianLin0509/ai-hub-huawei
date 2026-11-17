'use strict';
// 起因：Hub 自己的浏览器窗口是全新的浏览器资料，公司的安全终端免密登录在里面常常不生效，同事要反复手动登录；
// 而把 Edge 默认用户的登录状态（Local State + Cookies + Preferences）复制到临时目录后，经公司统一登录入口进站，
// 三个站点（门户首页、稼先、心声）都能自动登录并跳回（考勤从 2026-11-07 起就这么取，见 company-attendance-edge.js）。
//   - 不改用户自己的 Edge 资料，不弹窗（--headless=new + windowsHide）；
//   - 一次同步要开十来个页面：Edge 进程留着复用，闲置一会儿再结束并删掉临时目录。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { collectScript, clickScript, DETAIL_SCRIPT } = require('./company-forum-browser');
const { findEdge, copyProfile, markOwner, OWNER_FILE } = require('./company-attendance-edge');

const LOGIN_WORDS = /账号登录|扫码登录|密码登录|统一身份认证|统一认证|请输入(?:账号|密码|工号)|忘记密码/;
const delay = ms => new Promise(r => setTimeout(r, ms));
const within = (p, ms, fallback) => Promise.race([p, delay(ms).then(() => fallback)]);
const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
// 临时目录里是 Edge 登录状态的副本（含 Cookie）。Hub 被强退、崩溃或退出时来不及删，会一直留在 %TEMP%
// （2026-11-17 用户反馈：陈旧 user-data-dir 累积）。下次启动无头 Edge 前，把超过 STALE_MS 的旧副本删掉。
// 在用的目录一个文件也不能删（r38b 审查：递归删在碰到被锁文件前，已经把没锁的 Preferences 删掉了），所以删之前两道确认：
//   1. 建它的 Hub 进程（hub-owner.json 里的 pid）还活着：不动；
//   2. 先把整个目录改名：Windows 上目录里有文件被别的进程打开时改名会失败，说明还在用，跳过、一个文件都不碰；
//      改名成功才递归删改名后的目录（新路径没有进程认识，不会被删到一半时又被用起来）。
// 考勤（company-attendance-edge.js）的副本同样处理。
const STALE_PREFIXES = ['hub-posts-', 'hub-attendance-'];
const STALE_MS = 6 * 3600000; // 一次同步或考勤只要几分钟；留足余量，不碰还在用的副本
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function ownerAlive(full) {
  try { return pidAlive(Number(JSON.parse(fs.readFileSync(path.join(full, OWNER_FILE), 'utf8')).pid)); } catch { return false; }
}
function sweepStale({ dir = os.tmpdir(), now = Date.now(), staleMs = STALE_MS, keep = '', logger = console } = {}) {
  let removed = 0, names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!STALE_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
    const full = path.join(dir, name);
    if (keep && path.resolve(full) === path.resolve(keep)) continue;
    try {
      const st = fs.statSync(full);
      if (!st.isDirectory() || now - st.mtimeMs < staleMs) continue;
      if (ownerAlive(full)) continue;
      const moved = `${full}-sweep${process.pid}x${Math.random().toString(36).slice(2, 8)}`;
      fs.renameSync(full, moved); // 失败（EBUSY/EPERM/EACCES）= 还有文件被占着：整个目录原样留着
      fs.rmSync(moved, { recursive: true, force: true });
      removed += 1;
    } catch { /* 正被占用或没权限：下次再试 */ }
  }
  if (removed) logger.info?.(`[company-forum] 清掉 ${removed} 个陈旧的 Edge 临时目录`);
  return removed;
}

function createEdgeBrowser({ logger = console, env = process.env, idleMs = 20000 } = {}) {
  let inst = null, idleTimer = null, busy = Promise.resolve();

  async function start() {
    const edge = findEdge(env);
    if (!edge) throw new Error('本机没有找到 Edge');
    sweepStale({ logger });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-posts-'));
    markOwner(tmp);
    const prof = copyProfile(tmp, env);
    const port = 9300 + Math.floor(Math.random() * 600);
    let proc = null;
    try {
      if (!prof.copied) throw new Error(prof.error || '复制 Edge 登录状态失败');
      proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--window-size=1400,900', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
      for (let i = 0; i < 40; i += 1) {
        await delay(500);
        try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return { proc, tmp, port }; } catch { /* 还没起来 */ }
      }
      throw new Error('无头 Edge 没有启动');
    } catch (error) { await kill({ proc, tmp }); throw error; }
  }
  // 按进程号结束整棵 Edge 进程树（只动自己启动的这一个），再删临时目录（登录状态副本）。
  async function kill({ proc, tmp }) {
    if (proc?.pid && proc.exitCode === null) {
      try { spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch { try { proc.kill(); } catch { /* 已退 */ } }
    }
    await delay(800);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch (e) { logger.warn?.('[company-forum] Edge 临时目录未删净', e.code || e.message); }
  }
  // Hub 退出时同步收尾：before-quit 不等异步任务，异步删目录会被进程退出打断（临时目录就是这样留下的）。
  function stopSync() {
    clearTimeout(idleTimer); idleTimer = null;
    const cur = inst; inst = null;
    if (!cur) return;
    if (cur.proc?.pid && cur.proc.exitCode === null) {
      try { spawnSync('taskkill.exe', ['/PID', String(cur.proc.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch { try { cur.proc.kill(); } catch { /* 已退 */ } }
    }
    try { fs.rmSync(cur.tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch (e) { logger.warn?.('[company-forum] Edge 临时目录未删净，下次启动时再清', e.code || e.message); }
  }
  async function stop() { clearTimeout(idleTimer); idleTimer = null; const cur = inst; inst = null; if (cur) await kill(cur); }

  // 开一个新标签页，接上调试协议；api 匹配的 JSON 响应收进 out。
  async function withPage(api, fn) {
    clearTimeout(idleTimer); idleTimer = null;
    if (inst && inst.proc.exitCode !== null) { await kill(inst); inst = null; }
    if (!inst) inst = await start();
    const { port } = inst;
    let target = null, ws = null;
    try {
      target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('连接无头 Edge 失败')); });
      let id = 0;
      const pending = new Map(), watch = new Map(), out = [];
      const send = (method, params = {}) => within(new Promise(resolve => { id += 1; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }), 8000, null);
      ws.onmessage = async ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
        if (m.method === 'Network.responseReceived') {
          const r = m.params.response || {};
          if (/json/i.test(r.mimeType || '') && (!api || api.test(r.url || ''))) watch.set(m.params.requestId, { url: r.url, status: r.status });
        } else if (m.method === 'Network.loadingFinished' && watch.has(m.params.requestId)) {
          const meta = watch.get(m.params.requestId); watch.delete(m.params.requestId);
          if (m.params.encodedDataLength > 3e6) return;
          const b = await send('Network.getResponseBody', { requestId: m.params.requestId });
          try {
            const text = b.result.base64Encoded ? Buffer.from(b.result.body, 'base64').toString('utf8') : b.result.body;
            out.push({ ...meta, json: JSON.parse(text) });
          } catch { /* 不是 JSON */ }
        }
      };
      const run = async script => (await send('Runtime.evaluate', { expression: script, returnByValue: true }))?.result?.result?.value ?? null;
      await send('Network.enable'); await send('Page.enable');
      return await fn({ send, run, out });
    } finally {
      try { ws?.close(); } catch { /* 已关 */ }
      if (target?.id) { try { await within(fetch(`http://127.0.0.1:${port}/json/close/${target.id}`), 3000, null); } catch { /* 进程已退 */ } }
      idleTimer = setTimeout(() => { void stop(); }, idleMs);
      idleTimer.unref?.();
    }
  }
  // 等页面安定：正文长度连续两次（间隔 1.5 秒）不变且不为空，最多 maxMs；until 给了且对应接口已截到时提前结束。
  async function settle({ run, out }, { minMs = 2500, maxMs = 25000, until = null } = {}) {
    const start = Date.now();
    let last = -1, same = 0;
    await delay(minMs);
    while (Date.now() - start < maxMs) {
      if (until && out.some(r => until.test(String(r.url)))) { await delay(500); return; }
      const n = await run('document.body ? document.body.innerText.length : 0');
      if (typeof n === 'number' && n > 0 && n === last) { same += 1; if (same >= 2) return; } else same = 0;
      last = n;
      await delay(1500);
    }
  }
  // 还停在登录页：不在目标站点上（统一登录入口），或页面是登录表单的字样。
  const onLogin = (p, base) => !p || (!!hostOf(base) && hostOf(p.finalUrl) !== hostOf(base)) || (LOGIN_WORDS.test(String(p.text).slice(0, 3000)) && p.textLength < 4000);
  function serial(fn) { const p = busy.then(fn, fn); busy = p.catch(() => {}); return p; }

  // 参数与返回同 company-forum-browser.js 的 capture；多一个 until（见 settle）。
  // 免密登录要先到登录页、验证、再跳回（公司真机 9–40 秒），登录页上至少等 40 秒才判「需要登录」。
  function capture({ url, base = '', clickText = '', clickUnless = null, sections = [], api = null, maxMs = 25000, loginGraceMs = 0, until = null }) {
    return serial(() => withPage(api, async page => {
      const grace = Math.max(loginGraceMs, 40000);
      await page.send('Page.navigate', { url });
      await settle(page, { maxMs, until });
      let p = await page.run(collectScript(sections));
      const since = Date.now();
      while (onLogin(p, base) && Date.now() - since < grace) { await delay(2000); p = await page.run(collectScript(sections)); }
      if (onLogin(p, base)) return { ...(p || { finalUrl: url, textLength: 0, text: '', links: [], sections: [] }), needsLogin: true, json: [], via: 'edge' };
      if (Date.now() - since > 1500) { await settle(page, { minMs: 1500, maxMs, until }); p = await page.run(collectScript(sections)) || p; }
      const haveData = clickUnless && page.out.some(r => clickUnless.test(String(r.url)));
      if (clickText && !haveData && await page.run(clickScript(clickText))) { await settle(page, { minMs: 2000, maxMs: 15000 }); p = await page.run(collectScript(sections)) || p; }
      await delay(300);
      return { ...p, needsLogin: false, json: page.out.slice(0, 80), via: 'edge' };
    }));
  }
  function detail({ url, base = '', api = null, maxMs = 20000 }) {
    return serial(() => withPage(api, async page => {
      await page.send('Page.navigate', { url });
      await settle(page, { maxMs });
      let p = await page.run(DETAIL_SCRIPT);
      // 详情页偶尔也要过一次登录入口：停在别的域名时再等一会儿。
      const since = Date.now();
      while (p && base && hostOf(p.finalUrl) !== hostOf(base) && Date.now() - since < 30000) { await delay(2000); p = await page.run(DETAIL_SCRIPT); }
      p = p || { finalUrl: url, text: '', textLength: 0 };
      return { ...p, needsLogin: onLogin(p, base), json: page.out.slice(0, 20), via: 'edge' };
    }));
  }
  function close() { return stop(); }
  return { capture, detail, close, closeSync: stopSync };
}

module.exports = { createEdgeBrowser, sweepStale, STALE_PREFIXES };
