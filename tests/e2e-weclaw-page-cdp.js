'use strict';
// 「员工助手」页真实界面检查：隔离 Hub + 假 CodeAgent + 假的员工助手本机服务（随机端口），不碰真实员工助手。
//   全新用户：左侧栏有「员工助手 Beta」入口 → 页面一屏 → 一键接入 → 假服务收到指向本机代理的配置 → 断开后配置被删掉。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'artifacts/weclaw-page-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

function fakeWeclaw(port) {
  const state = { provider: null, calls: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      state.calls.push({ method: req.method, url: req.url });
      const send = (code, json) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.url === '/v1/health') return send(200, { status: 'ok', userId: 'tester' });
      if (req.url === '/v1/config/opencode/global/models' && req.method === 'GET') {
        const providers = [{ id: 'myagent', name: '体验模型', options: {}, models: { Qwen: {} } }];
        if (state.provider) providers.push({ id: 'myprovider_hubh', options: state.provider.options, models: state.provider.models });
        return send(200, { providers });
      }
      if (req.url.endsWith('/models/provider') && req.method === 'PUT') { state.provider = JSON.parse(body).myprovider_hubh; return send(200, { ok: true, pendingReload: false }); }
      if (req.url.endsWith('/models/provider/myprovider_hubh') && req.method === 'DELETE') { state.provider = null; return send(200, { ok: true }); }
      return send(404, {});
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, state })));
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-weclaw-page-')), dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const agentPort = await freePort(), fake = await fakeWeclaw(agentPort);
  const result = { passed: false, testRoot: root, checks: [], fixture: '隔离 Hub，假 CodeAgent，假员工助手本机服务；不碰真实员工助手' };
  let hub, c;
  const stop = async () => { if (hub) { result.teardown = await gracefulQuit(hub); hub = null; } if (c) { await c.close(); c = null; } };
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'weclaw-page', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: path.join(repo, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      AI_HUB_WECLAW_BASE: `http://127.0.0.1:${agentPort}`,
      ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline test' }, foreign: { ok: false, error: 'offline test' } }),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(150); } throw Error('Timeout: ' + expr); };
    const click = async selector => {
      const point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    };
    const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
    const oneScreen = () => c.eval(`(()=>{const b=document.querySelector('#weclaw-page .wcx-body');return{fits:b.scrollHeight<=b.clientHeight+1,h:b.scrollHeight,ch:b.clientHeight}})()`);
    await until(`(()=>{const b=document.getElementById('btn-weclaw');return !!b&&!b.hidden&&b.offsetWidth>0})()`);
    result.checks.push('左侧栏显示「员工助手 Beta」入口');
    result.rail = await c.eval(`(()=>{const r=e=>{const b=e.getBoundingClientRect();return [e.id||e.className,Math.round(b.top),Math.round(b.height),getComputedStyle(e).display]};const w=document.getElementById('btn-weclaw');const rail=w.parentElement;return {parent:rail.id||rail.className,sh:rail.scrollHeight,ch:rail.clientHeight,ov:getComputedStyle(rail).overflowY,items:[...rail.children].map(r)}})()`);
    await click('#btn-weclaw');
    await until(`!!document.querySelector('#weclaw-page [data-wc="connect"]')`);
    await _waitMs(300); await shot('1-before');
    result.before = await oneScreen(); assert.ok(result.before.fits, '接入前一屏');
    result.navActive = await c.eval(`(()=>{const b=document.getElementById('btn-weclaw');return b.classList.contains('active')||b.getAttribute('aria-current')==='page'})()`);
    result.checks.push('全新用户打开页面：一屏，有「一键接入」');
    await click('#weclaw-page [data-wc="connect"]');
    await until(`!document.querySelector('#weclaw-page [data-wc="connect"]') || !!document.querySelector('#weclaw-page .wcx-err')`, 120000);
    await _waitMs(500); await shot('2-after-connect');
    const err = await c.eval(`document.querySelector('#weclaw-page .wcx-err')?.textContent||''`);
    result.connectError = err;
    if (!err) {
      assert.ok(fake.state.provider, '假员工助手收到配置');
      assert.match(fake.state.provider.options.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      assert.ok(fake.state.provider.options.apiKey.endsWith('.weclaw__pin_personal'));
      // 隔离环境里没有真 CodeAgent，代理会报「上游未就绪」：第 3 步显示「已接入，暂不可用」（busy）也算接上了。
      await until(`!!document.querySelector('#weclaw-page [data-step="3"] [data-wc="disconnect"]')`);
      result.stepsAfterConnect = await c.eval(`[...document.querySelectorAll('#weclaw-page .wcx-step')].map(e=>e.dataset.state).join(',')`);
      await click('#weclaw-page [data-step="4"] [data-wc="test"]');
      await until(`!['busy'].includes(document.querySelector('#weclaw-page [data-step="4"]')?.dataset.state) && !document.querySelector('#weclaw-page [data-step="4"] button')?.disabled`, 90000);
      result.testStep = await c.eval(`document.querySelector('#weclaw-page [data-step="4"]').textContent`);
      result.checks.push('试一次：' + result.testStep);
      await shot('3-linked');
      result.after = await oneScreen(); assert.ok(result.after.fits, '接入后一屏');
      result.checks.push(`一键接入：员工助手收到指向本机代理的配置（${fake.state.provider.options.baseURL}），默认只用本人账号，页面显示已接入`);
      await click('#weclaw-page [data-wc="disconnect"]');
      await until(`!!document.querySelector('#weclaw-page [data-wc="connect"]')`);
      assert.equal(fake.state.provider, null);
      result.checks.push('断开：员工助手里的配置被删掉，页面回到未接入');
    } else result.checks.push('接入报错（就地显示）：' + err);
    result.passed = !err;
    if (err) process.exitCode = 1;
  } catch (error) {
    result.error = error.stack; result.logTail = error.logTail; process.exitCode = 1;
    if (c) try { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'failure.png'), Buffer.from(s.data, 'base64')); } catch {}
  } finally { await stop(); fake.server.close(); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
})();
