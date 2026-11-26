'use strict';
// DSH 权限模式真实路径（2026-11-26）：隔离 Hub + 真实 DSH CLI（终端方式）+ 本机反代 + 模拟 API 网关。
// 模拟模型按提示里的标记调用 DSH 的 pwsh 工具写文件，看三档在 Windows 上是不是真的生效：
//   完全放开：工作目录内写文件直接成功，不问；
//   自动改文件（workspace-write）：工作目录内写成功不问；工作目录外被沙箱拦下；
//   每步确认（read-only）：直接写被沙箱拦下；模型申请一次性升权 → Hub 侧栏显示等待输入 → 终端里选「允许一次」后写成功。
// 启动中心全程用鼠标点：全新用户默认「每步确认」，第一次选「完全放开」要确认一次。
//   DSH_E2E_ENTRY=<dsh/lib/bin.js> node tests/e2e-permission-mode-dsh-cdp.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/permission-mode-dsh');
const KEY = 'sk-' + 'e2epermdsh'.repeat(3);
const MODELS = ['deepseek-v4.1-flash', 'glm-5.3-flash'];
const report = { ok: false, checks: [], requests: [], toolResults: {} };

const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n') : '';
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
function whichDir(name) {
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    for (const ext of ['.exe', '.cmd', '']) if (dir && fs.existsSync(path.join(dir, name + ext))) return dir;
  }
  return null;
}

// 每个标记的脚本：第 n 次工具调用做什么（null = 收尾回答）。
function plan(tag, step, outside) {
  const write = (file, extra = {}) => ({ command: `Set-Content -LiteralPath '${file}' -Value 'ok-${tag}'`, description: 'write probe file', ...extra });
  if (tag === 'FULL') return [write('probe-full.txt')][step] || null;
  if (tag === 'WS') return [write('probe-ws.txt'), write(outside)][step] || null;
  if (tag === 'RO') return [write('probe-ro.txt'), write('probe-ro.txt', { escalate: true })][step] || null;
  return null;
}

