# Hub Win32 Job Object + EcoQoS broker. Started hidden by core/win32-job-qos.js; reads JSON lines on stdin, writes JSON lines on stdout.
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'win32-job-qos.cs')
    [HubWin32JobQos]::RunLoop()
} catch {
    [Console]::Out.WriteLine(('{"ready":false,"error":"' + ($_.Exception.Message -replace '[\\"]', ' ' -replace '[\r\n]+', ' ') + '"}'))
    exit 1
}
