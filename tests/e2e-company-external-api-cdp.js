'use strict';
// Real clicks in an isolated Hub. Fixtures only; no model/provider network calls.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/20261104-external-api-ui');
const report = { ok: false, checks: [], screenshots: [], providerNetworkTested: false };
function freePort() {
  return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  }); });
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-external-api-'));
  report.root = root;
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const fakeBin = path.join(home, 'fixture-bin');
  const traces = path.join(root, 'launch-traces');
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  for (const dir of [home, data, traces, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
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
    const point = await cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden control');return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function key(key, code, modifiers = 0) {
    const windowsVirtualKeyCode = ({ Escape: 27, Enter: 13, ArrowDown: 40, End: 35, a: 65, c: 67 })[key];
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode });
  }
  async function input(name, value) {
    await click(`#company-api-dialog [name="${name}"]`);
    await key('a', 'KeyA', 2);
    await cdp.send('Input.insertText', { text: value });
  }
  async function viewport(width) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 900 : 800, deviceScaleFactor: 1, mobile: false });
    // Hidden Chromium applies resize on a compositor frame, before opening popups.
    await cdp.send('Page.captureScreenshot', { format: 'png' });
    await until(`window.innerWidth===${width}`, 'viewport');
  }
  async function shot(name) {
    await cdp.eval('Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
    await sleep(180);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = name + '.png';
    fs.writeFileSync(path.join(out, file), Buffer.from(image.data, 'base64'));
    report.screenshots.push(file);
  }
  async function save(kind, protocol) {
    await click(`[data-api-kind="${kind}"]`);
    await input('baseURL', `https://api.example.test/${kind === 'claude' ? 'anthropic' : 'v1'}`);
    await input('apiKey', 'fixture-api-key');
    await input('model', 'Company/Model-V1');
    if (protocol) {
      await click('[name="wireApi"]');
      await key('End', 'End'); await key('Enter', 'Enter');
      check('协议控件选择 chat', await cdp.eval('document.querySelector("[name=wireApi]").value === "chat"'));
    }
    await click('#company-api-dialog [type="submit"]');
    await until('document.querySelector("#company-api-dialog [role=status]")?.textContent.startsWith("已保存") || document.querySelector("#company-api-dialog [role=status]")?.textContent.startsWith("配置已保存")', 'save ' + kind);
    check(kind + ' 保存后 Key 输入已清空', await cdp.eval('document.querySelector("#company-api-dialog [name=apiKey]").value === ""'));
  }
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'external-api-m1', extraEnv: env });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await until('!!window.__companyApiOpen && !!window.WorkspaceController', 'renderer ready');
    await until('document.querySelector(".new-session-option[data-kind=claude]")?.dataset.installed === "0"', 'missing CLI status');
    check('公司版未创建订阅额度侧栏', await cdp.eval('!document.querySelector("#account-quota-panel")?.textContent.trim()'));
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center');
    check('启动中心保留 CodeAgent、Claude、Codex、DSH、PowerShell', await cdp.eval(`['codeagent','claude','codex','deepseek','powershell'].every(kind => !!document.querySelector('.new-session-option[data-kind="'+kind+'"]'))`));
    check('Claude 和 Codex 头像文件可读取', ['claude', 'codex'].every(kind => fs.existsSync(path.join(__dirname, '../renderer/assets/ai-avatars/cel-v2', kind + '.png'))));
    for (const width of [1440, 1280]) {
      await viewport(width);
      if (await cdp.eval('getComputedStyle(document.getElementById("new-session-menu")).display === "none"')) await click('#btn-new');
      await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'reopen launch center');
      await shot('20261104-api-launcher-' + width + '-m1');
      await click('.new-session-option[data-kind="claude"]');
      await until('!!document.querySelector("#company-api-dialog [data-api-action=docs]")', 'installation guide');
      check(width + ' 缺 CLI 显示安装说明与重新检测', await cdp.eval('document.getElementById("company-api-dialog").innerText.includes("未安装") && !!document.querySelector("[data-api-action=refresh]")'));
      await shot('20261104-api-missing-claude-' + width + '-m1');
      await click('.company-api-close');
    }
    if (await cdp.eval('getComputedStyle(document.getElementById("new-session-menu")).display === "none"')) await click('#btn-new');
    await click('.new-session-option[data-kind="codex"]');
    await until('!!document.querySelector("#company-api-dialog [data-api-action=docs]")', 'Codex installation guide');
    check('Codex 缺 CLI 同样显示安装说明', await cdp.eval('document.getElementById("company-api-dialog").innerText.includes("安装 Codex")'));
    await click('.company-api-close');
    if (await cdp.eval('getComputedStyle(document.getElementById("new-session-menu")).display === "none"')) await click('#btn-new');
    check('DSH 缺环境显示未安装', await cdp.eval('document.querySelector(".new-session-option[data-kind=deepseek] .company-cli-status")?.textContent === "未安装"'));
    await click('.new-session-option[data-kind="deepseek"]');
    await until('!!document.querySelector("#company-api-dialog [data-api-action=configure]")', 'DSH setup instructions');
    check('DSH 缺环境给出指引且不启动会话', await cdp.eval('document.getElementById("company-api-dialog").innerText.includes("尚未就绪")'));
    await shot('20261104-api-missing-dsh-1280-m1');
    await click('.company-api-close');
    await key('Escape', 'Escape');
    await click('#btn-options'); await click('#options-settings');
    await until('!document.getElementById("config-modal").classList.contains("hidden")', 'settings');
    check('公司设置隐藏代理字段', await cdp.eval('document.getElementById("cfg-proxy").getBoundingClientRect().height===0'));
    await click('#company-api-settings-open');
    await until('!!document.querySelector("#company-api-dialog form")', 'API form');
    for (const kind of ['claude', 'codex', 'deepseek-acp']) await save(kind, kind === 'codex' ? 'chat' : null);
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    check('Claude 配置按 API 模式落盘', saved.providers.claude.backend === 'api' && saved.providers.claude.api_key === 'fixture-api-key');
    check('Codex chat 协议落盘', saved.providers.codex.backend === 'api' && saved.providers.codex.wire_api === 'chat');
    check('DSH 接口单独保存，不写入套餐 Key', saved.acp.companyApi.apiKey === 'fixture-api-key' && !saved.acp.apiKey);
    for (const width of [1440, 1280]) {
      await viewport(width);
      for (const kind of ['claude', 'codex', 'deepseek-acp']) {
        await click(`[data-api-kind="${kind}"]`);
        check(kind + ' ' + width + ' 没有订阅或代理控件', await cdp.eval('!/(订阅|代理|Packy|Token Plan)/.test(document.getElementById("company-api-dialog").innerText)'));
        check(kind + ' ' + width + ' 对话框不溢出', await cdp.eval('(() => {const e=document.getElementById("company-api-dialog"),r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&e.scrollWidth<=e.clientWidth+1;})()'));
        await shot(`20261104-api-settings-${kind}-${width}-m1`);
      }
    }
    await click('.company-api-close');
    await click('#btn-options'); await click('#options-settings'); await click('#company-api-settings-open');
    await until('!!document.querySelector("#company-api-dialog form")', 'reload form');
    check('重新打开只显示 Key 已保存状态', await cdp.eval('document.querySelector("#company-api-dialog [name=apiKey]").value==="" && document.querySelector("#company-api-dialog [name=apiKey]").placeholder.includes("已保存")'));
    check('原账号与额度开关保持关闭', await cdp.eval('!require("../core/distribution").featureEnabled("accounts") && !require("../core/distribution").featureEnabled("quotaBar")'));
    await click('.company-api-close');

    // Install task-local stand-ins only after the absent-CLI path has been tested.
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures/external-api-cli.ps1'), path.join(fakeBin, 'external-api-cli.ps1'));
    for (const kind of ['claude', 'codex']) fs.writeFileSync(path.join(fakeBin, kind + '.cmd'),
      `@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0external-api-cli.ps1" -Kind ${kind} %*\r\n`);
    await click('#community-refresh');
    await until('document.querySelector(".new-session-option[data-kind=codex]")?.dataset.installed === "1"', 'fixture CLIs detected');
    for (const kind of ['claude', 'codex']) {
      await click('#btn-new');
      await click(`.new-session-option[data-kind="${kind}"]`);
      await until('document.querySelector("#new-session-model")?.value === "Company/Model-V1"', 'configured model selected');
      check(kind + ' API 启动不显示订阅选号', await cdp.eval('document.getElementById("new-session-account-field").getBoundingClientRect().height===0'));
      await click('#new-session-submit');
      const file = path.join(traces, kind + '.jsonl');
      const end = Date.now() + 30000;
      while (!fs.existsSync(file) && Date.now() < end) await sleep(100);
      assert.ok(fs.existsSync(file), kind + ' fixture process started');
      const trace = JSON.parse(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0]);
      check(kind + ' 真实 PTY 使用已配置模型启动', trace.model === 'Company/Model-V1');
      if (kind === 'claude') {
        check('Claude 子进程收到自有 URL/AUTH_TOKEN，未继承旧认证', trace.baseURL === 'https://api.example.test/anthropic' && trace.tokenMatches && !trace.inheritedApiKey && !trace.inheritedOAuth);
      } else {
        check('Codex 子进程使用 Hub 隔离 API 目录', path.resolve(trace.codexHome) === path.join(data, 'codex-api-profile'));
        const config = fs.readFileSync(path.join(trace.codexHome, 'config.toml'), 'utf8');
        check('Codex 启动时实际生成 chat 与自有 URL', /wire_api = "chat"/.test(config) && config.includes('https://api.example.test/v1'));
      }
    }
    // Removing the explicit override must not synthesize another endpoint,
    // account profile, or model when the installed CLI already has its own setup.
    for (const kind of ['claude', 'codex']) {
      await click('#btn-options'); await click('#options-settings'); await click('#company-api-settings-open');
      await until('!!document.querySelector("#company-api-dialog form")', 'local reset form');
      await click(`[data-api-kind="${kind}"]`); await click('[data-api-action="local"]');
      await until('!!document.querySelector("#company-api-dialog [role=status]")?.textContent.includes("已清除")', 'local reset saved');
      check(kind + ' 可清除接口覆盖回本机配置', await cdp.eval('document.querySelector("#company-api-dialog [name=baseURL]").value === "" && document.querySelector("#company-api-dialog [name=model]").value === ""'));
      await click('.company-api-close');
      await click('#btn-new'); await click(`.new-session-option[data-kind="${kind}"]`);
      await until('document.querySelector("#new-session-model")?.value === ""', 'native model selected');
      await shot(`20261104-api-local-${kind}-1280-m1`);
      await click('#new-session-submit');
      const file = path.join(traces, kind + '.jsonl');
      const end = Date.now() + 30000;
      let entries = [];
      while (Date.now() < end) {
        entries = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
        if (entries.length >= 2) break;
        await sleep(100);
      }
      assert.ok(entries.length >= 2, kind + ' local fixture started');
      const trace = entries.at(-1);
      check(kind + ' 留空启动未附加模型参数', trace.model === '');
      if (kind === 'claude') check('Claude 留空启动没有注入地址、Key或模型环境', !trace.baseURL && !trace.tokenMatches && !trace.envModel);
      else check('Codex 留空启动使用原本机目录', path.resolve(trace.codexHome) === path.join(root, 'codex'));
    }
    // External single-session availability must not widen company dreams. Group members may use the
    // launch-center tools since 2026-11-12 (tests/e2e-company-group-harness-cdp.js covers the real launches).
    // The empty group is a local fixture; no CodeAgent process or inference starts.
    const boundaryWorkspace = path.join(root, 'workspaces', 'runtime-boundary');
    fs.mkdirSync(boundaryWorkspace, { recursive: true });
    await cdp.eval(`(async()=>{window.__apiBoundaryGroup = await require('electron').ipcRenderer.invoke('create-meeting',
      {title:'Runtime boundary fixture',workspace:${JSON.stringify(boundaryWorkspace)},slots:[]});})()`);
    for (const kind of ['claude', 'codex', 'deepseek-acp']) {
      const refused = await cdp.eval(`(async()=>{
        const ipc=require('electron').ipcRenderer;
        const dream=await ipc.invoke('memory:start-dream',{kind:${JSON.stringify(kind)}});
        return {dream:!!dream.error&&/只使用 CodeAgent/.test(dream.error)};
      })()`);
      check(kind + ' 真实造梦IPC拒绝外部工具', refused.dream);
    }
    for (const width of [1440, 1280]) {
      await viewport(width);
      await click('#btn-rail-group-rules');
      await until('document.getElementById("btn-rail-capabilities").getBoundingClientRect().height > 0', 'expanded resource navigation');
      await click('#btn-rail-capabilities');
      await until('!!document.querySelector("[data-hw-tab=memory]")', 'resource tabs');
      await click('[data-hw-tab="memory"]');
      await until('!!document.querySelector("#memory-page [data-tab=dream]")', 'memory tabs');
      await click('#memory-page [data-tab="dream"]');
      await until('!!document.querySelector("#mp-kind")', 'dream runtime selector');
      check(width + ' 造梦仅列CodeAgent并默认选中', await cdp.eval('document.querySelector("#mp-kind").value==="codeagent" && [...document.querySelectorAll("#mp-kind option")].every(o=>o.value==="codeagent")'));
      await shot('20261104-api-dream-codeagent-' + width + '-m1');
      await click('[data-hw-close]');
      await cdp.eval('window.openMeetingCreateModal("group")');
      await until('!!document.querySelector(".mcm-overlay .mcm-ai-select")', 'group runtime selectors');
      check(width + ' 新群聊成员可选四种工具', await cdp.eval('[...document.querySelector(".mcm-overlay .mcm-ai-select").options].map(o=>o.value).join(",")==="codeagent,claude,codex,deepseek-acp"'));
      await shot('20261104-api-new-group-codeagent-' + width + '-m1');
      await click('.mcm-close');
      await cdp.eval('window.MeetingRoom.openMeeting(window.__apiBoundaryGroup.id,window.__apiBoundaryGroup)');
      await until('!!document.querySelector("[data-gc-add-member],#mr-btn-add-sub")', 'group member add control');
      const addSelector = await cdp.eval('document.querySelector("[data-gc-add-member]")?.getBoundingClientRect().height ? "[data-gc-add-member]" : "#mr-btn-add-sub"');
      await click(addSelector);
      await until('!!document.querySelector("#mr-add-sub-menu [data-add-kind]")', 'add member menu');
      check(width + ' 已建群聊加成员可选四种工具', await cdp.eval('JSON.stringify([...document.querySelectorAll("#mr-add-sub-menu [data-add-kind]")].map(e=>e.dataset.addKind))===JSON.stringify(["codeagent","claude","codex","deepseek-acp"])'));
      await shot('20261104-api-add-member-codeagent-' + width + '-m1');
      await click('#btn-home');
    }
    report.launchFixturesTested = true;
    report.uiChecksPassed = true;
  } catch (error) {
    report.error = error.stack;
    if (cdp) await shot('20261104-api-failure-m1').catch(() => {});
    throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      fs.writeFileSync(path.join(out, '20261104-api-hub-m1.log'), hub.log().join('\n'));
      try { report.exit = await gracefulQuit(hub); }
      catch (error) { report.teardownError = error.stack; process.exitCode = 1; }
      finally { hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); }
    }
    report.ok = !!report.uiChecksPassed && report.exit?.exitCode === 0 && !report.exit.forced && !report.teardownError;
    fs.writeFileSync(path.join(out, '20261104-external-api-ui-m1.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, screenshots: report.screenshots.length, exit: report.exit, error: report.error || report.teardownError }));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
