'use strict';
// 黄区五项界面修复：隔离数据、假 CodeAgent、真实鼠标键盘发送，无头运行。
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/r9-ui-small/gui');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r9-ui-'));
  const data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal'), project = path.join(work, 'menu-test');
  for (const dir of [data, work, personal, project, OUT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'a00000001', expiresAt: Date.now() + 72 * 3600e3 } }));
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  const answerFile = path.join(root, 'answer.txt'); fs.writeFileSync(answerFile, 'GLM-5.2-WX-Auto');
  const command = path.join(root, 'codeagent.cmd'), router = path.join(root, 'router.cjs');
  // 旧替身的空闲帧缺公司 CLI 底栏；补上实录底栏，覆盖完整的菜单退出判据。
  fs.writeFileSync(router, `const write=process.stdout.write.bind(process.stdout);process.stdout.write=(text,...args)=>write(typeof text==='string'&&text.includes('> Anything I can assist you with?')?text+'Bypass (Cycle shift+tab) | GLM-5.2-WX-Auto\\r\\n':text,...args);require(${JSON.stringify(path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent-fake.js'))});`);
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${router}" %*\r\n`);
  const report = { checks: [], root };
  let hub, c;
  const until = async (expression, label, timeout = 45000) => {
    const deadline = Date.now() + timeout; let last;
    while (Date.now() < deadline) { last = await c.eval(expression); if (last) return last; await sleep(150); }
    throw new Error(`超时 ${label}: ${JSON.stringify(last)}`);
  };
  const invoke = (name, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(name)},${JSON.stringify(payload)})`);
  const terminalInput = (id, text) => c.eval(`require('electron').ipcRenderer.send('terminal-input',${JSON.stringify({ sessionId: id, data: text })})`);
  async function click(selector) {
    const xy = await until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`, selector);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...xy, button: 'left', clickCount: 1 });
  }
  async function shot(name) {
    const result = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(result.data, 'base64'));
  }
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), label: 'r9-ui-small', windowMode: 'hidden', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_SERVE: '1', CODEAGENT_POOL_FAKE_HELP_SETTINGS: '1',
      CODEAGENT_POOL_FAKE_ANSWER_MODEL_FILE: answerFile,
      CODEAGENT_POOL_FAKE_MODELS: 'GLM-5.2-WX-Auto,DeepSeek-V4.1', CODEAGENT_POOL_FAKE_MENU_SELECT: '1',
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0',
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof window.__hubOpenConfigModal === "function"', '渲染就绪', 60000);
    await c.eval('window.__hubOpenConfigModal()');
    await click('#cfg-tab-advanced'); await sleep(500);
    report.layout = await c.eval(`(()=>{const modal=document.querySelector('#config-modal');const b=document.querySelector('#config-save').getBoundingClientRect();return {saveVisible:b.top>=0&&b.bottom<=innerHeight,scroll:[modal,...modal.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&/(auto|scroll)/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+2}).map(e=>e.id),hintCount:modal.querySelectorAll('[data-cfg-tab="advanced"] .field-hint-icon:not([hidden])').length}})()`);
    assert.equal(report.layout.saveVisible, true); assert.deepEqual(report.layout.scroll, []); assert.equal(report.layout.hintCount, 2);
    await shot('01-advanced'); await click('#config-close'); report.checks.push('1440×900 高级页无滚动，保存可见，两项长说明为悬停提示');
    await invoke('codeagent-pool:probe', { id: 'personal' });
    const catalogFile = path.join(data, 'codeagent-pool/personal-models.json');
    await until(`require('fs').existsSync(${JSON.stringify(catalogFile)})`, '模型目录');
    // 给替身目录补真实报告中的窗口大小，检查真实下拉和精确值悬停提示。
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    require('../core/codeagent-model-probe').writeProbed(catalogFile, { source: 'serve', models: catalog.models,
      details: catalog.models.map((id, i) => ({ id, contextWindow: i ? 409600 : 202752 })) });
    const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd: project, title: '菜单状态回归', codeagentAccount: 'personal' } });
    assert.ok(created?.id, JSON.stringify(created)); const id = created.id;
    await c.eval(`selectSession(${JSON.stringify(id)})`);
    const box = `.floating-input-bar[data-session-id="${id}"] .floating-input-box`;
    await until(`!!document.querySelector(${JSON.stringify(box)})`, '输入框');
    await sleep(2000);
    await click(`.floating-input-bar[data-session-id="${id}"] .composer-model`);
    await until(`document.querySelectorAll('.model-picker-context').length === 2`, '模型上下文');
    report.context = await c.eval(`[...document.querySelectorAll('.model-picker-context')].map(e=>({text:e.textContent,title:e.closest('.model-picker-item').title}))`);
    assert.deepEqual(report.context.map(e => e.text), ['203K ctx', '410K ctx']);
    assert.match(report.context[0].title, /202,752 tokens/);
    await shot('02-model-context');
    await click(`.floating-input-bar[data-session-id="${id}"] .composer-model`);
    report.checks.push('真实模型下拉显示 203K / 410K，悬停保留 202,752 tokens 精确值');
    await terminalInput(id, '/model'); await sleep(150); await terminalInput(id, '\r');
    await until(`sessions.get(${JSON.stringify(id)})._ptyRuntimeReason === 'codeagent-model-menu'`, '菜单等待状态');
    assert.equal(await c.eval(`getSessionRuntimeTruth(sessions.get(${JSON.stringify(id)})).state`), 'waiting');
    assert.equal(await c.eval(`document.querySelector('.floating-input-bar[data-session-id="${id}"] .floating-input-stop').classList.contains('visible')`), false);
    await click(box); await c.send('Input.insertText', { text: '菜单开着时保留这条原文' });
    for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(`!document.querySelector('.floating-input-bar[data-session-id="${id}"] .composer-resend-strip').hidden`, '重发提示');
    report.notice = await c.eval(`({text:document.querySelector('.composer-resend-msg').textContent,draft:document.querySelector(${JSON.stringify(box)}).innerText,toasts:[...document.querySelectorAll('.toast')].map(e=>e.textContent).filter(t=>/消息未发送|消息没发出去/.test(t))})`);
    assert.match(report.notice.text, /模型选择界面/); assert.doesNotMatch(report.notice.text, /。。/);
    assert.match(report.notice.draft, /保留这条原文/); assert.deepEqual(report.notice.toasts, []);
    await until(`getSessionRuntimeTruth(sessions.get(${JSON.stringify(id)})).state === 'waiting'`, '未发送后仍等待菜单');
    await shot('02-menu-unsent'); report.checks.push('原生菜单为等待输入，停止键隐藏；界面发送保留原文，只显示一条重发提示，无双句号');
    await terminalInput(id, '\x1b');
    await until(`['idle','completed'].includes(getSessionRuntimeTruth(sessions.get(${JSON.stringify(id)})).state)`, '退出菜单恢复');
    assert.notEqual(await c.eval(`sessions.get(${JSON.stringify(id)}).status`), 'running');
    report.checks.push('Esc 退出菜单后恢复非工作状态'); report.ok = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.error = error.stack;
    if (c) {
      report.diagnostic = await c.eval(`typeof sessions==='undefined'?null:[...sessions.values()].map(s=>({status:s.status,truth:s.runtimeTruth,pty:s._ptyRuntimeReason,card:s.cardWorkingSource,screen:terminalActivityMonitor.extractLiveScreenLines(s.id)}))`).catch(() => null);
      await shot('failure').catch(() => {});
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    c?.close(); if (hub) await gracefulQuit(hub);
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
