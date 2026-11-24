# Hub Win32 Job Object + EcoQoS broker. Started hidden by core/win32-job-qos.js; reads JSON lines on stdin, writes JSON lines on stdout.
$ErrorActionPreference = 'Stop'
try {
    $cs = Join-Path $PSScriptRoot 'win32-job-qos.cs'
    $loaded = $false
    try {
        # Cache the compiled assembly per-user by source + CLR version + bitness so idle restarts skip csc.exe
        # and avoid repeated AV/Defender scans on newly generated random temp DLLs.
        $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [IO.Path]::GetTempPath() }
        $cacheDir = Join-Path $base 'ai-hub-win32-job-qos'
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $bytes = [IO.File]::ReadAllBytes($cs)
            $meta = [Text.Encoding]::UTF8.GetBytes('|' + [Environment]::Version.ToString() + '|' + [IntPtr]::Size)
            $buf = New-Object byte[] ($bytes.Length + $meta.Length)
            [Buffer]::BlockCopy($bytes, 0, $buf, 0, $bytes.Length)
            [Buffer]::BlockCopy($meta, 0, $buf, $bytes.Length, $meta.Length)
            $hash = ([BitConverter]::ToString($sha.ComputeHash($buf)) -replace '-', '').Substring(0, 16).ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
        $dllName = 'win32-job-qos-' + $hash + '.dll'
        $dll = Join-Path $cacheDir $dllName
        if (Test-Path -LiteralPath $dll) {
            try {
                [void][Reflection.Assembly]::LoadFrom($dll)
                if (('HubWin32JobQos' -as [type]) -ne $null) { $loaded = $true }
            } catch {}
            if (-not $loaded) {
                try { Remove-Item -LiteralPath $dll -Force -ErrorAction SilentlyContinue } catch {}
            }
        }
        if (-not $loaded) {
            if (-not (Test-Path -LiteralPath $cacheDir)) {
                [void](New-Item -ItemType Directory -Force -Path $cacheDir)
            }
            $tmp = Join-Path $cacheDir ('win32-job-qos-' + $hash + '.' + $PID + '.tmp.dll')
            try {
                Add-Type -Path $cs -OutputAssembly $tmp
                try {
                    [IO.File]::Move($tmp, $dll)
                } catch {
                    if (Test-Path -LiteralPath $tmp) {
                        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
                    }
                }
                if (Test-Path -LiteralPath $dll) {
                    [void][Reflection.Assembly]::LoadFrom($dll)
                    if (('HubWin32JobQos' -as [type]) -ne $null) { $loaded = $true }
                }
            } finally {
                if (Test-Path -LiteralPath $tmp) {
                    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
                }
            }
        }
        # Keep cache bounded on every startup (hit or miss): sweep older hashes and stale (>5m) temp files;
        # keep the active DLL and recent temp files, skipping any locked files quietly.
        if (Test-Path -LiteralPath $cacheDir) {
            try {
                $cutoff = [DateTime]::UtcNow.AddMinutes(-5)
                Get-ChildItem -LiteralPath $cacheDir -Filter 'win32-job-qos-*.dll' -ErrorAction SilentlyContinue | ForEach-Object {
                    if ($_.Name -ne $dllName -and ($_.Name -notlike '*.tmp.dll' -or $_.LastWriteTimeUtc -lt $cutoff)) {
                        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
                    }
                }
            } catch {}
        }
    } catch {
        # Any cache error (AppLocker, unwritable dir, AV lock) falls back transparently to in-memory compilation.
    }
    if (-not $loaded) {
        Add-Type -Path $cs
    }
    [HubWin32JobQos]::RunLoop()
} catch {
    [Console]::Out.WriteLine(('{"ready":false,"error":"' + ($_.Exception.Message -replace '[\\"]', ' ' -replace '[\r\n]+', ' ') + '"}'))
    exit 1
}
