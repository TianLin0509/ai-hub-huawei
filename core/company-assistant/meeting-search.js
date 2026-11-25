'use strict';
// 只通过会议服务的公开接口读取；不依赖目录、会话或模型。
const { performance } = require('node:perf_hooks');
const minutes = require('./meeting-minutes');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const TYPES = { title: ['标题', 5], summary: ['纪要', 4], mark: ['重点', 3], question: ['问答', 2], transcript: ['原话', 1] };
const ID = /^[a-f0-9-]{36}$/;
const caches = new WeakMap();
const CACHE_BYTES = 48 * 1024 * 1024;
const CACHE_MEETINGS = 64;
const fold = text => text.replace(/[A-Z]/g, c => c.toLowerCase());
// 材料本身可能引用本地文件。对返回的标题/片段也去路径，而非只去掉文件字段。
function safeText(value) {
  return String(value ?? '').replace(/file:\/\/[^\s<>"'，。；！？)）\]]*/gi, '〔本地路径〕')
    .replace(/(["'])(?:[a-z]:[\\/]|\\\\)[^"'\r\n]*\1/gi, '〔本地路径〕')
    .replace(/(?<![a-z0-9])(?:[a-z]:[\\/]|\\\\)(?:[^\s<>"'，。；！？)）\]]|[ \t]+(?=[^\s<>"'，。；！？)）\]]*[\\/]))*/gi, '〔本地路径〕')
    // Unicode词边界保护“上行/下行”“王工/李工”；Unix只认系统根或明确的多段路径。
    .replace(/(?<![\p{L}\p{N}_.\\/])\/(?:(?:home|Users|tmp|etc|var|usr|opt|root|mnt|Volumes|private|data)(?=\/|\s|[<>"'，。；！？)）\]]|$)(?:\/[^\s<>"'，。；！？)）\]]*)?|[a-zA-Z0-9._-]+\/[^\s<>"'，。；！？)）\]]+)/gu, '〔本地路径〕')
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
}
function dateBound(value, end = false) {
  if (value == null || value === '') return end ? Infinity : -Infinity;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') throw new Error('时间范围须为日期、ISO 时间或毫秒时间戳');
  let text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const stamp = Date.parse(text + 'T00:00:00+08:00');
    if (!Number.isFinite(stamp) || new Date(stamp + 8 * 3600000).toISOString().slice(0, 10) !== text) throw new Error('日期无效');
    return stamp + (end ? 86400000 - 1 : 0);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(text)) throw new Error('时间范围格式无效');
  dateBound(text.slice(0, 10)); // Date.parse会把2月30日滚到3月，须先校验日历日期。
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(text)) text += '+08:00';
  const stamp = Date.parse(text); if (!Number.isFinite(stamp)) throw new Error('时间范围无效');
  return stamp;
}
function request(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('搜索参数无效');
  if (input.query != null && typeof input.query !== 'string') throw new Error('关键词须为文字');
  const query = (input.query || '').trim();
  if (query.length > 256) throw new Error('关键词最多 256 字');
  const terms = [...new Set(query.split(/\s+/).filter(Boolean).map(fold))];
  if (terms.length > 16) throw new Error('一次最多搜索 16 个关键词');
  const from = dateBound(input.from), to = dateBound(input.to, true);
  if (from > to) throw new Error('开始日期不能晚于结束日期');
  const meetingId = input.meetingId == null ? '' : String(input.meetingId);
  if (meetingId && !ID.test(meetingId)) throw new Error('会议编号无效');
  const number = (value, fallback, max) => value === '' || value == null ? fallback : Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Math.floor(Number(value)))) : fallback;
  return { query, terms, from, to, meetingId, offset: number(input.offset ?? 0, 0, 10000), limit: Math.max(1, number(input.limit ?? 20, 20, 100)) };
}
function atTime(at) {
  if (!Number.isFinite(at)) return null;
  const n = Math.max(0, at);
  return `${String(Math.floor(n / 60000)).padStart(2, '0')}:${String(Math.floor(n / 1000) % 60).padStart(2, '0')}`;
}
function* sources(m) {
  yield { sourceType: 'title', itemId: 'title', text: m.title, at: null };
  const reference = text => {
    const seq = Number(/\[事件\s*(\d+)\]/.exec(text)?.[1]);
    const event = seq > 0 ? (m.events[seq - 1]?.seq === seq ? m.events[seq - 1] : m.events.find(e => e?.seq === seq)) : null;
    return { ...(event ? { seq } : {}), at: Number.isFinite(event?.at) ? Math.max(0, event.at) : null };
  };
  const parsed = minutes.parse(m.summary);
  if (parsed.size) {
    for (const [itemId, item] of parsed) yield { sourceType: 'summary', itemId, text: item.text, ...reference(item.text) };
  }
  // 旧纪要可能混有编号条目和普通段落，两部分都能检索；章节标题不制造成批假命中。
  let n = 0;
  for (const text of String(m.summary || '').split(/\r?\n/)) if (text.trim() && !/^\s*#/.test(text) && !minutes.parse(text).size) yield { sourceType: 'summary', itemId: `paragraph-${++n}`, text, ...reference(text) };
  for (const e of Array.isArray(m.events) ? m.events : []) {
    if (!e || !['mark', 'transcript'].includes(e.kind)) continue;
    yield { sourceType: e.kind, seq: Number.isSafeInteger(e.seq) ? e.seq : undefined, text: e.text, at: Number.isFinite(e.at) ? Math.max(0, e.at) : null };
  }
  for (const q of Array.isArray(m.answers) ? m.answers : []) {
    if (!q) continue;
    const when = Number.isFinite(q.queuedAt) ? q.queuedAt : q.at;
    yield { sourceType: 'question', itemId: typeof q.id === 'string' && !/[\\/]/.test(q.id) ? q.id : undefined,
      text: `问：${q.q || ''} 答：${q.answer ?? q.a ?? ''}`, at: Number.isFinite(when) && Number.isFinite(m.startedAt) ? Math.max(0, when - m.startedAt) : null };
  }
}
function excerpt(text, terms) {
  const lower = fold(text), hits = terms.map(term => ({ term, start: lower.indexOf(term) })).filter(h => h.start >= 0)
    .sort((a, b) => a.start - b.start || b.term.length - a.term.length);
  const hit = hits[0], before = Array.from(text.slice(0, hit?.start || 0));
  const lead = Math.min(40, Math.max(0, Math.floor((120 - Math.min(120, Array.from(hit?.term || '').length)) / 2)));
  const from = before.slice(0, Math.max(0, before.length - lead)).join('').length;
  // code point 截断不拆表情；高亮位置是片段中的 UTF-16 下标，可直接用 JS slice。
  const snippet = Array.from(text.slice(from)).slice(0, Math.min(120, 80 + Math.max(...terms.map(t => Array.from(t).length)))).join('');
  const ranges = [], to = from + snippet.length;
  for (const term of terms) {
    for (let start = lower.indexOf(term, Math.max(0, from - term.length + 1)); start >= 0 && start < to; start = lower.indexOf(term, start + Math.max(1, term.length))) {
      if (start + term.length > from) ranges.push({ start: Math.max(0, start - from), end: Math.min(snippet.length, start + term.length - from) });
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const highlights = [];
  for (const r of ranges) {
    const last = highlights.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end); else highlights.push({ ...r });
  }
  return { snippet, highlights };
}
function compare(a, b) {
  const at = row => Number.isFinite(row.at) ? row.at : -1;
  return b.matches - a.matches || TYPES[b.sourceType][1] - TYPES[a.sourceType][1]
    || b.startedAt - a.startedAt || at(b) - at(a) || a.order - b.order;
}
// 最差项置顶的小堆，只留 offset+limit 条，避免常见词命中十万条时全量排序/复制片段。
class BestRows {
  constructor(limit) { this.limit = limit; this.rows = []; }
  push(row) {
    const a = this.rows;
    if (a.length < this.limit) {
      a.push(row); let i = a.length - 1;
      while (i) { const p = (i - 1) >> 1; if (compare(a[i], a[p]) <= 0) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
    } else {
      if (compare(row, a[0]) >= 0) return;
      a[0] = row; let i = 0;
      while (2 * i + 1 < a.length) {
        let c = 2 * i + 1; if (c + 1 < a.length && compare(a[c + 1], a[c]) > 0) c++;
        if (compare(a[c], a[i]) <= 0) break; [a[i], a[c]] = [a[c], a[i]]; i = c;
      }
    }
  }
}
function cacheFor(store) {
  let cache = caches.get(store);
  if (!cache) { cache = { rows: new Map(), bytes: 0 }; caches.set(store, cache); }
  return cache;
}
function drop(cache, id) {
  const row = cache.rows.get(id);
  if (row) { cache.bytes -= row.bytes; cache.rows.delete(id); }
}
async function projection(store, id, cache, pause) {
  const mark = typeof store.changeMark === 'function' ? await store.changeMark(id) : '';
  const prior = cache.rows.get(id);
  if (mark && prior?.mark === mark) { cache.rows.delete(id); cache.rows.set(id, prior); return prior; }
  drop(cache, id);
  const m = await (typeof store.peek === 'function' ? store.peek(id) : store.load(id));
  if (!m || m.id !== id || !Array.isArray(m.events)) throw new Error('会议内容无效');
  const entry = { mark, title: Array.from(safeText(m.title)).slice(0, 160).join(''), startedAt: Number.isFinite(Number(m.startedAt)) ? Number(m.startedAt) : 0, docs: [], bytes: 512 };
  for (const source of sources(m)) {
    const raw = String(source.text || '');
    const text = /[\\/:]/.test(raw) ? safeText(raw) : raw.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
    if (text) {
      const lower = fold(text); entry.docs.push({ ...source, text, lower });
      entry.bytes += text.length * 2 + (text === lower ? 0 : lower.length * 2) + 96;
    }
    const turn = pause(); if (turn) await turn;
  }
  // 构建期间保存了会议时，本次结果是读到的快照，下一次必须重读，不把旧片段挂在新版本上。
  const after = typeof store.changeMark === 'function' ? await store.changeMark(id) : '';
  if (mark && mark === after && entry.bytes <= CACHE_BYTES) {
    while (cache.rows.size >= CACHE_MEETINGS || cache.bytes + entry.bytes > CACHE_BYTES) drop(cache, cache.rows.keys().next().value);
    drop(cache, id); cache.rows.set(id, entry); cache.bytes += entry.bytes;
  }
  return entry;
}
async function searchMeetings(store, input = {}, { sliceMs = 4, yieldTurn = nextTurn } = {}) {
  const started = performance.now(); let opts;
  try { opts = request(input); } catch (error) { return { ok: false, error: error.message, items: [] }; }
  const { query, terms, offset, limit, from, to, meetingId } = opts;
  const result = { ok: true, query: safeText(query), total: 0, offset, limit, hasMore: false, items: [], skipped: 0 };
  if (!terms.length) return result;
  await yieldTurn();
  let list;
  try {
    // listIds 是存储层可选的轻量公开枚举，避免为搜索先把整批历史解析一遍。
    list = typeof store.listIds === 'function' ? (await store.listIds()).map(id => ({ id })) : await store.list();
  } catch { return { ok: false, error: '会议列表暂时不可读，请稍后重试', items: [] }; }
  const selected = (Array.isArray(list) ? list : []).filter(row => row && ID.test(row.id) && (!meetingId || row.id === meetingId)
    && !store.removing?.has?.(row.id) && (row.startedAt == null || Number(row.startedAt) >= from && Number(row.startedAt) <= to));
  const cache = cacheFor(store), present = new Set((Array.isArray(list) ? list : []).map(r => r?.id));
  for (const id of cache.rows.keys()) if (!present.has(id)) drop(cache, id);
  let heap, order, until = performance.now() + sliceMs;
  const pause = () => performance.now() >= until ? Promise.resolve(yieldTurn()).then(() => { until = performance.now() + sliceMs; }) : null;
  // 删除可能在setImmediate期间开始；仅在出现新删除ID时重扫，排除集合只增，最多重扫所选场数次。
  const deleting = new Set(); let changed;
  do {
    heap = new BestRows(offset + limit); order = 0; result.total = 0; result.skipped = 0;
  for (const row of selected) {
    await yieldTurn();
    if (deleting.has(row.id) || store.removing?.has?.(row.id)) { deleting.add(row.id); drop(cache, row.id); continue; }
    let entry; try { entry = await projection(store, row.id, cache, pause); } catch { result.skipped++; continue; }
    if (store.removing?.has?.(row.id)) { deleting.add(row.id); drop(cache, row.id); continue; }
    const { title, startedAt } = entry;
    if (startedAt < from || startedAt > to) continue;
    for (const doc of entry.docs) {
      if (terms.every(term => doc.lower.includes(term))) {
        result.total++;
        const { lower, ...source } = doc;
        heap.push({ ...source, meetingId: row.id, title, startedAt, matches: terms.length, order: order++ });
      }
      const turn = pause(); if (turn) await turn;
    }
  }
    changed = false;
    for (const row of selected) if (!deleting.has(row.id) && store.removing?.has?.(row.id)) { deleting.add(row.id); drop(cache, row.id); changed = true; }
  } while (changed);
  result.items = heap.rows.sort(compare).slice(offset, offset + limit).map(({ text, order: unused, matches, ...hit }) => ({ ...hit,
    sourceLabel: TYPES[hit.sourceType][0], time: atTime(hit.at), ...excerpt(text, terms) }));
  result.hasMore = offset + result.items.length < result.total;
  result.elapsedMs = Math.round((performance.now() - started) * 10) / 10;
  return result;
}
module.exports = { searchMeetings, request, safeText, excerpt, compare, atTime };
