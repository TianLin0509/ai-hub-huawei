'use strict';
// 自定义安装位置不一定进入 PATH；从 CodeAgent 的安装记录取目录，不遍历磁盘。
const path = require('node:path');

async function registryInstallDirs({ env = process.env, platform = process.platform, execFileImpl = require('node:child_process').execFile } = {}) {
  if (platform !== 'win32') return [];
  const script = "$ErrorActionPreference='SilentlyContinue';$out=@();"
    + "$roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');"
    + "foreach($r in $roots){Get-ItemProperty -Path $r|Where-Object {$_.DisplayName -match 'code\\s*-?agent'}|ForEach-Object {$out+=@{location=$_.InstallLocation;icon=$_.DisplayIcon}}};"
    + "foreach($r in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths')){foreach($n in @('codeagent.exe','codeagentcli.exe','cac.exe')){$k=Get-Item -LiteralPath ($r+'\\'+$n);if($k){$out+=@{command=$k.GetValue('')}}}};"
    + "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($out) -Compress)))";
  return new Promise(resolve => {
    try {
      execFileImpl(require('../windows-powershell').windowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 8000, encoding: 'utf8', env, maxBuffer: 256 * 1024 }, (error, stdout) => {
          if (error) return resolve([]);
          try {
            const records = JSON.parse(Buffer.from(String(stdout || '').trim(), 'base64').toString('utf8'));
            const dirs = [];
            const expand = v => String(v || '').replace(/%([^%]+)%/g, (m, name) => env[Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase())] || m);
            const add = v => { if (v && path.isAbsolute(v) && !dirs.includes(v)) dirs.push(v); };
            for (const r of [].concat(records || [])) {
              add(expand(r.location).trim().replace(/^"|"$/g, ''));
              for (const raw of [r.icon, r.command]) {
                const value = expand(raw).trim();
                const quoted = /^"([^"]+)"/.exec(value);
                const file = quoted ? quoted[1] : value.replace(/,\s*-?\d+$/, '');
                if (path.isAbsolute(file)) add(path.dirname(file));
              }
            }
            resolve(dirs);
          } catch { resolve([]); }
        });
    } catch { resolve([]); }
  });
}

module.exports = { registryInstallDirs };
