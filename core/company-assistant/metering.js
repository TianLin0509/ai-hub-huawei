'use strict';
// 读取卡顿判定：250ms 在构建机满载时误报过（2026-11-09 CI 42652128569），放到 2 秒。
const STALL_MS = 2000;

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { ClaudeUsageLedger } = require('../session-token-usage');
const { parseCodeAgentContext, parseCodeAgentCredit } = require('../codeagent-screen-stats');
const { countCompactHints } = require('../../main/soft-compact-controller');
const { dayKey } = require('./data');

// Only numeric usage and response IDs are retained in memory; never persist transcript rows.
async function readLedger(file, size, previous = null) {
  const ledger = new ClaudeUsageLedger();
  if (previous) {
    ledger.messages = new Map(previous.ledger.messages);
    ledger.sums = { ...previous.ledger.sums };
    ledger.partial = previous.ledger.partial;
  }
  let compact = previous?.compact || 0;
  let model = previous?.model || null;
  let offset = previous?.offset || 0;
  if (!file) throw new Error('transcript-unavailable');
  if (size <= offset) return { ledger, compact, model, offset };
  const stream = fs.createReadStream(file, { start: offset, end: size - 1, highWaterMark: 64 * 1024 });
  // Limit stalled I/O, not total history length. Parsing yields between batches.
  let timeout;
  const arm = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => stream.destroy(new Error('transcript-read-timeout')), STALL_MS);
  };
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const accept = (line, complete = true) => {
    if (!line.trim()) return;
    try {
      const row = JSON.parse(line);
      if (complete && row.type === 'system' && row.subtype === 'compact_boundary') compact++;
      if (row.type === 'assistant' && !row.isSidechain && !row.message?.usage) ledger.partial = true;
      if (ledger.accept(row) && typeof row.message.model === 'string') model = row.message.model;
    } catch { ledger.partial = true; }
  };
  arm();
  try {
    for await (const chunk of stream) {
      clearTimeout(timeout);
      pending += decoder.write(chunk);
      let end, count = 0;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        offset += Buffer.byteLength(line);
        accept(line);
        if (++count % 128 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      await new Promise(resolve => setImmediate(resolve));
      arm();
    }
    pending += decoder.end();
    // An unfinished final row is replayed on the next read. Valid final rows
    // may already carry usage; the message ledger prevents counting them twice.
    if (pending.trim()) {
      try { JSON.parse(pending); accept(pending, false); } catch { /* Still being written. */ }
    }
    return { ledger, compact, model, offset };
  } catch (error) {
    throw new Error(error.message === 'transcript-read-timeout' ? error.message : 'transcript-read-failed');
  } finally { clearTimeout(timeout); stream.destroy(); }
}

function usageDelta(before, after) {
  if (!before || !after) return { value: null, reason: 'transcript-unavailable' };
  if (before.ledger.partial || after.ledger.partial) return { value: null, reason: 'usage-partial' };
  for (const id of before.ledger.messages.keys()) {
    if (!after.ledger.messages.has(id)) return { value: null, reason: 'usage-reset' };
  }
  const sums = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
  let responses = 0, zero = false;
  for (const [id, row] of after.ledger.messages) {
    const old = before.ledger.messages.get(id);
    if (old && JSON.stringify(old) === JSON.stringify(row)) continue;
    responses++;
    if (Object.values(row).every(n => n === 0)) zero = true;
    sums.input += row.fresh + row.cached + row.cacheWrite - (old ? old.fresh + old.cached + old.cacheWrite : 0);
    for (const k of ['output', 'cached', 'cacheWrite']) sums[k] += row[k] - (old?.[k] || 0);
  }
  if (zero || (responses && Object.values(sums).every(n => n === 0))) return { value: null, reason: 'usage-zero' };
  if (!responses) return { value: null, reason: 'usage-unavailable' };
  if (Object.values(sums).some(n => n < 0)) return { value: null, reason: 'usage-reset' };
  return { value: { ...sums, total: sums.input + sums.output }, reason: null };
}

function creditDelta(before, after) {
  if (!before || !after) return { value: null, reason: 'stats-unavailable' };
  if (before.bucket !== after.bucket || before.total !== after.total) return { value: null, reason: 'credit-tier-changed' };
  if (before.bucket === '当前额度') return { value: null, reason: 'credit-tier-unknown' };
  if (after.remaining > before.remaining) return { value: null, reason: 'credit-reset' };
  return { value: Math.round((before.remaining - after.remaining) * 1000) / 1000, reason: null };
}

