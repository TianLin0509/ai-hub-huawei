'use strict';

// Work products only. Configuration, credentials, caches and installed tools stay
// in the data directory. Activate at startup so running jobs keep their paths.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
let active = '', history = [], startupError = '';
const MIN_FREE_BYTES = 256 * 1024 * 1024;
function configure(root = '', oldRoots = []) {
  startupError = '';
  active = root ? path.resolve(root) : '';
  history = oldRoots.filter(r => typeof r === 'string' && path.isAbsolute(r));
}
function configureAtStartup(root = '', oldRoots = [], options = {}) {
  configure('', oldRoots);
  const checked = validate(root, { ...options, requireExisting: true });
  if (checked.ok) active = checked.value;
  else startupError = checked.message;
}
function directory(name, original) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid work directory name');
  return active ? path.join(active, name) : original;
}
function previousDirectories(name, original) {
  return [...new Set([original, ...history.map(r => path.join(r, name))].filter(Boolean))];
}
function validate(value, { fsModule = fs, protectedDirs = [], home, requireExisting = false } = {}) {
  const root = String(value || '').trim();
  if (!root) return { ok: true, value: '' };
  const reason = require('./storage-roots').defaultRootRejectReason(root, { protectedDirs, home });
  if (reason) return { ok: false, message: reason };
  let probe, owned = false;
  try {
    // Startup must not recreate a missing root (for example an unplugged drive).
    if (!requireExisting) fsModule.mkdirSync(root, { recursive: true });
    if (!fsModule.statSync(root).isDirectory()) throw new Error('这个路径是文件，不是文件夹');
    const disk = fsModule.statfsSync(root, { bigint: true });
    const free = BigInt(disk.bavail) * BigInt(disk.bsize);
    if (free < BigInt(MIN_FREE_BYTES)) return { ok: false, message: '目标磁盘可用空间不足 256 MB，请换一个位置或清理空间。' };
    probe = path.join(root, '.hub-write-check-' + randomUUID());
    fsModule.writeFileSync(probe, '', { flag: 'wx' });
    owned = true;
    fsModule.unlinkSync(probe); owned = false;
    return { ok: true, value: path.resolve(root), freeBytes: Number(free) };
  } catch (e) {
    if (requireExisting && e.code === 'ENOENT') {
      return { ok: false, message: '目标目录不存在或所在磁盘未连接：' + e.code };
    }
    return { ok: false, message: '目标目录无法写入或无法检查磁盘空间：' + (e.code || e.message) };
  } finally {
    if (owned) try { fsModule.unlinkSync(probe); } catch {}
  }
}
function current() { return active; }
function configuredRootError() { return startupError; }
module.exports = { configure, configureAtStartup, directory, previousDirectories, validate, current, configuredRootError, MIN_FREE_BYTES };
