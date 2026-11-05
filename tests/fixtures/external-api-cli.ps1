# API launch probe: no provider connection and no credential body in evidence.
param([string]$Kind, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'
$model = ''
for ($i = 0; $i -lt $Rest.Count - 1; $i++) {
  if ($Rest[$i] -eq '--model' -or $Rest[$i] -eq '-m') { $model = $Rest[$i + 1] }
}
$record = [ordered]@{
  provider = $Kind
  model = $model
  envModel = $env:ANTHROPIC_MODEL
  baseURL = $env:ANTHROPIC_BASE_URL
  tokenMatches = $env:ANTHROPIC_AUTH_TOKEN -eq 'fixture-api-key'
  inheritedApiKey = [bool]$env:ANTHROPIC_API_KEY
  inheritedOAuth = [bool]$env:CLAUDE_CODE_OAUTH_TOKEN
  codexHome = $env:CODEX_HOME
}
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::AppendAllText((Join-Path $env:HUB_EXTERNAL_API_FIXTURE_OUT ($Kind + '.jsonl')), (($record | ConvertTo-Json -Compress) + "`n"), $utf8)
Write-Host 'API fixture ready. No model request is made.'
while ($null -ne [Console]::In.ReadLine()) { }
