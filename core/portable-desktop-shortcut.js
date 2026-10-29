'use strict';
// 免安装版（zip 解压即用）第一次打开时在桌面建快捷方式：有的电脑运行不了安装程序，免安装包是主要的分发方式。
//   - 程序目录里有卸载程序 = 安装版，快捷方式由安装程序管，这里不动；
//   - 每个程序位置只建一次：建过之后用户删掉了，不再重建（记在数据目录 portable-shortcut.json）；
//   - 桌面已有同名快捷方式：指向本程序就不动；指向的程序已不存在（用户挪了文件夹）改指向本程序；
//     指向另一份还在的程序，是用户自己的选择，不动。
const fs = require('fs');
const path = require('path');

const MARKER = 'portable-shortcut.json';
const samePath = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();

function isInstalledCopy(execPath, fsModule = fs) {
  try { return fsModule.readdirSync(path.dirname(execPath)).some(name => /^uninstall\b.*\.exe$/i.test(name)); }
  catch { return false; }
}

function readMarker(file, fsModule) {
  try { const v = JSON.parse(fsModule.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

function ensurePortableDesktopShortcut({ shell, execPath, desktopDir, dataDir, name, iconPath = '', fsModule = fs, now = () => new Date() }) {
  if (!shell || !execPath || !desktopDir || !dataDir || !name) return { action: 'skipped', reason: 'missing-input' };
  if (isInstalledCopy(execPath, fsModule)) return { action: 'skipped', reason: 'installed' };
  const markerFile = path.join(dataDir, MARKER);
  const marker = readMarker(markerFile, fsModule);
  if (marker && samePath(marker.exe, execPath)) return { action: 'skipped', reason: 'done-before' };
  const linkPath = path.join(desktopDir, `${name}.lnk`);
  const details = { target: execPath, cwd: path.dirname(execPath), description: name, ...(iconPath ? { icon: iconPath, iconIndex: 0 } : {}) };
  let action = 'created';
  if (fsModule.existsSync(linkPath)) {
    let current = null;
    try { current = shell.readShortcutLink(linkPath); } catch { current = null; }
    const target = current && current.target;
    if (target && samePath(target, execPath)) action = 'kept';
    else if (target && fsModule.existsSync(target)) action = 'left-other';
    else {
      if (!shell.writeShortcutLink(linkPath, 'replace', details)) throw new Error('writeShortcutLink replace returned false');
      action = 'repointed';
    }
  } else if (!shell.writeShortcutLink(linkPath, 'create', details)) {
    throw new Error('writeShortcutLink create returned false');
  }
  fsModule.mkdirSync(dataDir, { recursive: true });
  fsModule.writeFileSync(markerFile, JSON.stringify({ exe: execPath, link: linkPath, action, at: now().toISOString() }, null, 2) + '\n', 'utf8');
  return { action, linkPath };
}

module.exports = { ensurePortableDesktopShortcut, isInstalledCopy, MARKER };
