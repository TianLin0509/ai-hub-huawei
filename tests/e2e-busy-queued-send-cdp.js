'use strict';
// 上一条没跑完时发第二条（core/busy-queued-watch.js）的端到端：隔离 Hub、隐藏窗口、替身 Claude CLI
// （tests/fixtures/fake-claude.ps1 的 queue-test：忙一段时间，屏幕显示在跑），不连任何 AI 服务。
//   1. 从输入框发第一条 queue-test <秒> <方式>，CLI 进入忙碌；
//   2. 忙碌中从输入框再发第二条：提示「已排在终端里」；
//   3. 方式 drop（CLI 丢掉排队输入，像 Esc 中断退回）/ exit（CLI 执行前退出）：原文回到输入框、挂「确认没收到，重发」条；
//      方式 keep（CLI 照常执行）：第二条被执行，不出提示条。
// 用法：node tests/e2e-busy-queued-send-cdp.js <drop|exit|keep> [label]；HUB_ENTRY=<旧代码目录> 对照修复前。
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
const mode = process.argv[2] || 'drop';
const label = process.argv[3] || mode;
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/busy-queued');
const BUSY_SECONDS = 20;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-busy-queued-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const workspace = path.join(root, 'workspaces', 'busy');
  const fakeBin = path.join(home, 'fake-bin');
  for (const dir of [home, data, out, fakeBin, workspace, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, 'fixtures', 'fake-claude.ps1'), path.join(fakeBin, 'fake-claude.ps1'));
  fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fake-claude.ps1" %*\r\n');
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = {
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
    [pathKey]: [fakeBin, system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '',
  };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) env[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const trace = path.join(home, 'fake-claude-trace.log');
  const traceText = () => { try { return fs.readFileSync(trace, 'utf8'); } catch { return ''; } };
  const entryPath = process.env.HUB_ENTRY ? path.join(process.env.HUB_ENTRY, 'main-bootstrap.js') : undefined;
  const report = { mode, label, entry: process.env.HUB_ENTRY || 'worktree', steps: [] };
  const step = (name, value) => { report.steps.push({ name, at: Date.now(), value }); console.log(`  · ${name}: ${j(value)}`); };
  let hub = null;
  let c = null;
  const isPage = target => target.type === 'page' && /index\.html/.test(target.url);
  const until = async (expr, what, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await c.eval(expr); if (v) return v; } catch {} await sleep(300); }
    throw new Error('timeout: ' + what);
  };
  const waitFor = async (predicate, what, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (predicate()) return; await sleep(200); }
    throw new Error('timeout: ' + what);
  };
  const shot = async name => {
    const image = await c.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, `20261121-busy-queued-${label}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    step('screenshot', file);
  };
  const composer = `document.querySelector('#terminal-panel .floating-input-box')`;
  const send = async text => {
    await c.eval(`(() => { const b = ${composer}; b.focus(); return true; })()`);
    await c.send('Input.insertText', { text });
    await sleep(200);
    await c.eval(`(() => { document.querySelector('#terminal-panel .floating-input-send').click(); return true; })()`);
  };
  const ui = `(() => { const strip = document.querySelector('#terminal-panel .composer-resend-strip');
    const toasts = [...document.querySelectorAll('#gc-fork-toast, [class*="toast"]')].filter(t => t.id !== 'gc-fork-toast' || t.style.opacity !== '0').map(t => (t.textContent || '').trim()).filter(Boolean);
    return { input: (${composer}?.textContent || '').trim(), strip: strip && !strip.hidden ? strip.textContent.trim() : null, toasts: toasts.slice(-4) }; })()`;
  const second = `second-message-${mode}`;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'busy-queued-' + label, extraEnv: env, ...(entryPath ? { entryPath } : {}) });
    c = await connectFirstPage(hub, isPage);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`!!window.WorkspaceController && typeof sessions !== 'undefined'`, 'renderer ready', 90000);
    const created = await c.eval(`window.WorkspaceController.createSession('claude', { cwd: ${j(workspace)}, opts: { permissionMode: 'bypassPermissions' } }).then(s => ({ id: s.id, agentRuntime: s.agentRuntime || null }))`);
    step('session', { id: created.id.slice(0, 8), agentRuntime: created.agentRuntime });
    await waitFor(() => /SessionStart exit=0/.test(traceText()), 'fake CLI started', 60000);
    await until(`(() => { const b = ${composer}; return b && b.offsetParent !== null; })()`, 'composer visible', 60000);
    await sleep(1500);
    if (mode === 'draft') {
      // 输入框草稿：只打字不发送，界面重新载入后还在（同事反馈「重启后聊天框消失」的一种读法）。
      await c.eval(`(() => { ${composer}.focus(); return true; })()`);
      await c.send('Input.insertText', { text: 'draft-survives-reload' });
      await sleep(2000);
      await c.eval('location.reload(); true').catch(() => {});
      try { await c.close(); } catch {}
      await sleep(4000);
      c = await connectFirstPage(hub, isPage);
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await until(`typeof sessions !== 'undefined' && sessions.has(${j(created.id)})`, 'reloaded', 60000);
      await c.eval(`(async () => { if (activeSessionId !== ${j(created.id)}) await selectSession(${j(created.id)}); return true; })()`).catch(() => {});
      await until(`(() => { const b = ${composer}; return b && b.offsetParent !== null; })()`, 'composer visible after reload', 60000);
      await sleep(2500);
      const after = await c.eval(ui);
      step('after reload', after);
      report.draftKept = after.input === 'draft-survives-reload';
      await shot('draft-after-reload');
      return;
    }
    await send(`queue-test ${BUSY_SECONDS} ${mode}`);
    await waitFor(() => /UserPromptSubmit exit=0/.test(traceText()), 'first prompt submitted', 30000);
    await sleep(3000);
    report.secondSentAt = Date.now();
    await send(second);
    let hint = null;
    for (let i = 0; i < 10 && !report.queuedHint; i++) {
      await sleep(250);
      hint = await c.eval(ui);
      report.queuedHint = hint.toasts.some(t => t.includes('已排在终端里'));
    }
    step('after second send', hint);
    await shot('1-queued-hint');
    if (mode === 'keep') {
      await waitFor(() => traceText().includes('prompt: ' + second), 'second prompt executed', BUSY_SECONDS * 1000 + 30000);
      await sleep(20000);
      const end = await c.eval(ui);
      step('after keep', end);
      report.executed = true;
      report.stripShown = !!end.strip;
    } else {
      const end = Date.now() + BUSY_SECONDS * 1000 + 45000;
      let state = null;
      while (Date.now() < end) { state = await c.eval(ui).catch(() => null); if (state?.strip) break; await sleep(500); }
      step('after drop/exit', state);
      report.stripShown = !!state?.strip;
      report.inputRestored = state?.input === second;
      report.secondExecuted = traceText().includes('prompt: ' + second);
      report.noticeLatencyMs = state?.strip ? Date.now() - report.secondSentAt : null;
      await shot('2-unsent-strip');
    }
  } catch (error) {
    report.error = String(error && error.stack || error);
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    report.trace = traceText().split('\n').filter(l => /prompt:|queue-test|Stop exit|SessionEnd/.test(l));
    fs.writeFileSync(path.join(out, `20261121-busy-queued-${label}.json`), JSON.stringify(report, null, 2));
    console.log(j({ label, draftKept: report.draftKept, queuedHint: report.queuedHint, stripShown: report.stripShown, inputRestored: report.inputRestored, executed: report.executed || report.secondExecuted, error: report.error ? report.error.split('\n')[0] : null }));
    if (c) try { await c.close(); } catch {}
    if (hub) await gracefulQuit(hub, { timeoutMs: 60000 }).catch(() => {});
    if (report.error) console.log('kept for diagnosis: ' + root);
    else try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
}

main();
