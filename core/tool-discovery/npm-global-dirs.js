'use strict';
// 外部命令行工具常装的目录（2026-11-07 从 company-assistant/welink.js 抽出，welink-cli 和 CodeAgent 共用）。
// 每个人的 npm 全局目录不一样：有人改到 D:\nodejs\node_global，有人用 nvm / pnpm / volta；
// 装完工具没重启 Hub 时，Hub 进程的 PATH 还是旧的，要去注册表读最新的 PATH。
// 这里只列目录、读注册表，不做全盘搜索；子进程一律隐藏窗口、带超时。
const fs = require('node:fs');
const path = require('node:path');

// npm 全局目录的候选：npm 配置文件里的 prefix、环境变量、nvm / pnpm / volta 的常见位置。
function npmPrefixes(env = process.env, fsModule = fs) {
  const out = [];
  const add = p => { if (p && !out.includes(p)) out.push(p); };
  const expand = v => String(v).trim().replace(/^["']|["']$/g, '').replace(/\$\{([^}]+)\}|%([^%]+)%/g, (_, a, b) => env[a || b] || '');
  add(env.npm_config_prefix || env.NPM_CONFIG_PREFIX);
  for (const rc of [env.USERPROFILE && path.join(env.USERPROFILE, '.npmrc'), env.APPDATA && path.join(env.APPDATA, 'npm', 'etc', 'npmrc')]) {
    if (!rc) continue;
    try { const m = /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(fsModule.readFileSync(rc, 'utf8')); if (m) add(expand(m[1])); } catch { /* 没有这个文件 */ }
  }
  add(env.APPDATA && path.join(env.APPDATA, 'npm'));
  add(env.NVM_SYMLINK);
  add(env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs'));
  add(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'npm'));
  add(env.PNPM_HOME);
  add(env.VOLTA_HOME && path.join(env.VOLTA_HOME, 'bin'));
  return out;
}

// Hub 进程自己的 PATH 目录（去引号、去重）。
function pathDirs(env = process.env) {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const out = [];
  for (const dir of String(env[key] || '').split(path.delimiter)) {
    const d = dir.trim().replace(/^"|"$/g, '');
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

function runText(file, args, { timeoutMs = 15000, env = process.env, execFileImpl = require('node:child_process').execFile } = {}) {
  return new Promise(resolve => {
    try {
      execFileImpl(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', env, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error && !stdout ? '' : String(stdout || '')));
    } catch { resolve(''); }
  });
}

// 注册表里最新的用户级 + 系统级 PATH（展开 %VAR%）。不是 Windows 或读不到时返回 []。
async function registryPathDirs({ env = process.env, execFileImpl, platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  const expand = v => String(v).replace(/%([^%]+)%/g, (_, k) => env[k] || env[Object.keys(env).find(x => x.toLowerCase() === k.toLowerCase())] || '');
  const read = async key => {
    const t = await runText('reg.exe', ['query', key, '/v', 'Path'], { execFileImpl, env });
    const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(t);
    return m ? expand(m[1].trim()) : '';
  };
  const joined = [await read('HKCU\\Environment'), await read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')].filter(Boolean).join(';');
  const out = [];
  for (const dir of joined.split(';').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean)) if (!out.includes(dir)) out.push(dir);
  return out;
}

// 「npm config get prefix」（用注册表里最新的 PATH 跑，装完 Node 没重启 Hub 也能问到）。问不到返回 ''。
async function npmConfigPrefix({ env = process.env, freshDirs = [], execFileImpl, timeoutMs = 20000 } = {}) {
  const npmEnv = freshDirs.length ? { ...env, PATH: freshDirs.join(';') + ';' + (env.PATH || env.Path || '') } : env;
  const out = await runText('cmd.exe', ['/d', '/c', 'npm', 'config', 'get', 'prefix'], { env: npmEnv, timeoutMs, execFileImpl });
  return String(out).trim().split(/\r?\n/).pop()?.trim() || '';
}

module.exports = { npmPrefixes, pathDirs, registryPathDirs, npmConfigPrefix, runText };
