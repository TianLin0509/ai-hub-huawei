'use strict';
// API 网关入口在启动中心（2026-11-19 同事反馈「找不到配置入口」）：全新用户、没有 CodeAgent，
// 之前在 Continue 插件里配过部门网关 key。不去首页，直接点「新建会话」：
//   Claude Code 的模型卡第一张是「用部门 API key」（推荐）→ 点开就地看到「检测到你在 Continue 插件里用过 API 网关 key」
//   →「用这个 key」→ 网关模型卡出现并选中默认模型 → 创建 → 发消息 → 回答经网关回来。key 不进配置文件和界面。
// 隔离 Hub（隐藏窗口、独立数据目录与 home）；模拟网关在本进程里；真实 Claude Code CLI。
//   node tests/e2e-api-gateway-launch-cdp.js   （产物：HUB_E2E_ARTIFACT_DIR 或 artifacts/api-gateway-launch）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/api-gateway-launch');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const KEY = 'e2e-fake-gateway-key-launch-' + 'x'.repeat(8);
const DETECT_KEY = 'sk-' + 'e2edetect'.repeat(4); // 别的工具里的样子（sk- 开头才会被识别）
const MODELS = ['qwen-aw-35b', 'deepseek-v4.1-flash', 'qwen3.8-27b', 'glm-5.3-flash'];
const MARKER = 'GW_LAUNCH_7Q2';
const report = { ok: false, checks: [], screenshots: [], gateway: { chats: 0, models: [] } };

function freePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function whichDir(name) {
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    for (const ext of ['.exe', '.cmd', '']) { if (dir && fs.existsSync(path.join(dir, name + ext))) return dir; }
  }
  return null;
}
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n') : '';

