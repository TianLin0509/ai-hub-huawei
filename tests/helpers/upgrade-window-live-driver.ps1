param([string]$Ui, [string]$Work, [string]$Out)
# 升级进度小窗真实窗口实测（tests/e2e-upgrade-window-live.js 调用）：由 window-flash-watch.py 放在私有桌面上运行，拉起的小窗也在那张桌面，用户屏幕上看不到。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [Windows.Automation.AutomationElement]; $TS = [Windows.Automation.TreeScope]
$results = New-Object Collections.ArrayList
function Rec($name, $ok, $detail) { [void]$results.Add([ordered]@{ check = $name; ok = [bool]$ok; detail = [string]$detail }) }
function Iso($msAgo) { return (Get-Date).ToUniversalTime().AddMilliseconds(-$msAgo).ToString('o') }
function Put($dir, $s) {
  $b = [ordered]@{ version = '9.0.1'; from = '9.0.0'; product = 'AI Hub'; total = 4; startedAt = (Iso 20000); updatedAt = (Iso 0); helperPid = $PID; step = 2; label = '等待后台进程收尾'; typical = '通常 0–10 秒'; stepStartedAt = (Iso 4000) }
  foreach ($k in $s.Keys) { $b[$k] = $s[$k] }
  $tmp = Join-Path $dir 'progress.tmp'; [IO.File]::WriteAllText($tmp, ($b | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $tmp -Destination (Join-Path $dir 'progress.json') -Force
}
function Start-Ui($script, $dir) {
  $si = New-Object Diagnostics.ProcessStartInfo; $si.FileName = Join-Path $PSHOME 'powershell.exe'
  $si.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "' + $script + '" -Dir "' + $dir + '"'
  $si.UseShellExecute = $false; $si.CreateNoWindow = $true; $si.RedirectStandardError = $true; $si.RedirectStandardOutput = $true
  $p = [Diagnostics.Process]::Start($si); $script:errTask = $p.StandardError.ReadToEndAsync(); [void]$p.StandardOutput.ReadToEndAsync(); return $p
}
function Until($sec, [scriptblock]$cond) { $sw = [Diagnostics.Stopwatch]::StartNew(); while ($sw.Elapsed.TotalSeconds -lt $sec) { $r = $null; try { $r = & $cond } catch {}; if ($r) { return $sw.Elapsed.TotalMilliseconds }; Start-Sleep -Milliseconds 50 }; return -1 }
function Win($p) { foreach ($e in $A::RootElement.FindAll($TS::Children, (New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty, $p.Id)))) { try { if ($e.Current.Name -like '*升级*') { return $e } } catch {} }; return $null }
function ByName($w, $name) { if (-not $w) { return $null }; return $w.FindFirst($TS::Descendants, (New-Object Windows.Automation.PropertyCondition($A::NameProperty, $name))) }
function Has($w, $sub) { if (-not $w) { return $false }; foreach ($e in $w.FindAll($TS::Descendants, [Windows.Automation.Condition]::TrueCondition)) { try { if ($e.Current.Name -like ('*' + $sub + '*')) { return $true } } catch {} }; return $false }
Add-Type -Namespace R19 -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'
function Click($w, $name) {
  $b = ByName $w $name; if (-not $b) { return $false }
  $o = $null; if ($b.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$o)) { $o.Invoke(); return $true }
  # WinForms 平面按钮：直接给按钮句柄发 BM_CLICK（等同用户点击）
  $h = $b.Current.NativeWindowHandle; if ($h) { return [R19.U]::PostMessage([IntPtr]$h, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) }; return $false
}
function Decision($dir) { $f = Join-Path $dir 'decision.json'; if (Test-Path -LiteralPath $f) { return [string](Get-Content -LiteralPath $f -Raw | ConvertFrom-Json).action }; return $null }
function NewDir($n) { $d = Join-Path $Work $n; New-Item -ItemType Directory -Force -Path $d | Out-Null; Remove-Item (Join-Path $d '*') -Force -ErrorAction SilentlyContinue; return $d }
function Finish($tag, $p) {
  $exited = $p.WaitForExit(15000); if (-not $exited) { try { $p.Kill() } catch {} }
  $err = ''; try { $err = $script:errTask.Result.Trim() } catch {}
  Rec ($tag + '：小窗进程没有报错输出') ($err -eq '') $err.Substring(0, [Math]::Min(400, $err.Length))
}

