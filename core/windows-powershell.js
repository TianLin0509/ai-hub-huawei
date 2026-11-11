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

module.exports = { windowsPowerShellPath, ensurePowerShellPath };
