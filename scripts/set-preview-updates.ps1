param([string]$DataDir, [switch]$Disable)
$ErrorActionPreference = 'Stop'
if (-not $DataDir) {
  if ($env:CLAUDE_HUB_DATA_DIR) { $DataDir = $env:CLAUDE_HUB_DATA_DIR }
  else { $DataDir = Join-Path $env:USERPROFILE '.ai-hub-community' }
}
$DataDir = [IO.Path]::GetFullPath($DataDir)
if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) { throw 'Hub data directory does not exist. Check the running instance before changing it.' }
$file = Join-Path $DataDir 'preview-updates.json'
$state = if (Test-Path -LiteralPath $file) { Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json } else { [PSCustomObject]@{} }
$state | Add-Member -MemberType NoteProperty -Name enabled -Value (-not $Disable.IsPresent) -Force
$tmp = "$file.$PID.tmp"
[IO.File]::WriteAllText($tmp, ($state | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $tmp -Destination $file -Force
Write-Output 'Preview preference saved. Updates use the next six-hour check or a manual check; no restart is requested.'
