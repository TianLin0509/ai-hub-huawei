'use strict';
// 2026-10-09：启动时登记进程号，最后启动的 Hub 负责；两个 Hub 共用一份数据时只有一个触发，不会重复提醒。
const fs = require('node:fs');
const path = require('node:path');
const { alive } = require('../session-open-ownership');
function claimTimers(store, pid = process.pid, now = Date.now()) { store.set('timerOwner', { pid, at: now }); }
function readHeartbeat(store, pid) {
  const file = store.db?.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(file)), 'diagnostics', `process-lifecycle-${pid}.heartbeat.json`), 'utf8')); }
  catch { return null; } // Missing/partially-written heartbeat is not evidence of a dead owner.
}
function ownsTimers(store, pid = process.pid, deps = {}) {
  const check = () => {
    const owner = store.get('timerOwner');
    if (!owner || owner.pid === pid) return true;
    const now = (deps.now || Date.now)();
    const heartbeat = (deps.readHeartbeat || (id => readHeartbeat(store, id)))(owner.pid);
    if (!(deps.isAlive || alive)(owner.pid) || (Number.isFinite(heartbeat?.epochMs) && now - heartbeat.epochMs > 120000)) {
      claimTimers(store, pid, now);
      return true;
    }
    return false;
  };
  // Serialize read + takeover so two survivors cannot both claim the same dead owner.
  if (!store.db) return check();
  store.db.exec('BEGIN IMMEDIATE');
  try { const result = check(); store.db.exec('COMMIT'); return result; }
  catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
module.exports = { claimTimers, ownsTimers };