async function startGateway(outside) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    (report.urls ||= []).push(req.method + ' ' + req.url + ' ' + (req.headers.authorization || '').slice(0, 12));
    if (req.headers.authorization !== 'Bearer ' + KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Invalid token"}}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: MODELS.map(id => ({ id })) })); }
    if (req.url.startsWith('/api/usage/token')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":{"total_used":1,"unlimited_quota":true}}'); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const messages = body.messages || [];
    // DSH 会在用户原话后面再附上下文消息：按「最后一条带标记的用户消息」定位这一轮。
    const lastUser = messages.map(m => m.role === 'user' && /PROBE-(FULL|WS|RO)\b/.test(textOf(m.content))).lastIndexOf(true);
    const tag = lastUser >= 0 ? textOf(messages[lastUser].content).match(/PROBE-(FULL|WS|RO)\b/)[1] : null;
    (report.samples ||= []).push({ url: req.url, keys: Object.keys(body), msgs: messages.slice(-4).map(m => m.role + ':' + JSON.stringify(m.content).slice(0, 200)) });
    const results = messages.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => textOf(m.content));
    if (tag) { report.toolResults[tag] = results.map(r => r.slice(0, 300)); report.requests.push({ tag, step: results.length }); }
    const pwsh = (body.tools || []).find(t => t.function?.name === 'pwsh');
    const escalation = pwsh?.function?.parameters?.properties?.sandbox_permissions?.enum || [];
    if (tag && !report.pwshSchema && pwsh) report.pwshSchema = { escalation, props: Object.keys(pwsh.function.parameters?.properties || {}) };
    let call = tag && pwsh ? plan(tag, results.length, outside) : null;
    if (call?.escalate) {
      const { escalate, ...rest } = call;
      call = { ...rest, sandbox_permissions: escalation.find(v => /full|escalat/i.test(v)) || escalation.at(-1), justification: 'The user asked to write this probe file.' };
    }
    const chatId = 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    if (call) {
      send({ id: chatId, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + chatId.slice(-8), type: 'function', function: { name: 'pwsh', arguments: JSON.stringify(call) } }] } }] });
      send({ id: chatId, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
    } else {
      send({ id: chatId, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: tag ? `DONE-${tag}` : 'ok' } }] });
      send({ id: chatId, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  assert.equal(require('../core/distribution').target, 'company', '这个用例只在公司版仓库运行');
  const dshEntry = process.env.DSH_E2E_ENTRY;
  assert.ok(dshEntry && fs.existsSync(dshEntry), '需要 DSH_E2E_ENTRY');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-perm-dsh-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data'), claudeDir = path.join(root, 'claude');
  // 工作目录和「工作目录外」都放在临时目录之外：DSH 的工作区可写沙箱默认也放开临时目录（和 Codex 一样），放在 TEMP 下测不出拦截。
  // 放在用户目录下（Hub 默认工作根 ~/Workspaces 也在这里）：DSH 的 Windows 沙箱要给工作目录加 ACL 和低完整性标记，
  // 开发机实测 D:\AIWork 下设完整性标记被拒（Win32 5），用户目录下可以。用完删掉。
  const realRoot = fs.mkdtempSync(path.join(os.homedir(), 'hub-perm-e2e-'));
  const outside = path.join(realRoot, 'outside-ws.txt');
  fs.mkdirSync(path.join(realRoot, 'tmp'), { recursive: true });
  for (const dir of [home, data, claudeDir, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local'), path.join(home, '.continue'), path.join(data, 'api-gateway')]) fs.mkdirSync(dir, { recursive: true });
  const gw = await startGateway(outside);
  fs.writeFileSync(path.join(data, 'api-gateway', 'gateway.json'), JSON.stringify({ baseURL: gw.origin + '/v1' }));
  fs.writeFileSync(path.join(home, '.continue', 'config.json'), JSON.stringify({ models: [{ title: '部门网关', provider: 'openai', apiBase: gw.origin + '/v1', apiKey: KEY, model: MODELS[0] }] }));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ acp: { nodePath: process.execPath, providers: { 'deepseek-acp': { entryPath: dshEntry, model: MODELS[0] } } } }));
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    // 临时目录也放用户目录下（公司电脑默认如此）；这台机器 TEMP 在 D:\Temp，DSH 给它设权限同样被拒。
    TEMP: path.join(realRoot, 'tmp'), TMP: path.join(realRoot, 'tmp'),
    AI_HUB_WORKSPACE_ROOT: path.join(realRoot, 'workspaces'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: claudeDir,
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0',
    // 开发机常年 CPU 满载：DSH 冷启动可能超过默认 150 秒，测试放宽到 300 秒（与权限模式无关）。
    AI_HUB_DSH_START_TIMEOUT_MS: '300000',
    [pathKey]: [path.resolve(path.dirname(dshEntry), '..', '..', '..', '.bin'), whichDir('node'), system, path.join(system, 'WindowsPowerShell/v1.0')].filter(Boolean).join(';'),
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
    HUB_CODEX_API_KEY: '', HUB_CLAUDE_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };
  let hub, cdp;
  const check = (name, value, detail) => { report.checks.push({ name, ok: !!value, ...(detail === undefined ? {} : { detail }) }); if (!value) throw new Error('检查失败：' + name + ' ' + JSON.stringify(detail ?? '')); };
  const ev = expression => cdp.eval(expression);
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await ev(expression).catch(() => false)) return; await sleep(150); }
    throw new Error('Timeout: ' + label);
  }
  async function waitFor(predicate, label, timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (predicate()) return; await sleep(200); }
    throw new Error('Timeout: ' + label);
  }
  async function click(selector) {
    const point = await ev(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) {
    await sleep(300);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, `20261126-perm-dsh-${name}.png`), Buffer.from(image.data, 'base64'));
  }
  async function expandMore() {
    if (await ev('(()=>{const b=document.getElementById("new-session-more-toggle");return !!b&&!b.hidden&&b.getBoundingClientRect().width>0&&b.getAttribute("aria-expanded")!=="true"})()')) await click('#new-session-more-toggle');
  }
  async function openLauncher(kind) {
    if (await ev('document.querySelector("#new-session-cancel")?.getBoundingClientRect().width > 0')) { await click('#new-session-cancel'); await sleep(300); }
    await ev(`window.WorkspaceController?.openNewSessionModal?.({kind:${JSON.stringify(kind)}})`);
    await until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', 'launcher', 15000);
    const sel = `.new-session-option[data-kind="${kind === 'deepseek-acp' ? 'deepseek' : kind}"]`;
    for (let i = 0; i < 5; i++) {
      await click(sel).catch(() => {});
      if (await ev(`document.querySelector(${JSON.stringify(sel)})?.getAttribute('aria-pressed')==='true'`)) break;
      await sleep(400);
    }
    await sleep(600);
    await expandMore();
  }
  async function pickPermission(value) {
    await click('#new-session-permission');
    await until(`!!document.querySelector('.launch-select-option[data-value="${value}"]')`, 'permission dropdown open');
    await click(`.launch-select-option[data-value="${value}"]`);
  }
  let adopted = false;
  async function create(mode, { confirmBypass = false } = {}) {
    if (!adopted) {
      await openLauncher('deepseek-acp');
      await until('document.querySelector("#new-session-gw-setup .gw-inline-hit")?.innerText.includes("Continue")', 'gateway key detected', 25000);
      await click('#new-session-gw-setup [data-gwi=adopt]');
      await until('document.querySelectorAll("#new-session-model-cards .session-model-card[data-source=gateway]").length >= 2', 'gateway cards', 30000);
      adopted = true;
    }
    await openLauncher('deepseek-acp');
    await until('document.querySelectorAll("#new-session-model-cards .session-model-card[data-source=gateway]").length >= 1', 'gateway cards dsh', 20000);
    await until('!document.getElementById("new-session-permission-field").hidden', 'DSH 权限模式可见', 15000);
    if (await ev('document.getElementById("new-session-permission").value') !== mode) {
      await pickPermission(mode);
      if (confirmBypass) {
        await until('!!document.querySelector("dialog.hub-dialog[open], dialog[open] .hub-dialog-actions")', '完全放开确认框', 10000);
        await shot('02-bypass-confirm');
        report.bypassDialog = await ev('document.querySelector("dialog[open]")?.innerText || ""');
        await click('dialog[open] .hub-button-primary');
      }
      await until(`document.getElementById("new-session-permission").value===${JSON.stringify(mode)}`, 'mode picked ' + mode);
    }
    await sleep(300);
    await shot(`01-launch-${mode}`);
    const before = JSON.stringify(await ev('[...sessions.keys()]'));
    await click('#new-session-submit');
    await until(`[...sessions.values()].some(x=>!${before}.includes(x.id)) || !!document.getElementById('new-session-error')?.innerText.trim()`, 'session created', 60000);
    const error = await ev('document.getElementById("new-session-error")?.innerText.trim() || ""');
    assert.equal(error, '', error);
    return ev(`[...sessions.values()].find(x=>!${before}.includes(x.id)).id`);
  }
  const truth = id => `getSessionRuntimeTruth(sessions.get(${JSON.stringify(id)}),{now:Date.now()}).state`;
  const runtime = id => ev(`(()=>{const s=sessions.get(${JSON.stringify(id)});const r=s?.cliRuntime||s?.nativeRuntime;return s?{status:s.status,truth:${truth(id)},perm:s.permissionMode||null,cwd:s.cwd,state:r?.state||null,reason:r?.reason||null}:null})()`);
  const idle = id => until(`['idle','completed'].includes(${truth(id)})`, 'idle ' + id, 330000);
  const terminalText = id => ev(`(async()=>String(await ipcRenderer.invoke("get-ring-buffer",${JSON.stringify(id)})))()`);
  // DSH 终端刚就绪时偶尔吞掉第一条（hub.log「prompt not acknowledged」，与权限无关）：30 秒没到模型就再发一次，最多 3 次。
  async function send(id, text) {
    const tag = (text.match(/PROBE-(FULL|WS|RO)/) || [])[1];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sleep(2000);
      await sendOnce(id, text);
      const end = Date.now() + 30000;
      while (Date.now() < end && !report.requests.some(r => r.tag === tag)) await sleep(300);
      if (report.requests.some(r => r.tag === tag)) { (report.sendAttempts ||= {})[tag] = attempt; return; }
    }
    await click('#btn-backstage').catch(() => {});
    await sleep(4000);
    await shot('send-fail-' + tag);
    throw new Error('3 次都没把消息发到 DSH：' + text);
  }
  async function sendOnce(id, text) {
    await ev(`selectSession && selectSession(${JSON.stringify(id)})`).catch(() => {});
    await until(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'composer', 60000);
    await click('#terminal-panel .floating-input-box');
    await cdp.send('Input.insertText', { text });
    await sleep(200);
    await click('#terminal-panel .floating-input-send');
  }
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'perm-dsh', extraEnv: env });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined"', 'renderer ready', 60000);

    // 0. 全新用户：DSH 默认「每步确认」，五档里 plan / auto 灰掉
    await openLauncher('deepseek-acp');
    await until('!document.getElementById("new-session-permission-field").hidden', 'DSH 权限模式可见', 15000);
    const view = await ev('({ value: document.getElementById("new-session-permission").value, disabled: document.getElementById("new-session-permission").disabled, options: [...document.getElementById("new-session-permission").options].map(o => ({ v: o.value, t: o.textContent, off: o.disabled, why: o.title })) })');
    report.freshView = view;
    check('全新用户 DSH 默认每步确认', view.value === 'default', view);
    check('DSH 可选（不再灰掉整个下拉）', view.disabled === false, view);
    check('DSH 灰掉「只讨论不改」「自动判断」并写原因', view.options.filter(o => o.off).map(o => o.v).join() === 'plan,auto' && view.options.filter(o => o.off).every(o => o.why.length > 6), view.options);
    await click('#new-session-permission');
    await until('!!document.querySelector(".launch-select-option[data-value=plan]")', 'dropdown open');
    await shot('00-dsh-dropdown');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

    // 1. 每步确认（read-only）
    const ro = await create('default');
    await idle(ro);
    check('每步确认：会话记下 permissionMode=default', (await runtime(ro)).perm === 'default', await runtime(ro));
    const roCwd = (await runtime(ro)).cwd;
    await send(ro, '请执行 PROBE-RO');
    await until(`${truth(ro)}==='waiting'`, '升权申请时 Hub 显示等待输入', 120000);
    report.roWaiting = await runtime(ro);
    report.roFirstWriteBlocked = !fs.existsSync(path.join(roCwd, 'probe-ro.txt'));
    // 只读档下 PowerShell 跑在受限语言模式（DSH 文档写明），报错文字随系统编码，判据看文件确实没写出来。
    check('每步确认：直接写文件被只读沙箱拦下（文件没写出来）', report.roFirstWriteBlocked, report.toolResults.RO);
    report.roTerminal = (await terminalText(ro)).slice(-3000);
    await shot('03-ro-waiting-sidebar');
    await click('#btn-backstage').catch(() => {});
    await sleep(1500);
    await shot('04-ro-approval-terminal');
    await ev(`ipcRenderer.send('terminal-input', { sessionId: ${JSON.stringify(ro)}, data: '\\r' })`);
    await waitFor(() => fs.existsSync(path.join(roCwd, 'probe-ro.txt')), '允许一次后写成功', 60000);
    check('每步确认：在终端选「允许一次」后写成功', true);
    await idle(ro);
    await click('#btn-backstage').catch(() => {});

    // 2. 自动改文件（workspace-write）
    const ws = await create('acceptEdits');
    await idle(ws);
    const wsCwd = (await runtime(ws)).cwd;
    await send(ws, '请执行 PROBE-WS');
    await waitFor(() => (report.requests.filter(r => r.tag === 'WS').map(r => r.step).includes(2)), 'WS 两步工具都跑完', 120000);
    check('自动改文件：工作目录内写文件直接成功', fs.existsSync(path.join(wsCwd, 'probe-ws.txt')), wsCwd);
    report.wsOutsideWritten = fs.existsSync(outside);
    check('自动改文件：工作目录外被沙箱拦下', !report.wsOutsideWritten, report.toolResults.WS);
    await idle(ws);
    await shot('05-ws-done');

    // 3. 完全放开（第一次要确认）
    const full = await create('bypassPermissions', { confirmBypass: true });
    check('完全放开确认框写清风险', /不再问你/.test(report.bypassDialog || ''), report.bypassDialog);
    await idle(full);
    const fullCwd = (await runtime(full)).cwd;
    await send(full, '请执行 PROBE-FULL');
    await waitFor(() => fs.existsSync(path.join(fullCwd, 'probe-full.txt')), '完全放开写成功', 120000);
    check('完全放开：直接写成功、不问', true);
    await idle(full);
    check('完全放开：确认记住了（localStorage）', await ev('localStorage.getItem("hub.launch.permissionBypassAck.v1")') === '1');
    await shot('06-full-done');

    // 4. 第二次选完全放开不再弹确认；本次覆盖不改默认
    await openLauncher('deepseek-acp');
    check('本次覆盖不改默认：重开仍是每步确认', await ev('document.getElementById("new-session-permission").value') === 'default');
    await pickPermission('bypassPermissions');
    await sleep(800);
    check('第二次选完全放开不再弹确认', await ev('!document.querySelector("dialog[open]")'));
    check('本次覆盖时出现「设为默认」', await ev('!document.getElementById("new-session-permission-setdefault").hidden'));
    await shot('07-override-setdefault');
    report.ok = true;
  } catch (error) {
    report.error = error.stack;
    if (cdp) {
      await shot('failure').catch(() => {});
      fs.writeFileSync(path.join(out, 'failure-dom.txt'), String(await ev('document.body.innerText').catch(() => '')));
      const ids = await ev('[...sessions.keys()]').catch(() => []);
      for (const id of ids) fs.writeFileSync(path.join(out, `failure-terminal-${id.slice(0, 8)}.txt`), String(await terminalText(id).catch(e => e.message)));
    }
    process.exitCode = 1;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) { report.teardown = await gracefulQuit(hub).catch(e => e.message); fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); }
    gw.server.close();
    report.realRoot = realRoot;
    try { fs.rmSync(realRoot, { recursive: true, force: true }); } catch (error) { report.cleanupError = error.message; }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.map(c => (c.ok ? 'PASS ' : 'FAIL ') + c.name), error: report.error?.split('\n')[0] }, null, 2));
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
