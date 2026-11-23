'use strict';

const fs = require('fs');
const { acquireLock, acquireLockAsync, releaseLock, releaseLockAsync } = require('./file-lock');
const { titleRevision } = require('./title-metadata');

// Only versioned titles join this lock. Keep the final disk comparison and
// replacement together: a prepared payload can be stale by the time it writes.
function newerTitleOnDisk(file, revision) {
  try { return titleRevision(JSON.parse(fs.readFileSync(file, 'utf8'))) > revision; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
// 异步保存路径用：读盘不占主线程（会话很多、保存很频繁时，同步读会让界面一阵阵卡住）。
async function newerTitleOnDiskAsync(file, revision) {
  try { return titleRevision(JSON.parse(await fs.promises.readFile(file, 'utf8'))) > revision; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function createTitleLockReaper() {
  // Birth lookup may spawn PowerShell. Reuse this acquisition's identity
  // verdict, but still check liveness on every retry so exited owners recover.
  const identities = new Map();
  return owner => {
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); }
    catch (error) { return error.code === 'ESRCH'; }
    if (!Number.isFinite(owner.mtime) || owner.mtime <= 0) return false;
    const key = owner.pid + ':' + owner.mtime;
    if (!identities.has(key)) {
      try { identities.set(key, !require('./owned-process').matches(owner.pid, owner.mtime)); }
      catch { identities.set(key, false); } // Unknown birth is not proof to steal.
    }
    return identities.get(key);
  };
}

// 本进程的异步写此刻正拿着的锁（锁路径 → 拿着的个数）。退出落盘时（ownAsyncOk）若锁正被本进程一个已作废的异步写拿着，
// 不必等它：那个写不会再发布，或发布后会补写回退出快照（core/session-store.js 的代次）。别的进程拿着的锁照旧等。
const heldByOwnAsync = new Map();
function withTitleBackupWrite(file, revision, write, { ownAsyncOk = false } = {}) {
  if (!Number.isFinite(revision)) return write();
  const lock = file + '.title.lock', fd = acquireLock(lock, { canReap: createTitleLockReaper() });
  if (fd == null) {
    if (ownAsyncOk && heldByOwnAsync.get(lock) > 0) return newerTitleOnDisk(file, revision) ? false : write();
    throw new Error('标题备份锁被占用，名称未保存，请重试');
  }
  try { return newerTitleOnDisk(file, revision) ? false : write(); }
  finally { releaseLock(fd, lock); }
}
async function withTitleBackupWriteAsync(file, revision, write) {
  if (!Number.isFinite(revision)) return write();
  const lock = file + '.title.lock', handle = await acquireLockAsync(lock, { retries: 1200, canReap: createTitleLockReaper() });
  if (!handle) throw new Error('标题备份锁被占用，名称未保存，请重试');
  heldByOwnAsync.set(lock, (heldByOwnAsync.get(lock) || 0) + 1);
  try { return (await newerTitleOnDiskAsync(file, revision)) ? false : await write(); }
  finally {
    const n = (heldByOwnAsync.get(lock) || 1) - 1;
    if (n > 0) heldByOwnAsync.set(lock, n); else heldByOwnAsync.delete(lock);
    await releaseLockAsync(handle, lock);
  }
}
module.exports = { withTitleBackupWrite, withTitleBackupWriteAsync };
