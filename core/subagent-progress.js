'use strict';
// 子 Agent 进度一行字（2026-10-29）：CodeAgent / Claude 在一轮回答里派出子 Agent（Task / Agent 工具）时，
// 卡片视图显示「2 个子任务进行中 · 最近一步：读取 GDlMeasure.cc」，全部结束后变成「3 个子任务已完成」。
//
// 数据来源（CodeAgent 是 Claude Code 衍生，记录格式相同）：
//   主记录 <dir>/<sessionId>.jsonl：Task/Agent 的 tool_use 有了对应 tool_result 就算结束；
//     后台派出的子 Agent（run_in_background）立刻回一条「Async agent launched」，那不算结束。
//   子 Agent 记录 <dir>/<sessionId>/subagents/agent-*.jsonl：每个子 Agent 一个文件，
//     同名 .meta.json 里有 toolUseId（旧版没有就按先后顺序配对）；最后一条是带正文的 end_turn 即结束。
// 读取：只在文件修改时间或大小变化时重读，且只读尾部（主记录 256KB、子 Agent 64KB），头部 4KB 只读一次取开始时间。
// 本文件是纯解析 + 带缓存的读取器（fs 可注入），主进程轮询见 main/subagent-progress-service.js。
const fs = require('node:fs');
const path = require('node:path');

const MAIN_TAIL_BYTES = 256 * 1024;
const SUB_TAIL_BYTES = 64 * 1024;
const HEAD_BYTES = 4 * 1024;
const STEP_MAX = 40;
const STALE_RUNNING_MS = 10 * 60 * 1000;   // 上一轮派出、还没结束的子 Agent：10 分钟内有写入才继续算「进行中」
const MAX_SUB_FILES = 40;
const AGENT_TOOLS = new Set(['Task', 'Agent']);

/** 一段 jsonl 文本 → 记录数组。fromStart=false 时第一行可能是被切断的半行，丢掉；任何坏行都跳过。 */
function parseJsonl(text, { fromStart = true } = {}) {
  const lines = String(text || '').split('\n');
  if (!fromStart) lines.shift();
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    try { const v = JSON.parse(s); if (v && typeof v === 'object') out.push(v); } catch { /* 半行或坏行 */ }
  }
  return out;
}

function contentBlocks(record) {
  const c = record && record.message && record.message.content;
  return Array.isArray(c) ? c : [];
}
function tsOf(record) {
  const t = Date.parse(record && record.timestamp);
  return Number.isFinite(t) ? t : null;
}
// 用户真正发出的一句话（这一轮的起点）。工具结果、系统注入（isMeta）、后台任务完成通知都不算。
function isHumanPrompt(record) {
  if (!record || record.type !== 'user' || record.isMeta || record.isSidechain) return false;
  const c = record.message && record.message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some(b => b && b.type === 'tool_result')) return false;
    text = c.filter(b => b && b.type === 'text').map(b => b.text || '').join('');
  }
  text = text.trim();
  if (!text) return false;
  return !/^<(task-notification|local-command|command-name|system-reminder)/.test(text);
}
function resultText(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
}

/** 主记录尾部 → 这一轮派出的子任务。 */
function summarizeMainRecords(records) {
  let start = 0, turnStartTs = null;
  for (let i = records.length - 1; i >= 0; i--) {
    if (isHumanPrompt(records[i])) { start = i + 1; turnStartTs = tsOf(records[i]); break; }
  }
  const toolUses = [], finished = new Set(), asyncLaunched = new Set();
  for (let i = start; i < records.length; i++) {
    const r = records[i];
    for (const b of contentBlocks(r)) {
      if (!b || typeof b !== 'object') continue;
      if (r.type === 'assistant' && b.type === 'tool_use' && AGENT_TOOLS.has(b.name) && b.id) {
        if (!toolUses.some(t => t.id === b.id)) toolUses.push({ id: b.id, ts: tsOf(r) });
      } else if (r.type === 'user' && b.type === 'tool_result' && b.tool_use_id) {
        const async = (r.toolUseResult && (r.toolUseResult.isAsync || r.toolUseResult.status === 'async_launched'))
          || /^Async agent launched/i.test(resultText(b).trim());
        (async ? asyncLaunched : finished).add(b.tool_use_id);
      }
    }
  }
  return { turnStartTs, toolUses, finished, asyncLaunched };
}

