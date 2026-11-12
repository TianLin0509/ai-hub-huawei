'use strict';
// the Hub extracts the fields it needs. Runs without Python or Node on PATH.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { normalizeHookPayload } = require('../core/hook-payload');

const RELAY = path.join(__dirname, '..', 'scripts', 'session-hub-hook.ps1');
const SYSTEM_PATH = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')].join(';');

function capture() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.end('{}'); });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port })));
}

function relay(event, stdin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RELAY, event],
      { env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`relay exit ${code}: ${stderr}`))));
    child.stdin.end(stdin);
  });
}

test('relay forwards raw payloads and the Hub extracts the hook fields', { skip: process.platform !== 'win32' }, async () => {
  const hub = await capture();
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = { ...process.env, [pathKey]: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), CLAUDE_HUB_SESSION_ID: 'hub-1', CLAUDE_HUB_TOKEN: 'tok', CLAUDE_HUB_PORT: String(hub.port) };
  const shell = require('../core/windows-powershell');
  assert.ok(path.isAbsolute(shell.windowsPowerShellPath(env)));
  shell.ensurePowerShellPath(env);
  const patchedPath = env[pathKey]; shell.ensurePowerShellPath(env);
  assert.equal(env[pathKey], patchedPath, '补充 PATH 不重复添加目录');
  try {
    const payload = { session_id: 'cc-1', prompt: '你好，继续 😀', transcript_path: 'C:\\t\\a.jsonl', cwd: 'C:\\work' };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    await relay('prompt', raw, env);
    assert.equal(hub.received.length, 1);
    const [request] = hub.received;
    assert.equal(request.url, '/api/hook-raw/prompt');
    assert.ok(request.body.equals(raw), 'payload bytes are unchanged');
    const body = normalizeHookPayload('prompt', request.body, { sessionId: request.headers['x-hub-session'], token: request.headers['x-hub-token'] });
    assert.deepEqual(body, { sessionId: 'hub-1', token: 'tok', claudeSessionId: 'cc-1', cwd: 'C:\\work',
      transcriptPath: 'C:\\t\\a.jsonl', prompt: '你好，继续 😀', backgroundTasks: [], sessionCrons: [] });
  } finally { hub.server.close(); }
});

test('精简 PATH 下仍可读注册表环境和异步检查系统 PowerShell', { skip: process.platform !== 'win32' }, async () => {
  const { execFileSync } = require('node:child_process');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const core = name => JSON.stringify(path.join(__dirname, '..', 'core', name));
  const script = `(async () => {
    const config = require(${core('codeagent-config')});
    const result = await config.readPersistentEnv('Path');
    if (result.error) throw new Error(result.error);
    const setup = await require(${core('community-setup')}).inspectSetupAsync({ packaged: true });
    if (!setup.requirements.powershell || !setup.powershellPolicy?.ok) throw new Error('PowerShell unavailable: ' + JSON.stringify(setup.powershellPolicy));
  })().catch(error => { console.error(String(error && error.message || error)); process.exitCode = 1; });`;
  // 带上 pwsh 7 的模块目录，模拟从 pwsh 7 终端或 CI 拉起：5.1 不能因此读不到注册表或误报策略拦截
  const pwsh7Modules = 'C:\\Program Files\\PowerShell\\7\\Modules';
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), windowsHide: true,
      env: { ...process.env, [pathKey]: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
        PSModulePath: [pwsh7Modules, process.env.PSModulePath].filter(Boolean).join(';') }, timeout: 45000, stdio: 'pipe' });
  } catch (error) { assert.fail(String(error.stderr || error.message)); }
});

test('起 Windows PowerShell 5.1 时去掉 PSModulePath，其余环境不变', () => {
  const { windowsPowerShellEnv } = require('../core/windows-powershell');
  const env = { Path: 'X', PSModulePath: 'D:/pwsh-7/Modules', psmodulepath: 'dup', HOME: 'h' };
  assert.deepEqual(windowsPowerShellEnv(env), { Path: 'X', HOME: 'h' });
  assert.equal(env.PSModulePath, 'D:/pwsh-7/Modules', '不改调用方的环境');
});

test('large tool output is truncated like the original hook', () => {
  const body = normalizeHookPayload('tool-complete', JSON.stringify({ tool_name: 'Read', tool_response: '中'.repeat(5000) }), { sessionId: 's', token: 't' });
  assert.ok(Buffer.byteLength(body.toolResult, 'utf8') <= 6000);
  assert.ok(body.toolResult.endsWith('…'));
  assert.equal(normalizeHookPayload('tool-use', '{}', { sessionId: 's' }), null);
});
