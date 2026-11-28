'use strict';
// 蒸馏自己（2026-11-28）：从本人 WeLink 消息里蒸馏出本机画像（说话的长短、口头禅、口吻、仿写例句、作息与习性），
// 本人勾选后供助理、分身、桌宠、社区、PPT 使用。画像只在本机；原话只在内存里用来做出口拦截，不另存。
// 方案：D:/AI-Artifacts/20261128-桌宠蒸馏WeLink方案（v2 定稿）；接口约定见任务目录。
const { scrub, hasName, hasCode } = require('./scrub');
const { computeStats } = require('./stats');
const { buildPrompt, parseModelOutput, CATS } = require('./prompt');
const { verbatimGuard, buildCorpusIndex } = require('./guard');
const { createStore, h16, APPLY_KEYS } = require('./store');
const { commitRisk } = require('../avatar/rules');
const { TOPIC_TEXTS } = require('./topic-words');

const MIN_MSGS = 20, LONG = 200;
const TARGETS = APPLY_KEYS;
const emptyApply = () => Object.fromEntries(APPLY_KEYS.map(k => [k, false]));

// 取材 → 去敏：rows 是档案记录（含别人的）；别人的消息只留时间戳。返回去敏后的行、计数和本人原话（只在内存）。
function prepare(rows, { names } = {}) {
  const out = [], originals = [];
  const dropped = { sensitive: 0, long: 0 };
  let msgs = 0;
  for (const r of rows || []) {
    if (!r || !Number.isFinite(Number(r.at))) continue;
    if (!r.m) { out.push({ at: Number(r.at), c: r.c, g: r.g }); continue; }
    const raw = String(r.t ?? '').trim();
    if (!raw || (r.ct && !/TEXT/i.test(r.ct))) continue;
    msgs += 1;
    originals.push(raw);
    if (raw.length > LONG) { dropped.long += 1; continue; }
    const t = scrub(raw, { names });
    if (t === null) { dropped.sensitive += 1; continue; }
    out.push({ m: 1, t, at: Number(r.at), c: r.c, g: r.g });
  }
  return { rows: out, msgs, kept: out.filter(r => r.m).length, dropped, originals };
}

// 重新蒸馏：locked 的条目原样保留（排在前面），其余换成新算的；同文字的新条目不重复。
function mergeLocked(prev = [], next = [], limit = 20) {
  const locked = (prev || []).filter(x => x && x.locked);
  const seen = new Set(locked.map(x => x.text));
  return [...locked, ...(next || []).filter(x => x && !seen.has(x.text))].slice(0, Math.max(limit, locked.length));
}

// 画像里不能出现原话、人名、代号、电话、链接、长数字或敏感内容：模型产出的口吻和例句逐条过闸，拦下的删掉。
function screen(items, guardOpts) { const kept = [], blocked = []; for (const x of items) (verbatimGuard(x.text, guardOpts).ok ? kept : blocked).push(x); return { kept, blocked }; }

// 画像 note 只放固定原因（审查 P1：底层异常正文可能带模型输出或原话，不进画像）。
const NOTES = {
  'few-msgs': n => `本人消息只有 ${n} 条（不到 ${MIN_MSGS} 条），先只出统计；等档案建好或消息多了再重新蒸馏`,
  'stats-only': () => '按「只统计」档，没有调用模型',
  'no-backend': () => '没找到可用的模型后端（CodeAgent 或「设置 › 功能模型 › 蒸馏自己」里选的后端），先只出统计',
  'bad-format': () => '模型回答的格式不对，这次先只出统计，可稍后重新蒸馏',
  'model-timeout': () => '模型超时没有回答，这次先只出统计，可稍后重新蒸馏',
  'model-failed': () => '模型调用没成功，这次先只出统计，可稍后重新蒸馏',
  blocked: n => `模型写的句子里有 ${n} 句和原话太像或带人名、代号、联系方式等，已删掉`,
};
const noteOf = (code, n) => (code && NOTES[code] ? NOTES[code](n) : '');

// 把新算的画像和已有画像合并：locked 条目原样保留，tags 的勾选和 apply 开关沿用已有的。
// 服务在写回前用「最新」画像再合一次（蒸馏期间本人保存、改开关不会被冲掉）。
function mergePrevious(fresh, previous) {
  const prev = previous || {};
  const prevTags = new Map((prev.tags || []).map(t => [t.text, t]));
  const freshTags = fresh.tags || [];
  return {
    ...fresh,
    createdAt: prev.createdAt || fresh.createdAt || 0,
    speak: {
      ...fresh.speak,
      catchphrases: mergeLocked(prev.speak?.catchphrases, fresh.speak.catchphrases, 12),
      tone: mergeLocked(prev.speak?.tone, fresh.speak.tone, 14),
      examples: mergeLocked(prev.speak?.examples, fresh.speak.examples, 16),
    },
    habits: { ...fresh.habits, topics: mergeLocked(prev.habits?.topics, fresh.habits.topics, 8) },
    tags: [...(prev.tags || []).filter(t => t.on && !freshTags.some(x => x.text === t.text)), ...freshTags.map(t => ({ ...t, on: !!prevTags.get(t.text)?.on }))],
    apply: { ...emptyApply(), ...(prev.apply || {}) },
  };
}

