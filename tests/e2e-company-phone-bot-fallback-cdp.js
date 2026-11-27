'use strict';
// 私聊助理离线回落界面验收（2026-11-27）：真实界面 + 真实主进程，WeLink 接口、网关、welink-cli 都是本机替身。
// 以前配过专用群的用户绑定私聊助理 → 接通 → 网关断掉 → 约 2 分钟后手机页显示「私聊助理离线，已临时改用专用群」、
// 群里收到一行提示、约 60 秒查一次群 → 网关恢复后自动重连、切回私聊助理、群里收到「已恢复」。约 6 分钟。
// 用法：node tests/e2e-company-phone-bot-fallback-cdp.js [输出目录]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'artifacts/phone-bot-fallback-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-phone-fallback-')), dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(dataDir, 'company-assistant'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: true, forum: false }));
  // 前提：这位用户以前用过专用群（回落只发生在配过群的人身上）。
  fs.writeFileSync(path.join(dataDir, 'company-assistant', 'settings.json'), JSON.stringify({ phone: { enabled: false, groupId: 'g-phone', groupName: '手机', pushWatched: true, pushStuck: true, since: 0 } }));
  const standinState = path.join(root, 'welink-state.txt');
  const result = { passed: false, testRoot: root, checks: [], fixture: 'isolated Hub, real renderer/IPC, fake WeLink register API + gateway + welink-cli on 127.0.0.1' };
  let confirm = false; const frames = [];
  const api = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url.endsWith('/im-register/qrcode')) return res.end(JSON.stringify({ code: '200', data: { qrcode: 'Q1', accessToken: 'T1', pcUrl: 'welink://test?q=Q1', weUrl: 'h5://test/index.html?qrcode=Q1#/createAssistant' } }));
    if (req.url.includes('/qrcode-detail/')) return res.end(JSON.stringify({ code: '200', data: confirm ? { status: 2, ak: 'AK-test', sk: 'SK-test', name: '助手' } : { status: 0 } }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  let wss = null, wsPort = 0, connections = 0;
  const openGateway = async () => {
    wss = new WebSocketServer({ port: wsPort, host: '127.0.0.1', handleProtocols: p => [...p][0] });
    await new Promise(r => wss.on('listening', r));
    wsPort = wss.address().port;
    wss.on('connection', ws => {
      connections += 1;
      ws.on('message', raw => { const m = JSON.parse(String(raw)); frames.push(m); if (m.type === 'register') ws.send(JSON.stringify({ type: 'register_ok' })); });
    });
  };
  const closeGateway = () => new Promise(r => { for (const ws of wss.clients) ws.terminate(); wss.close(() => r()); });
  await openGateway();
  let hub, c;
  const stop = async () => { if (hub) { result.teardown = await gracefulQuit(hub); hub = null; } if (c) { await c.close(); c = null; } };
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'phone-bot-fallback', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: path.join(repo, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_FORUM_TIMER: '0',
      CLAUDE_HUB_WELINK_CLI: path.join(repo, 'tests/fixtures/welink-cli-standin.js'), WELINK_STANDIN_LOG: path.join(root, 'welink-commands.jsonl'), WELINK_STANDIN_STATE: standinState,
      ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
      CLAUDE_HUB_WELINK_BOT_BASE: `http://127.0.0.1:${api.address().port}`, CLAUDE_HUB_WELINK_BOT_WS: `ws://127.0.0.1:${wsPort}/gw`,
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline test' }, foreign: { ok: false, error: 'offline test' } }),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(300); } throw Error('Timeout: ' + expr); };
    const click = async selector => {
      await until(`!!document.querySelector(${JSON.stringify(selector)})`);
      const point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    };
    // 截图前把设置面板滚回顶部，接通状态那一块要在图里。
    const shot = async (name, sel = '') => { await c.eval(sel ? `document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'center'})` : `(()=>{const p=document.querySelector('.ca-panel');if(p)p.scrollTop=0})()`); await _waitMs(300); const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(r.data, 'base64')); };
    const check = (name, ok, detail = '') => { result.checks.push({ name, ok: !!ok, detail }); assert.ok(ok, name + ' ' + detail); };
    const liveHas = text => `(document.querySelector('[data-slot="phone-live"]')?.innerText||'').includes(${JSON.stringify(text)})`;
    const groupLines = () => { try { return fs.readFileSync(path.join(root, 'welink-phone-group.jsonl'), 'utf8'); } catch { return ''; } };
    const queries = () => { try { return fs.readFileSync(path.join(root, 'welink-commands.jsonl'), 'utf8').split('\n').filter(l => l.includes('query-history-message') && l.includes('g-phone')).length; } catch { return 0; } };

    await click('#btn-company-assistant');
    await click('[data-ca="settings"]');
    await click('.ca-tabs [data-ca="settings-tab:phone"]');
    await until(`!!document.querySelector('[data-x="bot-register"]')`);
    await c.eval(`document.querySelector('.ca-bot-box').open=true`);
    await click('[data-x="bot-register"]');
    await until(`!!document.querySelector('.ca-bot-qr')?.src?.startsWith('data:image')`);
    confirm = true;
    await until(liveHas('已接通'), 30000);
    const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'company-assistant', 'settings.json'), 'utf8')).phone;
    check('私聊助理接通，以前配的群还在', settings.transport === 'bot' && settings.groupId === 'g-phone', JSON.stringify(settings));
    await _waitMs(8000);
    check('私聊助理在线时不查群', queries() === 0, 'query-history=' + queries());
    await shot('20261127-phone-fallback-1-bot.png');

    await closeGateway();
    const downAt = Date.now();
    await until(liveHas('私聊助理离线'), 200000);
    result.fallbackAfterMs = Date.now() - downAt;
    check('断开约 2 分钟后手机页显示改用专用群', result.fallbackAfterMs >= 110000, result.fallbackAfterMs + 'ms');
    await _waitMs(4000);
    check('群里收到「手机助手离线，已切回群轮询」', groupLines().includes('手机助手离线，已切回群轮询'));
    const q0 = queries(); await _waitMs(65000); const q1 = queries();
    result.groupQueriesIn65s = q1 - q0;
    check('回落期间约 60 秒查一次群', q1 - q0 >= 1 && q1 - q0 <= 2, `${q1 - q0} 次/65 秒`);
    result.liveFallback = await c.eval(`document.querySelector('[data-slot="phone-live"]')?.innerText||''`);
    await shot('20261127-phone-fallback-2-group.png');
    await shot('20261127-phone-fallback-2b-style.png', '[data-f="phone-fullAnswer"]');

    await openGateway();
    await until(liveHas('已接通'), 330000);
    check('网关恢复后自动重连、切回私聊助理', connections >= 2, 'connections=' + connections);
    await _waitMs(4000);
    check('群里收到「手机助手已恢复」', groupLines().includes('手机助手已恢复'));
    const logFile = path.join(dataDir, 'logs', 'welink-bot.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    result.logEvents = [...new Set(log.split('\n').map(l => l.split(' ')[1]).filter(Boolean))];
    check('生命周期日志记下了断开与重连，且不含凭据', / close /.test(log) && / retry /.test(log) && !/AK-test|SK-test/.test(log), result.logEvents.join(','));
    await shot('20261127-phone-fallback-3-recovered.png');
    result.passed = true;
  } catch (e) { result.error = e.stack || String(e); try { result.page = await c.eval(`document.querySelector('[data-slot="phone-live"]')?.innerText`); const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '20261127-phone-fallback-fail.png'), Buffer.from(r.data, 'base64')); } catch { /* */ } }
  finally {
    await stop(); api.close(); try { wss.close(); } catch { /* */ }
    fs.writeFileSync(path.join(out, '20261127-phone-fallback-result.json'), JSON.stringify(result, null, 1));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.map(x => (x.ok ? 'ok ' : 'FAIL ') + x.name + (x.detail ? ' (' + x.detail + ')' : '')), error: result.error?.split('\n')[0], fallbackAfterMs: result.fallbackAfterMs, out }));
    process.exit(result.passed ? 0 : 1);
  }
})();
