# Minimal stand-in for the Codex CLI used by tests/e2e-permission-mode-cdp.js.
# It only records the launch arguments the Hub passes (to check the permission mode reaches the CLI)
# and then waits on its terminal like an interactive TUI. It never talks to a model.
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
if ($Rest -contains '--version') { Write-Output 'codex-cli 0.164.0'; exit 0 }
if ($Rest -contains '--help') { Write-Output 'Usage: codex [OPTIONS] [PROMPT]'; exit 0 }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$trace = Join-Path $env:USERPROFILE 'fake-codex-trace.log'
[IO.File]::AppendAllText($trace, 'codex-args: ' + ($Rest -join ' ') + "`n", $utf8)
Write-Host 'Fake Codex ready  ? for shortcuts'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '/exit') { break }
}
