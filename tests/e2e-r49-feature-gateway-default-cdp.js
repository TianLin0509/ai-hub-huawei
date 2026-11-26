'use strict';
// R49-2（2026-11-26）只配了部门 key、没装 CodeAgent 的全新用户：后台功能没选过时默认走部门 key。真实操作路径：
//   设置 → 自有 API → Claude Code → API 网关：粘贴部门 key 保存 →
//   设置 →「功能使用的 Agent」：日常功能 5 项会话功能、PPT 页 4 项都写「默认：部门 API key（未检测到 CodeAgent）」，页面一屏不滚动 →
//   打开「论坛热帖汇总」的整理会话（论坛页同一个入口 company-forum:open-session）→ 会话是 Claude Code 经部门 key →
//   往这个会话发一句话 → 模拟网关收到、回答回来。
// 隔离 Hub（隐藏窗口、独立数据目录与 home）；模拟网关在本进程里；真实 Claude Code CLI。不用任何计费 key。
//   node tests/e2e-r49-feature-gateway-default-cdp.js   （产物：HUB_E2E_ARTIFACT_DIR 或 artifacts/r49-feature-gateway-default）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/r49-feature-gateway-default');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const KEY = 'sk-' + 'e2er49fa'.repeat(4);
const MODELS = ['deepseek-v4.1-flash', 'qwen-aw-35b'];
const MARKER = 'R49_FORUM_GW_4T8';
const NOTE = '默认：部门 API key（未检测到 CodeAgent）';
const report = { ok: false, checks: [], screenshots: [], gateway: { chats: 0, rejected: 0, models: [], marker: false } };

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
    if (req.headers.authorization !== 'Bearer ' + KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Invalid token","type":"new_api_error"}}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: MODELS.map(id => ({ id })) })); }
    if (req.url.startsWith('/api/usage/token')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":{"total_used":1,"unlimited_quota":true}}'); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const roles = (body.messages || []).map(m => m.role);
    report.gateway.chats++; report.gateway.models.push(body.model);
    if (roles.some((role, i) => role === 'system' && i > 0)) {
      report.gateway.rejected++;
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"System message must be at the beginning.","type":"BadRequestError","code":400}}');
    }
    const asked = (body.messages || []).some(m => m.role === 'user' && new RegExp(MARKER).test(textOf(m.content)));
    if (asked) report.gateway.marker = true;
    const reply = asked ? `R49_FORUM_OK: ${MARKER}` : 'ok';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    for (const piece of reply.match(/.{1,6}/g)) { send({ id: 'c', model: 'dsv41', choices: [{ index: 0, delta: { content: piece } }] }); await sleep(20); }
    send({ id: 'c', model: 'dsv41', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ id: 'c', model: 'dsv41', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r49fa-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data'), claudeDir = path.join(root, 'claude');
  for (const dir of [home, data, claudeDir, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
  // 论坛的整理目录平时在第一次同步论坛时建；这里不登录论坛、不同步，只验「整理会话按默认走哪条线」，所以先建好空目录。
  fs.mkdirSync(path.join(data, 'company-forum', 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', bypassPermissionsModeAccepted: true, numStartups: 5 }));
  const gw = await startGateway();
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const cliDirs = ['claude', 'node'].map(whichDir);
  assert.ok(cliDirs.every(Boolean), 'claude and node must be installed');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  // PATH 里只有 claude 和 node：本机没有 CodeAgent。
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: claudeDir,
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0',
    [pathKey]: [...new Set(cliDirs), system, path.join(system, 'WindowsPowerShell/v1.0')].join(';'),
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
    HUB_CODEX_API_KEY: '', HUB_CLAUDE_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };
  let hub, cdp;
  const check = (name, value) => { report.checks.push({ name, ok: !!value }); assert.ok(value, name); };
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
    const file = path.join(out, `${stamp}-R49-2-${name}-claude.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64')); report.screenshots.push(file);
  }
  const statusText = 'document.querySelector("#company-api-dialog form [role=status]")?.textContent || ""';
  const notesOnPage = `(() => { const rows = [...document.querySelectorAll('#cfg-feature-agents [data-fa-row]')];
    const p = document.querySelector('#config-main-view');
    return JSON.stringify({ rows: rows.map(r => r.dataset.faRow), auto: rows.filter(r => r.querySelector('[data-fa-auto]')?.textContent === ${JSON.stringify(NOTE)}).map(r => r.dataset.faRow),
      backends: rows.map(r => r.querySelector('[data-fa-backend]')?.selectedOptions?.[0]?.textContent || ''), h: p?.clientHeight || 0, sh: p?.scrollHeight || 0 }); })()`;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'r49-feature-gateway', windowMode: 'hidden', extraEnv: env });
    for (const end = Date.now() + 90000; !cdp;) {
      try { cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url)); }
      catch (error) { if (Date.now() > end) throw error; await sleep(1000); }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!document.getElementById("btn-new") && typeof window.__companyApiOpen === "function" && typeof window.__hubOpenConfigModal === "function" && !!window.__featureAgents', 'main page', 60000);

    // 1) 设置 → 自有 API → Claude Code → API 网关：粘贴部门 key 保存。
    await cdp.eval('window.__companyApiOpen("claude")');
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
    await cdp.eval('document.querySelector("#company-api-dialog [data-api-action=close]")?.click(); document.querySelector("#company-api-dialog")?.close?.()');
    await sleep(500);

    // 2) 设置 →「功能使用的 Agent」：日常功能页。
    await cdp.eval('window.__hubOpenConfigModal()');
    await until('!!document.querySelector("#cfg-tab-agents")', 'config modal', 10000);
    await click('#cfg-tab-agents');
    await cdp.eval('window.__featureAgents.refresh()');
    await until(`document.querySelectorAll('#cfg-feature-agents [data-fa-auto]').length >= 5`, 'auto notes (common)', 30000);
    report.common = JSON.parse(await cdp.eval(notesOnPage));
    await shot('01-settings-common');
    check('日常功能：助理、分身、论坛、会议、草稿整理都写「默认：部门 API key（未检测到 CodeAgent）」',
      ['assistant', 'avatar', 'forum', 'meeting', 'text'].every(id => report.common.auto.includes(id)));
    check('日常功能：问问 Hub、进展卡摘要不在这次范围，不标', !report.common.auto.includes('help') && !report.common.auto.includes('progress'));
    check('日常功能页一屏不滚动', report.common.sh <= report.common.h + 2);
    // PPT 页
    await click('#cfg-feature-agents [data-fa-group=ppt]');
    await until(`document.querySelectorAll('#cfg-feature-agents [data-fa-row]').length === 4`, 'ppt tab', 10000);
    report.ppt = JSON.parse(await cdp.eval(notesOnPage));
    await shot('02-settings-ppt');
    check('PPT 页：找页、做页、图转字、库地图都默认部门 key', ['ppt', 'pptMake', 'pptImgtext', 'pptMap'].every(id => report.ppt.auto.includes(id)));
    check('PPT 页一屏不滚动', report.ppt.sh <= report.ppt.h + 2);
    await cdp.eval(`document.getElementById('config-modal')?.classList.add('hidden')`);

    // 3) 论坛热帖汇总的整理会话：按默认（没选过）打开 → Claude Code 经部门 key → 发一句话收到回答。
    const opened = await cdp.eval(`require('electron').ipcRenderer.invoke('company-forum:open-session').then(r => JSON.stringify(r))`, { awaitPromise: true });
    report.forum = JSON.parse(opened);
    check('论坛整理会话打开成功', report.forum?.ok === true && !!report.forum.sessionId);
    const sid = report.forum.sessionId;
    await sleep(8000);
    const sent = await cdp.eval(`require('electron').ipcRenderer.invoke('session:send-prompt', { sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify('请原样回复这个标记：' + MARKER)}, clientSubmissionId: 'r49-forum-1', waitForCliReady: true }).then(r => JSON.stringify({ ok: r?.ok, error: r?.error || r?.message || '' }))`, { awaitPromise: true });
    report.sent = JSON.parse(sent);
    for (let i = 0; i < 400 && !report.gateway.marker; i++) await sleep(300);
    await sleep(3000);
    check('论坛整理会话的提问发到了部门网关（不是 CodeAgent）', report.gateway.marker);
    check('网关收到的是网关默认模型', report.gateway.models.includes(MODELS[0]));
    check('没有被网关 400 拒绝', report.gateway.rejected === 0);
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
    report.ok = !!report.uiChecksPassed && report.checks.every(c => c.ok);
    fs.writeFileSync(path.join(out, `${stamp}-R49-2-report-claude.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, common: report.common, ppt: report.ppt, forum: report.forum, sent: report.sent, gateway: report.gateway, error: report.error?.split('\n')[0] }, null, 1));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
