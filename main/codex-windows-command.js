'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// Where the Codex CLI on this Windows machine lives. Every entry point that starts
// Codex (account check and login, App Server, usage, PTY sessions, first-run
// detection) goes through this one lookup so "installed" and "can start" never disagree.
//
// Order:
//   1. CODEX_INSTALL_DIR\codex.exe       an explicitly chosen native install
//   2. %APPDATA%\npm\codex.cmd           the npm install (previous sole behaviour)
//   3. PATH, in order                    codex.exe = native, codex.cmd = npm shim
//   4. %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe
//                                        the official native installer's default,
//                                        found even before a new PATH reaches this process
function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function pathDirs(env) {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  return String(env[pathKey] || '').split(path.delimiter).map(dir => dir.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

// 2026-11-20 起改为问定位中心（core/harness-locator）：顺序同上，另外认注册表里最新的 PATH、.npmrc 的 prefix、pnpm / volta / nvm / fnm；
// 有试跑过的结论时用试跑通过的那份。返回值的形状不变：.exe → native，.cmd/.bat 命令壳 → npm。
const SOURCE_NAMES = { 'env-override': 'CODEX_INSTALL_DIR', 'npm-prefix': 'APPDATA', path: 'PATH', official: 'official-installer', 'hub-managed': 'hub-tools' };
function locateWindowsCodex(env = process.env) {
  let list = null;
  try { list = require('../core/harness-locator').quickAll('codex', { env, platform: 'win32' }); }
  catch (error) { console.warn('[codex] 定位中心不可用，改用旧的查找：' + error.message); }
  if (list) {
    for (const c of list) {
      const source = SOURCE_NAMES[c.source] || c.source;
      if (/\.exe$/i.test(c.path)) return { kind: 'native', command: c.path, source };
      if (/\.(?:cmd|bat)$/i.test(c.path)) return { kind: 'npm', shim: c.path, source };
      // 只有 codex.ps1、或只在 npm 目录的 node_modules 里找到包（没有命令壳）：直接用定位中心解析好的启动命令（包里自带的 codex.exe），
      // 和体检试跑的是同一条；不经 PowerShell 跑 .ps1。
      const launch = launchOf(c, env);
      if (launch) return { kind: 'native', command: launch.command, args: launch.args || [], env: launch.env, source, via: c.path };
    }
    return null;
  }
  return locateWindowsCodexLegacy(env);
}
function launchOf(cand, env) {
  if (!cand.form || !['node', 'native'].includes(cand.form.kind)) return null;
  try {
    const launch = require('../core/harness-locator').get().launchFor('codex', cand, { env });
    return launch && launch.command && !launch.shell && !launch.pending ? launch : null;
  } catch { return null; }
}
function locateWindowsCodexLegacy(env) {
  if (env.CODEX_INSTALL_DIR) {
    const explicit = path.join(env.CODEX_INSTALL_DIR, 'codex.exe');
    if (isFile(explicit)) return { kind: 'native', command: explicit, source: 'CODEX_INSTALL_DIR' };
  }
  const npmShim = path.join(env.APPDATA || '', 'npm', 'codex.cmd');
  if (env.APPDATA && isFile(npmShim)) return { kind: 'npm', shim: npmShim, source: 'APPDATA' };
  for (const dir of pathDirs(env)) {
    const exe = path.join(dir, 'codex.exe');
    if (isFile(exe)) return { kind: 'native', command: exe, source: 'PATH' };
    const shim = path.join(dir, 'codex.cmd');
    if (isFile(shim)) return { kind: 'npm', shim, source: 'PATH' };
  }
  if (env.LOCALAPPDATA) {
    const official = path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (isFile(official)) return { kind: 'native', command: official, source: 'official-installer' };
  }
  // 5. Hub 一键安装的（<数据目录>/tools/codex/<版本>/bin/codex.exe，core/cli-tools）：前面都没有时才用。
  let hub = null;
  try { hub = require('../core/cli-tools/registry').managedBin('codex', env); } catch (_) {}
  if (hub) return { kind: 'native', command: hub, source: 'hub-tools' };
  return null;
}

// Resolve the binary belonging to the selected npm shim, never another PATH version.
// The npm JS wrapper spawns a console process without windowsHide on Windows.
function resolveNpmShim(env, shim, options = {}) {
  const match = fs.readFileSync(shim, 'utf8').match(/"([^"\r\n]*[\\/]bin[\\/]codex(?:-managed)?\.js)"/i);
  if (!match) throw new Error('无法解析 Codex npm 启动器：' + shim);
  return resolveCodexScript(env, match[1].replace(/%~?dp0%?/gi, path.dirname(shim) + path.sep), options);
}
// npm / pnpm / volta 装的 Codex：实现在 core/harness-locator/codex-npm.js（定位中心和这里共用）。
function resolveCodexScript(env, script, options = {}) { return require('../core/harness-locator/codex-npm').resolveCodexScript(env, script, options); }

function resolveWindowsCodex(env = process.env, options = {}) {
  if (options.shim) return resolveNpmShim(env, options.shim, options);
  const found = locateWindowsCodex(env);
  if (!found) throw new Error('未找到 Codex CLI：请安装官方 Codex（原生安装器或 npm），装好后重新检测。');
  if (found.kind === 'npm') return resolveNpmShim(env, found.shim, options);
  if (found.via) return { command: found.command, args: found.args || [], env: found.env || { ...env } };
  // The official native installer ships a self-contained codex.exe; run it as-is.
  const launchEnv = { ...env };
  // Hub 装的 Codex：和 npm 版一样把自带的 rg 等工具目录（codex-path）放进 PATH。
  if (found.source === 'hub-tools') {
    const tools = require('../core/cli-tools/registry');
    const managed = tools.managed('codex', env);
    if (managed) tools.prependPath(launchEnv, managed.pathDirs);
  }
  return { command: found.command, args: [], env: launchEnv };
}

// A PTY types `codex` into PowerShell. Put the selected installation first so
// its executable is the same one checked for capabilities, including an APPDATA
// npm shim selected ahead of another native binary already present on PATH.
function ensureCodexOnSessionPath(sessionEnv) {
  const found = locateWindowsCodex(sessionEnv);
  if (!found || found.source === 'PATH') return false;
  const dir = path.dirname(found.kind === 'npm' ? found.shim : found.command);
  const pathKey = Object.keys(sessionEnv).find(key => key.toLowerCase() === 'path') || 'PATH';
  sessionEnv[pathKey] = dir + path.delimiter + (sessionEnv[pathKey] || '');
  return true;
}

module.exports = { resolveWindowsCodex, locateWindowsCodex, ensureCodexOnSessionPath, resolveCodexScript };
