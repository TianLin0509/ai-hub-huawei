'use strict';
// 自有模型接不上（DSH，2026-11-20 群诉求遗漏清单第 1 项）真实用户路径，隔离 Hub（隐藏窗口、独立数据目录与 CDP 端口）：
//   全新用户 → 首页「用 API key 开始」→ 地址指向模拟 OpenAI 兼容接口 → 粘 key → 保存 → 新建 DSH 会话 → 发消息 → 回答出现。
// 真实 DSH 终端运行环境（~/.dsh/hub-cli-runtime.json 或 AI_HUB_DSH_CLI_ROOT）；反代由 Hub 照常启动。
//   node tests/e2e-own-model-dsh-cdp.js   （产物：HUB_E2E_ARTIFACT_DIR 或 artifacts/own-model-dsh）
// 真实网关模式：E2E_GATEWAY_KEY_FILE=<key 文件>（只在公司黄区跑）。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/own-model-dsh');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const KEY_FILE = process.env.E2E_GATEWAY_KEY_FILE || '';
const REAL = !!KEY_FILE;
const KEY = REAL ? fs.readFileSync(KEY_FILE, 'utf8').replace(/^\s*Authorization:\s*Bearer\s*/i, '').trim() : 'e2e-fake-gateway-key-0001';
const MODELS = ['qwen-aw-35b', 'deepseek-v4.1-flash', 'qwen3.8-27b', 'glm-5.3-flash'];
const MARKER = 'GW_MARKER_D5H';
const FIRST_CHUNK_DELAY_MS = Number(process.env.E2E_GATEWAY_DELAY_MS) || 12000; // 模拟网关排队（11-19 实测 12–31 秒）
const DSH_ROOT = process.env.AI_HUB_DSH_CLI_ROOT || (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'hub-cli-runtime.json'), 'utf8')).root; } catch { return ''; } })();
const report = { ok: false, real: REAL, checks: [], screenshots: [], gateway: { chats: 0, models: [], authFailures: 0 } };

function freePort() {
  return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  }); });
}
function whichDir(name) {
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    for (const ext of ['.exe', '.cmd', '']) { if (dir && fs.existsSync(path.join(dir, name + ext))) return dir; }
  }
  return null;
}
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n') : '';