async function startGateway() {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.headers.authorization !== 'Bearer ' + DETECT_KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Invalid token","type":"new_api_error"}}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: MODELS.map(id => ({ id })) })); }
    if (req.url.startsWith('/api/usage/token')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":{"total_used":1,"unlimited_quota":true}}'); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    report.gateway.chats++; report.gateway.models.push(body.model);
    const lastUser = [...(body.messages || [])].reverse().find(m => m.role === 'user');
    const asked = new RegExp(MARKER).test(textOf(lastUser?.content));
    const reply = asked ? `LAUNCH_GATEWAY_OK: ${MARKER}` : 'ok';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    for (const piece of reply.match(/.{1,6}/g)) { send({ id: 'c', model: 'dsv41', choices: [{ index: 0, delta: { content: piece } }] }); await sleep(20); }
    send({ id: 'c', model: 'dsv41', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-api-gateway-launch-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data'), claudeDir = path.join(root, 'claude');
  for (const dir of [home, data, claudeDir, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local'), path.join(home, '.continue'), path.join(data, 'api-gateway')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', bypassPermissionsModeAccepted: true, numStartups: 5 }));
  const gw = await startGateway();
  // 网关地址指向模拟网关（真实用户是预填的公司网关）；key 不在 Hub 里，只在 Continue 插件的配置里。
  fs.writeFileSync(path.join(data, 'api-gateway', 'gateway.json'), JSON.stringify({ baseURL: gw.origin + '/v1' }));
  fs.writeFileSync(path.join(home, '.continue', 'config.json'), JSON.stringify({ models: [{ title: '部门网关', provider: 'openai', apiBase: gw.origin + '/v1', apiKey: DETECT_KEY, model: 'deepseek-v4.1-flash' }] }));
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const cliDirs = ['claude', 'node'].map(whichDir);
  assert.ok(cliDirs.every(Boolean), 'claude and node must be installed');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: claudeDir,
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0',
    [pathKey]: [...new Set(cliDirs), system, path.join(system, 'WindowsPowerShell/v1.0')].join(';'),
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
    HUB_CODEX_API_KEY: '', HUB_CLAUDE_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' };
  let hub, cdp;
  const check = (name, value) => { report.checks.push({ name, ok: !!value }); assert.ok(value, name); };
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await cdp.eval(expression).catch(() => false)) return; await sleep(150); }
    throw new Error('Timeout: ' + label);
  }
  async function click(selector) {
    const point = await cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden control '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) {
    await sleep(300);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, `${stamp}-apigw-launch-${name}-claude18.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64')); report.screenshots.push(file);
  }
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'api-gateway-launch', windowMode: 'hidden', extraEnv: env });
    for (const end = Date.now() + 90000; !cdp;) {
      try { cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url)); }
      catch (error) { if (Date.now() > end) throw error; await sleep(1000); }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!document.getElementById("btn-new")', 'main page', 40000);
    // 首页的「用 API key 开始」也因检测到 key 变成醒目推荐卡。
    await until('document.querySelector("#api-gateway-start .api-gw-hit")?.innerText.includes("Continue")', 'welcome detected hit', 40000);
    check('首页：检测到在 Continue 里用过的 key，推荐卡显示「用这个 key」', await cdp.eval('!!document.querySelector("#api-gateway-start .api-gw-card.rec") && !document.body.innerText.includes(' + JSON.stringify(DETECT_KEY) + ')'));
    await shot('01-welcome-detected');

    // 不在首页配，直接去启动中心。
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center', 20000);
    await until(`document.querySelector('.new-session-option[data-kind="claude"]')?.dataset.installed === '1'`, 'claude detected', 30000);
    // 没装 CodeAgent：启动中心默认就选 Claude Code，不用自己切工具。
    await until('!!document.querySelector("#new-session-model-cards [data-model-card=gw-setup]")', 'setup card without switching kind', 20000);
    check('启动中心：没有 CodeAgent 时第一张模型卡是「用部门 API key」并标推荐', await cdp.eval('(() => { const c = document.querySelector("#new-session-model-cards .session-model-card"); return c?.dataset.modelCard === "gw-setup" && c.dataset.state === "suggest"; })()'));
    await shot('02-launch-setup-card');
    // 没装 CodeAgent：就地配置自动展开，不用先找到那张卡。
    await until('document.querySelector("#new-session-gw-setup .gw-inline-hit")?.innerText.includes("Continue")', 'inline detected hit', 20000);
    check('就地配置自动展开，显示检测到的 key（打码）', await cdp.eval(`document.querySelector("#new-session-gw-setup").innerText.includes("sk-…") && !document.querySelector("#new-session-gw-setup").innerText.includes(${JSON.stringify(DETECT_KEY)})`));
    await shot('03-launch-inline');
    await click('#new-session-gw-setup [data-gwi=adopt]');
    await until('document.querySelectorAll("#new-session-model-cards .session-model-card[data-source=gateway]").length === 4', 'gateway cards after adopt', 30000);
    const picked = 'document.querySelector("#new-session-model-cards .session-model-card[aria-checked=true]")?.dataset.modelCard === "gw:deepseek-v4.1-flash"';
    await until(picked, 'default gateway model picked', 10000).catch(() => {});
    check('用这个 key 后出现 4 张网关模型卡并选中默认模型', await cdp.eval(picked));
    check('配置文件与网关文件里没有明文 key', !fs.readFileSync(path.join(data, 'config.json'), 'utf8').includes(DETECT_KEY) && !fs.readFileSync(path.join(data, 'api-gateway', 'gateway.json'), 'utf8').includes(DETECT_KEY));
    await shot('04-launch-gateway-cards');
    await click('#new-session-submit');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', 'session created', 60000);
    await until(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'composer visible', 60000);
    await sleep(5000);
    await click('#terminal-panel .floating-input-box');
    await cdp.send('Input.insertText', { text: `请原样回复这个标记：${MARKER}` });
    await click('#terminal-panel .floating-input-send');
    await until(`document.body.innerText.includes(${JSON.stringify('LAUNCH_GATEWAY_OK: ' + MARKER)})`, 'answer', 120000).catch(() => {});
    await shot('05-answer');
    check('回答经网关回来', await cdp.eval(`document.body.innerText.includes(${JSON.stringify('LAUNCH_GATEWAY_OK: ' + MARKER)})`));
    report.uiChecksPassed = true;
  } catch (error) {
    report.error = error.stack;
    if (cdp) await shot('failure').catch(() => {});
    throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      try { report.exit = await gracefulQuit(hub); } catch (error) { report.teardownError = error.stack; process.exitCode = 1; }
      finally { hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); }
    }
    gw.server.close();
    report.ok = !!report.uiChecksPassed && report.exit?.exitCode === 0 && !report.teardownError;
    fs.writeFileSync(path.join(out, `${stamp}-apigw-launch-e2e-result-claude18.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, failed: report.checks.filter(c => !c.ok).map(c => c.name), error: (report.error || report.teardownError || '').slice(0, 500) }));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
