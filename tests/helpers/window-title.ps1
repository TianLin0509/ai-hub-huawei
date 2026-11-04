param([Parameter(Mandatory=$true)][int]$TargetPid)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$privateDesktop = $env:PPTDOCTOR_TEST_DESKTOP
if (-not $privateDesktop) {
  (Get-Process -Id $TargetPid -ErrorAction Stop).MainWindowTitle
  exit 0
}
# MainWindowTitle enumerates the caller's desktop. Under the private-desktop
# test guard, query that desktop explicitly and only read our own Hub's caption.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class HubTestCaption {
  public delegate bool Callback(IntPtr window, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumDesktopWindows(IntPtr desktop, Callback callback, IntPtr data);
  [DllImport("user32.dll")]
  public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
}
'@
$desktop = [HubTestCaption]::OpenDesktop($privateDesktop, 0, $false, 65)
if ($desktop -eq [IntPtr]::Zero) { throw "Could not open the test desktop" }
$captions = [Collections.Generic.List[string]]::new()
try {
  $callback = [HubTestCaption+Callback]{
    param([IntPtr]$Window, [IntPtr]$Data)
    [uint32]$owner = 0
    [void][HubTestCaption]::GetWindowThreadProcessId($Window, [ref]$owner)
    if ($owner -eq $TargetPid) {
      $text = [Text.StringBuilder]::new(2048)
      if ([HubTestCaption]::GetWindowText($Window, $text, $text.Capacity) -gt 0) { $captions.Add($text.ToString()) }
    }
    return $true
  }
  if (-not [HubTestCaption]::EnumDesktopWindows($desktop, $callback, [IntPtr]::Zero)) { throw 'Could not enumerate owned test windows' }
  $captions | Where-Object { $_ -match ' v[0-9]+\.' } | Select-Object -First 1
} finally { [void][HubTestCaption]::CloseDesktop($desktop) }
