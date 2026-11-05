'use strict';

// Claude transcript JSONL → 原生卡片同一套投影。
//
// PTY 跑的 Claude 不经过 stream-json，但它落盘的每一行和 stream-json 的
// assistant / user 帧几乎同形。把磁盘条目按「一次用户提问」分组成
// claude-native-transcript 的 record，交给同一个 claudeTranscriptTurns()，
// PTY 会话的卡片就与原生会话逐项一致：过程/结果分段、工具状态与耗时、
// 模型与用量、后台任务续写、中断与失败的结局。
//
// 结局只从记录本身判断，不猜：
//   end_turn 且带正文的 assistant 帧 → completed
//   "[Request interrupted by user…" → interrupted
//   API 错误条目（isApiErrorMessage）→ failed
//   后面已有新的提问、自己却没有终态 → completed（历史，已经不在跑）
//   最后一组没有终态 → 仍在运行，工具显示 running

const fs = require('node:fs');
const { isSyntheticUserEntry, skillCommandText } = require('./synthetic-user-filter.js');
const { withQueuedHumanInputs, queuedHumanEntry } = require('./claude-queued-input');
const { claudeTranscriptTurns } = require('./claude-native-transcript.js');
const { isToolResultEntry, claudeAssistantContentHasAnswerText, isClaudeTurnStopReasonTerminal } = require('./claude-transcript-parser.js');

const TAIL_WINDOW_BYTES = 8 * 1024 * 1024;

function toMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function userText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

function isTaskNotification(entry, text) {
  return entry.origin?.kind === 'task-notification' || String(text || '').trimStart().startsWith('<task-notification>');
}

function isInterruptMarker(text) {
  return String(text || '').trimStart().startsWith('[Request interrupted by user');
}

function assistantText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter(block => block && block.type === 'text').map(block => block.text || '').join('\n\n');
}

function newRecord(entry, text, nativeActivity, origin = null) {
  const at = toMs(entry.timestamp) || 0;
  const content = Array.isArray(entry.message?.content) ? entry.message.content : [{ type: 'text', text }];
  return {
    userMessageId: entry.uuid,
    submissionId: null,
    text,
    content,
    createdAt: at,
    completedAt: null,
    status: 'running',
    finalText: '',
    messages: new Map(),
    streams: new Map(),
    nativeActivity,
    origin: origin || (nativeActivity ? { kind: 'task-notification' } : null),
    lastAt: at,
  };
}

function settle(record, status) {
  if (record.status !== 'running') return;
  record.status = status;
  record.completedAt = record.lastAt || record.createdAt;
}

