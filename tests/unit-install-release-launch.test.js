'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('诊断命令使用正确的临时回执路径，无 BEL 控制字符', () => {
  const doc = fs.readFileSync(path.join(__dirname, '../docs/AGENT-QUICKSTART.md'), 'utf8');
  assert.equal(doc.includes('\x07'), false);
  assert.ok(doc.includes('$env:TEMP\\ai-hub-install-result.json'));
});

for (const constrained of [true, false]) test(`安装脚本${constrained ? '在真实受限语言模式' : '普通失败'}下返回 JSON 回执，不下载或启动程序`, { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(__dirname, 'install-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resultPath = path.join(root, 'nested', 'result.json');
  const quote = text => "'" + text.replace(/'/g, "''") + "'";
  const command = (constrained ? "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; " : '')
    + `& ${quote(path.resolve(__dirname, '../scripts/install-release.ps1'))} -NoLaunch -NoShortcut -ResultPath ${quote(resultPath)}`
    + (constrained ? '' : " -PackagePath 'missing.zip'");
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(resultPath), true, result.stderr + result.stdout);
  const contents = fs.readFileSync(resultPath, 'utf8');
  if (!constrained) assert.notEqual(contents.charCodeAt(0), 0xFEFF, '普通模式回执必须是无 BOM 的 UTF-8 JSON');
  const receipt = JSON.parse(constrained ? contents.replace(/^\uFEFF/, '') : contents);
  assert.equal(receipt.ok, false); assert.equal(receipt.stagingDirectory, null);
  assert.match(receipt.error, constrained ? /受限语言模式.*完整安装包.*IT/ : /Offline installation requires both/);
  assert.equal(JSON.parse(result.stdout.trim().replace(/^\uFEFF/, '')).ok, false);
});
