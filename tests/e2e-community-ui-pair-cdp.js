'use strict';
// 社区页两实例真界面联调（2026-11-24）：真实隔离 Hub ×2，一台当收件机、一台当同事电脑，走真 IPC 与真 HTTP 心跳（不用 mock）。
// 另从 12 个回环地址（每台一个，避开每来源每小时 6 次的限频）投 12 台「别的同事」的心跳凑出榜单。窗口全程隐藏，1440×900 截图：
//   收件机视角（30 天趋势、版本、收件机状态）、同事视角（领奖台、我的位置）、同事改昵称后下一次心跳在收件机榜单上出现。
// 用法：node tests/e2e-community-ui-pair-cdp.js --out <新目录>
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argOut = process.argv.indexOf('--out');
const out = path.resolve(argOut > 0 ? process.argv[argOut + 1] : 'D:/Temp/community-ui-pair');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const invoke = (channel, req = {}) => `require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(req)})`;
const RECEIVER_IP = '127.0.0.2';
const PETS = ['shiba', 'cat', 'penguin', 'rabbit', 'hamster', 'cockatiel'];
const NICKS = ['算法小柴', '调度狂魔', '波束成形', 'OLLA收敛中', '今天不加班', 'MU配对王', 'Token燃烧者', '夜猫子退散', 'HARQ重传', '一键成群', '仓鼠·8E11', '玄凤·B812'];

function seed(port, n) {
  const body = JSON.stringify({ v: 1, iid: (0xabc000 + n).toString(16).padStart(32, '0'), ed: 'member', ver: n % 3 ? '5.6.100' : '5.6.99', nick: NICKS[n - 1], pet: PETS[n % PETS.length],
    lv: 4 + n * 3, ach: 2 + n, wxp: 120 * n + 40, wtok: 350000 * n, streak: n % 9, act: n % 2, days7: 1 + (n % 5) });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: RECEIVER_IP, port, path: '/community/v1/pulse', method: 'POST', localAddress: '127.0.0.' + (10 + n), headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(body);
  });
}

