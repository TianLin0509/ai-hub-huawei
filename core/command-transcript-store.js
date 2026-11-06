'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getHubDataDir } = require('./data-dir');
const CODEAGENT_COMMAND_CLOCK_SKEW_MS = 5000;

// User input belongs in history even when the provider executes it locally and
// never creates a model turn. This journal is presentation, never runtime truth.
class CommandTranscriptStore {
  constructor(root = getHubDataDir()) {
    fs.mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'command-transcript.sqlite'));
    try {
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS commands (
        session_id TEXT NOT NULL, submission_id TEXT NOT NULL, text TEXT NOT NULL,
        ts INTEGER NOT NULL, result TEXT, PRIMARY KEY(session_id, submission_id))`);
    } catch (error) { this.db.close(); throw error; }
  }
  begin(sessionId, id, text) {
    const old = this.db.prepare('SELECT text,result FROM commands WHERE session_id=? AND submission_id=?').get(sessionId, id);
    if (old) {
      if (old.text !== text) throw new Error('命令提交 ID 已用于其他正文');
      return { duplicate: true, result: old.result ? JSON.parse(old.result) : null };
    }
    this.db.prepare('INSERT INTO commands VALUES (?,?,?,?,NULL)').run(sessionId, id, text, Date.now());
    return { duplicate: false };
  }
  finish(sessionId, id, result) {
    this.db.prepare('UPDATE commands SET result=? WHERE session_id=? AND submission_id=?')
      .run(JSON.stringify(result), sessionId, id);
  }
  read(sessionId) {
    return this.db.prepare('SELECT submission_id,text,ts,result FROM commands WHERE session_id=? ORDER BY ts,rowid').all(sessionId)
      .map(row => ({ id: 'command:' + row.submission_id, role: 'user', text: row.text,
        ts: row.ts, source: 'hub-command', clientSubmissionId: row.submission_id,
        commandResult: row.result ? JSON.parse(row.result) : null }));
  }
  close() { this.db.close(); }
}
const stores = new Map();
function commandTranscriptStore() {
  const root = getHubDataDir();
  if (!stores.has(root)) stores.set(root, new CommandTranscriptStore(root));
  return stores.get(root);
}
function commandName(text) {
  const raw = String(text || '');
  const restored = require('./synthetic-user-filter').skillCommandText(raw) ?? raw;
  return restored.trimStart().match(/^\/\S+/)?.[0].toLowerCase() || '';
}
function pairCodeAgentCommands(turns, commands, opts) {
  const pairs = new Map();
  const identified = new Set(turns.filter(turn => turn.role === 'user' && turn.clientSubmissionId).map(turn => turn.clientSubmissionId));
  const candidates = turns.filter(turn => turn.role === 'user' && !turn.clientSubmissionId && Number.isFinite(turn.ts));
  const eligible = commands.filter(command => {
    const result = command.commandResult;
    // stuck/unconfirmed are uncertain submissions, not proof of non-delivery.
    const failed = result?.notSent === true || (result?.ok === false && !result.unconfirmed && result.sendStatus !== 'stuck');
    return commandName(command.text) && Number.isFinite(command.ts) && !identified.has(command.clientSubmissionId) && !failed;
  });
  if (opts.fromTail !== false && !opts.offset) {
    // The provider is already tail-limited. Align each command's visible echoes
    // with the latest journal sends, never with the beginning of its history.
    const groups = new Map();
    for (const echo of candidates) {
      const name = commandName(echo.text);
      if (!name) continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(echo);
    }
    for (const [name, echoes] of groups) {
      const recent = eligible.filter(command => commandName(command.text) === name).slice(-echoes.length);
      recent.forEach((command, index) => {
        if (echoes[index].ts >= command.ts - CODEAGENT_COMMAND_CLOCK_SKEW_MS) pairs.set(command, echoes[index]);
      });
    }
    return pairs;
  }
  // Forward/offset pages cannot safely align a full journal with a partial
  // provider prefix. Only use FIFO when the normal parse proved it complete.
  if (!opts.codeagentComplete) return pairs;
  let nextCli = 0;
  for (const command of eligible) {
    const name = commandName(command.text);
    for (let index = nextCli; index < candidates.length; index += 1) {
      const echo = candidates[index];
      if (echo.ts < command.ts - CODEAGENT_COMMAND_CLOCK_SKEW_MS || commandName(echo.text) !== name) continue;
      pairs.set(command, echo); nextCli = index + 1; break;
    }
  }
  return pairs;
}
function mergeCommandTurns(turns, commands, opts = {}) {
  // Correlate by submission identity, never collapse repeated identical commands.
  const ids = new Set(commands.map(c => c.clientSubmissionId));
  const pairs = opts.codeagent === true ? pairCodeAgentCommands(turns, commands, opts) : new Map();
  const echoes = new Set(pairs.values());
  const unmatched = [...commands];
  const kept = turns.filter(turn => {
    if (turn.role !== 'user') return true;
    if (ids.has(turn.clientSubmissionId)) return false;
    if (echoes.has(turn)) return false;
    // CodeAgent slash echoes use only the FIFO pairing above, never a second matcher.
    if (opts.codeagent === true && commandName(turn.text)) return true;
    // Legacy PTY transcripts have no submission IDs. Match each echo once by
    // exact text and nearby provider timestamp; repeated inputs remain separate.
    if (!turn.clientSubmissionId && turn.ts) {
      const index = unmatched.findIndex(c => c.text.trim() === String(turn.text || '').trim()
        && Math.abs(c.ts - turn.ts) < 30000);
      if (index >= 0) { unmatched.splice(index, 1); return false; }
    }
    return true;
  });
  const order = new Map(turns.map((turn, index) => [turn, index]));
  const projected = commands.map((command, index) => {
    const echo = pairs.get(command);
    const turn = echo ? { ...command, ts: echo.ts, nativeUserRecordId: echo.nativeUserRecordId || echo.id,
      ...(echo.queuedSupplement ? { queuedSupplement: true } : {}),
      ...(echo.codeagentCommand ? { codeagentCommand: echo.codeagentCommand } : {}) } : command;
    order.set(turn, echo ? order.get(echo) : turns.length + index);
    return turn;
  });
  const merged = [...kept, ...projected]
    .sort((a, b) => (a.ts || 0) - (b.ts || 0) || (pairs.size ? order.get(a) - order.get(b) : 0));
  const limit = opts.limit === undefined ? 50 : opts.limit;
  return Number.isFinite(limit) && limit >= 0
    ? (opts.fromTail === false ? merged.slice(0, limit) : limit === 0 ? [] : merged.slice(-limit)) : merged;
}
module.exports = { CommandTranscriptStore, commandTranscriptStore, mergeCommandTurns };
