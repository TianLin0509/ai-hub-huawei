'use strict';
// 伪终端宿主：Windows 上优先用 node-pty 自带的新版 ConPTY（conpty.dll + OpenConsole.exe），
// 起不来再退回系统自带的 ConPTY。
//
// 2026-11-07 本机实测（Windows 11 26200，系统 ConPTY）：经伪终端送进 CLI 的文字，
// 一大批符号被系统 ConPTY 直接丢掉——1667 个测试字符丢 1197 个：中文引号 “”‘’、破折号、
// 省略号、箭头、①②、× ± °、制表符号、方块三角、表情；汉字、字母、全角标点不受影响。
// 用户打「只回复“完成”」，Codex 收到「只回复完成」，卡片上的乐观气泡也因此对不上原生记录、显示两遍。
// 同样的字符经 node-pty 自带的 ConPTY 一个不丢（探针见 tests/unit-pty-host.test.js 的说明）。
//
// AI_HUB_PTY_HOST=system 可退回系统 ConPTY（排查用）。
const fs = require('fs');
const path = require('path');

let cachedDir;
function bundledConptyDir() {
  if (cachedDir !== undefined) return cachedDir;
  cachedDir = null;
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'))
      // 打包后 .node 从 app.asar.unpacked 加载，conpty.dll 要在它旁边
      .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    const dir = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'conpty');
    if (fs.existsSync(path.join(dir, 'conpty.dll')) && fs.existsSync(path.join(dir, 'OpenConsole.exe'))) cachedDir = dir;
  } catch { /* node-pty 不在：调用方自己会报错 */ }
  return cachedDir;
}

function bundledConptyWanted(env = process.env) {
  return process.platform === 'win32' && String(env.AI_HUB_PTY_HOST || '').toLowerCase() !== 'system' && !!bundledConptyDir();
}

let fallbackLogged = false;
// 与 pty.spawn 同参；只在 Windows + useConpty 时加 useConptyDll，失败一次就按系统 ConPTY 重来。
function spawnPty(ptyModule, file, args, options = {}) {
  if (options.useConpty === false || !bundledConptyWanted()) return ptyModule.spawn(file, args, options);
  try {
    return ptyModule.spawn(file, args, { useConpty: true, ...options, useConptyDll: true });
  } catch (error) {
    if (!fallbackLogged) { fallbackLogged = true; console.warn('[pty-host] 自带 ConPTY 启动失败，退回系统 ConPTY：', error && error.message); }
    return ptyModule.spawn(file, args, options);
  }
}

module.exports = { spawnPty, bundledConptyDir, bundledConptyWanted, _resetForTest() { cachedDir = undefined; fallbackLogged = false; } };