// 同事 Hub 不直连收件机，而是连这个计数代理：同事发出的每一个社区请求（心跳、取榜）都在这里记一笔，再原样转给收件机。
function countingProxy(targetPort) {
  const counts = { total: 0, pulse: 0, board: 0 };
  const server = http.createServer((req, res) => {
    counts.total++;
    if (req.url.startsWith('/community/v1/pulse')) counts.pulse++; else if (req.url.startsWith('/community/v1/board')) counts.board++;
    const up = http.request({ host: RECEIVER_IP, port: targetPort, path: req.url, method: req.method, headers: req.headers, localAddress: '127.0.0.4' }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.5', () => resolve({ server, port: server.address().port, counts })));
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'community-ui-pair-'));
  const port = await freePort();
  const domain = new URL(require('../core/app-update/openx-config').fileSite).hostname.split('.').slice(-2).join('.');
  const hostDir = path.join(root, 'host-data'), peerDir = path.join(root, 'peer-data');
  fs.mkdirSync(hostDir); fs.mkdirSync(peerDir);
  // 收件机：发布地址是本机计算机名 → 认出自己；同事：发布地址是收件机的 IP。
  fs.writeFileSync(path.join(hostDir, 'hub-feedback-receiver.json'), JSON.stringify({ urls: [`http://${os.hostname().split('.')[0]}.${domain}:${port}`], at: Date.now() }));
  const proxy = await countingProxy(port);
  fs.writeFileSync(path.join(peerDir, 'hub-feedback-receiver.json'), JSON.stringify({ urls: [`http://127.0.0.5:${proxy.port}`], at: Date.now() }));
  const report = { checks: [], failures: [], rendererErrors: [], root }, hubs = [];
  const expect = (ok, msg) => { if (!ok) report.failures.push(msg); };
  async function start(dir, label) {
    const home = path.join(root, label + '-home'); fs.mkdirSync(home, { recursive: true });
    const system = path.join(process.env.SystemRoot, 'System32');
    const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
    const extraEnv = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
      CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_FEEDBACK_RECEIVER_HOST: RECEIVER_IP, AI_HUB_COMMUNITY_PULSE_MS: '4000',
      CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0',
      [pathKey]: [system, path.join(system, 'WindowsPowerShell/v1.0')].join(';') };
    for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) extraEnv[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
    const hub = await launchIsolatedHub({ dataDir: dir, port: await freePort(), windowMode: 'hidden', label, extraEnv });
    const cdp = await connectFirstPage(hub); hubs.push({ hub, cdp });
    cdp.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') report.rendererErrors.push(label + ': ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); } catch { /* 不是异常 */ } });
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    return cdp;
  }
  async function until(cdp, expression, label, timeout = 60000) {
    const end = Date.now() + timeout; let last;
    while (Date.now() < end) { try { last = await cdp.eval(expression); if (last) return last; } catch { /* 页面还没好 */ } await sleep(500); }
    throw Error('Timed out: ' + label);
  }
  const shot = async (cdp, file) => { await sleep(800); fs.writeFileSync(path.join(out, file + '.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); report.checks.push('截图 ' + file); };
  const openTab = async (cdp, sel) => {
    await until(cdp, `!!document.getElementById('btn-community')`, 'entry');
    await cdp.eval(`(()=>{const p=document.getElementById('community-page');if(p&&!p.hidden)document.getElementById('btn-community').click();document.getElementById('btn-community').click();return true})()`);
    await until(cdp, `document.querySelector('#community-page ${sel}')`, 'page ' + sel);
  };
  try {
    const host = await start(hostDir, 'community-ui-host');
    await until(host, `${invoke('feedback-receiver:status')}.then(s => s.listening)`, 'receiver listening');
    for (let n = 1; n <= 12; n++) expect(await seed(port, n) === 200, 'seed ' + n);
    const peer = await start(peerDir, 'community-ui-peer');
    const hb = await until(host, `${invoke('community:get-board')}.then(b => b.online >= 14 && b)`, 'peer pulse arrives');
    report.host = { online: hb.online, today: hb.today, total: hb.total, versions: hb.versions, host: hb.host };
    report.checks.push(`收件机收到同事心跳：在线 ${hb.online}`);

    // 同事视角：真 IPC 取榜（10 分钟缓存之外强制取一次，模拟用户打开 tab）
    await peer.eval(invoke('community:get-board', { force: true }));
    await openTab(peer, '.cmy-podium');
    const pv = await peer.eval(`(()=>({isHost:!document.querySelector('#community-page .cmy-host')?false:true,podium:document.querySelectorAll('#community-page .pd').length,rows:document.querySelectorAll('#community-page .cmy-row').length,me:document.querySelector('#community-page .cmy-mctop .nm')?.textContent,ranks:[...document.querySelectorAll('#community-page .cmy-ranks b')].map(b=>b.textContent),footer:(document.getElementById('community-foot')||{}).textContent,dot:!document.querySelector('#btn-community .cmy-live')?.hidden,stats:[...document.querySelectorAll('#community-page .cmy-v')].map(e=>e.textContent)}))()`);
    report.peerView = pv;
    expect(pv.isHost === false, '同事视角出现了收件机专属卡片');
    expect(pv.podium === 3 && pv.rows >= 10, '同事视角领奖台或列表不对');
    expect(!!pv.me && pv.ranks.every(r => /第 \d+ 名|未上榜/.test(r)), '同事视角我的位置不对');
    expect(/在线/.test(pv.footer || '') && pv.dot, '同事底栏或绿点没亮');
    await shot(peer, '20261124-社区联调-同事视角');

    // 同事改昵称：写进本机，下一次心跳带上（收件机对同一台 30 分钟内的重复心跳只回 200 不计入，所以这里核对待发内容）
    await peer.eval(`(()=>{document.querySelector('#community-page [data-cmy="rename"]').click();return true})()`);
    await until(peer, `document.querySelector('#community-page .cmy-nick-input')`, 'rename input');
    await peer.eval(`(()=>{const i=document.querySelector('#community-page .cmy-nick-input');i.value='联调柴犬';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`);
    const st = await until(peer, `${invoke('community:get-settings')}.then(s => s.nick === '联调柴犬' && s)`, 'nickname saved for next pulse', 20000);
    report.peerRename = { nick: st.nick, line: await peer.eval(`document.querySelector('#community-page [data-slot="line"]').textContent`), pill: await peer.eval(`document.querySelector('#community-page [data-slot="nick"]')?.textContent`) };
    expect(report.peerRename.pill === '联调柴犬', '改名后页面上的昵称没更新');
    report.checks.push('同事在社区页改昵称：页面即显示「联调柴犬」，下一次心跳的昵称已是「联调柴犬」');
    await shot(peer, '20261124-社区联调-同事改昵称后');

    // 收件机视角
    await openTab(host, '.cmy-host');
    const hv = await host.eval(`(()=>({trend:!!document.querySelector('#community-page .cmy-trend-svg'),versions:document.querySelectorAll('#community-page .cmy-vbar').length,status:document.querySelector('#community-page .cmy-hoststat')?.textContent.replace(/\\s+/g,' ').trim(),hasPeer:document.getElementById('community-page').textContent.includes(${JSON.stringify(pv.me || '?')}),stats:[...document.querySelectorAll('#community-page .cmy-v')].map(e=>e.textContent)}))()`);
    report.hostView = hv;
    expect(hv.trend && hv.versions >= 1 && /收件机状态/.test(hv.status || ''), '收件机视角缺趋势、版本或状态');
    expect(hv.hasPeer, '收件机视角榜单里没有同事（' + pv.me + '）');
    await shot(host, '20261124-社区联调-收件机视角');
    await host.eval(`document.getElementById('community-page').scrollTop=99999`);
    await shot(host, '20261124-社区联调-收件机视角-下半屏');

    // 同事在 设置 › 高级 › 隐私 打开「纯离线模式」：立即停发、不拉榜，底栏与绿点隐藏，社区页锁定
    // 同事在线时的对照窗口：计数代理里应看到同事的心跳
    const WINDOW = 16000;
    const on0 = { ...proxy.counts }; await sleep(WINDOW); const on1 = { ...proxy.counts };
    await peer.eval(`document.getElementById('options-settings').click()`);
    await until(peer, `document.getElementById('cfg-tab-advanced')`, 'settings tabs');
    await peer.eval(`document.getElementById('cfg-tab-advanced').click()`);
    await until(peer, `(()=>{const f=document.getElementById('cfg-community-offline-field');return f&&!f.hidden&&f.offsetParent})()`, 'offline field visible');
    report.settingsFoldClosed = await peer.eval(`!document.getElementById('cfg-community-offline-field').open`);
    expect(report.settingsFoldClosed, '隐私折叠区默认应收起');
    await peer.eval(`(()=>{const f=document.getElementById('cfg-community-offline-field');f.open=true;f.scrollIntoView();return true})()`);
    await sleep(400);
    report.offlineDefault = await peer.eval(`document.getElementById('cfg-community-offline').checked`);
    expect(report.offlineDefault === false, '纯离线默认应为关（参与社区）');
    await peer.eval(`document.getElementById('cfg-community-offline').click()`);
    await until(peer, `${invoke('community:get-settings')}.then(s => s.enabled === false)`, 'offline saved');
    await shot(peer, '20261124-社区-设置高级隐私-纯离线已开');
    await peer.eval(`(document.getElementById('config-cancel')||document.querySelector('.config-btn-cancel'))?.click()`);
    await sleep(300);
    report.offlineChrome = await peer.eval(`({footer:!document.getElementById('community-foot')||document.getElementById('community-foot').hidden,dot:!!document.querySelector('#btn-community .cmy-live')?.hidden})`);
    expect(report.offlineChrome.footer && report.offlineChrome.dot, '纯离线后底栏在线或左栏绿点仍显示');
    await openTab(peer, '.cmy-locked');
    report.lockedText = await peer.eval(`document.querySelector('#community-page .cmy-locked').textContent.trim()`);
    expect(report.lockedText === '已开启纯离线模式，社区页不可用。可在 设置 › 高级 中关闭', '锁定文案不对：' + report.lockedText);
    await shot(peer, '20261124-社区-纯离线锁定');
    // 纯离线窗口：打开过社区页、等过 4 个心跳周期，同事一个社区请求都不该发出
    const off0 = { ...proxy.counts };
    await openTab(peer, '.cmy-locked');
    await peer.eval(invoke('community:get-board', { force: true }));
    await sleep(WINDOW); const off1 = { ...proxy.counts };
    const dOn = on1.total - on0.total, dOff = off1.total - off0.total;
    report.offlineRequests = { windowMs: WINDOW, peerOnline: { total: dOn, pulse: on1.pulse - on0.pulse }, peerOffline: { total: dOff, pulse: off1.pulse - off0.pulse, board: off1.board - off0.board } };
    expect(dOn >= 2, `对照窗口里同事心跳太少（${dOn} 次），计数代理可能没接上`);
    expect(dOff === 0, `纯离线后同事仍发出 ${dOff} 个社区请求`);
    report.checks.push(`同事开纯离线：16 秒窗口内同事发出的社区请求 ${dOn} 个 → ${dOff} 个（含打开社区页、强制取榜），社区页锁定，底栏与绿点隐藏`);
    // 关掉纯离线恢复（只能从设置里关）
    await peer.eval(invoke('community:set-enabled', { enabled: true }));

    // 收件机点「暂停收集」：同事再取时显示已暂停
    await host.eval(`document.getElementById('community-page').scrollTop=0`);
    await host.eval(`(()=>{document.querySelector('#community-page [data-cmy="host-pause"]').click();return true})()`);
    await until(host, `(document.querySelector('#community-page [data-cmy="host-pause"]')||{}).textContent==='恢复收集'`, 'host paused');
    const ps = await peer.eval(`${invoke('community:get-board', { force: true })}.then(b=>b.state)`);
    expect(ps === 'paused', '收件机暂停后同事状态不是 paused：' + ps);
    report.checks.push('收件机界面点「暂停收集」，同事侧状态变为 ' + ps);
  } catch (e) {
    report.failures.push(String(e && e.stack || e));
  } finally {
    proxy.server.close();
    for (const pair of hubs.splice(0)) { try { await gracefulQuit(pair.hub); } catch { /* 尽量关 */ } try { await pair.cdp.close(); } catch { /* 已关 */ } }
    if (report.rendererErrors.length) report.failures.push('页面脚本报错 ' + report.rendererErrors.length + ' 条');
    report.ok = report.failures.length === 0;
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, out, failures: report.failures, checks: report.checks }, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  }
}

main();