const baseName = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
function truncate(text, max = STEP_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
/** 一次工具调用 → 中文短描述（截断 40 字）。 */
function describeToolStep(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const file = baseName(i.file_path || i.notebook_path || i.path);
  let text;
  switch (name) {
    case 'Read': text = `读取 ${file}`; break;
    case 'Grep': text = `搜索 ${i.pattern || ''}`; break;
    case 'Glob': text = `查找 ${i.pattern || ''}`; break;
    case 'Bash': case 'PowerShell': text = i.description ? `运行命令：${i.description}` : '运行命令'; break;
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': text = `修改 ${file}`; break;
    case 'WebFetch': text = `读取网页 ${(String(i.url || '').match(/^\w+:\/\/([^/]+)/) || [])[1] || ''}`; break;
    case 'WebSearch': text = `联网搜索 ${i.query || ''}`; break;
    default: text = String(name || '工具');
  }
  return truncate(text);
}

/** 子 Agent 记录尾部 → { done, lastStep }。最后一条有效记录是带正文的 end_turn 才算结束。 */
function summarizeSubagentRecords(records) {
  const talk = records.filter(r => r && (r.type === 'user' || r.type === 'assistant'));
  const last = talk[talk.length - 1];
  let done = false;
  if (last && last.type === 'assistant') {
    const blocks = contentBlocks(last);
    done = Boolean(last.message && last.message.stop_reason === 'end_turn'
      && blocks.some(b => b && b.type === 'text' && String(b.text || '').trim())
      && !blocks.some(b => b && b.type === 'tool_use'));
  }
  let lastStep = '';
  for (let i = talk.length - 1; i >= 0 && !lastStep; i--) {
    if (talk[i].type !== 'assistant') continue;
    const uses = contentBlocks(talk[i]).filter(b => b && b.type === 'tool_use');
    if (uses.length) lastStep = describeToolStep(uses[uses.length - 1].name, uses[uses.length - 1].input);
  }
  return { done, lastStep };
}

/**
 * 合并主记录和子 Agent 文件 → 要显示的一行；没有子任务返回 null。
 * main：summarizeMainRecords 的结果；files：[{ name, toolUseId, firstTs, mtimeMs, done, lastStep }]。
 */
function buildSubagentProgress(main, files, { now = Date.now() } = {}) {
  const m = main || { turnStartTs: null, toolUses: [], finished: new Set(), asyncLaunched: new Set() };
  const turnIds = new Set(m.toolUses.map(t => t.id));
  const start = m.turnStartTs;
  // 这一轮的子 Agent 文件：meta 里的 toolUseId 属于本轮，或开始时间在本轮之后；
  // 另外上一轮后台派出、还在写的也算（新一轮开始不该让它凭空消失）。
  const relevant = (files || []).filter(f => {
    if (f.toolUseId && turnIds.has(f.toolUseId)) return true;
    const began = f.firstTs != null ? f.firstTs : f.mtimeMs;
    if (start != null ? began >= start : turnIds.size > 0) return true;
    return !f.done && now - f.mtimeMs < STALE_RUNNING_MS;
  }).sort((a, b) => (a.firstTs ?? a.mtimeMs) - (b.firstTs ?? b.mtimeMs));
  const tasks = [];
  const byId = new Map();
  for (const t of m.toolUses) {
    const task = { id: t.id, done: m.finished.has(t.id), file: null };
    tasks.push(task); byId.set(t.id, task);
  }
  const unmatched = [];
  for (const f of relevant) {
    const task = f.toolUseId && byId.get(f.toolUseId);
    if (task && !task.file) task.file = f; else unmatched.push(f);
  }
  // 旧版没有 meta：按先后顺序把文件配给还没配上文件的 tool_use；配不上的文件自成一项。
  const free = tasks.filter(t => !t.file);
  for (const f of unmatched) {
    const slot = !f.toolUseId && free.shift();
    if (slot) slot.file = f; else tasks.push({ id: f.name, done: false, file: f });
  }
  if (!tasks.length) return null;
  for (const t of tasks) if (t.file && t.file.done) t.done = true;
  const running = tasks.filter(t => !t.done);
  const done = tasks.length - running.length;
  if (!running.length) return { total: tasks.length, running: 0, done, lastStep: '', text: `${tasks.length} 个子任务已完成` };
  const latest = running.map(t => t.file).filter(f => f && f.lastStep).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  const lastStep = latest ? latest.lastStep : '';
  const text = [`${running.length} 个子任务进行中`, done ? `${done} 个已完成` : '', lastStep ? `最近一步：${lastStep}` : '']
    .filter(Boolean).join(' · ');
  return { total: tasks.length, running: running.length, done, lastStep, text };
}

/** 主记录路径 → 子 Agent 目录：<dir>/<sessionId>/subagents。 */
function subagentDirOf(transcriptPath) {
  if (!transcriptPath) return null;
  const dir = path.dirname(transcriptPath), base = path.basename(transcriptPath).replace(/\.jsonl$/i, '');
  return path.join(dir, base, 'subagents');
}

function readSlice(fsImpl, file, start, len) {
  const fd = fsImpl.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fsImpl.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString('utf8');
  } finally { fsImpl.closeSync(fd); }
}
function readTail(fsImpl, file, size, maxBytes) {
  const len = Math.min(size, maxBytes);
  return { text: readSlice(fsImpl, file, size - len, len), fromStart: len === size };
}

