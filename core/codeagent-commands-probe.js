'use strict';
const fs = require('node:fs');
const path = require('node:path');
const COMMAND_MAX_ITEMS = 200;
const COMMAND_MAX_SCREENS = 40;
const COMMAND_FRAME_WAIT_MS = 3000;
const COMMAND_SLASH_WAIT_MS = 10000;
const COMMAND_LIST_EMPTY_WAIT_MS = 1500;
const COMMAND_POLL_MS = 100;
const COMMAND_LOG_MAX_BYTES = 256 * 1024;
const COMMAND_PROBE_RETRY_MS = 30 * 60 * 1000;
const COMMAND_QUEUE_WAIT_MS = 120000;
const COMMAND_VERSION_WAIT_MS = 8000;
const failedProbes = new Map();
const failureKey = (dataDir, accountKey, version) => JSON.stringify([dataDir, accountKey, version]);
function retryCoolingDown(dataDir, accountKey, version, at) {
  const last = failedProbes.get(failureKey(dataDir, accountKey, version));
  return last !== undefined && at - last < COMMAND_PROBE_RETRY_MS;
}
function retryAt(dataDir, accountKey, version) {
  const last = failedProbes.get(failureKey(dataDir, accountKey, version));
  return last === undefined ? undefined : last + COMMAND_PROBE_RETRY_MS;
}
function rememberProbeResult(dataDir, accountKey, version, result, at) {
  const key = failureKey(dataDir, accountKey, version);
  if (result.ok) failedProbes.delete(key);
  else if (!result.skipped) failedProbes.set(key, at);
}
const ITEM = /^\s*(?:[│┃]\s*)?(?:[❯›▶>]\s*)?\/[\w.:-]+/;