// 一次完整蒸馏（纯流程，不碰文件）：返回 { portrait（已与 previous 合并）, fresh（未合并）, note, noteCode, counts }。
//   runModel(prompt) → 模型回答文字；statsOnly 或本人消息不足 20 条时不调。noBackend：没有可用后端（同样不调）。
async function distill({ rows, names = [], source = {}, previous = null, statsOnly = false, noBackend = false, backend = { kind: 'stats-only', model: '' }, runModel = null, onStep = () => {} } = {}) {
  onStep({ step: 'scrub', text: '去掉人名、工号、链接和敏感内容' });
  const prep = prepare(rows, { names });
  onStep({ step: 'scrub', text: `本人消息 ${prep.msgs} 条，保留 ${prep.kept} 条，丢弃敏感 ${prep.dropped.sensitive} 条、过长 ${prep.dropped.long} 条`, n: prep.kept, total: prep.msgs });
  onStep({ step: 'stats', text: '统计消息长短、口头禅、作息和回复快慢' });
  const st = computeStats(prep.rows);
  const guardOpts = { corpus: buildCorpusIndex(prep.originals), names };
  let tone = [], examples = [], code = '', codeN = 0, used = { kind: 'stats-only', model: '' };
  if (prep.kept < MIN_MSGS) { code = 'few-msgs'; codeN = prep.kept; }
  else if (statsOnly) code = 'stats-only';
  else if (noBackend || !runModel) code = 'no-backend';
  else {
    // 取样按全局时间排序后取最近的（多会话拼接时不偏向最后遍历的会话）。
    const samples = prep.rows.filter(r => r.m).sort((x, y) => x.at - y.at).map(r => r.t);
    onStep({ step: 'model', text: `用 ${backend.label || backend.kind} 提炼口吻和仿写例句（送去敏后的 ${Math.min(prep.kept, 300)} 条）` });
    try {
      const parsed = parseModelOutput(await runModel(buildPrompt(samples)));
      if (!parsed) code = 'bad-format';
      else {
        const a = screen(parsed.tone, guardOpts), b = screen(parsed.examples, guardOpts);
        tone = a.kept; examples = b.kept; used = { kind: backend.kind, model: backend.model || '' };
        if (a.blocked.length + b.blocked.length) { code = 'blocked'; codeN = a.blocked.length + b.blocked.length; }
      }
    } catch (e) { code = e && e.timedOut ? 'model-timeout' : 'model-failed'; }
  }
  // 统计出的口头禅也过一遍闸（短句一般不会命中原话 12 字，主要拦人名、代号和联系方式）。
  const catchphrases = st.catchphrases.filter(c => !hasName(c.text, names) && !hasCode(c.text));
  const note = noteOf(code, codeN);
  const fresh = {
    v: 1, createdAt: 0, updatedAt: 0,
    source: { kind: source.kind || 'archive', msgs: prep.msgs, kept: prep.kept, dropped: prep.dropped, days: st.days },
    backend: used,
    speak: { stats: st.stats, catchphrases, tone: [...st.tone, ...tone], examples },
    habits: { ...st.habits },
    tags: st.tags,
    apply: emptyApply(),
    note, noteCode: code,
  };
  const portrait = mergePrevious(fresh, previous);
  return { portrait, fresh, note, noteCode: code, corpus: guardOpts.corpus, counts: { msgs: prep.msgs, kept: prep.kept, dropped: prep.dropped, tone: portrait.speak.tone.length, examples: portrait.speak.examples.length } };
}

