'use strict';
// 只处理公司本机文件，不调用模型、网络或发送接口。
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const F = require('./fleet-rules'), R = require('./rules');
const REASONS = ['fact', 'tone', 'should_not_reply', 'too_long', 'missing_point', 'wrong_target'];
function read(file) {
  try { const rows = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(rows)) throw new Error('格式错误'); return rows; }
  catch (e) { if (e.code === 'ENOENT') return []; throw new Error('纠错卡读取失败，请保留文件并检查格式'); }
}
function write(file, cards) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(cards, null, 1), 'utf8'); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function create(file, item, { reason, correctAnswer, scope = 'this_avatar' } = {}, now = Date.now()) {
  const answer = String(correctAnswer ?? '').trim();
  if (!answer || answer.length > 3000) throw new Error('请填写不超过 3000 字的正确说法');
  if (!REASONS.includes(reason)) throw new Error('请选择纠错原因');
  if (!['this_avatar', 'all_avatars'].includes(scope)) throw new Error('请选择有效的生效范围');
  if (!String(item.text || '').trim() || R.sensitiveHit(item.text)) throw new Error('原问题为空或涉及敏感内容，不能保存纠错卡');
  if (R.sensitiveHit(answer) || /(?:password|secret|token|api[_ -]?key|密钥|口令)\s*[:：=]|\bsk-[A-Za-z0-9_-]{6,}/i.test(answer)) throw new Error('正确说法涉及敏感内容，未保存纠错卡，请去除敏感内容后再试');
  const cards = read(file);
  const nextNo = cards.reduce((m, c) => { const k = /^cor-(\d+)$/.exec(String(c?.id || '')); return k ? Math.max(m, Number(k[1])) : m; }, 0) + 1;
  const card = { id: 'cor-' + nextNo, version: 1, active: true, createdAt: now, revokedAt: 0, reason,
    question: F.safeText(item.text, 1200), oldAnswer: F.safeText(item.draft || '', 800), correctAnswer: F.safeText(answer, 3000), scope,
    sourceItemId: item.id, convName: F.safeText(item.convName || '', 120), source: 'user_correction' };
  cards.push(card); write(file, cards); return card;
}
function toggle(file, id, active, now = Date.now()) {
  if (typeof active !== 'boolean') throw new Error('请指定启用或撤销');
  const cards = read(file), card = cards.find(c => c.id === id); if (!card) throw new Error('找不到这张纠错卡');
  if (card.active !== active) { card.active = active; card.revokedAt = active ? 0 : now; card.version += 1; write(file, cards); }
  return { card, cards };
}
// 主题只按原问题匹配，避免正确答案中常见词把无关题召回。
function relevant(cards, query) {
  const q = topic(query); if (!q.size || R.sensitiveHit(query)) return [];
  return cards.filter(c => c.active && !R.sensitiveHit(c.correctAnswer) && !R.sensitiveHit(c.question)).filter(c => {
    const p = topic(c.question); let n = 0; for (const word of p) if (q.has(word)) n++;
    return p.size && n >= Math.min(2, p.size) && n / p.size >= 0.5 && n / q.size >= 0.5;
  }).sort((a, b) => b.createdAt - a.createdAt).map(c => `[纠错卡 #${c.id} v${c.version}] 原问题：${c.question} ｜ 正确口径：${c.correctAnswer} ｜ 错因：${c.reason} ｜ 依据注明「你的纠错卡 #${c.id}」`);
}
function topic(s) {
  const text = R.clean(s).toLowerCase().replace(/请问|麻烦|应该|如何|怎么|什么|哪里|为什么|能不能|可以|一下|谢谢/g, ' ');
  const parts = text.match(/[a-z][a-z0-9_.+-]*|[\p{Script=Han}]+/gu) || [];
  return new Set(parts.flatMap(p => /^[a-z]/.test(p) ? [p] : p.length < 2 ? [] : Array.from({ length: p.length - 1 }, (_, i) => p.slice(i, i + 2))));
}
function jsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function external(inbox, resolved) {
  const done = new Set(jsonl(resolved).map(r => r.id)), rows = new Map();
  for (const row of jsonl(inbox)) if (/^\d{8}-q\d+$/.test(row?.id)) rows.set(row.id, row);
  return [...rows.values()].filter(r => r.status === 'pending' && !done.has(r.id) && ['draft', 'promise'].includes(r.kind) && typeof r.conv === 'string' && r.conv && typeof r.question === 'string' && r.question.trim()).map(r => ({
    id: r.id, conv: r.conv, convName: F.safeText(r.convName || '', 120), askerName: F.safeText(r.askerName || '同事A', 80), question: F.safeText(r.question, 1200),
    answer: F.safeText(r.answer || '', 800), status: 'pending', basis: (Array.isArray(r.basis) ? r.basis : []).map(b => F.safeText(b, 300)),
    confidence: Math.max(0, Math.min(100, Number(r.confidence) || 0)), kind: r.kind, at: Number(r.at) || 0,
  }));
}
function resolve(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
}
function feedback(value, names = []) {
  let text = JSON.stringify(value, null, 2);
  for (const name of [...new Set(names.filter(n => typeof n === 'string' && n.trim().length >= 2))].sort((a, b) => b.length - a.length)) text = text.split(name).join('同事A');
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '［密钥已隐藏］')
    .replace(/\b(?:sk|pk|sess|token|ghp|gho|ghu|ghs|ghr|glpat|xoxb|xoxp)[-_][A-Za-z0-9_-]{6,}\b|\bAKIA[0-9A-Z]{12,}\b/gi, '［密钥已隐藏］')
    .replace(/((?:api[_ -]?key|authorization|bearer|token|secret|password|密钥|口令)\s*[:：=]?\s*)(?:\\?"[^"\r\n]*"|[^\s,，;；]+)(?:\s+[^\s,，;；]+)?/gi, '［密钥已隐藏］')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '［邮箱已隐藏］')
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d(?:[- ]?\d{4}){2}(?!\d)/g, '［手机号已隐藏］')
    .replace(/\b[a-z]{1,4}\d{6,9}\b/gi, '［工号已隐藏］').replace(/\b\d{8}\b/g, '［工号已隐藏］')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"\r\n]+/g, '［本机路径已隐藏］');
}
module.exports = { read, create, toggle, relevant, external, resolve, feedback };
