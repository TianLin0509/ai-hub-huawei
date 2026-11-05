'use strict';

const fs = require('node:fs');
const path = require('node:path');
const CODEAGENT_STOP_LOG_MAX_BYTES = 256 * 1024;
const STATES = new Set(['running', 'starting', 'waiting', 'completed', 'idle', 'failed', 'dormant', 'unknown', 'interrupted']);
const EVENTS = new Set(['requested', 'rejected', 'esc-first', 'esc-second', 'menu', 'input', 'runtime', 'finished', 'failed']);

// Explicit fields only: callers must never accidentally log editor text or errors.
function recordCodeAgentStop(record, { dataDir = require('./data-dir').getHubDataDir(), maxBytes = CODEAGENT_STOP_LOG_MAX_BYTES } = {}) {
  try {
    const row = { at: record.at, sessionId: String(record.sessionId || '').slice(0, 8), stopId: record.stopId,
      event: EVENTS.has(record.event) ? record.event : 'failed' };
    for (const key of ['rendererState', 'mainState']) if (STATES.has(record[key])) row[key] = record[key];
    if (['existing', 'created', 'direct', 'external'].includes(record.branch)) row.branch = record.branch;
    if (['empty', 'nonempty', 'unknown'].includes(record.inputState)) row.inputState = record.inputState;
    if (['running', 'idle', 'unknown'].includes(record.preRunning)) row.preRunning = record.preRunning;
    if (['screen-running', 'screen-idle', 'runtime-fallback'].includes(record.decision)) row.decision = record.decision;
    if ([0, 1, 2].includes(record.escSent)) row.escSent = record.escSent;
    if (typeof record.rewindMenuClosed === 'boolean') row.rewindMenuClosed = record.rewindMenuClosed;
    for (const key of ['queuePending', 'runtimeBecameNonRunning', 'runtimeKnown']) if (typeof record[key] === 'boolean') row[key] = record[key];
    if (Number.isFinite(record.queueWaitMs)) row.queueWaitMs = Math.max(0, record.queueWaitMs);
    const file = path.join(dataDir, 'logs', 'codeagent-stop.log'), text = JSON.stringify(row) + '\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(text) > maxBytes) {
      fs.rmSync(file + '.1', { force: true });
      fs.renameSync(file, file + '.1');
    }
    fs.appendFileSync(file, text);
  } catch { /* Diagnostics cannot prevent an interrupt. */ }
}

module.exports = { recordCodeAgentStop, CODEAGENT_STOP_LOG_MAX_BYTES };
