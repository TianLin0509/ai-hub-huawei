'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index');
const { SessionSearchService } = require('../core/session-search-service');
const { DAY_MS, MIN_FREE_BYTES, compactionReason, compactIndex, runCompaction } = require('../core/session-search-compaction');

function fixture(t, large = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-compaction-'));
  const file = path.join(dir, 'search.sqlite');
  const index = new SqliteSessionSearchIndex(file, { sqliteBusyTimeoutMs: 0 });
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    index.close();
    assert.ok(dir.startsWith(path.join(os.tmpdir(), 'search-compaction-')));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  index.replaceSource({ key: 'source', signature: '1', session: { key: 'session', provider: 'codex', title: '索引测试', updatedAt: Date.now() }, docs: [{ id: 'doc', text: 'searchable compact fixture', scope: 'user' }] });
  index.setMeta('lastRefreshAt', Date.now());
  if (large) {
    index.db.exec('CREATE TABLE ballast(data BLOB); BEGIN IMMEDIATE');
    const insert = index.db.prepare('INSERT INTO ballast VALUES(zeroblob(1048576))');
    for (let i = 0; i < 130; i++) insert.run();
    index.db.exec('COMMIT; DELETE FROM ballast; PRAGMA wal_checkpoint(TRUNCATE)');
  }
  return { index, file, cleanup };
}

test('strict thresholds, rolling daily limit and conservative disk space', () => {
  const stats = { bytes: 400 * 1024 * 1024, freeBytes: MIN_FREE_BYTES + 1, freeRatio: 0.31 };
  assert.equal(compactionReason(stats, 0, DAY_MS), null);
  assert.equal(compactionReason({ ...stats, freeBytes: MIN_FREE_BYTES }, 0), 'below_threshold');
  assert.equal(compactionReason({ ...stats, freeRatio: 0.3 }, 0), 'below_threshold');
  assert.equal(compactionReason(stats, DAY_MS, 2 * DAY_MS - 1), 'daily_limit');
  assert.equal(compactionReason(stats, DAY_MS, 2 * DAY_MS), null);
  assert.equal(compactionReason(stats, 0, DAY_MS, stats.bytes * 2 - 1), 'insufficient_space');
  assert.equal(compactionReason(stats, 0, DAY_MS, stats.bytes * 2), null);
});

test('skips small indexes, active leases and open write transactions without losing data', t => {
  const { index, file, cleanup } = fixture(t);
  assert.equal(compactIndex(index).skipped, 'below_threshold');
  const token = index.acquireWriterLease();
  const other = new SqliteSessionSearchIndex(file, { sqliteBusyTimeoutMs: 0 });
  cleanup.push(() => other.close());
  assert.equal(compactIndex(other).skipped, 'writer_active');
  index.releaseWriterLease(token);
  index.db.exec('BEGIN IMMEDIATE');
  index.db.prepare("UPDATE docs SET text='pending' WHERE event_id='doc'").run();
  assert.equal(compactIndex(other).skipped, 'database_busy');
  index.db.exec('COMMIT');
  assert.equal(other.db.prepare("SELECT text FROM docs WHERE event_id='doc'").get().text, 'pending');
  assert.equal(other.acquireWriterLease('next'), 'next');
  other.releaseWriterLease('next');
});

test('space failure skips before optimize and does not consume daily attempt', t => {
  const { index } = fixture(t, true);
  assert.equal(compactIndex(index, { availableBytes: () => 0 }).skipped, 'insufficient_space');
  assert.equal(index.getMeta('lastCompactionAttemptAt', 0), 0);
  assert.equal(index.db.prepare('SELECT count(*) AS n FROM search_writer_lease').get().n, 0);
});

test('background compaction preserves live WAL snapshots, FTS results, writes and daily limit', async t => {
  const { index, file, cleanup } = fixture(t, true);
  const beforeBytes = fs.statSync(file).size;
  const reader = new DatabaseSync(file, { readOnly: true });
  cleanup.push(() => reader.close());
  reader.exec('BEGIN');
  assert.equal(reader.prepare("SELECT count(*) AS n FROM docs_fts WHERE docs_fts MATCH 'searchable'").get().n, 1);
  let reads = 0;
  const timer = setInterval(() => {
    assert.equal(reader.prepare("SELECT count(*) AS n FROM docs_fts WHERE docs_fts MATCH 'searchable'").get().n, 1);
    reads++;
  }, 5);
  let result;
  try { result = await runCompaction(file); } finally { clearInterval(timer); }
  assert.ok(reads > 0, 'reader ran concurrently with the maintenance worker');
  assert.ok(result.after.bytes < beforeBytes / 2);
  assert.equal(result.after.freeBytes, 0);
  assert.equal(compactIndex(index).skipped, 'daily_limit');
  reader.exec('COMMIT');
  index.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(fs.statSync(file).size < beforeBytes / 2, 'physical file shrinks after frozen reader releases its snapshot');
  assert.equal(index.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  index.replaceSource({ key: 'source', signature: '2', session: { key: 'session', provider: 'codex' }, docs: [{ id: 'new', scope: 'user', text: 'new searchable update' }] });
  assert.equal(index.db.prepare("SELECT count(*) AS n FROM docs_fts WHERE docs_fts MATCH 'update'").get().n, 1);
});

test('service only schedules compaction after user idle with no indexing or requests', async t => {
  const { file, cleanup } = fixture(t);
  let idle = 0, calls = 0;
  const service = new SessionSearchService({ databasePath: file, prewarmEnabled: true, getIdleSeconds: () => idle });
  cleanup.push(() => service.close());
  service._request = async type => {
    assert.equal(type, 'compact'); calls++;
    service.queueRefresh({ sessions: [] });
    assert.equal(service._queueTimer, null, 'refresh waits until compaction exits');
    return { skipped: 'below_threshold' };
  };
  await service._maybeCompact(); assert.equal(calls, 0);
  idle = 180;
  service._childBusy = true;
  await service._maybeCompact(); assert.equal(calls, 0);
  service._childBusy = false;
  service._pending.set(1, {});
  await service._maybeCompact(); assert.equal(calls, 0);
  service._pending.clear();
  service._getIdleSeconds = () => { throw new Error('unavailable'); };
  await service._maybeCompact(); assert.equal(calls, 0);
  service._getIdleSeconds = () => idle;
  await service._maybeCompact(); assert.equal(calls, 1);
  assert.ok(service._queueTimer, 'queued refresh resumes after maintenance');
  service._queuedSnapshot = null;
  await service._maybeCompact(); assert.equal(calls, 1, 'probe throttled for an hour');
});

test('actual search child answers search while a compaction worker is running', async t => {
  const { file, cleanup } = fixture(t, true);
  const service = new SessionSearchService({ databasePath: file, refreshTtlMs: DAY_MS, backgroundWriter: true });
  cleanup.push(() => service.close());
  const before = await service.search({ query: 'searchable' });
  const compact = service._request('compact');
  const during = await service.search({ query: 'searchable' });
  const result = await compact;
  const after = await service.search({ query: 'searchable' });
  assert.ok(!result.skipped, JSON.stringify(result));
  assert.ok(before.results.length > 0);
  assert.equal(during.results.length, before.results.length);
  assert.equal(after.results.length, before.results.length);
});
