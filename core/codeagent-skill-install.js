'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const SKILL_TIMEOUT_MS = 120000;
const AGENTCENTER_URL = 'https://agent.huawei.com/ai';
const SKILL_INSTALL_LOG_MAX_BYTES = 256 * 1024;

function validSkillId(id) { return typeof id === 'string' && /^(?!-)[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/.test(id); }
function shortReason(value) { return String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 200); }
function parseSkillJson(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) if (/^\s*[\[{]/.test(lines[i])) {
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* Upgrade banner lines precede the JSON. */ }
  }
  throw new Error('技能详情不是有效 JSON');
}
function launchSkillCommand(command, args, options, { platform = process.platform, spawnImpl = spawn } = {}) {
  // Same Windows wrapper as codeagent-serve: preserves the CLI's certificate/proxy setup.
  const list = args[1] === 'list' && args.length === 3 && args[2] === '--json';
  const add = args[1] === 'add' && validSkillId(args[2]) && args.length === 5 && args[3] === '--scope' && ['global', 'project'].includes(args[4]);
  if (args[0] !== 'skills' || !(list || add)) throw new Error('不允许的技能命令参数');
  if (/[\r\n"`$;&|<>%!?^]/.test(command)) throw new Error('CodeAgent 命令包含不允许的字符');
  if (platform !== 'win32') return spawnImpl(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const head = /^[A-Za-z0-9_.-]+$/.test(command) ? command : `"${path.normalize(command)}"`;
  return spawnImpl('cmd.exe', ['/d', '/s', '/c', `"call ${head} ${args.join(' ')}"`], {
    ...options, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function runSkillCommand(command, args, options, { launch = launchSkillCommand, timeoutMs = SKILL_TIMEOUT_MS,
  setTimer = setTimeout, clearTimer = clearTimeout, terminate = child => {
    if (process.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else child.kill();
  } } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, stdout = '', stderr = '';
    const finish = (error, result) => { if (settled) return; settled = true; clearTimer(timer); if (error) reject(error); else resolve(result); };
    try { child = launch(command, args, options); } catch (error) { reject(error); return; }
    child.stdout.setEncoding?.('utf8'); child.stderr.setEncoding?.('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-2 * 1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2 * 1024 * 1024); });
    child.once('error', error => finish(Object.assign(error, { exitCode: null, stderr, timedOut: false })));
    child.once('close', code => finish(code === 0 ? null : Object.assign(new Error(shortReason(stderr || stdout) || `技能命令退出码 ${code}`),
      { exitCode: code, stderr, timedOut: false }), { stdout, stderr, exitCode: code, timedOut: false }));
    timer = setTimer(() => {
      finish(Object.assign(new Error('技能命令超时，请稍后重试'), { exitCode: null, stderr, timedOut: true }));
      try { terminate(child); } catch { /* Process already exited. */ }
    }, timeoutMs);
  });
}
function appendInstallLog(dataDir, record, { maxBytes = SKILL_INSTALL_LOG_MAX_BYTES } = {}) {
  try {
    const file = path.join(dataDir, 'logs', 'codeagent-skill-install.log'), text = JSON.stringify({
      at: record.at, operation: record.operation, scope: record.scope, exitCode: record.exitCode,
      durationMs: record.durationMs, timedOut: record.timedOut === true, stderr: shortReason(record.stderr),
    }) + '\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(text) > maxBytes) {
      fs.rmSync(file + '.1', { force: true }); fs.renameSync(file, file + '.1');
    }
    fs.appendFileSync(file, text);
  } catch { /* Diagnostics never decide whether installation succeeded. */ }
}
function createSkillInstaller({ getSession, dataDir, env = process.env, run = runSkillCommand, openExternal, now = Date.now }) {
  async function execute(current, args, scope) {
    const startedAt = now(); let execution;
    try { execution = await run(current.command, args, { cwd: current.session.cwd, env: current.env }); return execution; }
    catch (error) { execution = error; throw error; }
    finally {
      appendInstallLog(dataDir, { at: new Date(startedAt).toISOString(), operation: args[1], scope,
        exitCode: execution?.exitCode ?? null, durationMs: Math.max(0, now() - startedAt),
        timedOut: execution?.timedOut === true, stderr: execution?.stderr || '' });
    }
  }
  function context(sessionId) {
    const session = getSession(sessionId);
    if (!session || !require('./ai-kinds').isCodeAgentKind(session.kind)) throw new Error('当前会话不是可用的 CodeAgent 会话');
    const config = require('./codeagent-config').resolveCodeAgentConfig(env);
    const configDir = require('./codeagent-default-model-guard').sessionConfigDir(session, { dataDir, env });
    if (!configDir) throw new Error('未找到这个会话的 CodeAgent 配置目录');
    const childEnv = { ...env, [config.configDirEnv]: configDir };
    require('./codeagent-launch-env').applyAccountEnv(childEnv, { ...config, configDir });
    for (const key of Object.keys(childEnv)) if (/^CLAUDE_HUB_(?:SESSION_ID|PORT|TOKEN)$|^CODEAGENT_HUB_/.test(key)) delete childEnv[key];
    return { session, command: config.command, configDir, env: childEnv };
  }
  return async function action(payload = {}) {
    const startedAt = now(); let execution, attempted = false;
    try {
      const current = context(payload.sessionId);
      if (payload.op === 'browse') { await openExternal(AGENTCENTER_URL); return { ok: true }; }
      const id = payload.id;
      if (!validSkillId(id)) throw new Error('技能 ID 只允许字母、数字和 . _ - @（可用 ID@版本）');
      const cwd = current.session.cwd;
      if (!cwd) throw new Error('未找到当前会话的工作目录');
      if (payload.op !== 'add' || !['global', 'project'].includes(payload.scope)) throw new Error('不允许的技能操作或安装位置');
      attempted = true;
      await execute(current, ['skills', 'add', id, '--scope', payload.scope], payload.scope);
      let skill = { name: id };
      try {
        const listed = parseSkillJson((await execute(current, ['skills', 'list', '--json'], payload.scope)).stdout);
        if (Array.isArray(listed)) skill = listed.find(row => row.id === id || row.id === id.split('@')[0]) || skill;
      } catch { /* The add command succeeded even if the follow-up list cannot be read. */ }
      return { ok: true, skill };
    } catch (error) { if (!execution) execution = error; return { ok: false, error: shortReason(error.message) };
    } finally {
      if (payload.op === 'add' && !attempted) appendInstallLog(dataDir, { at: new Date(startedAt).toISOString(), operation: payload.op,
        scope: payload.scope === 'project' ? 'project' : 'global', exitCode: execution?.exitCode ?? null,
        durationMs: Math.max(0, now() - startedAt), timedOut: execution?.timedOut === true, stderr: execution?.stderr || '' });
    }
  };
}
module.exports = { SKILL_TIMEOUT_MS, SKILL_INSTALL_LOG_MAX_BYTES, AGENTCENTER_URL, validSkillId, shortReason, parseSkillJson, launchSkillCommand, runSkillCommand, createSkillInstaller, appendInstallLog };
