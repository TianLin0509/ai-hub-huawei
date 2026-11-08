param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
if (!(Test-Path -LiteralPath $root -PathType Container)) { throw 'Missing staging directory' }
if (@(Get-ChildItem -LiteralPath $root -Force).Count -ne 0) { throw 'Staging directory must be empty' }
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $total = [long]0
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('/', '\')
    if ($name -match '(^[\\/]|:|(^|[\\/])\.\.?([\\/]|$))') { throw 'Unsafe archive path' }
    foreach ($segment in $name.TrimEnd('\').Split('\')) {
      if (!$segment -or $segment -match '[. ]$|^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') { throw 'Unsafe archive name' }
    }
    $mode = (($entry.ExternalAttributes -shr 16) -band 0xF000)
    if ($mode -eq 0xA000 -or ($entry.ExternalAttributes -band 0x400) -ne 0) { throw 'Links are not supported' }
    $target = [IO.Path]::GetFullPath((Join-Path $root $name))
    if (!$target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or !$seen.Add($target)) { throw 'Unsafe or duplicate archive path' }
    $total += $entry.Length
    if ($total -gt 8GB -or $zip.Entries.Count -gt 100000) { throw 'Archive is too large' }
  }
  foreach ($entry in $zip.Entries) {
    $target = [IO.Path]::GetFullPath((Join-Path $root $entry.FullName.Replace('/', '\')))
    if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) { [IO.Directory]::CreateDirectory($target) | Out-Null }
    else {
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
  }
} finally { $zip.Dispose() }
