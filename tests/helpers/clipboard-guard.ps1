# 测试需要真实系统剪贴板时，先把用户剪贴板逐格式备份到磁盘，测完原样恢复。
#
#   powershell -STA -NoProfile -File clipboard-guard.ps1 backup  <dir>
#   powershell -STA -NoProfile -File clipboard-guard.ps1 settext <dir> -TextFile <utf8 file>
#   powershell -STA -NoProfile -File clipboard-guard.ps1 restore <dir> [-TextFile <file1>[;<file2>...]]
#   powershell -STA -NoProfile -File clipboard-guard.ps1 verify  <dir>
#
# backup 把每个格式的原始字节写进 <dir>（最坏情况下用户也能从磁盘找回内容），并记下格式清单。
# settext 把文件里的文字写进剪贴板（模拟从别的程序复制）。
# restore 只在剪贴板仍是测试写入的那份文字（-TextFile）时才恢复：测试期间用户若又复制了别的，
# 那份新内容比备份更新，不能覆盖。verify 核对格式清单与每个格式的字节是否与备份一致。
# 任何格式读不出字节（无法原样恢复）时 backup 以退出码 3 失败，调用方必须放弃使用系统剪贴板。
param(
  [Parameter(Mandatory = $true)][ValidateSet('backup', 'settext', 'restore', 'verify')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$TextFile = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-FormatBytes($data, [string]$format) {
  $value = $data.GetData($format, $false)
  if ($null -eq $value) { return $null }
  if ($value -is [System.IO.MemoryStream]) { return $value.ToArray() }
  if ($value -is [System.IO.Stream]) { $ms = New-Object System.IO.MemoryStream; $value.CopyTo($ms); return $ms.ToArray() }
  if ($value -is [string]) { return [System.Text.Encoding]::Unicode.GetBytes($value) }
  if ($value -is [string[]]) { return [System.Text.Encoding]::Unicode.GetBytes(($value -join "`0")) }
  if ($value -is [System.Drawing.Image]) { $ms = New-Object System.IO.MemoryStream; $value.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); return $ms.ToArray() }
  return $null
}

function Get-FormatKind($data, [string]$format) {
  $value = $data.GetData($format, $false)
  if ($value -is [string]) { return 'string' }
  if ($value -is [string[]]) { return 'strings' }
  if ($value -is [System.Drawing.Image]) { return 'image' }
  return 'stream'
}

function Safe-Name([string]$format) { return ($format -replace '[^A-Za-z0-9._-]', '_') }

$manifestPath = Join-Path $Dir 'manifest.json'

if ($Action -eq 'backup') {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $data = [System.Windows.Forms.Clipboard]::GetDataObject()
  $entries = @()
  if ($data) {
    $i = 0
    foreach ($format in $data.GetFormats($false)) {
      $bytes = Get-FormatBytes $data $format
      if ($null -eq $bytes) { Write-Output "UNRESTORABLE $format"; exit 3 }
      $file = ('{0:D2}-{1}.bin' -f $i, (Safe-Name $format))
      [System.IO.File]::WriteAllBytes((Join-Path $Dir $file), $bytes)
      $entries += [ordered]@{ format = $format; kind = (Get-FormatKind $data $format); file = $file; length = $bytes.Length }
      $i++
    }
  }
  $manifest = [ordered]@{ empty = ($entries.Count -eq 0); entries = $entries }
  ($manifest | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  Write-Output ("BACKED-UP {0} formats" -f $entries.Count)
  exit 0
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

if ($Action -eq 'settext') {
  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
  [System.Windows.Forms.Clipboard]::SetText($text)
  Write-Output ("SET {0} chars" -f $text.Length)
  exit 0
}

if ($Action -eq 'restore') {
  if ($TextFile) {
    # 可给多份候选（分号分隔）：测试可能写进剪贴板的每一份文字都算「仍是测试写的」。
    $current = [System.Windows.Forms.Clipboard]::GetText()
    $ours = $false
    foreach ($candidate in ($TextFile -split ';' | Where-Object { $_ })) {
      if ($current -eq [System.IO.File]::ReadAllText($candidate, [System.Text.Encoding]::UTF8)) { $ours = $true }
    }
    if (-not $ours) { Write-Output 'SKIPPED clipboard changed by someone else; not overwriting'; exit 0 }
  }
  if ($manifest.empty) { [System.Windows.Forms.Clipboard]::Clear(); Write-Output 'RESTORED empty'; exit 0 }
  $obj = New-Object System.Windows.Forms.DataObject
  foreach ($entry in $manifest.entries) {
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $Dir $entry.file))
    switch ($entry.kind) {
      'string' { $obj.SetData($entry.format, $false, [System.Text.Encoding]::Unicode.GetString($bytes)) }
      'strings' { $obj.SetData($entry.format, $false, [string[]]([System.Text.Encoding]::Unicode.GetString($bytes) -split "`0")) }
      'image' { $obj.SetData($entry.format, $false, [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(, $bytes)))) }
      default { $obj.SetData($entry.format, $false, (New-Object System.IO.MemoryStream(, $bytes))) }
    }
  }
  [System.Windows.Forms.Clipboard]::SetDataObject($obj, $true, 10, 100)
  Write-Output ("RESTORED {0} formats" -f @($manifest.entries).Count)
  exit 0
}

if ($Action -eq 'verify') {
  $data = [System.Windows.Forms.Clipboard]::GetDataObject()
  $formats = if ($data) { @($data.GetFormats($false)) } else { @() }
  $expected = @($manifest.entries | ForEach-Object { $_.format })
  $problems = @()
  foreach ($entry in $manifest.entries) {
    if ($formats -notcontains $entry.format) { $problems += "missing $($entry.format)"; continue }
    if ($entry.kind -eq 'image') { continue }  # GDI 重新编码的 PNG 字节不必逐字相同，靠同源 stream 格式校验
    $now = Get-FormatBytes $data $entry.format
    $saved = [System.IO.File]::ReadAllBytes((Join-Path $Dir $entry.file))
    if ($null -eq $now -or [Convert]::ToBase64String($now) -ne [Convert]::ToBase64String($saved)) { $problems += "bytes differ $($entry.format)" }
  }
  foreach ($format in $formats) { if ($expected -notcontains $format) { $problems += "extra $format" } }
  if ($problems.Count) { Write-Output ('MISMATCH ' + ($problems -join '; ')); exit 4 }
  Write-Output ("VERIFIED {0} formats identical" -f $expected.Count)
  exit 0
}
