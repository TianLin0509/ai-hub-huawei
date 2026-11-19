'use strict';
// CodeAgent 模型默认值一揽子（2026-11-19 反馈 3b805ace「设置默认模型不生效」、11e2dc81「怎么关掉默认的 W3 模型」、24908907；
// 群里两次「模型列表只保留能用的」）。隔离 Hub + 假 CodeAgent（tests/fixtures/codeagent-pool-fake），不连模型，截图 1440 宽：
//   1. 启动中心模型下拉：用不了的模型（供应商 disabled）单列「暂不可用」，选了只说明原因、不切换；
//   2. 选一个模型点「设为默认」→ 关掉重开，下拉显示的就是它；不动下拉直接创建，会话按它启动；
//   3. 自动会话（AI 助理问答 company-ai）没指定模型时也按它；
//   4. 选「跟随 CodeAgent」那一项 →「改回跟随 CodeAgent」→ 新会话回到 CodeAgent 自己的默认模型；
//   5. 会话里输入框下方的模型菜单：同样单列「暂不可用」，点了说明原因。
// 用法：node tests/e2e-codeagent-hub-default-model-cdp.js（HUB_E2E_ARTIFACT_DIR / HUB_E2E_SHOT_PREFIX 指定截图位置和前缀）
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(REPO, 'artifacts', 'codeagent-hub-default-model'));
const PREFIX = process.env.HUB_E2E_SHOT_PREFIX || '';
const CLI_DEFAULT = 'GLM-5.2-WX-Auto', HUB_DEFAULT = 'GLM-5.3-Auto';
const MODELS = [CLI_DEFAULT, HUB_DEFAULT, 'maas-deepseek-v4.1-flash-aliyun-codeagent'];
const BLOCKED = 'kimi-k3-mini';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-default-model-'));
  const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PROJECT = path.join(ROOT, 'work', 'default-model'), PERSONAL = path.join(ROOT, 'personal');
  for (const dir of [DATA, WORK, PROJECT, PERSONAL, OUT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(PERSONAL, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'a00000001', expiresAt: Date.now() + 72 * 3600e3 } }));
  fs.writeFileSync(path.join(PERSONAL, 'settings.json'), JSON.stringify({ model: CLI_DEFAULT }));
  const command = path.join(ROOT, 'codeagent.cmd'), router = path.join(ROOT, 'codeagent-router.cjs');
  fs.writeFileSync(router, `require(${JSON.stringify(path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent-fake.js'))});`);
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${router}" %*\r\n`);
  const report = { checks: [], shots: [], root: ROOT };
  const check = (label, condition = true) => { assert(condition, label); report.checks.push(label); console.log('PASS ' + label); };
  let hub, c;
  const until = async (expression, label, timeout = 45000) => {
    const end = Date.now() + timeout; let last;
    while (Date.now() < end) { try { last = await c.eval(expression); if (last) return last; } catch (e) { last = e.message; } await sleep(150); }
    throw new Error(`Timeout ${label}: ${JSON.stringify(last)}`);
  };
  const invoke = (name, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(name)},${JSON.stringify(payload)})`);
  async function click(selector) {
    const xy = await until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height)return null;const x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return h&&(h===e||e.contains(h))?{x,y}:null})()`, 'clickable ' + selector);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...xy });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...xy, button: 'left', clickCount: 1 });
  }
  async function shot(name) {
    await sleep(300);
    const image = await c.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${PREFIX}${name}.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    report.shots.push(file);
  }
  const modelLog = () => { try { return fs.readFileSync(path.join(DATA, 'logs', 'codeagent-model.log'), 'utf8'); } catch { return ''; } };
  async function openLauncher() {
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center');
    await until(`!!document.querySelector('.new-session-option[data-kind="codeagent"]')`, 'codeagent option', 30000);
    await click('.new-session-option[data-kind="codeagent"]');
    await until(`document.querySelectorAll('#new-session-model option').length >= ${MODELS.length}`, 'codeagent model list', 30000);
  }
  const optionValue = id => c.eval(`[...document.querySelectorAll('#new-session-model option')].find(o=>o.value===${JSON.stringify(id)}||o.value.startsWith('[')&&JSON.parse(o.value)[0]===${JSON.stringify(id)})?.value||null`);
  async function closeLauncher() {
    await c.eval(`document.getElementById('new-session-menu').style.display==='none'||document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', 'launch center closed', 8000).catch(async () => {
      await c.eval(`(()=>{const b=document.querySelector('#new-session-menu .new-session-close, #new-session-cancel');if(b)b.click();})()`);
      await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', 'launch center closed (button)', 8000);
    });
  }
  async function sessionModel(id) {
    return until(`(()=>{const s=sessions.get(${JSON.stringify(id)});return s&&s.fixedModel?s.fixedModel:null})()`, 'session pinned model ' + id, 45000);
  }
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), label: 'hub-default-model-b', windowMode: 'hidden', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, AI_HUB_CODEAGENT_SERVE: '1',
      CODEAGENT_POOL_FAKE_MODELS: MODELS.join(','), CODEAGENT_POOL_FAKE_HELP_SETTINGS: '1', CODEAGENT_POOL_FAKE_DISABLED_PROVIDER: `团队自配:${BLOCKED}`,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'scan'), CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0',
      CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`typeof sessions !== 'undefined' && typeof selectSession === 'function'`, 'renderer ready', 60000);
    await invoke('codeagent-pool:probe', { id: 'personal' });
    const personalFile = path.join(DATA, 'codeagent-pool', 'personal-models.json');
    for (let i = 0; i < 200; i++) { try { if ((JSON.parse(fs.readFileSync(personalFile, 'utf8')).unavailable || []).length) break; } catch {} await sleep(150); }
    const catalog = JSON.parse(fs.readFileSync(personalFile, 'utf8'));
    check('serve catalog keeps the disabled provider model as unavailable', catalog.models.length === MODELS.length && catalog.unavailable[0].id === BLOCKED);

    // 1. 启动中心：暂不可用一组
    await openLauncher();
    check('fresh install: the model select follows CodeAgent own default', (await c.eval(`document.getElementById('new-session-model').value`)) === '');
    await click('#new-session-model');
    await until(`!!document.querySelector('.launch-select-popover .launch-select-cap')`, 'unavailable heading');
    const pop = await c.eval(`({cap:document.querySelector('.launch-select-popover .launch-select-cap').textContent,grey:[...document.querySelectorAll('.launch-select-popover .launch-select-option.unavailable')].map(e=>e.textContent)})`);
    check('launcher dropdown lists the no-permission model last under 暂不可用', /暂不可用/.test(pop.cap) && pop.grey.length === 1 && pop.grey[0].includes(BLOCKED));
    await shot('01-launcher-unavailable-group');
    await click('.launch-select-popover .launch-select-option.unavailable');
    await until(`!document.getElementById('new-session-tuning-warning').hidden && document.getElementById('new-session-tuning-warning').textContent.includes(${JSON.stringify(BLOCKED)})`, 'reason shown');
    const after = await c.eval(`({value:document.getElementById('new-session-model').value,warn:document.getElementById('new-session-tuning-warning').textContent})`);
    check('picking it only explains why and keeps the previous choice', after.value === '' && /供应商/.test(after.warn));
    report.unavailableReason = after.warn;
    await shot('02-launcher-unavailable-reason');

    // 2. 设为默认 → 重开显示它 → 不动下拉直接创建，按它启动
    await click('#new-session-model');
    await until(`!!document.querySelector('.launch-select-popover')`, 'model popover');
    const hubValue = await optionValue(HUB_DEFAULT);
    await click(`.launch-select-popover .launch-select-option[data-value='${hubValue}']`);
    await until(`document.getElementById('new-session-model').value === ${JSON.stringify(hubValue)}`, 'hub default selected');
    await click('#new-session-model-default');
    await until(`(async()=>((await require('electron').ipcRenderer.invoke('get-hub-config'))||{}).defaultModels?.codeagent)()`, 'default saved');
    const saved = (await invoke('get-hub-config', null)).defaultModels.codeagent;
    check('设为默认 saves the CodeAgent default model', saved === HUB_DEFAULT);
    await closeLauncher();
    await openLauncher();
    await until(`document.getElementById('new-session-model').value === ${JSON.stringify(hubValue)}`, 'reopened launcher shows hub default', 15000);
    const btn = await c.eval(`document.getElementById('new-session-model-default').textContent`);
    check('reopened launcher shows the saved default selected (默认 ✓)', /默认/.test(btn));
    const summary = await c.eval(`document.getElementById('new-session-summary').textContent`);
    check('launcher summary names the Hub default too', summary.includes(HUB_DEFAULT));
    const followLabel = await c.eval(`document.querySelector('#new-session-model option[value=""]').textContent`);
    check('the CodeAgent-own option is labelled 跟随 CodeAgent while a Hub default exists', followLabel.includes('跟随 CodeAgent'));
    await shot('03-launcher-hub-default-selected');
    const before = new Set(await c.eval(`[...sessions.keys()]`));
    await click('#new-session-submit');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', 'session created', 60000);
    const manualId = await until(`[...sessions.keys()].find(id=>!${JSON.stringify([...before])}.includes(id))`, 'new session id');
    const manualModel = await sessionModel(manualId);
    check(`manual new session launches with the Hub default (${manualModel})`, manualModel === HUB_DEFAULT);

    // 3. 自动会话（AI 助理问答）也按它
    const auto = await invoke('create-session', { kind: 'codeagent', opts: { cwd: PROJECT, title: '自动会话验收', purpose: 'company-ai', codeagentAccount: 'personal' } });
    assert(auto?.id, JSON.stringify(auto));
    const autoModel = await sessionModel(auto.id);
    check(`automatic session (company-ai) also uses the Hub default (${autoModel})`, autoModel === HUB_DEFAULT);
    check('model log records hub-default applied', /event=hub-default .*reason=applied/.test(modelLog()));

    // 4. 改回跟随 CodeAgent
    await openLauncher();
    await click('#new-session-model');
    await until(`!!document.querySelector('.launch-select-popover')`, 'model popover');
    await click(`.launch-select-popover .launch-select-option[data-value='']`);
    await until(`document.getElementById('new-session-model-default').textContent.includes('改回跟随 CodeAgent')`, 'clear button');
    await shot('04-launcher-follow-codeagent');
    await click('#new-session-model-default');
    await until(`(async()=>!((await require('electron').ipcRenderer.invoke('get-hub-config'))||{}).defaultModels?.codeagent)()`, 'default cleared');
    check('改回跟随 CodeAgent clears the Hub default', true);
    await closeLauncher();
    const back = await invoke('create-session', { kind: 'codeagent', opts: { cwd: PROJECT, title: '跟随验收', purpose: 'company-ai', codeagentAccount: 'personal' } });
    const backModel = await sessionModel(back.id);
    check(`after clearing, sessions use CodeAgent own default again (${backModel})`, backModel === CLI_DEFAULT);

    // 5. 会话里的模型菜单
    await c.eval(`selectSession(${JSON.stringify(manualId)})`);
    await until(`!!document.querySelector('.floating-input-bar[data-session-id="${manualId}"] .composer-model:not([hidden])')`, 'model chip');
    await click(`.floating-input-bar[data-session-id="${manualId}"] .composer-model`);
    await until(`!!document.querySelector('.model-picker-menu .model-picker-item.unavailable')`, 'in-session unavailable item');
    await click('.model-picker-menu .model-picker-item.unavailable');
    await until(`!!document.querySelector('.model-picker-menu .model-picker-note[data-unavailable-note]')`, 'in-session reason');
    const still = await c.eval(`sessions.get(${JSON.stringify(manualId)}).fixedModel`);
    check('in-session menu explains the unavailable model and does not switch', still === HUB_DEFAULT);
    await shot('05-session-menu-unavailable');
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    if (c) await shot('failure').catch(() => {});
    throw error;
  } finally {
    if (c) await c.close().catch(() => {});
    if (hub) {
      try { report.teardown = await gracefulQuit(hub); } catch (error) { report.teardownError = error.stack; }
      fs.writeFileSync(path.join(OUT, PREFIX + 'hub.log'), hub.log().join('\n'));
    }
    report.modelLog = modelLog().split('\n').filter(Boolean).slice(-20);
    fs.writeFileSync(path.join(OUT, PREFIX + 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: !!report.passed, checks: report.checks.length, error: report.error && report.error.split('\n')[0] }, null, 2));
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
