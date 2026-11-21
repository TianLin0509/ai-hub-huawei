'use strict';
// 界面重新载入后接回「在跑」状态（core/renderer-reload-restore.js）的端到端：隔离 Hub、隐藏窗口、替身 Claude CLI
// （tests/fixtures/fake-claude.ps1 的 slow-tool：工具连续跑 N 秒），不连任何 AI 服务。
//   1. Claude 终端会话跑工具时，主进程记下这一轮在进行（get-sessions 带 liveTurn），侧栏显示在跑；
//   2. 界面进程崩溃（与卡死自救同一条恢复路径：主进程约 1 秒后重新载入 index.html?recovered=...）；
//   3. 重新载入后这个会话仍显示在跑，工具跑完后照常收尾成「已完成」。
// 用法：node tests/e2e-reload-restore-running-cdp.js [label]；HUB_ENTRY=<旧代码目录> 对照修复前（预期第 3 步失败）。
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
const label = process.argv[2] || 'run';
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/reload-restore');
const TOOL_SECONDS = 45;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reload-restore-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const workspace = path.join(root, 'workspaces', 'reload');
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
  const report = { label, entry: process.env.HUB_ENTRY || 'worktree', steps: [] };
  const step = (name, value) => { report.steps.push({ name, value }); console.log(`  · ${name}: ${j(value)}`); };
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
  const truthExpr = q => `(async () => { const s = sessions.get(${q}); const t = getSessionRuntimeTruth(s);
    const m = (await ipcRenderer.invoke('get-sessions')).find(x => x.id === ${q});
    return { state: t.state, source: t.source, active: sessionRuntimeIsActive(s), mainLiveTurn: !!(m && m.liveTurn),
      recovered: new URLSearchParams(location.search).get('recovered') }; })()`;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'reload-restore-' + label, extraEnv: env, ...(entryPath ? { entryPath } : {}) });
    c = await connectFirstPage(hub, isPage);
    await until(`!!window.WorkspaceController && typeof sessions !== 'undefined'`, 'renderer ready', 90000);
    const created = await c.eval(`window.WorkspaceController.createSession('claude', { cwd: ${j(workspace)}, opts: { permissionMode: 'bypassPermissions' } }).then(s => ({ id: s.id, agentRuntime: s.agentRuntime || null }))`);
    const id = created.id;
    const q = j(id);
    step('session', { id: id.slice(0, 8), agentRuntime: created.agentRuntime });
    await waitFor(() => /SessionStart exit=0/.test(traceText()), 'fake CLI started', 60000);
    await sleep(1500);
    await c.eval(`ipcRenderer.send('terminal-input', { sessionId: ${q}, data: ${j(`slow-tool ${TOOL_SECONDS}\r`)} }); true`);
    await waitFor(() => /PreToolUse exit=0/.test(traceText()), 'tool started (PreToolUse hook)', 60000);
    await until(`(async () => { const r = await (${truthExpr(q)}); window.__probe = r; return r.active && (${j(!!process.env.HUB_ENTRY)} || r.mainLiveTurn); })()`, 'running before reload', 30000)
      .catch(async e => { step('probe', await c.eval('window.__probe').catch(() => null)); throw e; });
    await sleep(2000);
    step('before reload', await c.eval(truthExpr(q)));
    report.crashAt = Date.now();
    await c.send('Page.crash').catch(() => {});
    try { await c.close(); } catch {}
    await sleep(4000);
    c = await connectFirstPage(hub, isPage);
    await until(`typeof sessions !== 'undefined' && sessions.has(${q}) && new URLSearchParams(location.search).has('recovered')`, 'reloaded renderer', 60000);
    await sleep(2500);
    const after = await c.eval(truthExpr(q));
    step('after reload', after);
    report.restoredRunning = after.active === true;
    report.toolStillRunning = !/PostToolUse exit=0/.test(traceText());
    if (!report.toolStillRunning) throw new Error('tool finished before the check; raise TOOL_SECONDS');
    if (!report.restoredRunning) throw new Error('after reload the running session shows as idle');
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state === 'completed'`, 'turn completed after reload', TOOL_SECONDS * 1000 + 60000);
    step('finished', await c.eval(truthExpr(q)));
    report.completedAfterReload = true;
  } catch (error) {
    report.error = String(error && error.stack || error);
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(out, `20261121-reload-restore-${label}.json`), JSON.stringify(report, null, 2));
    console.log(j({ label, restoredRunning: report.restoredRunning, completedAfterReload: !!report.completedAfterReload, error: report.error ? report.error.split('\n')[0] : null }));
    if (c) try { await c.close(); } catch {}
    if (hub) await gracefulQuit(hub, { timeoutMs: 60000 }).catch(() => {});
    if (report.error) console.log('kept for diagnosis: ' + root);
    else try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
}

main();
