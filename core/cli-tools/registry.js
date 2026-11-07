'use strict';
// Hub 自己装的 CLI 放在哪、装了哪一版（2026-11-07，CLI 一键安装）。
//
// 目录：<数据目录>/tools/<组件>/<版本>/，记录在 <数据目录>/tools/installed.json。
// 检测顺序里 Hub 装的永远排在最后：用户自己装过（PATH、npm 全局、官方安装器的默认目录）就用用户的，
// Hub 装的只在这台电脑上找不到别的时才顶上。这里只读文件、不起进程，检测和建会话时随时可以调。
const fs = require('fs');
const path = require('path');
const os = require('os');

const IDS = ['claude', 'codex', 'dsh', 'node'];
const DSH_RUNTIME_FILES = ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-harness-tui/dsh-tui/package.json'];

function toolsRoot(env = process.env) {
  // 测试用 AI_HUB_CLI_TOOLS_DIR 指到临时目录；否则跟随 Hub 数据目录（隔离测试的 CLAUDE_HUB_DATA_DIR 也认）。
  if (env.AI_HUB_CLI_TOOLS_DIR) return path.resolve(env.AI_HUB_CLI_TOOLS_DIR);
  const dataDir = (env.CLAUDE_HUB_DATA_DIR && String(env.CLAUDE_HUB_DATA_DIR).trim()) || require('../data-dir').getHubDataDir();
  return path.join(dataDir, 'tools');
}
function installedFile(root) { return path.join(root, 'installed.json'); }

function inside(root, rel) {
  const full = path.resolve(root, ...String(rel).split('/'));
  return full.startsWith(path.resolve(root) + path.sep) ? full : null;
}

// installed.json 按 (大小, 修改时间) 记住：检测会被频繁调用，不必每次都解析。
let memo = null;
function readInstalled(root) {
  let st;
  try { st = fs.statSync(installedFile(root)); } catch { return { schema: 1, tools: {} }; }
  if (memo && memo.root === root && memo.size === st.size && memo.mtimeMs === st.mtimeMs) return memo.value;
  let value = { schema: 1, tools: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(installedFile(root), 'utf8').replace(/^﻿/, ''));
    if (raw && raw.schema === 1 && raw.tools && typeof raw.tools === 'object') {
      for (const id of IDS) {
        const t = raw.tools[id];
        if (t && typeof t.version === 'string' && typeof t.dir === 'string' && inside(root, t.dir)) value.tools[id] = t;
      }
    }
  } catch (_) { /* 记录坏了就当没装过；重新安装会覆盖它 */ }
  memo = { root, size: st.size, mtimeMs: st.mtimeMs, value };
  return value;
}

function writeInstalled(root, value) {
  fs.mkdirSync(root, { recursive: true });
  const file = installedFile(root);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ schema: 1, tools: value.tools || {} }, null, 2), 'utf8');
  try { fs.renameSync(temp, file); } finally { try { fs.rmSync(temp, { force: true }); } catch (_) {} }
  memo = null;
}

const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };

// 一个 Hub 装的组件：目录、主程序、要加进 PATH 的目录。目录或主程序不在了就当没装。
function managed(id, env = process.env) {
  const root = toolsRoot(env);
  const t = readInstalled(root).tools[id];
  if (!t) return null;
  const dir = inside(root, t.dir);
  if (!dir) return null;
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  const bin = t.bin ? inside(dir, t.bin) || null : null;
  if (t.bin && (!bin || !isFile(bin))) return null;
  if (id === 'dsh' && !DSH_RUNTIME_FILES.every(file => fs.existsSync(path.join(dir, 'node_modules', file)))) return null;
  const pathDirs = (Array.isArray(t.pathDirs) && t.pathDirs.length ? t.pathDirs : bin ? [path.relative(dir, path.dirname(bin)) || '.'] : [])
    .map(rel => rel === '.' || rel === '' ? dir : inside(dir, rel)).filter(Boolean);
  return { id, version: t.version, dir, bin, pathDirs, installedAt: t.installedAt || null };
}
function managedBin(id, env) { const m = managed(id, env); return m && m.bin; }
function managedDshRoot(env) { const m = managed('dsh', env); return m ? m.dir : null; }

// findCommand（core/community-setup.js）在用户自己的目录之后再看这些。
function managedSearchDirs(command, env = process.env) {
  const id = { claude: 'claude', node: 'node' }[command];
  const m = id ? managed(id, env) : null;
  return m ? m.pathDirs : [];
}

function pathKey(env) { return Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH'; }
function pathDirs(env) { return String(env[pathKey(env)] || '').split(path.delimiter).map(d => d.trim().replace(/^"|"$/g, '')).filter(Boolean); }
function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function prependPath(env, dirs) {
  const have = pathDirs(env);
  const add = dirs.filter(d => !have.some(h => samePath(h, d)));
  if (add.length) { const key = pathKey(env); env[key] = [...add, env[key] || ''].filter(Boolean).join(path.delimiter); }
  return add;
}

// 用户自己装的 Claude Code：PATH 里的 claude.exe / claude.cmd、npm 全局、官方安装器的 ~/.local/bin。
function userClaude(env) {
  const dirs = pathDirs(env);
  for (const dir of dirs) for (const name of ['claude.exe', 'claude.cmd']) if (isFile(path.join(dir, name))) return { dir, onPath: true };
  const extra = [env.APPDATA ? path.join(env.APPDATA, 'npm') : null, path.join(env.USERPROFILE || os.homedir(), '.local', 'bin')].filter(Boolean);
  for (const dir of extra) for (const name of ['claude.exe', 'claude.cmd']) if (isFile(path.join(dir, name))) return { dir, onPath: false };
  return null;
}

// 新会话的 PATH（core/session-manager.js 建会话环境时调）：终端里直接输入 claude / codex，
// 只有本机没有用户自己的安装时才把 Hub 装的目录放到最前面；用户的装在不在 PATH 上都不动它的顺序。
function applySessionPath(sessionEnv, { platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  const added = [];
  const claude = managed('claude', sessionEnv);
  if (claude && !userClaude(sessionEnv)) added.push(...prependPath(sessionEnv, claude.pathDirs));
  const codex = managed('codex', sessionEnv);
  if (codex) {
    const found = require('../../main/codex-windows-command').locateWindowsCodex(sessionEnv);
    if (found && found.source === 'hub-tools') added.push(...prependPath(sessionEnv, codex.pathDirs));
  }
  return added;
}

module.exports = { IDS, DSH_RUNTIME_FILES, toolsRoot, readInstalled, writeInstalled, managed, managedBin, managedDshRoot,
  managedSearchDirs, applySessionPath, prependPath, userClaude };
