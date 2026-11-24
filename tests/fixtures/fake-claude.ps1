# Minimal stand-in for the Claude Code CLI used by tests/e2e-community-cdp.js.
#
# It behaves like the real CLI towards the Hub: it runs inside the Hub's PTY,
# reads prompts from its terminal, writes a transcript JSONL, and fires the
# hooks registered in ~/.claude/settings.json by executing the configured
# command strings (through Git Bash when present, as Claude Code does on
# Windows). It never talks to a model.
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'

# The Hub probes --version/--help (core/codeagent-capabilities.js) and drops launch flags the help does not list.
if ($Rest -contains '--version') { Write-Output '2.1.322 (Claude Code)'; exit 0 }
if ($Rest -contains '--help') {
  Write-Output @'
Usage: claude [options] [command] [prompt]
  --model <model>
  --effort <level>  (choices: "low", "medium", "high", "xhigh", "max")
  --permission-mode <mode>  (choices: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")
  --settings <file-or-json>
  --mcp-config <configs...>
  --strict-mcp-config
  --add-dir <directories...>
  --append-system-prompt-file <file>
  --session-id <uuid>
  -r, --resume [value]
  --fork-session
'@
  exit 0
}

$sid = $null
for ($i = 0; $i -lt $Rest.Count - 1; $i++) {
  if ($Rest[$i] -eq '--session-id' -or $Rest[$i] -eq '--resume') { $sid = $Rest[$i + 1] }
}
if (-not $sid) { $sid = [guid]::NewGuid().ToString() }

$userHome = $env:USERPROFILE
$settingsPath = Join-Path $userHome '.claude\settings.json'
$cwd = (Get-Location).Path
$slug = $cwd -replace '[^A-Za-z0-9]', '-'
$projectDir = Join-Path $userHome ".claude\projects\$slug"
New-Item -ItemType Directory -Force $projectDir | Out-Null
$transcript = Join-Path $projectDir "$sid.jsonl"
$trace = Join-Path $userHome 'fake-claude-trace.log'
$bash = @("$env:ProgramFiles\Git\bin\bash.exe", "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Trace([string]$text) { [IO.File]::AppendAllText($trace, $text + "`n", $utf8) }

function Invoke-Hook([string]$eventName, $payload) {
  $settings = [IO.File]::ReadAllText($settingsPath, $utf8) | ConvertFrom-Json
  $groups = $settings.hooks.$eventName
  if (-not $groups) { Write-Trace "no hook for $eventName"; return }
  $json = $payload | ConvertTo-Json -Compress -Depth 10
  foreach ($group in @($groups)) {
    foreach ($hook in @($group.hooks)) {
      $script = Join-Path $env:TEMP ("fake-claude-hook-" + [guid]::NewGuid().ToString() + ($(if ($bash) { '.sh' } else { '.cmd' })))
      [IO.File]::WriteAllText($script, $hook.command, $utf8)
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      if ($bash) { $psi.FileName = $bash; $psi.Arguments = '"' + $script + '"' }
      else { $psi.FileName = 'cmd.exe'; $psi.Arguments = '/d /c "' + $script + '"' }
      $psi.UseShellExecute = $false
      $psi.RedirectStandardInput = $true
      $psi.CreateNoWindow = $true
      $process = [System.Diagnostics.Process]::Start($psi)
      $bytes = $utf8.GetBytes($json)
      $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
      $process.StandardInput.Close()
      # Same 60 s budget as the real CLI's hook timeout; on a busy machine the hook's interpreter can take >15 s to start.
      # Reading ExitCode of a still-running process throws, which used to kill this fake silently.
      if ($process.WaitForExit(60000)) { $code = $process.ExitCode } else { $code = 'timeout'; try { $process.Kill() } catch {} }
      Write-Trace "$eventName exit=$code via=$(if ($bash) { 'bash' } else { 'cmd' })"
      Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue
    }
  }
}

function Add-Entry($entry) { [IO.File]::AppendAllText($transcript, ($entry | ConvertTo-Json -Compress -Depth 10) + "`n", $utf8) }

# The real CLI reads its terminal as UTF-8; Windows PowerShell 5.1 defaults to the OEM code page.
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$permissionMode = 'unset'
for ($i = 0; $i -lt $Rest.Count - 1; $i++) { if ($Rest[$i] -eq '--permission-mode') { $permissionMode = $Rest[$i + 1] } }
Write-Trace "permission-mode: $permissionMode"
Invoke-Hook 'SessionStart' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'SessionStart'; source = 'startup' }
# Same footer text the real CLI shows once its prompt is ready.
Write-Host 'Fake Claude ready  ? for shortcuts'

while ($true) {
  Write-Host -NoNewline '> '
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $prompt = ($line -replace ([string][char]27 + '\[20[01]~'), '' -replace '\[20[01]~', '').Trim()
  if (-not $prompt) { continue }
  if ($prompt -eq '/exit') { break }
  Write-Trace "prompt: $prompt"
  $now = (Get-Date).ToUniversalTime().ToString('o')
  $userId = [guid]::NewGuid().ToString()
  Add-Entry @{ type = 'user'; uuid = $userId; sessionId = $sid; timestamp = $now; cwd = $cwd; message = @{ role = 'user'; content = $prompt } }
  Invoke-Hook 'UserPromptSubmit' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'UserPromptSubmit'; prompt = $prompt }
  # Like the real CLI: outside bypassPermissions a Bash call stops on a permission dialog until the user answers.
  $toolUseId = 'toolu_' + [guid]::NewGuid().ToString('N')
  if ($prompt -like 'run-tool*' -and $permissionMode -ne 'bypassPermissions') {
    Invoke-Hook 'PreToolUse' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'PreToolUse'; tool_name = 'Bash'; tool_use_id = $toolUseId; tool_input = @{ command = 'echo fake' } }
    Invoke-Hook 'PermissionRequest' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'PermissionRequest'; tool_name = 'Bash'; tool_input = @{ command = 'echo fake' } }
    Invoke-Hook 'Notification' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'Notification'; notification_type = 'permission_prompt'; message = 'Claude needs your permission to use Bash' }
    Write-Host 'Bash command: echo fake'
    Write-Host 'Do you want to proceed?'
    Write-Host '> 1. Yes'
    Write-Host '  2. No, and tell Claude what to do differently (esc)'
    $answer = [Console]::In.ReadLine()
    Write-Trace "permission answer: $answer"
    # The real TUI redraws once the dialog is answered; leaving the menu on screen would read as still waiting.
    Write-Host -NoNewline ([string][char]27 + '[2J' + [string][char]27 + '[H')
    Invoke-Hook 'PostToolUse' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'PostToolUse'; tool_name = 'Bash'; tool_use_id = $toolUseId; tool_input = @{ command = 'echo fake' }; tool_response = @{ stdout = 'fake'; stderr = ''; interrupted = $false } }
  }
  # 'slow-tool <sec>': a Bash call that keeps running for <sec> seconds (tests/e2e-reload-restore-running-cdp.js).
  if ($prompt -match '^slow-tool\s+(\d+)') {
    $seconds = [int]$Matches[1]
    Invoke-Hook 'PreToolUse' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'PreToolUse'; tool_name = 'Bash'; tool_use_id = $toolUseId; tool_input = @{ command = "sleep $seconds" } }
    Write-Host "Running Bash: sleep $seconds"
    Start-Sleep -Seconds $seconds
    Invoke-Hook 'PostToolUse' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'PostToolUse'; tool_name = 'Bash'; tool_use_id = $toolUseId; tool_input = @{ command = "sleep $seconds" }; tool_response = @{ stdout = ''; stderr = ''; interrupted = $false } }
  }
  # 'queue-test <sec> <keep|drop|exit>': a busy turn with the real CLI's active status line, so a message sent meanwhile
  # is queued by the terminal (tests/e2e-busy-queued-send-cdp.js). keep = run it afterwards, drop = discard the queued
  # input (what an Esc interrupt or a lost queue looks like to the Hub), exit = the CLI quits before running it.
  if ($prompt -match '^queue-test\s+(\d+)\s+(keep|drop|exit)') {
    $seconds = [int]$Matches[1]; $how = $Matches[2]
    Write-Host '* Working... (esc to interrupt)'
    Start-Sleep -Seconds $seconds
    if ($how -eq 'exit') { Write-Trace 'queue-test exit'; exit 0 }
    if ($how -eq 'drop') {
      try { $Host.UI.RawUI.FlushInputBuffer() } catch { }
      while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }
      Write-Trace 'queue-test dropped queued input'
    }
  }
  Start-Sleep -Milliseconds 300
  $reply = "FAKE-REPLY: $prompt"
  Write-Host $reply
  Add-Entry @{ type = 'assistant'; uuid = [guid]::NewGuid().ToString(); parentUuid = $userId; sessionId = $sid; timestamp = (Get-Date).ToUniversalTime().ToString('o'); cwd = $cwd
    message = @{ id = 'msg_' + [guid]::NewGuid().ToString('N'); type = 'message'; role = 'assistant'; model = 'fake-model'; stop_reason = 'end_turn'
      content = @(@{ type = 'text'; text = $reply }); usage = @{ input_tokens = 1; output_tokens = 1 } } }
  Invoke-Hook 'Stop' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'Stop'; last_assistant_message = $reply }
}
Invoke-Hook 'SessionEnd' @{ session_id = $sid; transcript_path = $transcript; cwd = $cwd; hook_event_name = 'SessionEnd'; reason = 'prompt_input_exit' }
