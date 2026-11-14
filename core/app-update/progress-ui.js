'use strict';
// 升级进度小窗（2026-11-13）。用户反馈：点「立即重启」后到新版打开之间屏幕上什么都没有，以为失败又点一次图标，
// 打开的还是旧版；多开时替换失败、回滚后又开出旧版。
// 替换脚本（apply.js 的 HELPER）把每一步写进 progress.json，这个小窗每 0.4 秒读一次并显示：
//   正在升级到哪一版 · 第几步 · 这一步已等多久、通常多久 · 总共已等多久；
//   升级途中用户又点了图标（launch-guard.js 写 focus-request.flag）：小窗跳到最前面并说明「不用再点」；
//   还有别的 Hub 开着、或替换失败已还原时：说清原因，给一个按钮（写 decision.json，替换脚本照做）。
// 小窗是单独的 PowerShell 进程，不读安装目录里的任何文件，不会占住要换的文件。
// -Snapshot 只给测试和截图用：按 -State 给的状态画一张 PNG 后退出，不显示窗口、不抢焦点。
const PROGRESS_UI = String.raw`param([string]$Dir, [string]$Snapshot, [string]$State)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$progressFile = Join-Path $Dir 'progress.json'
$decisionFile = Join-Path $Dir 'decision.json'
$focusFile = Join-Path $Dir 'focus-request.flag'
function Read-State {
  if ($Snapshot) { return (Get-Content -LiteralPath $State -Raw -Encoding UTF8 | ConvertFrom-Json) }
  try { return ([IO.File]::ReadAllText($progressFile) | ConvertFrom-Json) } catch { return $null }
}
function Secs($iso) { try { return [int][Math]::Max(0, ((Get-Date) - [DateTime]::Parse($iso)).TotalSeconds) } catch { return 0 } }
$ink = [Drawing.Color]::FromArgb(31, 35, 41); $muted = [Drawing.Color]::FromArgb(96, 104, 115)
$brand = [Drawing.Color]::FromArgb(139, 92, 246); $bad = [Drawing.Color]::FromArgb(196, 43, 28); $ok = [Drawing.Color]::FromArgb(22, 128, 61)
$fn = 'Microsoft YaHei UI'
$form = New-Object Windows.Forms.Form
$form.Text = 'AI Hub 升级'; $form.ClientSize = New-Object Drawing.Size(480, 252)
$form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false; $form.MinimizeBox = $true
$form.StartPosition = 'CenterScreen'; $form.BackColor = [Drawing.Color]::White; $form.Font = New-Object Drawing.Font($fn, 9.5)
$form.TopMost = $true; $form.ShowInTaskbar = $true
function Label($y, $h, $size, $style, $color) {
  $l = New-Object Windows.Forms.Label; $l.Location = New-Object Drawing.Point(24, $y); $l.Size = New-Object Drawing.Size(432, $h)
  $l.Font = New-Object Drawing.Font($fn, $size, $style); $l.ForeColor = $color; $l.AutoEllipsis = $true; $form.Controls.Add($l); return $l
}
$title = Label 18 30 13 ([Drawing.FontStyle]::Bold) $ink
$sub = Label 50 22 9.5 ([Drawing.FontStyle]::Regular) $muted
$step = Label 84 24 10.5 ([Drawing.FontStyle]::Bold) $ink
$bar = New-Object Windows.Forms.ProgressBar; $bar.Location = New-Object Drawing.Point(24, 112); $bar.Size = New-Object Drawing.Size(432, 8); $bar.Maximum = 1000; $form.Controls.Add($bar)
$time = Label 126 22 9.5 ([Drawing.FontStyle]::Regular) $muted
$note = Label 150 54 9.5 ([Drawing.FontStyle]::Regular) $ink
function Button($x, $w) {
  $b = New-Object Windows.Forms.Button; $b.Location = New-Object Drawing.Point($x, 210); $b.Size = New-Object Drawing.Size($w, 30)
  $b.FlatStyle = 'Flat'; $b.Font = New-Object Drawing.Font($fn, 9.5); $b.Visible = $false; $form.Controls.Add($b); return $b
}
$b2 = Button 24 150; $b1 = Button 186 270
$b1.BackColor = $brand; $b1.ForeColor = [Drawing.Color]::White; $b1.FlatAppearance.BorderColor = $brand
$b2.BackColor = [Drawing.Color]::White; $b2.ForeColor = $ink; $b2.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(208, 213, 221)
$script:a1 = $null; $script:a2 = $null; $script:focusSeen = $null; $script:focusNote = ''; $script:doneAt = $null; $script:goneAt = $null
function Decide($action) {
  if (-not $action) { return }
  if ($action -eq 'close') { $form.Close(); return }
  try { [IO.File]::WriteAllText($decisionFile, ('{"action":"' + $action + '"}')) } catch {}
  $b1.Enabled = $false; $b2.Enabled = $false; $note.Text = '收到，正在处理…'
}
$b1.Add_Click({ Decide $script:a1 }); $b2.Add_Click({ Decide $script:a2 })
function Buttons($t1, $act1, $t2, $act2) {
  $script:a1 = $act1; $script:a2 = $act2
  $b1.Text = $t1; $b1.Visible = [bool]$t1; $b1.Enabled = $true
  $b2.Text = $t2; $b2.Visible = [bool]$t2; $b2.Enabled = $true
}
function Render($s) {
  if (-not $s) { return }
  $product = if ($s.product) { [string]$s.product } else { 'AI Hub' }
  $form.Text = $product + ' 升级'
  $sub.Text = $(if ($s.from) { 'v' + $s.from + ' → v' + $s.version } else { 'v' + $s.version }) + $(if ($s.state -eq 'running') { ' · 完成后会自动打开新版，不用再点图标' } else { '' })
  $total = Secs $s.startedAt; $inStep = Secs $s.stepStartedAt
  $n = [int]$s.step; if ($n -lt 1) { $n = 1 }
  $step.Text = '第 ' + $n + '/4 步 · ' + $s.label
  $title.ForeColor = $ink; $step.ForeColor = $ink
  $bar.Value = [Math]::Min(1000, [int](($n - 1) * 250 + [Math]::Min(230, $inStep * 12)))
  $time.Text = '这一步已等 ' + $inStep + ' 秒' + $(if ($s.typical) { '（' + $s.typical + '）' } else { '' }) + ' · 总共 ' + $total + ' 秒'
  $note.ForeColor = $ink
  if ($s.state -eq 'running' -and $s.need -eq 'close-others') {
    $title.Text = '还有别的 ' + $product + ' 开着'
    $note.Text = '它们占着程序文件，不关掉就换不了：' + (@($s.others) -join '、') + '。关闭时会先保存会话，正在生成的回答会中断，重新打开后会话可以接着用。'
    Buttons '关闭它们并继续升级' 'close-others' '这次先不升级' 'cancel'
  } elseif ($s.state -eq 'failed' -and $s.need -eq 'retry') {
    $title.Text = '这次没换成，已恢复原来的版本'; $title.ForeColor = $bad
    $note.Text = [string]$s.reason + $(if (@($s.leftovers).Count) { '。还在运行：' + (@($s.leftovers) -join '、') } else { '' })
    Buttons '结束占用的程序并重试' 'retry' '先用原来的版本' 'give-up'
  } elseif ($s.state -eq 'failed') {
    $title.Text = $(if ($s.restoreFailed) { '升级出错，没能恢复原来的版本' } else { '这次没有升级' }); $title.ForeColor = $bad; $note.Text = [string]$s.reason; $bar.Value = 0
    Buttons '' $null '知道了' 'close'
  } elseif ($s.state -eq 'done') {
    $title.Text = '升级完成，正在打开 v' + $s.version; $title.ForeColor = $ok; $bar.Value = 1000
    $note.Text = '新版窗口马上出现，这个小窗会自动关闭。'
    Buttons '' $null '' $null
  } elseif ($s.state -eq 'gave-up') {
    $title.Text = '正在打开原来的版本'; $bar.Value = 0; $note.Text = [string]$s.reason; Buttons '' $null '' $null
  } else {
    $title.Text = '正在升级到 v' + $s.version
    $note.Text = $(if ($script:focusNote) { $script:focusNote } else { '升级期间请不要再点图标；如果点了，会回到这个小窗。' })
    Buttons '' $null '' $null
  }
  if ($script:focusNote -and $s.state -eq 'running' -and $s.need -ne 'close-others') { $note.ForeColor = $brand }
}
if ($Snapshot) {
  $s = Read-State
  if ($s.focusNote) { $script:focusNote = [string]$s.focusNote }
  Render $s
  # 放到屏幕外、不激活地显示（不抢焦点、不进任务栏），用 PrintWindow 连标题栏一起画下来。
  Add-Type -Namespace HubUpg -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);'
  $form.ShowInTaskbar = $false; $form.TopMost = $false; $form.StartPosition = 'Manual'; $form.Location = New-Object Drawing.Point(-32000, -32000)
  $h = $form.Handle
  [void][HubUpg.W]::ShowWindow($h, 4)
  for ($i = 0; $i -lt 10; $i++) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 30 }
  $bmp = New-Object Drawing.Bitmap($form.Width, $form.Height)
  $g = [Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc(); [void][HubUpg.W]::PrintWindow($h, $dc, 2); $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save($Snapshot, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $form.Dispose()
  exit 0
}
$timer = New-Object Windows.Forms.Timer; $timer.Interval = 400
$timer.Add_Tick({
  $s = Read-State
  try { $f = [IO.File]::GetLastWriteTimeUtc($focusFile); if ((Test-Path -LiteralPath $focusFile) -and $f -ne $script:focusSeen) {
    $first = $null -eq $script:focusSeen; $script:focusSeen = $f
    if (-not $first -or ((Get-Date).ToUniversalTime() - $f).TotalSeconds -lt 5) {
      $script:focusNote = '你刚才又点了一次图标：升级还在进行，完成后会自动打开新版，不用再点。'
      if ($form.WindowState -eq 'Minimized') { $form.WindowState = 'Normal' }
      $form.TopMost = $true; $form.Activate(); [Media.SystemSounds]::Asterisk.Play()
    } } } catch {}
  Render $s
  if (-not $s) { return }
  if ($s.state -in @('done', 'gave-up', 'cancelled')) { if (-not $script:doneAt) { $script:doneAt = Get-Date }; if (((Get-Date) - $script:doneAt).TotalSeconds -gt $(if ($s.state -eq 'done') { 6 } else { 2 })) { $form.Close() } }
  # 替换脚本没了（被结束、或已经结束）又没有要用户看的结果：不留一个永远转圈的小窗。
  $alive = $false; try { $alive = [bool](Get-Process -Id ([int]$s.helperPid) -ErrorAction Stop) } catch {}
  if (-not $alive -and $s.state -ne 'failed') { if (-not $script:goneAt) { $script:goneAt = Get-Date }; if (((Get-Date) - $script:goneAt).TotalSeconds -gt 3) { $form.Close() } }
})
$form.Add_Shown({ $form.Activate(); $timer.Start() })
# 用户关掉小窗：要他选的就当「这次先不升级 / 先用原来的版本」，其余照常进行。
$form.Add_FormClosing({ $timer.Stop(); $s = Read-State; if ($s -and $s.need -and $s.state -in @('running', 'failed') -and $b2.Visible -and $b2.Enabled -and $script:a2 -ne 'close') { try { [IO.File]::WriteAllText($decisionFile, ('{"action":"' + $script:a2 + '"}')) } catch {} } })
Render (Read-State)
[void][Windows.Forms.Application]::Run($form)
`;

module.exports = { PROGRESS_UI };
