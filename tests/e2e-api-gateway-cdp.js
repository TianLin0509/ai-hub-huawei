'use strict';
// API 网关（部门 API key 用户，2026-11-19）真实用户路径，隔离 Hub（隐藏窗口、独立数据目录与 CDP 端口）：
//   全新用户 → 首页「用 API key 开始」→ 改地址指向模拟网关 → 粘 key →「保存并继续」→ 选默认模型
//   → 启动中心默认选中网关模型卡 → 新建 Claude Code 会话 → 发消息 → 首包前标题栏显示「网关排队中」→ 回答出现
//   → 侧栏显示网关用量 → 设置里该工具是「API 网关」模式；配置文件里没有明文 key。
// 2026-11-20 API 网关体检：保存 key 后后台自动体检一次 → 设置里右栏有分组（free）和能力表：能用 / 首字 / 工具 / 思考 / 上下文 / 接口，
//   503「分组下没有渠道」的模型显示「不对你的 free 分组开放」并给「换个模型」；1440×900 下弹窗一屏放下、不出纵向滚动。
//   截图另存到 HUB_E2E_SHOT_DIR（默认同产物目录）。
// 真实 Claude Code CLI 运行；反代由 Hub 照常启动；网关是本进程里的模拟 OpenAI 兼容网关（无公司网络、无真实 key）。
//   node tests/e2e-api-gateway-cdp.js        （产物：HUB_E2E_ARTIFACT_DIR 或 artifacts/api-gateway）
// 真实网关模式（只在公司黄区跑）：E2E_GATEWAY_KEY_FILE=<本人受保护的 key 文件>，可选 HUB_E2E_EXE=<已装 Hub 的 exe 副本>。
//   用预填的默认网关地址、像真实用户一样粘贴 key；key 只从文件读进内存，不写进任何产物，日志里出现就替换成 <KEY>。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/api-gateway');
const shotsDir = path.resolve(process.env.HUB_E2E_SHOT_DIR || out);
const PRICING = fs.readFileSync(path.join(__dirname, 'fixtures', 'ascend-pricing-20261120.json'), 'utf8');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const KEY_FILE = process.env.E2E_GATEWAY_KEY_FILE || '';
const REAL = !!KEY_FILE;
const KEY = REAL ? fs.readFileSync(KEY_FILE, 'utf8').replace(/^\s*Authorization:\s*Bearer\s*/i, '').trim() : 'e2e-fake-gateway-key-0001';
const MODELS = ['qwen-aw-35b', 'deepseek-v4.1-flash', 'qwen3.8-27b', 'glm-5.3-flash'];
const MARKER = 'GW_MARKER_5T8';
const FIRST_CHUNK_DELAY_MS = Number(process.env.E2E_GATEWAY_DELAY_MS) || 12000; // 模拟网关排队（11-19 实测 12–31 秒）
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
    // 网关公开目录：不要 key（11-20 黄区实测还原的样本）。
    if (req.url === '/api/pricing') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(PRICING); }
    if (req.headers.authorization !== 'Bearer ' + KEY) { report.gateway.authFailures++; res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Invalid token","type":"new_api_error"}}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: MODELS.map(id => ({ id, object: 'model' })), object: 'list' })); }
    if (req.url.startsWith('/api/usage/token')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: true, data: { total_used: 25103, total_granted: 0, total_available: -25103, unlimited_quota: true, expires_at: 0 } })); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    report.gateway.chats++; report.gateway.models.push(body.model);
    // 一键体检的试跑请求（带 get_time 工具的一句话）：四个模型四种回法，覆盖能力表的各种格子。
    if (body.tools?.[0]?.function?.name === 'get_time' && body.messages?.length === 1) {
      report.gateway.healthProbes = (report.gateway.healthProbes || 0) + 1;
      if (body.model === 'qwen3.8-27b') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'model_not_found', message: 'No available channel for model qwen3.8-27b under group free (distributor)', type: 'new_api_error' } })); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const put = (obj, tight) => res.write((tight ? 'data:' : 'data: ') + JSON.stringify(obj) + '\n\n');
      const hid = 'chatcmpl-hc';
      await sleep(body.model === 'glm-5.3-flash' ? 900 : 300);
      report.gateway.probeBodies = [...(report.gateway.probeBodies || []), { model: body.model, noThink: body.chat_template_kwargs?.enable_thinking === false }];
      if (body.model === 'qwen-aw-35b' && body.chat_template_kwargs?.enable_thinking !== false) {
        // 11-20 黄区实测：开着思考时整段都是思考、到上限没正文（finish=length）；帧格式空格不一。
        for (const c of ['用户要', '查时间', '先想想']) put({ id: hid, choices: [{ index: 0, delta: { reasoning: c } }] }, true);
        put({ id: hid, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
      } else if (body.model === 'qwen-aw-35b') { // 关了思考：直接回正文（每段带空 tool_calls、data: 后没空格）
        for (const c of ['现在', '是下午三点']) put({ id: hid, choices: [{ index: 0, delta: { content: c, tool_calls: [] } }] }, true);
        put({ id: hid, choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: 'stop' }] }, true);
      } else {
        if (body.model === 'glm-5.3-flash') put({ id: hid, choices: [{ index: 0, delta: { reasoning_content: '要查时间，调用工具。' } }] });
        put({ id: hid, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_hc', type: 'function', function: { name: 'get_time', arguments: '{}' } }] } }] });
        put({ id: hid, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      }
      return res.end('data: [DONE]\n\n');
    }
    const lastUser = [...(body.messages || [])].reverse().find(m => m.role === 'user');
    const asked = /GW_MARKER_\w+/.exec(textOf(lastUser?.content))?.[0];
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
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-api-gateway-'));
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
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0',
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
    const file = path.join(shotsDir, `${stamp}-apigw-${name}-m3.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    report.screenshots.push(file);
  }
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'api-gateway', windowMode: 'hidden', extraEnv: env,
      ...(process.env.HUB_E2E_EXE ? { executablePath: process.env.HUB_E2E_EXE } : {}) });
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

    // 2. 新建 Claude Code 会话：启动中心默认选中网关模型卡。
    await click('#api-gateway-start [data-gw="start"]');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center', 20000);
    await until(`document.querySelector('.new-session-option[data-kind="claude"]')?.dataset.installed === '1'`, 'claude detected', 30000);
    await click('.new-session-option[data-kind="claude"]');
    const cardCount = REAL ? report.gateway.modelCount : 4;
    await until(`document.querySelectorAll("#new-session-model-cards .session-model-card[data-source=gateway]").length === ${cardCount}`, 'gateway cards', 20000);
    check('启动中心有全部 API 网关模型卡，默认选中 deepseek-v4.1-flash', await cdp.eval('document.querySelector("#new-session-model-cards .session-model-card[aria-checked=true]")?.dataset.modelCard === "gw:deepseek-v4.1-flash"'));
    await shot('04-launch');
    await click('#new-session-submit');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', 'session created', 60000);
    await until(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'composer visible', 60000);
    await sleep(6000);
    check('标题栏显示「API 网关」线路', await cdp.eval('document.getElementById("toolbar-model-route")?.textContent.includes("API 网关")'));

    // 3. 发消息：首包前标题栏显示「网关排队中」，之后出现回答。
    const chatsBefore = report.gateway.chats;
    await click('#terminal-panel .floating-input-box');
    await cdp.send('Input.insertText', { text: REAL ? '请计算 37+48，只回复一行：GW_ANS_ 后面紧跟结果数字，不要调用任何工具。' : `请原样回复这个标记：${MARKER}` });
    await click('#terminal-panel .floating-input-send');
    let queued = false;
    const sentAt = Date.now();
    const qEnd = Date.now() + (REAL ? 60000 : FIRST_CHUNK_DELAY_MS + 45000); // 机器满载时 Claude Code 起得慢（就绪标记 20 秒等不到），多给点时间
    while (Date.now() < qEnd && !queued) { queued = await cdp.eval('document.getElementById("toolbar-model-route")?.textContent.includes("网关排队中")').catch(() => false); if (!queued) await sleep(400); }
    if (queued) await shot('05-queue');
    report.queueShown = queued;
    // 真实网关可能很快就回（不排队），这时看不到提示是正常的，只记录不判失败。
    if (!REAL) check('首包前标题栏显示「网关排队中 N 秒」', queued);
    let answered = false;
    const aEnd = Date.now() + (REAL ? 420000 : 120000);
    // 真实模型偶尔在前缀和数字间加空格（11-19 实测回「GW_ANS_ 85」），按正则认。
    const probe = REAL ? '/GW_ANS_\\s*85/.test(document.body.innerText)' : `document.body.innerText.includes(${JSON.stringify('MOCK_GATEWAY_FINAL: ' + MARKER)})`;
    while (Date.now() < aEnd && !answered) { answered = await cdp.eval(probe).catch(() => false); if (!answered) await sleep(1000); }
    report.answerSeconds = Math.round((Date.now() - sentAt) / 1000);
    await shot('06-answer');
    check('界面上看到经网关回来的回答', answered);
    if (!REAL) check('请求确实发到了网关、模型是用户选的 deepseek-v4.1-flash', report.gateway.chats > chatsBefore && report.gateway.models.includes('deepseek-v4.1-flash') && report.gateway.models.every(m => MODELS.includes(m)));
    await sleep(6000);
    check('回答后排队提示消失', !(await cdp.eval('document.getElementById("toolbar-model-route")?.textContent.includes("网关排队中")').catch(() => true)));

    // 4. 侧栏用量与设置。
    await until('!document.getElementById("rail-gateway-usage")?.hidden && document.getElementById("rail-gateway-usage").innerText.includes("已用")', 'sidebar usage', 20000).catch(() => {});
    report.sidebarUsage = await cdp.eval('document.getElementById("rail-gateway-usage")?.innerText || ""').catch(() => '');
    check('侧栏显示 API 网关已用量', REAL ? report.sidebarUsage.includes('已用') : report.sidebarUsage.includes('25,103') && report.sidebarUsage.includes('不限额'));
    await cdp.eval('window.__companyApiOpen("claude")');
    await until('!!document.querySelector("#company-api-dialog [data-gateway-form]")', 'settings gateway form', 20000);
    check('设置里 Claude Code 是「API 网关」模式，key 显示为已保存', await cdp.eval('document.querySelector("#company-api-dialog [data-api-mode=gateway]").getAttribute("aria-checked")==="true" && document.querySelector("#company-api-dialog").innerText.includes("key 已保存")'));
    // 5. 网关体检：保存 key 时后台已自动体检一次，打开设置就能看到能力表。
    const row = id => `document.querySelector('#company-api-dialog [data-api-gw-row="${id}"]')`;
    await until(`!!document.querySelector('#company-api-dialog [data-api-gw-health] tbody tr[data-api-gw-state]')`, 'health table', 60000);
    const groupText = await cdp.eval('document.querySelector("#company-api-dialog [data-api-gw-group]").innerText');
    report.groupText = groupText;
    check('右栏写明分组', REAL ? /你的 key 在 \S+ 分组/.test(groupText) : groupText.includes('你的 key 在 free 分组'));
    if (!REAL) {
      check('保存 key 后自动体检过（没点按钮就有结果）', (report.gateway.healthProbes || 0) >= 4);
      check('能力表：deepseek 能用、会用工具、上下文 256K', await cdp.eval(`${row('deepseek-v4.1-flash')}?.dataset.apiGwState === 'ok' && /256K/.test(${row('deepseek-v4.1-flash')}.innerText) && ${row('deepseek-v4.1-flash')}.innerText.includes('会')`));
      check('能力表：glm 有思考、接口含 Anthropic', await cdp.eval(`${row('glm-5.3-flash')}.innerText.includes('有') && ${row('glm-5.3-flash')}.innerText.includes('Anthropic')`));
      check('能力表：只出思考的 qwen-aw-35b 标「想太久没回答」、首正文「没出」，给「关闭思考」', await cdp.eval(`${row('qwen-aw-35b')}?.dataset.apiGwState === 'slow' && ${row('qwen-aw-35b')}.innerText.includes('没出') && ${row('qwen-aw-35b')}.innerText.includes('想太久没回答') && !!${row('qwen-aw-35b')}.querySelector('[data-api-gw-act="no-think"]')`));
      check('能力表：glm 首字分「思考 / 正文」两个数', await cdp.eval(`/[\\d.]+ \\/ [\\d.]+/.test(${row('glm-5.3-flash')}.innerText)`));
      check('能力表：503 分组无渠道显示「不对你的 free 分组开放」+ 换个模型按钮，不说成网络问题', await cdp.eval(`${row('qwen3.8-27b')}?.dataset.apiGwState === 'fail' && ${row('qwen3.8-27b')}.innerText.includes('不对你的 free 分组开放') && !${row('qwen3.8-27b')}.innerText.includes('网络') && !!${row('qwen3.8-27b')}.querySelector('[data-api-gw-act="switch-model"]')`));
      check('看不到的模型说清开给谁', groupText.includes('qwen3.8-flash-next（只开给 default）'));
    }
    check('1440×900 下弹窗一屏放下：不溢出、不出纵向滚动', await cdp.eval('(()=>{const e=document.getElementById("company-api-dialog"),r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&e.scrollHeight<=e.clientHeight+1&&e.scrollWidth<=e.clientWidth+1})()'));
    check('标题旁显示网关地址（同事靠它认出是哪个网关），不再指向不存在的「模型线路」', await cdp.eval(`(() => {
      const d = document.getElementById('company-api-dialog'); const host = d.querySelector('[data-api-gw-host]')?.textContent || '';
      const url = d.querySelector('input[name=baseURL]')?.value || '';
      return !!host && url.includes(host) && !d.innerText.includes('模型线路');
    })()`));
    await shot('07-settings-health');
    if (!REAL) {
      await click('#company-api-dialog [data-api-gw-row="qwen3.8-27b"] [data-api-gw-act="switch-model"]');
      check('点「换个模型」：默认模型换成能用且会调工具的', await cdp.eval('["deepseek-v4.1-flash","glm-5.3-flash"].includes(document.querySelector("#company-api-dialog select[name=model]").value) && document.querySelector("#company-api-dialog [role=status]").textContent.includes("已把默认模型换成")'));
      await click('#company-api-dialog [data-api-gw-row="qwen3.8-27b"] summary');
      check('网关原话在详情里', await cdp.eval(`${row('qwen3.8-27b')}.querySelector('details code')?.textContent.includes('No available channel')`));
    }
    if (!REAL) {
      await click('#company-api-dialog [data-api-gw-row="qwen-aw-35b"] [data-api-gw-act="no-think"]');
      await until(`document.querySelector('#company-api-dialog [role=status]')?.textContent.includes('已对 qwen-aw-35b 关闭思考')`, 'no-think saved', 10000);
      check('点「关闭思考」：按模型存进设置', JSON.parse(fs.readFileSync(path.join(data, 'api-gateway', 'gateway.json'), 'utf8')).noThinking?.includes('qwen-aw-35b'));
    }
    const probesBefore = report.gateway.healthProbes || 0;
    await click('#company-api-dialog [data-api-action="gw-health"]');
    await until('document.querySelector("#company-api-dialog [role=status]")?.textContent.includes("体检完成")', 'healthcheck again', REAL ? 300000 : 60000);
    if (!REAL) {
      check('再点「一键体检」重测全部 4 个对话模型', (report.gateway.healthProbes || 0) - probesBefore === 4);
      check('关闭思考后试跑带 enable_thinking=false，qwen-aw-35b 直接回答、标「已关闭」', report.gateway.probeBodies.slice(-4).some(b => b.model === 'qwen-aw-35b' && b.noThink)
        && await cdp.eval(`${row('qwen-aw-35b')}?.dataset.apiGwState === 'ok' && ${row('qwen-aw-35b')}.innerText.includes('已关')`));
    }
    report.healthStatus = await cdp.eval('document.querySelector("#company-api-dialog [role=status]").textContent');
    check('再体检后弹窗仍一屏放下', await cdp.eval('(()=>{const e=document.getElementById("company-api-dialog");return e.scrollHeight<=e.clientHeight+1&&e.getBoundingClientRect().bottom<=innerHeight})()'));
    await shot('08-health-again');
    report.uiChecksPassed = true;
  } catch (error) {
    report.error = error.stack;
    if (cdp) await shot('failure').catch(() => {});
    throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      fs.writeFileSync(path.join(out, `${stamp}-apigw-hub-claude18.log`), hub.log().join('\n').split(KEY).join('<KEY>'));
      try { report.exit = await gracefulQuit(hub); }
      catch (error) { report.teardownError = error.stack; process.exitCode = 1; }
      finally { hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); }
      try { const log = fs.readFileSync(path.join(data, 'diagnostics', 'company-model-proxy.log'), 'utf8'); report.keyInProxyLog = log.includes(KEY);
        fs.writeFileSync(path.join(out, `${stamp}-apigw-proxy-claude18.log`), log.split(KEY).join('<KEY>')); } catch { /* not started */ }
      // 整个隔离测试目录（数据、home、会话记录、日志、配置）里都不该出现明文 key。
      report.plainKeyFiles = [];
      const scan = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name);
        if (e.isDirectory()) scan(f); else { try { if (fs.statSync(f).size < 50e6 && fs.readFileSync(f).includes(KEY)) report.plainKeyFiles.push(path.relative(root, f)); } catch { /* 占用中的文件跳过 */ } } } };
      try { scan(root); } catch (error) { report.scanError = String(error.message); }
    }
    gw.server.close();
    report.ok = !!report.uiChecksPassed && report.keyInProxyLog === false && !report.plainKeyFiles?.length && report.exit?.exitCode === 0 && !report.teardownError;
    if (report.error) report.error = report.error.split(KEY).join('<KEY>');
    fs.writeFileSync(path.join(out, `${stamp}-apigw-e2e-result-claude18.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, real: REAL, answerSeconds: report.answerSeconds, queueShown: report.queueShown, sidebar: report.sidebarUsage, plainKeyFiles: report.plainKeyFiles, checks: report.checks.length, failed: report.checks.filter(c => !c.ok).map(c => c.name), screenshots: report.screenshots.length, keyInProxyLog: report.keyInProxyLog, error: (report.error || report.teardownError || '').slice(0, 400) }));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
