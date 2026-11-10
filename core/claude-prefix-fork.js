'use strict';

// Prefix-fork experiment only. This module never launches a CLI or writes
// the source transcript. The caller supplies the account's actual configDir.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { textFromContent, skillCommandText, isSyntheticUserEntry } = require('./synthetic-user-filter');
const { CODEAGENT_BUILTIN_COMMANDS } = require('./codeagent-command-records');

const { isNativeRecordId, isNativeSessionId } = require('./codeagent-record-id');
const LOCAL_COMMANDS = new Set(CODEAGENT_BUILTIN_COMMANDS);
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const REASONS = {
  'invalid-options': '参数无效，需要源文件、账号配置目录、工作目录和用户记录 ID',
  'source-unreadable': '无法读取源会话记录',
  'source-too-large': '记录超过 16 MiB 历史分支读取上限，请使用普通分支或新开会话',
  'source-changing': '源文件正在写入，未能取得稳定记录，请等回答结束后重试',
  'incomplete-json': '源文件有不完整或无效的 JSON 记录，重试后仍无法读取',
  'invalid-record': '源文件包含无法识别的记录结构',
  'cut-not-found': '找不到指定的用户记录',
  'ambiguous-cut': '无法唯一定位这一轮的开头',
  'unsupported-queued-command': '暂不支持排队或轮内补充消息的截断',
  'unsupported-sidechain': '暂不支持子代理或旁支记录的截断',
  'unsupported-local-command': '本地命令不是可截断的提问轮次',
  'not-human-turn': '指定记录不是真实的一轮提问开头',
  'empty-prefix': '截断点之前没有提问轮次，请直接新开空会话，不生成空记录',
  'unpaired-tool': '前缀中的工具调用与工具结果未完整配对',
  'compact-reference-outside-prefix': '压缩记录引用了被截掉的内容',
  'reference-outside-prefix': '前缀记录引用了未保留的消息',
  'unknown-reference-outside-prefix': '不认识的记录类型引用了被截掉的内容，暂不支持',
  'session-identity-mismatch': '源文件的会话身份不一致，无法安全改写',
  'target-exists': '目标会话文件已存在，未覆盖',
  'write-failed': '新会话文件写入失败，未改动源文件',
  'cleanup-failed': '新会话文件写入失败且无法清理，请检查该文件的权限，不要恢复它',
};

function reasonText(reason) { return REASONS[reason] || '操作未完成'; }

// Same cwd bucket rule as claude-native-history.js; do not use a display slug.
function projectSlug(cwd) { return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'); }

function sameStat(a, b) { return a.size === b.size && a.mtimeMs === b.mtimeMs; }

function readBoundedText(fd, size, fsModule, maxBytes) {
  const buffer = Buffer.alloc(Math.min(size + 1, maxBytes + 1));
  let used = 0;
  while (used < buffer.length) {
    const count = fsModule.readSync(fd, buffer, used, buffer.length - used, used);
    if (!count) break;
    used += count;
  }
  if (used > maxBytes) throw Object.assign(new Error('source-too-large'), { code: 'SOURCE_TOO_LARGE' });
  return buffer.subarray(0, used).toString('utf8').replace(/^\uFEFF/, '');
}

function readStableTranscript(file, { fsModule = fs, maxBytes = MAX_TRANSCRIPT_BYTES } = {}) {
  let reason = 'source-unreadable';
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fsModule.openSync(file, 'r');
      const before = fsModule.fstatSync(fd);
      if (!before.isFile()) return { ok: false, reason: 'source-unreadable' };
      if (before.size > maxBytes) return { ok: false, reason: 'source-too-large' };
      const raw = readBoundedText(fd, before.size, fsModule, maxBytes);
      const after = fsModule.fstatSync(fd), current = fsModule.statSync(file);
      if (!sameStat(before, after) || !sameStat(after, current)) {
        reason = 'source-changing';
        continue;
      }
      const rows = [];
      try {
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          rows.push(JSON.parse(line));
        }
      } catch { reason = 'incomplete-json'; continue; }
      if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || typeof row.type !== 'string')) {
        return { ok: false, reason: 'invalid-record' };
      }
      return { ok: true, rows, stat: { size: after.size, mtimeMs: after.mtimeMs } };
    } catch (error) { reason = error.code === 'SOURCE_TOO_LARGE' ? 'source-too-large' : 'source-unreadable'; }
    finally { if (fd !== undefined) fsModule.closeSync(fd); }
  }
  return { ok: false, reason };
}

