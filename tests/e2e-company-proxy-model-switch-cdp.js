'use strict';
// Real Claude CLI, hidden isolated Hub and synthetic upstream: switching the
// composer model must change the next upstream request, including when the
// initial model was injected through ANTHROPIC_MODEL.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/company-proxy-model-switch');
const GLM = 'GLM-5.2-WX', DS = 'deepseek-v4.1-flash-1017';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { ok: false, mockUpstream: true, realCli: 'claude', checks: [], screenshots: [] };
function freePort() { return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
function whichDir(name) { return String(process.env.PATH || process.env.Path || '').split(path.delimiter).find(dir => dir && ['.exe', '.cmd', ''].some(ext => fs.existsSync(path.join(dir, name + ext)))); }
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-proxy-model-switch-'));
  report.root = root;
  const home = path.join(root, 'home'), data = path.join(root, 'data'), claude = path.join(root, 'claude'), files = path.join(root, 'files');
  for (const dir of [home, data, claude, files, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(data, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(data, 'profile', 'profile.json'), JSON.stringify({ v: 1, days: {}, nickname: '测试用户' }));
  fs.writeFileSync(path.join(claude, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', bypassPermissionsModeAccepted: true, numStartups: 5 }));
  fs.mkdirSync(path.join(data, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(data, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: [{ id: 'aaaaaa1', label: 'Fixture' }] }));
  const account = path.join(data, 'codeagent-pool', 'accounts', 'aaaaaa1'); fs.mkdirSync(account, { recursive: true });
  fs.writeFileSync(path.join(account, 'hub-models.json'), JSON.stringify({ models: [GLM, DS], defaultModel: GLM, at: new Date().toISOString(), source: 'serve' }));
  const turns = [{ model: GLM, marker: 'BEFORE_MARKER_A1' }, { model: DS, marker: 'AFTER_MARKER_B2' }];
  for (const turn of turns) fs.writeFileSync(path.join(files, turn.marker + '.txt'), turn.marker + '\n');
  const cliDirs = ['claude', 'node'].map(whichDir); assert.ok(cliDirs.every(Boolean), 'claude and node are installed');
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), CLAUDE_CONFIG_DIR: claude,
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0', AI_HUB_COMPANY_PROXY_MOCK: '1',
    [pathKey]: [...new Set(cliDirs), system, path.join(system, 'WindowsPowerShell/v1.0')].join(';'),
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '', HUB_CODEX_API_KEY: '', HUB_CLAUDE_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' };
  let hub, cdp;
  const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); assert.ok(ok, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); };
  async function until(expression, label, timeout = 30000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await cdp.eval(expression).catch(() => false)) return; await sleep(150); } throw Error('Timeout: ' + label); }
  async function click(selector) {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) { const result = await cdp.send('Page.captureScreenshot', { format: 'png' }); const file = path.join(out, name + '.png'); fs.writeFileSync(file, Buffer.from(result.data, 'base64')); report.screenshots.push(file); }
  async function proxyStatus() { const endpoint = JSON.parse(fs.readFileSync(path.join(data, 'company-model-proxy', 'endpoint.json'), 'utf8')); return (await fetch(`http://127.0.0.1:${endpoint.port}/admin/status`, { headers: { authorization: `Bearer ${endpoint.key}` } })).json(); }
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'company-proxy-model-switch', windowMode: 'hidden', extraEnv: env });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!window.WorkspaceController', 'renderer ready');
    await cdp.eval(`document.head.insertAdjacentHTML('beforeend','<style>*,*::before,*::after{transition:none!important}</style>')`);
    await click('#btn-new');
    await until(`document.querySelector('.new-session-option[data-kind="claude"]')?.dataset.installed === '1'`, 'Claude detected');
    await click('.new-session-option[data-kind="claude"]');
    const card = `#new-session-model-cards [data-model-card="${GLM}"]`;
    await until(`!!document.querySelector(${JSON.stringify(card)})`, 'company model card'); await click(card);
    await click('#new-session-submit');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', 'session created', 90000);
    await until('!!(window.activeSessionId||(typeof activeSessionId!=="undefined"?activeSessionId:null))', 'active session');
    report.sessionId = await cdp.eval('window.activeSessionId||(typeof activeSessionId!=="undefined"?activeSessionId:null)');
    await until(`(()=>{const e=document.querySelector('#terminal-panel .floating-input-box');return e&&e.offsetParent!==null})()`, 'composer'); await sleep(6500);
    let previousCounts = {};
    for (const [index, turn] of turns.entries()) {
      if (index) {
        await click('#terminal-panel .composer-model');
        const option = `.model-picker-menu [data-model-id="${DS}"]`;
        await until(`!!document.querySelector(${JSON.stringify(option)})`, 'DeepSeek model choice');
        await shot('model-menu-1440'); await click(option);
        await until(`!document.querySelector('.model-picker-menu')`, 'model switch confirmed', 45000);
        check('model chip confirms DeepSeek', (await cdp.eval(`document.querySelector('#terminal-panel .composer-model')?.innerText||''`)).toLowerCase().includes('deepseek'));
      }
      await click('#terminal-panel .floating-input-box');
      await cdp.send('Input.insertText', { text: `请读取文件 ${path.join(files, turn.marker + '.txt')}，告诉我里面的标记。` }); await click('#terminal-panel .floating-input-send');
      await until(`document.body.innerText.includes(${JSON.stringify('MOCK_FINAL: ' + turn.marker)})`, 'file answer ' + turn.marker, 120000);
      await sleep(1000);
      const status = await proxyStatus(), counts = status.mockUpstream?.byModel || {};
      report['turn' + index] = { selectedModel: turn.model, upstreamByModel: counts, statsByKind: status.stats?.byKind };
      check('upstream receives ' + turn.model, (counts[turn.model] || 0) > (previousCounts[turn.model] || 0), counts);
      if (index) check('next turn does not request the initial GLM model', (counts[GLM] || 0) === (previousCounts[GLM] || 0), counts);
      previousCounts = { ...counts }; await shot(index ? 'after-deepseek-1440' : 'before-glm-1440');
    }
    const diagnostics = fs.readFileSync(path.join(data, 'diagnostics', 'company-model-proxy.log'), 'utf8');
    check('proxy diagnostics confirm both Claude request models', diagnostics.includes('claude ' + GLM + ' -> HTTP 200') && diagnostics.includes('claude ' + DS + ' -> HTTP 200'));
    report.validated = true;
  } catch (error) { report.error = error.stack; if (cdp) {
    await shot('failure-1440').catch(() => {}); report.screen = await cdp.eval('document.body.innerText').catch(() => '');
    report.terminal = await cdp.eval(`ipcRenderer.invoke('get-session-buffer-snapshot', ${JSON.stringify(report.sessionId)})`).catch(e => e.message);
  } }
  finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n'));
      try { report.exit = await gracefulQuit(hub); } catch (error) { report.teardownError = error.stack; }
      hub.child.stdout?.destroy(); hub.child.stderr?.destroy();
      try { fs.copyFileSync(path.join(data, 'diagnostics', 'company-model-proxy.log'), path.join(out, 'proxy.log')); } catch { /* proxy may not have started */ }
    }
    report.ok = !!report.validated && report.exit?.exitCode === 0 && !report.exit.forced && !report.teardownError;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, error: (report.error || report.teardownError || '').split('\n')[0] }));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
