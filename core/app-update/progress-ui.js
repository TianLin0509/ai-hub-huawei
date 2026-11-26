'use strict';
// 升级进度小窗（2026-11-13）。用户反馈：点「立即重启」后到新版打开之间屏幕上什么都没有，以为失败又点一次图标，
// 打开的还是旧版；多开时替换失败、回滚后又开出旧版。
// 替换脚本（apply.js 的 HELPER）把每一步写进 progress.json，这个小窗每 0.4 秒读一次并显示：
//   正在升级到哪一版 · 第几步 · 这一步已等多久、通常多久 · 总共已等多久；
//   升级途中用户又点了图标（launch-guard.js 写 focus-request.flag）：小窗跳到最前面并说明「不用再点」；
//   还有别的 Hub 开着、或替换失败已还原时：说清原因，给一个按钮（写 decision.json，替换脚本照做）。
// 小窗是单独的 PowerShell 进程，不读安装目录里的任何文件，不会占住要换的文件。
// -Snapshot 只给测试和截图用：按 -State 给的状态画一张 PNG 后退出，不显示窗口、不抢焦点；-Scale 指定缩放（1 / 1.5），不给按 100%。
//
// 2026-11-16 改版（r19）：用户嫌原来的 WinForms 小窗「很丑很糊」。糊的根因：powershell.exe 没声明 DPI 感知，
// 150% 缩放下系统把 100% 画好的位图整体拉伸。改用 WPF（.NET Framework 4.x 自带，Win10/11 无需安装，矢量渲染），
// 进程先声明 Per-Monitor DPI 感知；外观取 Hub 的鸿蒙主题（renderer/styles/hw-tokens.css）：浅灰底白卡片、
// 圆角 16、鸿蒙蓝 #0A59F7、成功绿 #3A9E42、告警红 #CF0A2C、胶囊按钮，去掉系统标题栏改自绘标题行（最小化 / 关闭）。
// 只换外观：参数、progress.json / decision.json 格式、轮询与自动关闭时序、关窗即「先不升级」的约定都不变。
// WPF 加载失败时的退路：原来的 WinForms 小窗（2026-11-13 版），逻辑与新版一致。
const LEGACY_UI = String.raw`Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
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
  } elseif ($s.state -eq 'failed' -and $s.need -eq 'launch') {
    $title.Text = '新版本已换好，窗口还没出来'; $bar.Value = 1000; $note.Text = [string]$s.reason; $note.ForeColor = $brand
    Buttons '手动启动' 'launch' '关闭' 'close'
  } elseif ($s.state -eq 'failed') {
    $title.Text = $(if ($s.restoreFailed) { '升级出错，没能恢复原来的版本' } else { '这次没有升级' }); $title.ForeColor = $bad; $note.Text = [string]$s.reason; $bar.Value = 0
    Buttons '' $null '知道了' 'close'
  } elseif ($s.state -eq 'done') {
    $title.Text = '升级完成，正在打开 v' + $s.version; $title.ForeColor = $ok; $bar.Value = 1000
    $note.Text = '新版窗口已经打开，这个小窗马上自动关闭。'
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
  if ($s.state -in @('done', 'gave-up', 'cancelled')) { if (-not $script:doneAt) { $script:doneAt = Get-Date }; if (((Get-Date) - $script:doneAt).TotalSeconds -gt $(if ($s.state -eq 'done') { 3 } else { 2 })) { $form.Close() } }
  # 替换脚本没了（被结束、或已经结束）又没有要用户看的结果：不留一个永远转圈的小窗。
  $alive = $false; try { $alive = [bool](Get-Process -Id ([int]$s.helperPid) -ErrorAction Stop) } catch {}
  if (-not $alive -and $s.state -ne 'failed') { if (-not $script:goneAt) { $script:goneAt = Get-Date }; if (((Get-Date) - $script:goneAt).TotalSeconds -gt 3) { $form.Close() } }
})
$form.Add_Shown({ $form.Activate(); $timer.Start() })
# 用户关掉小窗：要他选的就当「这次先不升级 / 先用原来的版本」，其余照常进行。
$form.Add_FormClosing({ $timer.Stop(); $s = Read-State; if ($s -and $s.need -and $s.state -in @('running', 'failed') -and $b2.Visible -and $b2.Enabled -and $script:a2 -ne 'close') { try { [IO.File]::WriteAllText($decisionFile, ('{"action":"' + $script:a2 + '"}')) } catch {} } })
Render (Read-State)
[void][Windows.Forms.Application]::Run($form)
exit 0
`;

