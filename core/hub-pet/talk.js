'use strict';
// 桌宠闲聊怎么挑句子、怎么记住回应（2026-11-17 r27g）。纯逻辑，方便单测；话术原文在 talk-lines.js。
// - 按情境（早上、午饭、下午、回来、久坐、连着答完、散会、下班、深夜）和日子（周一、周五、周末）挑句子；
// - 说过的句子记在 recent 里（存进 hub-pet.json），短期内不重复，整组都说过才从最早说的那句重来；
// - 回应按钮记进 prefs：某类被点「少说」越多，挑中的机会越小；净少说两次以上，这一类基本不再主动说。
const { ACKS, CTX_CHIPS, LINES, TYPE_CHIPS } = require('./talk-lines');

const TYPES = Object.freeze(['care', 'cheer', 'chat']);
const RECENT_MAX = 60;         // 记住最近说过的 60 句（每天三五句，约两周不重复）
const PREF_MAX = 20;
const NAME_MAX = 8;

// 句子的稳定编号：按原文算，句子增删不影响别的句子的「说过没有」。
function lineId(ctx, s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return ctx + '-' + h.toString(36);
}

// 名字：去掉控制字符、括号与尖括号，最多 8 个字；空串表示不起名。
function cleanName(value) {
  return Array.from(String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f{}<>]+/g, '').replace(/\s+/g, ' ').trim()).slice(0, NAME_MAX).join('').trim();
}

function normalizePrefs(raw) {
  const out = {};
  for (const t of TYPES) {
    const v = raw && typeof raw === 'object' ? raw[t] : null;
    const n = k => Math.max(0, Math.min(PREF_MAX, Math.round(Number(v && v[k]) || 0)));
    out[t] = { up: n('up'), down: n('down') };
  }
  return out;
}

function normalizeRecent(raw) {
  return Array.isArray(raw) ? raw.filter(id => typeof id === 'string' && /^[\w-]{1,40}$/.test(id)).slice(-RECENT_MAX) : [];
}

// 一类话的权重：每次「喜欢」+0.2，每次「少说」-0.5，夹在 0.1–2 之间。
function typeWeight(prefs, type) {
  const p = (prefs && prefs[type]) || {};
  return Math.max(0.1, Math.min(2, 1 + 0.2 * (Number(p.up) || 0) - 0.5 * (Number(p.down) || 0)));
}

function dayOk(d, date) {
  if (!d) return true;
  const w = date.getDay();
  if (d === 'mon') return w === 1;
  if (d === 'fri') return w === 5;
  if (d === 'weekend') return w === 0 || w === 6;
  if (d === 'weekday') return w >= 1 && w <= 5;
  return false;
}

// 挑一句。返回 { id, ctx, type, text, named, chips } 或 null（这一情境此刻不说）。
// opts：{ now, name, prefs, recent, rng }。rng 默认 Math.random，单测里固定。
function pickLine(ctx, { now = Date.now(), name = '', prefs = null, recent = [], rng = Math.random } = {}) {
  const pool = LINES[ctx];
  if (!pool) return null;
  const date = new Date(now);
  // 当天限定的句子（周一、周五、周末）优先：有就只在它们和通用句里挑，权重翻倍，让「周一了」这类话更容易出现。
  const all = pool.filter(l => dayOk(l.d, date)).map(l => ({ ...l, id: lineId(ctx, l.s), w: typeWeight(prefs, l.t) * (l.d ? 2 : 1) }));
  if (!all.length) return null;
  // 少说的类型：整组里最高的权重都很低时，这次就按概率不说（净少说两次以上基本不说，「少说」不是「从此不说」）。
  const best = Math.max(...all.map(l => typeWeight(prefs, l.t)));
  if (best < 1 && rng() > best) return null;
  const seen = new Set(normalizeRecent(recent));
  let cand = all.filter(l => !seen.has(l.id));
  if (!cand.length) {
    // 整组都说过：从最早说的那几句里重新挑（recent 越靠前越早）。
    const order = normalizeRecent(recent);
    const rank = id => { const i = order.indexOf(id); return i < 0 ? -1 : i; };
    const sorted = all.slice().sort((a, b) => rank(a.id) - rank(b.id));
    cand = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 3)));
  }
  const total = cand.reduce((s, l) => s + l.w, 0);
  let r = rng() * total, line = cand[cand.length - 1];
  for (const l of cand) { r -= l.w; if (r <= 0) { line = l; break; } }
  const nm = cleanName(name);
  const named = !!nm && line.s.includes('{name}');
  // 用替换函数：名字按字面插入，$& $' 这类字符不被当成替换模式（r27g 审查第 3 项）。
  const text = line.s.replace(/\{name\}/g, () => nm || '我');
  const chips = (CTX_CHIPS[ctx] || TYPE_CHIPS[line.t] || []).map(([id, label]) => ({ id, label }));
  return { id: line.id, ctx, type: line.t, text, named, chips };
}

// 记一句说过了：返回新的 recent（不改原数组）。
function noteSpoken(recent, id) {
  const list = normalizeRecent(recent).filter(x => x !== id);
  list.push(id);
  return list.slice(-RECENT_MAX);
}

// 记一次回应：返回 { prefs, ack }。choice：up / down / snooze；ctx 用来挑情境专属的回话（久坐提醒）。
function applyReply(prefs, { type, choice, name = '', ctx = '' } = {}) {
  const next = normalizePrefs(prefs);
  const nm = cleanName(name) || '我';
  if (choice === 'snooze') return { prefs: next, ack: ACKS.snooze };
  if (!TYPES.includes(type) || (choice !== 'up' && choice !== 'down')) return { prefs: next, ack: '' };
  const p = next[type];
  if (choice === 'up') { p.up = Math.min(PREF_MAX, p.up + 1); if (p.down > 0) p.down -= 1; }
  else p.down = Math.min(PREF_MAX, p.down + 1);
  const byCtx = ACKS.ctx && ACKS.ctx[ctx] && ACKS.ctx[ctx][choice];
  return { prefs: next, ack: String(byCtx || ACKS[choice][type] || '').replace(/\{name\}/g, () => nm) };
}

function lineCount() {
  return Object.values(LINES).reduce((n, list) => n + list.length, 0);
}

module.exports = { NAME_MAX, RECENT_MAX, TYPES, applyReply, cleanName, lineCount, lineId, noteSpoken, normalizePrefs, normalizeRecent, pickLine, typeWeight };
