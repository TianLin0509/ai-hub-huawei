'use strict';
// 去敏（蒸馏自己）：送模型之前、写进画像之前各过一遍。纯函数。
//   1. 命中替身的敏感分类（人事、拍板、凭据、指令）→ 整条丢弃（返回 null）；
//   2. 本机见过的姓名 → 「某同事」；
//   3. 链接、邮箱、工号、电话、长数字串、英文大写加数字的代号 → 占位。
// 白名单里的领域词（如 3GPP）不当代号替换。
const { sensitiveHit } = require('../avatar/rules');
const { TOPIC_TEXTS } = require('./topic-words');

const KEEP = new Set(TOPIC_TEXTS.map(t => t.toUpperCase()).concat(['5G', '4G', '6G', 'LTE', 'NR', 'OK', 'PPT']));
const URL = /\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// 工号：一个字母加 7–8 位数字（常见写法），或单独的 8 位数字串前带字母。
const STAFF = /(?<![A-Za-z0-9])[A-Za-z]\d{7,8}(?![A-Za-z0-9])/g;
const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)|(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g;
const LONGNUM = /\d{6,}/g;
// 代号：至少一个大写字母和一个数字，长 3 位以上（如 AB12、X5-PRO）；纯大写缩写（MIMO）和白名单词不动。
const CODE = /(?<![A-Za-z0-9])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9][A-Za-z0-9_-]{2,}(?![A-Za-z0-9])/g;
const codeHit = token => !KEEP.has(token.toUpperCase());

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameCache = new WeakMap();
// 名单 → 一个正则（长名优先，避免「张三丰」被「张三」截一半）。只收 2 个字以上的名字。
function namePattern(names) {
  if (!names) return null;
  const key = Array.isArray(names) ? names : null;
  if (key && nameCache.has(key)) return nameCache.get(key);
  const list = [...new Set([...(names || [])].map(n => String(n || '').trim()).filter(n => n.length >= 2 && n.length <= 20))].sort((a, b) => b.length - a.length);
  const re = list.length ? new RegExp(list.map(esc).join('|'), 'g') : null;
  if (key) nameCache.set(key, re);
  return re;
}

function scrub(text, { names } = {}) {
  let s = String(text ?? '').replace(/\r/g, '').trim();
  if (!s) return null;
  if (sensitiveHit(s)) return null;
  const re = namePattern(names);
  if (re) s = s.replace(re, '某同事');
  s = s.replace(URL, '[链接]').replace(EMAIL, '[邮箱]').replace(STAFF, '[工号]').replace(PHONE, '[电话]').replace(LONGNUM, '[数字]')
    .replace(CODE, m => (codeHit(m) ? '[代号]' : m));
  return s;
}

// 出口拦截用：这段话里有没有人名或代号（不改写，只判断）。
function hasName(text, names) { const re = namePattern(names); return !!re && String(text || '').search(re) >= 0; }
// 链接、电话、长数字串也算（审查 P1：模型产出的句子要和去敏同一套边界）。
function hasCode(text) {
  const s = String(text || '');
  if (s.match(URL) || s.match(EMAIL) || s.match(STAFF) || s.match(PHONE) || s.match(LONGNUM)) return true;
  return (s.match(CODE) || []).some(codeHit);
}

module.exports = { scrub, hasName, hasCode, namePattern };
