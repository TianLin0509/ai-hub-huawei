'use strict';
// 在本机找一个能用的 Node.js（DSH 等 Node 程序靠它运行）。2026-11-12。
//
// 起因：一台黄区电脑上 Node 装在 C:\Program Files\nodejs，CodeAgent 也自带一份 Node 24，
// 但系统 PATH 后来被改掉、不再含 nodejs 目录；Hub 原先只看 PATH，于是 DSH 报「需要本机的 Node.js」。
// 现在按下面的顺序找，找到版本够的就用，各功能（启动 DSH、一键安装、环境体检）共用这一份结果：
//   1. 当前进程 PATH；
//   2. 常见安装目录：Program Files\nodejs、用户级 Programs\nodejs、nvm、scoop；
//   3. CodeAgent 自带的 Node（安装目录下的 node\ 或 node-v*\）；
// Hub 一键安装的 Node 由调用方按原来的优先级处理。只看文件、按需跑一次 `node --version`（隐藏窗口），结果按文件缓存。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXE = process.platform === 'win32' ? 'node.exe' : 'node';
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };

function envGet(env, name) {
  const key = Object.keys(env || {}).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? String(env[key] || '') : '';
}
function subdirs(dir, pattern) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && pattern.test(d.name)).map(d => path.join(dir, d.name)); }
  catch { return []; }
}
// 版本号大的排前面（node-v24.18.1 先于 node-v24.12.0；v22 目录排在 v24 之后）。
function byVersionDesc(a, b) {
  const v = s => (String(path.basename(s)).match(/\d+/g) || []).map(Number);
  const x = v(a), y = v(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  return 0;
}

function pathDirs(env) {
  return envGet(env, 'PATH').split(path.delimiter).map(d => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function codeAgentDirs(env) {
  const roots = [];
  try { const dir = require('./codeagent-config').codeagentInstallDir(env); if (dir) roots.push(dir); } catch (_) {}
  const pf = envGet(env, 'ProgramFiles');
  if (pf) roots.push(path.join(pf, 'CodeAgentCLI'));
  const out = [];
  for (const root of [...new Set(roots)]) {
    out.push(path.join(root, 'node'));
    out.push(...subdirs(root, /^node-v\d/i).sort(byVersionDesc));
  }
  return out;
}

// 候选目录（按优先级），每个目录下找 node.exe。
function candidateDirs(env = process.env) {
  const dirs = [...pathDirs(env)];
  if (process.platform === 'win32') {
    // 只用传进来的环境变量拼路径（不回退到真实主目录），隔离测试给什么环境就只看什么。
    const home = envGet(env, 'USERPROFILE');
    const appData = envGet(env, 'APPDATA'), local = envGet(env, 'LOCALAPPDATA');
    for (const pf of [envGet(env, 'ProgramFiles'), envGet(env, 'ProgramW6432'), envGet(env, 'ProgramFiles(x86)')]) {
      if (pf) dirs.push(path.join(pf, 'nodejs'));
    }
    if (local) dirs.push(path.join(local, 'Programs', 'nodejs'));
    const nvmSymlink = envGet(env, 'NVM_SYMLINK');
    if (nvmSymlink) dirs.push(nvmSymlink);
    const nvmHome = envGet(env, 'NVM_HOME') || (appData ? path.join(appData, 'nvm') : '');
    if (nvmHome) dirs.push(...subdirs(nvmHome, /^v\d/i).sort(byVersionDesc));
    if (home) dirs.push(path.join(home, 'scoop', 'apps', 'nodejs', 'current'), path.join(home, 'scoop', 'apps', 'nodejs-lts', 'current'));
    dirs.push(...codeAgentDirs(env));
  }
  const seen = new Set();
  return dirs.filter(dir => { const k = path.resolve(dir).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

const versionMemo = new Map();
function nodeMajor(file, run) {
  let st; try { st = fs.statSync(file); } catch { return 0; }
  const key = file + '|' + st.size + '|' + st.mtimeMs;
  if (!run && versionMemo.has(key)) return versionMemo.get(key);
  let out = '';
  try {
    if (run) out = String(run(file) || '');
    else {
      const r = spawnSync(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      out = String(r.stdout || '');
    }
  } catch { out = ''; }
  const major = Number((/^v?(\d+)\./.exec(out.trim()) || [])[1]) || 0;
  if (!run) versionMemo.set(key, major);
  return major;
}

// 返回第一个版本够的 node 绝对路径；找不到返回 ''。run 仅供测试替换取版本的方式。
function findNode({ env = process.env, minMajor = 22, run = null } = {}) {
  for (const dir of candidateDirs(env)) {
    const file = path.join(dir, EXE);
    if (!path.isAbsolute(file) || !isFile(file)) continue;
    if (nodeMajor(file, run) >= minMajor) return file;
  }
  return '';
}

// 给报错提示用：列出找过的几类位置。
const SEARCHED_HINT = 'PATH、C:\\Program Files\\nodejs、nvm、scoop、CodeAgent 自带的 Node';

module.exports = { findNode, candidateDirs, SEARCHED_HINT };
