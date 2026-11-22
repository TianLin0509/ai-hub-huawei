'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ensureWindowsShellIntegration, getShortcutPaths, HUB_APP_USER_MODEL_ID } = require('../core/windows-shell-integration');

test('退役快捷方式只保留最新备份，不动其它快捷方式和停用的桌面修复', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shortcut-backup-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('hub-shortcut-backup-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const appDataPath = path.join(root, 'appdata'), desktopPath = path.join(root, 'desktop');
  const execPath = path.join(root, 'electron.exe');
  const { legacyPath, desktopLegacyPath } = getShortcutPaths({ appDataPath, desktopPath });
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.mkdirSync(desktopPath);
  const old = legacyPath + '.hub-invalid-20260101000000.bak';
  const other = path.join(path.dirname(legacyPath), 'Other.lnk.hub-invalid-20260101000000.bak');
  const nonBackup = legacyPath + '.hub-invalid-keep.txt';
  for (const file of [old, other, nonBackup, desktopLegacyPath]) fs.writeFileSync(file, '保留');
  const shell = {
    readShortcutLink: () => ({ target: execPath, appUserModelId: HUB_APP_USER_MODEL_ID, args: '' }),
    writeShortcutLink: () => true,
  };
  const app = { setAppUserModelId() {}, setUserTasks: () => true, getPath: () => root };
  const run = date => ensureWindowsShellIntegration({ app, shell, execPath, appRoot: root,
    appDataPath, desktopPath, platform: 'win32', now: () => new Date(date), logger: { warn() {}, log() {} } });
  fs.writeFileSync(legacyPath, '第一次');
  const first = run('2026-11-23T01:00:00Z');
  assert.ok(first.legacyBackupPath);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.readFileSync(first.legacyBackupPath, 'utf8'), '第一次');
  fs.writeFileSync(legacyPath, '第二次');
  const second = run('2026-11-23T02:00:00Z');
  assert.equal(fs.existsSync(first.legacyBackupPath), false);
  assert.equal(fs.readFileSync(second.legacyBackupPath, 'utf8'), '第二次');
  for (const file of [other, nonBackup, desktopLegacyPath]) assert.equal(fs.readFileSync(file, 'utf8'), '保留');
  assert.equal(second.desktopShortcutUpdated, false);
});
