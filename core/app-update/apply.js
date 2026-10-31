'use strict';
// 应用增量更新（2026-10-13，公司版）。运行中的程序锁着 app.asar，不能原地替换，所以：
//   1. 解包到暂存目录并逐个核对 sha256；
//   2. 写一份替换计划（plan.json）和一个 PowerShell 小脚本；
//   3. 用户点「立即重启」：主进程隐藏启动小脚本后退出；脚本等这个进程结束 → 备份要替换的文件 →
//      逐个复制新文件 → 再核对 sha256 → 任何一步失败就把备份全部还原 → 重新打开程序；
//   装在 C:Program Files 这类普通权限写不进的目录时（2026-10-30），脚本只为「备份 + 复制」这一步申请一次管理员授权，
//   程序本身照旧以普通权限重新打开；授权被取消就什么都不换，如实报告。
//   4. 结果写进 last-result.json，下次启动由界面读出来告诉用户（成功 / 失败已回滚 + 原因）。
// Electron 会把名为 *.asar 的文件当成压缩包拦截（写 app.asar 会报 Invalid package），用它提供的原始文件接口。
const fs = (() => { try { return require('original-fs'); } catch (_) { return require('fs'); } })();
const path = require('path');
const { spawn } = require('child_process');
const { unpackPayload } = require('./payload');

