'use strict';
// 各 AI 的本机会话记录 → 按「天 / 工具 / 模型 / 账号」聚合。只读本机文件，不调用模型，不上传。
// 口径：fresh=未命中缓存的输入，cached=缓存读取，write=缓存写入，output=输出（含思考）；四项之和是总量。
// 按启动的工具归类：同一工具里能选不同模型，模型明细单独列。
const fs = require('node:fs');
const path = require('node:path');

const pad = n => String(n).padStart(2, '0');
function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
const parseTime = v => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : 0; };
const SEP = '\u0000';

class Tally {
  constructor(sinceMs) { this.sinceMs = sinceMs; this.rows = new Map(); }
  add(at, provider, model, account, usage) {
    if (!at || at < this.sinceMs) return;
    const fresh = num(usage.fresh), cached = num(usage.cached), write = num(usage.write), output = num(usage.output);
    if (!fresh && !cached && !write && !output) return;
    const key = [dayKey(at), provider, model || 'unknown', account || ''].join(SEP);
    const row = this.rows.get(key) || [0, 0, 0, 0];
    row[0] += fresh; row[1] += cached; row[2] += write; row[3] += output;
    this.rows.set(key, row);
  }
  byDay() {
    const days = {};
    for (const [key, v] of this.rows) { const [day, provider, model, account] = key.split(SEP); (days[day] ||= []).push([provider, model, account, ...v]); }
    return days;
  }
}

function walk(root, match, sinceMs, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // 目录链接指向的内容在它的真实位置已经统计过
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, match, sinceMs, out); }
    else if (e.isFile() && match(e.name)) { try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch {} }
  }
  return out;
}
const subdirs = root => { try { return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => e.name); } catch { return []; } };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// 逐行读，needle 先在字节层筛一遍，日志动辄几 GB，绝大多数行不用解析。
async function eachLine(file, needle, onLine) {
  const needleBuf = Buffer.from(needle);
  let carry = [];
  const take = buf => { if (buf.includes(needleBuf)) { let r; try { r = JSON.parse(buf.toString('utf8')); } catch { return; } onLine(r); } };
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    let start = 0, nl;
    while ((nl = chunk.indexOf(10, start)) !== -1) {
      const part = chunk.subarray(start, nl);
      if (carry.length) { carry.push(part); take(Buffer.concat(carry)); carry = []; } else take(part);
      start = nl + 1;
    }
    if (start < chunk.length) carry.push(Buffer.from(chunk.subarray(start)));
  }
  if (carry.length) take(Buffer.concat(carry));
}

function roots({ homeDir, dataDir: hub, codeAgentDir }) {
  const claude = [], codex = [];
  claude.push({ dir: path.join(codeAgentDir || path.join(homeDir, '.cac'), 'projects'), account: 'personal', provider: 'codeagent' });
  for (const id of subdirs(path.join(hub, 'codeagent-pool', 'accounts'))) claude.push({ dir: path.join(hub, 'codeagent-pool', 'accounts', id, 'projects'), account: id, provider: 'codeagent' });
  claude.push({ dir: path.join(homeDir, '.claude', 'projects'), account: 'default', provider: 'claude' });
  for (const id of subdirs(path.join(homeDir, '.claude-profiles'))) claude.push({ dir: path.join(homeDir, '.claude-profiles', id, 'projects'), account: id, provider: 'claude' });
  codex.push({ dir: path.join(homeDir, '.codex', 'sessions'), account: 'default', provider: 'codex' });
  for (const id of subdirs(path.join(homeDir, '.codex-profiles'))) codex.push({ dir: path.join(homeDir, '.codex-profiles', id, 'sessions'), account: id, provider: 'codex' });
  const acp = subdirs(path.join(hub, 'acp')).map(id => path.join(hub, 'acp', id, 'home'));
  return { claude, codex, acp };
}

// Claude：一条回复的多个内容块共用 message.id 和累计用量；分支会话也会抄历史，所以跨文件去重，各字段取最大。
async function scanClaude(list, tally, ctx) {
  const seen = new Map();
  for (const src of list) for (const file of walk(src.dir, n => n.endsWith('.jsonl'), ctx.sinceMs)) {
    ctx.files++;
    try {
      await eachLine(file, '"usage"', r => {
        if (r?.type !== 'assistant' || !r.message?.usage || r.message.model === '<synthetic>') return;
        const key = r.message.id || r.requestId, u = r.message.usage, at = parseTime(r.timestamp);
        if (!key || !at) return;
        const v = [num(u.input_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens), num(u.output_tokens)];
        const old = seen.get(key);
        if (old) old.v = old.v.map((x, i) => Math.max(x, v[i]));
        else seen.set(key, { v, at, model: r.message.model, account: src.account, provider: src.provider });
      });
    } catch { ctx.errors++; }
  }
  for (const m of seen.values()) tally.add(m.at, m.provider, m.model, m.account, { fresh: m.v[0], cached: m.v[1], write: m.v[2], output: m.v[3] });
}

// Codex：每次调用都有 last_token_usage；恢复、分支会把旧记录重放到新文件，用累计值+本次值识别同一次调用。
async function scanCodex(list, tally, ctx) {
  const seen = new Set();
  for (const src of list) for (const file of walk(src.dir, n => n.endsWith('.jsonl'), ctx.sinceMs)) {
    ctx.files++;
    let model = '';
    try {
      await eachLine(file, '_', r => {
        if (r?.type === 'turn_context') { model = r.payload?.model || model; return; }
        if (r?.type !== 'event_msg' || r.payload?.type !== 'token_count') return;
        const info = r.payload.info, last = info?.last_token_usage, at = parseTime(r.timestamp);
        if (!last || !at) return;
        const key = [info.total_token_usage?.total_tokens, last.total_tokens, last.input_tokens, last.output_tokens].join(':');
        if (seen.has(key)) return;
        seen.add(key);
        const cached = num(last.cached_input_tokens);
        tally.add(at, src.provider, model, src.account, { fresh: num(last.input_tokens) - cached, cached, output: num(last.output_tokens) });
      });
    } catch { ctx.errors++; }
  }
}

async function scanDsh(homes, tally, ctx) {
  const seen = new Set();
  for (const home of homes) for (const file of walk(path.join(home, '.dsh', 'hub-events'), n => n.endsWith('.jsonl'), ctx.sinceMs)) {
    ctx.files++;
    try {
      await eachLine(file, 'cacheReadTokens', r => {
        for (const e of r?.events || []) {
          const u = e?.data?.usage, key = file + ':' + e.seq;
          if (!u || !Number.isFinite(u.outputTokens) || seen.has(key)) continue;
          seen.add(key);
          tally.add(parseTime(e.time), 'dsh', e.data.message?.source?.model || e.data.model || r.model, '', { fresh: u.inputTokens, cached: u.cacheReadTokens, output: u.outputTokens });
        }
      });
    } catch { ctx.errors++; }
  }
}

async function scanAll({ homeDir, dataDir, codeAgentDir, sinceMs, onStage = () => {} }) {
  const tally = new Tally(sinceMs), r = roots({ homeDir, dataDir, codeAgentDir }), ctx = { sinceMs, files: 0, errors: 0 };
  onStage('CodeAgent、Claude'); await scanClaude(r.claude, tally, ctx);
  onStage('Codex'); await scanCodex(r.codex, tally, ctx);
  onStage('DSH'); await scanDsh(r.acp, tally, ctx);
  return { days: tally.byDay(), files: ctx.files, errors: ctx.errors };
}

module.exports = { dayKey, Tally, scanAll };
