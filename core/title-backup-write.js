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

function withTitleBackupWrite(file, revision, write) {
  if (!Number.isFinite(revision)) return write();
  const lock = file + '.title.lock', fd = acquireLock(lock, { canReap: createTitleLockReaper() });
  if (fd == null) throw new Error('标题备份锁被占用，名称未保存，请重试');
  try { return newerTitleOnDisk(file, revision) ? false : write(); }
  finally { releaseLock(fd, lock); }
}
async function withTitleBackupWriteAsync(file, revision, write) {
  if (!Number.isFinite(revision)) return write();
  const lock = file + '.title.lock', handle = await acquireLockAsync(lock, { retries: 1200, canReap: createTitleLockReaper() });
  if (!handle) throw new Error('标题备份锁被占用，名称未保存，请重试');
  try { return newerTitleOnDisk(file, revision) ? false : await write(); }
  finally { await releaseLockAsync(handle, lock); }
}
module.exports = { withTitleBackupWrite, withTitleBackupWriteAsync };