// 界面保存：patch 是局部对象，数组整段替换（{ speak:{ catchphrases?, tone?, examples? }, habits:{ topics? }, tags? }）。
// 本人改过文字的条目自动锁定，重新蒸馏时不被覆盖。
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
function cleanList(list, prev, kind) {
  if (!Array.isArray(list)) return prev;
  const old = new Map((prev || []).map(x => [x.id, x]));
  const out = [];
  for (const x of list.slice(0, 40)) {
    let text = clip(x?.text, kind === 'examples' ? 80 : 60); if (!text) continue;
    const before = old.get(x?.id);
    // 关心的领域只能锁定、删除，不能改字，且必须是白名单词（审查口径）。
    if (kind === 'topics') { if (before) text = before.text; if (!TOPIC_TEXTS.includes(text)) continue; }
    const id = typeof x?.id === 'string' && x.id ? x.id.slice(0, 40) : require('./stats').idOf('u', kind + text);
    const row = { id, text, locked: !!x?.locked || (kind !== 'topics' && ((!!before && before.text !== text) || !before)) };
    if (kind === 'examples') row.cat = CATS.includes(x?.cat) ? x.cat : (before?.cat || 'chat');
    if (kind === 'tone') row.basis = clip(x?.basis ?? before?.basis ?? '本人填写', 80);
    if (kind === 'catchphrases' || kind === 'topics') row.n = Number(before?.n ?? x?.n) || 0;
    out.push(row);
  }
  return out;
}
function applyPatch(p, patch = {}) {
  const next = { ...p, speak: { ...p.speak }, habits: { ...p.habits } };
  for (const k of ['catchphrases', 'tone', 'examples']) if (patch.speak && k in patch.speak) next.speak[k] = cleanList(patch.speak[k], p.speak?.[k], k);
  if (patch.habits && 'topics' in patch.habits) next.habits.topics = cleanList(patch.habits.topics, p.habits?.topics, 'topics');
  if (Array.isArray(patch.tags)) next.tags = patch.tags.slice(0, 20).map(t => ({ id: clip(t?.id, 40) || require('./stats').idOf('g', clip(t?.text, 20)), text: clip(t?.text, 20), on: !!t?.on })).filter(t => t.text);
  return next;
}

// ---- 给各功能的精简内容（apply 关时返回 null，调用方保持原样） ----
const texts = list => (list || []).map(x => x.text).filter(Boolean);
const quote = list => list.map(t => `「${t}」`).join('');
function lengthLine(s) { return s?.median ? `消息一半不超过 ${s.median} 字，九成不超过 ${s.p90} 字` : ''; }
function styleLines(p) {
  const s = p.speak?.stats || {}, lines = [];
  const len = lengthLine(s); if (len) lines.push(len);
  if (s.periodRate !== undefined && s.periodRate < 10) lines.push('句末基本不加句号');
  const cp = texts(p.speak?.catchphrases).slice(0, 8); if (cp.length) lines.push('常用短回复：' + quote(cp));
  for (const t of texts(p.speak?.tone)) if (!lines.includes(t)) lines.push(t);
  return lines;
}
const cap = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function habitsOf(p) {
  const h = p.habits || {};
  return { hours: Array.isArray(h.hours) ? h.hours.slice(0, 24) : Array(24).fill(0), activeFrom: h.activeFrom ?? 9, activeTo: h.activeTo ?? 18,
    dailyMsgs: h.dailyMsgs || 0, replyMedianMin: h.replyMedianMin || 0, topics: texts(h.topics) };
}
function shape(p, target) {
  if (!p || !p.apply || !p.apply[target]) return null;
  if (target === 'assistant') {
    const lines = styleLines(p); if (!lines.length) return null;
    return cap(['说话风格（本人「蒸馏自己」画像；替我起草 WeLink 回复、邮件、简报时照这个写，回答我本人的问题时不用模仿）：', ...lines.map(l => '- ' + l)].join('\n'), 400);
  }
  if (target === 'avatar') {
    const lines = styleLines(p); if (!lines.length) return null;
    return { persona: cap(lines.join('\n'), 1200), samples: texts(p.speak?.examples).slice(0, 12) };
  }
  if (target === 'pet') {
    return { catchphrases: texts(p.speak?.catchphrases), examples: (p.speak?.examples || []).filter(e => e.cat === 'chat').map(e => e.text), habits: habitsOf(p) };
  }
  if (target === 'community') {
    const lines = styleLines(p);
    return { toneText: cap(lines.join('；'), 300), examples: texts(p.speak?.examples), habits: habitsOf(p), tags: (p.tags || []).filter(t => t.on).map(t => t.text) };
  }
  if (target === 'ppt') {
    const s = p.speak?.stats || {}, parts = [];
    if (s.median) parts.push(`句子短，一般不超过 ${Math.max(s.p90 || 0, 12)} 字，能用短句不用长句`);
    const tp = texts(p.habits?.topics).slice(0, 6); if (tp.length) parts.push('常用领域词：' + tp.join('、'));
    if (s.enMixRate >= 15) parts.push('术语直接用英文缩写');
    if (!parts.length) return null;
    return cap('本人用词习惯（只用于讲解词和要点用词；汇报页仍用汇报口吻，不带聊天语气）：' + parts.join('；'), 200);
  }
  return null;
}
// target ∈ assistant|avatar|pet|community|ppt。owner 不给时按最近一次写画像的账号找（桌宠等拿不到账号的地方用）。
function forTarget({ dataDir, owner, target, store } = {}) {
  if (!TARGETS.includes(target)) return null;
  try {
    const s = store || createStore({ dataDir });
    return shape(owner ? s.read(owner) : s.readCurrent(), target);
  } catch { return null; }
}

module.exports = {
  scrub, computeStats, buildPrompt, parseModelOutput, verbatimGuard, buildCorpusIndex, createStore, forTarget, shape,
  prepare, distill, mergePrevious, noteOf, mergeLocked, applyPatch, commitRisk, h16, TARGETS, MIN_MSGS, emptyApply,
};
