/**
 * read-last-assistant.js
 *
 * Read the most recent `assistant` turn from a Claude Code transcript JSONL.
 * Symmetric to main.js's readLastUserMessage — uses the same tail-only
 * reverse-read approach (64KB chunks) to avoid loading 10MB+ session files
 * into memory on every call. Reuses S1's parseAssistantContent so we don't
 * reimplement the content-block flatten logic.
 *
 * Returns null on any failure (file missing, parse error, no assistant entry)
 * — caller should treat absence as non-fatal.
 *
 * Coexists with `core/transcript-tap.js:readLastAssistantMessageFromClaudeTranscript`
 * which returns only `string` text (used by 4 internal hooks for the
 * turn-complete event payload). This module returns the structured object
 * needed by spec 2's card view rendering. Dedup planned for spec 4+ (wrap
 * the legacy string function around this one and call `.text`).
 */

const fs = require('node:fs');
const { parseAssistantContent } = require('./claude-transcript-parser');

// 2026-11-06 CodeAgent 性能盘点「读最后一条回答加上限」：异步版以前没有上限，一直往前读到文件开头；
// 遇到超长的行（大段工具输出）每读一块就把攒下的半行整段重拼、重切一遍，最坏随文件变长按平方变慢。
// 现在两版都只读文件尾部最多 4MB，半行按字节攒着、遇到换行才解码。
const CHUNK = 65536;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

// 从文件尾往前一块块喂字节，吐出完整的行（从后往前）。chunk 是紧挨在上一块前面的字节；atStart 表示已读到文件开头。
class ReverseLines {
  constructor() { this.carry = []; this.carryBytes = 0; }
  feed(chunk, atStart) {
    const out = [];
    let end = chunk.length;
    while (end > 0) {
      const nl = chunk.lastIndexOf(10, end - 1);
      if (nl < 0) break;
      out.push(this.take(chunk.subarray(nl + 1, end)));
      end = nl;
    }
    if (atStart) out.push(this.take(chunk.subarray(0, end)));
    else if (end > 0) { this.carry.unshift(Buffer.from(chunk.subarray(0, end))); this.carryBytes += end; }
    return out;
  }
  take(piece) {
    const line = this.carryBytes ? Buffer.concat([piece, ...this.carry]) : piece;
    this.carry = []; this.carryBytes = 0;
    return line.toString('utf8').trim();
  }
}

function assistantEntry(line) {
  if (!line || !line.includes('"assistant"')) return null;
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (!entry || entry.type !== 'assistant') return null;
  return entry;
}

function lastAssistantResult(entry) {
  const msg = entry.message;
  if (!msg || typeof msg !== 'object') return null;
  const parsed = parseAssistantContent(msg.content);
  const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
  return {
    text: parsed.text,
    thinking: parsed.thinking,
    toolCalls: parsed.toolCalls,
    model: typeof msg.model === 'string' ? msg.model : undefined,
    stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined,
    usage: (msg.usage && typeof msg.usage === 'object') ? msg.usage : undefined,
    ts: Number.isFinite(ts) ? ts : null,
    id: entry.uuid,
  };
}

async function scanLastAssistant(transcriptPath, maxBytes) {
  let fh;
  try {
    fh = await fs.promises.open(transcriptPath, 'r');
    const { size } = await fh.stat();
    const lines = new ReverseLines();
    let pos = size, scanned = 0;
    while (pos > 0 && scanned < maxBytes) {
      const readLen = Math.min(CHUNK, pos, maxBytes - scanned);
      pos -= readLen; scanned += readLen;
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, pos);
      for (const line of lines.feed(buf, pos === 0)) {
        const entry = assistantEntry(line);
        const result = entry && lastAssistantResult(entry);
        if (result) return result;
      }
    }
  } catch {
    // swallowed — non-fatal
  } finally {
    if (fh) { try { await fh.close(); } catch {} }
  }
  return null;
}

// 同一回合 Stop hook 和回合结束事件各来读一次（main.js observeCodeAgentModel）：文件没变（大小、修改时间都一样）时
// 复用上一次的结果，正在读的也共用同一次读取；文件变了才重读。
const recentReads = new Map();
const RECENT_READS_MAX = 32;

/**
 * @param {string} transcriptPath
 * @param {{ maxBytes?: number }} [opts] 最多从文件尾读多少字节（默认 4MB）
 * @returns {Promise<{
 *   text: string,
 *   thinking: string|null,
 *   toolCalls: Array,
 *   model?: string,
 *   stopReason?: string,
 *   usage?: object,
 *   ts: number|null,
 *   id?: string
 * } | null>}
 */
async function readLastAssistantMessage(transcriptPath, { maxBytes = MAX_TAIL_BYTES } = {}) {
  let stat;
  try { stat = await fs.promises.stat(transcriptPath); } catch { return null; }
  const key = `${stat.size}:${stat.mtimeMs}:${maxBytes}`;
  const prev = recentReads.get(transcriptPath);
  if (prev && prev.key === key) {
    const result = await prev.promise;
    return result && { ...result };
  }
  const promise = scanLastAssistant(transcriptPath, maxBytes);
  recentReads.delete(transcriptPath);
  recentReads.set(transcriptPath, { key, promise });
  while (recentReads.size > RECENT_READS_MAX) recentReads.delete(recentReads.keys().next().value);
  const result = await promise;
  return result && { ...result };
}

// 回执与 main.js 异步补记实际模型之间有竞争，发回执那一刻直接读一次。只读文件尾部（最多 maxBytes），读不到返回空串。
function readLastAssistantModelSync(transcriptPath, { maxBytes = MAX_TAIL_BYTES } = {}) {
  if (!transcriptPath) return '';
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const lines = new ReverseLines();
    let pos = size, scanned = 0;
    while (pos > 0 && scanned < maxBytes) {
      const readLen = Math.min(CHUNK, pos, maxBytes - scanned);
      pos -= readLen; scanned += readLen;
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, pos);
      for (const line of lines.feed(buf, pos === 0)) {
        const entry = assistantEntry(line);
        if (!entry || entry.isSidechain) continue;
        const model = entry.message && typeof entry.message.model === 'string' ? entry.message.model.trim() : '';
        // 合成的占位回答（如被打断时 CLI 自己写的 <synthetic>）不算模型。
        if (model && !model.startsWith('<')) return model;
      }
    }
  } catch {
    // 读不到不影响回执
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  return '';
}

module.exports = { readLastAssistantMessage, readLastAssistantModelSync, MAX_TAIL_BYTES };