function turnReason(row) {
  if (row.isSidechain || row.agentId || row.agent_id) return 'unsupported-sidechain';
  if (row.type === 'attachment' && row.attachment?.type === 'queued_command') return 'unsupported-queued-command';
  if (row.type !== 'user') return 'not-human-turn';
  const blocks = row.message?.content;
  if (Array.isArray(blocks) && blocks.some(block => block?.type === 'tool_result')) return 'not-human-turn';
  const text = textFromContent(blocks), skill = skillCommandText(text);
  const command = (skill ?? text).trimStart().match(/^\/([^\s]+)/)?.[1]?.toLowerCase();
  if (LOCAL_COMMANDS.has(command) || /^\s*<(?:local-command|command-name)/.test(text)) return 'unsupported-local-command';
  if (isSyntheticUserEntry(row, text) || (!text.trim() && !blocks?.some?.(block => block?.type === 'image'))) return 'not-human-turn';
  return null;
}

function listTranscriptTurns(rows) {
  return rows.flatMap((row, index) => turnReason(row) || !row.uuid ? []
    : [{ uuid: row.uuid, index, text: skillCommandText(textFromContent(row.message.content)) ?? textFromContent(row.message.content) }]);
}

function locateCut(rows, cutUserUuid) {
  const matches = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.uuid === cutUserUuid
    || (row.attachment?.type === 'queued_command' && [row.attachment.source_uuid, row.attachment.delivery_id].includes(cutUserUuid)));
  if (!matches.length) return { reason: 'cut-not-found' };
  if (matches.some(({ row }) => row.attachment?.type === 'queued_command')) return { reason: 'unsupported-queued-command' };
  if (matches.length !== 1) return { reason: 'ambiguous-cut' };
  const { row, index } = matches[0], reason = turnReason(row);
  if (reason) return { reason };
  const turns = listTranscriptTurns(rows);
  if (row.promptId && turns.some(turn => turn.index !== index && rows[turn.index].promptId === row.promptId)) {
    return { reason: 'ambiguous-cut' };
  }
  // A queued delivery preceding its later user echo is not a standalone boundary.
  if (rows.some(entry => entry.attachment?.type === 'queued_command'
    && (entry.attachment.source_uuid === cutUserUuid || entry.attachment.promptId === row.promptId && row.promptId))) {
    return { reason: 'unsupported-queued-command' };
  }
  return { index, turns };
}

function uuidReferences(value, key = '') {
  if (typeof value === 'string') return /uuid/i.test(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(item => uuidReferences(item, key));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([name, item]) => uuidReferences(item, name));
}

function mentionsRemoved(value, removed, key = '') {
  // An unknown record's payload cannot safely be assumed to be mere prose.
  // Account/session identity is not a message reference.
  if (['sessionId', 'session_id'].includes(key)) return false;
  if (typeof value === 'string') return removed.has(value);
  if (Array.isArray(value)) return value.some(item => mentionsRemoved(item, removed, key));
  return !!value && typeof value === 'object' && Object.entries(value).some(([name, item]) => mentionsRemoved(item, removed, name));
}

function validatePrefix(rows, allRows) {
  const ids = new Set(rows.map(row => row.uuid).filter(Boolean));
  const removed = new Set(allRows.map(row => row.uuid).filter(id => id && !ids.has(id)));
  const calls = new Map(), results = new Map();
  for (const row of rows) {
    if (row.type === 'attachment' && row.attachment?.type === 'queued_command') return 'unsupported-queued-command';
    if (row.subtype === 'compact_boundary' || row.compactMetadata) {
      if (uuidReferences(row.compactMetadata).some(id => id && !ids.has(id))) return 'compact-reference-outside-prefix';
    }
    for (const field of ['parentUuid', 'parent_uuid', 'logicalParentUuid', 'sourceToolAssistantUUID']) {
      if (row[field] && !ids.has(row[field])) return 'reference-outside-prefix';
    }
    if (!['user', 'assistant', 'system'].includes(row.type) && mentionsRemoved(row, removed)) return 'unknown-reference-outside-prefix';
    for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (block?.type === 'tool_use') {
        if (!block.id) return 'unpaired-tool';
        calls.set(block.id, (calls.get(block.id) || 0) + 1);
      }
      if (block?.type === 'tool_result') {
        if (!block.tool_use_id) return 'unpaired-tool';
        results.set(block.tool_use_id, (results.get(block.tool_use_id) || 0) + 1);
      }
    }
  }
  if ([...new Set([...calls.keys(), ...results.keys()])].some(id => calls.get(id) !== 1 || results.get(id) !== 1)) return 'unpaired-tool';
  return null;
}

