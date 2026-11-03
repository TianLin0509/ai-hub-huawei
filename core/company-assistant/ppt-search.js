'use strict';

// Doctor counts quoted phrases separately. Remove quotes before bounding words,
// and count Unicode characters like Python so a cut never splits a surrogate pair.
function truncateQuery(value) {
  return Array.from(value.replace(/["'“”‘’「」『』《》＂＇]/gu, ' ')
    .split(/[\s\u001c-\u001f\u0085]+/u).filter(Boolean).slice(0, 16).join(' '))
    .slice(0, 200).join('').trim();
}

function queriesFor(args = {}) {
  const plan = args.plan || { queries: [args.query || ''] };
  if (!Array.isArray(plan.queries) || !plan.queries.length) throw new Error('计划应包含 1–16 个 queries');
  const raw = plan.query ? [{ query: plan.query, rationale: '用户原词' }, ...plan.queries] : plan.queries;
  const unique = new Map();
  for (const item of raw) {
    const q = typeof item === 'string' ? { query: item } : item;
    if (!q || typeof q.query !== 'string') throw new Error('每组查询需要文字');
    const query = truncateQuery(q.query), key = query.normalize('NFKC').toLowerCase();
    if (!query) throw new Error('每组查询需要有效文字');
    if (!unique.has(key)) unique.set(key, { query, rationale: String(q.rationale || '').slice(0, 250) });
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

module.exports = { truncateQuery, queriesFor, parallelQueries };