/**
 * 带缓存的读取器：同一份文件修改时间和大小都没变就复用上次的解析结果。
 * read(transcriptPath) → buildSubagentProgress 的结果或 null；任何读不到的文件都当作不存在，不抛错。
 */
function createSubagentProgressReader({ fsImpl = fs, now = () => Date.now() } = {}) {
  const cache = new Map();   // 文件路径 → { mtimeMs, size, value }
  function cached(file, st, compute) {
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = compute();
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value, head: hit && hit.head });
    return value;
  }
  function headTs(file, st) {
    const hit = cache.get(file);
    if (hit && hit.head !== undefined) return hit.head;
    let ts = null;
    try { const r = parseJsonl(readSlice(fsImpl, file, 0, Math.min(st.size, HEAD_BYTES))).find(x => tsOf(x) != null); ts = r ? tsOf(r) : null; } catch { ts = null; }
    if (hit) hit.head = ts; else cache.set(file, { mtimeMs: null, size: null, value: null, head: ts });
    return ts;
  }
  // 同名 .meta.json：toolUseId 用来和主记录配对；新版 Claude Code 结束后还会写 finished:true。按修改时间缓存。
  function metaOf(file) {
    const metaFile = file.replace(/\.jsonl$/i, '.meta.json');
    let st; try { st = fsImpl.statSync(metaFile); } catch { return { toolUseId: null, finished: false }; }
    return cached(`${metaFile}#meta`, st, () => {
      try {
        const meta = JSON.parse(fsImpl.readFileSync(metaFile, 'utf8'));
        return { toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : null, finished: meta.finished === true };
      } catch { return { toolUseId: null, finished: false }; }
    });
  }
  function read(transcriptPath) {
    if (!transcriptPath) return null;
    let main = null;
    try {
      const st = fsImpl.statSync(transcriptPath);
      main = cached(transcriptPath, st, () => {
        const { text, fromStart } = readTail(fsImpl, transcriptPath, st.size, MAIN_TAIL_BYTES);
        return summarizeMainRecords(parseJsonl(text, { fromStart }));
      });
    } catch { main = null; }
    const dir = subagentDirOf(transcriptPath);
    let names = [];
    try { names = fsImpl.readdirSync(dir).filter(n => /\.jsonl$/i.test(n)); } catch { names = []; }
    const stats = [];
    for (const name of names) {
      const file = path.join(dir, name);
      try { const st = fsImpl.statSync(file); stats.push({ name, file, st }); } catch { /* 刚被删 */ }
    }
    stats.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    const files = [];
    for (const { name, file, st } of stats.slice(0, MAX_SUB_FILES)) {
      try {
        const sum = cached(file, st, () => {
          const { text, fromStart } = readTail(fsImpl, file, st.size, SUB_TAIL_BYTES);
          return summarizeSubagentRecords(parseJsonl(text, { fromStart }));
        });
        const meta = metaOf(file);
        files.push({ name, toolUseId: meta.toolUseId, firstTs: headTs(file, st), mtimeMs: st.mtimeMs, ...sum, done: sum.done || meta.finished });
      } catch { /* 读不到的文件当作不存在 */ }
    }
    const live = new Set([transcriptPath, ...stats.map(s => s.file)]);
    for (const key of cache.keys()) {
      const base = key.endsWith('#meta') ? key.slice(0, -5).replace(/\.meta\.json$/i, '.jsonl') : key;
      if (!live.has(base)) cache.delete(key);
    }
    return buildSubagentProgress(main, files, { now: now() });
  }
  return { read, _cache: cache };
}

module.exports = {
  parseJsonl, summarizeMainRecords, summarizeSubagentRecords, describeToolStep, buildSubagentProgress,
  subagentDirOf, createSubagentProgressReader, isHumanPrompt,
};
