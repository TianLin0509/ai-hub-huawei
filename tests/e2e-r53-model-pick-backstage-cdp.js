'use strict';
// R53：CodeAgent 会话在模型下拉里切换失败、原因是「菜单没对上」时，失败说明下面有「打开后台手动选」，点了进终端。
// 隔离 Hub + 假 CodeAgent（tests/fixtures/codeagent-pool-fake）。主进程的切换回执在页面里替换成 pick-failed / mismatch（模拟），
// 只验证界面这一段；主进程分三类的逻辑由 tests/unit-codeagent-model-picker-grouped-real.test.js 覆盖。截图 1440×900。
// R53: the model dropdown offers "open background to pick manually" when the CodeAgent menu could not be matched.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.R53_OUTPUT || 'D:/AIWork/20261125-hubh-rsi-lead2-claude/R53');
const MODELS = ['GLM-5.2-WX-Auto', 'GLM-5.3-CodeAgent-Auto', 'DeepSeek-V4.1-Flash-1017'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'r53-backstage-'));
  const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PROJECT = path.join(WORK, 'r53'), PERSONAL = path.join(ROOT, 'personal');
  for (const dir of [DATA, WORK, PROJECT, PERSONAL, OUT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(PERSONAL, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'a00000001', expiresAt: Date.now() + 72 * 3600e3 } }));
  fs.writeFileSync(path.join(PERSONAL, 'settings.json'), JSON.stringify({ model: MODELS[0] }));
  const command = path.join(ROOT, 'codeagent.cmd'), router = path.join(ROOT, 'codeagent-router.cjs');
  fs.writeFileSync(router, `require(${JSON.stringify(path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent-fake.js'))});`);
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${router}" %*\r\n`);
  const report = { checks: [], shots: [], fixture: '隔离 Hub + 假 CodeAgent；主进程切换回执在页面里模拟成 pick-failed/mismatch' };
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
    const file = path.join(OUT, `20261127-R53-${name}-1440x900.png`);
    fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    report.shots.push(file);
  }
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), label: 'r53-backstage', windowMode: 'hidden', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, AI_HUB_CODEAGENT_SERVE: '1',
      CODEAGENT_POOL_FAKE_MODELS: MODELS.join(','), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'scan'), CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0',
      CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`typeof sessions !== 'undefined' && typeof selectSession === 'function'`, 'renderer ready', 60000);
    await invoke('codeagent-pool:probe', { id: 'personal' });
    const personalFile = path.join(DATA, 'codeagent-pool', 'personal-models.json');
    for (let i = 0; i < 200; i++) { try { if ((JSON.parse(fs.readFileSync(personalFile, 'utf8')).models || []).length === MODELS.length) break; } catch { /* 还没写好 */ } await sleep(150); }
    const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd: PROJECT, title: 'R53 模型切换', codeagentAccount: 'personal' } });
    assert(created?.id, JSON.stringify(created));
    const id = created.id;
    await c.eval(`selectSession(${JSON.stringify(id)})`);
    await until(`!!document.querySelector('.floating-input-bar[data-session-id="${id}"] .composer-model:not([hidden])')`, 'model chip');
    // 模拟主进程回执：菜单没对上（mismatch），文案与 core/codeagent-model-picker.js pickFailureMessage 一致。
    await c.eval(`(() => { const ipc = require('electron').ipcRenderer, real = ipc.invoke.bind(ipc);
      ipc.invoke = (name, payload) => name === 'codeagent:switch-model' ? Promise.resolve({ ok: false, reason: 'pick-failed', pickFailure: 'mismatch',
        message: 'Hub 没能在 CodeAgent 模型菜单里自动选中 ' + payload.modelId + '（菜单没对上，不一定是账号没有这个模型）；请点「打开后台」在菜单里手动选一次' }) : real(name, payload); })()`);
    await click(`.floating-input-bar[data-session-id="${id}"] .composer-model`);
    await until(`document.querySelectorAll('.model-picker-menu .model-picker-item[data-model-id]').length >= ${MODELS.length}`, 'models listed');
    await click(`.model-picker-menu .model-picker-item[data-model-id="DeepSeek-V4.1-Flash-1017"]`);
    const note = await until(`document.querySelector('.model-picker-menu .model-picker-note[data-state="error"]')?.textContent || ''`, 'failure note');
    check(`失败说明写明「菜单没对上」：${note}`, /菜单没对上/.test(note));
    await until(`!!document.querySelector('.model-picker-menu .model-picker-backstage')`, 'backstage button');
    check('失败说明下面有「打开后台手动选」按钮', (await c.eval(`document.querySelector('.model-picker-menu .model-picker-backstage').textContent`)) === '打开后台手动选');
    await shot('pick-mismatch-backstage-button');
    await click('.model-picker-menu .model-picker-backstage');
    await until(`!document.querySelector('.model-picker-menu')`, 'dropdown closed');
    const mode = await until(`typeof currentView !== 'undefined' && currentView === 'pty' ? currentView : ''`, 'view switched to the terminal', 15000);
    report.viewMode = mode;
    check(`点按钮后关掉下拉、切到后台终端（viewMode=${mode}）`, mode === 'pty');
    await shot('pick-mismatch-backstage-opened');
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    if (c) await shot('backstage-failure').catch(() => {});
    throw error;
  } finally {
    if (c) await c.close().catch(() => {});
    if (hub) { try { report.teardown = await gracefulQuit(hub); } catch (error) { report.teardownError = error.stack; } }
    fs.writeFileSync(path.join(OUT, '20261127-R53-backstage-gui.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: !!report.passed, checks: report.checks.length, error: report.error && report.error.split('\n')[0] }, null, 2));
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 留给系统清理 */ }
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
