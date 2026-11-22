'use strict';
// 2026-11-20 反馈「CodeAgent 我都切了 GLM5.3，还是 DS4.1」的隔离 Hub 复现与验收。
// 假 CodeAgent（tests/fixtures/codeagent-pool-fake，CODEAGENT_POOL_FAKE_MENU_SELECT=1）照公司 CLI 的优先级回答：
// 每次请求重读 --settings 文件，文件里有 model 就用它，没有才用 /model 菜单里选的。
// Menu-only output leaves the pin unchanged. A later transcript-confirmed GLM
// answer (injected by the simulated provider) authorizes the pin/settings update.
// 不连模型。用法：node tests/e2e-codeagent-terminal-model-switch-cdp.js
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(REPO, 'artifacts', 'codeagent-terminal-model-switch'));
const DS = 'DeepSeek-V4.1-Flash-1017', GLM = 'GLM-5.3-WX-Auto';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-terminal-model-'));
  const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PROJECT = path.join(WORK, 'terminal-model'), PERSONAL = path.join(ROOT, 'personal'), ANSWER = path.join(ROOT, 'answer-model.txt');
  const runtimeModel = path.join(ROOT, 'runtime-model.txt');
  for (const dir of [DATA, WORK, PROJECT, PERSONAL, OUT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(PERSONAL, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'a00000001', expiresAt: Date.now() + 72 * 3600e3 } }));
  fs.writeFileSync(path.join(PERSONAL, 'settings.json'), JSON.stringify({ model: DS }));
  fs.writeFileSync(ANSWER, 'fixture-fallback');
  const command = path.join(ROOT, 'codeagent.cmd'), router = path.join(ROOT, 'codeagent-router.cjs');
  fs.writeFileSync(router, `require(${JSON.stringify(path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent-fake.js'))});`);
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${router}" %*\r\n`);
  const report = { checks: [], shots: [], answers: [] };
  const check = (label, condition = true) => { assert(condition, label); report.checks.push(label); console.log('PASS ' + label); };
  let hub, c;
  const until = async (expression, label, timeout = 45000) => {
    const end = Date.now() + timeout; let last;
    while (Date.now() < end) { try { last = await c.eval(expression); if (last) return last; } catch (e) { last = e.message; } await sleep(150); }
    throw new Error(`Timeout ${label}: ${JSON.stringify(last)}`);
  };
  const invoke = (name, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(name)},${JSON.stringify(payload)})`);
  const type = (id, data) => c.eval(`require('electron').ipcRenderer.send('terminal-input',${JSON.stringify({ sessionId: id, data })})`);
  async function click(selector) {
    const xy = await until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();if(!r.width||!r.height)return null;const x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return h&&(h===e||e.contains(h))?{x,y}:null})()`, 'clickable ' + selector);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...xy });
    for (const t of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type: t, ...xy, button: 'left', clickCount: 1 });
  }
  async function shot(name) {
    await sleep(250);
    const image = await c.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    report.shots.push(file);
  }
  async function send(id, text) {
    await click(`.floating-input-bar[data-session-id="${id}"] .floating-input-box`);
    await c.send('Input.insertText', { text });
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  // 原生记录里最后一条回答的模型（假 CLI 按上面的优先级写入）
  const lastAnswerModel = () => {
    const dir = path.join(PERSONAL, 'projects'); let found = '';
    for (const sub of fs.existsSync(dir) ? fs.readdirSync(dir) : []) for (const f of fs.readdirSync(path.join(dir, sub))) {
      for (const line of fs.readFileSync(path.join(dir, sub, f), 'utf8').split('\n').filter(Boolean)) {
        try { const row = JSON.parse(line); if (row.type === 'assistant' && row.message?.model) found = row.message.model; } catch {}
      }
    }
    return found;
  };
  const waitAnswer = async (n, label) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) { if (countAnswers() >= n) { const m = lastAnswerModel(); report.answers.push(m); return m; } await sleep(200); }
    throw new Error('Timeout ' + label);
  };
  const countAnswers = () => {
    const dir = path.join(PERSONAL, 'projects'); let n = 0;
    for (const sub of fs.existsSync(dir) ? fs.readdirSync(dir) : []) for (const f of fs.readdirSync(path.join(dir, sub))) n += fs.readFileSync(path.join(dir, sub, f), 'utf8').split('\n').filter(l => l.includes('"type":"assistant"')).length;
    return n;
  };
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), label: 'terminal-model-f1', windowMode: 'hidden', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, AI_HUB_CODEAGENT_SERVE: '1',
      CODEAGENT_POOL_FAKE_MODELS: [DS, GLM].join(','), CODEAGENT_POOL_FAKE_HELP_SETTINGS: '1', CODEAGENT_POOL_FAKE_ANSWER_MODEL_FILE: ANSWER,
      CODEAGENT_POOL_FAKE_RUNTIME_MODEL_FILE: runtimeModel,
      CODEAGENT_POOL_FAKE_MENU_SELECT: '1', CODEAGENT_POOL_FAKE_KEYLOG: path.join(OUT, 'fake-keys.log'),
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'scan'), CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0',
      CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`typeof sessions !== 'undefined' && typeof selectSession === 'function'`, 'renderer ready', 60000);
    await invoke('codeagent-pool:probe', { id: 'personal' });
    const personalFile = path.join(DATA, 'codeagent-pool', 'personal-models.json');
    for (let i = 0; i < 200; i++) { try { if ((JSON.parse(fs.readFileSync(personalFile, 'utf8')).models || []).length === 2) break; } catch {} await sleep(150); }
    check('serve catalog read (DeepSeek + GLM)', JSON.parse(fs.readFileSync(personalFile, 'utf8')).models.length === 2);

    const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd: PROJECT, title: '终端换模型验收', codeagentAccount: 'personal', model: DS, codeagentModelPick: true } });
    assert(created?.id, JSON.stringify(created));
    const id = created.id;
    await c.eval(`selectSession(${JSON.stringify(id)})`);
    const launchFile = path.join(DATA, 'codeagent-launch', `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    await until(`!!document.querySelector('.floating-input-bar[data-session-id="${id}"] .floating-input-box')`, 'input box');
    for (let i = 0; i < 100 && !fs.existsSync(launchFile); i++) await sleep(100);
    check('the session was launched with a --settings file pinning DeepSeek', JSON.parse(fs.readFileSync(launchFile, 'utf8')).model === DS);
    await sleep(1500);
    await send(id, '第一问');
    check('first answer uses DeepSeek', (await waitAnswer(1, 'first answer')) === DS);

    // 用户在终端里自己 /model，选第 2 项 GLM（逐键敲，和人手一样）
    await type(id, '/model'); await sleep(200); await type(id, '\r'); await sleep(600);
    await type(id, '\x1b[B'); await sleep(300); await type(id, '\r'); await sleep(1500);
    report.launchAfterSwitch = fs.readFileSync(launchFile, 'utf8');
    check('terminal output alone cannot rewrite the launch pin', JSON.parse(report.launchAfterSwitch).model === DS);
    await shot('01-after-terminal-switch');
    await send(id, '第二问');
    const second = await waitAnswer(2, 'second answer');
    report.secondAnswer = second;
    check(`the display follows the actual pinned DeepSeek answer (got ${second})`, second === DS);
    await until(`document.querySelector('.floating-input-bar[data-session-id="${id}"] .composer-actual-model')?.textContent.includes(${JSON.stringify(DS)})`, 'actual model shows DeepSeek');
    // Simulate a CLI/provider that actually switched: only its next assistant
    // record can authorize the Hub to replace the launch pin.
    fs.writeFileSync(runtimeModel, GLM);
    await send(id, '第三问');
    check('a transcript-confirmed GLM answer changes the model', (await waitAnswer(3, 'GLM record')) === GLM);
    await until(`document.querySelector('.floating-input-bar[data-session-id="${id}"] .composer-model')?.textContent.includes(${JSON.stringify(GLM)})`, 'chip shows GLM', 15000);
    check('the model chip under the input box shows GLM', true);
    check('resume keeps GLM', (await c.eval(`sessions.get(${JSON.stringify(id)}).fixedModel`)) === GLM);
    check('the launch settings now follow transcript-confirmed GLM', JSON.parse(fs.readFileSync(launchFile, 'utf8')).model === GLM);
    await until(`document.querySelector('.floating-input-bar[data-session-id="${id}"] .composer-actual-model')?.textContent.includes('终端里已切到')`, 'inline actual model notice');
    await shot('02-second-answer-glm');
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    if (c) await shot('failure').catch(() => {});
    throw error;
  } finally {
    if (c) await c.close().catch(() => {});
    if (hub) {
      try { report.teardown = await gracefulQuit(hub); } catch (error) { report.teardownError = error.stack; }
      fs.writeFileSync(path.join(OUT, 'hub.log'), hub.log().join('\n'));
    }
    try { report.modelLog = fs.readFileSync(path.join(DATA, 'logs', 'codeagent-model.log'), 'utf8').split('\n').filter(Boolean).slice(-15); } catch {}
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: !!report.passed, checks: report.checks.length, answers: report.answers, error: report.error && report.error.split('\n')[0] }, null, 2));
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
