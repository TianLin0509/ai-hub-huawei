'use strict';
//   假门户按 Cookie 认登录：没登录时一律跳到 /login（带密码框，永远不会自动跳回），所以无头 Edge 原路线必然停在登录页；
//   每轮把服务端的登录令牌换掉（等于上一轮在 Hub 里的登录失效），然后：
//     刷新 → 原路线（以及上一轮留下的 Hub 登录）都停在登录页 → 页面出现「在 Hub 里登录一次门户」→ 点它 → 登录窗口
//     → 偶数轮在窗口里填密码登录（应自动关窗并用 Hub 窗口读到待办），奇数轮直接关窗（应什么都不留）。
//   全程每秒采样：无头 Edge 主进程数、Hub 的子进程数、登录窗口个数；结束后与开始前的基线比较。
// 用法：node tests/e2e-company-w3-fallback-cdp.js [--rounds 20] [--out <截图目录>] [--electron <electron.exe>]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const { execFile } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

function fakePortal() {
  const st = { token: 't0', logins: 0 };
  const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json;charset=UTF-8' }); res.end(JSON.stringify(body)); };
  const ago = d => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10) + ' 10:05:51';
  const T = (id, desc, days) => ({ taskUUID: id, taskDesc: desc, time: ago(days), taskURL: 'https://flow.corp.example/t/' + encodeURIComponent(id), applicant: '某系统 00123456', handler: '某人 00654321' });
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(decodeURIComponent(req.url));
    const ok = new RegExp('(^|;\\s*)w3s=' + st.token + '(;|$)').test(req.headers.cookie || '');
    if (req.method === 'POST' && u.startsWith('/login')) {
      st.logins += 1;
      res.writeHead(302, { 'set-cookie': `w3s=${st.token}; Path=/; HttpOnly; Max-Age=86400`, location: '/next/indexa.html' }); return res.end();
    }
    if (u.startsWith('/next/service/rest/my/w3account')) return json(res, ok ? { uid: 'u1', email: 'someone@corp.example', profile: { lname: '某人' } } : {});
    if (ok) {
      if (u.startsWith('/service/rest/task/getappinfocount')) return json(res, { todoCount: 2, todoData: [{ appName: '绩效', appNum: '1' }, { appName: '考勤', appNum: '1' }] });
      if (u.startsWith('/service/rest/task/appinfo')) return json(res, [{ appName: '工时', appNum: '1' }]);
      const m = /^\/service\/rest\/task\/(tasklists|applists)\/([^?]+)/.exec(u);
      if (m) return json(res, { count: 1, data: [T(m[2], m[2] === '绩效' ? '请完成中期辅导与反馈' : m[2] === '工时' ? '本周工时' : '考勤异常，请确认', m[2] === '绩效' ? 34 : 3)] });
      if (u.startsWith('/next/proxyw3/')) return json(res, { data: { count: 0 } });
      if (u.startsWith('/service/rest/info/common/docs')) return json(res, {});
      if (u === '/' || u.startsWith('/login')) { res.writeHead(302, { location: '/next/indexa.html' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>Workplace</title><body><div>设为首页 | 我的收藏 | WeLink二维码 | 找人</div><h1>门户首页</h1></body>');
    }
    if (!u.startsWith('/login')) { res.writeHead(302, { location: '/login' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>统一身份认证</title><style>body{font:15px "Microsoft YaHei";background:#f3f5f8;display:grid;place-items:center;height:96vh}form{background:#fff;padding:36px 44px;border-radius:8px;box-shadow:0 2px 10px #0001;width:340px}input,button{display:block;width:100%;margin:10px 0;padding:9px;box-sizing:border-box;font:inherit}button{background:#c7000b;color:#fff;border:0;border-radius:4px}</style>
<form method="post" action="/login"><h2>统一身份认证 · 账号登录</h2><input name="u" placeholder="工号/邮箱" value="someone"><input id="pw" type="password" name="p" placeholder="密码"><button id="go" type="submit">登录</button><small>扫码登录 · 忘记密码</small></form>`);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, st })));
}

// 进程采样：Hub 主进程的全部后代（按名字分），以及系统里的无头 Edge 主进程（命令行带 --headless 且不是 --type= 子进程）。
function processTable() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 }, (err, out) => { try { resolve(JSON.parse(out)); } catch { resolve([]); } });
  });
}
async function sample(hubPid) {
  const rows = await processTable();
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ParentProcessId)) kids.set(r.ParentProcessId, []); kids.get(r.ParentProcessId).push(r); }
  const desc = []; const q = [hubPid];
  while (q.length) { const p = q.shift(); for (const k of kids.get(p) || []) { desc.push(k); q.push(k.ProcessId); } }
  const name = n => String(n || '').toLowerCase();
  const edgeAll = rows.filter(r => name(r.Name) === 'msedge.exe');
  const headlessMain = edgeAll.filter(r => /--headless/.test(r.CommandLine || '') && !/--type=/.test(r.CommandLine || ''));
  const headlessAll = edgeAll.filter(r => /--headless/.test(r.CommandLine || ''));
  return { hubDescendants: desc.length, hubElectron: desc.filter(r => name(r.Name) === 'electron.exe').length, hubEdge: desc.filter(r => name(r.Name) === 'msedge.exe').length,
    headlessEdgeMain: headlessMain.length, headlessEdgeAll: headlessAll.length, edgeSystemTotal: edgeAll.length };
}

async function run() {
  const rounds = Number(arg('--rounds', 20));
  const out = path.resolve(arg('--out', path.join(os.tmpdir(), 'w3-fallback-' + Date.now())));
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hubfb-e2e-')), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false, attendance: false, w3: true }));
  const { srv, st } = await fakePortal();
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const ev = { rounds: [], peaks: { headlessEdgeMain: 0, loginWindows: 0, hubElectron: 0, hiddenPortalWindows: 0 }, rendererErrors: [], overflow: {} };
  let hub, c, sampling = true;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'background', label: 'w3-fallback', ...(arg('--electron') ? { executablePath: arg('--electron') } : {}), extraEnv: {
      CLAUDE_HUB_COMPANY_W3: '1', CLAUDE_HUB_W3_TIMER: '0', CLAUDE_HUB_W3_URL: origin + '/', CLAUDE_HUB_W3_LOGIN_GRACE_MS: '3000',
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') ev.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 60000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* */ } await sleep(300); } throw Error('Timeout: ' + label); };
    const shot = async (client, name) => { await sleep(700); const f = path.join(out, `20261120-portalP-${name}.png`); fs.writeFileSync(f, Buffer.from((await client.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); return f; };
    const targets = async () => { try { return JSON.parse(await new Promise((res, rej) => http.get(hub.cdpHttpBase + '/json/list', r => { let b = ''; r.on('data', d => { b += d; }); r.on('end', () => res(b)); }).on('error', rej))); } catch { return []; } };
    const portalPages = async () => (await targets()).filter(t => t.type === 'page' && String(t.url).startsWith(origin));
    const status = () => c.eval(`ipcRenderer.invoke('company-w3:status')`);
    const P = `document.getElementById('company-w3-page')`;

    await wait(`typeof ipcRenderer !== 'undefined' && !!document.getElementById('btn-company-w3')`, 'w3 nav', 90000);
    // 首次自动取数（开启时触发的那一次）结束后再取基线。
    await c.eval(`document.getElementById('btn-company-w3').click()`);
    await wait(`ipcRenderer.invoke('company-w3:status').then(s=>s.ok&&s.lastResult&&!s.syncing)`, 'first sync done', 150000);
    await sleep(4000);
    ev.baseline = await sample(hub.pid);
    ev.baselineTargets = (await targets()).filter(t => t.type === 'page').length;
    // 采样线程：每秒一次，记峰值。
    (async () => {
      while (sampling) {
        const [s, pages] = await Promise.all([sample(hub.pid), portalPages()]);
        ev.peaks.headlessEdgeMain = Math.max(ev.peaks.headlessEdgeMain, s.headlessEdgeMain);
        ev.peaks.hubElectron = Math.max(ev.peaks.hubElectron, s.hubElectron);
        ev.peaks.hiddenPortalWindows = Math.max(ev.peaks.hiddenPortalWindows, pages.length);
        await sleep(1000);
      }
    })();

    for (let i = 0; i < rounds; i += 1) {
      const R = { i, mode: i % 2 === 0 ? 'login' : 'cancel' };
      const t0 = Date.now();
      st.token = 't' + (i + 1);
      const fail = await c.eval(`ipcRenderer.invoke('company-w3:sync')`);
      R.fail = { ok: fail.lastResult?.ok, kind: fail.lastResult?.kind, hubTried: fail.lastResult?.hubTried || '', hubLogin: fail.hubLogin };
      if (fail.lastResult?.ok !== false || fail.lastResult?.kind !== 'login') throw Error(`第 ${i} 轮：刷新应停在登录页：` + JSON.stringify(R.fail));
      const btnSel = `${P}.querySelector('[data-w3="hub-login"]')`;
      await wait(`${btnSel}&&!${btnSel}.disabled`, 'hub-login button', 15000);
      if (i === 0) {
        ev.failPage = await c.eval(`(()=>{const b=${P}.querySelector('.w3p-blank')||${P}.querySelector('[data-slot="alert"]');return {text:b.innerText,buttons:[...b.querySelectorAll('button')].map(x=>x.innerText)}})()`);
        ev.overflow.failPage = await c.eval(`(()=>{const p=${P};return p.scrollHeight>p.clientHeight+1})()`);
        ev.shots = [await shot(c, '01-门户-停在登录页给出Hub登录按钮')];
      }
      const before = (await portalPages()).length;
      await c.eval(`${btnSel}.click()`);
      let lw = null;
      for (const end = Date.now() + 20000; Date.now() < end && !lw;) { lw = (await portalPages())[0] || null; if (!lw) await sleep(300); }
      if (!lw) throw Error(`第 ${i} 轮：没看到登录窗口`);
      R.windowsWhenOpen = (await portalPages()).length;
      ev.peaks.loginWindows = Math.max(ev.peaks.loginWindows, R.windowsWhenOpen - before);
      // 再点一次按钮（模拟用户着急连点）：不应多开第二个窗口。
      await c.eval(`ipcRenderer.invoke('company-w3:login')`).then(r => { R.secondClick = r?.reason || (r?.ok ? 'ok' : 'other'); });
      R.windowsAfterSecondClick = (await portalPages()).length;
      if (R.windowsWhenOpen !== 1 || R.windowsAfterSecondClick !== 1 || R.secondClick !== 'already-open') throw Error(`第 ${i} 轮：登录窗口应只有 1 个：` + JSON.stringify({ open: R.windowsWhenOpen, second: R.windowsAfterSecondClick, click: R.secondClick }));
      const lc = await connectCDP(lw.webSocketDebuggerUrl);
      try {
        await lc.send('Runtime.enable');
        const lwait = async (expr, label, timeout = 15000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await lc.eval(expr); if (v) return v; } catch { /* */ } await sleep(250); } throw Error('Timeout: ' + label); };
        await lwait(`document.readyState==='complete'&&!!document.getElementById('pw')`, 'login form');
        if (i === 0) ev.shots.push(await shot(lc, '02-Hub登录窗口'));
        if (R.mode === 'login') { await lc.eval(`document.getElementById('pw').value='x';document.getElementById('go').click();true`); }
        else await lc.eval(`window.close();true`).catch(() => {});
      } finally { try { lc.close(); } catch { /* 窗口已关 */ } }
      // 等登录窗口自己消失。
      const tClose = Date.now(), loginsBefore = st.logins;
      for (const end = Date.now() + 60000; Date.now() < end;) { if (!(await portalPages()).some(p => p.id === lw.id)) break; await sleep(300); }
      R.loginWindowGone = !(await portalPages()).some(p => p.id === lw.id);
      R.closeMs = Date.now() - tClose; R.portalLoginPosts = st.logins - loginsBefore;
      if (!R.loginWindowGone) throw Error(`第 ${i} 轮：登录窗口 60 秒内没有销毁（收到登录提交 ${R.portalLoginPosts} 次）`);
      if (R.mode === 'login') {
        const s = await wait(`ipcRenderer.invoke('company-w3:status').then(s=>s.lastResult&&s.lastResult.reason==='login'&&!s.syncing&&s.lastResult.at>${JSON.stringify(new Date(t0).toISOString())}?s:null)`, 'sync after login', 60000);
        R.after = { ok: s.lastResult.ok, via: s.lastResult.via || 'edge', todo: s.todo.length };
        if (!s.lastResult.ok || s.lastResult.via !== 'hub') throw Error(`第 ${i} 轮：登录后应经 Hub 窗口读到：` + JSON.stringify(s.lastResult));
        if (i === 0) {
          await wait(`${P}.querySelector('.w3p-row')`, 'rows', 15000);
          ev.overflow.rows = await c.eval(`(()=>{const p=${P};const b=p.querySelector('.w3p-body');return {page:p.scrollHeight>p.clientHeight+1,body:b.scrollHeight>b.clientHeight+1}})()`);
          ev.shots.push(await shot(c, '03-门户-Hub登录后读到待办'));
        }
      } else {
        await sleep(1500);
        const s = await status();
        R.after = { lastReason: s.lastResult?.reason, hubLogin: s.hubLogin };
        if (s.lastResult?.reason === 'login') throw Error(`第 ${i} 轮：取消登录不应触发取数`);
      }
      await sleep(1500);
      R.hiddenWindowsLeft = (await portalPages()).length;
      R.proc = await sample(hub.pid);
      if (R.hiddenWindowsLeft !== 0) throw Error(`第 ${i} 轮：留下了 ${R.hiddenWindowsLeft} 个门户窗口`);
      if (!R.proc.hubDescendants) throw Error(`第 ${i} 轮：进程采样失败，无法验证`);
      R.ms = Date.now() - t0;
      ev.rounds.push(R);
      console.error(`[round ${i}] ${R.mode} ok, ${R.ms} ms, closeMs=${R.closeMs} edgeMain=${R.proc.headlessEdgeMain} hubElectron=${R.proc.hubElectron} portalWindows=${R.hiddenWindowsLeft}`);
    }
    sampling = false;
    await sleep(6000);
    ev.final = await sample(hub.pid);
    ev.finalTargets = (await targets()).filter(t => t.type === 'page').length;
    ev.portalLogins = st.logins;
    ev.leftoverEdgeDirs = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('hub-w3-')).length;
    const logFile = path.join(data, 'logs', 'company-w3.log');
    // 防风暴判定：采样成功、无头 Edge 同时最多 1 个、结束后 Edge 与 Hub 子进程回到基线、页面目标数回到基线。
    if (!ev.baseline.hubDescendants || !ev.final.hubDescendants) throw Error('进程采样失败，防风暴未验证');
    if (ev.peaks.headlessEdgeMain > 1) throw Error('无头 Edge 同时超过 1 个：' + ev.peaks.headlessEdgeMain);
    if (ev.peaks.loginWindows > 1 || ev.peaks.hiddenPortalWindows > 1) throw Error('门户窗口同时超过 1 个');
    if (ev.final.headlessEdgeAll !== ev.baseline.headlessEdgeAll || ev.final.hubEdge !== ev.baseline.hubEdge) throw Error('Edge 进程没回到基线');
    if (ev.final.hubElectron > ev.baseline.hubElectron) throw Error(`Hub 子进程多了：${ev.baseline.hubElectron} → ${ev.final.hubElectron}`);
    if (ev.finalTargets !== ev.baselineTargets) throw Error(`页面数没回到基线：${ev.baselineTargets} → ${ev.finalTargets}`);
    ev.logTail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-3).map(l => JSON.parse(l));
  } catch (error) {
    ev.error = error.message;
    try { fs.writeFileSync(path.join(out, '20261120-portalP-error.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* */ }
  } finally {
    sampling = false;
    try { c?.close?.(); } catch { /* */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    srv.close();
    await sleep(3000);
    ev.afterQuit = { headlessEdgeMain: (await sample(-1)).headlessEdgeMain };
    if (ev.baseline && ev.afterQuit.headlessEdgeMain > ev.baseline.headlessEdgeMain) ev.error = (ev.error ? ev.error + '；' : '') + 'Hub 退出后留下了无头 Edge';
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch { /* 留给系统清理 */ }
  }
  fs.writeFileSync(path.join(out, '20261120-portalP-evidence.json'), JSON.stringify(ev, null, 1));
  const summary = { error: ev.error, rounds: ev.rounds.length, baseline: ev.baseline, final: ev.final, peaks: ev.peaks, afterQuit: ev.afterQuit, baselineTargets: ev.baselineTargets, finalTargets: ev.finalTargets, portalLogins: ev.portalLogins, overflow: ev.overflow, rendererErrors: ev.rendererErrors.length };
  console.log(JSON.stringify(summary, null, 1));
  if (ev.error) process.exitCode = 1;
}
run();
