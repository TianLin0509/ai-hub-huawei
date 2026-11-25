'use strict';
// R45（2026-11-25）自定义模型 / 部门 key 二期的真实操作路径：
//   设置 → 自有 API → Claude Code → 自有接口：先填只懂 OpenAI 的部门接口 → 测试连接 → 就地看到「协议对不上」和「改用 API 网关接入」；
//   换成能用的接口 → 测试连接（对话测试通过）→「全部加入」三个模型 → 保存；
//   API 网关：保存部门 key → 自动体检 → 默认模型下拉「手填模型名…」→ 检测并加入带日期后缀的模型；
//   启动中心 Claude Code：自有接口三张卡 + 网关卡里有手填模型 → 选自有接口第二个模型建会话发消息 → 请求带的就是这个模型；
//   再选网关手填模型建会话发消息 → 请求带的就是手填模型；最后读分身页的后端清单，看到「部门 API key（网关）」一行。
// 隔离 Hub（隐藏窗口、独立数据目录与 home）；两个模拟接口在本进程里；真实 Claude Code CLI。不用任何计费 key。
//   node tests/e2e-r45-custom-model-cdp.js   （产物：HUB_E2E_ARTIFACT_DIR 或 artifacts/r45-custom-model）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/r45-custom-model');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const KEY_OWN = 'e2e-own-key-' + 'a'.repeat(12);
const KEY_GW = 'sk-' + 'e2edeptgw'.repeat(4);
// 8 个模型：加上网关 3 个共 11 张卡，超过 3 行，验证启动中心折叠成「更多模型」。
const OWN_MODELS = ['ma-1', 'ma-2', 'ma-3', 'ma-4', 'ma-5', 'ma-6', 'ma-7', 'ma-8'];
const GW_MODELS = ['deepseek-v4.1-flash', 'glm-5.3-flash'];
const GW_HIDDEN = 'deepseek-v4.1-flash-1017';
const report = { ok: false, checks: [], screenshots: [], own: { probes: [], chats: [] }, gw: { chats: [], paths: [] } };

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
const readBody = async req => { const chunks = []; for await (const c of req) chunks.push(c); try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; } };