// cutUserUuid is exclusive; null is allowed only with a replyId proven to be
// the final round by the full native projection. newSessionId is optional; the
// fsModule seam lets tests simulate a writer without touching a real session.
function forkClaudePrefix({ sourceFile, configDir, cwd, cutUserUuid, replyId, newSessionId, expectedStat } = {}, { fsModule = fs } = {}) {
  const result = { ok: false, newSessionId: null, file: null, keptLines: 0, droppedLines: 0, cutUserUuid: cutUserUuid || null, reason: null };
  const reject = reason => ({ ...result, reason });
  if (![sourceFile, configDir, cwd].every(value => typeof value === 'string' && value.trim())
    || !(typeof cutUserUuid === 'string' && cutUserUuid.trim()
      || cutUserUuid === null && typeof replyId === 'string' && replyId.trim())
    || newSessionId !== undefined && !isNativeSessionId(newSessionId)) return reject('invalid-options');
  const read = readStableTranscript(sourceFile, { fsModule });
  if (!read.ok) return reject(read.reason);
  if (expectedStat && !sameStat(expectedStat, read.stat)) return reject('source-changing');
  const { rows } = read, cut = replyId ? resolveAfterReply(rows, replyId) : locateCut(rows, cutUserUuid);
  if (cut.reason) return reject(cut.reason);
  if (replyId && cut.cutUserUuid !== cutUserUuid) return reject('ambiguous-cut');
  const cutIndex = replyId && cut.cutUserUuid === null ? rows.length : cut.index;
  if (!listTranscriptTurns(rows).some(turn => turn.index < cutIndex)) { result.droppedLines = rows.length; return reject('empty-prefix'); }
  const initial = rows.slice(0, cutIndex), ids = new Set(initial.map(row => row.uuid).filter(Boolean));
  const prefix = replyId && cut.cutUserUuid === null ? initial
    : initial.filter(row => row.type !== 'last-prompt' || !row.leafUuid || ids.has(row.leafUuid));
  result.keptLines = prefix.length;
  result.droppedLines = rows.length - prefix.length;
  const reason = validatePrefix(prefix, rows);
  if (reason) return reject(reason);
  const identities = new Set(rows.map(row => row.sessionId).filter(value => typeof value === 'string' && value));
  if (identities.size !== 1 || rows.some(row => row.session_id !== undefined && !identities.has(row.session_id))) {
    return reject('session-identity-mismatch');
  }
  result.newSessionId = newSessionId || randomUUID();
  result.file = path.join(path.resolve(configDir), 'projects', projectSlug(cwd), result.newSessionId + '.jsonl');
  let fd, created = false;
  try {
    const output = prefix.map(row => JSON.stringify({ ...row,
      ...(Object.hasOwn(row, 'sessionId') ? { sessionId: result.newSessionId } : {}),
      ...(Object.hasOwn(row, 'session_id') ? { session_id: result.newSessionId } : {}) })).join('\n') + '\n';
    fsModule.mkdirSync(path.dirname(result.file), { recursive: true });
    if (!sameStat(read.stat, fsModule.statSync(sourceFile))) return reject('source-changing');
    // A random, undisclosed target is not resumable by another caller until we
    // return it. Exclusive creation prevents both accidental overwrite and races.
    fd = fsModule.openSync(result.file, 'wx', 0o600);
    created = true;
    fsModule.writeFileSync(fd, output, 'utf8');
    fsModule.fsyncSync(fd);
    const changed = !sameStat(read.stat, fsModule.statSync(sourceFile));
    fsModule.closeSync(fd);
    fd = undefined;
    if (changed) { fsModule.unlinkSync(result.file); created = false; return reject('source-changing'); }
    return { ...result, ok: true };
  } catch (error) {
    if (fd !== undefined) { try { fsModule.closeSync(fd); } catch {} }
    if (created) { try { fsModule.unlinkSync(result.file); } catch { return reject('cleanup-failed'); } }
    return reject(error.code === 'EEXIST' ? 'target-exists' : 'write-failed');
  }
}

