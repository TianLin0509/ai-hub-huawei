'use strict';
// 密钥拦截（2026-11-20）：写进长期存储（助理记忆、组队计划）之前，先看文字里有没有密钥。
// 规则从严但不误伤：普通十六进制提交号（只有小写和数字）、UUID、普通网址都放行；
// 网关发的 key 多数以 sk- 开头，另认 Bearer、JWT、云厂商 AccessKey、私钥头、带「密钥/密码/token」标签的值、
// 网址参数里的 key=…，以及不在网址/路径/内嵌图片里、32 位以上大小写字母和数字混排的随机串（常见的 API Key 样子）。
// 纯函数：只返回命中的类别名，不回显密钥本身。

const RULES = [
  ['sk- 开头的 API Key', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['GitHub 令牌', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['云厂商 AccessKey', /\b(?:AKIA[0-9A-Z]{16}|LTAI[0-9A-Za-z]{12,})\b/],
  ['Google API Key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['私钥', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Bearer 令牌', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ['JWT 令牌', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['网址里的密钥参数', /[?&](?:api[_-]?key|apikey|access[_-]?token|token|key|secret|signature)=[^&\s#]{12,}/i],
  ['密码', /(?:password|passwd|pwd|密码|口令)\s*(?:是|为)?\s*[:：=]\s*\S{6,}/i],
];
// 标签 + 值。字段名前后可带引号（JSON：{"api_key":"…"}，Codex 审查 P1）。
// 明确的密钥字段名（api_key、secret、密钥…）：值 16 位以上、不是纯数字就算；
// 泛称（key、token）：值要 12 位以上且同时有字母和数字，这样「token 用量：120000」「key: introduction_section」不误伤。
const STRONG = /(?:api[_ -]?key|apikey|access[_ -]?key|secret[_ -]?key|client[_ -]?secret|secret|密钥|秘钥|令牌)["']?\s*(?:是|为)?\s*[:：=]\s*["'`]?([A-Za-z0-9._~+/=-]{16,})/gi;
const WEAK = /(?:token|key)["']?\s*(?:是|为)?\s*[:：=]\s*["'`]?([A-Za-z0-9._~+/=-]{12,})/gi;
// 无标签的随机串（Codex 审查 P2 收窄）：32 位以上、大小写字母和数字都有、不是十六进制摘要，
// 且不在网址、路径、data:/base64 里（图片地址、文件名、内嵌图片都放行）。
const RANDOM_TOKEN = /[A-Za-z0-9_-]{32,}/g;

function hasLetterAndDigit(s) { return /[A-Za-z]/.test(s) && /\d/.test(s); }
function looksRandom(s) { return /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && !/^[0-9a-fA-F]+$/.test(s); }
// 随机串所在的整段（按空白和引号切开）：带 / 、:// 、data: 、base64 的是网址、路径或内嵌数据。
function inUrlOrData(s, index, length) {
  let a = index, b = index + length;
  while (a > 0 && !/[\s"'`<>()\[\]{}]/.test(s[a - 1])) a--;
  while (b < s.length && !/[\s"'`<>()\[\]{}]/.test(s[b])) b++;
  return /[\/]|:\/\/|data:|base64/i.test(s.slice(a, b));
}

/** 返回命中的类别名（如「sk- 开头的 API Key」），没命中返回 null。 */
function findSecret(text) {
  const s = String(text == null ? '' : text);
  if (!s) return null;
  for (const [label, re] of RULES) if (re.test(s)) return label;
  for (const m of s.matchAll(STRONG)) if (!/^\d+$/.test(m[1])) return '带标签的密钥';
  for (const m of s.matchAll(WEAK)) if (hasLetterAndDigit(m[1])) return '带标签的密钥';
  for (const m of s.matchAll(RANDOM_TOKEN)) if (looksRandom(m[0]) && !inUrlOrData(s, m.index, m[0].length)) return '疑似 API Key 的随机串';
  return null;
}

// 组队计划（goal + 每人的 role/task/title）里含密钥就拒收：计划文件落盘、还会原样发给成员会话。
function assertPlanFree(args = {}) {
  const fields = [['goal', args && args.goal]];
  (Array.isArray(args && args.members) ? args.members : []).forEach((m, i) => {
    for (const k of ['task', 'role', 'title']) fields.push([`第 ${i + 1} 人的 ${k}`, m && m[k]]);
  });
  for (const [where, value] of fields) {
    const hit = findSecret(value);
    if (hit) throw Error(`计划的 ${where} 里疑似有密钥（${hit}），已拒收：密钥不进计划文件。请改写成「密钥在设置里，名称 X」后重新提交`);
  }
}

module.exports = { findSecret, assertPlanFree };
