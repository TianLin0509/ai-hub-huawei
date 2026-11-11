'use strict';
// 找这台电脑上的 Git Bash（2026-11-07 用户：一键安装 Git for Windows 之前先全局找一遍，别让用户重复装）。
//
// Claude Code 在 Windows 上优先用 Git Bash 执行命令，找不到时改用 PowerShell（官方预览功能）。
// 找的顺序：
//   1. 快速查找（同步，只看固定几个位置，随时可调）：CLAUDE_CODE_GIT_BASH_PATH、各 Program Files\Git、
//      用户目录的 Programs\Git、scoop、PATH 上的 git.exe / bash.exe（排除 Windows 自带的 WSL bash）；
//   2. 深度查找（异步，起一个隐藏的 PowerShell 读注册表和本机硬盘列表）：Git 安装器写的注册表 InstallPath、
//      Visual Studio 和 GitHub Desktop 自带的 Git、每个本地硬盘根目录和常见工具目录下名字带 git 的文件夹。
//      结果记在进程里，快速查找也会用上；
//   3. 都没有才用 Hub 自己装的（<数据目录>/tools/git/<版本>/）。
// 只认「完整」的 Git Bash：bash.exe 旁边要有 ls、grep（MinGit 一类精简版只有 sh，Claude 跑不了常用命令）。
// 用户自己指定的 CLAUDE_CODE_GIT_BASH_PATH 原样信任。
const fs = require('fs');
const path = require('path');
const os = require('os');

const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const isDir = dir => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };

// <根>/bin/bash.exe 或 <根>/usr/bin/bash.exe，且 usr/bin 下有 ls、grep。
function bashIn(root) {
  if (!root) return null;
  if (!isFile(path.join(root, 'usr', 'bin', 'ls.exe')) || !isFile(path.join(root, 'usr', 'bin', 'grep.exe'))) return null;
  for (const rel of [['bin', 'bash.exe'], ['usr', 'bin', 'bash.exe']]) {
    const file = path.join(root, ...rel);
    if (isFile(file)) return file;
  }
  return null;
}

