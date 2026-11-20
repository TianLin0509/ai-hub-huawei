'use strict';
// 解析命令壳（定位中心）：npm、pnpm、volta 生成的 .cmd / .ps1 命令壳只是一层转发，真正的入口是包里的 JS 脚本或原生程序。
// Hub 解析出真实入口，再用一份够新的 Node 直接运行它，不经过 .ps1（公司组策略可能禁止跑脚本），也不依赖 PATH 上有没有 node。
// 只读文件，不起进程。
//
// 解析结果（form）：
//   { kind: 'native', exe }                原生程序（.exe，或命令壳转发到的 .exe）
//   { kind: 'node', script, shimNode, pkg } JS 入口；shimNode 是命令壳旁边自带的 node.exe（npm 的壳会优先用它）
//   { kind: 'cmd', file }                  认不出转发目标的 .cmd/.bat（如 DSH 桌面版的壳：它自己按绝对路径调桌面程序），原样经 cmd.exe 运行
//   { kind: 'ps1', file }                  认不出转发目标的 .ps1，只能经 PowerShell 运行（可能被组策略拦）
//   { kind: 'placeholder', file }          .exe 其实是文本占位（npm 禁了安装脚本时留下的），运行会报「不是有效的 Win32 程序」
const path = require('node:path');

const JS_RE = /\.(?:c|m)?js$/i;

function readText(fsImpl, file) { try { return fsImpl.readFileSync(file, 'utf8'); } catch { return ''; } }
function isFile(fsImpl, file) { try { return fsImpl.statSync(file).isFile(); } catch { return false; } }
function realpath(fsImpl, p) { try { return (fsImpl.realpathSync.native || fsImpl.realpathSync)(p); } catch { return p; } }

// 原生程序头两个字节是 MZ；npm 占位文件是文本。
function looksNative(fsImpl, file) {
  let fd = null;
  try {
    fd = fsImpl.openSync(file, 'r');
    const buf = Buffer.alloc(2);
    const n = fsImpl.readSync(fd, buf, 0, 2, 0);
    return n === 2 && buf[0] === 0x4d && buf[1] === 0x5a;
  } catch { return true; } // 读不了头时不下结论，交给试跑
  finally { if (fd != null) { try { fsImpl.closeSync(fd); } catch { /* 已关 */ } } }
}

// 命令壳里引号括起来的路径（已把 %dp0%、%~dp0、$basedir 换成壳所在目录）。
function quotedPaths(text, dir) {
  const base = dir + path.sep;
  const replaced = String(text)
    .replace(/%~dp0%?/gi, base).replace(/%dp0%/gi, base)
    .replace(/\$basedir/g, dir).replace(/\$exe\b/g, '.exe');
  const out = [];
  const re = /"([^"\r\n]+)"/g;
  let m;
  while ((m = re.exec(replaced))) {
    const raw = m[1].trim();
    if (!/[\\/]/.test(raw) || /%_prog%|\$\w+/.test(raw)) continue;
    out.push(path.normalize(path.isAbsolute(raw) ? raw : path.resolve(dir, raw)));
  }
  return out;
}

// 包根目录：从入口往上找第一个带 name 的 package.json（npm link 的源码目录先解开链接）。
function packageOf(fsImpl, script) {
  let dir = path.dirname(realpath(fsImpl, script));
  for (let i = 0; i < 8; i++) {
    const file = path.join(dir, 'package.json');
    if (isFile(fsImpl, file)) {
      try {
        const json = JSON.parse(readText(fsImpl, file).replace(/^﻿/, ''));
        if (json && json.name) return { dir, name: String(json.name), version: String(json.version || ''), engines: json.engines || {}, bin: json.bin || null,
          dependencies: { ...(json.dependencies || {}), ...(json.peerDependencies || {}), ...(json.optionalDependencies || {}) } };
      } catch { /* 坏的 package.json 当没有 */ }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function nodeForm(fsImpl, script, shimDir) {
  const shimNode = shimDir && isFile(fsImpl, path.join(shimDir, 'node.exe')) ? path.join(shimDir, 'node.exe') : null;
  return { kind: 'node', script, shimNode, pkg: packageOf(fsImpl, script) };
}

function resolveFile(file, { fs: fsImpl, platform = process.platform } = {}) {
  if (!isFile(fsImpl, file)) return { kind: 'missing', file };
  const ext = path.extname(file).toLowerCase();
  if (JS_RE.test(file)) return nodeForm(fsImpl, file, null);
  if (platform !== 'win32') return { kind: 'native', exe: file };
  if (ext === '.exe' || ext === '.com') return looksNative(fsImpl, file) ? { kind: 'native', exe: file } : { kind: 'placeholder', file };
  const dir = path.dirname(file);
  if (ext === '.cmd' || ext === '.bat' || ext === '.ps1') {
    const text = readText(fsImpl, file);
    // DSH 桌面版的壳：用桌面程序自带的 Electron 当 Node 跑（ELECTRON_RUN_AS_NODE=1，入口 dsh-desktop-host 的 cli.js 或 desktop-cli.js）。
    // 不能拆出 JS 入口换成本机 Node 跑，原样经 cmd 运行。
    if (/ELECTRON_RUN_AS_NODE|dsh-desktop-host|desktop-cli.js/i.test(text)) return { kind: ext === '.ps1' ? 'ps1' : 'cmd', file, electron: true };
    const paths = quotedPaths(text, dir);
    const js = paths.filter(p => JS_RE.test(p));
    const exes = paths.filter(p => /\.exe$/i.test(p) && !/[\\/]node\.exe$/i.test(p));
    // 壳按绝对路径调另一个程序跑脚本（DSH 桌面版：用桌面程序自带的 Electron 当 Node）：原样运行，它自己知道怎么跑。
    if (exes.length && js.length) return { kind: ext === '.ps1' ? 'ps1' : 'cmd', file };
    if (js.length) {
      const script = js[js.length - 1];
      if (isFile(fsImpl, script)) return nodeForm(fsImpl, script, dir);
      return { kind: ext === '.ps1' ? 'ps1' : 'cmd', file, brokenTarget: script };
    }
    if (exes.length) {
      const exe = exes[exes.length - 1];
      if (isFile(fsImpl, exe)) return looksNative(fsImpl, exe) ? { kind: 'native', exe, via: file } : { kind: 'placeholder', file: exe, via: file };
      return { kind: ext === '.ps1' ? 'ps1' : 'cmd', file, brokenTarget: exe };
    }
    return { kind: ext === '.ps1' ? 'ps1' : 'cmd', file };
  }
  return { kind: 'native', exe: file };
}

// npm 全局目录里的包（没有命令壳时）：读 package.json 的 bin，得到 JS 入口。返回入口路径或 ''。
function packageEntry(fsImpl, root, pkgName, binName) {
  const dir = path.join(root, 'node_modules', ...pkgName.split('/'));
  let json = null;
  try { json = JSON.parse(readText(fsImpl, path.join(dir, 'package.json')).replace(/^﻿/, '')); } catch { return ''; }
  if (!json) return '';
  const bin = typeof json.bin === 'string' ? json.bin : json.bin && (json.bin[binName] || Object.values(json.bin)[0]);
  if (!bin) return '';
  const entry = path.join(dir, bin);
  return isFile(fsImpl, entry) ? entry : '';
}

module.exports = { resolveFile, packageEntry, packageOf, quotedPaths, looksNative };
