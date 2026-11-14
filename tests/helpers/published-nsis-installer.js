'use strict';
// Execute the byte-identical published NSIS installer. Only its destination and
// temporary installation metadata are redirected; no repackaging/build tools.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";

function publicInstallerGuid() {
  const ns = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex');
  const bytes = crypto.createHash('sha1').update(ns).update('com.ai-hub.community').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function installationScript({ installer, install, evidence }) {
  return `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$installer=${quote(installer)}
$target=${quote(install)}
$evidence=${quote(evidence)}
$guid='${publicInstallerGuid()}'
$keys=@("Software\\$guid","Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$guid")
$user=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
$machine=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
$mutex=[Threading.Mutex]::new($false,'Local\\AIHubPublishedSetupAcceptance')
$locked=$false;$changed=$false
$report=[ordered]@{installer=$installer;target=$target;publishedInstallerExecuted=$false;arguments=@('/S','/currentuser','--updated','--no-desktop-shortcut',"/D=$target");registryRestored=$false;shortcutsUnchanged=$false;otherProcessesPreserved=$false}
function Snapshot($base,$keyPath){
 $key=$base.OpenSubKey($keyPath)
 if(!$key){return $null}
 try{
  $values=@(foreach($name in ($key.GetValueNames() | Sort-Object)){[ordered]@{name=$name;kind=$key.GetValueKind($name).ToString();value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}})
  $children=@(foreach($name in ($key.GetSubKeyNames() | Sort-Object)){[ordered]@{name=$name;tree=(Snapshot $base ($keyPath+'\\'+$name))}})
  return [ordered]@{values=$values;children=$children}
 }finally{$key.Dispose()}
}
function Restore($base,$keyPath,$tree){
 $base.DeleteSubKeyTree($keyPath,$false)
 if($null -eq $tree){return}
 $key=$base.CreateSubKey($keyPath)
 try{foreach($v in $tree.values){$key.SetValue($v.name,$v.value,[Enum]::Parse([Microsoft.Win32.RegistryValueKind],$v.kind))}}finally{$key.Dispose()}
 foreach($child in $tree.children){Restore $base ($keyPath+'\\'+$child.name) $child.tree}
}
function Canonical($tree){return ConvertTo-Json -InputObject $tree -Depth 40 -Compress}
function FileHash($file){if(Test-Path -LiteralPath $file){return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash};return $null}
try{
 $locked=$mutex.WaitOne(0)
 if(!$locked){throw 'Another published Setup acceptance is running'}
 if(!(Test-Path -LiteralPath (Join-Path $target 'AI Hub Community.exe'))){throw 'Expected isolated public executable missing'}
 $before=[ordered]@{};$machineBefore=[ordered]@{}
 foreach($key in $keys){$before[$key]=Snapshot $user $key;$machineBefore[$key]=Snapshot $machine $key}
 $report.registryBefore=$before
 $report.machineRegistryBefore=$machineBefore
 $links=@((Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI Hub.lnk'),(Join-Path ([Environment]::GetFolderPath('Programs')) 'AI Hub.lnk'))
 $linkBefore=@(foreach($link in $links){@{path=$link;sha256=(FileHash $link)}})
 $others=@(Get-Process | ForEach-Object {try{if($_.Path -and [IO.Path]::GetFileName($_.Path) -eq 'AI Hub Community.exe' -and !$_.Path.StartsWith($target+'\\',[StringComparison]::OrdinalIgnoreCase)){@{pid=$_.Id;birth=$_.StartTime.ToUniversalTime().Ticks.ToString();path=$_.Path}}}catch{}})
 $report.otherProcessesBefore=$others
 # The released builder uses a directory-scoped PowerShell process check when
 # PowerShell works. Force its inherited process policy, then probe its exact
 # 32-bit executable before allowing any metadata change or installer launch.
 $env:PSExecutionPolicyPreference='Bypass'
 $powershell=Join-Path $env:WINDIR 'SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe'
 & $powershell -NonInteractive -Command "if((Get-Command Get-CimInstance -ErrorAction SilentlyContinue) -and (Get-ExecutionPolicy -Scope Process) -ne 'Restricted'){exit 0};exit 1"
 if($LASTEXITCODE -ne 0){throw 'Directory-scoped NSIS process check unavailable'}
 $changed=$true
 $key=$user.CreateSubKey($keys[0])
 try{$key.SetValue('InstallLocation',$target);$key.SetValue('KeepShortcuts','true');$key.SetValue('ShortcutName','AI Hub');$key.SetValue('MenuDirectory','')}finally{$key.Dispose()}
 $key=$user.CreateSubKey($keys[1])
 try{$key.SetValue('UninstallString','');$key.SetValue('QuietUninstallString','')}finally{$key.Dispose()}
 $report.metadataRedirected=$true
 $report | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $evidence -Encoding UTF8
 $info=[Diagnostics.ProcessStartInfo]::new()
 $info.FileName=$installer
 $info.Arguments='/S /currentuser --updated --no-desktop-shortcut /D='+$target
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle='Hidden'
 $info.WorkingDirectory=$target
 $child=[Diagnostics.Process]::Start($info)
 try{
  $report.installerPid=$child.Id;$report.publishedInstallerExecuted=$true
  if(!$child.WaitForExit(240000)){
   # This is our retained Process object, never an executable-name lookup.
   $child.Kill();$child.WaitForExit();throw 'Published Setup timed out'
  }
  $report.exitCode=$child.ExitCode
  if($child.ExitCode -ne 0){throw ('Published Setup exit '+$child.ExitCode)}
 }finally{$child.Dispose()}
}catch{$report.error=$_.Exception.Message;throw}finally{
 try{
  if($changed){
   $key=$user.OpenSubKey($keys[0]);try{$location=if($key){$key.GetValue('InstallLocation')}else{$null}}finally{if($key){$key.Dispose()}}
   if($location -ne $target){throw 'Installation registry ownership changed; refusing to overwrite another installer'}
   foreach($key in $keys){Restore $user $key $before[$key]}
   $after=[ordered]@{};foreach($key in $keys){$after[$key]=Snapshot $user $key}
   $report.registryRestored=(Canonical $before) -eq (Canonical $after)
   $machineAfter=[ordered]@{};foreach($key in $keys){$machineAfter[$key]=Snapshot $machine $key}
   $report.machineRegistryUnchanged=(Canonical $machineBefore) -eq (Canonical $machineAfter)
   $linkAfter=@(foreach($link in $links){@{path=$link;sha256=(FileHash $link)}})
   $report.shortcutsUnchanged=(Canonical $linkBefore) -eq (Canonical $linkAfter)
   $report.otherProcessesPreserved=$true
   foreach($item in $others){$p=Get-Process -Id $item.pid -ErrorAction SilentlyContinue;if(!$p -or $p.StartTime.ToUniversalTime().Ticks.ToString() -ne $item.birth){$report.otherProcessesPreserved=$false}}
   if(!$report.registryRestored -or !$report.machineRegistryUnchanged -or !$report.shortcutsUnchanged -or !$report.otherProcessesPreserved){throw 'Published Setup isolation verification failed'}
  }
 }catch{$report.cleanupError=$_.Exception.Message;throw}finally{
  $report | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $evidence -Encoding UTF8
  $user.Dispose();$machine.Dispose();if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()
 }
}
`;
}

async function installPublishedNsis({ installer, install, root, out, sha256 }) {
  const resolvedRoot = path.resolve(root), target = path.resolve(install);
  if (path.dirname(resolvedRoot) !== path.resolve(os.tmpdir()) || target !== path.join(resolvedRoot, 'hub') || !path.basename(resolvedRoot).startsWith('hub-public-upgrade-')) throw Error('Outside isolated acceptance install directory');
  if (!path.resolve(installer).startsWith(resolvedRoot + path.sep)) throw Error('Installer must be staged inside the acceptance root');
  if (/[^a-f0-9]/.test(sha256) || sha256.length !== 64 || crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex') !== sha256) throw Error('Published Setup SHA256 mismatch');
  const evidence = path.join(out, 'published-installer.json');
  const script = installationScript({ installer: path.resolve(installer), install: target, evidence: path.resolve(evidence) });
  fs.writeFileSync(path.join(out, 'published-installer.ps1'), script);
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 280000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return JSON.parse(fs.readFileSync(evidence, 'utf8').replace(/^\uFEFF/, ''));
}

module.exports = { publicInstallerGuid, installationScript, installPublishedNsis };
