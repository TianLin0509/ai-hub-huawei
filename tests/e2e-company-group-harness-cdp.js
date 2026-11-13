'use strict';
// 公司版群聊成员可选 CodeAgent / Claude Code / Codex / DSH（2026-11-12）。
// 隔离 Hub、全新数据目录、真实点击；Claude / Codex 用夹具命令代替，不发任何模型请求。
// 公司模型（经本机反代）要公司内网账号，这里只走「沿用本机 CLI 配置」这条来源；公司模型的保存请求由单测覆盖。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/20261112-group-harness-ui');
const report = { ok: false, checks: [], screenshots: [], providerNetworkTested: false };
function freePort() {
  return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  }); });
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-group-harness-'));
  report.root = root;
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const fakeBin = path.join(home, 'fixture-bin');
  const traces = path.join(root, 'launch-traces');
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  for (const dir of [home, data, traces, fakeBin, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/external-api-cli.ps1'), path.join(fakeBin, 'external-api-cli.ps1'));
  for (const kind of ['claude', 'codex']) fs.writeFileSync(path.join(fakeBin, kind + '.cmd'),
    `@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0external-api-cli.ps1" -Kind ${kind} %*\r\n`);
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0',
    [pathKey]: [fakeBin, system, path.join(system, 'WindowsPowerShell/v1.0')].join(';'), HUB_EXTERNAL_API_FIXTURE_OUT: traces,
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '',
    HUB_CODEX_API_KEY: '', HUB_CLAUDE_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '', AI_HUB_DSH_CLI_ROOT: '' };
  let hub, cdp;
  const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await cdp.eval(expression).catch(() => false)) return; await sleep(100); }
    throw new Error('Timeout: ' + label);
  }
  async function click(selector) {
    const point = await cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control ${selector.replace(/['"\\]/g, '')}');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden control ${selector.replace(/['"\\]/g, '')}');return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  // 下拉框：聚焦后改值并发 change（和用户选一项后页面收到的事件相同）。
  const choose = (selector, value) => cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing select');
    if(![...e.options].some(o=>o.value===${JSON.stringify(value)}))throw Error('No such option');e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  async function shot(name) {
    await sleep(200);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
    report.screenshots.push(name + '.png');
  }
  const traceLines = kind => { try { return fs.readFileSync(path.join(traces, kind + '.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  async function waitTraces(kind, count) {
    const end = Date.now() + 45000;
    while (traceLines(kind).length < count && Date.now() < end) await sleep(150);
    assert.ok(traceLines(kind).length >= count, `${kind} 夹具进程启动了 ${count} 个`);
  }
  const slot = i => `#meeting-create-modal .mcm-slot[data-slot="${i}"]`;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'group-harness', extraEnv: env });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await until('!!window.WorkspaceController && !!window.openMeetingCreateModal', 'renderer ready');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.captureScreenshot', { format: 'png' });

    // 1. 全新用户打开「新建 › 群聊」：默认两位 CodeAgent，但每张成员卡多了「AI」下拉。
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center');
    await click('[data-launch-intent="group"]');
    await until(`document.querySelectorAll('#meeting-create-modal .mcm-slot').length === 2`, 'group panel');
    await until(`window.WorkspaceController.resolveSessionTuning('codex').modelOptions.length === 3`, 'company model catalog loaded');
    check('默认成员仍是两位 CodeAgent', await cdp.eval(`[...document.querySelectorAll('#meeting-create-modal .mcm-slot')].every(e => e.dataset.kind === 'codeagent')`));
    check('成员卡的 AI 下拉可见，列出 CodeAgent / Claude Code / Codex / DSH', await cdp.eval(`(() => {const s=document.querySelector('${slot(0)} .mcm-ai-select');
      return s.getBoundingClientRect().height > 0 && [...s.options].map(o=>o.value+'|'+o.textContent).join(',') === 'codeagent|CodeAgent,claude|Claude Code,codex|Codex,deepseek-acp|DSH';})()`));
    check('「添加成员」默认仍加 CodeAgent', await cdp.eval(`document.getElementById('mcm-add-member').textContent.trim() === '+ 添加 CodeAgent'`));
    await shot('20261112-group-harness-01-default-1440');

    // 2. 两位成员都换成 Codex：模型下拉是两个公司模型 + 沿用本机 CLI 配置，全新用户默认公司模型。
    await choose(`${slot(0)} .mcm-ai-select`, 'codex');
    await choose(`${slot(1)} .mcm-ai-select`, 'codex');
    await until(`document.querySelector('${slot(1)}')?.dataset.kind === 'codex'`, 'kind switched');
    const codexModels = await cdp.eval(`[...document.querySelectorAll('${slot(0)} .mcm-model-select option')].map(o=>o.value)`);
    assert.deepEqual(codexModels, ['GLM-5.2-WX', 'deepseek-v4.1-flash-1017', '']);
    check('Codex 成员的模型下拉 = 两个公司模型 + 沿用本机 CLI 配置', true);
    check('全新用户默认选中公司模型', await cdp.eval(`document.querySelector('${slot(0)} .mcm-model-select').value === 'GLM-5.2-WX'`));

    // 3. 同一种工具一半公司模型一半自有来源：就地报清楚，不建群。
    await choose(`${slot(1)} .mcm-model-select`, '');
    await click('#meeting-create-modal .mcm-create');
    await until(`/Codex 成员不能一部分用公司模型/.test(document.querySelector('#meeting-create-modal .mcm-error')?.textContent || '')`, 'mixed source error');
    check('同一种工具混用两种来源时就地提示', true);
    check('提示后没有建群', await cdp.eval(`require('electron').ipcRenderer.invoke('get-meetings').then(list => list.length === 0)`));
    await shot('20261112-group-harness-02-mixed-source-1440');

    // 4. 成员 1 = Claude Code、成员 2 = Codex，都沿用本机 CLI 配置，创建。
    await choose(`${slot(0)} .mcm-ai-select`, 'claude');
    await until(`document.querySelector('${slot(0)}')?.dataset.kind === 'claude'`, 'claude selected');
    await choose(`${slot(0)} .mcm-model-select`, '');
    await choose(`${slot(1)} .mcm-model-select`, '');
    check('成员卡标题随工具更新', await cdp.eval(`document.querySelector('${slot(0)} .mcm-slot-head strong').textContent === 'Claude Code' && document.querySelector('${slot(1)} .mcm-slot-head strong').textContent === 'Codex'`));
    await shot('20261112-group-harness-03-claude-codex-1440');
    // Hub 自己探测 CLI（版本、模型目录）也会调到夹具命令，所以按「建群前后新增了几条」来数。
    const before = { claude: traceLines('claude').length, codex: traceLines('codex').length };
    await click('#meeting-create-modal .mcm-create');
    await waitTraces('claude', before.claude + 1); await waitTraces('codex', before.codex + 1);
    check('Claude Code 成员真实启动（沿用本机配置，不附加模型）', traceLines('claude').at(-1).model === '' && !traceLines('claude').at(-1).baseURL);
    check('Codex 成员真实启动（沿用本机配置，不附加模型）', traceLines('codex').at(-1).model === '');
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    check('来源写回设置：两个工具都记成自有来源', saved.providers.claude.backend === 'api' && saved.providers.codex.backend === 'api' && !saved.providers.claude.base_url);
    await until(`!!document.getElementById('mr-btn-add-sub')`, 'meeting room open');
    const meeting = await cdp.eval(`(async()=>{const list=await require('electron').ipcRenderer.invoke('get-meetings');const m=list[list.length-1];
      const sessions=await require('electron').ipcRenderer.invoke('get-sessions');return {id:m.id,kinds:m.subSessions.map(id=>sessions.find(s=>s.id===id)?.kind)};})()`);
    check('群里两位成员分别是 Claude Code 与 Codex', JSON.stringify(meeting.kinds) === JSON.stringify(['claude', 'codex']));
    await shot('20261112-group-harness-04-room-1440');

    // 5. 群里「+ 成员」：同样四种工具可选；加一位 Claude Code。
    await click('#mr-btn-add-sub');
    await until(`!!document.getElementById('mr-add-sub-menu')`, 'add menu');
    check('「+ 成员」菜单列出四种工具，CodeAgent 第一，名字和建群弹窗一致', await cdp.eval(`[...document.querySelectorAll('#mr-add-sub-menu [data-add-kind]')].map(e=>e.dataset.addKind+'|'+e.textContent).join(',') === 'codeagent|CodeAgent,claude|Claude Code,codex|Codex,deepseek-acp|DSH'`));
    await shot('20261112-group-harness-05-add-menu-1440');
    const claudeBefore = traceLines('claude').length;
    await click('#mr-add-sub-menu [data-add-kind="claude"]');
    await waitTraces('claude', claudeBefore + 1);
    await until(`require('electron').ipcRenderer.invoke('get-meetings').then(list => list.at(-1).subSessions.length === 3)`, 'third member registered');
    check('群里追加的 Claude Code 成员真实启动', true);

    // 6. 造梦仍只用 CodeAgent。
    const dream = await cdp.eval(`require('electron').ipcRenderer.invoke('memory:start-dream',{kind:'claude'})`);
    check('造梦仍拒绝外部工具', !!dream.error && /只使用 CodeAgent/.test(dream.error));
    report.ok = true;
  } catch (error) {
    report.error = error && error.stack || String(error);
    if (cdp) await shot('20261112-group-harness-failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(out, '20261112-group-harness-e2e.json'), JSON.stringify(report, null, 2));
    if (cdp) await cdp.close?.();
    if (hub) await gracefulQuit(hub).catch(() => {});
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, error: report.error, out }, null, 2));
  }
}
main();
