'use strict';
// 任务栏图标空白（反馈 1e407a67）：任务栏固定项指向已不存在的旧 Hub exe 时，启动时改指向当前程序和图标；
// 指向另一份还在的程序、或不是 Hub 的快捷方式都不动。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { refreshPackagedShortcutIcons, HUB_APP_USER_MODEL_ID } = require('../core/windows-shell-integration');

const EXE = 'D:\\Download\\AIHubHuawei-5.6.2-win-x64\\AI Hub Community.exe';
const ICON = 'D:\\Download\\AIHubHuawei-5.6.2-win-x64\\resources\\app.asar.unpacked\\claude-wx.ico';
const PINNED = 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar';

function setup(links, existing) {
  const files = new Set(['C:\\', 'D:\\', EXE, ICON, PINNED, ...existing, ...Object.keys(links)]);
  const writes = [];
  const fsModule = {
    existsSync: p => files.has(p),
    readdirSync: dir => Object.keys(links).filter(f => path.dirname(f) === dir).map(f => path.basename(f)),
  };
  const shell = {
    readShortcutLink: f => ({ ...links[f] }),
    writeShortcutLink: (f, op, d) => { writes.push({ f: path.basename(f), op, d }); return true; },
  };
  return { fsModule, shell, writes };
}

test('dead pinned Hub shortcut (old install removed) is repointed to the running exe and icon', () => {
  const dead = path.join(PINNED, 'AI Hub.lnk');
  const { fsModule, shell, writes } = setup({ [dead]: { target: 'D:\\AIHub\\AI Hub Community\\AI Hub Community.exe', icon: 'D:\\AIHub\\AI Hub Community\\AI Hub Community.exe', appUserModelId: HUB_APP_USER_MODEL_ID } }, []);
  const changed = refreshPackagedShortcutIcons({ shell, execPath: EXE, iconPath: ICON, dirs: [PINNED], fsModule, logger: { log() {}, warn() {} } });
  assert.deepEqual(changed, [dead]);
  assert.equal(writes[0].op, 'update');
  assert.equal(writes[0].d.target, EXE);
  assert.equal(writes[0].d.cwd, path.dirname(EXE));
  assert.equal(writes[0].d.icon, ICON);
  assert.equal('args' in writes[0].d, false, 'keeps user launch args');
});

test('same-name exe without Hub AUMID is not touched (could be another app)', () => {
  const dead = path.join(PINNED, 'Hub.lnk');
  const { fsModule, shell, writes } = setup({ [dead]: { target: 'D:\\old\\AI Hub Community.exe', icon: '' } }, []);
  assert.equal(refreshPackagedShortcutIcons({ shell, execPath: EXE, iconPath: ICON, dirs: [PINNED], fsModule, logger: {} }).length, 0);
  assert.equal(writes.length, 0);
});

test('another Hub copy that still exists, and non-Hub shortcuts, are left alone', () => {
  const other = 'D:\\AIHub\\AI Hub Community\\AI Hub Community.exe';
  const { fsModule, shell, writes } = setup({
    [path.join(PINNED, 'AI Hub.lnk')]: { target: other, icon: other, appUserModelId: HUB_APP_USER_MODEL_ID },
    [path.join(PINNED, 'Word.lnk')]: { target: 'C:\\gone\\WINWORD.EXE', icon: '' },
  }, [other]);
  assert.deepEqual(refreshPackagedShortcutIcons({ shell, execPath: EXE, iconPath: ICON, dirs: [PINNED], fsModule, logger: {} }), []);
  assert.equal(writes.length, 0);
});

test('shortcut to the running exe still only gets its icon refreshed (unchanged behaviour)', () => {
  const own = path.join(PINNED, 'AI Hub.lnk');
  const { fsModule, shell, writes } = setup({ [own]: { target: EXE, icon: EXE, appUserModelId: HUB_APP_USER_MODEL_ID } }, []);
  assert.deepEqual(refreshPackagedShortcutIcons({ shell, execPath: EXE, iconPath: ICON, dirs: [PINNED], fsModule, logger: {} }), [own]);
  assert.deepEqual(writes[0].d, { icon: ICON, iconIndex: 0 });
});

test('target on a drive that is not there (USB unplugged) or a network share is left alone', () => {
  const usb = path.join(PINNED, 'USB Hub.lnk'), unc = path.join(PINNED, 'Share Hub.lnk');
  const { fsModule, shell, writes } = setup({
    [usb]: { target: 'F:\\Hub\\AI Hub Community.exe', icon: '', appUserModelId: HUB_APP_USER_MODEL_ID },
    [unc]: { target: '\\\\nas\\apps\\AI Hub Community.exe', icon: '', appUserModelId: HUB_APP_USER_MODEL_ID },
  }, []);
  assert.deepEqual(refreshPackagedShortcutIcons({ shell, execPath: EXE, iconPath: ICON, dirs: [PINNED], fsModule, logger: {} }), []);
  assert.equal(writes.length, 0);
});