function claudeDiskRecords(entries, opts = {}) {
  const extracted = require('./codeagent-command-records').extractCommandRecords(entries, opts);
  const records = [];
  if (extracted.commands.length) records.codeagentCommands = extracted.commands;
  const scheduledFires = new Set();
  // Keep hidden skill/tool/command nodes in the parent index. Filtering those
  // nodes before resolving ownership disconnects otherwise valid reply chains.
  const byId = new Map(), owners = new Map(), promptOwners = new Map(), toolOwners = new Map();
  const queuedCanonical = new Map(), inputAliases = new Map();
  const interrupted = new Set();
  for (const entry of entries) {
    if (!entry?.uuid || entry.isSidechain) continue;
    const previous = byId.get(entry.uuid);
    if (!previous || (toMs(entry.timestamp) || 0) >= (toMs(previous.timestamp) || 0)) byId.set(entry.uuid, entry);
  }
  // Mirror queued-input dedup identities before duplicates disappear. A replay
  // may change source UUID while retaining delivery/prompt identity, and its
  // new wire UUID still remains a valid parent of a later assistant record.
  for (const entry of extracted.entries) {
    const queued = queuedHumanEntry(entry), user = queued || (entry?.type === 'user' && entry.uuid ? entry : null);
    if (!user) continue;
    const aliases = ['source:' + user.uuid];
    if (typeof user.promptId === 'string' && user.promptId && !isToolResultEntry(user) && !isSyntheticUserEntry(user)) aliases.push('prompt:' + user.promptId);
    if (queued && entry.attachment.delivery_id) aliases.push('delivery:' + entry.attachment.delivery_id);
    if (queued && entry.uuid) aliases.push('attachment:' + entry.uuid);
    const canonical = aliases.map(alias => inputAliases.get(alias)).find(Boolean) || user.uuid;
    for (const alias of aliases) if (!inputAliases.has(alias)) inputAliases.set(alias, canonical);
    if (queued && entry.uuid) queuedCanonical.set(entry.uuid, canonical);
  }
  function bind(entry, record) {
    if (!record) return;
    if (entry.uuid) owners.set(entry.uuid, record);
    if (entry.promptId) promptOwners.set(entry.promptId, record);
  }
  function linkedOwner(entry) {
    // A tail can start inside an old answer/tool run. Before the first record
    // there is no question to attach those fragments to, so they are discarded
    // regardless of ownership. Only retained history needs a complete chain.
    if (!records.length) return null;
    let id = entry.parentUuid || entry.parent_uuid;
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      if (owners.has(id)) return owners.get(id);
      const parent = byId.get(id);
      if (!parent) { if (opts.codeagentPartial) records.needsFullRead = true; break; }
      const promptId = parent.promptId || parent.attachment?.promptId;
      if (promptId && promptOwners.has(promptId)) return promptOwners.get(promptId);
      const sourceId = queuedCanonical.get(id) || parent.attachment?.source_uuid || parent.attachment?.delivery_id;
      if (sourceId && owners.has(sourceId)) return owners.get(sourceId);
      id = parent.parentUuid || parent.parent_uuid;
    }
    if (isToolResultEntry(entry)) {
      const receipts = entry.message.content.filter(block => block?.type === 'tool_result');
      // A tail window may contain a result whose tool call lives outside it.
      // Re-read before the compatibility fallback can attach it to a new turn.
      if (opts.codeagentPartial && receipts.some(block => block.tool_use_id && !toolOwners.has(block.tool_use_id))) records.needsFullRead = true;
      const matches = new Set(receipts.map(block => toolOwners.get(block.tool_use_id)).filter(Boolean));
      if (matches.size === 1) return [...matches][0];
    }
    return null;
  }
  let current = null;
  for (const entry of withQueuedHumanInputs(extracted.entries)) {
    if (!entry || typeof entry !== 'object' || entry.isSidechain) continue;
    // A repeated assistant UUID is a snapshot, not another message. Do not let
    // an older snapshot appended later roll back a newer final response.
    if (entry.type === 'assistant' && entry.uuid && byId.get(entry.uuid) !== entry) continue;
    const at = toMs(entry.timestamp);
    // A native scheduled wakeup starts an independent background turn. Its
    // meta prompt is not a human question, but its answer must not overwrite
    // the previous human turn's final result.
    if (entry.type === 'system' && entry.subtype === 'scheduled_task_fire') {
      if (entry.uuid) scheduledFires.add(entry.uuid);
      if (current) settle(current, current.finalText ? 'completed' : 'interrupted');
      current = null;
      continue;
    }
    if (entry.type === 'user' && !isToolResultEntry(entry)) {
      const rawText = userText(entry.message), text = skillCommandText(rawText) ?? rawText;
      if (isInterruptMarker(text)) {
        const target = linkedOwner(entry) || current;
        if (target) { if (at) target.lastAt = Math.max(target.lastAt, at); settle(target, 'interrupted'); interrupted.add(target); bind(entry, target); }
        continue;
      }
      const notification = isTaskNotification(entry, text);
      const scheduled = entry.isMeta === true && scheduledFires.has(entry.parentUuid);
      if (!notification && !scheduled && isSyntheticUserEntry(entry, rawText)) { bind(entry, linkedOwner(entry) || current); continue; }
      if (!notification && !text.trim() && !(entry.message?.content || []).some?.(b => b && b.type === 'image')) continue;
      if (entry.isQueuedSupplement && current) {
        // This input steers the existing turn. Keep its running tools and their
        // eventual results together instead of inventing an interrupted turn.
        const supplement = newRecord(entry, text, false);
        supplement.status = 'accepted';
        supplement.accepted = true;
        (current.userSupplements ||= []).push(supplement);
        bind(entry, current);
        continue;
      }
      if (current) settle(current, current.finalText ? 'completed' : 'interrupted');
      current = newRecord(entry, text, notification || scheduled,
        scheduled ? { kind: 'scheduled-task', triggerId: entry.parentUuid } : null);
      records.push(current);
      bind(entry, current);
      continue;
    }
    if (entry.type !== 'assistant' && entry.type !== 'user') continue;
    // Missing parent links retain legacy adjacency. A partial disk window is
    // reread in full before that fallback can become the displayed history.
    const target = linkedOwner(entry) || current;
    if (!target) continue;
    bind(entry, target);
    if (at) target.lastAt = Math.max(target.lastAt, at);
    const frame = { type: entry.type, uuid: entry.uuid, message: entry.message, parent_tool_use_id: null,
      timestamp: entry.timestamp, hubObservedAt: at || target.lastAt };
    target.messages.set(entry.uuid || entry.message?.id, frame);
    for (const block of entry.message?.content || []) if (block?.type === 'tool_use') toolOwners.set(block.id, target);
    if (entry.type !== 'assistant') continue;
    if (entry.isApiErrorMessage) {
      target.finalText = assistantText(entry.message) || target.finalText;
      settle(target, 'failed');
      continue;
    }
    // 只有「终态 + 自带正文」才算答完；空正文的 end_turn 是交错思考的过程标记。
    if (isClaudeTurnStopReasonTerminal(entry.message?.stop_reason)
        && claudeAssistantContentHasAnswerText(entry.message?.content)) {
      target.finalText = assistantText(entry.message);
      target.status = interrupted.has(target) ? 'interrupted' : 'completed';
      target.completedAt = at || target.lastAt;
    } else if (target.status === 'completed') {
      // 终态之后又写了新的 assistant 帧（stop hook 续写等）：本轮其实还在继续。
      target.status = 'running';
      target.completedAt = null;
    }
  }
  return records;
}