const PROGRESS_UI = String.raw`param([string]$Dir, [string]$Snapshot, [string]$State, [double]$Scale = 0)
$ErrorActionPreference = 'Continue'
# WPF 是 .NET Framework 4.x 自带的；万一加载不了（精简系统、组件损坏），退回原来的 WinForms 画法，升级不被卡住。
$wpf = $false; try { Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase -ErrorAction Stop; $wpf = $true } catch {}
$progressFile = Join-Path $Dir 'progress.json'
$decisionFile = Join-Path $Dir 'decision.json'
$focusFile = Join-Path $Dir 'focus-request.flag'
function Read-State {
  if ($Snapshot) { return (Get-Content -LiteralPath $State -Raw -Encoding UTF8 | ConvertFrom-Json) }
  try { return ([IO.File]::ReadAllText($progressFile) | ConvertFrom-Json) } catch { return $null }
}
function Secs($iso) { try { return [int][Math]::Max(0, ((Get-Date) - [DateTime]::Parse($iso)).TotalSeconds) } catch { return 0 } }
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  Title="AI Hub 升级" Width="512" SizeToContent="Height" WindowStyle="None" AllowsTransparency="True" Background="Transparent"
  ResizeMode="NoResize" WindowStartupLocation="CenterScreen" Topmost="True" ShowInTaskbar="True"
  FontFamily="Microsoft YaHei UI" UseLayoutRounding="True" TextOptions.TextFormattingMode="Ideal">
  <Window.Resources>
    <Style x:Key="Pill" TargetType="Button">
      <Setter Property="Height" Value="36"/><Setter Property="Padding" Value="20,0"/><Setter Property="FontSize" Value="14"/>
      <Setter Property="Cursor" Value="Hand"/><Setter Property="Background" Value="#EDEFF2"/><Setter Property="Foreground" Value="#182431"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border x:Name="b" CornerRadius="18" Background="{TemplateBinding Background}" Padding="{TemplateBinding Padding}">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.88"/></Trigger>
          <Trigger Property="IsEnabled" Value="False"><Setter TargetName="b" Property="Opacity" Value="0.45"/></Trigger>
        </ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style x:Key="Primary" TargetType="Button" BasedOn="{StaticResource Pill}">
      <Setter Property="Background" Value="#0A59F7"/><Setter Property="Foreground" Value="White"/><Setter Property="FontWeight" Value="SemiBold"/>
    </Style>
    <Style x:Key="Chrome" TargetType="Button">
      <Setter Property="Width" Value="32"/><Setter Property="Height" Value="28"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border x:Name="b" CornerRadius="8" Background="Transparent"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border>
        <ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Background" Value="#EDEFF2"/></Trigger></ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
  </Window.Resources>
  <Border x:Name="Shell" Margin="16" CornerRadius="16" Background="White" BorderBrush="#14182431" BorderThickness="1">
    <Border.Effect><DropShadowEffect BlurRadius="24" ShadowDepth="6" Direction="270" Opacity="0.14" Color="#182431"/></Border.Effect>
    <StackPanel Margin="24,14,24,22">
      <Grid x:Name="Head" Background="Transparent" Margin="0,0,-10,6">
        <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
          <Border Width="18" Height="18" CornerRadius="5" Background="#0A59F7"><Path Data="M4,9.5 L8,5.5 L12,9.5 M8,5.5 L8,13" Stroke="White" StrokeThickness="1.6" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round" Margin="1,0,0,0"/></Border>
          <TextBlock x:Name="AppName" Text="AI Hub 升级" Margin="8,0,0,0" FontSize="13" Foreground="#A8182431" VerticalAlignment="Center"/>
        </StackPanel>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
          <Button x:Name="MinBtn" Style="{StaticResource Chrome}" ToolTip="最小化" AutomationProperties.Name="最小化"><Path Data="M0,0 L10,0" Stroke="#99182431" StrokeThickness="1.3"/></Button>
          <Button x:Name="CloseBtn" Style="{StaticResource Chrome}" ToolTip="关闭" AutomationProperties.Name="关闭"><Path Data="M0,0 L9,9 M9,0 L0,9" Stroke="#99182431" StrokeThickness="1.3"/></Button>
        </StackPanel>
      </Grid>
      <TextBlock x:Name="TitleT" FontSize="20" FontWeight="SemiBold" Foreground="#182431" TextTrimming="CharacterEllipsis"/>
      <TextBlock x:Name="SubT" Margin="0,6,0,0" FontSize="13" Foreground="#A8182431" TextTrimming="CharacterEllipsis"/>
      <Border Margin="0,18,0,0" Padding="16,14" CornerRadius="12" Background="#F7F8FA">
        <StackPanel>
          <Grid>
            <TextBlock x:Name="StepT" FontSize="14" FontWeight="SemiBold" Foreground="#182431" TextTrimming="CharacterEllipsis" Margin="0,0,64,0"/>
            <TextBlock x:Name="PctT" HorizontalAlignment="Right" FontSize="13" FontFamily="Segoe UI" FontWeight="SemiBold" Foreground="#0A59F7"/>
          </Grid>
          <Grid x:Name="Track" Margin="0,10,0,0" Height="6">
            <Border CornerRadius="3" Background="#E3E7EC"/>
            <Border x:Name="Fill" CornerRadius="3" Background="#0A59F7" HorizontalAlignment="Left" Width="0"/>
          </Grid>
          <TextBlock x:Name="TimeT" Margin="0,10,0,0" FontSize="12" Foreground="#A8182431" TextTrimming="CharacterEllipsis"/>
        </StackPanel>
      </Border>
      <Border x:Name="NoteBox" Margin="0,14,0,0" Padding="0" CornerRadius="10" Background="Transparent">
        <TextBlock x:Name="NoteT" FontSize="13.5" LineHeight="21" Foreground="#182431" TextWrapping="Wrap"/>
      </Border>
      <Grid x:Name="BtnRow" Margin="0,18,0,0">
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
          <Button x:Name="B2" Style="{StaticResource Pill}" Margin="0,0,10,0"/>
          <Button x:Name="B1" Style="{StaticResource Primary}"/>
        </StackPanel>
      </Grid>
    </StackPanel>
  </Border>
</Window>
'@
$form = $null
if ($wpf) {
  try {
    # 清晰：在建任何窗口前声明 Per-Monitor V2 DPI 感知，并让 WPF 跟随显示器缩放重绘；老系统退回系统级感知。
    Add-Type -Namespace HubUpg -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
    try { [AppContext]::SetSwitch('Switch.System.Windows.DoNotScaleForDpiChanges', $false) } catch {}
    $dpiOk = $false; try { $dpiOk = [HubUpg.Dpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch {}
    if (-not $dpiOk) { try { [void][HubUpg.Dpi]::SetProcessDPIAware() } catch {} }
    $form = [Windows.Markup.XamlReader]::Parse($xaml)
  } catch { $form = $null }
}
if (-not $form) {
${LEGACY_UI}}
foreach ($n in 'Shell','Head','AppName','MinBtn','CloseBtn','TitleT','SubT','StepT','PctT','Track','Fill','TimeT','NoteBox','NoteT','BtnRow','B1','B2') { Set-Variable -Name ('x' + $n) -Value $form.FindName($n) }
function Brush($hex) { return [Windows.Media.BrushConverter]::new().ConvertFromString($hex) }
$ink = Brush '#182431'; $muted = Brush '#A8182431'; $brand = Brush '#0A59F7'; $bad = Brush '#CF0A2C'; $ok = Brush '#3A9E42'
$brandSoft = Brush '#E7EFFE'; $badSoft = Brush '#FCE8EB'; $clear = [Windows.Media.Brushes]::Transparent
$script:a1 = $null; $script:a2 = $null; $script:focusSeen = $null; $script:focusNote = ''; $script:doneAt = $null; $script:goneAt = $null; $script:pct = 0; $script:decided = $null; $script:stateKey = ''
function Decide($action) {
  if (-not $action) { return }
  if ($action -eq 'close') { $form.Close(); return }
  try { [IO.File]::WriteAllText($decisionFile, ('{"action":"' + $action + '"}')) } catch {}
  $script:decided = $script:stateKey; $xB1.IsEnabled = $false; $xB2.IsEnabled = $false; $xNoteT.Text = '收到，正在处理…'
}
$xB1.Add_Click({ Decide $script:a1 }); $xB2.Add_Click({ Decide $script:a2 })
$xMinBtn.Add_Click({ $form.WindowState = 'Minimized' }); $xCloseBtn.Add_Click({ $form.Close() })
$xHead.Add_MouseLeftButtonDown({ try { $form.DragMove() } catch {} })
function Show-El($el, $on) { $el.Visibility = $(if ($on) { 'Visible' } else { 'Collapsed' }) }
function Buttons($t1, $act1, $t2, $act2) {
  $script:a1 = $act1; $script:a2 = $act2
  $xB1.Content = [string]$t1; Show-El $xB1 ([bool]$t1); $xB1.IsEnabled = $true
  $xB2.Content = [string]$t2; Show-El $xB2 ([bool]$t2); $xB2.IsEnabled = $true
  Show-El $xBtnRow ([bool]$t1 -or [bool]$t2)
}
function Note($text, $tone) {
  $xNoteT.Text = [string]$text; Show-El $xNoteBox ([bool]$text)
  if ($tone -eq 'brand') { $xNoteBox.Background = $brandSoft; $xNoteBox.Padding = '14,10'; $xNoteT.Foreground = $brand }
  elseif ($tone -eq 'bad') { $xNoteBox.Background = $badSoft; $xNoteBox.Padding = '14,10'; $xNoteT.Foreground = $ink }
  else { $xNoteBox.Background = $clear; $xNoteBox.Padding = '0'; $xNoteT.Foreground = $ink }
}
function Bar($permille, $color) {
  $script:pct = [Math]::Max(0, [Math]::Min(1000, $permille)); $xFill.Background = $color; $xPctT.Foreground = $color
  $xPctT.Text = [string][int]($script:pct / 10) + '%'
  $w = $xTrack.ActualWidth; if ($w -le 0) { $w = 430 }
  $xFill.Width = $w * $script:pct / 1000
}
$xTrack.Add_SizeChanged({ $xFill.Width = $xTrack.ActualWidth * $script:pct / 1000 })
function Render($s) {
  if (-not $s) { return }
  $script:stateKey = [string]$s.state + '|' + [string]$s.need
  # 离开了点按钮时的那一步就忘掉「已点过」：同一种提示第二次出现（例如再次等不到新版窗口）时按钮要能再点（R48 审查 P1-1）。
  if ($script:decided -and $script:decided -ne $script:stateKey) { $script:decided = $null }
  $product = if ($s.product) { [string]$s.product } else { 'AI Hub' }
  $form.Title = $product + ' 升级'; $xAppName.Text = $product + ' 升级'
  $xSubT.Text = $(if ($s.from) { 'v' + $s.from + ' → v' + $s.version } else { 'v' + $s.version }) + $(if ($s.state -eq 'running') { ' · 完成后会自动打开新版，不用再点图标' } else { '' })
  $total = Secs $s.startedAt; $inStep = Secs $s.stepStartedAt
  $n = [int]$s.step; if ($n -lt 1) { $n = 1 }
  $xStepT.Text = '第 ' + $n + '/4 步 · ' + $s.label
  $xTitleT.Foreground = $ink
  $prog = [int](($n - 1) * 250 + [Math]::Min(230, $inStep * 12))
  $xTimeT.Text = '这一步已等 ' + $inStep + ' 秒' + $(if ($s.typical) { '（' + $s.typical + '）' } else { '' }) + ' · 总共 ' + $total + ' 秒'
  if ($s.state -eq 'running' -and $s.need -eq 'close-others') {
    $xTitleT.Text = '还有别的 ' + $product + ' 开着'; Bar $prog $brand
    Note ('它们占着程序文件，不关掉就换不了：' + (@($s.others) -join '、') + '。关闭时会先保存会话，正在生成的回答会中断，重新打开后会话可以接着用。') 'brand'
    Buttons '关闭它们并继续升级' 'close-others' '这次先不升级' 'cancel'
  } elseif ($s.state -eq 'failed' -and $s.need -eq 'retry') {
    $xTitleT.Text = '这次没换成，已恢复原来的版本'; $xTitleT.Foreground = $bad; Bar $prog $bad
    Note ([string]$s.reason + $(if (@($s.leftovers).Count) { '。还在运行：' + (@($s.leftovers) -join '、') } else { '' })) 'bad'
    Buttons '结束占用的程序并重试' 'retry' '先用原来的版本' 'give-up'
  } elseif ($s.state -eq 'failed' -and $s.need -eq 'launch') {
    $xTitleT.Text = '新版本已换好，窗口还没出来'; Bar 1000 $brand
    Note ([string]$s.reason) 'brand'
    Buttons '手动启动' 'launch' '关闭' 'close'
  } elseif ($s.state -eq 'failed') {
    $xTitleT.Text = $(if ($s.restoreFailed) { '升级出错，没能恢复原来的版本' } else { '这次没有升级' }); $xTitleT.Foreground = $bad; Bar 0 $bad
    Note ([string]$s.reason) 'bad'
    Buttons '' $null '知道了' 'close'
  } elseif ($s.state -eq 'done') {
    $xTitleT.Text = '升级完成，正在打开 v' + $s.version; $xTitleT.Foreground = $ok; Bar 1000 $ok
    Note '新版窗口已经打开，这个小窗马上自动关闭。' ''
    Buttons '' $null '' $null
  } elseif ($s.state -eq 'gave-up') {
    $xTitleT.Text = '正在打开原来的版本'; Bar 0 $brand; Note ([string]$s.reason) ''; Buttons '' $null '' $null
  } else {
    $xTitleT.Text = '正在升级到 v' + $s.version; Bar $prog $brand
    if ($script:focusNote) { Note $script:focusNote 'brand' } else { Note '升级期间请不要再点图标；如果点了，会回到这个小窗。' '' }
    Buttons '' $null '' $null
  }
  if ($script:decided -and $script:decided -eq $script:stateKey) { $xB1.IsEnabled = $false; $xB2.IsEnabled = $false; Note '收到，正在处理…' '' }
}
if ($Snapshot) {
  $s = Read-State
  if ($s.focusNote) { $script:focusNote = [string]$s.focusNote }
  # 不显示窗口：把卡片从窗口里摘下来，放到浅灰底上直接矢量渲染成 PNG（不抢焦点、不进任务栏）。
  $sc = $Scale; if ($sc -le 0) { $sc = 1 }
  $form.Content = $null
  $bg = New-Object Windows.Controls.Grid; $bg.Background = Brush '#F1F3F5'; $bg.Width = 512
  [Windows.Media.TextOptions]::SetTextFormattingMode($bg, 'Ideal'); $bg.UseLayoutRounding = $true
  $bg.Resources = $form.Resources; $bg.Children.Add($xShell) | Out-Null
  Render $s
  $bg.Measure([Windows.Size]::new(512, [double]::PositiveInfinity)); $bg.Arrange([Windows.Rect]::new(0, 0, 512, $bg.DesiredSize.Height)); $bg.UpdateLayout()
  Render $s; $bg.UpdateLayout()
  $w = [int][Math]::Ceiling(512 * $sc); $h = [int][Math]::Ceiling($bg.ActualHeight * $sc)
  $rtb = New-Object Windows.Media.Imaging.RenderTargetBitmap($w, $h, (96 * $sc), (96 * $sc), [Windows.Media.PixelFormats]::Pbgra32)
  $rtb.Render($bg)
  $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder; $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($rtb))
  $fs = [IO.File]::Create($Snapshot); try { $enc.Save($fs) } finally { $fs.Dispose() }
  exit 0
}
$timer = New-Object Windows.Threading.DispatcherTimer; $timer.Interval = [TimeSpan]::FromMilliseconds(400)
$timer.Add_Tick({
  $s = Read-State
  try { $f = [IO.File]::GetLastWriteTimeUtc($focusFile); if ((Test-Path -LiteralPath $focusFile) -and $f -ne $script:focusSeen) {
    $first = $null -eq $script:focusSeen; $script:focusSeen = $f
    if (-not $first -or ((Get-Date).ToUniversalTime() - $f).TotalSeconds -lt 5) {
      $script:focusNote = '你刚才又点了一次图标：升级还在进行，完成后会自动打开新版，不用再点。'
      if ($form.WindowState -eq 'Minimized') { $form.WindowState = 'Normal' }
      $form.Topmost = $true; [void]$form.Activate(); [Media.SystemSounds]::Asterisk.Play()
    } } } catch {}
  Render $s
  if (-not $s) { return }
  if ($s.state -in @('done', 'gave-up', 'cancelled')) { if (-not $script:doneAt) { $script:doneAt = Get-Date }; if (((Get-Date) - $script:doneAt).TotalSeconds -gt $(if ($s.state -eq 'done') { 3 } else { 2 })) { $form.Close() } }
  # 替换脚本没了（被结束、或已经结束）又没有要用户看的结果：不留一个永远转圈的小窗。
  $alive = $false; try { $alive = [bool](Get-Process -Id ([int]$s.helperPid) -ErrorAction Stop) } catch {}
  if (-not $alive -and $s.state -ne 'failed') { if (-not $script:goneAt) { $script:goneAt = Get-Date }; if (((Get-Date) - $script:goneAt).TotalSeconds -gt 3) { $form.Close() } }
})
# 计时器在显示前就启动，不依赖「内容已渲染」事件（不在前台渲染的桌面上该事件可能不来，小窗会停在第一帧）。
$form.Add_Loaded({ [void]$form.Activate() })
$timer.Start()
# 用户关掉小窗：要他选的就当「这次先不升级 / 先用原来的版本」，其余照常进行。
$form.Add_Closing({ $timer.Stop(); $s = Read-State; if ($s -and $s.need -and $s.state -in @('running', 'failed') -and $xB2.Visibility -eq 'Visible' -and $xB2.IsEnabled -and $script:a2 -ne 'close') { try { [IO.File]::WriteAllText($decisionFile, ('{"action":"' + $script:a2 + '"}')) } catch {} } })
Render (Read-State)
[void]$form.ShowDialog()
`;

module.exports = { PROGRESS_UI };