function parseCommandRow(line) {
  const clean = String(line).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s*[│┃]\s*$/, '');
  const match = /^\s*(?:[│┃]\s*)?(?:[❯›▶>]\s*)?\/([\w.:-]+)(?:\s*\(([^)]*)\))?\s+(.*?)(custom-command|command|skill)\s*$/.exec(clean);
  if (!match || /(?:custom-command|command|skill)\s*(?:[❯›▶>]\s*)?\/[\w.:-]+/.test(match[3])) return null;
  const aliases = match[2] ? match[2].split(',').map(value => value.trim().replace(/^\//, '')) : [];
  if (aliases.some(value => !/^[\w.:-]+$/.test(value))) return null;
  return { name: match[1], aliases, description: match[3].trim(), kind: match[4] };
}
let columnWidths;
function mainColumn(line, width) {
  if (!columnWidths) {
    // Reuse the shipped terminal's Unicode widths, including CJK and combining
    // characters, rather than treating UTF-16 offsets as screen columns.
    new (require('@xterm/addon-unicode11').Unicode11Addon)().activate({ unicode: { register: provider => { columnWidths = provider; } } });
  }
  let columns = 0, result = '';
  for (const char of line) {
    const size = columnWidths.wcwidth(char.codePointAt(0));
    if (columns + size > width) break;
    columns += size; result += char;
  }
  return result;
}
function suggestionRegion(lines) {
  const borderAt = lines.findLastIndex(line => /^\s*╭[─━]+╮/.test(line));
  if (borderAt >= 0) {
    const width = lines[borderAt].indexOf('╮') + 1;
    const screen = lines.map(line => mainColumn(line, width));
    const inputAt = screen.findLastIndex(line => /^\s*(?:[│┃]\s*)?[❯›>]\s*\/\s*(?:[│┃])?\s*$/.test(line));
    const region = [];
    if (inputAt > borderAt) for (let i = borderAt - 1; i >= 0; i -= 1) {
      if (!/^\s*(?:[❯›▶>]\s*)?\//.test(screen[i]) || !parseCommandRow(screen[i])) break;
      region.unshift(screen[i]);
    }
    return { lines: region, slashEntered: inputAt > borderAt };
  }
  const inputAt = lines.findLastIndex(line => /^\s*(?:[│┃]\s*)?[❯›>]\s*\/\s*(?:[│┃])?\s*$/.test(line));
  if (inputAt < 0) return { lines: [], slashEntered: false };
  const runs = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i === inputAt || !ITEM.test(lines[i])) continue;
    const last = runs.at(-1);
    if (last && i - last.at(-1) <= 2 && !(last.at(-1) < inputAt && i > inputAt)) last.push(i);
    else runs.push([i]);
  }
  const distance = run => Math.min(...run.map(index => Math.abs(index - inputAt)));
  const run = runs.sort((a, b) => distance(a) - distance(b))[0];
  if (!run || distance(run) > 6) return { lines: [], slashEntered: true };
  return { lines: run.map(index => lines[index]), slashEntered: true };
}
function commandFrame(frame) {
  const region = suggestionRegion(frame.lines);
  const rows = region.lines.map(parseCommandRow);
  return { ...region, commands: rows.filter(Boolean), invalid: rows.filter(row => !row).length,
    signature: JSON.stringify(region.lines.map(line => line.replace(/^\s*(?:[│┃]\s*)?[❯›▶>]\s*(?=\/)/, '').trim())), revision: frame.revision };
}
function cacheFile(dataDir) { return path.join(dataDir, 'codeagent-pool', 'codeagent-commands.json'); }
function readCommandCache(dataDir) {
  try { return JSON.parse(fs.readFileSync(cacheFile(dataDir), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, accounts: {} }; throw error; }
}
function commandsNeedProbe(dataDir, key, version) {
  try {
    const cache = readCommandCache(dataDir), entry = cache.accounts?.[key];
    return cache.version !== 1 || !version || entry?.version !== version || !entry.commands?.length;
  } catch { return true; }
}
function writeCommandCache(dataDir, key, version, commands) {
  const cache = readCommandCache(dataDir);
  if (cache.version !== 1 || !cache.accounts || !key || !version || !commands.length) throw new Error('invalid-command-cache');
  const file = cacheFile(dataDir), tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, accounts: { ...cache.accounts, [key]: { version, commands } } }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function commandDiagnostic(dataDir, reason, lines, { now = Date.now(), maxBytes = COMMAND_LOG_MAX_BYTES, metadata = {} } = {}) {
  if (!dataDir) return;
  try {
    const file = path.join(dataDir, 'logs', 'codeagent-commands-probe.log');
    const region = lines.slice(0, 60);
    const text = JSON.stringify({ at: new Date(now).toISOString(), reason, lineCount: region.length, lines: region, ...metadata }) + '\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(text) > maxBytes) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, text, 'utf8');
  } catch { /* Command diagnostics do not affect the model usage probe. */ }
}
function screenDiagnosticLines(lines, limit = 40) {
  return lines.flatMap(line => require('./ansi-utils').stripAnsi(String(line)).split(/\r?\n/))
    .filter(line => line.trim()).slice(-limit).map(line => line.slice(0, 200));
}
function inputDiagnosticLines(lines) {
  const clean = lines.map(line => require('./ansi-utils').stripAnsi(String(line)));
  const at = clean.findLastIndex(line => /^\s*(?:[│┃]\s*)?[─\s]*[❯›>]/.test(line));
  return at < 0 ? [] : screenDiagnosticLines(clean.slice(at), 10);
}
function createCommandTrace(dataDir, { accountKey, requestId = require('node:crypto').randomBytes(4).toString('hex'), now = Date.now } = {}) {
  return (event, fields = {}) => {
    const safe = { event, requestId, accountKey };
    for (const key of ['hasSessionVersion', 'version', 'pending', 'deduplicated', 'round', 'result', 'commandCount', 'invalidCount', 'fresh', 'state', 'directoryHash', 'hubVersion', 'dataDirOverride', 'key', 'downCount', 'retryAt', 'force']) {
      if (['string', 'number', 'boolean'].includes(typeof fields[key])) safe[key] = fields[key];
    }
    const lines = event === 'screen' ? screenDiagnosticLines(fields.lines || [])
      : event === 'input-before-slash' ? inputDiagnosticLines(fields.lines || []) : [];
    commandDiagnostic(dataDir, String(fields.reason || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120), lines, { now: now(), metadata: safe });
  };
}
function commandStartup(dataDir, { hubVersion, dataDirOverride }) {
  createCommandTrace(dataDir)('startup', { hubVersion, dataDirOverride,
    directoryHash: require('node:crypto').createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 12) });
}
function recoveredCommandState(dataDir, accountKey) {
  for (const suffix of ['', '.1']) {
    let lines;
    try { lines = fs.readFileSync(path.join(dataDir, 'logs', 'codeagent-commands-probe.log' + suffix), 'utf8').slice(-COMMAND_LOG_MAX_BYTES).trim().split('\n'); }
    catch { continue; }
    for (const line of lines.reverse()) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.accountKey !== accountKey || !row.event) continue;
      if (!['failed', 'cache-written', 'cache-current'].includes(row.event)) continue;
      const state = row.state || (['cache-written', 'cache-current'].includes(row.event) ? 'ready' : 'failed');
      return { state, reason: row.reason || (state === 'failed' ? 'unfinished-request' : ''), at: row.at,
        ...(Number.isFinite(row.retryAt) ? { retryAt: row.retryAt } : {}) };
    }
  }
  return { state: 'idle', reason: '', at: null };
}
function waitWithTimeout(promise, ms, reason, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimer(() => reject(Object.assign(new Error(reason), { code: reason })), ms); })])
    .finally(() => clearTimer(timer));
}
function queueCommandsProbe(chain, run, { trace = () => {}, pending = false, timeoutMs = COMMAND_QUEUE_WAIT_MS,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  trace('queued', { pending });
  let expired = false, timer;
  const waiting = new Promise(resolve => { timer = setTimer(() => {
    expired = true; trace('failed', { reason: 'queue-timeout', state: 'failed' }); resolve({ ok: false, reason: 'queue-timeout' });
  }, timeoutMs); });
  const start = async () => {
    if (expired) return { ok: false, reason: 'queue-timeout' };
    clearTimer(timer); trace('probe-start'); return run();
  };
  return Promise.race([chain.then(start, start), waiting]).finally(() => clearTimer(timer));
}

async function collectCommands({ readFrame, write, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
  maxScreens = COMMAND_MAX_SCREENS, maxItems = COMMAND_MAX_ITEMS, frameWaitMs = COMMAND_FRAME_WAIT_MS, exited = () => false, trace = () => {} }) {
  let latest = { lines: [] };
  let reads = 0, firstUnrecognized = false, initialReason = 'unrecognized-list';
  async function stable(after) {
    let previous, emptySince = null, enteredAt = null;
    const deadline = now() + frameWaitMs;
    const slashDeadline = now() + COMMAND_SLASH_WAIT_MS;
    while ((!after || now() < deadline) && !exited()) {
      trace('frame', { round: ++reads, result: 'reading' });
      const raw = await readFrame(), frame = commandFrame(raw);
      if (frame.lines.length) latest = frame;
      const fresh = !after || frame.revision > after.revision;
      const stable = !!(frame.commands.length && fresh && previous?.signature === frame.signature);
      trace('frame', { round: reads, result: stable ? 'stable' : frame.commands.length ? 'parsed' : frame.slashEntered ? 'unrecognized' : 'waiting-slash', commandCount: frame.commands.length, invalidCount: frame.invalid, fresh });
      if (!frame.commands.length && !firstUnrecognized) {
        firstUnrecognized = true; trace('screen', { result: 'first-unrecognized', round: reads, lines: raw.diagnosticLines || raw.lines });
      }
      if (stable) return frame;
      if (!after) {
        if (frame.slashEntered) {
          enteredAt ??= now();
          emptySince = frame.commands.length ? null : emptySince ?? now();
          if (emptySince !== null && now() - emptySince >= COMMAND_LIST_EMPTY_WAIT_MS) return null;
          if (frame.commands.length && now() - enteredAt >= frameWaitMs) { initialReason = 'unstable-list'; return null; }
        } else {
          emptySince = null;
          if (now() >= slashDeadline) { initialReason = 'slash-not-visible'; return null; }
        }
      }
      previous = fresh ? frame : null;
      await sleep(COMMAND_POLL_MS);
    }
    return null;
  }
  const commands = new Map();
  let frame = await stable(), steps = 0, unchanged = 0, moved = false;
  if (!frame) return { ok: false, reason: initialReason, lines: latest.lines };
  const first = frame.signature, firstName = frame.commands[0].name, pageSize = frame.commands.length;
  while (frame) {
    if (frame.invalid) return { ok: false, reason: 'invalid-rows', lines: frame.lines };
    for (const command of frame.commands) commands.set(command.name.toLowerCase(), command);
    // Down moves one item. Bound work to forty screenfuls of keys, rather than
    // treating each highlight-only move inside the same viewport as a page.
    if (commands.size >= maxItems || steps >= maxScreens * pageSize) return { ok: false, reason: 'limit', lines: frame.lines };
    write('\x1b[B'); steps += 1;
    const next = await stable(frame);
    if (!next) return { ok: false, reason: 'unconfirmed-navigation', lines: latest.lines };
    if (next.signature === frame.signature) unchanged += 1;
    else { unchanged = 0; moved = true; }
    if (unchanged > pageSize + 2 || moved && next.signature !== frame.signature && (next.signature === first || next.commands[0].name === firstName)) {
      if (next.invalid) return { ok: false, reason: 'invalid-rows', lines: next.lines };
      return { ok: true, commands: [...commands.values()], lines: next.lines };
    }
    frame = next;
  }
  return { ok: false, reason: 'unrecognized-list', lines: latest.lines };
}

// This is called only by the hidden /model probe, never a user's session PTY.
async function probeCommands({ dataDir, accountKey, version, readFrame, write,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, exited = () => false,
  trace = createCommandTrace(dataDir, { accountKey, now }), cancelled = () => false, force = false, ...limits }) {
  if (!force && retryCoolingDown(dataDir, accountKey, version, now())) { trace('cooldown-skip'); return { ok: false, skipped: true, reason: 'failure-cooldown' }; }
  if (!accountKey || !version) { commandDiagnostic(dataDir, 'version-unavailable', []); return { ok: false, reason: 'version-unavailable' }; }
  if (!commandsNeedProbe(dataDir, accountKey, version)) { trace('cache-current', { state: 'ready' }); return { ok: true, skipped: true }; }
  let result = { ok: false, reason: 'probe-error', lines: [] }, typed = false, latest = null, inputLines = [], downCount = 0, finalLogged = false;
  function finalScreen() {
    if (finalLogged) return;
    finalLogged = true;
    trace('screen', { result: 'final', reason: result.reason, lines: latest ?? inputLines, downCount });
  }
  async function empty() {
    const deadline = now() + COMMAND_FRAME_WAIT_MS;
    while (now() < deadline && !exited()) {
      const frame = await readFrame(); inputLines = frame.diagnosticLines || frame.lines;
      if (require('./codeagent-input-guard').inputSnapshot(frame.lines).state === 'empty') return true;
      await sleep(COMMAND_POLL_MS);
    }
    return false;
  }
  try {
    if (!await empty()) result.reason = 'input-not-empty';
    else {
      trace('input-before-slash', { lines: inputLines, state: 'empty' });
      typed = true; write('/'); trace('slash-typed', { key: '/', downCount });
      result = await collectCommands({ readFrame: async () => {
        const frame = await readFrame(); latest = frame.diagnosticLines || frame.lines; return frame;
      }, write: key => {
        write(key);
        if (key === '\x1b[B') trace('key', { key: '↓', downCount: ++downCount });
      }, sleep, now, exited, trace, ...limits });
    }
  } catch { result = { ok: false, reason: 'probe-error', lines: latest }; }
  finally {
    if (typed) {
      // Preserve the failed screen before Ctrl+U removes the suggestion menu.
      if (!result.ok) finalScreen();
      try { write('\x15'); if (!await empty()) result = { ...result, ok: false, reason: 'input-not-cleared' }; }
      catch { result = { ...result, ok: false, reason: 'input-not-cleared' }; }
    }
  }
  if (cancelled()) result = { ...result, ok: false, reason: 'timeout' };
  if (result.ok) {
    try { writeCommandCache(dataDir, accountKey, version, result.commands); trace('cache-written', { commandCount: result.commands.length, state: 'ready' }); }
    catch { result = { ...result, ok: false, reason: 'cache-write-failed' }; }
  }
  if (!result.ok) { finalScreen(); trace('failed', { reason: result.reason, state: 'failed', downCount }); }
  rememberProbeResult(dataDir, accountKey, version, result, now());
  return result;
}

function createCommandsProbeScheduler({ dataDir, getVersion, probe, now = Date.now, onResult = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const pending = new Map(), states = new Map();
  return {
    state(session) {
      const key = session.codeagentPoolAccount || 'personal';
      if (!states.has(key)) states.set(key, recoveredCommandState(dataDir, key));
      return { ...states.get(key) };
    },
    request(session, { force = false } = {}) {
      const accountKey = session.codeagentPoolAccount || 'personal';
      if (pending.has(accountKey)) { pending.get(accountKey).trace('requested', { hasSessionVersion: !!session.codeagentVersion, deduplicated: true }); return pending.get(accountKey).task; }
      const previous = this.state(session), trace = createCommandTrace(dataDir, { accountKey, now });
      trace('requested', { hasSessionVersion: !!session.codeagentVersion, force });
      states.set(accountKey, { state: 'reading', reason: '', at: now() });
      const run = async () => {
        let version = '', result;
        try {
          trace('version-start');
          try {
            version = session.codeagentVersion || await waitWithTimeout(Promise.resolve().then(() => getVersion(session)), COMMAND_VERSION_WAIT_MS, 'version-timeout', { setTimer, clearTimer }) || '';
            if (!version) throw Object.assign(new Error('version-unavailable'), { code: 'version-unavailable' });
            trace('version-done', { version });
          } catch (error) { trace('version-failed', { reason: error.code === 'version-timeout' ? error.code : 'version-unavailable' }); throw error; }
          if (!force && retryCoolingDown(dataDir, accountKey, version, now())) { trace('cooldown-skip', { retryAt: retryAt(dataDir, accountKey, version) }); result = { ok: false, skipped: true, reason: 'failure-cooldown' }; }
          else if (!commandsNeedProbe(dataDir, accountKey, version)) { trace('cache-current', { state: 'ready' }); result = { ok: true, skipped: true, reason: 'cache-current' }; }
          else {
            result = await probe(session, version, { trace, force });
            if (!result.ok) {
              commandDiagnostic(dataDir, result.reason || 'probe-failed', []);
            }
          }
        } catch (error) {
          result = { ok: false, reason: error.code === 'version-timeout' ? 'version-timeout' : !version ? 'version-unavailable' : 'probe-unavailable' }; commandDiagnostic(dataDir, result.reason, []);
        }
        rememberProbeResult(dataDir, accountKey, version, result, now());
        const reason = result.reason === 'failure-cooldown' && previous.state === 'failed' ? previous.reason : result.reason || '';
        const nextRetryAt = retryAt(dataDir, accountKey, version);
        states.set(accountKey, { state: result.ok ? 'ready' : 'failed', reason, at: now(),
          ...(nextRetryAt === undefined ? {} : { retryAt: nextRetryAt }) });
        if (!result.ok) trace('failed', { reason, state: 'failed', retryAt: nextRetryAt });
        onResult({ accountKey, version, ...result });
        return result;
      };
      const task = run().finally(() => pending.delete(accountKey));
      pending.set(accountKey, { task, trace }); return task;
    },
  };
}

module.exports = { parseCommandRow, suggestionRegion, commandFrame, commandsNeedProbe, writeCommandCache, commandDiagnostic,
  createCommandTrace, commandStartup, recoveredCommandState, queueCommandsProbe, collectCommands, probeCommands, createCommandsProbeScheduler,
  COMMAND_QUEUE_WAIT_MS, COMMAND_VERSION_WAIT_MS, COMMAND_PROBE_RETRY_MS, COMMAND_MAX_ITEMS, COMMAND_MAX_SCREENS, COMMAND_FRAME_WAIT_MS, COMMAND_SLASH_WAIT_MS, COMMAND_LIST_EMPTY_WAIT_MS, COMMAND_LOG_MAX_BYTES };
