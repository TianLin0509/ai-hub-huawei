'use strict';
// 改名替换遇到 Windows 短暂占用就稍等重试（2026-10-16，进程级统一安装）。
//
// 背景：代码里约 90 处「先写临时文件再改名」的保存点，Windows 上目标文件被杀毒、索引或另一个读者短暂占用时，
// 改名会报 EPERM / EBUSY。2026-10-15 到 16 日的合并闸门里，助理入口文件、网页圆桌、重启恢复、编排账本等
// 不同保存点轮流因此失败，一处一处补重试补不完。这里在进程启动时统一给 fs 的改名套上同一条规则：
// 只重试 EPERM / EBUSY / EACCES（杀毒或索引持有句柄时 Windows 也会报 EACCES）、仅 Windows、
// 默认最多 20 次（每次约 15 毫秒，次数和间隔可在 install 时调）；其他错误照常抛出。
// Hub 主进程（main.js）在最开始安装；自用版的单测运行器也给每个测试进程预先装上，行为一致。
// 这是全仓唯一一层改名重试：没有安装的进程（子进程、脚本）用下面的 renameSync / rename，规则相同。
const fs = require('node:fs');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRIES = 20;
const DELAY_MS = 15;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const INSTALLED = Symbol.for('hub.fsRenameRetry');

function wrapSync(original, { retries = RETRIES, delayMs = DELAY_MS, sleep = ms => Atomics.wait(sleepCell, 0, 0, ms) } = {}) {
  return function renameSyncWithRetry(source, target) {
    for (let attempt = 0; ; attempt += 1) {
      try { return original.call(this, source, target); }
      catch (error) {
        // 里层已经按这条规则重试过（带 renameRetried 标记）就直接抛，不叠第二层。
        if (!error || !RETRY_CODES.has(error.code) || error.renameRetried !== undefined) throw error;
        if (attempt >= retries) { try { error.renameRetried = attempt; } catch {} throw error; }
        sleep(delayMs);
      }
    }
  };
}
function wrapAsync(original, { retries = RETRIES, delayMs = DELAY_MS } = {}) {
  return async function renameWithRetry(source, target) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await original.call(this, source, target); }
      catch (error) {
        // 里层已经按这条规则重试过（带 renameRetried 标记）就直接抛，不叠第二层。
        if (!error || !RETRY_CODES.has(error.code) || error.renameRetried !== undefined) throw error;
        if (attempt >= retries) { try { error.renameRetried = attempt; } catch {} throw error; }
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  };
}
function wrapCallback(original, options) {
  const promised = wrapAsync((source, target) => new Promise((resolve, reject) => original(source, target, error => error ? reject(error) : resolve())), options);
  return function renameCallbackWithRetry(source, target, callback) {
    promised(source, target).then(() => callback(null), error => callback(error));
  };
}

// 只在 Windows 上安装；重复调用无副作用。返回是否安装了。
function install({ platform = process.platform, retries = RETRIES, delayMs = DELAY_MS } = {}) {
  if (platform !== 'win32' || fs[INSTALLED]) return false;
  const originals = { renameSync: fs.renameSync, rename: fs.rename, promisesRename: fs.promises.rename };
  fs.renameSync = wrapSync(originals.renameSync, { retries, delayMs });
  fs.rename = wrapCallback(originals.rename, { retries, delayMs });
  fs.promises.rename = wrapAsync(originals.promisesRename, { retries, delayMs });
  Object.defineProperty(fs, INSTALLED, { value: originals, configurable: true });
  return true;
}
function installed() { return !!fs[INSTALLED]; }

// 按同一规则改名：本进程已安装就直接调 fs（不叠加第二层）；没安装、或传入了替身 fsImpl，就临时套一层。
function useDirect(fsImpl, platform) { return platform !== 'win32' || (fsImpl === fs && installed()); }
function renameSync(source, target, { fsImpl = fs, platform = process.platform, ...options } = {}) {
  if (useDirect(fsImpl, platform)) return fsImpl.renameSync(source, target);
  return wrapSync(fsImpl.renameSync.bind(fsImpl), options)(source, target);
}
async function rename(source, target, { fsImpl = fs, platform = process.platform, ...options } = {}) {
  const original = fsImpl.promises.rename.bind(fsImpl.promises);
  if (useDirect(fsImpl, platform)) return original(source, target);
  return wrapAsync(original, options)(source, target);
}

module.exports = { install, installed, wrapSync, wrapAsync, renameSync, rename, RETRY_CODES, RETRIES };
