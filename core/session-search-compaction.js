'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_FREE_BYTES = 100 * 1024 * 1024;

function storageStats(index) {
  const pageSize = Number(index.db.prepare('PRAGMA page_size').get().page_size);
  const pages = Number(index.db.prepare('PRAGMA page_count').get().page_count);
  const freePages = Number(index.db.prepare('PRAGMA freelist_count').get().freelist_count);
  return { bytes: pages * pageSize, freeBytes: freePages * pageSize, freeRatio: pages ? freePages / pages : 0 };
}

function compactionReason(stats, lastAttempt, now = Date.now(), availableBytes = Infinity) {
  if (lastAttempt > 0 && now - lastAttempt < DAY_MS) return 'daily_limit';
  if (stats.freeRatio <= 0.3 || stats.freeBytes <= MIN_FREE_BYTES) return 'below_threshold';
  // SQLite VACUUM may need twice the original size in additional disk space.
  // https://www.sqlite.org/lang_vacuum.html#how_vacuum_works
  if (availableBytes < stats.bytes * 2) return 'insufficient_space';
  return null;
}

function compactIndex(index, options = {}) {
  const now = options.now ?? Date.now();
  const available = options.availableBytes || (() => {
    const stat = fs.statfsSync(path.dirname(index.databasePath));
    return Number(stat.bavail) * Number(stat.bsize);
  });
  // Do not wait behind an unrelated transaction or interfere with a live indexer.
  index.db.exec('PRAGMA busy_timeout=0');
  let token;
  try {
    token = index.acquireWriterLease();
    if (!token) return { skipped: 'writer_active' };
    const before = storageStats(index);
    const lastAttempt = Number(index.getMeta('lastCompactionAttemptAt', 0));
    const reason = compactionReason(before, lastAttempt, now);
    if (reason) return { skipped: reason };
    const spaceReason = compactionReason(before, lastAttempt, now, available());
    if (spaceReason) return { skipped: spaceReason, before };
    // Persist before the expensive work: failure/restart must not cause a loop.
    index.setMeta('lastCompactionAttemptAt', now);
    const started = performance.now();
    index.db.exec("INSERT INTO docs_fts(docs_fts) VALUES('optimize'); INSERT INTO docs_cjk(docs_cjk) VALUES('optimize'); VACUUM;");
    // A frozen WAL snapshot can defer truncation. It remains valid; never wait
    // for its reader, replace the live file, or force-close search cursors.
    const checkpoint = index.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    return { before, after: storageStats(index), durationMs: Math.round(performance.now() - started), checkpoint };
  } catch (error) {
    if (/locked|busy/i.test(error.message)) return { skipped: 'database_busy' };
    throw error;
  } finally {
    // A short external write may start just after VACUUM commits. Cleanup runs
    // in the maintenance worker, so wait there rather than strand a lease whose
    // parent PID stays alive after this thread exits.
    if (token) {
      index.db.exec('PRAGMA busy_timeout=5000');
      index.releaseWriterLease(token);
    }
  }
}

function runCompaction(databasePath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { databasePath } });
    let result;
    worker.on('message', message => { result = message; });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code || !result) reject(new Error(`搜索索引整理线程退出 (${code})`));
      else if (result.error) reject(new Error(result.error));
      else resolve(result);
    });
  });
}

if (!isMainThread) {
  let index;
  try {
    const { SqliteSessionSearchIndex } = require('./session-search-sqlite-index');
    index = new SqliteSessionSearchIndex(workerData.databasePath, { sqliteCacheMb: 32, sqliteBusyTimeoutMs: 0 });
    parentPort.postMessage(compactIndex(index));
  } catch (error) {
    parentPort.postMessage(/locked|busy/i.test(error.message) ? { skipped: 'database_busy' } : { error: error.message });
  } finally { if (index) index.close(); }
}

module.exports = { DAY_MS, MIN_FREE_BYTES, compactionReason, compactIndex, runCompaction };
