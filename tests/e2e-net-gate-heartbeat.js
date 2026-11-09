'use strict';
// 放行心跳 + 看不见的窗口里真实点击（2026-11-08）：真实 Electron 主进程 + 本机模拟的公司代理。
// 运行：node tests/e2e-net-gate-heartbeat.js（脚本自己用 Electron 跑自己，窗口全程不显示）。
// 模拟代理三种放行页：
//   A 两个不认识文字的蓝色大按钮，左边是放行，且只认真实点击（isTrusted），要点 3 次才生效（模拟「不灵敏」）；
//   B 放行按钮在内嵌页（iframe）里；
//   C GET 已放行、POST 仍被拦（2026-10-30 真机）。
// 验证：心跳发现被拦 → 自动连点 → 通了报恢复；没被拦时一次都不点；结果写到 artifacts。
const path = require('node:path');
const fs = require('node:fs');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const electron = require('electron');
  const child = spawn(electron, [__filename], { stdio: 'inherit', windowsHide: true, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' } });
  child.on('exit', code => process.exit(code ?? 1));
  return;
}

const http = require('node:http');
const assert = require('node:assert/strict');
const { app, BrowserWindow, net } = require('electron');
const netUnblock = require('../core/net-unblock');
const { GateHeartbeat, probeOwnPage } = require('../core/net-gate-heartbeat');

const OWN = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>AI HUB 服务</title></head><body><p>AI HUB 服务正常。这个页面只用于网络放行，可以关闭。</p></body></html>';
const blue = 'style="display:inline-block;width:200px;height:56px;margin:20px;background:#3478f6;color:#fff;border:0;font-size:18px"';
function gatePage(mode) {
  if (mode === 'B') return `<!doctype html><meta charset="utf-8"><title>Notice</title><p>访问提示</p><iframe src="/gate/frame" width="800" height="300"></iframe>`;
  return `<!doctype html><meta charset="utf-8"><title>HIS Proxy Notification</title><p>The site is uncategorized.</p>
    <button class="btn" ${blue} id="l">Visit site</button><button class="btn" ${blue} id="r">Learn more</button>
    <script>document.getElementById('l').addEventListener('click', e => { if (!e.isTrusted) return; fetch('/gate/ok', { method: 'POST' }); });
    document.getElementById('r').addEventListener('click', () => fetch('/gate/wrong', { method: 'POST' }));</script>`;
}
function server() {
  const g = { mode: 'A', gatedGet: false, gatedPost: false, need: 3, oks: 0, wrong: 0, gateViews: 0 };
  g.srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const html = body => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); };
    if (u.pathname === '/gate/ok' && req.method === 'POST') { g.oks += 1; if (g.oks >= g.need) { g.gatedGet = false; g.gatedPost = false; } res.writeHead(204); return res.end(); }
    if (u.pathname === '/gate/wrong') { g.wrong += 1; res.writeHead(204); return res.end(); }
    if (u.pathname === '/gate/frame') return html(`<!doctype html><meta charset="utf-8"><button ${blue} onclick="fetch('/gate/ok',{method:'POST'})">接受风险并访问</button><button ${blue}>返回</button>`);
    if (u.pathname === '/gate/warn') { g.gateViews += 1; return html(gatePage(g.mode)); }
    if (u.pathname === '/hub-update/api/feedback') {
      const gated = req.method === 'POST' ? g.gatedPost : g.gatedGet;
      if (gated) { res.writeHead(302, { Location: `http://127.0.0.1:${g.port}/gate/warn` }); return res.end(); }
      if (req.method === 'POST') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"ok": false, "error": {"code": "not_found"}}'); }
      return html(OWN);
    }
    res.writeHead(404); res.end();
  });
  return new Promise(r => g.srv.listen(0, '127.0.0.1', () => { g.port = g.srv.address().port; r(g); }));
}

const until = async (label, fn, ms) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return; await new Promise(r => setTimeout(r, 300)); } throw new Error('超时：' + label); };

