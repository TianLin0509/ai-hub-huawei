'use strict';
// 库地图与提炼共用的文字工具（r28，2026-11-17）。
// 规范化规则与 pptutor_core/text.py 的 comparable 一致：NFKC + casefold + 合并空白（Python 侧装了 opencc 时另做繁转简，这里不做）。
const crypto = require('node:crypto');

const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase();
const comparable = text => normalize(text).replace(/\s+/g, ' ').trim();
const pageHash = text => crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
const stableHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);

// 引文必须是该页文字的连续片段（至少 4 个字），与 report 的 validate_quote 同一口径。
function quoteInPage(quote, text) {
  const q = comparable(quote);
  return q.length >= 4 && comparable(text).includes(q);
}

// r28d：数值、单位、比较方向、前提的解析与比较已移到 ppt-claim.js（从原文摘录解析，不再核对模型转述）。

// 页标题：首个非空、不太长的行（索引没有标题字段，catalog 的 heading 也是现场推的）。
function pageTitle(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (t && t.length <= 60) return t;
  }
  return '';
}

module.exports = { normalize, comparable, pageHash, stableHash, quoteInPage, pageTitle };
