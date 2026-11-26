'use strict';
// R49（2026-11-26）只配了部门 key、没有 CodeAgent 权限、没有 Claude 官方订阅的全新用户，按真实操作走一遍：
//   设置 → 自有 API → Claude Code → API 网关：粘贴部门 key 保存 →
//   新建会话 → Claude Code：模型卡和模型下拉只列网关上的模型（没有 Opus / Sonnet 这类官方模型，也没有用不了的公司模型）→
//   选一个网关模型建会话 → 发一句话收到回复（模拟网关像 Qwen 模板一样：system 不在第一条就回 400）→
//   会话里点模型名打开切换菜单：只列网关模型 →「设为默认」能把网关模型设成 Claude 的默认模型。
// 隔离 Hub（隐藏窗口、独立数据目录与 home）；模拟网关在本进程里；真实 Claude Code CLI。不用任何计费 key。
//   node tests/e2e-r49-gateway-claude-models-cdp.js   （产物：HUB_E2E_ARTIFACT_DIR 或 artifacts/r49-gateway-claude-models）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/r49-gateway-claude-models');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const KEY = 'sk-' + 'e2er49gw'.repeat(4);
const MODELS = ['qwen-aw-35b', 'deepseek-v4.1-flash', 'glm-5.3-flash'];
const PICK = 'qwen-aw-35b';
const MARKER = 'R49_GW_9K3';
const OFFICIAL = /\b(?:Opus|Sonnet|Haiku|Fable)\b|claude-(?:opus|sonnet|haiku|fable)/;
const report = { ok: false, checks: [], screenshots: [], gateway: { chats: 0, rejected: 0, roles: [], models: [] } };

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

