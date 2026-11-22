# AI Hub lifecycle hook relay for machines without Python or Node.
#
# Claude Code / Codex run this for every configured hook event and write the
# event JSON to stdin. The script forwards the raw bytes to the local Hub
# (POST /api/hook-raw/<event>); the Hub extracts the same fields that
# session-hub-hook.py would send (core/hook-payload.js).
#
# Sessions not started by the Hub have no CLAUDE_HUB_SESSION_ID and exit
# immediately, so the user's own terminal sessions are unaffected.
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param([string]$HookEvent = 'stop')

# ask-gate: synchronous PreToolUse hook registered only for the question tools
# (core/auto-dispatch-rules.js). Sessions the Hub dispatches automatically carry
# AI_HUB_NO_CHOICE=1; for them the call is refused with exit code 2 and the reason
# (AI_HUB_NO_CHOICE_REASON, written to stderr as UTF-8) goes back to the model.
# Every other session, and any failure here, lets the call through (exit 0).
if ($HookEvent -eq 'ask-gate') {
  if ($env:AI_HUB_NO_CHOICE -ne '1') { exit 0 }
  $deny = $false
  try {
    $stdin = [Console]::OpenStandardInput()
    $buffer = New-Object System.IO.MemoryStream
    $stdin.CopyTo($buffer)
    $payload = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray()) | ConvertFrom-Json
    $tools = @(([string]$env:AI_HUB_NO_CHOICE_TOOLS).Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($tools.Count -eq 0) { $tools = @('AskUserQuestion') }
    $deny = $tools -contains [string]$payload.tool_name
  } catch { $deny = $false }
  if (-not $deny) { exit 0 }
  try {
    $reason = [string]$env:AI_HUB_NO_CHOICE_REASON
    if (-not $reason) { $reason = 'This session is dispatched automatically and nobody can answer questions: continue with the most reasonable assumptions and state them in the answer.' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($reason)
    $err = [Console]::OpenStandardError()
    $err.Write($bytes, 0, $bytes.Length)
    $err.Flush()
  } catch { }
  exit 2
}

# upload-guard: synchronous PreToolUse hook, registered only where the upload
# limits are active (core/net-guard.js, 2026-11-23), for tools that run commands
# or fetch URLs. A command that names the Hub's own servers (matched by SHA-256 of
# every host-name suffix / IP, the names themselves are not stored here)
# together with an upload or direct-transfer form (curl -d/-F/-T, -X POST,
# Invoke-WebRequest -Method Post/-Body/-InFile, WebClient.Upload*, requests.post,
# scp/sftp/rsync/ssh/git push/nc ...) is refused with exit code 2; so is a
# WebFetch URL to those hosts longer than 8 KB. Heuristic only: a host name built
# at run time is not recognised. Any failure here lets the call through (exit 0).
if ($HookEvent -eq 'upload-guard') {
  $deny = $null
  try {
    $stdin = [Console]::OpenStandardInput()
    $buffer = New-Object System.IO.MemoryStream
    $stdin.CopyTo($buffer)
    $payload = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray()) | ConvertFrom-Json
    $text = [string]($payload.tool_input | ConvertTo-Json -Depth 8 -Compress)
    $uploadRe = '(?i)(?:^|[\s"''(])(?:-d|--data[\w-]*|-F|--form[\w-]*|-T|--upload-file|--json)\b|-X\s*["'']?(?:POST|PUT|PATCH)|--request\s*["'']?(?:POST|PUT|PATCH)|-Method\s+["'']?(?:Post|Put|Patch)|-Body\b|-InFile\b|-Form\b|Upload(?:File|String|Data|Values)(?:Async)?\b|requests\.(?:post|put|patch)\b|\.(?:post|put|patch)\s*\(|method\s*[:=]\s*["'']?(?:POST|PUT|PATCH)|urlopen\([^)]*data|\b(?:scp|sftp|rsync|ssh|ftp|tftp|nc|ncat|socat|telnet)(?:\.exe)?\s|git\s+push|WebSocket|Send-MailMessage'
    $hashes = @('762de0365f2be955852ae501c0e11283e7d7110502c6a7cbee51851fea9f9a3f', '784f2c8674a504da116abbdc51de51d706d508fdec637f9803aea8c9218a9a53', '526b0f8c77d279fa01e5d23e4df2f3598c8768da889397ddc37d7a98be8b1e9a')
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $ours = $false
    foreach ($m in [regex]::Matches($text, '(?i)\b(?:\d{1,3}\.){3}\d{1,3}\b|\b\d{8,10}\b|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b')) {
      $labels = $m.Value.ToLowerInvariant().Split('.')
      $n = [Math]::Max(1, $labels.Length - 1)
      for ($i = 0; $i -lt $n -and -not $ours; $i++) {
        $s = ($labels[$i..($labels.Length - 1)] -join '.')
        $h = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s)) | ForEach-Object { $_.ToString('x2') })
        if ($hashes -contains $h) { $ours = $true }
      }
      if ($ours) { break }
    }
    if ($ours) {
      if ($text -match $uploadRe) { $deny = 'upload' }
      elseif ([string]$payload.tool_name -eq 'WebFetch' -and ([string]$payload.tool_input.url).Length -gt 8192) { $deny = 'url' }
    }
  } catch { $deny = $null }
  if (-not $deny) { exit 0 }
  try {
    $reason = 'Refused by AI Hub: this computer may not upload data to the Hub''s own servers with shell commands. Put the result in your answer instead; do not retry another way.'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($reason)
    $err = [Console]::OpenStandardError()
    $err.Write($bytes, 0, $bytes.Length)
    $err.Flush()
  } catch { }
  exit 2
}

$sessionId = $env:CLAUDE_HUB_SESSION_ID
if (-not $sessionId -or $HookEvent -eq 'tool-use') { exit 0 }

try {
  $port = $env:CLAUDE_HUB_PORT
  if (-not $port) { $port = '3456' }
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buffer)
  $bytes = $buffer.ToArray()

  $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/api/hook-raw/$HookEvent")
  $request.Method = 'POST'
  $request.Proxy = $null
  $request.Timeout = 3000
  $request.ReadWriteTimeout = 3000
  $request.ContentType = 'application/json; charset=utf-8'
  $request.Headers.Add('X-Hub-Session', [string]$sessionId)
  $request.Headers.Add('X-Hub-Token', [string]$env:CLAUDE_HUB_TOKEN)
  if ($env:CLAUDE_HUB_CODEX_ACCOUNT_ATTEMPT) {
    $request.Headers.Add('X-Hub-Codex-Account-Attempt', [string]$env:CLAUDE_HUB_CODEX_ACCOUNT_ATTEMPT)
  }
  $request.ContentLength = $bytes.Length
  $out = $request.GetRequestStream()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Close()
  $request.GetResponse().Close()
} catch {
  # The Hub not running is not an error for the CLI.
}
exit 0
