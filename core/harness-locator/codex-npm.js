'use strict';
// npm / pnpm / volta 装的 Codex：由包里的 bin/codex.js 找到自带的原生 codex.exe 直接运行（包里的 JS 转发器起子进程时不隐藏窗口）。
// 放在 core 里，对照脚本只带 core/ 和 scripts/ 也能用；main/codex-windows-command.js 转用这里。只依赖 Node 内置模块。
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function resolveCodexScript(env, script, options = {}) {
  script = path.normalize(script);
  const source = fs.readFileSync(script, 'utf8');
  const packageRoot = path.resolve(path.dirname(script), '..');
  const arch = options.arch || process.arch;
  const triple = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!triple) throw new Error('不支持的 Codex Windows 架构：' + arch);
  let vendor = path.join(packageRoot, 'vendor');
  try {
    vendor = path.join(path.dirname(createRequire(script).resolve(`@openai/codex-win32-${arch}/package.json`)), 'vendor');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  const target = path.join(vendor, triple + '-pc-windows-msvc');
  const command = ['bin', 'codex'].map(dir => path.join(target, dir, 'codex.exe')).find(file => fs.existsSync(file));
  if (!command) throw new Error('Codex 原生程序不存在：' + target);
  const managed = source.match(/CODEX_MANAGED_PACKAGE_ROOT:\s*("(?:[^"\\]|\\.)*")/);
  const launchEnv = { ...env, CODEX_MANAGED_PACKAGE_ROOT: managed ? JSON.parse(managed[1]) : packageRoot };
  for (const key of ['NPM', 'BUN', 'PNPM', 'VITE_PLUS']) delete launchEnv['CODEX_MANAGED_BY_' + key];
  launchEnv.CODEX_MANAGED_BY_NPM = '1';
  const pathKey = Object.keys(launchEnv).find(key => key.toLowerCase() === 'path') || 'PATH';
  const pathDir = path.join(target, 'path');
  if (fs.existsSync(pathDir)) launchEnv[pathKey] = pathDir + path.delimiter + (launchEnv[pathKey] || '');
  return { command, args: [], env: launchEnv };
}

module.exports = { resolveCodexScript };
