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
const { PROGRESS_UI } = require('./progress-ui');

const HELPER = String.raw`param([string]$Plan, [switch]$Elevated)
$ErrorActionPreference = 'Stop'
$p = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
# 第一时间留下「已开始」标记：主进程要看到它才会退出（脚本被组策略、杀软拦住时主进程不退出，用户还能继续用）。
if ($p.cancelFile -and -not $Elevated -and (Test-Path -LiteralPath $p.cancelFile)) { exit 0 }
if ($p.startedFile -and -not $Elevated) { try { Set-Content -LiteralPath $p.startedFile -Value (Get-Date).ToString('o') -Encoding ASCII } catch {} }
function Write-Result($ok, $reason, $rolledBack, $restoreFailed = $false) {
  $r = [ordered]@{ ok = $ok; version = $p.version; from = $p.from; reason = $reason; rolledBack = $rolledBack; restoreFailed = [bool]$restoreFailed; elevated = [bool]$Elevated; quiet = [bool]$p.quiet; at = (Get-Date).ToString('o') }
  ($r | ConvertTo-Json -Compress) | Set-Content -LiteralPath $p.resultFile -Encoding UTF8
}

# 升级进度（2026-11-13）：以前关掉旧窗口到新版打开之间屏幕上什么都没有，用户以为失败又点一次图标，打开的还是旧版。
# 现在每一步写进 progress.json（第几步、这一步已等多久、通常多久），由独立的进度小窗显示；
# 用户这时再点图标，新启动的程序看到升级在进行就把焦点交给进度小窗后立即退出（core/app-update/launch-guard.js），不再占住文件。
$script:t0 = Get-Date; $script:stepNo = 0; $script:stepAt = $script:t0; $script:stepLabel = ''; $script:stepTypical = ''; $script:extra = @{}; $script:ui = $null
# 每一步的用时记进 upgrade-log.txt（只留最近 200 行），公司电脑上远程排查「为什么这么久」时直接读它。
function Log($msg) {
  if (-not $p.stagingDir -or $Elevated) { return }
  try { $f = Join-Path $p.stagingDir 'upgrade-log.txt'; $old = @(); if (Test-Path -LiteralPath $f) { $old = @(Get-Content -LiteralPath $f -Encoding UTF8 -ErrorAction Stop | Select-Object -Last 199) }
    [IO.File]::WriteAllLines($f, [string[]](@($old) + ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff') + ' +' + [int]((Get-Date) - $script:t0).TotalMilliseconds + 'ms ' + $msg)), (New-Object Text.UTF8Encoding $false)) } catch {}
}
function Set-Progress($no, $label, $typical, $extra = @{}, $state = 'running') {
  # 静默替换（用户关 Hub 时顺手换）不写进度：没有进度窗，也不能让升级守卫拦下用户紧接着的打开。
  if (-not $p.progressFile -or $Elevated -or $p.quiet) { return }
  if ($label -or $state -ne $script:lastState) { Log ("[$state] 第 $(if ($no) { $no } else { $script:stepNo }) 步 " + $(if ($label) { $label } else { $script:stepLabel }) + $(if ($extra.reason) { ' · ' + $extra.reason } else { '' })) }
  if ($no -and $no -ne $script:stepNo) { $script:stepNo = $no; $script:stepAt = Get-Date }
  if ($label) { $script:stepLabel = $label; $script:stepTypical = $typical; $script:extra = $extra }
  $o = [ordered]@{ state = $state; version = $p.version; from = $p.from; product = $p.productName; step = $script:stepNo; total = 4; label = $script:stepLabel; typical = $script:stepTypical
    startedAt = $script:t0.ToString('o'); stepStartedAt = $script:stepAt.ToString('o'); updatedAt = (Get-Date).ToString('o'); helperPid = $PID }
  foreach ($k in $script:extra.Keys) { $o[$k] = $script:extra[$k] }
  $script:lastState = $state
  $json = $o | ConvertTo-Json -Compress -Depth 4
  $tmp = $p.progressFile + '.tmp'
  try { [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding $false)); Move-Item -LiteralPath $tmp -Destination $p.progressFile -Force }
  catch { try { [IO.File]::WriteAllText($p.progressFile, $json, (New-Object Text.UTF8Encoding $false)) } catch {} }
}
function Beat { if ($script:stepNo) { Set-Progress 0 $null $null @{} $script:lastState } }
# 进度小窗是单独的 PowerShell（不读安装目录里的任何文件，不会占住要换的文件）。不建控制台（CREATE_NO_WINDOW），
# 默认终端是 Windows Terminal 时也不会多出空终端窗口。静默替换、管理员副本、测试里不开。
function Start-Ui {
  if (-not $p.progressUi -or $p.quiet -or $Elevated -or -not $p.progressUiScript) { return }
  try {
    $si = New-Object Diagnostics.ProcessStartInfo
    $si.FileName = Join-Path $PSHOME 'powershell.exe'
    $si.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "' + $p.progressUiScript + '" -Dir "' + $p.stagingDir + '"'
    $si.UseShellExecute = $false; $si.CreateNoWindow = $true
    $script:ui = [Diagnostics.Process]::Start($si)
  } catch { $script:ui = $null }
}
# assumeUi 只给测试用：不开小窗，由测试代替用户写 decision.json。
function Ui-Alive { if ($p.assumeUi) { return $true }; try { return ($script:ui -and -not $script:ui.HasExited) } catch { return $false } }
# 等进度小窗里的按钮（decision.json）。小窗没开或被关掉就不等，按原来的做法走。
function Wait-Decision($seconds) {
  if ($p.decisionFile) { Remove-Item -LiteralPath $p.decisionFile -Force -ErrorAction SilentlyContinue }
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) {
    if ($p.decisionFile -and (Test-Path -LiteralPath $p.decisionFile)) {
      try { $d = [string](Get-Content -LiteralPath $p.decisionFile -Raw -Encoding UTF8 | ConvertFrom-Json).action; Remove-Item -LiteralPath $p.decisionFile -Force -ErrorAction SilentlyContinue; if ($d) { return $d } } catch {}
    }
    if (-not (Ui-Alive)) { return 'ui-closed' }
    Beat
    Start-Sleep -Milliseconds 300
  }
  return 'timeout'
}
function Relaunch {
  # 先放开「升级进行中」的锁：否则刚打开的新版会以为还在升级、把焦点交给进度窗后退出。
  try { if ($script:helperLock) { $script:helperLock.Close(); $script:helperLock = $null } } catch {}
  if ($p.relaunch -and $p.exe) {
    # Start-Process 用空格拼参数，带空格的要自己加引号。
    $argList = @($p.args | Where-Object { $_ -ne $null -and $_ -ne '' } | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
    if ($argList.Count) { Start-Process -FilePath $p.exe -ArgumentList $argList -WorkingDirectory (Split-Path $p.exe) }
    else { Start-Process -FilePath $p.exe -WorkingDirectory (Split-Path $p.exe) }
  }
}
# 一次进程快照（WMI，约 0.8 秒）同时给出「安装目录里还在跑的」和「哪些是 Hub 主程序」，0.7 秒内重复调用直接复用，
# 免得每个判断各查一遍（11-13 实测逐个读 Path 0.4 秒、逐个查命令行 0.7 秒，叠起来一步多花 4 秒）。
# WMI 被禁用时退回逐个读 Path，这时分不清主程序和子进程（Main 为 $null）。
$script:snap = $null; $script:snapAt = [DateTime]::MinValue; $script:snapWmi = $true
function Snap {
  if ($null -ne $script:snap -and ((Get-Date) - $script:snapAt).TotalMilliseconds -lt 700) { return $script:snap }
  $list = @()
  if ($p.appDir) {
    $dir = ([string]$p.appDir).TrimEnd('\') + '\'
    try {
      if ($p.simulateNoWmi) { throw 'simulateNoWmi' }
      $list = @(([wmisearcher]'SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process').Get() | ForEach-Object { $path = [string]$_.ExecutablePath
        if ($_.ProcessId -ne $PID -and $path -and $path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase)) { [pscustomobject]@{ Id = [int]$_.ProcessId; Path = $path; Main = ([string]$_.CommandLine -notmatch '\s--type=') } } })
      $script:snapWmi = $true
    } catch {
      $script:snapWmi = $false
      # 进程可能在枚举中途退出，Path 前后两次读到的不一样；只读一次，出错就跳过，否则整个脚本会崩掉、不写结果也不重开程序。
      $list = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object { try { $path = [string]$_.Path; if ($_.Id -ne $PID -and $path -and $path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase)) { [pscustomobject]@{ Id = $_.Id; Path = $path; Main = $null } } } catch {} })
    }
  }
  $script:snap = $list; $script:snapAt = Get-Date
  return $list
}
function Fresh { $script:snap = $null }
function Procs($items) { @($items | Where-Object { $_ } | ForEach-Object { try { Get-Process -Id $_.Id -ErrorAction Stop } catch {} }) }
# 安装目录下还在跑的程序（Hub 退出后残留的子进程、另开的窗口）：它们会锁住 app.asar。
function Get-Leftovers { Procs (Snap) }
# 自己算 SHA256，不用 Get-FileHash：从 PowerShell 7 终端或 CI 服务里拉起时会继承 7 的 PSModulePath，
# 5.1 自带的 Get-FileHash 就认不出来，替换整个失败（11-07 CI 实测）。
function Get-Sha256($path) { $s = [IO.File]::OpenRead($path); try { $a = [Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($a.ComputeHash($s)) -replace '-', '') } finally { $a.Dispose() } } finally { $s.Dispose() } }
# 另外开着的 Hub 主程序（2026-11-13）：同一个 exe、命令行里没有 --type=（GPU、界面等子进程都带 --type=）。
# 最小化到托盘的 Hub 没有可见窗口，以前会被当成残留直接结束；现在算作「开着的 Hub」，先问用户。
# 只认安装目录里的 Hub 自己的 exe、按进程号结束，不按命令行子串结束进程。
# 读不到命令行（WMI 被禁用）时分不清主程序和子进程（2026-11-13 审查返工）：以前退回按窗口判断，托盘 Hub 没有窗口，
# 又被当残留直接结束；现在保守地把同一 exe 的进程都当作「可能是开着的 Hub」，要用户在进度窗里同意才关，不同意就不换。
function Get-OtherMains {
  if (-not $p.exe) { return @() }
  $s = Snap
  return @(Procs @($s | Where-Object { ($_.Main -or -not $script:snapWmi) -and $_.Id -ne [int]$p.pid -and $_.Path -ieq [string]$p.exe }))
}
function Others-Now { return @(Get-OtherMains) }
function Names($procs) { @($procs | Where-Object { $_ } | ForEach-Object { try { $t = [string]$_.MainWindowTitle; if (-not $t) { $t = $(if ($script:snapWmi) { '最小化到托盘' } else { '没有窗口，可能是最小化到托盘的 Hub' }) }; $_.Name + '（' + $t + '，进程 ' + $_.Id + '）' } catch {} }) }
# 主进程已退、也没有开着的 Hub 时，同一 exe 的进程只可能是上次运行的残留（GPU、以 Node 方式跑的 MCP 等），它们锁着 app.asar。
# 有开着的 Hub 时一个都不动；只认 Hub 自己的 exe，安装目录里的其他程序不碰（$all 只在用户点了「结束占用的程序并重试」后才用）。
function Stop-Orphans($all = $false) {
  if (-not $p.exe -or (Others-Now).Count) { return }
  $orphans = @(Get-Leftovers | Where-Object { $all -or $_.Path -ieq [string]$p.exe })
  if (-not $orphans.Count) { return }
  Log ('结束残留进程：' + (@($orphans | ForEach-Object { $_.Name + '(' + $_.Id + ')' }) -join '、'))
  $orphans | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
  Fresh
}
# 用户在进度窗里同意后才关别的 Hub：先像点右上角关闭那样请它保存退出，等不到再按进程号结束。
# 最小化到托盘的没有可见窗口，请不动它保存退出，直接按进程号结束（用户已在进度窗里同意）。
function Close-Others($procs) {
  Log ('关闭别的 Hub：' + ((Names $procs) -join '、'))
  $asked = @($procs | Where-Object { try { $_.CloseMainWindow() } catch { $false } })
  $end = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $end -and @($asked | Where-Object { try { -not $_.HasExited } catch { $false } }).Count) { Beat; Start-Sleep -Milliseconds 500 }
  $procs | Where-Object { try { -not $_.HasExited } catch { $false } } | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Milliseconds 800
  Fresh
}
function Test-Writable($dir) {
  try { $t = Join-Path $dir ('.hub-update-write-test-' + $PID); [IO.File]::WriteAllText($t, 'x'); Remove-Item -LiteralPath $t -Force; return $true } catch { return $false }
}
# 替换失败的原因分开说：没权限 / 被占用，并附系统原话（以前一律写「被占用」，权限问题也被说成占用）。
function Explain($err, $rel) {
  $e = $err.Exception; $msg = $e.Message
  $open = (Names (Others-Now)) -join '、'
  if ($open) { return "替换 $rel 失败：还有别的 Hub 窗口开着（$open）。请把所有 Hub 窗口都关掉后再更新" }
  $left = @(Get-Leftovers | ForEach-Object { $_.Name + '(' + $_.Id + ')' }) -join '、'
  if ($left) { return "替换 $rel 失败：文件被占用，这些程序还在运行：$left（$msg）" }
  if ($e -is [UnauthorizedAccessException] -or $msg -match 'denied|拒绝') { return "替换 $rel 失败：没有写入安装目录的权限（$msg）" }
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
      # 先写到同目录的临时名并核对，再一步换上：中途断电、关机或脚本被结束时，原文件要么是旧的要么是新的，不会只剩半截。
      $tmp = $dest + '.hub-new'
      $old = $dest + '.hub-old'
      try { Copy-Item -LiteralPath (Join-Path $p.newDir $f.path) -Destination $tmp -Force } catch { throw (Explain $_ $f.path) }
      $h = (Get-Sha256 $tmp).ToLower()
      if ($h -ne $f.sha256) { throw "替换后 $($f.path) 校验不一致" }
      $swapped = $false
      $tries = if ($p.swapTries) { [int]$p.swapTries } else { 40 }
      for ($i = 0; $i -lt $tries -and -not $swapped; $i++) {
        try {
          if ($existed) { [IO.File]::Replace($tmp, $dest, $old) } else { [IO.File]::Move($tmp, $dest) }
          $swapped = $true
        } catch {
          # 被占用等 0.5 秒再试，最多 20 秒。
          if ($i -ge $tries - 1) { throw (Explain $_ $f.path) }
          Beat
          Start-Sleep -Milliseconds 500
        }
      }
      Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    }
    if ($p.simulateFailure) { throw $p.simulateFailure }
    Write-Result $true '' $false
    Remove-Item -LiteralPath $p.newDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    $reason = $_.Exception.Message
    $restored = $true
    foreach ($d in $done) {
      Remove-Item -LiteralPath ($d.dest + '.hub-new') -Force -ErrorAction SilentlyContinue
      try {
        if ($p.simulateRestoreFailure) { throw 'simulateRestoreFailure' }
        # 还没被换掉的（比如没权限、第一次复制就失败）不用再写回，免得写回本身也失败、误报「没能恢复」。
        if ($d.existed) { if ((Get-Sha256 $d.dest) -ne (Get-Sha256 $d.bak)) { Copy-Item -LiteralPath $d.bak -Destination $d.dest -Force } }
        elseif (Test-Path -LiteralPath $d.dest) { Remove-Item -LiteralPath $d.dest -Force }
      } catch { $restored = $false }
    }
    Write-Result $false $reason $restored (-not $restored)
  }
}
function Is-Cancelled($e) {
  # Windows PowerShell 5.1 把「用户点了否」包成 InvalidOperationException，不一定带内层异常，所以再按原话认一次。
  while ($e) { if (($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) -or $e.Message -match '取消|cancel') { return $true }; $e = $e.InnerException }
  return $false
}
function Read-Result { try { return (Get-Content -LiteralPath $p.resultFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null } }
# 一次替换（普通权限直接换；受保护目录申请一次管理员授权）。返回结果对象。
function Do-Replace {
  $script:elevationAttempted = $false
  if (Test-Writable $p.resourcesDir) { Replace-Files; return (Read-Result) }
  $script:elevationAttempted = $true
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
  return (Read-Result)
}

# 管理员副本（2026-10-30）：只替换文件、写结果，不重新打开程序——由普通权限的那一份负责，免得 Hub 以管理员身份运行。
if ($Elevated) { Replace-Files; exit 0 }

# 多开时两个窗口可能先后退出，各起一个脚本：只让先到的那个干活，它结束时系统自动释放。
try { $script:helperLock = [IO.File]::Open((Join-Path $p.stagingDir 'helper.lock'), 'OpenOrCreate', 'ReadWrite', 'None') } catch { Relaunch; exit 0 }

Start-Ui
Set-Progress 1 '保存会话并关闭旧窗口' '通常 3–20 秒'
$deadline = (Get-Date).AddSeconds([int]$p.waitSeconds)
while ($p.pid -and (Get-Process -Id ([int]$p.pid) -ErrorAction SilentlyContinue)) {
  if ($p.cancelFile -and (Test-Path -LiteralPath $p.cancelFile)) { Set-Progress 0 $null $null @{} 'cancelled'; exit 0 }
  if ((Get-Date) -gt $deadline) {
    # 旧窗口没退出（一般是有会话没保存完、Hub 取消了关闭）：它还开着，不再多开一个旧版。
    $why = '旧窗口一直没有退出（可能有会话还没保存完，Hub 取消了关闭），没有替换任何文件。旧窗口还开着，可以在里面再点一次「立即重启」'
    Write-Result $false $why $false
    Set-Progress 1 '旧窗口没有退出' '' @{ reason = $why; final = $true } 'failed'
    [void](Wait-Decision 120)
    exit 1
  }
  Beat
  Start-Sleep -Milliseconds 300
}
# 主进程退了，子进程可能还要一会儿（GPU、终端等）；同一 exe 的子进程最多等 5 秒，之后当残留结束。
Set-Progress 2 '等待后台进程收尾' '通常 0–10 秒'
$childDeadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $childDeadline -and @(Get-Leftovers | Where-Object { $_.Path -ieq [string]$p.exe }).Count -and (-not $script:snapWmi -or -not (Others-Now).Count)) { Beat; Start-Sleep -Milliseconds 400 }
# 静默替换是顺手的事：还有 Hub 开着（另开的，或用户刚关又开）就不动，留给下次退出。
if ($p.quiet -and (Others-Now).Count) { exit 0 }
# 还有别的 Hub 开着（多开、最小化到托盘、或升级途中又点开的旧版）：它们锁着 app.asar，以前硬换 20 秒后回滚、再开一个旧版。
# 现在在进度窗里列出来，用户点「关闭它们并继续升级」才关；不点就不换，也不再多开旧版。
$others = @(Others-Now)
if ($others.Count -and -not (Ui-Alive)) {
  # 没有进度窗（没开起来或被用户关掉）就问不了用户：不结束它们、不硬换，照原来的做法打开程序，原因写进结果。
  Write-Result $false ('还有别的 Hub 开着，这次没有升级（' + ((Names $others) -join '、') + '）。把它们都关掉后，在任意一个 Hub 里再点「立即重启」即可') $false
  Relaunch
  exit 0
}
if ($others.Count) {
  Set-Progress 2 '还有别的 Hub 开着' '' @{ need = 'close-others'; others = @(Names $others) }
  $d = Wait-Decision 900
  if ($d -eq 'close-others') { Set-Progress 2 '正在关闭别的 Hub' '通常 3–25 秒'; Close-Others @(Others-Now) }
  else {
    $why = '还有别的 Hub 开着，这次没有升级（' + ((Names $others) -join '、') + '）。把它们都关掉后，在任意一个 Hub 里再点「立即重启」即可'
    Write-Result $false $why $false
    Set-Progress 2 '这次没有升级' '' @{ reason = $why; final = $true } 'failed'
    exit 0
  }
}
Stop-Orphans
# 安装目录里别的程序（终端宿主等）最多再等 leftoverWaitSeconds 秒；还在就照常尝试，失败时报出名字。
$leftDeadline = (Get-Date).AddSeconds([int]$p.leftoverWaitSeconds)
while ((Get-Date) -lt $leftDeadline -and (Get-Leftovers).Count) { Beat; Start-Sleep -Milliseconds 500 }

$attempt = 0
while ($true) {
  $attempt++
  Set-Progress 3 '替换程序文件' '通常 1–5 秒'
  $r = Do-Replace
  if ($r -and $r.restoreFailed) {
    # 没能恢复原文件（2026-11-13 审查返工）：安装目录可能新旧混在一起。再试一次会把这些混合文件当成「原版本」重新备份，
    # 真正的原文件就丢了；自动重开也可能打不开或带病运行。所以立即停：不重试、不重开，原备份改名留着。
    $kept = ''
    $bk = Join-Path $p.stagingDir 'backup'
    if (Test-Path -LiteralPath $bk) { $kept = Join-Path $p.stagingDir ('backup-restore-failed-' + (Get-Date).ToString('yyyyMMdd-HHmmss')); try { Move-Item -LiteralPath $bk -Destination $kept -ErrorAction Stop } catch { $kept = $bk } }
    $why = '升级出错，而且没能把原来的文件全部恢复（' + [string]$r.reason + '）。程序文件可能新旧混在一起，已停止，没有自动重新打开。请用完整安装包重新安装' + $(if ($kept) { '；原来的文件备份在 ' + $kept } else { '' })
    Write-Result $false $why $false $true
    Set-Progress 3 '没能恢复原来的版本' '' @{ reason = $why; final = $true; restoreFailed = $true } 'failed'
    if (Ui-Alive) { [void](Wait-Decision 600) }
    exit 1
  }
  # 授权被取消或管理员副本替换失败：普通权限父脚本立即重开原版。
  # 结束占用进程不能解决授权问题；等进度窗再确认会让 Hub 消失最多 10 分钟。
  # 回滚失败已在上面停止，不能重开可能损坏的版本。
  if (($r -and $r.ok) -or $script:elevationAttempted -or $attempt -ge 4 -or -not (Ui-Alive)) { break }
  # 失败已自动还原：在进度窗里说清原因，用户点「结束占用的程序并重试」就结束安装目录里还在跑的本程序进程再换一次。
  $why = if ($r) { [string]$r.reason } else { '替换没有留下结果' }
  Set-Progress 3 '这次没换成，已恢复原版本' '' @{ need = 'retry'; reason = $why; rolledBack = [bool]($r -and $r.rolledBack); leftovers = @(Names (@(Others-Now) + @(Get-Leftovers | Where-Object { $_.Path -ine [string]$p.exe }))) } 'failed'
  $d = Wait-Decision 600
  if ($d -ne 'retry') { break }
  Set-Progress 3 '正在结束占用的程序' '通常 1–25 秒'
  $o = @(Others-Now); if ($o.Count) { Close-Others $o }
  Stop-Orphans $true
}
if ($r -and $r.ok) { Set-Progress 4 '打开新版本' '通常 3–10 秒' @{} 'done' }
else { Set-Progress 4 '打开原来的版本' '' @{ reason = $(if ($r) { [string]$r.reason } else { '' }) } 'gave-up' }
Relaunch
`;