function pathDirs(env) {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  return String(env[key] || '').split(path.delimiter).map(d => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function windowsDir(env) { return path.resolve(env.SystemRoot || env.windir || 'C:\\Windows').toLowerCase(); }

// git.exe 在 <根>/cmd、<根>/bin 或 <根>/mingw64|ucrt64/bin 下；bash.exe 在 <根>/bin 或 <根>/usr/bin 下。
function rootsFromPath(env) {
  const out = [];
  const win = windowsDir(env);
  for (const dir of pathDirs(env)) {
    if (path.resolve(dir).toLowerCase().startsWith(win)) continue; // System32\bash.exe 是 WSL，不算
    if (isFile(path.join(dir, 'git.exe')) || isFile(path.join(dir, 'bash.exe'))) {
      const up = path.dirname(dir);
      out.push(up, path.dirname(up));
    }
  }
  return out;
}

function quickRoots(env) {
  const programs = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean);
  if (!programs.length) programs.push('C:\\Program Files');
  const home = env.USERPROFILE || os.homedir();
  return [
    ...programs.map(p => path.join(p, 'Git')),
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Git') : null,
    env.SCOOP ? path.join(env.SCOOP, 'apps', 'git', 'current') : null,
    path.join(home, 'scoop', 'apps', 'git', 'current'),
    ...rootsFromPath(env),
  ].filter(Boolean);
}

let deep = null; // { bash, at }：上一次深度查找的结果（bash 为 null 表示没找到）

function hubBash(env) {
  try {
    const m = require('./cli-tools/registry').managed('git', env);
    return m ? bashIn(m.dir) : null;
  } catch { return null; }
}

// 同步查找：{ bash, source }。source：env（用户指定）/ user（本机已有）/ hub（Hub 装的）。
// 安装进度每次刷新都会问一遍：同一个环境 3 秒内复用上次的答案；深度查找出结果、装完 Git 时清掉（invalidate）。
let memo = null;
function locateGitBash(env = process.env) {
  const key = [env.CLAUDE_CODE_GIT_BASH_PATH, env.PATH, env.Path, env.ProgramFiles, env.AI_HUB_CLI_TOOLS_DIR, env.CLAUDE_HUB_DATA_DIR].join('|');
  if (memo && memo.env === env && memo.key === key && Date.now() - memo.at < 3000) return memo.hit;
  const hit = locateUncached(env);
  memo = { env, key, hit, at: Date.now() };
  return hit;
}
function invalidate() { memo = null; }

function locateUncached(env) {
  const own = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (own && isFile(own)) return { bash: own, source: 'env' };
  const seen = new Set();
  for (const root of quickRoots(env)) {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const bash = bashIn(root);
    if (bash) return { bash, source: 'user' };
  }
  if (deep && deep.bash && isFile(deep.bash)) return { bash: deep.bash, source: 'user', deep: true };
  const hub = hubBash(env);
  return hub ? { bash: hub, source: 'hub' } : null;
}

function findGitBash(env = process.env) { const hit = locateGitBash(env); return hit ? hit.bash : null; }

// 隐藏的 PowerShell：本地硬盘（不含网络盘）+ Git 安装器的注册表 InstallPath。只用 cmdlet，受限语言模式下也能跑。
const PS_SCRIPT = [
  "Get-PSDrive -PSProvider FileSystem | Where-Object { -not $_.DisplayRoot } | ForEach-Object { 'D ' + $_.Root }",
  "foreach ($k in 'HKLM:\\SOFTWARE\\GitForWindows','HKCU:\\SOFTWARE\\GitForWindows','HKLM:\\SOFTWARE\\WOW6432Node\\GitForWindows') { try { 'R ' + (Get-ItemProperty -Path $k -Name InstallPath -ErrorAction Stop).InstallPath } catch {} }",
].join('; ');

function runPowerShell(env, timeoutMs) {
  return new Promise(resolve => {
    require('child_process').execFile(require('./windows-powershell').windowsPowerShellPath(env), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', env }, (error, stdout) => resolve(String(stdout || '')));
  });
}

const listDir = async dir => { try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; } };

async function deepRoots(env, { runPs = runPowerShell, timeoutMs = 15000, drives: onlyDrives } = {}) {
  const out = [];
  const text = process.platform === 'win32' || runPs !== runPowerShell ? await runPs(env, timeoutMs) : '';
  const drives = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([DR]) (.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'R') out.push(m[2].trim());
    else if (/^[A-Za-z]:\\?$/.test(m[2].trim())) drives.push(m[2].trim().slice(0, 2) + '\\');
  }
  // Visual Studio 自带的 Git（Team Explorer\Git）。
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
    const vs = path.join(base, 'Microsoft Visual Studio');
    for (const year of await listDir(vs)) {
      if (!year.isDirectory()) continue;
      for (const edition of await listDir(path.join(vs, year.name))) {
        if (edition.isDirectory()) out.push(path.join(vs, year.name, edition.name, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'TeamFoundation', 'Team Explorer', 'Git'));
      }
    }
  }
  // GitHub Desktop 自带的 Git。
  if (env.LOCALAPPDATA) {
    const gd = path.join(env.LOCALAPPDATA, 'GitHubDesktop');
    for (const app of await listDir(gd)) if (app.isDirectory() && /^app-/.test(app.name)) out.push(path.join(gd, app.name, 'resources', 'app', 'git'));
  }
  // 每个本地硬盘：根目录和常见工具目录下名字带 git 的文件夹（PortableGit、Git-2.x、Git 等），再往下一层也看一眼 Git。
  // 读不到硬盘列表（PowerShell 被禁或超时）时至少看系统盘；drives 只给单测用。
  for (const drive of onlyDrives || (drives.length ? drives : [(env.SystemDrive || 'C:') + '\\'])) {
    const parents = [drive, ...['Program Files', 'Program Files (x86)', 'Programs', 'Tools', 'DevTools', 'Software', 'Apps', 'Soft'].map(n => path.join(drive, n))];
    for (const parent of parents) {
      for (const d of await listDir(parent)) {
        if (!d.isDirectory() || !/git/i.test(d.name)) continue;
        out.push(path.join(parent, d.name), path.join(parent, d.name, 'Git'));
      }
    }
  }
  return out;
}

// 深度查找：先快速查找，没有再深挖；结果记下来。没 force 时复用上次结果：找到过的 1 分钟、没找到的 10 分钟内不再起 PowerShell
// （没装 Git 的电脑每次打开安装窗口都会问）；点「一键安装」「重新检测」时 force。
async function searchGitBash(env = process.env, { force = false, runPs, timeoutMs, drives } = {}) {
  if (force) memo = null;
  const quick = locateGitBash(env);
  if (quick && quick.source !== 'hub') return quick;
  // 界面测试用：关掉深度查找，免得测试机上真实装的 Git 被找到。
  if (env.AI_HUB_GIT_DEEP_SEARCH === '0') return quick;
  if (!force && deep && Date.now() - deep.at < (deep.bash ? 60000 : 10 * 60000)) return quick;
  let bash = null;
  try {
    for (const root of await deepRoots(env, { runPs, timeoutMs, drives })) { bash = bashIn(root); if (bash) break; }
  } catch (_) { bash = null; }
  deep = { bash, at: Date.now() };
  memo = null;
  return bash ? { bash, source: 'user', deep: true } : quick;
}

function resetForTests() { deep = null; memo = null; }

module.exports = { locateGitBash, findGitBash, searchGitBash, bashIn, invalidate, resetForTests };