function Run-Main($tag, $script) {
  # 显示 → 0.4 秒刷新 → 最小化后又点图标被拉回 → 别的 Hub 开着点主按钮 → 完成后自动关
  $d = NewDir ($tag + '-main'); Put $d @{ state = 'running' }
  $p = Start-Ui $script $d
  $t = Until 20 { Has (Win $p) '正在升级到 v9.0.1' }; Rec ($tag + '：真实窗口显示出来') ($t -ge 0) ('ms=' + [int]$t)
  $w = Win $p
  Put $d @{ state = 'running'; version = '9.0.2' }
  $t = Until 5 { Has $w '正在升级到 v9.0.2' }; Rec ($tag + '：改 progress.json 后界面跟着刷新（0.4 秒轮询）') ($t -ge 0 -and $t -lt 1500) ('ms=' + [int]$t)
  $wp = $w.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
  Rec ($tag + '：小窗置顶') ([bool]$wp.Current.IsTopmost) ''
  if (ByName $w '最小化') { [void](Click $w '最小化') } else { $wp.SetWindowVisualState('Minimized') }; Start-Sleep -Milliseconds 500
  $min = [string]$wp.Current.WindowVisualState
  [IO.File]::WriteAllText((Join-Path $d 'focus-request.flag'), 'x')
  $t = Until 5 { ([string]$wp.Current.WindowVisualState -eq 'Normal') -and (Has $w '你刚才又点了一次图标') }
  Rec ($tag + '：最小化后又点图标，小窗恢复并提示不用再点') ($min -eq 'Minimized' -and $t -ge 0) ('min=' + $min + ' ms=' + [int]$t)
  Put $d @{ state = 'running'; need = 'close-others'; others = @('AI Hub（进程 1234）') }
  $t = Until 5 { ByName $w '关闭它们并继续升级' }
  $ok = ($t -ge 0) -and (Click $w '关闭它们并继续升级')
  $t2 = Until 3 { (Decision $d) -eq 'close-others' }; Rec ($tag + '：点「关闭它们并继续升级」写 decision.json=close-others') ($ok -and $t2 -ge 0) ('got=' + (Decision $d))
  Rec ($tag + '：点后提示收到、正在处理') ((Until 3 { Has $w '收到，正在处理' }) -ge 0) ''
  Remove-Item (Join-Path $d 'decision.json') -Force -ErrorAction SilentlyContinue
  Put $d @{ state = 'done'; step = 4; label = '打开新版本' }
  $sw = [Diagnostics.Stopwatch]::StartNew(); $gone = $p.WaitForExit(12000)
  Rec ($tag + '：完成后约 6 秒自动关闭') ($gone -and $sw.Elapsed.TotalSeconds -ge 5 -and $sw.Elapsed.TotalSeconds -lt 9) ('s=' + [Math]::Round($sw.Elapsed.TotalSeconds, 1))
  Finish $tag $p
}
function Run-Retry($tag, $script) {
  $d = NewDir ($tag + '-retry'); Put $d @{ state = 'failed'; step = 3; need = 'retry'; reason = '替换 app.asar 失败：文件被占用'; leftovers = @('OpenConsole(4321)') }
  $p = Start-Ui $script $d; $t = Until 20 { ByName (Win $p) '先用原来的版本' }
  $ok = ($t -ge 0) -and (Click (Win $p) '先用原来的版本'); $t2 = Until 3 { (Decision $d) -eq 'give-up' }
  Rec ($tag + '：失败已还原时点「先用原来的版本」写 give-up') ($ok -and $t2 -ge 0) ('got=' + (Decision $d))
  Put $d @{ state = 'gave-up'; step = 3; reason = '已按你的选择先用原来的版本' }
  $sw = [Diagnostics.Stopwatch]::StartNew(); $gone = $p.WaitForExit(8000)
  Rec ($tag + '：放弃后约 2 秒自动关闭') ($gone -and $sw.Elapsed.TotalSeconds -lt 5) ('s=' + [Math]::Round($sw.Elapsed.TotalSeconds, 1))
  Finish $tag $p
}
function Run-CloseDefault($tag, $script) {
  $d = NewDir ($tag + '-close'); Put $d @{ state = 'running'; need = 'close-others'; others = @('AI Hub（进程 1234）') }
  $p = Start-Ui $script $d; [void](Until 20 { ByName (Win $p) '这次先不升级' })
  $w = Win $p; $c = ByName $w '关闭'
  if ($c) { [void](Click $w '关闭') } else { $w.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close() }
  $t = Until 5 { (Decision $d) -eq 'cancel' }
  Rec ($tag + '：要用户选择时关窗，默认写 cancel') ($t -ge 0) ('got=' + (Decision $d) + ' via=' + $(if ($c) { '自绘关闭' } else { '系统关闭' }))
  Rec ($tag + '：关窗后进程退出') ($p.WaitForExit(5000)) ''
  Finish $tag $p
}
function Run-Ack($tag, $script) {
  $d = NewDir ($tag + '-ack'); Put $d @{ state = 'failed'; step = 3; reason = '新版文件校验没通过，已保留原来的版本' }
  $p = Start-Ui $script $d; $t = Until 20 { ByName (Win $p) '知道了' }
  $ok = ($t -ge 0) -and (Click (Win $p) '知道了')
  Rec ($tag + '：普通失败点「知道了」关窗且不写决定') ($ok -and $p.WaitForExit(5000) -and -not (Decision $d)) ''
  Finish $tag $p
}
function Run-Gone($tag, $script) {
  $d = NewDir ($tag + '-gone'); Put $d @{ state = 'running'; helperPid = 999999 }
  $p = Start-Ui $script $d; $sw = [Diagnostics.Stopwatch]::StartNew(); $gone = $p.WaitForExit(15000)
  Rec ($tag + '：替换脚本已不在时自行关闭') ($gone -and $sw.Elapsed.TotalSeconds -lt 10) ('s=' + [Math]::Round($sw.Elapsed.TotalSeconds, 1))
  Finish $tag $p
}
$src = Get-Content -LiteralPath $Ui -Raw -Encoding UTF8
$noWpf = Join-Path $Work 'ui-nowpf.ps1'; [IO.File]::WriteAllText($noWpf, $src.Replace('PresentationFramework, PresentationCore, WindowsBase', 'NoSuchWpfAssembly'), (New-Object Text.UTF8Encoding $true))
$noFont = Join-Path $Work 'ui-nofont.ps1'; [IO.File]::WriteAllText($noFont, $src.Replace('FontFamily="Microsoft YaHei UI"', 'FontFamily="NoSuchFontXyz"').Replace('FontFamily="Segoe UI"', 'FontFamily="NoSuchFontXyz2"'), (New-Object Text.UTF8Encoding $true))
foreach ($c in @(@('WPF', $Ui), @('无WPF退回WinForms', $noWpf), @('字体缺失', $noFont))) {
  foreach ($f in 'Run-Main', 'Run-Retry', 'Run-CloseDefault', 'Run-Ack', 'Run-Gone') {
    try { & $f $c[0] $c[1] } catch { Rec ($c[0] + '：' + $f + ' 脚本异常') $false $_.Exception.Message }
  }
}
[IO.File]::WriteAllText($Out, (ConvertTo-Json -InputObject @($results) -Depth 4), (New-Object Text.UTF8Encoding $false))