function stagingPaths(dataDir) {
  const root = path.join(dataDir, 'app-update');
  return { root, downloads: path.join(root, 'downloads'), newDir: path.join(root, 'new'), plan: path.join(root, 'plan.json'),
    helper: path.join(root, 'apply-update.ps1'), result: path.join(root, 'last-result.json'), started: path.join(root, 'helper-started.flag'), cancel: path.join(root, 'helper-cancelled.flag'),
    // 升级进度（2026-11-13）：进度、进度窗按钮的选择、升级途中又点图标的请求，以及进度窗脚本。
    progress: path.join(root, 'progress.json'), decision: path.join(root, 'decision.json'), focus: path.join(root, 'focus-request.flag'), lock: path.join(root, 'helper.lock'),
    progressUi: path.join(root, 'upgrade-progress.ps1') };
}

// 解包并写替换计划；不动安装目录。
// 普通权限能不能写这个目录（建一个临时文件再删）。Windows 的权限看 ACL，fs.access 判断不准，所以真写一次。
function canWriteDir(dir) {
  const probe = path.join(dir, '.hub-update-write-test-' + process.pid);
  try { fs.writeFileSync(probe, 'x'); fs.rmSync(probe, { force: true }); return true; } catch (_) { return false; }
}

// elevateMode 只给测试用：'plain' 不弹授权框、按普通权限跑管理员那一份；'cancel' 模拟用户在授权框点了「否」。
function stageIncremental({ dataDir, payloadFile, resourcesDir, version, from, exe, args = [], pid = process.pid, simulateFailure = null, relaunch = true,
  elevateMode = null, leftoverWaitSeconds = 10, expectedAsar = null, progressUi = false, productName = 'AI Hub' }) {
  const p = stagingPaths(dataDir);
  fs.rmSync(p.newDir, { recursive: true, force: true });
  fs.mkdirSync(p.newDir, { recursive: true });
  // app.asar 放最后换：中途断掉时版本号还是旧的，下次检查发现文件对不上，会改下完整更新包补齐；反过来就再也不会更新了。
  const unpacked = unpackPayload(payloadFile, p.newDir, { resourcesDir, from, expectedAsar });
  const files = [...unpacked.filter(f => f.path !== 'app.asar'), ...unpacked.filter(f => f.path === 'app.asar')];
  const plan = { version, from, pid, exe, args, relaunch, waitSeconds: 90, resourcesDir, appDir: path.dirname(path.resolve(resourcesDir)), leftoverWaitSeconds,
    newDir: p.newDir, stagingDir: p.root, resultFile: p.result, startedFile: p.started, cancelFile: p.cancel, progressFile: p.progress, decisionFile: p.decision, progressUi: !!progressUi, progressUiScript: p.progressUi, productName, files, ...(simulateFailure ? { simulateFailure } : {}), ...(elevateMode ? { elevateMode } : {}) };
  try { for (const x of [p.started, p.cancel, p.progress, p.decision, p.focus]) fs.rmSync(x, { force: true }); } catch (_) {}
  fs.writeFileSync(p.plan, JSON.stringify(plan, null, 2), 'utf8');
  fs.writeFileSync(p.helper, '﻿' + HELPER, 'utf8');
  fs.writeFileSync(p.progressUi, '﻿' + PROGRESS_UI, 'utf8');
  return { plan, paths: p, needsAdmin: !canWriteDir(resourcesDir) };
}

