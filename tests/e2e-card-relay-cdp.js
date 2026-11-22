'use strict';
// Claude Code、DSH 卡片试点的真实路径：隔离 Hub+ 真实 CLI + 本机反代 + 模拟 API 网关。
// 启动中心选「ACP 试点」→ 卡片发消息 → 点后台接真实终端并在终端里打字 → 回卡片自动换回 → 再发消息，后一轮要看到前面所有内容。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/card-relay');
const KEY = 'sk-' + 'e2ecardrelay'.repeat(3);
const MODELS = ['deepseek-v4.1-flash', 'glm-5.3-flash'];
const report = { ok: false, checks: [], timings: {}, requests: 0 };
const requests = [];

const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
function whichDir(name) {
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    for (const ext of ['.exe', '.cmd', '']) if (dir && fs.existsSync(path.join(dir, name + ext))) return dir;
  }
  return null;
}
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n') : '';

const WARMUP_PROBE = `(()=>{if(window.__warmup)return;const r=window.__warmup={count:0,visibleMs:[]};new MutationObserver(list=>{for(const m of list){for(const n of m.addedNodes)if(n.classList?.contains('terminal-warmup')){r.count++;r.at=performance.now();}for(const n of m.removedNodes)if(n.classList?.contains('terminal-warmup'))r.visibleMs.push(Math.round(performance.now()-r.at));}}).observe(document.body,{childList:true});})()`;

