'use strict';
// 专属 WeLink 助手界面验收（2026-11-13）：真实界面 + 真实主进程，WeLink 接口与网关换成本机假服务。
// 全新数据目录走一遍：手机页 → 创建我的专属助手 → 出二维码 → 假装手机确认 → 自动开启并连上网关 → 私聊一句进助理。
// 用法：node tests/e2e-company-welink-bot-cdp.js [输出目录]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'artifacts/welink-bot-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-welink-bot-')), dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: true, forum: false }));
  const result = { passed: false, testRoot: root, checks: [], fixture: 'isolated Hub, real renderer/IPC, fake WeLink register API + gateway on 127.0.0.1' };
  // 假 WeLink：扫码接口 + 网关
  let confirm = false; const frames = [];
  let apiHits = 0;
  const api = http.createServer((req, res) => {
    apiHits += 1;
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url.endsWith('/im-register/qrcode')) return res.end(JSON.stringify({ code: '200', data: { qrcode: 'Q1', accessToken: 'T1', pcUrl: 'welink://test?q=Q1', weUrl: 'h5://test/index.html?qrcode=Q1#/createAssistant' } }));
    if (req.url.includes('/qrcode-detail/')) return res.end(JSON.stringify({ code: '200', data: confirm ? { status: 2, ak: 'AK-test', sk: 'SK-test', name: '助手' } : { status: 0 } }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: p => [...p][0] });
  await new Promise(r => wss.on('listening', r));
  let sock = null, authOk = false;
  wss.on('connection', (ws, req) => {
    sock = ws; authOk = /^auth\./.test(req.headers['sec-websocket-protocol'] || '');
    ws.on('message', raw => { const m = JSON.parse(String(raw)); frames.push(m); if (m.type === 'register') ws.send(JSON.stringify({ type: 'register_ok' })); });
  });
  let hub, c;
  const stop = async () => { if (hub) { result.teardown = await gracefulQuit(hub); hub = null; } if (c) { await c.close(); c = null; } };
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'welink-bot', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: path.join(repo, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      CLAUDE_HUB_WELINK_CLI: path.join(repo, 'tests/fixtures/welink-cli-standin.js'), WELINK_STANDIN_LOG: path.join(root, 'welink-commands.jsonl'),
      ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
      CLAUDE_HUB_WELINK_BOT_BASE: `http://127.0.0.1:${api.address().port}`, CLAUDE_HUB_WELINK_BOT_WS: `ws://127.0.0.1:${wss.address().port}/gw`,
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline test' }, foreign: { ok: false, error: 'offline test' } }),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(150); } throw Error('Timeout: ' + expr); };
    const click = async selector => {
      await until(`!!document.querySelector(${JSON.stringify(selector)})`);
      const point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    };
    const shot = async name => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(r.data, 'base64')); };
    const check = (name, ok, detail = '') => { result.checks.push({ name, ok: !!ok, detail }); assert.ok(ok, name + ' ' + detail); };
    const botText = () => c.eval(`document.querySelector('[data-slot="phone-bot"]')?.innerText||''`);

    await click('#btn-company-assistant');
    await click('[data-ca="settings"]');
    await click('.ca-tabs [data-ca="settings-tab:phone"]');
    await until(`!!document.querySelector('[data-x="bot-register"]')`);
    // 严格可选（2026-11-27）：全新用户看到的还是原来的专用群设置；私聊助理只是页底一个收起的入口，没有网络请求。
    check('全新用户：私聊助理入口默认收起', await c.eval(`!document.querySelector('.ca-bot-box').open`));
    check('全新用户：专用群设置照常显示', await c.eval(`!!document.querySelector('[data-f="phone-group"]')?.offsetParent`));
    check('全新用户：没点绑定前没碰 WeLink 接口和网关', apiHits === 0 && !frames.length, `api=${apiHits} frames=${frames.length}`);
    await shot('20261127-welink-bot-1-first.png');
    await c.eval(`document.querySelector('.ca-bot-box').open=true`);
    check('展开后看到「绑定到 WeLink」', (await botText()).includes('绑定到 WeLink'));

    await click('[data-x="bot-register"]');
    await until(`!!document.querySelector('.ca-bot-qr')?.src?.startsWith('data:image')`);
    check('出二维码和「在电脑 WeLink 里打开」', (await botText()).includes('在电脑 WeLink 里打开'));
    await shot('20261127-welink-bot-2-qr.png');

    confirm = true;
    await until(`(document.querySelector('[data-slot="phone-live"]')?.innerText||'').includes('已接通')`, 30000);
    check('确认后自动接通、网关鉴权走子协议', authOk && frames.some(f => f.type === 'register'));
    const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'company-assistant', 'settings.json'), 'utf8')).phone;
    check('扫码确认后设置改为私聊助理并开启', settings.enabled === true && settings.transport === 'bot', JSON.stringify(settings));
    const bin = fs.readFileSync(path.join(dataDir, 'company-assistant', 'welink-bot.bin'));
    check('凭据加密保存', !bin.toString('utf8').includes('SK-test'));
    await shot('20261127-welink-bot-3-ready.png');

    sock.send(JSON.stringify({ type: 'invoke', action: 'create_session', welinkSessionId: 'W1', payload: {} }));
    sock.send(JSON.stringify({ type: 'invoke', action: 'chat', payload: { text: '现在有哪些会话在跑？', toolSessionId: 'TS1', sendUserAccount: 'u001' } }));
    await until(`(document.querySelector('[data-slot="phone-live"]')?.innerText||'').includes('现在有哪些会话在跑')`);
    check('回了 session_created', frames.some(f => f.type === 'session_created'));
    check('私聊进了助理（最近往来里能看到）', true);
    const scroll = await c.eval(`(()=>{const e=document.querySelector('.ca-tab-body')||document.scrollingElement;let n=e;while(n&&n!==document.body){if(n.scrollHeight>n.clientHeight+4&&getComputedStyle(n).overflowY!=='visible')return{h:n.scrollHeight,c:n.clientHeight,cls:n.className};n=n.parentElement}return null})()`);
    result.scroll = scroll;
    await shot('20261127-welink-bot-4-chat.png');
    result.passed = true;
  } catch (e) { result.error = e.stack || String(e); try { result.page = await c.eval(`document.querySelector('[data-slot="phone-bot"]')?.innerText`); result.toast = await c.eval(`[...document.querySelectorAll('.toast,.hub-toast,[role=status]')].map(x=>x.innerText).join(' | ')`); const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '20261127-welink-bot-fail.png'), Buffer.from(r.data, 'base64')); } catch { /* */ } }
  finally {
    await stop(); api.close(); wss.close();
    fs.writeFileSync(path.join(out, '20261127-welink-bot-result.json'), JSON.stringify(result, null, 1));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.map(x => (x.ok ? 'ok ' : 'FAIL ') + x.name), error: result.error?.split('\n')[0], scroll: result.scroll, out }));
    process.exit(result.passed ? 0 : 1);
  }
})();
