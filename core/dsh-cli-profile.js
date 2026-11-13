'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The runtime is installed separately; Hub's shared node_modules stays intact.
const RUNTIME_FILES = ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-harness-tui/dsh-tui/package.json'];
function isRuntimeRoot(root) {
  return RUNTIME_FILES.every(file => fs.existsSync(path.join(root, 'node_modules', file)));
}

// 用户自己全局安装 DSH 可能落在的根目录（根目录下有 node_modules）。只读文件，不运行 npm。
function npmrcPrefix(file) {
  try {
    const m = /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1].replace(/^["']|["']$/g, '').replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] || '') : '';
  } catch { return ''; }
}
function userInstalledRoots(env = process.env) {
  const get = name => { const k = Object.keys(env).find(x => x.toLowerCase() === name.toLowerCase()); return k ? String(env[k] || '') : ''; };
  const roots = [];
  const home = get('USERPROFILE');
  roots.push(get('NPM_CONFIG_PREFIX'));
  if (home) roots.push(npmrcPrefix(path.join(home, '.npmrc')));
  // npm 在 Windows 上把 dsh.cmd 放在全局目录本身，模块在它下面的 node_modules。
  for (const dir of get('PATH').split(path.delimiter).map(d => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    if (['dsh.cmd', 'dsh.ps1', 'dsh'].some(name => fs.existsSync(path.join(dir, name)))) roots.push(dir, path.dirname(dir));
  }
  // Node 安装目录（含 nvm 各版本、CodeAgent 自带）：默认全局目录有时就是它；它自带的 npmrc 也可能写了 prefix。
  try {
    for (const dir of require('./local-node').candidateDirs(env)) {
      if (!fs.existsSync(path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'))) continue;
      roots.push(dir, npmrcPrefix(path.join(dir, 'node_modules', 'npm', 'npmrc')));
    }
  } catch (_) {}
  const local = get('LOCALAPPDATA');
  if (local) roots.push(path.join(local, 'pnpm', 'global', '5'));
  const seen = new Set();
  return roots.filter(r => r && path.isAbsolute(r)).filter(r => { const k = path.resolve(r).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function resolveDshCliRuntime(entry = {}, env = process.env) {
  let root = entry.cliRoot || env.AI_HUB_DSH_CLI_ROOT;
  if (!root) {
    const file = path.join(os.homedir(), '.dsh', 'hub-cli-runtime.json');
    if (fs.existsSync(file)) root = JSON.parse(fs.readFileSync(file, 'utf8')).root;
  }
  // 全局安装（npm i -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui）也认：Windows 默认装在 %APPDATA%\npm。
  if (!root && env.APPDATA && isRuntimeRoot(path.join(env.APPDATA, 'npm'))) root = path.join(env.APPDATA, 'npm');
  // 用户自己装在别处的也认（2026-11-12）：改过的 npm 全局目录、PATH 上 dsh 命令所在目录、nvm、pnpm、Node 安装目录。
  if (!root) root = userInstalledRoots(env).find(isRuntimeRoot) || root;
  // 最后才用 Hub 一键安装的运行环境（<数据目录>/tools/dsh/<版本>，core/cli-tools/registry.js）。
  if (!root) { try { root = require('./cli-tools/registry').managedDshRoot(env) || root; } catch (_) {} }
  if (!root || !path.isAbsolute(root)) throw new Error('请先安装 DSH CLI 终端运行环境');
  const modules = path.join(root, 'node_modules');
  const entryPath = path.join(modules, '@deepseek-ai/dsh/lib/bin.js');
  for (const file of [entryPath, path.join(modules, '@deepseek-harness-tui/dsh-tui/package.json')]) {
    if (!fs.existsSync(file)) throw new Error('DSH CLI 终端运行环境不完整：' + file);
  }
  return { root, modules, entryPath };
}

function buildDshCliOptions(kind, opts, config, dataDir, env) {
  const runtime = resolveDshCliRuntime(config.acp?.providers?.['deepseek-acp'], env);
  const acp = config.acp || {};
  return require('./acp-profiles').buildAcpOptions(kind, { ...opts, dshCliRuntime: runtime }, {
    ...config, acp: { ...acp, providers: { ...acp.providers,
      'deepseek-acp': { ...acp.providers?.['deepseek-acp'], entryPath: runtime.entryPath } } },
  }, dataDir, env);
}
module.exports = { resolveDshCliRuntime, buildDshCliOptions, userInstalledRoots };
