'use strict';
const fs = require('node:fs');
const path = require('node:path');

function windowsPowerShellPath(env = process.env) {
  const file = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return process.platform === 'win32' && fs.existsSync(file) ? file : 'powershell.exe';
}

// Hook 命令须兼容不同 shell，保留裸命令名，只补当前会话的 PATH。
function ensurePowerShellPath(env) {
  const file = windowsPowerShellPath(env);
  if (!path.isAbsolute(file)) return env;
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const dir = path.dirname(file), dirs = String(env[key] || '').split(path.delimiter);
  if (!dirs.some(d => d.replace(/^"|"$/g, '').toLowerCase() === dir.toLowerCase())) env[key] = [...dirs.filter(Boolean), dir].join(path.delimiter);
  return env;
}

// 起 Windows PowerShell 5.1 用的环境：去掉 PSModulePath。从 pwsh 7 终端或 CI（默认 shell 是 pwsh 7）间接拉起时，
// 5.1 会继承 7 的模块目录，先找到 7 版的 Microsoft.PowerShell.Utility / Security 却加载不了，
// ConvertTo-Json、Get-ExecutionPolicy 都「无法加载」。5.1 没有这个变量时会自己用默认目录。同 scripts/ci-slot.js。
function windowsPowerShellEnv(env = process.env) {
  const next = { ...env };
  for (const key of Object.keys(next)) if (key.toLowerCase() === 'psmodulepath') delete next[key];
  return next;
}

module.exports = { windowsPowerShellPath, ensurePowerShellPath, windowsPowerShellEnv };
