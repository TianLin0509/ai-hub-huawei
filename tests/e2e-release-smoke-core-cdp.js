'use strict';
// 发版冒烟·核心路径（2026-11-23）：一个隔离 Hub（隐藏窗口、临时数据目录与 HOME、替身 CLI，不连任何模型）里
// 按用户每天必走的顺序用真实鼠标键盘走一遍，任何一步坏了就失败并写明是哪一步：
//   1. 首页：界面起来、主页「新建会话」按钮可点、没有界面脚本报错；
//   2. 设置：菜单 → 设置 打开，页签逐个能切，关掉回主页；
//   3. 新建普通会话：主页「新建会话」→ 选 Claude Code → 创建 → 输入框打字按回车 → 替身 CLI 收到这句并回复；
//   4. 问问 Hub：底栏按钮打开答疑面板 → 打字发送 → 替身 CodeAgent 的回答出现在面板里。
// 由 scripts/release-smoke.js 调度；也可单独跑：node tests/e2e-release-smoke-core-cdp.js
// 失败截图与日志写到 HUB_E2E_ARTIFACT_DIR（默认系统临时目录下新建的子目录）。
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-release-smoke-'));
  const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(root, 'artifacts'));
  const home = path.join(root, 'home'), data = path.join(root, 'data'), work = path.join(root, 'workspaces'), fakeBin = path.join(home, 'fake-bin');
  for (const dir of [out, home, data, work, fakeBin, path.join(root, 'scan'), path.join(root, 'personal'), path.join(root, 'empty'),
    path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(data, 'optional-features.json'), j({ assistant: false, forum: false }));
  fs.copyFileSync(path.join(REPO, 'tests/fixtures/fake-claude.ps1'), path.join(fakeBin, 'fake-claude.ps1'));
  fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fake-claude.ps1" %*\r\n');
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = {
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: work,
    // node 给替身 CodeAgent 用；其余只留系统目录，免得找到本机真实 CLI
    [pathKey]: [fakeBin, path.dirname(process.execPath), system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/help-ask-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'),
    AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), AI_HUB_HELP_ASK_ENGINE: 'codeagent',
    CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '',
    HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
  };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) env[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const trace = path.join(home, 'fake-claude-trace.log');
  const traceText = () => { try { return fs.readFileSync(trace, 'utf8'); } catch { return ''; } };

  const report = { ok: false, root, out, steps: [], rendererErrors: [] };
  let step = '启动';
  const pass = name => { report.steps.push({ name, ok: true, at: Date.now() }); console.log('PASS ' + name); };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'release-smoke-core', extraEnv: env });
    c = await connectFirstPage(hub, t => t.type === 'page' && /index\.html/.test(t.url));
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') report.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* 非 JSON 帧 */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, what, ms = 30000) => {
      let last; for (const end = Date.now() + ms; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch (e) { last = e.message; } await sleep(200); }
      throw Error(`等待超时：${what}${last ? '（' + last + '）' : ''}`);
    };
    // 真实鼠标点在控件中心；被别的元素盖住就算失败（用户点不到）
    const click = async selector => {
      const xy = await until(`(()=>{const e=document.querySelector(${j(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return r.width&&r.height&&(h===e||e.contains(h))?{x,y}:null})()`, '可点击 ' + selector);
      // 面板滑入等动画中坐标会变：两次读到的位置一致才点
      let at = xy;
      for (let i = 0; i < 20; i++) {
        await sleep(80);
        const again = await c.eval(`(()=>{const r=document.querySelector(${j(selector)})?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`);
        if (again && Math.abs(again.x - at.x) < 1 && Math.abs(again.y - at.y) < 1) break;
        at = again || at;
      }
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...at });
    };
    const enter = async () => {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    };

    step = '1 首页';
    await until(`typeof selectSession==='function' && !!window.LaunchCenter && document.readyState==='complete'`, '界面就绪', 90000);
    await click('#btn-home');
    await until(`document.querySelector('#home-create-session')?.getBoundingClientRect().width>0`, '主页新建会话按钮');
    assert.deepEqual(report.rendererErrors, [], '首页加载时界面脚本报错');
    pass(step);

    step = '2 设置页';
    await click('#btn-options');
    await until(`document.getElementById('options-settings')?.getBoundingClientRect().width>0`, '菜单展开');
    await click('#options-settings');
    await until(`!document.getElementById('config-modal').classList.contains('hidden') && !document.getElementById('config-save').disabled`, '设置弹窗打开');
    const tabs = await c.eval(`[...document.querySelectorAll('#cfg-tabs [data-cfg-tab-btn]')].filter(b=>!b.hidden).map(b=>b.dataset.cfgTabBtn)`);
    assert.ok(tabs.length >= 3, '设置页签少于 3 个：' + j(tabs));
    for (const tab of tabs) {
      await click(`#cfg-tab-${tab}`);
      await until(`document.querySelector('#cfg-tab-${tab}')?.getAttribute('aria-selected')==='true' || document.querySelector('#cfg-tab-${tab}')?.classList.contains('active')`, '切到页签 ' + tab, 5000);
    }
    await click('#config-close');
    await until(`document.getElementById('config-modal').classList.contains('hidden')`, '设置关闭');
    pass(step);

    step = '3 新建普通会话并发出';
    await click('#btn-home');
    await click('#home-create-session');
    await click('.new-session-option[data-kind="claude"]');
    // 公司版默认卡是经 CodeAgent 中转的公司模型；冒烟没有真 CodeAgent，点「沿用本机 CLI 配置」（有这张卡时）
    const own = '#new-session-model-cards [data-model-card="own"]';
    // 模型卡在选中工具后异步渲染（容器渲染前是隐藏的，不能拿可见性判断「没有卡」）：最多等 20 秒
    const hasOwn = await until(`!!document.querySelector(${j(own)})`, '「沿用本机 CLI 配置」模型卡', 20000).catch(() => false);
    if (hasOwn) {
      await click(own);
      await until(`document.querySelector(${j(own)})?.getAttribute('aria-checked')==='true'`, '选中沿用本机 CLI 配置', 5000);
    }
    await until(`document.querySelector('#new-session-submit')?.textContent.trim()==='创建会话'`, '创建按钮');
    const before = await c.eval(`ipcRenderer.invoke('get-sessions').then(s=>s.length)`);
    await click('#new-session-submit');
    await until(`ipcRenderer.invoke('get-sessions').then(s=>s.length>${before})`, '会话已创建');
    const composer = `document.querySelector('#terminal-panel .floating-input-box')`;
    await until(`(()=>{const b=${composer};return b&&b.offsetParent!==null})()`, '会话输入框出现', 45000);
    for (const end = Date.now() + 90000; !/SessionStart exit=0/.test(traceText());) { if (Date.now() > end) throw Error('替身 CLI 没起来'); await sleep(300); }
    await sleep(1200);
    const ping = 'smoke-ping-' + Date.now();
    await click('#terminal-panel .floating-input-box');
    await c.send('Input.insertText', { text: ping });
    await enter();
    for (const end = Date.now() + 30000; !traceText().includes('prompt: ' + ping);) { if (Date.now() > end) throw Error('回车后 CLI 没收到这句（输入框按回车没发出去）'); await sleep(300); }
    await until(`!${composer}.textContent.trim()`, '发送后输入框清空', 10000);
    await until(`document.querySelector('#terminal-panel')?.textContent.includes(${j('FAKE-REPLY: ' + ping)})`, '回复显示在会话里', 45000);
    pass(step);

    step = '4 问问 Hub';
    await click('#btn-help-ask');
    await until(`document.querySelector('#help-ask-panel textarea')?.getBoundingClientRect().width>0`, '答疑面板打开');
    await click('#help-ask-panel textarea');
    await c.send('Input.insertText', { text: '回车键在哪设置？' });
    await click('#help-ask-panel [data-ha="send"]');
    await until(`document.querySelector('#help-ask-panel')?.textContent.includes('测试替身')`, '答疑回答出现', 60000);
    assert.ok(await c.eval(`document.querySelector('#help-ask-panel').textContent.includes('已收到说明书')`), '答疑没带上使用说明书');
    pass(step);

    assert.deepEqual(report.rendererErrors, [], '走完核心路径后界面脚本有报错');
    report.ok = true;
  } catch (error) {
    report.failedStep = step;
    report.error = error.stack || String(error);
    if (c) { try { fs.writeFileSync(path.join(out, 'release-smoke-core-failure.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* 尽力截图 */ } }
    console.error(`FAIL ${step}: ${error.message}`);
  } finally {
    try { await c?.close(); } catch { /* 已关 */ }
    if (hub) { try { report.exit = await gracefulQuit(hub); } catch (e) { report.exitError = e.message; if (report.ok) { report.ok = false; report.failedStep = '退出时 Hub 没收干净'; console.error('FAIL 退出时 Hub 没收干净：' + e.message); } } try { fs.writeFileSync(path.join(out, 'release-smoke-core-hub.log'), hub.log().join('\n')); } catch { /* 无日志 */ } }
    try { fs.writeFileSync(path.join(out, 'release-smoke-core.json'), JSON.stringify(report, null, 2)); } catch { /* 目录不可写 */ }
    console.log(JSON.stringify({ ok: report.ok, failedStep: report.failedStep || null, steps: report.steps.length, out }));
  }
  if (!report.ok) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
