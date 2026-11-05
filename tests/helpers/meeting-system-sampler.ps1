# System-only diagnostics for the isolated meeting CI. The parent owns the
# hidden process and must bound shutdown if a performance-counter query hangs.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$StopPath,
    [ValidateRange(100, 60000)][int]$IntervalMs = 2000,
    [switch]$Once
)
$ErrorActionPreference = 'Stop'
$outputFile = [IO.Path]::GetFullPath($OutputPath)
$stopFile = [IO.Path]::GetFullPath($StopPath)
if ($outputFile -eq $stopFile) { throw 'OutputPath and StopPath must differ' }
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputFile)) | Out-Null
$writer = [IO.StreamWriter]::new($outputFile, $true, [Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
$clock = [Diagnostics.Stopwatch]::StartNew()
$counters = [ordered]@{
    diskQueueLength = '\PhysicalDisk(_Total)\Avg. Disk Queue Length'
    availableMBytes = '\Memory\Available MBytes'
    pagesPerSec = '\Memory\Pages/sec'
}
try {
    while (-not [IO.File]::Exists($stopFile)) {
        $sampleStart = $clock.Elapsed.TotalMilliseconds
        $dateNow = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $queryClock = [Diagnostics.Stopwatch]::StartNew()
        $queryErrors = @()
        $samples = @()
        try {
            $sets = @(Get-Counter -Counter @($counters.Values) -MaxSamples 1 -ErrorAction SilentlyContinue -ErrorVariable queryErrors)
            $samples = @($sets | ForEach-Object { $_.CounterSamples })
        } catch {
            $queryErrors += $_
        }
        $queryClock.Stop()
        $metrics = [ordered]@{}
        $errors = @()
        foreach ($queryError in $queryErrors) {
            $message = [string]$queryError
            $errors += [ordered]@{ counter = 'query'; error = $message.Substring(0, [Math]::Min(512, $message.Length)); code = 'query-error' }
        }
        foreach ($name in $counters.Keys) {
            $counterPath = $counters[$name]
            $metrics[$name] = $null
            $matched = @($samples | Where-Object { $_ -and ([string]$_.Path).EndsWith($counterPath, [StringComparison]::OrdinalIgnoreCase) })
            if ($matched.Count -ne 1) {
                $errors += [ordered]@{ counter = $counterPath; error = 'Expected exactly one counter sample'; code = 'missing-or-duplicate' }
                continue
            }
            $sample = $matched[0]
            # PDH_CSTATUS_VALID_DATA (0) and PDH_CSTATUS_NEW_DATA (1)
            # both carry usable data. Do not coerce absent/text status to zero.
            if ($null -eq $sample.Status -or $sample.Status -is [string] -or @(0, 1) -notcontains $sample.Status) {
                $errors += [ordered]@{ counter = $counterPath; error = 'Counter sample status is not valid'; code = [string]$sample.Status }
                continue
            }
            $value = $sample.CookedValue
            if ($null -eq $value -or [double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value)) {
                $errors += [ordered]@{ counter = $counterPath; error = 'Counter value is not finite'; code = 'invalid-value' }
                continue
            }
            $metrics[$name] = [double]$value
        }
        $validCount = @($metrics.Values | Where-Object { $null -ne $_ }).Count
        $status = if ($validCount -eq 3 -and $errors.Count -eq 0) { 'ok' } elseif ($validCount -gt 0) { 'partial' } else { 'error' }
        $writer.WriteLine((ConvertTo-Json -Compress -Depth 6 -InputObject ([ordered]@{
            kind = 'meeting-system-resources'; dateNow = $dateNow; monotonicMs = $sampleStart
            queryElapsedMs = $queryClock.Elapsed.TotalMilliseconds; status = $status
            metrics = $metrics; errors = @($errors)
        })))
        if ($Once) { break }
        # Poll the stop file while waiting; never overlap counter queries or
        # launch a separate process to query system state.
        while (-not [IO.File]::Exists($stopFile) -and ($clock.Elapsed.TotalMilliseconds - $sampleStart) -lt $IntervalMs) {
            Start-Sleep -Milliseconds 100
        }
    }
} finally {
    $writer.Dispose()
    $clock.Stop()
}
