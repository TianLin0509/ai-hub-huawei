'use strict';
// 启动中心「权限模式」端到端（2026-11-20，11-26 改为「设为默认 + 本次覆盖」、新用户默认每步确认）：
// 全新数据目录、隔离 Hub、无头 CDP、替身 Claude / Codex / CodeAgent CLI（tests/fixtures/）。
//   1. 全新用户打开启动中心 → Claude 默认「每步确认」，五档全列、auto 灰掉；1440 宽下启动中心不出纵向滚动；
//   2. 选「完全放开」先弹一次风险确认 → 点「设为默认」→ 再把这次改成「每步确认」（本次覆盖）建会话
//      → CLI 收到 --permission-mode default → 跑工具时停在确认框，Hub 显示等待输入；在终端里回 1 继续；
//   3. 重开启动中心显示默认「完全放开」（本次覆盖没落盘）→「恢复默认」回到每步确认；
//   4. 休眠后从侧栏点开恢复、以及整个 Hub 重启后恢复，CLI 仍按 default 启动；
//   5. Codex 默认每步确认建会话；CodeAgent 启动中心可选「只讨论不改」（开发机上没有真 CodeAgent，启动参数由单测核对）。
// 不连任何 AI 服务。用法：node tests/e2e-permission-mode-cdp.js（截图与报告写到 HUB_E2E_ARTIFACT_DIR 或 artifacts/permission-mode-gui）
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/permission-mode-gui');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub perm mode '));
  const home = path.join(root, 'home dir');
  const data = path.join(root, 'data');
  const fakeBin = path.join(home, 'fake-bin');
  for (const dir of [home, data, out, fakeBin, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.resolve('tests/fixtures/fake-claude.ps1'), path.join(fakeBin, 'fake-claude.ps1'));
  fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fake-claude.ps1" %*\r\n');
  // 替身 Codex（tests/fixtures/fake-codex.ps1）：只记下 Hub 传的启动参数，看权限模式有没有到 CLI。
  fs.copyFileSync(path.resolve('tests/fixtures/fake-codex.ps1'), path.join(fakeBin, 'fake-codex.ps1'));
  fs.writeFileSync(path.join(fakeBin, 'codex.cmd'), '@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fake-codex.ps1" %*\r\n');
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = {
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
    [pathKey]: [fakeBin, system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
  };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) env[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const trace = path.join(home, 'fake-claude-trace.log');
  const traceText = () => { try { return fs.readFileSync(trace, 'utf8'); } catch { return ''; } };
  const modeLines = () => traceText().split(/\r?\n/).filter(line => line.startsWith('permission-mode:'));
  const report = { checks: [], root, providerNetworkTested: false };
  let hub;
  let cdp;
  const until = async (expression, label, timeout = 40000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { try { if (await cdp.eval(expression)) return; } catch {} await sleep(200); }
    throw new Error('Timeout: ' + label);
  };
  const waitFor = async (predicate, label, timeout = 40000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (predicate()) return; await sleep(200); }
    throw new Error('Timeout: ' + label);
  };
  async function click(selector) {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
  }
  async function launch(label) {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label, extraEnv: env });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
  async function quit() {
    if (cdp) await cdp.close().catch(() => {});
    cdp = null;
    if (hub) { report.teardown = await gracefulQuit(hub); fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); }
    hub = null;
  }
  const permSeg = value => `.lcc-seg[data-for="new-session-permission"] [data-lcc-value="${value}"]`;
  const selected = 'document.getElementById("new-session-permission").value';
  async function pickPermission(value) {
    await expandMore();
    await until('document.getElementById("new-session-permission")?.getBoundingClientRect().width > 0', 'permission select visible', 15000);
    if (await cdp.eval(`!!document.querySelector(${JSON.stringify(permSeg(value))})?.getBoundingClientRect().width`)) { await click(permSeg(value)); return 'segment'; }
    await click('#new-session-permission');
    await until(`!!document.querySelector('.launch-select-option[data-value="${value}"]')`, 'permission dropdown open');
    await click(`.launch-select-option[data-value="${value}"]`);
    return 'dropdown';
  }
  // 2026-11-21 起账号、MCP、权限模式等次要项默认收在「更多选项」里（renderer/launch-more-options.js），先用鼠标点开。
  async function expandMore() {
    if (await cdp.eval('(()=>{const b=document.getElementById("new-session-more-toggle");return !!b&&!b.hidden&&b.getBoundingClientRect().width>0&&b.getAttribute("aria-expanded")!=="true"})()')) await click('#new-session-more-toggle');
  }
  async function openLauncher() {
    if (!(await cdp.eval('document.getElementById("home-create-session")?.getBoundingClientRect().width > 0'))) await click('#btn-home');
    await until('document.getElementById("home-create-session")?.getBoundingClientRect().width > 0', 'home visible');
    await click('#home-create-session');
    await until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', 'launch center open');
    await click('.new-session-option[data-kind="claude"]');
    await until('!document.getElementById("new-session-permission-field").hidden', 'permission field shown for Claude');
    await expandMore();
  }
  try {
    await launch('perm-mode');
    await until('[...document.querySelectorAll(".community-provider")].some(e => e.dataset.provider === "claude" && e.dataset.installed === "1") ', 'Claude detected');

    // 1. 全新用户：默认每步确认（不默认完全放开）；五档全列、auto 灰掉；1440 宽不出纵向滚动
    await openLauncher();
    assert.equal(await cdp.eval(selected), 'default', '新用户默认每步确认');
    const options = await cdp.eval('[...document.getElementById("new-session-permission").options].map(o => o.value + (o.disabled ? "-" : ""))');
    assert.deepEqual(options, ['default', 'acceptEdits', 'plan', 'auto-', 'bypassPermissions'], 'Claude 4 档可选，auto 灰掉');
    assert.match(await cdp.eval('document.getElementById("new-session-permission").options[0].textContent'), /每步确认（默认）/);
    assert.equal(await cdp.eval('document.getElementById("new-session-permission-reset").hidden'), true);
    assert.equal(await cdp.eval('document.getElementById("new-session-permission-setdefault").hidden'), true);
    report.permissionBlockHeight = await cdp.eval(`(()=>{const f=document.getElementById('new-session-permission-field').getBoundingClientRect(),n=document.getElementById('new-session-permission-note').getBoundingClientRect();return Math.round(Math.max(f.bottom,n.bottom)-f.top);})()`);
    const scrollers = await cdp.eval(`(()=>{const m=document.getElementById('new-session-menu');return [m,...m.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e);return /(auto|scroll)/.test(s.overflowY)&&e.scrollHeight>e.clientHeight+2&&e.getBoundingClientRect().height>0;}).map(e=>(e.id||e.className)+':'+e.scrollHeight+'/'+e.clientHeight);})()`);
    report.launchCenterScrollers = scrollers;
    await shot('01-launch-fresh-default');
    report.checks.push(`全新用户：Claude 默认「每步确认」、4 档可选、auto 灰掉；1440×900 下有纵向滚动的区域：${scrollers.length ? scrollers.join(', ') : '无'}`);

    // CodeAgent / Codex / DSH 的显示（本机没装也能看界面）
    const kinds = await cdp.eval('[...document.querySelectorAll(".new-session-option[data-kind]")].filter(b => b.getBoundingClientRect().width > 0).map(b => b.dataset.kind)');
    for (const kind of ['codeagent', 'codex', 'pi']) {
      if (!kinds.includes(kind)) continue;
      await click(`.new-session-option[data-kind="${kind}"]`);
      await sleep(400);
      const view = await cdp.eval('({ hidden: document.getElementById("new-session-permission-field").hidden, value: document.getElementById("new-session-permission").value, options: [...document.getElementById("new-session-permission").options].map(o => o.value + (o.disabled ? "-" : "") + "=" + o.textContent), disabled: document.getElementById("new-session-permission").disabled, desc: document.getElementById("new-session-permission-desc").textContent, sectionHidden: document.getElementById("new-session-config-section").hidden })');
      report[`view_${kind}`] = view;
      if (!view.sectionHidden) await shot(`01-launch-${kind}`);
      if (kind === 'codeagent' && !view.sectionHidden) { assert.ok(view.options.some(o => o.startsWith('auto=自动判断')), 'CodeAgent 有自动判断'); assert.equal(view.value, 'default'); }
      if (kind === 'codex' && !view.sectionHidden) { assert.equal(view.disabled, false); assert.deepEqual(view.options.map(o => o.split('=')[0]), ['default', 'acceptEdits-', 'plan-', 'auto-', 'bypassPermissions']); assert.equal(view.value, 'default'); }
      if (kind === 'pi' && !view.sectionHidden) { assert.equal(view.disabled, true); assert.equal(view.value, 'bypassPermissions'); }
    }
    report.checks.push('CodeAgent 五档含「自动判断」、默认每步确认；Codex 可选每步确认 / 完全放开、其余灰掉；pi 只能完全放开并灰显（配置区可见时）');
    await click('.new-session-option[data-kind="claude"]');
    await until('!document.getElementById("new-session-permission-field").hidden', 'back to Claude');

    // 2. 选「完全放开」：第一次弹风险确认；先点取消不变，再选并确认；点「设为默认」；再把这次改回「每步确认」（本次覆盖）
    report.pickedWith = await pickPermission('bypassPermissions');
    await until('!!document.querySelector("dialog[open] .hub-button-primary")', 'bypass confirm dialog');
    report.bypassDialog = await cdp.eval('document.querySelector("dialog[open]").innerText');
    assert.match(report.bypassDialog, /不再问你/);
    await shot('02a-bypass-confirm');
    await click('dialog[open] .hub-dialog-actions .hub-button:not(.hub-button-primary)');
    await until(`${selected} === "default"`, 'cancel keeps default');
    await pickPermission('bypassPermissions');
    await until('!!document.querySelector("dialog[open] .hub-button-primary")', 'bypass confirm dialog again');
    await click('dialog[open] .hub-button-primary');
    await until(`${selected} === "bypassPermissions"`, 'bypass picked');
    assert.equal(await cdp.eval('localStorage.getItem("hub.launch.permissionBypassAck.v1")'), '1');
    assert.equal(await cdp.eval('document.getElementById("new-session-permission-setdefault").hidden'), false, '本次覆盖时出现「设为默认」');
    await shot('02b-override-bypass');
    await click('#new-session-permission-setdefault');
    await until('document.getElementById("new-session-permission-setdefault").hidden', 'set as default');
    assert.equal(await cdp.eval('JSON.parse(localStorage.getItem("hub.launch.lastPermissionMode.v1")).claude'), 'bypassPermissions');
    assert.equal(await cdp.eval('document.getElementById("new-session-permission-reset").hidden'), false, '设过默认后可恢复默认');
    await pickPermission('default');
    await until(`${selected} === "default"`, 'default picked as override');
    assert.equal(await cdp.eval('!!document.querySelector("dialog[open]")'), false, '改保守档不弹确认');
    assert.match(await cdp.eval('document.getElementById("new-session-permission-desc").textContent'), /仅本次：每步确认/);
    await shot('02c-launch-override-default');
    report.checks.push('第一次选「完全放开」弹风险确认（取消不变、确认后记住）；「设为默认」写入默认；再选「每步确认」显示「仅本次」');
    // 公司版全新用户默认选公司模型卡，替身 CLI 用不了公司反代：改用「沿用本机 CLI 配置」。
    if (await cdp.eval(`!!document.querySelector('[data-model-card="own"]')?.getBoundingClientRect().width`)) await click('[data-model-card="own"]');
    await click('#new-session-submit');
    await until('[...sessions.values()].some(s => s.kind === "claude")', 'Claude session created');
    const id = await cdp.eval('[...sessions.values()].find(s => s.kind === "claude").id');
    const q = JSON.stringify(id);
    await waitFor(() => /SessionStart exit=0/.test(traceText()), 'CLI started');
    assert.deepEqual(modeLines(), ['permission-mode: default'], 'CLI 收到 --permission-mode default');
    assert.equal(await cdp.eval(`sessions.get(${q}).permissionMode`), 'default');
    report.checks.push('点「每步确认」建会话：CLI 启动参数 --permission-mode default，会话元数据记下 permissionMode=default');

    const composer = `.floating-input-bar[data-session-id="${id}"]`;
    await until(`document.querySelector(${JSON.stringify(composer + ' .floating-input-box')})`, 'composer ready');
    await click(composer + ' .floating-input-box');
    await cdp.send('Input.insertText', { text: 'run-tool please' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(() => /Notification exit=0/.test(traceText()), 'permission dialog hooks fired');
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state === RUNTIME_WAITING`, 'Hub shows waiting for input');
    await until(`(async()=>String(await ipcRenderer.invoke("get-ring-buffer",${q})).includes("Do you want to proceed?"))()`, 'dialog on terminal');
    report.waitingText = await cdp.eval(`document.querySelector(${JSON.stringify(composer)})?.innerText || ''`);
    report.sidebarText = await cdp.eval(`document.querySelector('.session-item[data-session-id=${q}]')?.innerText || ''`);
    await shot('03-waiting-permission');
    await cdp.eval(`ipcRenderer.send('terminal-input', { sessionId: ${q}, data: '1\\r' })`);
    await waitFor(() => /permission answer: 1[\s\S]*Stop exit=0/.test(traceText()), 'answered and finished');
    await until(`document.querySelector(${JSON.stringify(composer)})?.innerText.includes("完成")`, 'turn completed');
    report.checks.push('跑工具时 CLI 停在确认框（终端显示 Do you want to proceed?），Hub 状态为等待输入；在终端回 1 后继续并完成');

    // 3. 重开启动中心：显示默认「完全放开」（本次覆盖没落盘）；第二次选完全放开不再弹确认；恢复默认回到每步确认
    await openLauncher();
    assert.equal(await cdp.eval(selected), 'bypassPermissions', '默认是设过的完全放开，本次覆盖没落盘');
    await shot('04-launch-shows-saved-default');
    await click('#new-session-permission-reset');
    await until(`${selected} === "default"`, 'reset to product default');
    assert.equal(await cdp.eval('localStorage.getItem("hub.launch.lastPermissionMode.v1")'), null);
    await pickPermission('bypassPermissions');
    await sleep(600);
    assert.equal(await cdp.eval('!!document.querySelector("dialog[open]")'), false, '确认过一次不再弹');
    await shot('05-launch-reset');
    await click('#new-session-cancel');
    report.checks.push('重开启动中心显示默认「完全放开」（本次覆盖未落盘）；「恢复默认」回到每步确认并清掉记录；再选完全放开不再弹确认');

    // 4a. 休眠 → 侧栏点开恢复
    const suspended = await cdp.eval(`ipcRenderer.invoke('suspend-session', { sessionId: ${q} })`);
    assert.equal(suspended && suspended.ok, true, 'suspend: ' + JSON.stringify(suspended));
    await until(`sessions.get(${q})?.status === 'dormant'`, 'session dormant');
    await click(`.session-item[data-session-id="${id}"]`);
    await waitFor(() => modeLines().length >= 2, 'CLI restarted on wake');
    assert.equal(modeLines()[1], 'permission-mode: default', '休眠恢复后仍是 default');
    report.checks.push('休眠后从侧栏点开：CLI 重新启动仍带 --permission-mode default');

    // 4b. Hub 整个重启后恢复
    await until(`sessions.get(${q})?.status !== 'dormant'`, 'awake');
    await sleep(1500);
    await quit();
    await launch('perm-mode-2');
    await until(`typeof sessions !== 'undefined' && sessions.has(${q})`, 'session restored in sidebar after hub restart', 60000);
    if (await cdp.eval(`sessions.get(${q}).status !== 'dormant'`)) {
      await waitFor(() => modeLines().length >= 3, 'CLI restarted with hub', 60000);
    } else {
      await click(`.session-item[data-session-id="${id}"]`);
      await waitFor(() => modeLines().length >= 3, 'CLI restarted after hub restart', 60000);
    }
    assert.equal(modeLines()[2], 'permission-mode: default', 'Hub 重启后仍是 default');
    assert.equal(await cdp.eval(`sessions.get(${q}).permissionMode`), 'default');
    await shot('06-after-hub-restart');
    report.checks.push('整个 Hub 退出再启动后恢复该会话：CLI 仍带 --permission-mode default');
    report.modeLines = modeLines();

    // 5. Codex（二期）：选「每步确认」建会话 → CLI 不带旁路参数、用只读沙箱 + 按需批准；休眠恢复后仍是
    const codexTrace = path.join(home, 'fake-codex-trace.log');
    const codexArgs = () => { try { return fs.readFileSync(codexTrace, 'utf8').split(/\r?\n/).filter(line => line.startsWith('codex-args:') && !/^codex-args: (app-server|exec|login|mcp)\b/.test(line)); } catch { return []; } };
    await openLauncher();
    await click('.new-session-option[data-kind="codex"]');
    await until('document.getElementById("new-session-permission").options.length === 5', 'Codex permission options');
    await until(`${selected} === "default"`, 'codex default is ask');
    await shot('07-launch-codex-default');
    if (await cdp.eval(`!!document.querySelector('[data-model-card="own"]')?.getBoundingClientRect().width`)) await click('[data-model-card="own"]');
    await click('#new-session-submit');
    await until('[...sessions.values()].some(s => s.kind === "codex")', 'Codex session created', 60000);
    const codexId = await cdp.eval('[...sessions.values()].find(s => s.kind === "codex").id');
    const cq = JSON.stringify(codexId);
    await waitFor(() => codexArgs().length >= 1, 'Codex CLI launched', 60000);
    report.codexArgs = codexArgs();
    assert.match(codexArgs()[0], /approval_policy="?on-request/);
    assert.match(codexArgs()[0], /sandbox_mode="?read-only/);
    assert.doesNotMatch(codexArgs()[0], /dangerously-bypass-approvals-and-sandbox|approval_policy="?never/);
    assert.equal(await cdp.eval(`sessions.get(${cq}).permissionMode`), 'default');
    // 替身 Codex 不产生原生会话 id，Hub 不让它休眠；恢复链路沿用与 Claude 相同的 permissionMode 字段（单测覆盖），这里核对落盘记录。
    await sleep(1500);
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'sessions', codexId + '.json'), 'utf8'));
    report.codexSavedPermission = saved.permissionMode;
    assert.equal(saved.permissionMode, 'default', '会话文件里记下了 Codex 的权限模式');
    await shot('08-codex-session');
    report.checks.push('Codex 默认「每步确认」建会话：CLI 不带旁路参数，approval_policy=on-request、sandbox_mode=read-only；会话文件记下 permissionMode=default');

    // 5b. CodeAgent：选「只讨论不改」建会话 → 替身 CLI 收到 --permission-mode plan
    await openLauncher();
    await click('.new-session-option[data-kind="codeagent"]');
    await until('document.getElementById("new-session-permission").options.length === 5 && !document.getElementById("new-session-permission").disabled', 'CodeAgent permission options');
    await pickPermission('plan');
    await until(`${selected} === "plan"`, 'codeagent plan picked');
    await shot('08b-launch-codeagent-plan');
    // CodeAgent 是公司内网工具，开发机上没有真 CLI；替身在隔离 Hub 里起不来（号池/模型探测链路），启动参数由单测
    // tests/unit-permission-modes.test.js 逐档核对（5 档含 auto 都原样带 --permission-mode）。这里只核对界面选档。
    report.codeagentPicked = await cdp.eval('document.getElementById("new-session-permission").value');
    assert.equal(report.codeagentPicked, 'plan');
    await click('#new-session-cancel');
    report.checks.push('CodeAgent 启动中心可选「只讨论不改」（截图）；CLI 启动参数由单测逐档核对，开发机无真 CLI 未端到端');

    // 6. 五个工具各截一张启动中心：权限模式那一行独占整行（2026-11-20 负责人返工：Codex 6 列网格里说明被挤成一字一行）。
    // DSH 本机没装，点按钮会弹安装说明，这里用 Hub 自己「带工具打开启动中心」的入口直接选中它。
    report.harnessLayout = {};
    for (const kind of ['claude', 'codex', 'codeagent', 'deepseek-acp', 'pi']) {
      if (await cdp.eval('document.querySelector("#new-session-cancel")?.getBoundingClientRect().width > 0')) await click('#new-session-cancel');
      await sleep(300);
      await cdp.eval(`window.WorkspaceController.openNewSessionModal({ kind: ${JSON.stringify(kind)} })`);
      await until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', 'launcher for ' + kind);
      await sleep(900);
      await expandMore();
      const layout = await cdp.eval(`(()=>{const f=document.getElementById('new-session-permission-field'),n=document.getElementById('new-session-permission-note'),g=document.getElementById('new-session-tuning');
        const visible=f&&!f.hidden&&f.getBoundingClientRect().width>0;if(visible)f.scrollIntoView({block:'center'});
        const fr=f.getBoundingClientRect(),nr=n.getBoundingClientRect(),gr=g.getBoundingClientRect();
        return {visible,fieldWidth:Math.round(fr.width),gridWidth:Math.round(gr.width),noteWidth:Math.round(nr.width),noteHeight:Math.round(nr.height),noteText:n.textContent,options:[...document.getElementById('new-session-permission').options].map(o=>o.textContent),disabled:document.getElementById('new-session-permission').disabled};})()`);
      report.harnessLayout[kind] = layout;
      await sleep(200);
      await shot(`09-harness-${kind}`);
      if (layout.visible) {
        assert.ok(layout.fieldWidth >= layout.gridWidth - 2, `${kind}: 权限模式独占整行 ${layout.fieldWidth}/${layout.gridWidth}`);
        // 说明进了「权限模式」旁的 ⓘ（2026-11-22）；下面那行只在需要「恢复默认」时出现，出现时仍独占整行。
        assert.ok(layout.noteWidth === 0 || layout.noteWidth >= layout.gridWidth - 2, `${kind}: 说明独占整行 ${layout.noteWidth}/${layout.gridWidth}`);
        assert.ok(layout.noteHeight <= 60, `${kind}: 说明没有被挤成竖条（高 ${layout.noteHeight}px）`);
      }
    }
    report.checks.push('Claude / Codex / CodeAgent / DSH / pi 各截一张：权限模式与说明都占满整行，说明高度不超过 60px（配置区可见时）');
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    report.trace = traceText().split(/\r?\n/).filter(Boolean).slice(-40);
    if (cdp) {
      await shot('failure').catch(() => {});
      fs.writeFileSync(path.join(out, 'failure-dom.txt'), String(await cdp.eval('document.body.innerText').catch(() => '')));
    }
    throw error;
  } finally {
    let teardownError;
    try { await quit(); } catch (error) { teardownError = error; report.teardownError = error.stack; report.passed = false; }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (teardownError) throw teardownError;
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