// 模拟网关：和 Qwen 系列的对话模板一样，system 不在第一条就报「System message must be at the beginning.」。
async function startGateway() {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.headers.authorization !== 'Bearer ' + KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Invalid token","type":"new_api_error"}}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: MODELS.map(id => ({ id })) })); }
    if (req.url.startsWith('/api/usage/token')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":{"total_used":1,"unlimited_quota":true}}'); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const roles = (body.messages || []).map(m => m.role);
    report.gateway.chats++; report.gateway.models.push(body.model); report.gateway.roles.push(roles.join(','));
    if (roles.some((role, i) => role === 'system' && i > 0)) {
      report.gateway.rejected++;
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"System message must be at the beginning.","type":"BadRequestError","code":400}}');
    }
    const lastUser = [...(body.messages || [])].reverse().find(m => m.role === 'user');
    const reply = new RegExp(MARKER).test(textOf(lastUser?.content)) ? `R49_GATEWAY_OK: ${MARKER}` : 'ok';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    for (const piece of reply.match(/.{1,6}/g)) { send({ id: 'c', model: 'qw35', choices: [{ index: 0, delta: { content: piece } }] }); await sleep(20); }
    send({ id: 'c', model: 'qw35', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ id: 'c', model: 'qw35', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r49-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data'), claudeDir = path.join(root, 'claude');
  for (const dir of [home, data, claudeDir, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
  // Claude Code 首次引导已走过（与其他 E2E 一致）；没有任何登录、没有官方订阅。
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', bypassPermissionsModeAccepted: true, numStartups: 5 }));
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
  const check = (name, value, soft = process.env.R49_SOFT === '1') => { report.checks.push({ name, ok: !!value, ...(soft ? { soft: true } : {}) }); if (!soft) assert.ok(value, name); };
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await cdp.eval(expression).catch(() => false)) return; await sleep(150); }
    throw new Error('Timeout: ' + label);
  }
  async function click(selector) {
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
    const file = path.join(out, `${stamp}-R49-${name}-claude.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64')); report.screenshots.push(file);
  }
  const statusText = 'document.querySelector("#company-api-dialog form [role=status]")?.textContent || ""';
  // 启动中心里用户看得见的模型：模型卡 + 可见的模型下拉选项。
  const visibleModels = `JSON.stringify({
    cards: [...document.querySelectorAll('#new-session-model-cards .session-model-card')].filter(c => c.offsetParent).map(c => c.innerText.replace(/\\s+/g, ' ').trim()),
    selects: [...document.querySelectorAll('#new-session-menu select')].filter(s => s.offsetParent).map(s => ({ id: s.id, options: [...s.options].map(o => o.textContent.trim()) })),
  })`;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'r49-gateway-claude', windowMode: 'hidden', extraEnv: env });
    for (const end = Date.now() + 90000; !cdp;) {
      try { cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url)); }
      catch (error) { if (Date.now() > end) throw error; await sleep(1000); }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!document.getElementById("btn-new") && typeof window.__companyApiOpen === "function"', 'main page', 40000);

    // 1) 设置 → 自有 API → Claude Code → API 网关：粘贴部门 key 保存（地址填模拟网关；真实用户是预填的公司网关）。
    await cdp.eval('document.getElementById("company-api-settings-open") ? document.getElementById("company-api-settings-open").click() : window.__companyApiOpen("claude")');
    await until('!!document.querySelector("#company-api-dialog [data-api-kind=claude]")', 'api dialog', 20000);
    await click('#company-api-dialog [data-api-kind=claude]');
    await click('#company-api-dialog [data-api-mode=gateway]');
    await until('!!document.querySelector("#company-api-dialog form[data-gateway-form]")', 'gateway form', 10000);
    await fill('#company-api-dialog [data-gateway-form] [name=baseURL]', gw.origin + '/v1');
    await fill('#company-api-dialog [data-gateway-form] [name=apiKey]', KEY);
    await click('#company-api-dialog form[data-gateway-form] [type=submit]');
    await until(`!!(${statusText})`, 'gateway save started', 3000).catch(() => click('#company-api-dialog form[data-gateway-form] [type=submit]'));
    await until(`/体检完成|已保存|正在体检/.test(${statusText})`, 'gateway saved', 40000);
    await until(`/体检完成/.test(${statusText})`, 'health done', 120000).catch(() => {});
    await shot('01-settings-gateway-saved');
    await cdp.eval('document.querySelector("#company-api-dialog [data-api-action=close]")?.click(); document.querySelector("#company-api-dialog")?.close?.()');
    await sleep(500);

    // 2) 新建会话 → Claude Code：只看到网关上的模型。
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center', 20000);
    await until(`document.querySelector('.new-session-option[data-kind="claude"]')?.dataset.installed === '1'`, 'claude detected', 30000);
    await click('.new-session-option[data-kind="claude"]');
    await until(`document.querySelectorAll('#new-session-model-cards .session-model-card[data-source=gateway]').length === ${MODELS.length}`, 'gateway cards', 30000);
    await sleep(800);
    report.launch = JSON.parse(await cdp.eval(visibleModels));
    await shot('02-launch-claude-cards');
    const launchText = [...report.launch.cards, ...report.launch.selects.flatMap(s => s.options)].join(' | ');
    check('启动中心：网关的 3 个模型都在', MODELS.every(id => launchText.includes(id)));
    check('启动中心：没有官方模型（没有官方订阅）', !OFFICIAL.test(launchText));
    check('启动中心：没有用不了的公司模型卡（没有 CodeAgent）', !/GLM-5\.2-WX|deepseek-v4\.1-flash-1017/.test(launchText));

    // 3) 选一个网关模型 → 设为默认 → 建会话。
    await click(`#new-session-model-cards [data-model-card="gw:${PICK}"]`);
    await until(`document.querySelector('#new-session-model-cards [data-model-card="gw:${PICK}"]')?.getAttribute('aria-checked') === 'true'`, 'card picked', 5000);
    const defaultBtn = await cdp.eval('(() => { const b = document.getElementById("new-session-model-default"); return b && !b.hidden && b.offsetParent ? { text: b.textContent.trim(), disabled: b.disabled } : null; })()');
    report.defaultButton = defaultBtn;
    check('选了非默认的网关模型：「设为默认」可点', !!defaultBtn && !defaultBtn.disabled);
    await click('#new-session-model-default');
    const doneText = '/默认 ✓|整组默认 ✓/.test(document.getElementById("new-session-model-default")?.textContent || "")';
    await until(doneText, 'default saved', 10000);
    check('点「设为默认」后按钮变成「默认 ✓」', await cdp.eval(doneText));
    const cfg = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')); } catch { return {}; } };
    report.savedDefault = cfg().models?.defaults?.claude || cfg().launch?.defaults?.claude?.model || null;
    check('「设为默认」把网关模型存成 Claude 的默认模型', report.savedDefault === PICK);
    check('「设为默认」不改线路配置（线路在新建会话时才保存）', cfg().providers?.claude?.model !== PICK);
    await shot('03-launch-default-set');
    // 不建会话、关掉启动中心再打开：默认选中的是刚设的默认模型，按钮仍是「默认 ✓」（R49 审查 P1-2）。
    await cdp.eval('document.getElementById("new-session-cancel")?.click()');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', 'launch center closed', 10000);
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center reopened', 20000);
    await click('.new-session-option[data-kind="claude"]');
    const reopened = `document.querySelector('#new-session-model-cards [data-model-card="gw:${PICK}"]')?.getAttribute('aria-checked') === 'true'`;
    await until(reopened, 'default card preselected', 30000);
    await until(doneText, 'default button after reopen', 10000);
    check('重开启动中心：默认选中刚设的默认模型，按钮是「默认 ✓」', await cdp.eval(reopened) && await cdp.eval(doneText));
    await shot('03b-launch-reopened-default');
    await click('#new-session-submit');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', 'session created', 60000);
    await until(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'composer visible', 60000);
    await sleep(6000);
    await click('#terminal-panel .floating-input-box');
    await cdp.send('Input.insertText', { text: `请原样回复这个标记：${MARKER}` });
    await click('#terminal-panel .floating-input-send');
    await until(`document.body.innerText.includes(${JSON.stringify('R49_GATEWAY_OK: ' + MARKER)})`, 'answer', 120000).catch(() => {});
    await shot('04-answer');
    check('回答经网关回来', await cdp.eval(`document.body.innerText.includes(${JSON.stringify('R49_GATEWAY_OK: ' + MARKER)})`));
    check('网关收到的模型是用户选的', report.gateway.models.includes(PICK));
    check('网关收到的 system 都在第一条（没有被 400 拒绝）', report.gateway.rejected === 0 && report.gateway.chats > 0);

    // 4) 会话里切换模型：点底栏模型名，菜单只列网关模型。
    const chip = await cdp.eval('(() => { const c = [...document.querySelectorAll("#terminal-panel .clickable")].find(e => e.offsetParent && /qwen|deepseek|glm/i.test(e.textContent)); if (!c) return ""; c.setAttribute("data-r49-chip", "1"); return c.textContent.trim(); })()');
    report.chip = chip;
    if (chip) {
      await click('[data-r49-chip="1"]');
      await until('!!document.querySelector(".model-picker-menu .model-picker-item")', 'picker items', 15000).catch(() => {});
      await sleep(800);
      report.picker = await cdp.eval('[...document.querySelectorAll(".model-picker-menu .model-picker-item")].map(i => i.textContent.replace(/\\s+/g, " ").trim())');
      await shot('05-session-model-picker');
      const pickerText = (report.picker || []).join(' | ');
      check('会话内切换：网关模型都在', MODELS.every(id => pickerText.includes(id)));
      check('会话内切换：没有官方模型、没有公司模型', !OFFICIAL.test(pickerText) && !/GLM-5\.2-WX|deepseek-v4\.1-flash-1017/.test(pickerText));
    } else check('会话底栏能找到模型名', false);
    report.uiChecksPassed = true;
  } catch (error) {
    report.error = error.stack;
    if (error.logTail) report.logTail = error.logTail;
    if (cdp) await shot('failure').catch(() => {});
    throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      try { report.exit = await gracefulQuit(hub); } catch (error) { report.teardownError = error.stack; process.exitCode = 1; }
      finally { hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); }
    }
    gw.server.close();
    report.ok = !!report.uiChecksPassed && report.checks.every(c => c.ok || c.soft);
    fs.writeFileSync(path.join(out, `${stamp}-R49-report-claude.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, launch: report.launch, picker: report.picker, defaultButton: report.defaultButton, savedDefault: report.savedDefault, gateway: report.gateway, error: report.error?.split('\n')[0] }, null, 1));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
