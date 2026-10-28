'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { MARKER } = require('./codex-account-runtime');

const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const same = (a, b) => normalized(a) === normalized(b);
function within(root, candidate) {
  const relative = path.relative(normalized(root), normalized(candidate));
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function unknown() {
  return Object.assign(new Error('Codex 历史账号归属无法核对，暂不使用历史文件推算账号额度'), { code: 'CODEX_JSONL_HISTORY_UNKNOWN' });
}
// Rollout token_count events have no reliable account identity. Once a managed
// runtime has resumed an original home's history, that home's JSONL quota
// fallback cannot safely be labelled as its canonical account. Markers outlive
// open sessions, so closed/suspended sessions must remain covered as well.
// No cache here: callers must check before returning any older JSONL cache.
function isManagedCodexHistoryRoot({ dataDir, sessionsRoot } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)
      || typeof sessionsRoot !== 'string' || !path.isAbsolute(sessionsRoot)) throw unknown();
  const root = path.join(dataDir, 'codex-account-runtime');
  // New runtime-owned histories are not canonical account history roots.
  if (within(root, sessionsRoot)) return false;
  let rootInfo;
  try { rootInfo = fs.lstatSync(root); }
  catch (error) { if (error.code === 'ENOENT') return false; throw unknown(); }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw unknown();
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { throw unknown(); }
  for (const entry of entries) {
    // Fresh preparations are atomically published under their session id. A
    // leftover staging directory has never been a launched managed runtime.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw unknown();
    if (!entry.isDirectory()) continue;
    const home = path.join(root, entry.name), markerFile = path.join(home, MARKER);
    let marker;
    try {
      const info = fs.lstatSync(markerFile);
      if (!info.isFile() || info.isSymbolicLink()) throw unknown();
      marker = JSON.parse(fs.readFileSync(markerFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch { throw unknown(); }
    if (!marker || marker.version !== 1 || marker.sessionId !== entry.name
        || typeof marker.home !== 'string' || !path.isAbsolute(marker.home) || !same(marker.home, home)
        || typeof marker.historyHome !== 'string' || !path.isAbsolute(marker.historyHome)
        || !Number.isSafeInteger(marker.generation) || marker.generation < 1
        || typeof marker.profile !== 'string' || !marker.profile
        || typeof marker.contextProfile !== 'string' || !marker.contextProfile) throw unknown();
    if (!within(root, marker.historyHome) && same(path.join(marker.historyHome, 'sessions'), sessionsRoot)) return true;
  }
  return false;
}

function filterManagedCodexHistoryCache(cache, options) {
  if (!cache?.codex || cache.codex.source === 'app-server') return cache;
  let mixed = true;
  try { mixed = isManagedCodexHistoryRoot(options); } catch { /* Unknown provenance remains unavailable. */ }
  if (!mixed) return cache;
  const safe = {...cache};
  delete safe.codex;
  return safe;
}

module.exports = { isManagedCodexHistoryRoot, filterManagedCodexHistoryCache };
