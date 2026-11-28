# AI Hub workspace guard: synchronous PreToolUse hook for Claude Code / CodeAgent.
# Registered only through the per-session --settings overlay that the Hub writes
# when the user ticks "only let the AI change files inside the work folder"
# (core/workspace-guard.js). It never touches the user's own settings.json.
#
# Argument 1: base64 (UTF-8) JSON array of allowed root folders.
# Reads the hook payload from stdin; for file-editing tools whose target path is
# outside every allowed root it writes the reason to stderr and exits 2, which
# Claude Code treats as "block this tool call" even in bypassPermissions mode.
# Shell commands are not inspected: Windows has no sandbox for them.
# Any internal failure lets the call through (exit 0), so a broken guard never
# freezes a session. A payload without a path (TodoWrite also matches "Write")
# is let through too.
#
# Argument 2 "member" (team members, main/team/member-guard.js): after the local
# work-folder check passes, the raw hook payload is also sent to the Hub
# (/api/member-guard, session id and token from the session environment), which
# refuses five kinds of dangerous actions. The Hub not answering, a timeout or any
# error here lets the call through. Both checks share this one entry point, so a
# session with both on starts only one PowerShell per tool call.
param([string]$RootsB64 = '', [string]$Mode = '')

# \\?\D:\x and \\.\D:\x -> D:\x ; \\?\UNC\srv\share -> \\srv\share
function Remove-DevicePrefix([string]$p) {
  if ($p -match '^\\\\[?.]\\UNC\\(.*)$') { return '\\' + $Matches[1] }
  if ($p -match '^\\\\[?.]\\([a-zA-Z]:.*)$') { return $Matches[1] }
  return $p
}

function Test-Absolute([string]$p) { return ($p -match '^([a-zA-Z]:[\\/]|\\\\)') }

# Follow junctions / symbolic links on the existing part of the path, so a link inside
# the work folder that points elsewhere is judged by where the write really lands.
# The Hub also adds each allowed folder's real path (core/workspace-guard.js), so
# opening the work folder through a link is not refused. Missing tail parts stay as written.
function Resolve-Real([string]$p) {
  $hops = 0
  $restart = $true
  while ($restart -and $hops -lt 32) {
    $restart = $false
    $root = [System.IO.Path]::GetPathRoot($p)
    if (-not $root) { return $p }
    $parts = $p.Substring($root.Length).Split([char[]]@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)
    $cur = $root.TrimEnd('\')
    for ($i = 0; $i -lt $parts.Length; $i++) {
      $next = $cur + '\' + $parts[$i]
      $item = Get-Item -LiteralPath $next -Force -ErrorAction SilentlyContinue
      if (-not $item) { return $p }
      $link = $null
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        $link = @($item.Target) | Where-Object { $_ } | Select-Object -First 1
      }
      if ($link) {
        $link = Remove-DevicePrefix ([string]$link)
        if (-not (Test-Absolute $link)) { $link = [System.IO.Path]::Combine($cur, $link) }
        $rest = @($parts | Select-Object -Skip ($i + 1)) -join '\'
        if ($rest) { $link = $link.TrimEnd('\') + '\' + $rest }
        $p = [System.IO.Path]::GetFullPath($link).TrimEnd('\', '/')
        $hops++
        $restart = $true
        break
      }
      $cur = $next
    }
  }
  return $p
}

$blocked = $null
try {
  $roots = @()
  if ($RootsB64) {
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RootsB64))
    # Windows PowerShell 5.1 emits a JSON array as one object; foreach unrolls it.
    foreach ($item in ($json | ConvertFrom-Json)) { if ($item) { $roots += [string]$item } }
  }
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buffer)
  $rawBytes = $buffer.ToArray()
  $payload = [System.Text.Encoding]::UTF8.GetString($rawBytes) | ConvertFrom-Json
  $input0 = $payload.tool_input
  $target = [string]$input0.file_path
  if (-not $target) { $target = [string]$input0.notebook_path }
  if (-not $target) { $target = [string]$input0.filePath }
  if (-not $target) { $target = [string]$input0.notebookPath }
  if (-not $target) { $target = [string]$input0.target_file }
  if (-not $target) { $target = [string]$input0.path }
  if ($target -and $roots.Count -gt 0) {
    $base = [string]$payload.cwd
    if (-not $base) { $base = (Get-Location).Path }
    # Git Bash style /d/foo -> D:\foo
    if ($target -match '^/([a-zA-Z])/(.*)$') { $target = $Matches[1] + ':\' + $Matches[2] }
    $target = Remove-DevicePrefix $target
    if ($target -match '^[a-zA-Z]:(?![\\/])') {
      # Drive-relative "D:foo" is "rooted" for .NET but would resolve against this
      # process's folder; resolve it against the session folder on the same drive.
      if ($base.Length -ge 2 -and $base.Substring(0, 2) -ieq $target.Substring(0, 2)) {
        $target = [System.IO.Path]::Combine($base, $target.Substring(2))
      } else { $target = $target.Substring(0, 2) + '\' + $target.Substring(2) }
    } elseif (-not (Test-Absolute $target)) { $target = [System.IO.Path]::Combine($base, $target) }
    $full = Resolve-Real ([System.IO.Path]::GetFullPath($target).TrimEnd('\', '/'))
    $inside = $false
    foreach ($root in $roots) {
      if (-not $root) { continue }
      $r = [System.IO.Path]::GetFullPath((Remove-DevicePrefix ([string]$root))).TrimEnd('\', '/')
      if ($full.Equals($r, [System.StringComparison]::OrdinalIgnoreCase) -or
          $full.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)) { $inside = $true; break }
    }
    if (-not $inside) { $blocked = $full }
  }
} catch { $blocked = $null }

if (-not $blocked -and $Mode -eq 'member' -and $rawBytes) {
  $deny = $null
  try {
    $port = $env:CLAUDE_HUB_PORT
    $sid = $env:CLAUDE_HUB_SESSION_ID
    if ($port -and $sid) {
      $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/api/member-guard")
      $request.Method = 'POST'
      $request.Proxy = $null
      $request.Timeout = 15000
      $request.ReadWriteTimeout = 15000
      $request.ContentType = 'application/json; charset=utf-8'
      $request.Headers.Add('X-Hub-Session', [string]$sid)
      $request.Headers.Add('X-Hub-Token', [string]$env:CLAUDE_HUB_TOKEN)
      $request.ContentLength = $rawBytes.Length
      $out = $request.GetRequestStream()
      $out.Write($rawBytes, 0, $rawBytes.Length)
      $out.Close()
      $response = $request.GetResponse()
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
      $verdict = $reader.ReadToEnd() | ConvertFrom-Json
      $reader.Close(); $response.Close()
      if ([string]$verdict.decision -eq 'deny') {
        $deny = [string]$verdict.reason
        if (-not $deny) { $deny = 'Refused by AI Hub (team member guard); the team lead has been told.' }
      }
    }
  } catch { $deny = $null }
  if (-not $deny) { exit 0 }
  try {
    $err = [Console]::OpenStandardError()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($deny)
    $err.Write($bytes, 0, $bytes.Length)
    $err.Flush()
  } catch { }
  exit 2
}
if (-not $blocked) { exit 0 }
try {
  $first = [string]$roots[0]
  $msg = "Refused by AI Hub: this session may only change files inside its work folder ($first). '$blocked' is outside it. Do not try another way (shell commands, scripts or copies) to change files outside the work folder; tell the user which file you wanted to change and why."
  $err = [Console]::OpenStandardError()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
  $err.Write($bytes, 0, $bytes.Length)
  $err.Flush()
} catch { }
exit 2
