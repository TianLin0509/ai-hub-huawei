'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MESSAGE_ROUND_LOG_MAX_BYTES = 256 * 1024;
const PHASES = ['changed', 'pinnedTop', 'ordinaryTop', 'rotation', 'retry', 'full'];
const REASONS = ['due', 'pending', 'no-order', 'owner-mismatch', 'identity-missing', 'manual', 'not-due', 'query'];

// Only explicit counters enter this log: never IDs, names, error text or bodies.
function recordMessageRound(dataDir, round, maxBytes = MESSAGE_ROUND_LOG_MAX_BYTES) {
  const count = value => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const row = {
    startedAt: new Date(round.startedAt).toISOString(), endedAt: new Date(round.endedAt).toISOString(),
    durationMs: count(round.endedAt - round.startedAt),
    trigger: ['timer', 'manual', 'query'].includes(round.trigger) ? round.trigger : 'timer',
    mode: round.mode === 'full-check' ? 'full-check' : 'incremental',
    fullCheckReason: REASONS.includes(round.fullCheckReason) ? round.fullCheckReason : 'not-due',
    changedCount: count(round.changedCount), pinnedHead: count(round.pinnedHead),
    identityMissing: !!round.identityMissing, cacheReused: !!round.cacheReused, identityClaimed: !!round.identityClaimed,
    requests: Object.fromEntries(PHASES.map(key => [key, count(round.requests?.[key])])),
    failed: count(round.failed), rateLimited: !!round.rateLimited, timedOut: !!round.timedOut,
  };
  try {
    const file = path.join(dataDir, 'logs', 'company-assistant-message-round.log');
    const text = JSON.stringify(row) + '\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(text) > maxBytes) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, text, 'utf8');
  } catch { /* Diagnostics cannot interrupt collection. */ }
}

module.exports = { recordMessageRound, MESSAGE_ROUND_LOG_MAX_BYTES };