// Use the same complete native projection as the cards, never a renderer page.
function resolveAfterReply(rows, replyId) {
  const { claudeDiskRecords } = require('./claude-disk-transcript');
  const { claudeTranscriptTurns, groupClaudeRecords } = require('./claude-native-transcript');
  const records = claudeDiskRecords(rows, { codeagent: true });
  const cards = claudeTranscriptTurns(records);
  const reply = cards.find(card => card.id === replyId && card.role === 'assistant'
    && !card.nativeActivity && !card.queuedSupplement && card.text?.trim());
  if (!reply) return { reason: 'reply-not-found' };
  if (!isNativeRecordId(reply.userMessageId)) return { reason: 'ambiguous-reply' };
  const group = groupClaudeRecords(records).find(g => g.record.userMessageId === reply.userMessageId);
  if (!group) return { reason: 'reply-not-found' };
  // The displayed logical reply may merge a completed answer and continuations.
  // Locate its last body frame by native identity, not by frontend page/order.
  const frames = [group.record, ...group.continuations].flatMap(record => [...record.messages.values()]);
  const frame = frames.findLast(f => f.type === 'assistant' && Array.isArray(f.message?.content)
    && f.message.content.some(b => b.type === 'text' && b.text?.trim()));
  const matches = rows.flatMap((r, i) => frame?.uuid && r.uuid === frame.uuid ? [i] : []);
  if (matches.length !== 1) return { reason: 'ambiguous-reply' };
  const after = matches[0];
  // A display group may absorb a hidden user input and its later answer. Its
  // logical ID then spans both sides of a mandatory cut. Never silently retain
  // that input or truncate a reply which the selected merged card also shows.
  const firstBody = frames.find(f => f.type === 'assistant' && Array.isArray(f.message?.content)
    && f.message.content.some(b => b.type === 'text' && b.text?.trim()));
  const firstMatches = rows.flatMap((r, i) => firstBody?.uuid && r.uuid === firstBody.uuid ? [i] : []);
  if (firstMatches.length !== 1) return { reason: 'ambiguous-reply' };
  const intervening = rows.slice(firstMatches[0] + 1, after).find(isCutRow);
  if (intervening) return { reason: 'ambiguous-reply', cutLineType: cutRowType(intervening) };
  for (let index = after + 1; index < rows.length; index++) {
    const row = rows[index];
    if (!isCutRow(row)) continue;
    const cutLineType = cutRowType(row);
    // A queued attachment without a user row is also a boundary, never silently
    // swallowed into a whole-session fork. Its native record ID must be unique.
    if (!isNativeRecordId(row.uuid) || rows.filter(r => r.uuid === row.uuid).length !== 1) {
      return { reason: 'ambiguous-cut', cutLineType, index };
    }
    return { userUuid: reply.userMessageId, cutUserUuid: row.uuid, index, cutLineType };
  }
  return { userUuid: reply.userMessageId, cutUserUuid: null, index: null, cutLineType: null };
}

function isToolResult(row) {
  return Array.isArray(row.message?.content) && row.message.content.some(b => b?.type === 'tool_result');
}

function isCutRow(row) {
  return row.isSidechain !== true && (row.type === 'user' && !isToolResult(row)
    || row.type === 'attachment' && row.attachment?.type === 'queued_command');
}

function cutRowType(row) {
  return row.attachment?.type === 'queued_command' || row.isQueuedSupplement ? 'queued-message'
    : turnReason(row) === 'unsupported-local-command' ? 'local-command'
    : isSyntheticUserEntry(row, textFromContent(row.message?.content)) ? 'synthetic-user' : 'user';
}

