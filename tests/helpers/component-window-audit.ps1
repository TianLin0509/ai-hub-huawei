param(
  [Parameter(Mandatory = $true)][int]$RootProcessId,
  [string]$AdditionalDesktop
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# MainWindowHandle can refer to a window on an isolated test desktop. Inspect
# Default and the input desktop explicitly, including every visible top-level
# window owned by this process tree. AdditionalDesktop is for the real guard
# regression: a visible fixture stays off the user's desktop throughout.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class ReskinWindowAudit {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder value, int length, out int needed);
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumDesktopWindows(IntPtr desktop, EnumProc callback, IntPtr lparam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int length);
  public class Window {
    public int pid; public long hwnd; public string desktop; public string title; public string windowClass;
  }
  public static string Name(IntPtr desktop) {
    var text = new StringBuilder(256); int needed;
    if (!GetUserObjectInformation(desktop, 2, text, text.Capacity * 2, out needed)) throw new Win32Exception();
    return text.ToString();
  }
  public static Window[] Scan(IntPtr desktop, int[] pids) {
    var wanted = new HashSet<int>(pids); var found = new List<Window>(); string name = Name(desktop);
    EnumProc callback = (hwnd, unused) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (!wanted.Contains((int)pid) || !IsWindowVisible(hwnd)) return true;
      var title = new StringBuilder(1024); var cls = new StringBuilder(256);
      GetWindowText(hwnd, title, title.Capacity); GetClassName(hwnd, cls, cls.Capacity);
      uint verified; GetWindowThreadProcessId(hwnd, out verified);
      if (verified == pid) found.Add(new Window {pid=(int)pid, hwnd=hwnd.ToInt64(), desktop=name, title=title.ToString(), windowClass=cls.ToString()});
      return true;
    };
    if (!EnumDesktopWindows(desktop, callback, IntPtr.Zero)) {
      int error = Marshal.GetLastWin32Error();
      if (error != 0) throw new Win32Exception(error);
    }
    GC.KeepAlive(callback);
    return found.ToArray();
  }
}
'@

function Get-AuditProcessStartTicks([int]$ProcessId) {
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (!$process) { return $null }
  $readError = $null
  try {
    $startTime = $process.StartTime
    if ($null -ne $startTime) { return $startTime.ToUniversalTime().Ticks }
  } catch { $readError = $_ }
  # A Process object can outlive its OS process. Recheck the PID before
  # treating an absent StartTime as an exit; unreadable live identities fail.
  if (!(Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $null }
  if ($readError) { throw $readError }
  throw "Cannot verify creation time of live process $ProcessId during window audit"
}

$all = @(Get-CimInstance Win32_Process)
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($RootProcessId)
do {
  $added = 0
  foreach ($item in $all) {
    if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $added++ }
  }
} while ($added -gt 0)
$starts = @{}
foreach ($id in $ids) {
  $startTicks = Get-AuditProcessStartTicks $id
  if ($null -ne $startTicks) { $starts[$id] = $startTicks }
}
$handles = [System.Collections.Generic.List[System.IntPtr]]::new()
$names = [System.Collections.Generic.List[string]]::new()
$visible = [System.Collections.Generic.List[object]]::new()
$inputUnavailable = $false
try {
  foreach ($name in @('Default', $AdditionalDesktop) | Where-Object { $_ } | Select-Object -Unique) {
    $handle = [ReskinWindowAudit]::OpenDesktop($name, 0, $false, 0x41)
    if ($handle -eq [IntPtr]::Zero) { throw [System.ComponentModel.Win32Exception]::new() }
    $handles.Add($handle); $names.Add([ReskinWindowAudit]::Name($handle))
  }
  $inputDesktop = [ReskinWindowAudit]::OpenInputDesktop(0, $false, 0x41)
  if ($inputDesktop -eq [IntPtr]::Zero) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -ne 5) { throw [System.ComponentModel.Win32Exception]::new($errorCode) }
    $inputUnavailable = $true
  } elseif ($names.Contains([ReskinWindowAudit]::Name($inputDesktop))) {
    [void][ReskinWindowAudit]::CloseDesktop($inputDesktop)
  } else {
    $handles.Add($inputDesktop); $names.Add([ReskinWindowAudit]::Name($inputDesktop))
  }
  foreach ($handle in $handles) {
    foreach ($window in [ReskinWindowAudit]::Scan($handle, [int[]]@($starts.Keys))) {
      $startTicks = Get-AuditProcessStartTicks $window.pid
      if ($null -eq $startTicks) { continue }
      if ($startTicks -ne $starts[$window.pid]) { throw 'Window process identity changed during audit' }
      $visible.Add($window)
    }
  }
  [pscustomobject]@{
    supported = $true
    currentDesktop = [ReskinWindowAudit]::Name([ReskinWindowAudit]::GetThreadDesktop([ReskinWindowAudit]::GetCurrentThreadId()))
    monitoredDesktops = @($names.ToArray())
    inputDesktopUnavailable = $inputUnavailable
    processIds = @($starts.Keys | Sort-Object)
    visible = @($visible.ToArray())
  } | ConvertTo-Json -Depth 5 -Compress
} finally {
  foreach ($handle in $handles) { [void][ReskinWindowAudit]::CloseDesktop($handle) }
}
