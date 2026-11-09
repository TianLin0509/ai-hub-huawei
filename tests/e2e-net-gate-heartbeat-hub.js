'use strict';
// 放行心跳·真实隔离 Hub（成员版源码，2026-11-08）：Hub 自己启动心跳，发现被拦就在看不见的窗口里自动点放行。
// 本机模拟的公司代理：自家放行小页被拦时跳到放行页（两个不认识文字的蓝色大按钮，左边是放行、只认真实点击、点 2 次才生效）。
// 验证：不点任何界面，Hub 后台自己放行；放行窗口点完即关，主窗口外不留页面；不连接真实服务、不启动 AI。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const OWN = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>AI HUB 服务</title></head><body><p>AI HUB 服务正常。</p></body></html>';
const blue = 'style="display:inline-block;width:200px;height:56px;margin:20px;background:#3478f6;color:#fff;border:0"';

function server() {
  const g = { gated: false, need: 2, oks: 0, wrong: 0, gateViews: 0, probes: 0 };
  g.srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const html = b => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(b); };
    if (u.pathname === '/gate/ok' && req.method === 'POST') { g.oks += 1; if (g.oks >= g.need) g.gated = false; res.writeHead(204); return res.end(); }
    if (u.pathname === '/gate/wrong') { g.wrong += 1; res.writeHead(204); return res.end(); }
    if (u.pathname === '/gate/warn') {
      g.gateViews += 1;
      return html(`<!doctype html><meta charset="utf-8"><title>HIS Proxy Notification</title><button class="btn" ${blue} id="l">Visit site</button><button class="btn" ${blue} id="r">Learn more</button>
        <script>l.addEventListener('click', e => { if (e.isTrusted) fetch('/gate/ok', { method: 'POST' }); }); r.addEventListener('click', () => fetch('/gate/wrong', { method: 'POST' }));</script>`);
    }
    if (u.pathname === '/hub-update/api/feedback') {
      g.probes += 1;
      if (g.gated) { res.writeHead(302, { Location: `http://127.0.0.1:${g.port}/gate/warn` }); return res.end(); }
      if (req.method === 'POST') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"ok": false, "error": {"code": "not_found"}}'); }
      return html(OWN);
    }
    if (u.pathname.endsWith('latest.json')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"version":"0.0.1","files":[]}'); }
    res.writeHead(404); res.end();
  });
  return new Promise(r => g.srv.listen(0, '127.0.0.1', () => { g.port = g.srv.address().port; r(g); }));
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || os.tmpdir(), 'gate-hb-hub-'));
  const out = path.resolve(__dirname, '..', 'artifacts', '20261108-net-gate-heartbeat-claude1');
  fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, scope: '真实隔离 Hub（成员版源码、Electron 主进程、看不见的窗口、真实网络请求）+ 本机模拟放行页；不代表公司真实代理页面', checks: [] };
  const check = (m, extra) => { result.checks.push(extra ? { m, ...extra } : m); console.log('✓ ' + m); };
  const g = await server();
  let hub, c;
  try {
    const dataDir = path.join(testRoot, 'data');
    const base = `http://127.0.0.1:${g.port}`;
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'gate-heartbeat-hub', windowMode: 'background',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(testRoot, 'home'), CLAUDE_HUB_GATE_HEARTBEAT_MS: '2500', CLAUDE_HUB_BRIDGE_TIMER: '0',
        CLAUDE_HUB_WIRELESS_TIMER: '0', HUB_ASSISTANT_FAST_LANE: '0', DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '',
        AI_HUB_UPDATE_SOURCES: JSON.stringify([{ id: 'own', name: '自家', manifest: `${base}/hub-update/x/latest.json`, files: `${base}/hub-update/x/v{version}/` }]) } });
    c = await connectFirstPage(hub);
    const state = () => c.eval('require("electron").ipcRenderer.invoke("net-unblock:state")');
    const until = async (label, read, ms) => { for (const end = Date.now() + ms; Date.now() < end;) { const v = await read(); if (v) return v; await wait(500); } throw new Error('超时：' + label); };

    const s0 = await until('心跳启动', async () => { const s = await state(); return s && s.heartbeats && s.heartbeats[0] && s.heartbeats[0].lastProbe ? s : null; }, 60000);
    assert.equal(s0.auto, true, '成员版应开启自动放行');
    assert.equal(s0.heartbeats[0].lastProbe.state, 'ok');
    assert.equal(g.gateViews, 0);
    check('成员版启动后心跳自己跑起来；没被拦时只探不点', { probes: g.probes });

    g.gated = true;
    const t0 = Date.now();
    await until('自动放行', async () => !g.gated && (await state()).heartbeats[0].gated === false && g.oks >= g.need, 90000);
    assert.equal(g.wrong, 0, '不能点右边');
    check('被拦后不点任何界面，Hub 后台自动连点左边按钮（真实点击）直到放行', { seconds: Math.round((Date.now() - t0) / 1000), clicks: g.oks });
    // 放行那一刻可能还有一个窗口在收尾（点完等页面跳转）：给 15 秒关掉。
    let left = [];
    for (let i = 0; i < 30; i++) { left = (await (await fetch(`http://127.0.0.1:${hub.port}/json/list`)).json()).filter(p => p.type === 'page' && /^http/.test(p.url) && /gate|hub-update/.test(p.url)); if (!left.length) break; await wait(500); }
    if (left.length) console.log('LEFT', JSON.stringify(left.map(p => ({ url: p.url, title: p.title }))));
    assert.deepEqual(left.map(p => p.url), [], '放行窗口应已关闭');
    check('放行窗口点完即关，没有留下页面');
    const log = fs.readFileSync(path.join(dataDir, 'logs', 'net-unblock.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(log.some(x => x.result === 'passed'));
    check('写了放行日志', { results: log.map(x => x.result + (x.method ? '/' + x.method : '')) });
    result.passed = true;
  } catch (error) { result.error = error.stack || String(error); console.error(error); process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(out, '20261108-net-gate-heartbeat-hub-result-claude1.json'), JSON.stringify(result, null, 1));
    if (c) await c.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    g.srv.close();
  }
})();
