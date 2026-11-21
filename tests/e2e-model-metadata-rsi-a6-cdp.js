'use strict';
// Isolated Hub and simulated CLI only; no company connection or live model call.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(REPO, 'artifacts', 'rsi-a6-ui'));
const ID = 'deepseek4.1', UNKNOWN = 'unlisted-model';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-metadata-ui-'));
  const data = path.join(root, 'data'), work = path.join(root, 'work'), project = path.join(work, 'metadata'), personal = path.join(root, 'personal');
  for (const dir of [data, work, project, personal, OUT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'a00000001', expiresAt: Date.now() + 72 * 3600e3 } }));
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: ID }));
  const providers = path.join(root, 'providers.json');
  fs.writeFileSync(providers, JSON.stringify(['max', 'free'].map(id => ({ id, status: 'available', models: {
    [ID]: { id: ID, max_context_tokens: id === 'max' ? 400000 : 200000 },
    ...(id === 'free' ? { [UNKNOWN]: { id: UNKNOWN } } : {}),
  } }))));
  const command = path.join(root, 'codeagent.cmd'), router = path.join(root, 'router.cjs');
  fs.writeFileSync(router, `require(${JSON.stringify(path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent-fake.js'))});`);
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${router}" %*\r\n`);
  const report = { checks: [], shots: [] };
  const check = (label, condition) => { assert(condition, label); report.checks.push(label); console.log('PASS ' + label); };
  let hub, c;
  const until = async (expr, label, timeout = 45000) => {
    const end = Date.now() + timeout; let last;
    while (Date.now() < end) { try { last = await c.eval(expr); if (last) return last; } catch (error) { last = error.message; } await sleep(150); }
    throw new Error(`Timeout ${label}: ${JSON.stringify(last)}`);
  };
  const invoke = (name, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(name)},${JSON.stringify(payload)})`);
  const click = async selector => {
    const p = await until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`, selector);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  const shot = async name => { await sleep(200); const data = await c.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png'); fs.writeFileSync(file, Buffer.from(data.data, 'base64')); report.shots.push(file); };
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), label: 'model-metadata-a6', windowMode: 'hidden', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_SERVE: '1', CODEAGENT_POOL_FAKE_MODELS: [ID, UNKNOWN].join(','), CODEAGENT_POOL_FAKE_HELP_SETTINGS: '1',
      CODEAGENT_POOL_FAKE_PROVIDER_FILE: providers, AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0', CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`typeof sessions !== 'undefined' && typeof selectSession === 'function'`, 'renderer ready', 60000);
    await invoke('codeagent-pool:probe', { id: 'personal' });
    console.log('PASS isolated catalog probe completed');
    const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd: project, title: '模型元数据验收', model: ID, fixedModel: ID,
      codeagentModelPick: false, codeagentModelProvider: 'free', codeagentModelProviderLabel: 'free', codeagentModelMenuLabel: ID } });
    const id = created.id; assert(id);
    await c.eval(`selectSession(${JSON.stringify(id)})`);
    const chip = `.floating-input-bar[data-session-id="${id}"] .composer-model`;
    await until(`document.querySelector(${JSON.stringify(chip)})?.textContent.includes(${JSON.stringify(ID)})`, 'model chip');
    await click(chip);
    await until(`document.querySelectorAll('.model-picker-item[data-model-id]').length === 3`, 'three grouped model options');
    const rows = await c.eval(`[...document.querySelectorAll('.model-picker-item[data-model-id]')].map(e=>({text:e.textContent,title:e.title}))`);
    check('max/free labels distinguish groups and their 400K/200K windows', rows.some(r => /max.*高倍率/.test(r.text) && /400K ctx/.test(r.text)) && rows.some(r => /free.*免费/.test(r.text) && /200K ctx/.test(r.text)));
    check('missing catalog context is explicitly unknown', rows.some(r => /unlisted-model/.test(r.text) && /上下文未知/.test(r.text)));
    await shot('01-model-picker-1440');
    await click(chip);
    await until(`!document.querySelector('.model-picker-menu')`, 'picker closed');
    // Native hook supplies the source identity. Metadata assertions do not claim real provider execution.
    await until(`sessions.get(${JSON.stringify(id)})?.ccSessionId`, 'source native session identity');
    const fork = await invoke('fork-session', { sourceSessionId: id });
    check('fork retains the source model and free provider metadata', fork.ok && fork.session.currentModel?.id === ID && fork.session.codeagentModelProvider === 'free');
    await c.eval(`selectSession(${JSON.stringify(id)})`);
    const before = await c.eval(`new Set(sessions.keys()).size`);
    await c.eval(`switchSessionScene(${JSON.stringify(id)},'coding',null,{fresh:false})`);
    const scene = await until(`(()=>{const s=[...sessions.values()].find(s=>s.id!==${JSON.stringify(id)}&&s.id!==${JSON.stringify(fork.session.id)});return s||null})()`, 'new scene session');
    check('scene reference preserves source model and free provider', scene.currentModel?.id === ID && scene.codeagentModelProvider === 'free');
    check('scene creates a separate conversation', (await c.eval(`sessions.size`)) > before);
    await c.eval(`selectSession(${JSON.stringify(scene.id)})`);
    await until(`document.querySelector('.floating-input-bar[data-session-id="${scene.id}"] .floating-input-box')?.textContent.includes('source') || !!document.querySelector('.floating-input-bar[data-session-id="${scene.id}"] .floating-input-box')?.textContent`, 'reference draft retained');
    await shot('02-scene-reference-1440');
    report.passed = true;
  } catch (error) { report.error = error.stack; if (c) await shot('failure').catch(() => {}); throw error; }
  finally {
    if (c) await c.close().catch(() => {});
    if (hub) { report.teardown = await gracefulQuit(hub); fs.writeFileSync(path.join(OUT, 'ui-hub.log'), hub.log().join('\n')); }
    fs.writeFileSync(path.join(OUT, 'ui-report.json'), JSON.stringify(report, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    console.log(JSON.stringify({ passed: !!report.passed, checks: report.checks.length, error: report.error?.split('\n')[0] }));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
