'use strict';
const fs = require('node:fs'), path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const verified = new Map();
const UNINSTALL = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{B7E2A8F3-5C4D-4E1F-9A2B-3D4C5E6F7A08}_is1';
const exec = (exe, args) => new Promise((resolve, reject) => execFile(exe, args, { windowsHide: true, timeout: 4000, encoding: 'utf8', maxBuffer: 256 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
const names = dir => ['PPT-Doctor.exe', 'PPT Doctor.exe'].map(n => path.join(dir, n));

async function registryPaths(execFn = exec) {
  const jobs = ['HKCU', 'HKLM'].flatMap(hive => ['32', '64'].map(view => execFn('reg.exe', ['query', `${hive}\\${UNINSTALL}`, `/reg:${view}`])));
  const results = await Promise.allSettled(jobs), candidates = [];
  for (const result of results) if (result.status === 'fulfilled') {
    for (const line of result.value.split(/\r?\n/)) {
      const m = line.match(/^\s*(InstallLocation|DisplayIcon)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i); if (!m) continue;
      const value = m[2].replace(/^"(.*)"(?:,\d+)?$/, '$1').replace(/,\d+$/, '');
      candidates.push(...(m[1].toLowerCase() === 'installlocation' ? names(value) : [value]));
    }
  }
  return candidates;
}

async function shortcutPaths(env, execFn = exec) {
  const roots = [env.APPDATA, env.ProgramData].filter(Boolean).map(p => path.join(p, 'Microsoft/Windows/Start Menu/Programs'));
  const files = roots.flatMap(root => ['PPT Doctor.lnk', 'PPT-Doctor.lnk', 'PPT Doctor/PPT Doctor.lnk', 'PPT-Doctor/PPT Doctor.lnk'].map(n => path.join(root, n))).filter(p => fs.existsSync(p));
  if (!files.length) return [];
  // Paths are data in a Base64 JSON literal; no filename becomes shell code.
  const data = Buffer.from(JSON.stringify(files), 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'; $paths=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}'))|ConvertFrom-Json; $w=New-Object -ComObject WScript.Shell; @($paths|ForEach-Object {$w.CreateShortcut($_).TargetPath})|ConvertTo-Json -Compress`;
  const value = await execFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  const result = JSON.parse(value.replace(/^\uFEFF/, '')); return Array.isArray(result) ? result : [result];
}

async function candidates(env = process.env, deps = {}) {
  if (deps.pptDoctorCandidates) return deps.pptDoctorCandidates;
  const fromRegistry = process.platform === 'win32' ? await registryPaths(deps.pptDoctorExec) : [];
  const defaults = [...names(path.join(env.LOCALAPPDATA || '', 'Programs/PPT-Doctor')),
    ...[env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).flatMap(base => names(path.join(base, 'PPT-Doctor')))];
  let shortcuts = [];
  if (![...fromRegistry, ...defaults].some(file => fs.existsSync(file)) && process.platform === 'win32') {
    try { shortcuts = await shortcutPaths(env, deps.pptDoctorExec); }
    catch (error) { console.warn('[ppt-doctor] 开始菜单快捷方式读取失败，可手动选择程序：', error.message); }
  }
  return [...new Set([...fromRegistry, ...defaults, ...shortcuts].filter(Boolean))];
}

// 联动能力标记 hub-api.json：协议版本和能力列表决定「能不能联动」。
// R31（2026-11-24）：标记里的 exeSha256 和程序实际哈希对不上时不再判成「版本太旧」，而是带 exeHashMismatch 返回，
// 由调用方实际调一次 status、按回执的 apiVersion 定。起因：公司电脑覆盖安装 v2.1.9 时 PPT-Doctor.exe 正被占用没换掉，
// 其余文件（含标记）已是 2.1.9，Hub 按哈希判成「太旧」，一键升级反把它装回 2.0.7 完整基线。
// 返回 null 只表示「没有可用的标记」（老版本没有 --hub，启动它会弹出界面），这时一律不启动。
async function capability(executable) {
  const file = path.join(path.dirname(executable), 'hub-api.json');
  try {
    const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 16384) return null;
    const info = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (info.apiVersion !== 1 || String(info.executable).toLowerCase() !== path.basename(executable).toLowerCase()
        || !/^[a-f0-9]{64}$/i.test(info.exeSha256 || '') || !Array.isArray(info.capabilities) || !info.capabilities.includes('status')) return null;
    const exeStat = fs.statSync(executable), key = `${executable}:${exeStat.size}:${exeStat.mtimeMs}:${stat.size}:${stat.mtimeMs}:${info.exeSha256}`;
    if (verified.has(key)) return verified.get(key);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(executable)) hash.update(chunk);
    const match = hash.digest('hex') === info.exeSha256.toLowerCase();
    const after = fs.statSync(executable);
    if (after.size !== exeStat.size || after.mtimeMs !== exeStat.mtimeMs) return null;   // 算哈希时程序正被替换：这一刻不判
    const result = match ? info : { ...info, exeHashMismatch: true };
    verified.set(key, result); while (verified.size > 8) verified.delete(verified.keys().next().value);
    return result;
  } catch (error) { if (error.code !== 'ENOENT') console.warn('[ppt-doctor] 联动能力标记不可读：', error.message); return null; }
}

// Hub 一键安装放在 <数据目录>/tools/ppt-doctor/install-<uuid>/ 下（ppt-doctor-install.js）。这份不算用户手动指定：
// 本机另有更新的 PPT Doctor 时自动改用新的（R31：以前一键装的旧基线会一直压住用户后来自己升级的新版）。
const isHubInstall = file => /[\\/]tools[\\/]ppt-doctor[\\/]install-[0-9a-f-]{36}[\\/]/i.test(String(file || ''));

module.exports = { candidates, capability, registryPaths, shortcutPaths, isHubInstall };
