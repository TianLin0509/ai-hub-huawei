'use strict';

// Doctor counts a quoted phrase as one term. Preserve valid phrases and count
// Unicode characters like Python so a cut never splits a surrogate pair.
function splitQuery(value, maxChars = 200) {
  const normalized = value.replace(/[“”「」『』《》＂]/gu, '"');
  const words = [];
  for (const match of normalized.matchAll(/"([^"]+)"|[^"\s\u001c-\u001f\u0085]+/gu)) {
    const content = (match[1] ?? match[0]).replace(/[\s\u001c-\u001f\u0085]+/gu, ' ').trim();
    if (!/[^"'‘’＇\s]/u.test(content)) continue;
    const token = match[1] === undefined ? content : `"${content}"`;
    // An overlong phrase cannot fit the protocol; retain its words as separate groups.
    if (match[1] !== undefined && Array.from(token).length > maxChars) words.push(...content.split(' '));
    else words.push(token);
  }
  const groups = [];
  let current = [], chars = 0;
  for (const word of words) {
    // A single unspaced token retains the previous character bound (including CJK).
    const token = Array.from(word).slice(0, maxChars).join('');
    const length = Array.from(token).length;
    if (current.length && (current.length === 16 || chars + 1 + length > maxChars)) {
      groups.push(current.join(' ')); current = []; chars = 0;
    }
    chars += (current.length ? 1 : 0) + length;
    current.push(token);
  }
  if (current.length) groups.push(current.join(' '));
  return groups;
}

function truncateQuery(value) { return splitQuery(value)[0] || ''; }

function queriesFor(args = {}) {
  const plan = args.plan || { queries: [args.query || ''] };
  if (!Array.isArray(plan.queries) || !plan.queries.length) throw new Error('计划应包含 1–16 个 queries');
  const raw = plan.query ? [{ query: plan.query, rationale: '用户原词' }, ...plan.queries] : plan.queries;
  const unique = new Map();
  for (const item of raw) {
    const q = typeof item === 'string' ? { query: item } : item;
    if (!q || typeof q.query !== 'string') throw new Error('每组查询需要文字');
    const groups = splitQuery(q.query);
    if (!groups.length) throw new Error('每组查询需要有效文字');
    for (const query of groups) {
      const key = query.normalize('NFKC').toLowerCase();
      if (!unique.has(key)) unique.set(key, { query, rationale: String(q.rationale || '').slice(0, 250) });
      if (unique.size === 16) break;
    }
    if (unique.size === 16) break;
  }
  return [...unique.values()];
}

// Each process retains its own timeout. Partial failure never becomes zero hits.
async function parallelQueries(sources, args, run) {
  const queries = queriesFor(args);
  const jobs = sources.flatMap(source => queries.map(query => ({ source, query })));
  const responses = await Promise.all(jobs.map(async ({ source, query }) => {
    try {
      const result = await run(source, query);
      if (result.ok === false) throw new Error(result.error?.message || result.error || '查询失败');
      return { source, query, result };
    } catch (error) { return { source, query, error }; }
  }));
  const successes = responses.filter(r => !r.error), errors = responses.filter(r => r.error).map(r => ({ source: r.source.label, query: r.query.query, message: r.error.message }));
  if (!successes.length) throw new Error(errors.map(e => `${e.source} / ${e.query}：${e.message}`).join('；'));
  return { successes, errors };
}

module.exports = { truncateQuery, splitQuery, queriesFor, parallelQueries };
