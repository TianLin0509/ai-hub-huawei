'use strict';
// Launch center model cards, real user path in an isolated Hub (hidden window, own data dir and CDP port, mock upstream):
//   new session -> pick Claude Code / Codex / DSH -> pick a company model card (no trip to Settings) -> the session
//   starts through the proxy -> ask it to read a file -> the answer shows up; session card and title bar name the
//   model, "公司模型" and the pool account alias. Six sessions: each tool x GLM and DeepSeek. The last pick per tool
//   is remembered. Settings shows "反代运行中".
//   node tests/e2e-company-launch-model-cdp.js                 (artifacts: HUB_E2E_ARTIFACT_DIR or artifacts/company-launch-model)
//   E2E_BEFORE=1 -> only screenshots of the launch center (for before/after comparison).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/company-launch-model');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const tagName = process.env.E2E_SHOT_TAG || (process.env.E2E_BEFORE === '1' ? 'before' : 'after');
const report = { ok: false, checks: [], screenshots: [], sessions: [], mockUpstream: true };
const GLM = 'GLM-5.2-WX', DS = 'deepseek-v4.1-flash-1017';
const RUNS = [
  { ui: 'claude', label: 'Claude Code', model: GLM, marker: 'CLAUDEGLM_MARKER_A1' },
  { ui: 'claude', label: 'Claude Code', model: DS, marker: 'CLAUDEDS_MARKER_B2' },
  { ui: 'codex', label: 'Codex', model: GLM, marker: 'CODEXGLM_MARKER_C3' },
  { ui: 'codex', label: 'Codex', model: DS, marker: 'CODEXDS_MARKER_D4' },
  { ui: 'deepseek', label: 'DSH', model: GLM, marker: 'DSHGLM_MARKER_E5' },
  { ui: 'deepseek', label: 'DSH', model: DS, marker: 'DSHDS_MARKER_F6' },
].filter(r => !process.env.E2E_KINDS || process.env.E2E_KINDS.split(',').includes(r.ui));

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

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-launch-model-'));
  report.root = root;
  const home = path.join(root, 'home'), data = path.join(root, 'data'), claudeDir = path.join(root, 'claude'), files = path.join(root, 'files');
  for (const dir of [home, data, claudeDir, files, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', bypassPermissionsModeAccepted: true, numStartups: 5 }));
  for (const r of RUNS) fs.writeFileSync(path.join(files, `note-${r.marker}.txt`), `This file belongs to the ${r.label} + ${r.model} check.\n${r.marker}\n`);
  const POOL = ['aaaaaa1', 'bbbbbb2'];
  fs.mkdirSync(path.join(data, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(data, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: POOL.map(id => ({ id, label: 'Pool ' + id })) }));
  for (const id of POOL) {
    const dir = path.join(data, 'codeagent-pool', 'accounts', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hub-models.json'), JSON.stringify({ models: [GLM, DS], defaultModel: GLM, at: new Date().toISOString(), source: 'serve' }));
  }
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const cliDirs = ['claude', 'codex', 'node'].map(whichDir);
  assert.ok(cliDirs.every(Boolean), 'claude, codex and node must be installed for this end-to-end test');
  const dshRoot = process.env.AI_HUB_DSH_CLI_ROOT || (() => {
    try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'hub-cli-runtime.json'), 'utf8')).root; } catch { return ''; }
  })();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: claudeDir,
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0',
    AI_HUB_COMPANY_PROXY_MOCK: '1', AI_HUB_DSH_CLI_ROOT: dshRoot,
    [pathKey]: [...new Set(cliDirs), system, path.join(system, 'WindowsPowerShell/v1.0')].join(';'),
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '',
    HUB_CODEX_API_KEY: '', HUB_CLAUDE_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' };
  let hub, cdp;
  const check = (name, value, detail) => { report.checks.push({ name, ok: !!value, ...(detail !== undefined ? { detail } : {}) }); assert.ok(value, name + (detail !== undefined ? ' ' + JSON.stringify(detail) : '')); };
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
  async function shot(name) {
    await sleep(300);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = `${stamp}-launch-model-${tagName}-${name}-claude.png`;
    fs.writeFileSync(path.join(out, file), Buffer.from(image.data, 'base64'));
    report.screenshots.push(path.join(out, file));
  }
  async function escape() {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
  async function proxyStatus() {
    const endpoint = JSON.parse(fs.readFileSync(path.join(data, 'company-model-proxy', 'endpoint.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/admin/status`, { headers: { authorization: `Bearer ${endpoint.key}` } });
    return response.json();
  }
  const openLaunch = async ui => {
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center');
    await until(`document.querySelector('.new-session-option[data-kind="${ui}"]')?.dataset.installed === '1'`, ui + ' detected', 30000);
    await click(`.new-session-option[data-kind="${ui}"]`);
  };
  const cardSel = model => `#new-session-model-cards [data-model-card="${model}"]`;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'company-launch-model', windowMode: 'hidden', extraEnv: env });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!window.__companyApiOpen && !!window.WorkspaceController', 'renderer ready');
    // The hidden test window gets no animation frames, so CSS transitions can stop half way (a previously selected
    // tool button stays tinted in screenshots). Screenshots show the end state.
    await cdp.eval(`document.head.insertAdjacentHTML('beforeend','<style id="e2e-no-transition">*,*::before,*::after{transition:none!important}</style>')`);

    if (process.env.E2E_BEFORE === '1') {
      for (const ui of ['claude', 'codex', 'deepseek']) {
        await click('#btn-new');
        await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center');
        await sleep(1500);
        await click(`.new-session-option[data-kind="${ui}"]`);
        await sleep(2000);
        await shot(`launch-${ui}-1440`);
        await escape(); await sleep(400);
      }
      report.uiChecksPassed = true;
      return;
    }

    // 1. Cards: the three tools each show both company models with source and status; Claude/Codex also their own source.
    await openLaunch('claude');
    await until(`!!document.querySelector(${JSON.stringify(cardSel(GLM))})`, 'claude model cards', 20000);
    const cards = await cdp.eval(`[...document.querySelectorAll('#new-session-model-cards [data-model-card]')].map(c=>({id:c.dataset.modelCard,source:c.dataset.source,state:c.dataset.state,text:c.innerText}))`);
    report.claudeCards = cards;
    check('Claude Code：模型卡有两个公司模型和一张自有来源卡', cards.filter(c => c.source === 'company').map(c => c.id).join() === `${GLM},${DS}` && cards.some(c => c.source === 'own'), cards);
    check('公司模型卡写明来源「公司模型」', cards.filter(c => c.source === 'company').every(c => c.text.includes('公司模型')), cards);
    await shot('launch-claude-cards-1440');
    await escape(); await sleep(300);

    // 2. Six sessions, each from the launch center with one click on a model card.
    let lastId = null;
    for (const r of RUNS) {
      await openLaunch(r.ui);
      await until(`!!document.querySelector(${JSON.stringify(cardSel(r.model))})`, `${r.ui} cards`, 20000);
      await click(cardSel(r.model));
      await until(`document.querySelector(${JSON.stringify(cardSel(r.model))})?.getAttribute('aria-checked') === 'true'`, `${r.ui} ${r.model} picked`, 5000);
      const state = await cdp.eval(`document.querySelector(${JSON.stringify(cardSel(r.model))})?.dataset.state`);
      if (RUNS.find(x => x.ui === r.ui) === r) await shot(`launch-${r.ui}-picked-1440`);
      report.pickStates = [...(report.pickStates || []), `${r.ui}:${r.model}:${state}`];
      await click('#new-session-submit');
      await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', `${r.ui} ${r.model} session created`, 90000);
      await until(`(()=>{const id=window.activeSessionId||(typeof activeSessionId!=="undefined"?activeSessionId:null);return !!id&&id!==${JSON.stringify(lastId)}})()`, 'new active session', 30000);
      const id = await cdp.eval('window.activeSessionId || (typeof activeSessionId!=="undefined" ? activeSessionId : null)');
      lastId = id;
      await until(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, `${r.ui} composer visible`, 60000);
      await sleep(r.ui === 'deepseek' ? 8000 : 6000);
      await click('#terminal-panel .floating-input-box');
      await cdp.send('Input.insertText', { text: `请读取文件 ${path.join(files, `note-${r.marker}.txt`)} ，告诉我里面的标记。` });
      await click('#terminal-panel .floating-input-send');
      const deadline = Date.now() + 150000;
      let seen = false;
      while (Date.now() < deadline) {
        seen = await cdp.eval(`document.body.innerText.includes(${JSON.stringify('MOCK_FINAL: ' + r.marker)})`).catch(() => false);
        if (seen) break;
        await sleep(1000);
      }
      await sleep(5500); // proxy status poll (5 s) brings the pool account to the title bar and card
      const titleChip = await cdp.eval('document.getElementById("toolbar-model-route")?.innerText || ""');
      const cardText = await cdp.eval(`(()=>{const e=document.querySelector('[data-session-id=${JSON.stringify(id)}] .sl-route');return e?e.dataset.route+'|'+e.innerText+'|'+e.title:''})()`);
      const st = await proxyStatus();
      report.sessions.push({ ...r, id, seen, titleChip, cardText, byModel: st.mockUpstream?.byModel, byKind: st.stats?.byKind });
      await shot(`answer-${r.ui}-${r.model === GLM ? 'glm' : 'ds'}-1440`);
      check(`${r.label}+${r.model}：读文件后的回答出现在界面上（${r.marker}）`, seen);
      check(`${r.label}+${r.model}：标题栏写明模型、公司模型和号池别名`, titleChip.includes(r.model) && titleChip.includes('公司模型') && /号 \d|个人/.test(titleChip), titleChip);
      check(`${r.label}+${r.model}：会话卡片写明模型和号池别名（悬停写公司模型）`, cardText.startsWith('proxy|') && cardText.includes(r.model === GLM ? 'GLM' : 'DS') && /号 \d|个人/.test(cardText) && cardText.includes('公司模型'), cardText);
    }
    const final = await proxyStatus();
    report.finalProxy = { stats: final.stats, upstream: final.mockUpstream };
    check(`${RUNS.length} 个会话的请求按所选模型发到上游（每个会话至少 2 次）`, [GLM, DS].every(m => (final.mockUpstream.byModel[m] || 0) >= 2 * RUNS.filter(r => r.model === m).length), final.mockUpstream.byModel);
    check('三个工具都经反代发出请求', [...new Set(RUNS.map(r => r.ui === 'deepseek' ? 'dsh' : r.ui))].every(k => final.stats.byKind[k] > 0), final.stats.byKind);
    await escape(); await sleep(300);
    await shot('session-cards-1440');

    // 3. Remembered: reopening the launch center selects each tool's last pick.
    for (const ui of [...new Set(RUNS.map(r => r.ui))]) {
      const last = RUNS.filter(r => r.ui === ui).at(-1).model;
      await openLaunch(ui);
      await until(`document.querySelector(${JSON.stringify(cardSel(last))})?.getAttribute('aria-checked') === 'true'`, `${ui} remembers ${last}`, 15000);
      check(`${ui}：再次打开启动中心，默认选中上次的 ${last}`, true);
      await escape(); await sleep(300);
    }

    // 4. Settings shows the proxy running.
    await click('#btn-options'); await click('#options-settings');
    await until('!document.getElementById("config-modal").classList.contains("hidden")', 'settings');
    await click('#company-api-settings-open');
    await until('document.querySelector("#company-api-dialog [data-proxy-state]")?.dataset.proxyState === "running"', 'proxy running shown', 30000);
    check('设置里显示「反代运行中」', await cdp.eval('document.getElementById("company-api-dialog").innerText.includes("反代运行中")'));
    await shot('settings-running-1440');
    report.uiChecksPassed = true;
  } catch (error) {
    report.error = error.stack;
    if (cdp) await shot('failure').catch(() => {});
    throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      fs.writeFileSync(path.join(out, `${stamp}-launch-model-${tagName}-hub-claude.log`), hub.log().join('\n'));
      try { report.exit = await gracefulQuit(hub); }
      catch (error) { report.teardownError = error.stack; process.exitCode = 1; }
      finally { hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); }
      try { fs.copyFileSync(path.join(data, 'diagnostics', 'company-model-proxy.log'), path.join(out, `${stamp}-launch-model-${tagName}-proxy-claude.log`)); } catch { /* not started */ }
    }
    report.ok = !!report.uiChecksPassed && report.exit?.exitCode === 0 && !report.exit.forced && !report.teardownError;
    fs.writeFileSync(path.join(out, `${stamp}-launch-model-${tagName}-result-claude.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, failed: report.checks.filter(c => !c.ok).map(c => c.name), screenshots: report.screenshots.length, error: (report.error || report.teardownError || '').split('\n')[0] }));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