app.whenReady().then(async () => {
  const out = path.resolve(__dirname, '..', 'artifacts', '20261108-net-gate-heartbeat-claude1');
  fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, scope: '真实 Electron 主进程、看不见的窗口、真实网络请求 + 本机模拟放行页；不代表公司真实代理页面', checks: [] };
  const check = (m, extra) => { result.checks.push(extra ? { m, ...extra } : m); console.log('✓ ' + m); };
  const g = await server();
  const url = `http://127.0.0.1:${g.port}/hub-update/api/feedback`;
  const logDir = path.join(out, 'logs'); fs.rmSync(logDir, { recursive: true, force: true });
  const passer = new netUnblock.GatePasser({ logDir, logName: 'net-unblock', budget: new netUnblock.ClickBudget(),
    open: (_u, opts) => opts && opts.method === 'POST' ? netUnblock.postInHiddenWindow(BrowserWindow, url, {}) : netUnblock.openHiddenGateWindow(BrowserWindow, url) });
  let passedCount = 0;
  const hb = new GateHeartbeat({ url, passer, intervalMs: 1500, settleMs: 1200, probe: () => probeOwnPage((...a) => net.fetch(...a), url), onPassed: () => { passedCount += 1; } });
  try {
    // 0. 没被拦：心跳照跑，一次都不点。
    await hb.tick(); await hb.tick();
    assert.equal(g.gateViews, 0); assert.equal(g.oks, 0);
    check('没被拦：心跳探到自家小页，不开放行窗口、不点');

    // A. 不认识文字的两个蓝色大按钮、只认真实点击、要点 3 次。
    Object.assign(g, { mode: 'A', gatedGet: true, gatedPost: true, need: 3, oks: 0 });
    const t0 = Date.now();
    hb.start();
    await until('A 放行', () => passedCount === 1, 90000);
    assert.equal(g.wrong, 0, '不能点右边那个');
    assert.ok(g.oks >= 3);
    const logA = fs.readFileSync(path.join(logDir, 'net-unblock.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(logA.some(x => x.result === 'clicked' && /trusted/.test(x.method) && x.how === 'left'), '应是真实点击 + 左边兜底');
    check('A：左边蓝色按钮（文字不认识、只认真实点击、点 3 次才生效）自动连点到通', { seconds: Math.round((Date.now() - t0) / 1000), clicks: g.oks, methods: logA.filter(x => x.method).map(x => x.method) });
    // 放行窗口点完即关。
    assert.equal(BrowserWindow.getAllWindows().length, 0, '看不见的窗口应全部关闭');
    check('放行窗口点完即关');

    // B. 放行按钮在内嵌页里。
    Object.assign(g, { mode: 'B', gatedGet: true, gatedPost: true, need: 1, oks: 0 });
    await until('B 放行', () => passedCount === 2, 60000);
    check('B：放行按钮在内嵌页（iframe）里也能点到');

    // C. GET 已放行、POST 仍被拦。
    Object.assign(g, { mode: 'A', gatedGet: false, gatedPost: true, need: 1, oks: 0 });
    await until('C 放行', () => passedCount === 3, 60000);
    const logC = fs.readFileSync(path.join(logDir, 'net-unblock.log'), 'utf8').trim().split('\n').map(JSON.parse);
    check('C：只有 POST 被拦时，在窗口里直接 POST 让拦截页出来再点', { last: logC.slice(-2).map(x => x.result) });
    result.passed = true;
  } catch (error) { result.error = error.stack || String(error); console.error(error); process.exitCode = 1; }
  finally {
    hb.stop(); g.srv.close();
    fs.writeFileSync(path.join(out, '20261108-net-gate-heartbeat-result-claude1.json'), JSON.stringify(result, null, 1));
    console.log(path.join(out, '20261108-net-gate-heartbeat-result-claude1.json'));
    app.exit(process.exitCode || 0);
  }
});
app.on('window-all-closed', () => {});
