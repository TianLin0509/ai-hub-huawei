'use strict';
// 出口拦截（蒸馏自己）：画像里的句子、社区代答说出去之前都过这一道。
//   原话：和本人原聊天连续重合 ≥12 个字（去掉空白和标点后比）→ 拦；
//   人名、项目代号：和去敏同一套名单与规则 → 拦。
// corpus 是本人原话（只在内存里，由调用方加载；这里不存盘）。可以传字符串数组，也可以传 buildCorpusIndex 建好的索引（多次比对时省时间）。
const { scrub, hasName, hasCode } = require('./scrub');

const SPAN = 12;
const norm = s => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
const indexes = new WeakMap();

function buildCorpusIndex(texts) {
  const grams = new Set();
  for (const t of texts || []) {
    const s = norm(t);
    for (let i = 0; i + SPAN <= s.length; i += 1) grams.add(s.slice(i, i + SPAN));
  }
  return { grams, size: (texts || []).length };
}
function indexOf(corpus) {
  if (!corpus) return null;
  if (corpus.grams instanceof Set) return corpus;
  if (!Array.isArray(corpus)) return null;
  if (!indexes.has(corpus)) indexes.set(corpus, buildCorpusIndex(corpus));
  return indexes.get(corpus);
}
// 和原话重合的那一段（没有就返回空串）。
function overlap(text, corpus) {
  const idx = indexOf(corpus);
  if (!idx || !idx.grams.size) return '';
  const s = norm(text);
  for (let i = 0; i + SPAN <= s.length; i += 1) { const g = s.slice(i, i + SPAN); if (idx.grams.has(g)) return g; }
  return '';
}

// 另按去敏规则复查：命中敏感分类（人事、拍板、凭据、指令）→ sensitive。
function verbatimGuard(text, { corpus, names } = {}) {
  const s = String(text ?? '');
  if (s.trim() && scrub(s) === null) return { ok: false, text: '', hit: 'sensitive' };
  if (hasName(s, names)) return { ok: false, text: '', hit: 'name' };
  if (hasCode(s)) return { ok: false, text: '', hit: 'code' };
  if (overlap(s, corpus)) return { ok: false, text: '', hit: 'verbatim' };
  return { ok: true, text: s, hit: '' };
}

module.exports = { verbatimGuard, buildCorpusIndex, overlap, SPAN };