function readEntries(file, { fromTail = false } = {}) {
  let raw;
  let partial = false;
  if (fromTail) {
    const size = fs.statSync(file).size;
    if (size > TAIL_WINDOW_BYTES) {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(TAIL_WINDOW_BYTES);
        fs.readSync(fd, buffer, 0, TAIL_WINDOW_BYTES, size - TAIL_WINDOW_BYTES);
        raw = buffer.toString('utf8');
        raw = raw.slice(raw.indexOf('\n') + 1);
        partial = true;
      } finally { fs.closeSync(fd); }
    }
  }
  if (raw === undefined) raw = fs.readFileSync(file, 'utf8');
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed)); } catch {}
  }
  return { entries, partial };
}

/**
 * 与 parseClaudeTranscriptToTurns 同样的调用约定（limit / fromTail），
 * 输出原生投影的卡片 turn。
 */
function parseClaudeTranscriptToNativeTurns(file, opts = {}) {
  const { limit, fromTail = false } = opts;
  if (typeof limit === 'number' && limit <= 0) return [];
  let { entries, partial } = readEntries(file, { fromTail: fromTail && typeof limit === 'number' });
  const records = claudeDiskRecords(entries, { ...opts, codeagentFile: file, codeagentPartial: partial });
  let turns = claudeTranscriptTurns(records);
  // 尾部窗口可能从一组提问的中间开始；凑不够就回退整文件，保证卡片 id 稳定。
  if (partial && (records.needsFullRead || turns.length <= limit)) {
    ({ entries } = readEntries(file));
    turns = claudeTranscriptTurns(claudeDiskRecords(entries, { ...opts, codeagentFile: file }));
  } else if (partial) {
    turns = turns.slice(1);
  }
  if (typeof limit === 'number' && limit < turns.length) {
    turns = fromTail ? turns.slice(turns.length - limit) : turns.slice(0, limit);
  }
  return turns.map(turn => ({ ...turn, source: 'claude-transcript' }));
}

module.exports = { claudeDiskRecords, parseClaudeTranscriptToNativeTurns };