async function startGateway() {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.headers.authorization !== 'Bearer ' + KEY) { report.gateway.authFailures++; res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Invalid token","type":"new_api_error"}}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: MODELS.map(id => ({ id, object: 'model' })), object: 'list' })); }
    if (req.url.startsWith('/api/usage/token')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: true, data: { total_used: 25103, total_granted: 0, total_available: -25103, unlimited_quota: true, expires_at: 0 } })); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    report.gateway.chats++; report.gateway.models.push(body.model);
    const lastUser = [...(body.messages || [])].reverse().find(m => m.role === 'user');
    // DSH 把用户消息放进带类型的片段里，且最后一条 user 可能是 Hub 的提醒：在最后一条含标记的 user 消息里找。
    const userTexts = (body.messages || []).filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    const asked = [...(userTexts.reverse().find(t => /GW_MARKER_\w+/.test(t)) || textOf(lastUser?.content)).matchAll(/GW_MARKER_\w+/g)].at(-1)?.[0];
    // Claude Code 的后台小请求（标题、话题判断等）立即回；带标记的主请求先「排队」再回，用来看排队提示。
    if (asked) await sleep(FIRST_CHUNK_DELAY_MS);
    const reply = asked ? `MOCK_GATEWAY_FINAL: ${asked}` : 'ok';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    const id = 'chatcmpl-e2e';
    send({ id, model: 'dsv41', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
    send({ id, model: 'dsv41', choices: [{ index: 0, delta: { reasoning: '用户要标记' } }] });
    for (const piece of reply.match(/.{1,6}/g)) { send({ id, model: 'dsv41', choices: [{ index: 0, delta: { content: piece } }] }); await sleep(30); }
    send({ id, model: 'dsv41', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ id, model: 'dsv41', choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
  // 公司真机上本脚本借已装 Hub 的 exe 当 node 跑（ELECTRON_RUN_AS_NODE）；不能把它带给被测 Hub。
  delete process.env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-own-dsh-'));
  report.root = root;
  const home = path.join(root, 'home'), data = path.join(root, 'data'), claudeDir = path.join(root, 'claude');
  for (const dir of [home, data, claudeDir, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', bypassPermissionsModeAccepted: true, numStartups: 5 }));
  const gw = REAL ? { server: { close() {} }, origin: null } : await startGateway();
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const cliDirs = ['claude', 'node'].map(whichDir);
  assert.ok(cliDirs.every(Boolean), 'claude and node must be installed for this end-to-end test');
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: claudeDir,
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0', AI_HUB_DSH_CLI_ROOT: DSH_ROOT,
    [pathKey]: [...new Set(cliDirs), system, path.join(system, 'WindowsPowerShell/v1.0')].join(';'),
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '',
    HUB_CODEX_API_KEY: '', HUB_CLAUDE_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '',
    ...(REAL ? {} : { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' }) };
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
  async function typeInto(selector, text, { clear = false } = {}) {
    await click(selector);
    if (clear) await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.select();})()`);
    await cdp.send('Input.insertText', { text });
  }
  async function shot(name) {
    await sleep(300);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, `${stamp}-owndsh-${name}-ownN.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    report.screenshots.push(file);
  }
  try {
    // 机器忙时 Electron 冷启动可能超过 hub-launcher 的 30 秒，最多试 3 次。
    for (let n = 1; !hub; n++) {
      try { hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'own-dsh', windowMode: 'hidden', extraEnv: env,
      ...(process.env.HUB_E2E_EXE ? { executablePath: process.env.HUB_E2E_EXE } : {}) }); }
      catch (error) { if (n >= 3 || !/CDP not ready|not owned by spawned PID/.test(error.message)) throw error; await sleep(3000); }
    }
    // 主窗口出现前反复找（公司真机较慢，打包版的主页面要过一会儿才出来）。
    for (const end = Date.now() + 90000; !cdp;) {
      try { cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url)); }
      catch (error) { if (Date.now() > end) throw error; await sleep(1000); }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!document.querySelector("#api-gateway-start") && document.querySelector("#api-gateway-start").innerHTML.length > 0', 'welcome gateway block', 40000);

    // 1. 首页：用 API key 开始（本机没有 CodeAgent 时直接是表单；有 CodeAgent 时是一行入口，点开）。
    const recommended = await cdp.eval('!!document.querySelector("#api-gateway-start .api-gw-card.rec")');
    report.codeagentDetected = !recommended;
    if (!await cdp.eval('!!document.querySelector("#api-gateway-start input[name=apiKey]")')) await click('#api-gateway-start [data-gw="expand"]');
    await until('!!document.querySelector("#api-gateway-start input[name=apiKey]")', 'gateway form');
    check('网关地址已预填（公司默认网关）', await cdp.eval('document.querySelector("#api-gateway-start input[name=baseURL]").value.startsWith("http://models.")'));
    await shot('01-welcome');
    // 错的 key：就地报「key 无效」，不落盘。真实模式不改地址，用预填的公司网关。
    if (!REAL) {
      await click('#api-gateway-start [data-gw="addr"]');
      await typeInto('#api-gateway-start input[name=baseURL]', gw.origin + '/v1', { clear: true });
    }
    await typeInto('#api-gateway-start input[name=apiKey]', 'sk-wrong-key-for-e2e');
    await click('#api-gateway-start [data-gw="save"]');
    await until('!!document.querySelector("#api-gateway-start .api-gw-err")', 'bad key error', 20000);
    check('key 错误时就地提示「key 无效」并给出重新验证按钮', await cdp.eval('document.querySelector("#api-gateway-start .api-gw-err").innerText.includes("key 无效")'));
    await shot('02-bad-key');
    check('key 错误时没有保存', !fs.existsSync(path.join(data, 'api-gateway', 'gateway.json')) || !JSON.parse(fs.readFileSync(path.join(data, 'api-gateway', 'gateway.json'), 'utf8')).encryptedKey);
    // 正确的 key。
    await typeInto('#api-gateway-start input[name=apiKey]', KEY, { clear: true });
    await click('#api-gateway-start [data-gw="save"]');
    await until('document.querySelector("#api-gateway-start")?.innerText.includes("已连通")', 'gateway saved', 30000);
    if (REAL) {
      report.gateway.modelCount = await cdp.eval('document.querySelectorAll("#api-gateway-start [data-gw-model]").length');
      check('保存后显示已连通和网关上的模型', report.gateway.modelCount > 0 && await cdp.eval(`document.querySelector("#api-gateway-start").innerText.includes("找到 ${report.gateway.modelCount} 个模型")`));
    } else check('保存后显示已连通和 4 个模型', await cdp.eval('document.querySelector("#api-gateway-start").innerText.includes("找到 4 个模型") && document.querySelectorAll("#api-gateway-start [data-gw-model]").length === 4'));
    check('默认模型是 deepseek-v4.1-flash', await cdp.eval('document.querySelector("#api-gateway-start [data-gw-model][aria-checked=true]")?.dataset.gwModel === "deepseek-v4.1-flash"'));
    await shot('03-connected');
    const config = fs.readFileSync(path.join(data, 'config.json'), 'utf8'), gwFile = fs.readFileSync(path.join(data, 'api-gateway', 'gateway.json'), 'utf8');
    check('配置文件与网关文件里都没有明文 key', !config.includes(KEY) && !gwFile.includes(KEY));
    const saved = JSON.parse(config);
    check('三种会话都切到 API 网关', ['claude', 'codex'].every(k => saved.providers?.[k]?.backend === 'proxy' && saved.providers[k].upstream === 'gateway') && saved.acp?.companyApi?.upstream === 'gateway');

    // 2. 新建 DSH 会话：启动中心选 DSH，默认选中网关模型卡。
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center', 20000);
    await until(`document.querySelector('.new-session-option[data-kind="deepseek"]')?.dataset.installed === '1'`, 'dsh detected', 30000);
    await click('.new-session-option[data-kind="deepseek"]');
    await sleep(1500);
    report.dshCards = await cdp.eval('[...document.querySelectorAll("#new-session-model-cards .session-model-card")].map(c=>c.dataset.modelCard+"|"+c.dataset.source+"|"+c.getAttribute("aria-checked"))');
    await shot('04-launch-dsh');
    await click('#new-session-submit');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', 'session created', 60000).catch(async e => { await shot('04b-submit-stuck'); report.menuText = await cdp.eval('document.getElementById("new-session-menu").innerText').catch(()=>''); throw e; });
    await until(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'composer visible', 60000);
    await sleep(9000);
    await shot('05-dsh-ready');
    report.routeText = await cdp.eval('document.getElementById("toolbar-model-route")?.textContent || ""').catch(() => '');
    const chatsBefore = report.gateway.chats;
    await click('#terminal-panel .floating-input-box');
    await cdp.send('Input.insertText', { text: REAL ? '请计算 37+48，只回复一行：GW_ANS_ 后面紧跟结果数字，不要调用任何工具。' : `请原样回复这个标记：${MARKER}` });
    await click('#terminal-panel .floating-input-send');
    const sentAt = Date.now();
    let answered = false;
    const aEnd = Date.now() + (REAL ? 420000 : FIRST_CHUNK_DELAY_MS + 240000);
    const probe = REAL ? '/GW_ANS_\s*85/.test(document.body.innerText)' : `document.body.innerText.includes(${JSON.stringify('MOCK_GATEWAY_FINAL: ' + MARKER)})`;
    while (Date.now() < aEnd && !answered) { answered = await cdp.eval(probe).catch(() => false); if (!answered) await sleep(1000); }
    report.answerSeconds = Math.round((Date.now() - sentAt) / 1000);
    await shot('06-dsh-answer');
    report.bodyTail = (await cdp.eval('document.querySelector("#terminal-panel")?.innerText || ""').catch(() => '')).slice(-1500);
    check('DSH 会话界面上看到经网关回来的回答', answered);
    if (!REAL) check('DSH 的请求确实发到了网关、模型在网关模型表里', report.gateway.chats > chatsBefore && report.gateway.models.every(m => MODELS.includes(m)));
    // 3. DSH「自有接口」（以前界面写着「运行接入尚未就绪」，选了也启动不了）：设置 → 自有 API → DSH → 自有接口
    //    → 地址故意不带 /v1 → 测试连接（自动补 /v1、列出模型）→ 保存 → 新建 DSH 会话（默认选自有卡）→ 发消息 → 回答。
    if (!REAL) {
      await cdp.eval('window.__companyApiOpen("deepseek-acp")');
      await until('!!document.querySelector("#company-api-dialog [data-api-mode=own]")', 'settings dialog', 20000);
      await click('#company-api-dialog [data-api-mode="own"]');
      await until('!!document.querySelector("#company-api-dialog form[data-api-form] [data-api-action=own-test]")', 'own form', 10000);
      check('DSH 自有接口页不再写「运行接入尚未就绪」', !(await cdp.eval('document.querySelector("#company-api-dialog").innerText.includes("尚未就绪")')));
      await typeInto('#company-api-dialog input[name=baseURL]', gw.origin, { clear: true });
      await typeInto('#company-api-dialog input[name=apiKey]', KEY);
      await click('#company-api-dialog [data-api-action="own-test"]');
      await until('document.querySelector("#company-api-dialog [role=status]")?.textContent.includes("连接正常")', 'own probe', 20000);
      check('测试连接：地址自动补上 /v1、模型从列表里填好', await cdp.eval(`document.querySelector("#company-api-dialog input[name=baseURL]").value === ${JSON.stringify(gw.origin + '/v1')} && document.querySelector("#company-api-dialog input[name=model]").value === "deepseek-v4.1-flash"`));
      check('测试连接后出现「接口上的模型」下拉，列出 4 个模型', await cdp.eval('!document.querySelector("#company-api-dialog [data-own-model-pick]").hidden && document.querySelectorAll("#company-api-dialog [data-own-model-select] option").length === 4'));
      await cdp.eval('(()=>{const s=document.querySelector("#company-api-dialog [data-own-model-select]");s.value="qwen3.8-27b";s.dispatchEvent(new Event("change"));})()');
      check('下拉里换模型后模型框跟着变', await cdp.eval('document.querySelector("#company-api-dialog input[name=model]").value === "qwen3.8-27b"'));
      await shot('07-dsh-own-probe');
      await click('#company-api-dialog form[data-api-form] [type=submit]');
      await until('document.querySelector("#company-api-dialog [role=status]")?.textContent.includes("直连这个接口")', 'own saved', 20000);
      await shot('08-dsh-own-saved');
      const saved = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
      check('DSH 自有接口落盘：地址、模型', saved.acp?.companyApi?.baseURL === gw.origin + '/v1' && saved.acp.companyApi.model === 'qwen3.8-27b');
      await click('#company-api-dialog .company-api-close');
      await click('#btn-new');
      await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center 2', 20000);
      await click('.new-session-option[data-kind="deepseek"]');
      await until('document.querySelector("#new-session-model-cards .session-model-card[aria-checked=true]")?.dataset.source === "own"', 'own card preselected', 20000);
      check('启动中心默认选中 DSH 自有接口卡', true);
      await shot('09-launch-dsh-own');
      await click('#new-session-submit');
      await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', 'own session created', 60000);
      await until(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'own composer', 60000);
      await sleep(9000);
      const before = report.gateway.chats, ownMarker = 'GW_MARKER_OWN7';
      await click('#terminal-panel .floating-input-box');
      await cdp.send('Input.insertText', { text: `请原样回复这个标记：${ownMarker}` });
      await click('#terminal-panel .floating-input-send');
      let ok = false;
      for (const end = Date.now() + 240000; Date.now() < end && !ok;) { ok = await cdp.eval(`document.body.innerText.includes(${JSON.stringify('MOCK_GATEWAY_FINAL: ' + ownMarker)})`).catch(() => false); if (!ok) await sleep(1000); }
      await shot('10-dsh-own-answer');
      report.ownTail = (await cdp.eval('document.querySelector("#terminal-panel")?.innerText || ""').catch(() => '')).slice(-1500);
      check('DSH 自有接口会话看到回答', ok);
      check('请求直连到自有接口、用的是选的 qwen3.8-27b', report.gateway.chats > before && report.gateway.models.slice(before).includes('qwen3.8-27b'));

      // 4. 自有 API 账号能编辑、能删除（群诉求第 7 项）：Claude Code 加一个账号 → 改名 → 删除。
      await cdp.eval('window.__companyApiOpen("claude")');
      await until('!!document.querySelector("#company-api-dialog [data-api-mode=own]")', 'claude dialog', 20000);
      await click('#company-api-dialog [data-api-mode="own"]');
      await until('!!document.querySelector("#company-api-dialog [data-api-profile]")', 'profile select', 10000);
      await cdp.eval('(()=>{const s=document.querySelector("#company-api-dialog [data-api-profile]");s.value="new";s.dispatchEvent(new Event("change"));})()');
      await until('!!document.querySelector("#company-api-dialog input[name=label]")', 'new profile form', 10000);
      await typeInto('#company-api-dialog input[name=label]', '部门 A');
      await typeInto('#company-api-dialog input[name=baseURL]', gw.origin + '/v1', { clear: true });
      await typeInto('#company-api-dialog input[name=apiKey]', KEY);
      await typeInto('#company-api-dialog input[name=model]', 'glm-5.3-flash', { clear: true });
      await click('#company-api-dialog [data-api-action="own-test"]');
      await until('document.querySelector("#company-api-dialog [role=status]")?.textContent.includes("连接正常")', 'claude probe', 20000);
      check('Claude Code 测试连接后就地提示 OpenAI 兼容接口要改用 API 网关接入', await cdp.eval('!document.querySelector("#company-api-dialog [data-own-hint]").hidden && !!document.querySelector("#company-api-dialog [data-api-action=own-to-gateway]")'));
      await shot('11-claude-own-hint');
      await click('#company-api-dialog form[data-api-form] [type=submit]');
      await until('document.querySelector("#company-api-dialog [role=status]")?.textContent.includes("已保存")', 'profile saved', 20000);
      check('编辑中的账号有「删除此账号」和「保存修改」', await cdp.eval('!!document.querySelector("#company-api-dialog [data-api-action=profile-delete]") && document.querySelector("#company-api-dialog form [type=submit]").textContent.includes("保存修改")'));
      // 已保存的 Key 只发往原地址：改了地址、Key 留空去测试，就地要求重新粘贴 Key，不往新地址发。
      const chatsAtSwap = report.gateway.chats;
      await typeInto('#company-api-dialog input[name=baseURL]', 'http://127.0.0.1:9/v1', { clear: true });
      await click('#company-api-dialog [data-api-action="own-test"]');
      await until('document.querySelector("#company-api-dialog [role=status]")?.textContent.includes("重新粘贴 Key")', 'key needed', 10000);
      check('改了地址、Key 留空时不拿已存 Key 去测新地址', report.gateway.chats === chatsAtSwap);
      await typeInto('#company-api-dialog input[name=baseURL]', gw.origin + '/v1', { clear: true });
      await typeInto('#company-api-dialog input[name=label]', '部门 A2', { clear: true });
      await click('#company-api-dialog form[data-api-form] [type=submit]');
      await until('document.querySelector("#company-api-dialog [role=status]")?.textContent.includes("已保存")', 'profile edited', 20000);
      const edited = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).providers?.claude?.api_profiles || [];
      check('改名后落盘、Key 留空保留原 Key', edited.length === 1 && edited[0].label === '部门 A2' && edited[0].apiKey === KEY);
      await click('#company-api-dialog [data-api-action="profile-delete"]');
      await until('document.querySelector("#company-api-dialog [data-api-action=profile-delete]")?.textContent.includes("确认删除")', 'confirm delete', 5000);
      await shot('12-claude-profile-delete-confirm');
      await click('#company-api-dialog [data-api-action="profile-delete"]');
      await until('document.querySelector("#company-api-dialog [role=status]")?.textContent.includes("已删除")', 'profile deleted', 20000);
      const left = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).providers?.claude?.api_profiles || [];
      check('删除后列表里没有这个账号', left.length === 0);
      await shot('13-claude-profile-deleted');
    }
    report.uiChecksPassed = true;
  } catch (error) {
    report.error = error.stack + (error.logTail ? '\nLOG:\n' + error.logTail : '');
    if (cdp) await shot('failure').catch(() => {});
    throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      fs.writeFileSync(path.join(out, `${stamp}-owndsh-hub-ownN.log`), hub.log().join('\n').split(KEY).join('<KEY>'));
      try { report.exit = await gracefulQuit(hub); }
      catch (error) { report.teardownError = error.stack; process.exitCode = 1; }
      finally { hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); }
      try { const log = fs.readFileSync(path.join(data, 'diagnostics', 'company-model-proxy.log'), 'utf8'); report.keyInProxyLog = log.includes(KEY);
        fs.writeFileSync(path.join(out, `${stamp}-owndsh-proxy-ownN.log`), log.split(KEY).join('<KEY>')); } catch { /* not started */ }
      // 整个隔离测试目录（数据、home、会话记录、日志、配置）里都不该出现明文 key。
      report.plainKeyFiles = [];
      // 自有接口的 Key 按设计存在主配置和自有 API 账号的落盘版本里（与 Claude Code / Codex 的自有接口一致）；其余位置一律不许出现。
      const ALLOWED_KEY_FILE = /^data[\\/](config\.json(\.[\w.-]+)?|cli-api-profiles[\\/].+[\\/]connection\.json)$/;
      const scan = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name);
        if (e.isDirectory()) scan(f); else { try { if (fs.statSync(f).size < 50e6 && fs.readFileSync(f).includes(KEY) && !ALLOWED_KEY_FILE.test(path.relative(root, f))) report.plainKeyFiles.push(path.relative(root, f)); } catch { /* 占用中的文件跳过 */ } } } };
      try { scan(root); } catch (error) { report.scanError = String(error.message); }
    }
    gw.server.close();
    report.ok = !!report.uiChecksPassed && report.keyInProxyLog === false && !report.plainKeyFiles?.length && report.exit?.exitCode === 0 && !report.teardownError;
    if (report.error) report.error = report.error.split(KEY).join('<KEY>');
    fs.writeFileSync(path.join(out, `${stamp}-owndsh-e2e-result-ownN.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, real: REAL, answerSeconds: report.answerSeconds, queueShown: report.queueShown, sidebar: report.sidebarUsage, plainKeyFiles: report.plainKeyFiles, checks: report.checks.length, failed: report.checks.filter(c => !c.ok).map(c => c.name), screenshots: report.screenshots.length, keyInProxyLog: report.keyInProxyLog, error: (report.error || report.teardownError || '').slice(0, 400) }));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
