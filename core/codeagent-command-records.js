'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { skillCommandText, textFromContent } = require('./synthetic-user-filter');
const CODEAGENT_BUILTIN_COMMANDS = ['clear', 'new', 'compact', 'model', 'model-config', 'config', 'help', 'cd',
  'add-dir', 'mcp', 'memory', 'sessions', 'resume', 'continue', 'skills', 'cost', 'context', 'status'];
const COMMAND_RECORD_LOG_MAX_BYTES = 256 * 1024;
const IDENTITY_SWITCH_WINDOW_MS = 30000;
const logged = new Set(), switches = new WeakMap();

function commandName(text) {
  return /^(?:\/)([\w:-]+)(?:\s|$)/.exec((skillCommandText(text) ?? String(text || '')).trim())?.[1]?.toLowerCase() || '';
}

function commandNames(dataDir, account = 'personal') {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'codeagent-pool', 'codeagent-commands.json'), 'utf8'));
    const commands = cache.version === 1 && cache.accounts?.[account]?.commands;
    if (Array.isArray(commands)) return commands.filter(row => row.kind === 'command')
      .flatMap(row => [row.name, ...(row.aliases || [])]).map(name => String(name).replace(/^\//, '').toLowerCase());
  } catch { /* Older installations have no per-account command cache yet. */ }
  return CODEAGENT_BUILTIN_COMMANDS;
}

// Remove built-ins before either parser groups human turns. Keep their identity
// until the journal has been paired; filtering before that would shift echoes.
function extractCommandRecords(entries, opts = {}) {
  if (!opts.codeagent) return { entries, commands: [] };
  const names = new Set(opts.codeagentCommandNames || CODEAGENT_BUILTIN_COMMANDS);
  const kept = [], commands = [];
  let firstUser = !opts.codeagentPartial;
  for (const entry of entries) {
    const user = entry?.type === 'user' && !entry.isSidechain
      && !entry.message?.content?.some?.(block => block?.type === 'tool_result');
    if (!user) { kept.push(entry); continue; }
    const text = typeof entry.message?.content === 'string' ? entry.message.content : textFromContent(entry.message?.content);
    const name = commandName(text), firstUserInFile = firstUser;
    firstUser = false;
    if (!names.has(name)) { kept.push(entry); continue; }
    if (opts.excludeEntryIds?.includes(entry.uuid) || opts.excludeMessageIds?.includes(entry.message?.id)) continue;
    commands.push({ id: entry.uuid || 'command-' + entry.timestamp, role: 'user', text: skillCommandText(text) ?? text,
      ts: Date.parse(entry.timestamp || '') || 0,
      codeagentCommand: { name, recordId: entry.uuid, firstUserInFile, file: path.basename(opts.codeagentFile || '').slice(0, 8) } });
  }
  return { entries: kept, commands };
}

function appendCommandRecords(turns, commands) {
  return commands.length ? [...turns, ...commands].sort((a, b) => (a.ts || 0) - (b.ts || 0)) : turns;
}

function observeIdentitySwitches(manager) {
  if (!manager || switches.has(manager)) return;
  const events = new Map(); switches.set(manager, events);
  manager.on?.('claude-identity-switched', event => {
    if (event?.source !== 'clear' || !event.sessionId) return;
    const rows = events.get(event.sessionId) || [];
    rows.push({ at: Number(event.at) || Date.now(), to: event.to });
    events.set(event.sessionId, rows.slice(-20));
    if (events.size > 1000) events.delete(events.keys().next().value);
  });
}

function logCommand(record, { dataDir, sessionId, action, identitySwitch, now = Date.now(), maxBytes = COMMAND_RECORD_LOG_MAX_BYTES }) {
  const key = JSON.stringify([dataDir, sessionId, record.codeagentCommand?.recordId || record.id, record.codeagentCommand?.file]);
  if (logged.has(key)) return;
  try {
    const row = { at: new Date(now).toISOString(), sessionId: String(sessionId || '').slice(0, 8),
      command: record.codeagentCommand.name, action, firstUserInFile: record.codeagentCommand.firstUserInFile === true,
      identitySwitch, file: String(record.codeagentCommand.file || '').slice(0, 8) };
    const file = path.join(dataDir, 'logs', 'codeagent-command-records.log'), text = JSON.stringify(row) + '\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(text) > maxBytes) {
      fs.rmSync(file + '.1', { force: true }); fs.renameSync(file, file + '.1');
    }
    fs.appendFileSync(file, text);
    logged.add(key); if (logged.size > 4000) logged.delete(logged.values().next().value);
  } catch { /* Displaying history cannot depend on diagnostic storage. */ }
}

function projectCommandRecords(turns, { names = CODEAGENT_BUILTIN_COMMANDS, manager, sessionId, transcriptPath, dataDir, now, maxBytes, submissionIds } = {}) {
  const builtins = new Set(names), events = switches.get(manager)?.get(sessionId) || [];
  return turns.flatMap(turn => {
    const name = turn.codeagentCommand?.name || (turn.source === 'hub-command' ? commandName(turn.text) : '');
    if (turn.role !== 'user' || !builtins.has(name)) return [turn];
    if (turn.clientSubmissionId) submissionIds?.push(turn.clientSubmissionId);
    const record = { ...turn, codeagentCommand: turn.codeagentCommand || { name, firstUserInFile: false,
      file: path.basename(transcriptPath || '').slice(0, 8) } };
    const identitySwitch = events.some(event => Math.abs(event.at - turn.ts) <= IDENTITY_SWITCH_WINDOW_MS
      && (!event.to || path.basename(transcriptPath || '', '.jsonl') === event.to));
    const sent = turn.commandResult?.ok !== false && !turn.commandResult?.notSent;
    const divider = sent && (name === 'compact' || (['clear', 'new'].includes(name)
      && (record.codeagentCommand.firstUserInFile || identitySwitch)));
    if (dataDir) logCommand(record, { dataDir, sessionId, identitySwitch, action: divider ? 'divider' : 'hidden', now, maxBytes });
    return divider ? [{ id: turn.id, role: 'divider', command: name, ts: turn.ts, clientSubmissionId: turn.clientSubmissionId,
      text: name === 'compact' ? '上下文已压缩' : '已开始新对话，之前的上下文已清空' }] : [];
  });
}

module.exports = { CODEAGENT_BUILTIN_COMMANDS, commandNames, extractCommandRecords, appendCommandRecords,
  observeIdentitySwitches, projectCommandRecords, COMMAND_RECORD_LOG_MAX_BYTES };
