'use strict';
// CodeAgent-Lite 真实界面验收（2026-11-23）：隔离数据目录 + 空 HOME + 无头隐藏窗口的真实 AI Hub。
// 用户路径：打开启动中心（默认仍选 CodeAgent）→ 点「CodeAgent-Lite · 省内存」→ 运行方式与思考强度隐藏、说明可见、无滚动
// → 点「创建会话」，截获发给主进程的参数（codeagent + serve，无 effort，不真的起会话）→ 1024×640 同样一屏
// → 设置「功能使用的 Agent」里助理下拉有 CodeAgent-Lite（省内存）并能选上 → 助理页 ⚙ Agent 弹窗里就地可切。
// 用法：node tests/e2e-codeagent-lite-cdp.js（截图写到 HUB_E2E_ARTIFACT_DIR 或 artifacts/codeagent-lite）
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/codeagent-lite');
const SCROLLERS = root => `(()=>{const r=document.querySelector(${JSON.stringify(root)});if(!r)return ['missing ${root}'];return [r,...r.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e);const b=e.getBoundingClientRect();return /(auto|scroll)/.test(s.overflowY)&&b.width>0&&b.height>0&&s.visibility!=='hidden'&&e.scrollHeight>e.clientHeight+2;}).map(e=>(e.id?'#'+e.id:(e.className||e.tagName))+' '+e.scrollHeight+'/'+e.clientHeight);})()`;
const PAGE_SCROLL = '(()=>{const d=document.scrollingElement||document.documentElement;return {scrollHeight:d.scrollHeight,clientHeight:d.clientHeight};})()';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub codeagent lite '));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  for (const dir of [home, data, out, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local'), path.join(root, 'codeagent')]) fs.mkdirSync(dir, { recursive: true });
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = {
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
    // CodeAgent 用测试替身：启动中心与功能选型按「已安装」显示，本用例不真的起会话。
    AI_HUB_CODEAGENT_COMMAND: path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd'),
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'),
    [pathKey]: [system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
  };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) env[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const report = { checks: [], measures: {}, shots: [] };
  let hub, cdp;
  const until = async (expression, label, timeout = 40000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { try { if (await cdp.eval(expression)) return; } catch {} await sleep(200); }
    throw new Error('Timed out: ' + label);
  };
  async function click(selector) {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  const choose = (selector, value) => cdp.eval(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});s.value=${JSON.stringify(String(value))};s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  async function shot(name) {
    await sleep(300);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    report.shots.push(file);
  }
  async function noScroll(label, rootSel) {
    const list = await cdp.eval(SCROLLERS(rootSel));
    const page = await cdp.eval(PAGE_SCROLL);
    report.measures[label] = { scrollers: list, page };
    assert.deepEqual(list, [], `${label} 出现纵向滚动：${list.join(', ')}`);
    assert.ok(page.scrollHeight <= page.clientHeight, `${label} 整页出现纵向滚动 ${page.scrollHeight}/${page.clientHeight}`);
  }
  const viewport = (width, height) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const pressed = kind => cdp.eval(`document.querySelector('.new-session-option[data-kind="${kind}"]')?.getAttribute('aria-pressed')==='true'`);
  const visible = id => cdp.eval(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e)return false;return !e.hidden&&!e.closest('[hidden]')&&e.getBoundingClientRect().height>0;})()`);
  async function openLauncher() {
    await cdp.eval('window.WorkspaceController?.openNewSessionModal?.({})');
    await until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', 'launcher', 20000);
    await sleep(800);
  }
  async function openSettingsTab(tab) {
    await click('#btn-options');
    await until('document.getElementById("options-settings")?.getBoundingClientRect().width > 0', 'options menu');
    await click('#options-settings');
    await until('!document.getElementById("config-modal").classList.contains("hidden")', 'settings open');
    await sleep(500);
    await click(`#cfg-tabs [data-cfg-tab-btn="${tab}"]`);
    await sleep(600);
  }

  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'codeagent-lite', extraEnv: env, windowMode: 'hidden' });
    cdp = await connectFirstPage(hub);
    await viewport(1440, 900);
    await until('!!window.WorkspaceController?.openNewSessionModal', 'renderer ready', 60000);
    await sleep(1500);

    // 1. 启动中心：默认仍是 CodeAgent，Lite 紧跟其后
    await openLauncher();
    await until('!!document.querySelector(".new-session-option[data-kind=\\"codeagent-lite\\"]")', 'lite button');
    const order = await cdp.eval('[...document.querySelectorAll(".session-kind-grid .new-session-option")].map(b=>b.dataset.kind)');
    report.measures.kindOrder = order;
    assert.equal(order.indexOf('codeagent-lite'), order.indexOf('codeagent') + 1, 'Lite 紧跟 CodeAgent');
    await until(`document.querySelector('.new-session-option[data-kind="codeagent"]')?.getAttribute('aria-pressed')==='true'`, '默认选中 CodeAgent', 15000);
    assert.equal(await pressed('codeagent-lite'), false);
    await shot('20261123-codeagent-lite-1-启动中心默认仍选CodeAgent-1440x900');
    report.checks.push(`启动中心按钮顺序 ${order.join(' > ')}；默认选中 CodeAgent，Lite 未选中`);

    // 2. 选 Lite：运行方式、思考强度隐藏，说明可见，一屏
    await click('.new-session-option[data-kind="codeagent-lite"]');
    await until(`document.querySelector('.new-session-option[data-kind="codeagent-lite"]')?.getAttribute('aria-pressed')==='true'`, 'lite pressed');
    await sleep(800);
    assert.equal(await pressed('codeagent'), false);
    assert.equal(await visible('new-session-run-mode-field'), false, '运行方式隐藏');
    assert.equal(await visible('new-session-effort-field'), false, '思考强度隐藏');
    const note = await cdp.eval('document.getElementById("new-session-run-mode-note")?.textContent || ""');
    report.measures.liteNote = note;
    assert.match(note, /轻量共享模式/);
    assert.equal(await visible('new-session-run-mode-note'), true, '轻量共享说明直接可见');
    assert.equal(await visible('new-session-submit'), true, '创建会话按钮可见');
    await noScroll('launcher-lite-1440x900', '#new-session-menu');
    await shot('20261123-codeagent-lite-2-启动中心选中Lite-1440x900');
    report.checks.push('选中 Lite：运行方式与思考强度隐藏、显示轻量共享说明、创建按钮可见；1440×900 无纵向滚动');

    // 3. 点创建：截获参数（不真的起会话）
    await cdp.eval(`(()=>{const ipc=require('electron').ipcRenderer;if(ipc.__liteOrig)return;ipc.__liteOrig=ipc.invoke;ipc.invoke=function(ch,...a){if(ch==='create-session'){window.__liteCreate=JSON.parse(JSON.stringify(a[0]));return Promise.reject(new Error('E2E 截获：不真的创建'));}return ipc.__liteOrig.call(this,ch,...a);};})()`);
    await click('#new-session-submit');
    await until('!!window.__liteCreate', 'create payload', 30000);
    const payload = await cdp.eval('window.__liteCreate');
    report.measures.createPayload = { kind: payload.kind, codeagentRunMode: payload.opts.codeagentRunMode, hasEffort: 'effort' in payload.opts, permissionMode: payload.opts.permissionMode || null };
    assert.equal(payload.kind, 'codeagent');
    assert.equal(payload.opts.codeagentRunMode, 'serve');
    assert.equal('effort' in payload.opts, false);
    report.checks.push(`创建参数：kind=${payload.kind}、codeagentRunMode=${payload.opts.codeagentRunMode}、不带 effort、权限 ${payload.opts.permissionMode || '默认'}`);
    await cdp.eval('(()=>{const ipc=require("electron").ipcRenderer;if(ipc.__liteOrig){ipc.invoke=ipc.__liteOrig;delete ipc.__liteOrig;}})()');
    await cdp.eval('window.WorkspaceController?.closeNewSessionModal?.() || document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await sleep(600);

    // 4. 1024×640：启动中心在加 Lite 之前就放不下一屏（工作目录区在折叠线下）。这里对照同一实例里
    //    「去掉 Lite 按钮、选 CodeAgent」的原样高度，如实记录多出的那一行按钮；要求选 Lite 不比选 CodeAgent 更高、创建按钮始终可见。
    await viewport(1024, 640);
    await openLauncher();
    const body = () => cdp.eval('(()=>{const b=document.querySelector("#new-session-menu .session-create-body");return {scrollHeight:b.scrollHeight,clientHeight:b.clientHeight};})()');
    const liteSel = '.new-session-option[data-kind="codeagent-lite"]';
    await click('.new-session-option[data-kind="codeagent"]');
    await sleep(800);
    const withLiteButton = await body();
    await cdp.eval(`document.querySelector(${JSON.stringify(liteSel)}).style.display="none"`);
    await sleep(400);
    const baseline = await body();
    await cdp.eval(`document.querySelector(${JSON.stringify(liteSel)}).style.display=""`);
    await click(liteSel);
    await until(`document.querySelector(${JSON.stringify(liteSel)})?.getAttribute('aria-pressed')==='true'`, 'lite pressed 1024');
    await sleep(800);
    const lite = await body();
    report.measures['launcher-1024x640'] = { baselineCodeagentNoLiteButton: baseline, codeagentWithLiteButton: withLiteButton, liteSelected: lite };
    assert.equal(await visible('new-session-submit'), true, '1024×640 创建会话按钮可见');
    assert.equal(await visible('new-session-run-mode-note'), true, '1024×640 轻量共享说明可见');
    assert.ok(lite.scrollHeight <= withLiteButton.scrollHeight, `选 Lite 时内容高度 ${lite.scrollHeight} 不超过选 CodeAgent 时 ${withLiteButton.scrollHeight}`);
    await shot('20261123-codeagent-lite-3-启动中心选中Lite-1024x640');
    report.checks.push(`1024×640：原样（无 Lite、选 CodeAgent）已需滚动 ${baseline.scrollHeight}/${baseline.clientHeight}；选 Lite ${lite.scrollHeight}/${lite.clientHeight}（比原样多 ${lite.scrollHeight - baseline.scrollHeight}px）；选 CodeAgent 时多一行按钮 ${withLiteButton.scrollHeight}/${withLiteButton.clientHeight}；创建按钮与说明可见`);
    await cdp.eval('window.WorkspaceController?.closeNewSessionModal?.() || document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await sleep(500);
    await viewport(1440, 900);
    await sleep(400);

    // 5. 设置「功能使用的 Agent」：助理下拉有 Lite 并能选上
    await openSettingsTab('agents');
    await until('!!document.querySelector("#cfg-feature-agents [data-fa-row=\\"assistant\\"] [data-fa-backend]")', 'feature agent rows', 30000);
    const options = await cdp.eval('[...document.querySelector("#cfg-feature-agents [data-fa-row=\\"assistant\\"] [data-fa-backend]").options].map(o=>({v:o.value,t:o.textContent,d:o.disabled}))');
    report.measures.assistantOptions = options;
    const liteOption = options.find(o => o.v === 'codeagent-lite');
    assert.ok(liteOption && !liteOption.d, '助理下拉有可选的 CodeAgent-Lite');
    assert.match(liteOption.t, /CodeAgent-Lite（省内存）/);
    await choose('#cfg-feature-agents [data-fa-row="assistant"] [data-fa-backend]', 'codeagent-lite');
    await until('document.querySelector("#cfg-feature-agents [data-fa-row=\\"assistant\\"] [data-fa-backend]")?.value==="codeagent-lite"', 'assistant saved lite', 20000);
    const saved = await cdp.eval('require("electron").ipcRenderer.invoke("feature-agents:get").then(s=>s.features.find(f=>f.id==="assistant").choice)');
    assert.equal(saved?.kind, 'codeagent-lite');
    await noScroll('settings-agents-1440x900', '#config-modal');
    await shot('20261123-codeagent-lite-4-设置功能使用的Agent-助理选Lite-1440x900');
    report.checks.push('设置「功能使用的 Agent」：助理下拉有「CodeAgent-Lite（省内存）」，选中后主进程保存为 codeagent-lite；1440×900 无纵向滚动');
    await viewport(1024, 640);
    await sleep(500);
    report.measures['settings-agents-1024x640'] = { scrollers: await cdp.eval(SCROLLERS('#config-modal')) };
    await shot('20261123-codeagent-lite-4b-设置功能使用的Agent-1024x640');
    await viewport(1440, 900);
    await sleep(300);
    await cdp.eval('document.getElementById("config-cancel")?.click() || document.getElementById("config-close")?.click()');
    await sleep(600);

    // 6. 助理页 ⚙ Agent 弹窗
    const opened = await cdp.eval('(()=>{const b=document.getElementById("btn-company-assistant");if(b){b.click();return true;}return false;})()');
    if (opened) {
      await sleep(1200);
      // 新数据目录里助理是「可选功能 · 未开启」：按用户路径先点「开启助理」。
      await cdp.eval('(()=>{const b=[...document.querySelectorAll("#company-assistant-page button, .optional-feature-gate button, button")].find(x=>x.offsetParent&&x.textContent.trim()==="开启助理");if(b)b.click();return !!b;})()');
      await until('(()=>{const e=document.querySelector("#company-assistant-page [data-feature-agent=\\"assistant\\"]");if(!e)return false;const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&(hit===e||e.contains(hit));})()', 'assistant entry clickable', 30000);
      await sleep(600);
      const entryLabel = await cdp.eval('document.querySelector("#company-assistant-page [data-feature-agent=\\"assistant\\"]").textContent');
      report.measures.assistantEntry = entryLabel;
      assert.match(entryLabel, /CodeAgent-Lite/);
      await click('#company-assistant-page [data-feature-agent="assistant"]');
      await until('!!document.querySelector(".fa-popup [data-fa-row=\\"assistant\\"] [data-fa-backend]")', 'popup rows', 20000);
      await sleep(500);
      assert.equal(await cdp.eval('document.querySelector(".fa-popup [data-fa-row=\\"assistant\\"] [data-fa-backend]").value'), 'codeagent-lite');
      const popupFits = await cdp.eval('(()=>{const p=document.querySelector(".fa-popup").getBoundingClientRect();return p.bottom<=innerHeight&&p.right<=innerWidth;})()');
      assert.ok(popupFits, '弹窗完整显示在窗口内');
      await shot('20261123-codeagent-lite-5-助理页Agent弹窗-就地切换-1440x900');
      // 就地切回默认，确认能改
      await click('.fa-popup [data-fa-row="assistant"] [data-fa-reset]');
      await until('document.querySelector(".fa-popup [data-fa-row=\\"assistant\\"] [data-fa-backend]")?.value===""', 'popup reset', 20000);
      report.checks.push(`助理页入口显示「${entryLabel.trim()}」；⚙ 弹窗当前为 CodeAgent-Lite，点「恢复默认」就地切回原 CodeAgent`);
    } else report.checks.push('本发行版没有助理页入口，跳过弹窗验收');
    report.ok = true;
  } catch (error) {
    report.ok = false; report.error = error.stack || error.message;
    try { await shot('20261123-codeagent-lite-error'); } catch { /* 截不到就算了 */ }
  } finally {
    try { if (hub) await gracefulQuit(hub); } catch { /* 隔离实例 */ }
    fs.writeFileSync(path.join(out, '20261123-codeagent-lite-e2e-report.json'), JSON.stringify(report, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, error: report.error ? String(report.error).split('\n')[0] : undefined, out }));
  if (!report.ok) process.exitCode = 1;
}
main();