// 能用的自有接口：列模型 + Anthropic 格式（Claude Code 会打 {地址}/v1/messages）。
async function startOwn() {
  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const body = await readBody(req);
    const auth = req.headers.authorization === 'Bearer ' + KEY_OWN || req.headers['x-api-key'] === KEY_OWN;
    if (!auth) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"invalid key"}}'); }
    if (req.method === 'GET' && url.endsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: OWN_MODELS.map(id => ({ id })) })); }
    // 和真实 Anthropic 兼容接口一样只认 /v1/messages（审查 P1-1：多拼一层 /v1 就 404）。
    if (url === '/v1/messages/count_tokens') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":12}'); }
    if (url !== '/v1/messages') { res.writeHead(404); return res.end(); }
    const last = [...(body.messages || [])].reverse().find(m => m.role === 'user');
    const marker = /R45OWN_\w+/.exec(textOf(last?.content))?.[0];
    if (body.max_tokens === 1) report.own.probes.push({ path: url, model: body.model }); else report.own.chats.push({ path: url, model: body.model, marker: marker || '' });
    const reply = marker ? `OWN_OK ${body.model} ${marker}` : 'ok';
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const piece of reply.match(/.{1,8}/g)) { ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } }); await sleep(15); }
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    ev('message_stop', {});
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// 部门网关（只懂 OpenAI chat）：/v1/models 只列两个，带日期后缀的模型不列但能用；/messages 405、/responses 404。
async function startGateway() {
  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const body = await readBody(req);
    report.gw.paths.push(`${req.method} ${url}`);
    if (url.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    if (req.headers.authorization !== 'Bearer ' + KEY_GW) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Invalid token","type":"new_api_error"}}'); }
    if (url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: GW_MODELS.map(id => ({ id })) })); }
    if (url.endsWith('/messages')) { res.writeHead(405, { 'content-type': 'application/json' }); return res.end('{"detail":"Method Not Allowed"}'); }
    if (url !== '/v1/chat/completions') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"detail":"Not Found"}'); }
    if (![...GW_MODELS, GW_HIDDEN].includes(body.model)) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `No available channel for model ${body.model} under group default`, type: 'new_api_error' } })); }
    const last = [...(body.messages || [])].reverse().find(m => m.role === 'user');
    const marker = /R45GW_\w+/.exec(textOf(last?.content))?.[0];
    report.gw.chats.push({ model: body.model, marker: marker || '' });
    const reply = marker ? `GW_OK ${body.model} ${marker}` : 'ok';
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    for (const piece of reply.match(/.{1,6}/g)) { send({ id: 'c', model: body.model, choices: [{ index: 0, delta: { content: piece } }] }); await sleep(15); }
    send({ id: 'c', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r45-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data'), claudeDir = path.join(root, 'claude');
  for (const dir of [home, data, claudeDir, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local'), path.join(data, 'api-gateway')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', bypassPermissionsModeAccepted: true, numStartups: 5 }));
  const own = await startOwn();
  const gw = await startGateway();
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
    HUB_CODEX_API_KEY: '', HUB_CLAUDE_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };
  let hub, cdp;
  const check = (name, value, soft = false) => { report.checks.push({ name, ok: !!value, ...(soft ? { soft: true } : {}) }); if (!soft) assert.ok(value, name); };
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await cdp.eval(expression).catch(() => false)) return; await sleep(150); }
    throw new Error('Timeout: ' + label);
  }
  async function click(selector) {
    // 等位置稳定再点（弹窗有开合动画、按目录重画时坐标会变，点到空白处就什么都不发生）。
    let last = '';
    for (let i = 0; i < 20; i++) {
      const rect = await cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return '';const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(Math.round).join(',');})()`).catch(() => '');
      if (rect && rect === last) break;
      last = rect; await sleep(120);
    }
    const point = await cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden control '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function fill(selector, value) {
    await cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input '+${JSON.stringify(selector)});e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  async function shot(name) {
    await sleep(300);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, `${stamp}-R45-${name}-claude.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64')); report.screenshots.push(file);
  }
  const statusText = 'document.querySelector("#company-api-dialog form [role=status]")?.textContent || ""';
  const noScroll = '(() => { const d = document.querySelector("#company-api-dialog"); return !!d && d.scrollHeight <= d.clientHeight + 1 && document.documentElement.scrollHeight <= innerHeight + 1; })()';
  async function newSessionWith(card, marker, reply) {
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center', 20000);
    await until(`!!document.querySelector('#new-session-model-cards [data-model-card="${card}"]')`, 'card ' + card, 30000);
    await click(`#new-session-model-cards [data-model-card="${card}"]`);
    await until(`document.querySelector('#new-session-model-cards [data-model-card="${card}"]')?.getAttribute('aria-checked') === 'true'`, 'card picked', 5000);
    await click('#new-session-submit');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', 'session created', 60000);
    await until(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'composer visible', 60000);
    // 等 CLI 真正就绪再输入（机器忙时 Claude Code 起得慢，过早输入会丢）。
    await until(`(document.querySelector('#terminal-panel .floating-input-box')?.closest('[class]')?.parentElement?.innerText || document.body.innerText).includes('已就绪')`, 'cli ready', 90000).catch(() => {});
    await sleep(2000);
    await click('#terminal-panel .floating-input-box');
    await cdp.send('Input.insertText', { text: `请原样回复这个标记：${marker}` });
    await click('#terminal-panel .floating-input-send');
    await until(`document.body.innerText.includes(${JSON.stringify(reply)})`, 'answer ' + marker, 120000).catch(() => {});
    const ok = await cdp.eval(`document.body.innerText.includes(${JSON.stringify(reply)})`);
    if (!ok) {
      // 没等到回答：切到终端（「后台」）截一张，看 CLI 卡在哪。
      await cdp.eval('[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "后台" && b.offsetParent)?.click()').catch(() => {});
      await sleep(1500);
      await shot('debug-terminal-' + marker);
    }
    return ok;
  }
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'r45-custom-model', windowMode: 'hidden', extraEnv: env });
    for (const end = Date.now() + 90000; !cdp;) {
      try { cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url)); }
      catch (error) { if (Date.now() > end) throw error; await sleep(1000); }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!document.getElementById("btn-new") && typeof window.__companyApiOpen === "function"', 'main page', 40000);

    // 1) 设置 → 自有 API（与设置页「配置接口」按钮同一入口）→ Claude Code → 自有接口：只懂 OpenAI 的部门接口
    await cdp.eval('document.getElementById("company-api-settings-open") ? document.getElementById("company-api-settings-open").click() : window.__companyApiOpen("claude")');
    await until('!!document.querySelector("#company-api-dialog [data-api-kind=claude]")', 'api dialog', 20000);
    await click('#company-api-dialog [data-api-kind=claude]');
    await click('#company-api-dialog [data-api-mode=own]');
    await until('!!document.querySelector("#company-api-dialog form[data-api-form]")', 'own form', 10000);
    await fill('#company-api-dialog [name=baseURL]', gw.origin + '/v1');
    await fill('#company-api-dialog [name=apiKey]', KEY_GW);
    await fill('#company-api-dialog [name=model]', 'deepseek-v4.1-flash');
    await click('#company-api-dialog [data-api-action=own-test]');
    await until('!!document.querySelector("#company-api-dialog [data-own-chat-error]")', 'protocol mismatch line', 40000);
    const mismatch = await cdp.eval(statusText);
    check('只懂 OpenAI 的接口：测试连接就地说清「OpenAI 格式、Claude Code 会报错」', /OpenAI 格式/.test(mismatch) && /405/.test(mismatch));
    check('旁边就是「改用 API 网关接入」按钮', await cdp.eval('!!document.querySelector("#company-api-dialog [data-api-action=own-to-gateway]")'));
    check('状态行写明「模型列表能读到，但对话测试没通过」', /对话测试没通过/.test(await cdp.eval(statusText)));
    check('测试连接打的就是 Claude Code 会打的路径（/v1/v1/messages）', report.gw.paths.includes('POST /v1/v1/messages'));
    check('1440×900 下自有接口页不出现纵向滚动（对话测试没通过、带按钮时）', await cdp.eval(noScroll), true);
    await shot('01-own-protocol-mismatch');

    // 2) 换成能用的接口：地址不带 /v1（自动补）、模型留空（自动填）→ 对话测试通过 →「全部加入」→ 保存
    await fill('#company-api-dialog [name=baseURL]', own.origin);
    await fill('#company-api-dialog [name=apiKey]', KEY_OWN);
    await fill('#company-api-dialog [name=model]', '');
    await click('#company-api-dialog [data-api-action=own-test]');
    await until(`/对话测试通过/.test(${statusText})`, 'chat probe ok', 40000);
    check('能用的接口：对话测试通过，地址保持不带 /v1 的根地址（Claude Code 自己拼 /v1/messages）', (await cdp.eval('document.querySelector("#company-api-dialog [name=baseURL]").value')) === own.origin);
    check('对话测试用的是会话同一个模型和路径', report.own.probes.some(p => p.model === 'ma-1' && p.path === '/v1/messages'));
    await until('!document.querySelector("#company-api-dialog [data-own-models-all]")?.hidden', 'add-all button', 5000);
    await click('#company-api-dialog [data-own-models-all]');
    check('「全部加入」把接口上的 8 个模型填进可选模型', (await cdp.eval('document.querySelector("#company-api-dialog [name=models]").value')) === OWN_MODELS.join(', '));
    check('1440×900 下自有接口页不出现纵向滚动（对话测试通过后）', await cdp.eval(noScroll), true);
    await shot('02-own-chat-ok-add-all');
    await click('#company-api-dialog form[data-api-form] [type=submit]');
    await until(`/已保存/.test(${statusText})`, 'own saved', 20000);
    const cfg = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    check('保存后 Claude Code 自有接口带 8 个模型的模型表', JSON.stringify(cfg.providers?.claude?.model_list) === JSON.stringify(OWN_MODELS));

    // 3) API 网关：保存部门 key（只给 Claude Code 用）→ 自动体检 → 手填带日期后缀的模型
    await click('#company-api-dialog [data-api-mode=gateway]');
    await until('!!document.querySelector("#company-api-dialog form[data-gateway-form]")', 'gateway form', 10000);
    await fill('#company-api-dialog [data-gateway-form] [name=baseURL]', gw.origin + '/v1');
    await fill('#company-api-dialog [data-gateway-form] [name=apiKey]', KEY_GW);
    await cdp.eval('(() => { const c = document.querySelector("#company-api-dialog [name=alsoOthers]"); if (c) c.checked = false; })()');
    await click('#company-api-dialog form[data-gateway-form] [type=submit]');
    // 点击偶尔落在重绘间隙（界面刚按网关目录重画）：3 秒没反应就再点一次。
    await until(`!!(${statusText})`, 'gateway save started', 3000).catch(() => click('#company-api-dialog form[data-gateway-form] [type=submit]'));
    await until(`/体检完成|已保存|正在体检/.test(${statusText})`, 'gateway saved', 40000);
    await until(`/体检完成/.test(${statusText})`, 'health done', 120000).catch(() => {});
    check('网关保存后自动体检完成', /体检完成/.test(await cdp.eval(statusText)), true);
    await shot('03-gateway-health');
    await cdp.eval('(() => { const s = document.querySelector("#company-api-dialog [data-gateway-form] [name=model]"); s.value = "__custom__"; s.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await until('!document.querySelector("#company-api-dialog [data-gw-custom]")?.hidden', 'custom box', 5000);
    await fill('#company-api-dialog [data-gw-custom-input]', GW_HIDDEN);
    await click('#company-api-dialog [data-api-action=gw-custom-check]');
    await until(`/已测通并加入/.test(${statusText})`, 'custom added', 60000);
    check('网关手填带日期后缀的模型：测通后加入并选为默认', (await cdp.eval('document.querySelector("#company-api-dialog [data-gateway-form] [name=model]").value')) === GW_HIDDEN);
    check('1440×900 下网关页不出现纵向滚动', await cdp.eval(noScroll), true);
    await shot('04-gateway-custom-model');
    await click('#company-api-dialog form[data-gateway-form] [type=submit]');
    await until(`/已保存/.test(${statusText})`, 'gateway saved 2', 40000);
    check('网关文件里没有明文 key', !fs.readFileSync(path.join(data, 'api-gateway', 'gateway.json'), 'utf8').includes(KEY_GW));
    await cdp.eval('document.querySelector("#company-api-dialog [data-api-action=close]")?.click(); document.querySelector("#company-api-dialog")?.close?.()');
    await sleep(500);

    // 4) 启动中心：自有接口三张卡 + 网关卡里有手填模型
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center', 20000);
    await until(`!!document.querySelector('.new-session-option[data-kind="claude"]')`, 'claude option', 20000);
    await click('.new-session-option[data-kind="claude"]');
    await until(`!!document.querySelector('#new-session-model-cards [data-model-card="own#ma-2"]')`, 'own cards', 30000);
    const ids = await cdp.eval('[...document.querySelectorAll("#new-session-model-cards .session-model-card")].map(c => c.dataset.modelCard)');
    report.cards = ids;
    check('启动中心：自有接口每个模型一张卡（own、own#ma-2 可见）', ['own', 'own#ma-2'].every(id => ids.includes(id)));
    check('启动中心：卡多时折成 3 行 +「更多模型」，不出现纵向滚动', ids.length === 9 && ids.at(-1) === 'more'
      && await cdp.eval('(() => { const b = document.querySelector(".session-create-body") || document.getElementById("new-session-menu"); return b.scrollHeight <= b.clientHeight + 1; })()'));
    check('启动中心：网关卡里有手填测通的模型', ids.includes('gw:' + GW_HIDDEN));
    await shot('05-launch-cards');
    await click('#new-session-model-cards [data-model-card="more"]');
    await until(`!!document.querySelector('#new-session-model-cards [data-model-card="own#ma-8"]')`, 'expanded cards', 5000);
    check('点「更多模型」在同一区域展开全部（含 own#ma-8），最后一张变「收起」', await cdp.eval('[...document.querySelectorAll("#new-session-model-cards .session-model-card")].at(-1).innerText.includes("收起")'));
    await shot('05b-launch-cards-expanded');
    await cdp.eval('document.getElementById("new-session-cancel")?.click(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await sleep(600);

    // R45_E2E_ORDER=own-first 时先跑自有接口会话（排查会话先后对结果的影响）。
    const runGw = async () => {
    // 6) 选网关手填模型建会话 → 请求带的就是手填模型
    const gwOk = await newSessionWith('gw:' + GW_HIDDEN, 'R45GW_B2', `GW_OK ${GW_HIDDEN} R45GW_B2`);
    await shot('07-gateway-custom-answer');
    check('选网关手填模型：回答经网关回来，请求里的模型是手填模型', gwOk && report.gw.chats.some(c => c.model === GW_HIDDEN && c.marker === 'R45GW_B2'));

    };
    const runOwn = async () => {
    // 5) 选自有接口第二个模型建会话 → 请求带的就是 ma-2
    const ownOk = await newSessionWith('own#ma-2', 'R45OWN_A1', 'OWN_OK ma-2 R45OWN_A1');
    await shot('06-own-ma2-answer');
    check('选自有接口第二个模型：回答回来，请求里的模型是 ma-2', ownOk && report.own.chats.some(c => c.model === 'ma-2' && c.marker === 'R45OWN_A1'));

    };
    if (process.env.R45_E2E_ORDER === 'own-first') { await runOwn(); await runGw(); } else { await runGw(); await runOwn(); }
    // 7) 分身页后端清单（主进程 avatar:status）：有「部门 API key（网关）」一行，模型含手填的
    const av = await cdp.eval('require("electron").ipcRenderer.invoke("avatar:status").then(r => JSON.stringify({ available: r.available, missing: r.missing, reason: r.reason, rows: (r.backends?.rows || []).map(x => ({ id: x.id, usable: x.usable, models: x.models, reason: x.reason })) }))', { awaitPromise: true }).catch(error => JSON.stringify({ error: error.message }));
    report.avatar = JSON.parse(av);
    const gwRow = report.avatar.rows?.find(r => r.id === 'api-gateway');
    check('分身后端清单里有部门 API key 一行，且模型含手填模型', !!gwRow && gwRow.usable && gwRow.models.includes(GW_HIDDEN), true);
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
    own.server.close(); gw.server.close();
    report.ok = !!report.uiChecksPassed && report.exit?.exitCode === 0 && !report.teardownError;
    fs.writeFileSync(path.join(out, `${stamp}-R45-e2e-result-claude.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, failed: report.checks.filter(c => !c.ok).map(c => c.name), error: (report.error || report.teardownError || '').slice(0, 600) }));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
