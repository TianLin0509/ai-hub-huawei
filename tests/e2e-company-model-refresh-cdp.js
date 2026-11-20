'use strict';
// 启动中心「刷新模型列表」真实路径（隔离 Hub、隐藏窗口、合成上游）：打开 Claude Code 启动中心只有两个公司模型 ->
// CodeAgent 里出了 GLM-5.3（反代存的模型目录多了一项）-> 不刷新时卡片不变 -> 点「刷新模型列表」-> 出现 5.3 卡、提示「新增」->
// 切到 Codex 也有。2026-11-20 定：模型目录只在打开 Hub 时取一次，加手动刷新，不定时刷。
//   node tests/e2e-company-model-refresh-cdp.js     (artifacts: HUB_E2E_ARTIFACT_DIR or artifacts/company-model-refresh)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const catalog = require('../core/company-proxy/model-catalog.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/company-model-refresh');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-refresh-'));
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
    const file = `${stamp}-model-refresh-${tagName}-${name}-claude.png`;
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
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'company-model-refresh', windowMode: 'hidden', extraEnv: env });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!window.__companyApiOpen && !!window.WorkspaceController', 'renderer ready');
    // The hidden test window gets no animation frames, so CSS transitions can stop half way (a previously selected
    // tool button stays tinted in screenshots). Screenshots show the end state.
    await cdp.eval(`document.head.insertAdjacentHTML('beforeend','<style id="e2e-no-transition">*,*::before,*::after{transition:none!important}</style>')`);

    const NEW = 'maas-glm-5-3-260814';
    const has = model => cdp.eval(`!!document.querySelector(${JSON.stringify(cardSel(model))})`);
    await openLaunch('claude');
    await until(`!!document.querySelector(${JSON.stringify(cardSel(GLM))})`, 'claude model cards', 20000);
    check('「刷新模型列表」按钮在模型卡上方可见', await cdp.eval(`(() => { const b = document.getElementById('new-session-model-refresh'); return !!b && b.getBoundingClientRect().width > 0 && b.textContent === '刷新模型列表'; })()`));
    check('刷新前没有 5.3', !(await has(NEW)));
    await shot('before-1440');
    // CodeAgent 里出了 GLM-5.3：反代拉到后存的就是这份目录（合成上游连不到 CodeAgent，这里直接写同一个文件）。
    catalog.writeCache(data, { schema: 1, at: Date.now(), accounts: { personal: { at: Date.now(), models: catalog.parseCatalog([
      { name: 'GLM-5.3-Auto(Volcano-MaaS)', modelId: 'GLM-5.3-Auto(Volcano-MaaS)', input: 169984, output: 32768,
        routModels: [{ modelId: NEW, modelLevel: 'large' }, { modelId: 'Qwen3.6-27B-CodeAgent-VL', modelLevel: 'small' }] },
      { name: 'GLM-5.2-WX-Auto', modelId: 'GLM-5.2-WX-Auto', input: 169984, output: 32768, routModels: [{ modelId: GLM, modelLevel: 'large' }] },
      { name: DS, modelId: DS, input: 344064, output: 65536 }]) } } });
    await sleep(1500);
    check('不点刷新、启动中心不自己变（不定时刷）', !(await has(NEW)));
    await click('#new-session-model-refresh');
    await until(`(document.getElementById('new-session-model-refresh-msg')?.textContent || '').startsWith('已从 CodeAgent')`, 'refresh message', 60000);
    const msg = await cdp.eval(`document.getElementById('new-session-model-refresh-msg').textContent`);
    check('提示取到 3 个、新增 5.3', msg.includes('3 个') && msg.includes('新增 GLM-5.3'), msg);
    check('点刷新后出现 5.3 卡，显示名用 CodeAgent 菜单名', await cdp.eval(`(document.querySelector(${JSON.stringify(cardSel(NEW))})?.innerText || '').includes('GLM-5.3')`));
    check('按钮恢复可点', await cdp.eval(`!document.getElementById('new-session-model-refresh').disabled`));
    check('按钮、提示和「模型」标题在同一行', await cdp.eval(`(() => { const t = id => Math.round(document.getElementById(id).getBoundingClientRect().top); return t('new-session-model-cards-label') === t('new-session-model-refresh') && t('new-session-model-refresh') === t('new-session-model-refresh-msg'); })()`));
    check('DeepSeek 卡仍显示好读名字', await cdp.eval(`(document.querySelector(${JSON.stringify(cardSel(DS))})?.innerText || '').includes('DeepSeek V4.1 Flash')`));
    await shot('after-claude-1440');
    await click('.new-session-option[data-kind="codex"]');
    await until(`!!document.querySelector(${JSON.stringify(cardSel(NEW))})`, 'codex 5.3 card', 20000);
    check('切到 Codex 也有 5.3', true);
    await shot('after-codex-1440');
    report.uiChecksPassed = true;
  } catch (error) {
    report.error = error.stack;
    if (cdp) await shot('failure').catch(() => {});
    throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      fs.writeFileSync(path.join(out, `${stamp}-model-refresh-${tagName}-hub-claude.log`), hub.log().join('\n'));
      try { report.exit = await gracefulQuit(hub); }
      catch (error) { report.teardownError = error.stack; process.exitCode = 1; }
      finally { hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); }
      try { fs.copyFileSync(path.join(data, 'diagnostics', 'company-model-proxy.log'), path.join(out, `${stamp}-model-refresh-${tagName}-proxy-claude.log`)); } catch { /* not started */ }
    }
    report.ok = !!report.uiChecksPassed && report.exit?.exitCode === 0 && !report.exit.forced && !report.teardownError;
    fs.writeFileSync(path.join(out, `${stamp}-model-refresh-${tagName}-result-claude.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, failed: report.checks.filter(c => !c.ok).map(c => c.name), screenshots: report.screenshots.length, error: (report.error || report.teardownError || '').split('\n')[0] }));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