const HELPER = String.raw`param([string]$Plan, [switch]$Elevated)
$ErrorActionPreference = 'Stop'
$p = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
function Write-Result($ok, $reason, $rolledBack) {
  $r = [ordered]@{ ok = $ok; version = $p.version; from = $p.from; reason = $reason; rolledBack = $rolledBack; elevated = [bool]$Elevated; at = (Get-Date).ToString('o') }
  ($r | ConvertTo-Json -Compress) | Set-Content -LiteralPath $p.resultFile -Encoding UTF8
}
function Relaunch {
  if ($p.relaunch -and $p.exe) {
    # Start-Process 用空格拼参数，带空格的要自己加引号。
    $argList = @($p.args | Where-Object { $_ -ne $null -and $_ -ne '' } | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
    if ($argList.Count) { Start-Process -FilePath $p.exe -ArgumentList $argList -WorkingDirectory (Split-Path $p.exe) }
    else { Start-Process -FilePath $p.exe -WorkingDirectory (Split-Path $p.exe) }
  }
}
# 安装目录下还在跑的程序（Hub 退出后残留的子进程、另开的窗口）：它们会锁住 app.asar。
function Get-Leftovers {
  if (-not $p.appDir) { return @() }
  $dir = ([string]$p.appDir).TrimEnd('\') + '\'
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID -and $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) })
}
function Test-Writable($dir) {
  try { $t = Join-Path $dir ('.hub-update-write-test-' + $PID); [IO.File]::WriteAllText($t, 'x'); Remove-Item -LiteralPath $t -Force; return $true } catch { return $false }
}
# 替换失败的原因分开说：没权限 / 被占用，并附系统原话（以前一律写「被占用」，权限问题也被说成占用）。
function Explain($err, $rel) {
  $e = $err.Exception; $msg = $e.Message
  if ($e -is [UnauthorizedAccessException] -or $msg -match 'denied|拒绝') { return "替换 $rel 失败：没有写入安装目录的权限（$msg）" }
  $left = @(Get-Leftovers | ForEach-Object { $_.Name + '(' + $_.Id + ')' }) -join '、'
  if ($left) { return "替换 $rel 失败：文件被占用，这些程序还在运行：$left（$msg）" }
  return "替换 $rel 失败：文件被占用，可能另一个窗口还开着（$msg）"
}
function Replace-Files {
  $backup = Join-Path $p.stagingDir 'backup'
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  $done = @()
  try {
    foreach ($f in $p.files) {
      $dest = Join-Path $p.resourcesDir $f.path
      $bak = Join-Path $backup $f.path
      $existed = Test-Path -LiteralPath $dest
      if ($existed) { New-Item -ItemType Directory -Force -Path (Split-Path $bak) | Out-Null; Copy-Item -LiteralPath $dest -Destination $bak -Force }
      $done += [pscustomobject]@{ dest = $dest; bak = $bak; existed = $existed }
      New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
      $copied = $false
      for ($i = 0; $i -lt 40 -and -not $copied; $i++) {
        try { Copy-Item -LiteralPath (Join-Path $p.newDir $f.path) -Destination $dest -Force; $copied = $true }
        catch {
          # 没权限重试也没用，直接报；被占用等 0.5 秒再试，最多 20 秒。
          if ($i -eq 39 -or $_.Exception -is [UnauthorizedAccessException]) { throw (Explain $_ $f.path) }
          Start-Sleep -Milliseconds 500
        }
      }
      $h = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
      if ($h -ne $f.sha256) { throw "替换后 $($f.path) 校验不一致" }
    }
    if ($p.simulateFailure) { throw $p.simulateFailure }
    Write-Result $true '' $false
    Remove-Item -LiteralPath $p.newDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    $reason = $_.Exception.Message
    $restored = $true
    foreach ($d in $done) {
      try {
        # 还没被换掉的（比如没权限、第一次复制就失败）不用再写回，免得写回本身也失败、误报「没能恢复」。
        if ($d.existed) { if ((Get-FileHash -LiteralPath $d.dest -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $d.bak -Algorithm SHA256).Hash) { Copy-Item -LiteralPath $d.bak -Destination $d.dest -Force } }
        elseif (Test-Path -LiteralPath $d.dest) { Remove-Item -LiteralPath $d.dest -Force }
      } catch { $restored = $false }
    }
    Write-Result $false $reason $restored
  }
}
function Is-Cancelled($e) {
  # Windows PowerShell 5.1 把「用户点了否」包成 InvalidOperationException，不一定带内层异常，所以再按原话认一次。
  while ($e) { if (($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) -or $e.Message -match '取消|cancel') { return $true }; $e = $e.InnerException }
  return $false
}

# 管理员副本（2026-10-30）：只替换文件、写结果，不重新打开程序——由普通权限的那一份负责，免得 Hub 以管理员身份运行。
if ($Elevated) { Replace-Files; exit 0 }

$deadline = (Get-Date).AddSeconds([int]$p.waitSeconds)
while ($p.pid -and (Get-Process -Id ([int]$p.pid) -ErrorAction SilentlyContinue)) {
  if ((Get-Date) -gt $deadline) { Write-Result $false '等待程序退出超时，没有替换任何文件' $false; Relaunch; exit 1 }
  Start-Sleep -Milliseconds 300
}
# 主进程退了，子进程可能还要一会儿（GPU、终端等）；最多再等 leftoverWaitSeconds 秒，还在就照常尝试，失败时报出名字。
$leftDeadline = (Get-Date).AddSeconds([int]$p.leftoverWaitSeconds)
while ((Get-Date) -lt $leftDeadline -and (Get-Leftovers).Count) { Start-Sleep -Milliseconds 500 }

if (Test-Writable $p.resourcesDir) { Replace-Files }
else {
  # 装在 C:\Program Files 这类受保护目录：只为替换这一步申请一次管理员授权（Windows 弹「是否允许」）。
  Remove-Item -LiteralPath $p.resultFile -Force -ErrorAction SilentlyContinue
  $argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -Plan "' + $Plan + '" -Elevated'
  try {
    if ($p.elevateMode -eq 'cancel') { throw (New-Object ComponentModel.Win32Exception 1223) }
    if ($p.elevateMode -eq 'plain') { $null = Start-Process powershell.exe -ArgumentList $argLine -WindowStyle Hidden -Wait -PassThru }
    else { $null = Start-Process powershell.exe -ArgumentList $argLine -Verb RunAs -WindowStyle Hidden -Wait -PassThru }
    if (-not (Test-Path -LiteralPath $p.resultFile)) { Write-Result $false '已获得管理员授权，但替换程序没有留下结果（可能被安全软件拦截），请用完整安装包更新' $false }
  } catch {
    if (Is-Cancelled $_.Exception) { $reason = '程序装在受保护目录（' + $p.appDir + '），替换文件需要管理员授权；这次没有授权，没有替换任何文件。再次更新时在 Windows 弹出的确认框里点「是」即可' }
    else { $reason = '申请管理员授权失败（' + $_.Exception.Message + '），没有替换任何文件' }
    Write-Result $false $reason $false
  }
}
Relaunch
`;

