'use strict';
// CodeAgent 会话输入框下方的模型（2026-11-19 两条反馈）：
//   1. 20261118T063101Z-147541f7：号上配了很多模型，下拉要能看到、选到全部（这里 9 个，超过以前反馈的 5 个）；
//   2. 20261119T080512Z-3d260a3c：在后台（终端里 /model）换了模型，下一轮回答已是新模型，输入框下方要跟着改。
// 隔离 Hub + 假 CodeAgent（tests/fixtures/codeagent-pool-fake：假 serve 报模型清单、按 hook 报回答、回答的 model 取自文件），
// 不连模型。截图 1440 宽。用法：node tests/e2e-codeagent-model-chip-cdp.js
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(REPO, 'artifacts', 'codeagent-model-chip'));
const PREFIX = process.env.HUB_E2E_SHOT_PREFIX || '';
const MODELS = ['GLM-5.3-Auto(Volcano-MaaS)', 'GLM-5.2-Auto(Tencent-MaaS)', 'GLM-5.2-Auto(Volcano-MaaS)', 'GLM-5.3-Auto(Baidu-MaaS)',
  'maas-glm-5.2-volcengine-codeagent', 'maas-DeepSeek-V4.1-Flash', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'qwen3.8-27b'];
// 用户在 settings.json 的 enterprise.providers 里自配、serve 清单没报的模型（公司回执 Q-1119-12 的结构）。
const CONFIGURED = ['kimi-k3-mini', 'dsr2-think'];
const START = 'maas-glm-5.2-volcengine-codeagent', SWITCHED = 'GLM-5.3-Auto(Volcano-MaaS)';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-chip-'));
  const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PROJECT = path.join(ROOT, 'work', 'model-chip'), PERSONAL = path.join(ROOT, 'personal'), ANSWER = path.join(ROOT, 'answer-model.txt');
  for (const dir of [DATA, WORK, PROJECT, PERSONAL, OUT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(PERSONAL, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'a00000001', expiresAt: Date.now() + 72 * 3600e3 } }));
  fs.writeFileSync(path.join(PERSONAL, 'settings.json'), JSON.stringify({ model: START, enterprise: { providers: {
    'team-models': { provider: 'openai', protocol: 'openai', apiBaseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture', mainModel: START, smallModel: CONFIGURED[0], deepModel: CONFIGURED[1] } } } }));
  fs.writeFileSync(ANSWER, 'maas-glm-5-2-260617');
  const command = path.join(ROOT, 'codeagent.cmd');
  // 仓库路径可能含中文：.cmd 按本地码页读，路径只放进 .cjs（Node 按 UTF-8 读），同 e2e-codeagent-quota-panel-cdp.js。
  const router = path.join(ROOT, 'codeagent-router.cjs');
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
    await sleep(250);
    const image = await c.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${PREFIX}${name}.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    report.shots.push(file);
  }
  async function send(id, text) {
    const box = `.floating-input-bar[data-session-id="${id}"] .floating-input-box`;
    await click(box);
    await c.send('Input.insertText', { text });
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  const chip = id => c.eval(`document.querySelector('.floating-input-bar[data-session-id="${id}"] .composer-model')?.textContent.trim() || ''`);
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), label: 'model-chip-m3', windowMode: 'hidden', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, AI_HUB_CODEAGENT_SERVE: '1',
      CODEAGENT_POOL_FAKE_MODELS: MODELS.join(','), CODEAGENT_POOL_FAKE_HELP_SETTINGS: '1', CODEAGENT_POOL_FAKE_ANSWER_MODEL_FILE: ANSWER,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'scan'), CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0',
      CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`typeof sessions !== 'undefined' && typeof selectSession === 'function'`, 'renderer ready', 60000);
    await invoke('codeagent-pool:probe', { id: 'personal' });
    const personalFile = path.join(DATA, 'codeagent-pool', 'personal-models.json');
    for (let i = 0; i < 200; i++) { try { if ((JSON.parse(fs.readFileSync(personalFile, 'utf8')).models || []).length === MODELS.length) break; } catch {} await sleep(150); }
    check(`serve catalog read with all ${MODELS.length} models`, JSON.parse(fs.readFileSync(personalFile, 'utf8')).models.length === MODELS.length);

    const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd: PROJECT, title: '模型显示验收', codeagentAccount: 'personal' } });
    assert(created?.id, JSON.stringify(created));
    const id = created.id;
    await c.eval(`selectSession(${JSON.stringify(id)})`);
    await until(`!!document.querySelector('.floating-input-bar[data-session-id="${id}"] .composer-model:not([hidden])')`, 'model chip');
    await until(`document.querySelector('.floating-input-bar[data-session-id="${id}"] .composer-model')?.textContent.includes(${JSON.stringify(START)})`, 'chip shows the launch model');
    check('the chip starts on the pinned launch model', (await chip(id)).includes(START));

    // 1. 下拉看得到、选得到全部模型
    await click(`.floating-input-bar[data-session-id="${id}"] .composer-model`);
    const ALL = [...MODELS, ...CONFIGURED];
    await until(`document.querySelectorAll('.model-picker-menu .model-picker-item[data-model-id]').length === ${ALL.length}`, 'all models listed');
    const listed = await c.eval(`[...document.querySelectorAll('.model-picker-menu .model-picker-item[data-model-id]')].map(e=>e.dataset.modelId)`);
    check(`dropdown lists all ${ALL.length} models: ${MODELS.length} from serve, then ${CONFIGURED.length} self-configured`, JSON.stringify(listed) === JSON.stringify(ALL));
    await shot('01-dropdown-all-models');
    const reach = await c.eval(`(()=>{const items=[...document.querySelectorAll('.model-picker-menu .model-picker-item[data-model-id]')];const last=items[items.length-1];last.scrollIntoView({block:'nearest'});
      const r=last.getBoundingClientRect(),h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);const m=document.querySelector('.model-picker-menu').getBoundingClientRect();
      return {lastReachable:!!h&&(h===last||last.contains(h)),inViewport:r.bottom<=innerHeight&&r.top>=0,menuBottom:m.bottom,vh:innerHeight};})()`);
    check('the last model is on screen and clickable', reach.lastReachable && reach.inViewport);
    await click(`.floating-input-bar[data-session-id="${id}"] .composer-model`); // 再点一次关掉
    await until(`!document.querySelector('.model-picker-menu')`, 'dropdown closed');

    // 2. 第一轮：后端名同版本，显示不变
    await send(id, '第一轮');
    await until(`sessions.get(${JSON.stringify(id)})?.codeagentActualModel === 'maas-glm-5-2-260617'`, 'first answer observed');
    await sleep(500);
    check('same-version backend name keeps the chosen model', (await chip(id)).includes(START));
    await shot('02-before-backstage-switch');
    // 后台 /model 回车选了 GLM-5.3-Auto(Volcano-MaaS)：CodeAgent 把它写进默认模型，之后回答换成 5.3 的后端名。
    fs.writeFileSync(path.join(PERSONAL, 'settings.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(PERSONAL, 'settings.json'), 'utf8')), model: SWITCHED }));
    fs.writeFileSync(ANSWER, 'maas-glm-5-3-260814');
    await send(id, '第二轮');
    await until(`sessions.get(${JSON.stringify(id)})?.codeagentActualModel === 'maas-glm-5-3-260814'`, 'second answer observed');
    await until(`document.querySelector('.floating-input-bar[data-session-id="${id}"] .composer-model')?.textContent.includes(${JSON.stringify(SWITCHED)})`, 'chip follows the backstage switch', 15000);
    check('after a backstage /model switch the chip shows the new model', true);
    await click(`.floating-input-bar[data-session-id="${id}"] .composer-model`);
    await until(`document.querySelector('.model-picker-menu .model-picker-item.current')?.dataset.modelId === ${JSON.stringify(SWITCHED)}`, 'dropdown checks the new model');
    check('the dropdown marks the new model as current', true);
    await shot('03-after-backstage-switch');
    const main = await invoke('codeagent:session-models', { sessionId: id });
    report.mainOptions = main?.options?.length;
    const pinned = await c.eval(`sessions.get(${JSON.stringify(id)}).fixedModel`);
    check('resume uses the switched model (pin follows)', pinned === SWITCHED);
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
    try { report.modelLog = fs.readFileSync(path.join(DATA, 'logs', 'codeagent-model.log'), 'utf8').split('\n').filter(Boolean).slice(-15); } catch {}
    fs.writeFileSync(path.join(OUT, PREFIX + 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: !!report.passed, checks: report.checks.length, error: report.error && report.error.split('\n')[0] }, null, 2));
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