function transcriptStats(rows) {
  if (!rows) return { recordLines: null, recordTypes: null, hasSubtasks: null, hasSidechain: null,
    hasAgentId: null, hasOriginKind: null, hasTaskNotification: null, hasTaskToolUse: null,
    hasQueuedMessages: null, hasCompaction: null };
  const recordTypes = {};
  for (const row of rows) {
    const type = ['user', 'assistant', 'system', 'attachment', 'progress', 'summary', 'file-history-snapshot', 'last-prompt', 'queue-operation'].includes(row.type) ? row.type : 'other';
    recordTypes[type] = (recordTypes[type] || 0) + 1;
  }
  const hasSidechain = rows.some(row => row.isSidechain === true);
  const hasAgentId = rows.some(row => row.agentId || row.agent_id);
  const hasOriginKind = rows.some(row => row.origin?.kind);
  const hasTaskNotification = rows.some(row => row.origin?.kind === 'task-notification');
  const hasTaskToolUse = rows.some(row => row.message?.content?.some?.(b => b?.type === 'tool_use' && ['Task', 'Agent'].includes(b.name)));
  return { recordLines: rows.length, recordTypes,
    // These are evidence flags, not a rejection policy. Only explicit sidechain
    // rows block a prefix; main-chain tool calls/results still undergo pairing.
    hasSubtasks: hasSidechain || hasAgentId || hasTaskNotification || hasTaskToolUse,
    hasSidechain, hasAgentId, hasOriginKind, hasTaskNotification, hasTaskToolUse,
    hasQueuedMessages: rows.some(row => row.isQueuedSupplement || row.attachment?.type === 'queued_command' || row.type === 'queue-operation'),
    hasCompaction: rows.some(row => row.subtype === 'compact_boundary' || row.compactMetadata || row.type === 'summary') };
}

function diagnosticStats(file, rows) {
  if (rows) return { ...transcriptStats(rows), invalidLines: 0, metadataComplete: true };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size > MAX_TRANSCRIPT_BYTES) return { ...transcriptStats(null), metadataComplete: false, readSkipped: 'source-too-large' };
    const lines = readBoundedText(fd, size, fs, MAX_TRANSCRIPT_BYTES).split(/\r?\n/).filter(line => line.trim());
    const parsed = []; let invalidLines = 0;
    for (const line of lines) {
      try { const row = JSON.parse(line); if (row && typeof row === 'object' && !Array.isArray(row)) parsed.push(row); else invalidLines++; }
      catch { invalidLines++; }
    }
    return { ...transcriptStats(parsed), recordLines: lines.length, invalidLines, metadataComplete: false };
  } catch { return { ...transcriptStats(null), invalidLines: null, metadataComplete: false }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Company-machine evidence: JSONL-only resume worked for a short conversation
// with model-io/model-io-0.jsonl and observability/obs.jsonl. Inspect names and
// directory accessibility and entry kinds, never open/copy/read sidecar files.
// Logs allow regular files; subagents also allows nested directories. Only
// names and lstat metadata are inspected; links are rejected before traversal.
function inspectSiblingDirectory(file, { fsModule = fs } = {}) {
  const directory = file.replace(/\.jsonl$/i, '');
  const result = { ok: false, directory, present: null, entries: [], inspected: false, copied: false, hasSubagents: false };
  const reject = reason => ({ ...result, reason });
  if (directory === file) return reject('sidecar-unknown-content');
  try {
    let stat;
    try { stat = fsModule.lstatSync(directory); }
    catch (error) {
      if (error.code === 'ENOENT') return { ...result, ok: true, present: false, inspected: true };
      throw error;
    }
    result.present = true;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return reject('sidecar-unknown-content');
    let unknown = false;
    const names = fsModule.readdirSync(directory).sort();
    result.entries.push(...names);
    result.hasSubagents = names.some(name => name.toLowerCase() === 'subagents');
    for (const name of names) {
      const kind = name.toLowerCase();
      if (!['model-io', 'observability', 'subagents'].includes(kind)) { unknown = true; continue; }
      const folder = path.join(directory, name), info = fsModule.lstatSync(folder);
      if (info.isSymbolicLink() || !info.isDirectory()) { unknown = true; continue; }
      const pending = [name];
      while (pending.length) {
        const relative = pending.pop(), current = path.join(directory, relative);
        const children = fsModule.readdirSync(current).sort();
        result.entries.push(...children.map(child => relative + '/' + child));
        for (const child of children) {
          const childRelative = relative + '/' + child, childStat = fsModule.lstatSync(path.join(directory, childRelative));
          if (childStat.isSymbolicLink()) { unknown = true; continue; }
          if (kind === 'subagents' && childStat.isDirectory()) pending.push(childRelative);
          else if (!childStat.isFile()) unknown = true;
        }
      }
    }
    result.inspected = true;
    if (unknown) return reject('sidecar-unknown-content');
    return { ...result, ok: true };
  } catch { return reject('sidecar-unreadable'); }
}

module.exports = { forkClaudePrefix, listTranscriptTurns, readStableTranscript, projectSlug, reasonText,
  resolveAfterReply, transcriptStats, diagnosticStats, inspectSiblingDirectory, MAX_TRANSCRIPT_BYTES };