async function startGateway() {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.headers.authorization !== 'Bearer ' + KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Invalid token"}}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: MODELS.map(id => ({ id })) })); }
    if (req.url.startsWith('/api/usage/token')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":{"total_used":1,"unlimited_quota":true}}'); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const users = (body.messages || []).filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n');
    const tags = [...new Set(users.match(/TAG\d[A-Z]/g) || [])];
    const tag = tags.at(-1) || null;
    if (tag) { requests.push({ tag, seen: tags }); report.requests += 1; }
    const reply = tag ? `ANS-${tag}` : 'ok';
    const chatId = 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: chatId, object: 'chat.completion', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    send({ id: chatId, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: reply } }] });
    send({ id: chatId, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
const seenFor = tag => requests.filter(r => r.tag === tag).map(r => r.seen).sort((a, b) => b.length - a.length)[0] || [];

async function main() {
  fs.mkdirSync(out, { recursive: true });
  assert.equal(require('../core/distribution').target, 'company', '这个用例只在公司版仓库运行');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-card-relay-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data'), claudeDir = path.join(root, 'claude');
  for (const dir of [home, data, claudeDir, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local'), path.join(home, '.continue'), path.join(data, 'api-gateway')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', bypassPermissionsModeAccepted: true, numStartups: 5 }));
  const gw = await startGateway();
  fs.writeFileSync(path.join(data, 'api-gateway', 'gateway.json'), JSON.stringify({ baseURL: gw.origin + '/v1' }));
  fs.writeFileSync(path.join(home, '.continue', 'config.json'), JSON.stringify({ models: [{ title: '部门网关', provider: 'openai', apiBase: gw.origin + '/v1', apiKey: KEY, model: MODELS[0] }] }));
  const dshEntry = process.env.DSH_E2E_ENTRY;
  assert.ok(dshEntry && fs.existsSync(dshEntry), '需要 DSH_E2E_ENTRY');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ acp: { nodePath: process.execPath, providers: { 'deepseek-acp': { entryPath: dshEntry, model: MODELS[0] } } } }));
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const cliDirs = ['claude', 'node'].map(whichDir);
  assert.ok(cliDirs.every(Boolean), 'claude and node must be installed');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: claudeDir,
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0', AI_HUB_CARD_TERMINAL_KEEP_MS: '1500',
    [pathKey]: [path.resolve(path.dirname(dshEntry), '..', '..', '..', '.bin'), ...new Set(cliDirs), system, path.join(system, 'WindowsPowerShell/v1.0')].join(';'),
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
    HUB_CODEX_API_KEY: '', HUB_CLAUDE_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };
  let hub, cdp;
  const check = (name, value, detail) => { report.checks.push({ name, ok: !!value, ...(value ? {} : { detail }) }); if (!value) throw new Error('检查失败：' + name + ' ' + JSON.stringify(detail ?? '')); };
  const ev = expression => cdp.eval(expression);
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await ev(expression).catch(() => false)) return; await sleep(150); }
    throw new Error('Timeout: ' + label);
  }
  async function click(selector) {
    const point = await ev(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) {
    await sleep(300);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, `20261122-card-relay-${name}-claude.png`), Buffer.from(image.data, 'base64'));
  }
  const state = id => ev(`(()=>{const s=sessions.get(${JSON.stringify(id)});return s?{card:s.cardRunMode,term:s.cardTerminal,backend:s.runtimeBackend||null,agent:s.agentRuntime||null,status:s.status,conn:s.nativeRuntime?.connection||s.cliRuntime?.connection||null,state:s.nativeRuntime?.state||s.cliRuntime?.state||null}:null})()`);
  const sendCard = async text => {
    await until(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'composer', 60000);
    await click('#terminal-panel .floating-input-box');
    await cdp.send('Input.insertText', { text });
    await sleep(200);
    await click('#terminal-panel .floating-input-send');
  };
  const idle = id => until(`(()=>{const s=sessions.get(${JSON.stringify(id)});const r=s?.nativeRuntime||s?.cliRuntime;return s&&s.status!=='dormant'&&(!r||(r.connection==='connected'&&['idle','completed'].includes(r.state)))})()`, 'idle ' + id, 60000);
  async function openLauncher(kind) {
    await ev(`window.WorkspaceController?.openNewSessionModal?.({kind:${JSON.stringify(kind)}})`);
    await until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', 'launcher', 15000);
    const sel = `.new-session-option[data-kind="${kind}"]`;
    for (let i = 0; i < 5; i++) {
      await click(sel).catch(() => {});
      if (await ev(`document.querySelector(${JSON.stringify(sel)})?.getAttribute('aria-pressed')==='true'`)) break;
      await sleep(400);
    }
    await sleep(600);
  }
  async function adoptGateway() {
    await until('document.querySelector("#new-session-gw-setup .gw-inline-hit")?.innerText.includes("Continue")', 'gateway key detected', 25000);
    await click('#new-session-gw-setup [data-gwi=adopt]');
    await until('document.querySelectorAll("#new-session-model-cards .session-model-card[data-source=gateway]").length >= 2', 'gateway cards', 30000);
    await sleep(600);
  }
  let adopted = false;
  async function create(kind, mode) {
    if (!adopted) { await openLauncher('claude'); await adoptGateway(); adopted = true; }
    await openLauncher(kind);
    await until('document.querySelectorAll("#new-session-model-cards .session-model-card[data-source=gateway]").length >= 2', 'gateway cards ' + kind, 20000);
    await until('!document.getElementById("new-session-run-mode-field").hidden', '运行方式可见 ' + kind, 15000);
    await ev(`(()=>{const s=document.getElementById('new-session-run-mode');s.value=${JSON.stringify(mode)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await until(`document.getElementById('new-session-run-mode').value===${JSON.stringify(mode)}`, 'run mode set');
    await sleep(500);
    const before = JSON.stringify(await ev('[...sessions.keys()]'));
    await click('#new-session-submit');
    await until(`[...sessions.values()].some(x=>!${before}.includes(x.id)) || !!document.getElementById('new-session-error')?.innerText.trim()`, 'session created', 60000);
    const error = await ev('document.getElementById("new-session-error")?.innerText.trim() || ""');
    assert.equal(error, '', error);
    return ev(`[...sessions.values()].find(x=>!${before}.includes(x.id)).id`);
  }
  const body = text => `document.getElementById('msg-overlay')?.innerText.includes(${JSON.stringify(text)})`;
  async function relay(kind, letter, backend) {
    const label = kind === 'claude' ? 'Claude' : 'DSH';
    const id = await create(kind, 'serve');
    await until(`sessions.get(${JSON.stringify(id)})?.runtimeBackend===${JSON.stringify(backend)}`, label + ' 卡片驱动', 60000);
    check(`${label}：新建后走结构化通道`, (await state(id)).card === 'card', await state(id));
    await idle(id);
    await sendCard(`请回复 TAG1${letter}`);
    await until(body(`ANS-TAG1${letter}`), label + ' 第一轮卡片回答', 90000);
    check(`${label}：卡片第一轮有回答`, true);
    await idle(id);
    await shot(`${kind}-1-card`);

    await ev(WARMUP_PROBE);
    const warmupBefore = await ev('window.__warmup.count');
    let at = Date.now();
    await click('#btn-backstage');
    await until(`window.__warmup.count>${warmupBefore}`, label + ' 冷启动过渡动画', 15000);
    await sleep(450);
    await shot(`${kind}-1b-warmup`);
    check(`${label}：第一次打开后台显示过渡动画`, true);
    await until(`(()=>{const s=sessions.get(${JSON.stringify(id)});return s?.cardTerminal===true&&s.status!=='dormant'&&s.agentRuntime==='pty'})()`, label + ' 接力到终端', 90000);
    await until(`(()=>{const t=terminalCache.get(${JSON.stringify(id)})?.terminal;if(!t)return false;const b=t.buffer.active;let x='';for(let i=0;i<b.length;i++)x+=b.getLine(i)?.translateToString(true)||'';return x.includes('ANS-TAG1${letter}')})()`, label + ' 终端显示历史', 90000);
    report.timings[label + '：点后台到终端显示历史'] = Date.now() - at;
    check(`${label}：点后台后是真实终端并显示历史`, true);
    await until('!document.querySelector(".terminal-warmup")', label + ' 过渡动画淡出', 5000);
    check(`${label}：终端画出内容后动画消失`, true, await ev('window.__warmup.visibleMs'));
    check(`${label}：切到终端后仍停在后台视图`, await ev('currentView==="pty"'), await ev('currentView'));
    await idle(id);
    await sleep(2500);
    await shot(`${kind}-2-terminal`);
    await ev(`terminalCache.get(${JSON.stringify(id)}).terminal.focus()`);
    await sleep(300);
    await cdp.send('Input.insertText', { text: `请回复 TAG2${letter}` });
    await sleep(700);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const end = Date.now() + 60000;
    while (Date.now() < end && !requests.some(r => r.tag === `TAG2${letter}`)) await sleep(200);
    check(`${label}：真实终端里打字发出去了，且带着卡片那一轮`, seenFor(`TAG2${letter}`).includes(`TAG1${letter}`), seenFor(`TAG2${letter}`));
    await sleep(2500);
    await idle(id);

    const warmupWarm = await ev('window.__warmup.count');
    await click('#btn-backstage');
    await until('currentView==="card"', '保温期回卡片');
    await click('#btn-backstage');
    await until('currentView==="pty"', '保温期再开后台');
    await sleep(700);
    check(`${label}：保温期内再开后台不显示动画`, (await ev('window.__warmup.count')) === warmupWarm, await ev('window.__warmup.count'));

    at = Date.now();
    await click('#btn-backstage');
    await until('currentView==="card"', '回卡片视图');
    await until(`(()=>{const s=sessions.get(${JSON.stringify(id)});return s?.cardTerminal===false&&s.status!=='dormant'&&s.runtimeBackend===${JSON.stringify(backend)}})()`, label + ' 自动换回结构化通道', 60000);
    report.timings[label + '：回卡片到换回结构化通道（含 1.5 秒测试保温）'] = Date.now() - at;
    await idle(id);
    check(`${label}：离开后台后自动换回结构化通道`, true);
    await until(`activeSessionId===${JSON.stringify(id)}`, '仍选中会话', 5000);
    await until(body(`ANS-TAG2${letter}`), label + ' 卡片显示终端那一轮', 30000);
    check(`${label}：卡片里能看到终端里聊的那一轮`, true);
    await sendCard(`请回复 TAG3${letter}`);
    await until(body(`ANS-TAG3${letter}`), label + ' 第三轮卡片回答', 90000);
    const seen = seenFor(`TAG3${letter}`);
    check(`${label}：回到卡片后上下文完整`, seen.includes(`TAG1${letter}`) && seen.includes(`TAG2${letter}`), seen);
    await idle(id);
    await shot(`${kind}-3-back`);
    return id;
  }
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'card-relay', windowMode: process.env.CARD_E2E_WINDOW || 'hidden', extraEnv: env });
    for (const end = Date.now() + 90000; !cdp;) {
      try { cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url)); }
      catch (error) { if (Date.now() > end) throw error; await sleep(1000); }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!document.getElementById("btn-new")', 'main page', 40000);
    await sleep(2500);
    const only = (process.env.CARD_E2E_ONLY || 'claude,dsh,share,pty').split(',');
    if (only.includes('claude')) await relay('claude', 'A', 'claude-stream-json');
    if (only.includes('dsh')) await relay('deepseek-acp', 'B', 'acp');
    if (only.includes('share')) {
      const ids = [];
      for (const letter of ['C', 'D']) {
        const id = await create('deepseek-acp', 'serve');
        ids.push(id);
        await until(`sessions.get(${JSON.stringify(id)})?.runtimeBackend==='acp'`, '共享会话驱动', 60000);
        await idle(id);
        await sendCard(`请回复 TAG1${letter}`);
        await until(body(`ANS-TAG1${letter}`), '共享会话回答 ' + letter, 90000);
        await idle(id);
      }
      const seen = [...seenFor('TAG1C'), ...seenFor('TAG1D')];
      check('多个 DSH 卡片会话内容互不串', seenFor('TAG1C').join() === 'TAG1C' && seenFor('TAG1D').join() === 'TAG1D', seen);
      const script = `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match '--profile acp' -and $_.CommandLine -like '*${path.basename(root)}*' }).Count`;
      const counted = require('node:child_process').spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      report.sharedAcpProcesses = Number(String(counted.stdout).trim());
      check('多个 DSH 卡片会话共用一个 ACP 进程', report.sharedAcpProcesses === 1, report.sharedAcpProcesses);
    }
    if (only.includes('pty')) {
      const ptyId = await create('claude', 'pty');
      await until(`sessions.get(${JSON.stringify(ptyId)})?.agentRuntime==='pty'`, '默认 PTY', 30000);
      const s = await state(ptyId);
      check('默认 PTY：不走卡片驱动', s.card !== 'card' && s.term !== true && s.backend === null, s);
    }
    report.uiChecksPassed = true;
  } catch (error) {
    report.error = error.stack;
    if (cdp) await shot('failure').catch(() => {});
    if (cdp) report.failureState = await ev(`JSON.stringify({view:currentView,active:activeSessionId,sessions:[...sessions.values()].map(s=>({k:s.kind,card:s.cardRunMode,term:s.cardTerminal,b:s.runtimeBackend,a:s.agentRuntime,st:s.status,err:s.nativeActionError,conn:s.nativeRuntime?.connection,rs:s.nativeRuntime?.state,why:s.nativeRuntime?.reason})),toast:[...document.querySelectorAll('.toast')].map(x=>x.innerText).slice(-3)})`).catch(() => null);
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      try { report.exit = await gracefulQuit(hub); } catch (error) { report.teardownError = error.stack; process.exitCode = 1; }
      finally { hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); }
    }
    gw.server.close();
    report.ok = !!report.uiChecksPassed && report.exit?.exitCode === 0 && !report.teardownError;
    fs.writeFileSync(path.join(out, '20261122-card-relay-e2e-result-claude.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(c => c.ok).length, failed: report.checks.filter(c => !c.ok).map(c => c.name), timings: report.timings, error: String(report.error || report.teardownError || '').slice(0, 500), state: report.failureState?.slice?.(0, 900) }, null, 1));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