function stagingPaths(dataDir) {
  const root = path.join(dataDir, 'app-update');
  return { root, downloads: path.join(root, 'downloads'), newDir: path.join(root, 'new'), plan: path.join(root, 'plan.json'),
    helper: path.join(root, 'apply-update.ps1'), result: path.join(root, 'last-result.json') };
}

// 解包并写替换计划；不动安装目录。
// 普通权限能不能写这个目录（建一个临时文件再删）。Windows 的权限看 ACL，fs.access 判断不准，所以真写一次。
function canWriteDir(dir) {
  const probe = path.join(dir, '.hub-update-write-test-' + process.pid);
  try { fs.writeFileSync(probe, 'x'); fs.rmSync(probe, { force: true }); return true; } catch (_) { return false; }
}

// elevateMode 只给测试用：'plain' 不弹授权框、按普通权限跑管理员那一份；'cancel' 模拟用户在授权框点了「否」。
function stageIncremental({ dataDir, payloadFile, resourcesDir, version, from, exe, args = [], pid = process.pid, simulateFailure = null, relaunch = true,
  elevateMode = null, leftoverWaitSeconds = 30 }) {
  const p = stagingPaths(dataDir);
  fs.rmSync(p.newDir, { recursive: true, force: true });
  fs.mkdirSync(p.newDir, { recursive: true });
  const files = unpackPayload(payloadFile, p.newDir, { resourcesDir });
  const plan = { version, from, pid, exe, args, relaunch, waitSeconds: 90, resourcesDir, appDir: path.dirname(path.resolve(resourcesDir)), leftoverWaitSeconds,
    newDir: p.newDir, stagingDir: p.root, resultFile: p.result, files, ...(simulateFailure ? { simulateFailure } : {}), ...(elevateMode ? { elevateMode } : {}) };
  fs.writeFileSync(p.plan, JSON.stringify(plan, null, 2), 'utf8');
  fs.writeFileSync(p.helper, '﻿' + HELPER, 'utf8');
  return { plan, paths: p, needsAdmin: !canWriteDir(resourcesDir) };
}

// 隐藏启动替换脚本（与本进程脱离，本进程退出后它继续跑）。
// 本机实测（2026-10-13）：直接 detached 启动 powershell.exe 一行都不执行；经 cmd 的 start /b 转一手
// 才能脱离本进程、在本进程退出后继续跑完，且不弹窗。/s 让 cmd 原样保留引号里的路径（可带空格）。
function launchHelper(paths, { env = process.env, spawnImpl = spawn } = {}) {
  const line = `/d /s /c "start "" /b powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${paths.helper}" -Plan "${paths.plan}""`;
  const child = spawnImpl(process.env.ComSpec || 'cmd.exe', [line], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env });
  if (child && typeof child.unref === 'function') child.unref();
  return child;
}

// 上次更新的结果：读出来后改名为 .seen，只报告一次。
function takeLastResult(dataDir) {
  const p = stagingPaths(dataDir);
  try {
    const result = JSON.parse(fs.readFileSync(p.result, 'utf8').replace(/^﻿/, ''));
    fs.renameSync(p.result, p.result + '.seen');
    return result;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { ok: false, reason: `读取上次更新结果失败：${error.message}` };
  }
}

module.exports = { HELPER, stagingPaths, canWriteDir, stageIncremental, launchHelper, takeLastResult };