class TaskMetering {
  constructor(dir, deps, now = Date.now) { this.dir = dir; this.deps = deps; this.now = now; this.transcripts = new Map(); }
  warn() { console.warn('[company-assistant] metering failed'); }
  snapshot(id) {
    // Capture file boundary synchronously, before the queue can submit the next task.
    let meta, identity = null, empty = false, error = null, size = 0, file = null;
    try {
      meta = id && (this.deps.getSession(id) || this.deps.getSessionMetadata?.(id));
      file = meta?.transcriptPath || null;
      if (file) {
        const stat = fs.statSync(file);
        size = stat.size;
        identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      } else empty = true;
    } catch (err) {
      empty = err.code === 'ENOENT';
      error = empty ? null : 'transcript-read-failed';
      file = null;
    }
    const cached = file && this.transcripts.get(file);
    const reading = Promise.resolve(cached?.reading).then(previous => {
      if (!file) return null;
      const seed = cached?.identity === identity && cached.size <= size ? previous : null;
      return readLedger(file, size, seed);
    });
    // Keep failures handled immediately, even when a task finishes later.
    const safeReading = reading.catch(err => { error = err.message; return null; });
    if (file) { this.transcripts.delete(file); this.transcripts.set(file, { identity, size, reading: safeReading }); }
    // 5.5.11 起每问一个新会话：只留最近 50 份记录的读数缓存，免得长期运行越攒越多。
    while (this.transcripts.size > 50) this.transcripts.delete(this.transcripts.keys().next().value);
    let screen = null;
    try { if (id) screen = this.deps.readTerminalScreen?.(id); } catch { /* Optional stats must not affect usage. */ }
    const model = typeof meta?.currentModel === 'string' ? meta.currentModel : meta?.currentModel?.id || null;
    return Promise.all([
      safeReading,
      Promise.resolve().then(async () => {
        if (!screen) return null;
        return require('../hub-phone/session-chat').renderRows(screen);
      }).catch(() => null),
    ]).then(([usage, rows]) => ({ file, identity, size, empty, error, usage, model: usage?.model || model, context: parseCodeAgentContext(rows), credit: parseCodeAgentCredit(rows), hints: rows ? countCompactHints(rows) : null }));
  }
  begin(job) {
    try { job.meterStart ??= this.now(); job.meterBefore = this.snapshot(job.sessionId); } catch { this.warn(); }
  }
  finish(job, result) {
    if (job.meterFinished) return;
    job.meterFinished = true;
    const endedAt = this.now();
    try {
      const after = this.snapshot(job.sessionId);
      return Promise.all([job.meterBefore || null, after]).then(async ([b, a]) => {
        const sameFile = b?.file && b.file === a.file && b.identity === a.identity && b.size <= a.size;
        const baseline = b?.empty ? { ledger: new ClaudeUsageLedger(), compact: 0 } : b?.usage;
        const comparable = (sameFile || b?.empty) && a.file && baseline && a.usage;
        const tokens = b?.error || a.error
          ? { value: null, reason: b?.error || a.error }
          : comparable ? usageDelta(baseline, a.usage) : { value: null, reason: 'transcript-unavailable' };
        const credit = creditDelta(b?.credit, a.credit);
        const compressed = comparable ? (a.usage.compact > baseline.compact ? true : baseline.ledger.partial || a.usage.ledger.partial ? null : false) : null;
        const compacted = job.meterCompacted || compressed === true || (b?.hints != null && a.hints > b.hints) ? true : compressed;
        const record = { version: 1, taskId: job.id, type: job.type, sessionId: job.sessionId || null,
          startedAt: job.meterStart || endedAt, endedAt, result, model: a.model || b?.model || null,
          contextBefore: b?.context || null, contextAfter: a.context, tokens: tokens.value,
          creditBefore: b?.credit || null, creditAfter: a.credit, creditDelta: credit.value,
          compacted, reasons: { tokens: tokens.reason, credit: credit.reason,
            contextBefore: b?.context ? null : 'stats-unavailable', contextAfter: a.context ? null : 'stats-unavailable',
            model: a.model || b?.model ? null : 'model-unavailable', compacted: compacted == null ? 'compression-unavailable' : null } };
        await fs.promises.mkdir(this.dir, { recursive: true });
        await fs.promises.appendFile(path.join(this.dir, `metering-${dayKey(endedAt)}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
        await cleanup(this.dir, endedAt);
      }).catch(() => this.warn());
    } catch { this.warn(); }
  }
}

async function cleanup(dir, now) {
  const cutoff = dayKey(now - 13 * 86400000);
  for (const name of await fs.promises.readdir(dir)) {
    const m = /^metering-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (m && m[1] < cutoff) await fs.promises.unlink(path.join(dir, name));
  }
}

module.exports = { TaskMetering, usageDelta, creditDelta, readLedger, cleanup };
