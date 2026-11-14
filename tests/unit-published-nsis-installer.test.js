'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { installationScript, publicInstallerGuid, installPublishedNsis } = require('./helpers/published-nsis-installer');

test('published public Setup uses its stable appId GUID without a build dependency', () => {
  assert.equal(publicInstallerGuid(), 'c2abb912-3d28-59fc-848e-8d5776c6de2c');
});

test('a full acceptance refuses external destinations or unverified installer bytes before execution', async () => {
  await assert.rejects(installPublishedNsis({root:os.tmpdir(),install:'C:/Users/real-hub',installer:'missing',sha256:'0'.repeat(64)}), /Outside isolated/);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-public-upgrade-unit-'));
  const file=path.join(root,'Setup.exe');fs.writeFileSync(file,'not a verified release');
  try {
    await assert.rejects(installPublishedNsis({root,install:path.join(root,'hub'),installer:file,out:root,sha256:'0'.repeat(64)}), /SHA256 mismatch/);
    assert.equal(fs.existsSync(path.join(root,'published-installer.ps1')),false);
    await assert.rejects(installPublishedNsis({root,install:path.join(root,'hub'),installer:path.join(root,'..','Setup.exe'),out:root,sha256:'0'.repeat(64)}), /staged inside/);
  }finally{fs.unlinkSync(file);fs.rmdirSync(root);}
});

test('published installer PowerShell parses with quoted paths and restores exact metadata in finally', {skip:process.platform!=='win32'}, () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'published-setup-parser-'));
  const file=path.join(root,'script.ps1');
  const script=installationScript({installer:"D:\\Temp\\a'b\\Setup.exe",install:"D:\\Temp\\a'b\\hub",evidence:path.join(root,'result.json')});
  try {
    fs.writeFileSync(file,script);
    const ps="$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|Out-String|Write-Error;exit 1}";
    // Parse only: never execute the installer or touch the real registry here.
    const parse=`& { ${ps} } '${file.replace(/'/g,"''")}'`;
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(parse,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,stdio:'pipe'});
    assert.ok(script.includes('/S /currentuser --updated --no-desktop-shortcut /D='));
    assert.ok(script.includes('finally{'));
    assert.ok(script.includes('Restore $user $key $before[$key]'));
    assert.ok(script.includes('otherProcessesPreserved'));
    assert.ok(!script.includes('taskkill'));
    assert.ok(!script.includes('electron-builder'));
  }finally{fs.unlinkSync(file);fs.rmdirSync(root);}
});