// 隐藏启动替换脚本（本进程退出后它继续跑）。
// 本机实测（2026-10-13）：直接 detached 启动 powershell.exe 一行都不执行；经 cmd 的 start /b 转一手
// 才能在本进程退出后继续跑完。/s 让 cmd 原样保留引号里的路径（可带空格）。
// 不能再给 cmd 加 detached（2026-11-12 公司电脑事故）：detached 的 cmd 没有控制台，start /b 起的
// powershell 只好自己新开一个；默认终端是 Windows Terminal 时 -WindowStyle Hidden 藏不住，桌面留下
// 一个空的「管理员:」终端窗口，重启后的 Hub 还挂在这个控制台上，用户一关窗口 Hub 就被一起关掉。
// 不加 detached、只靠 windowsHide 时，cmd 带一个没有窗口的控制台，powershell 和重启后的 Hub 都继承它，
// 全程不出现窗口；实测 Electron 退出后脚本照常跑完（直接 spawn powershell 则会随 Electron 一起退出）。
function launchHelper(paths, { env = process.env, spawnImpl = spawn } = {}) {
  const line = `/d /s /c "start "" /b powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${paths.helper}" -Plan "${paths.plan}""`;
  const child = spawnImpl(process.env.ComSpec || 'cmd.exe', [line], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env });
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

module.exports = { HELPER, PROGRESS_UI, stagingPaths, canWriteDir, stageIncremental, launchHelper, takeLastResult };
