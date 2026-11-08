'use strict';
// 分辨发言人（2026-11-07 用户确认要做）。转写组件给每句话（≥1 秒）算一个声纹向量（3D-Speaker CAM++，192 维单位向量），
// 这里按会议在线聚类：和已有发言人的平均声纹余弦相似度 ≥ THRESHOLD 就归给最像的那位，否则记为新发言人。
// 麦克风和系统声音分开聚类：同一个人很少同时出现在两路里，两路的音色也被各自的设备改变了。
// 阈值：合成三人会议上 0.4–0.6 都分得开；换成 6 个合成声音（4 男 2 女）时 0.5 会把相近的男声并成一人（6 人聚成 4 人），
// 0.6 聚成 5 人、0.75 才全分开但真人声音起伏大、会被拆碎。并错了用户没法改，拆开了可以把两位改成同一个名字，所以宁拆勿并，取 0.6。
const THRESHOLD = 0.6;
const MAX_SPEAKERS = 12;
const INHERIT_MS = 4000;

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const unit = v => { const n = Math.sqrt(dot(v, v)) || 1; return v.map(x => x / n); };

function book(m) { return (m.speakers ||= { next: 1, list: [] }); }

// 返回发言人编号；短句没有声纹时，紧跟同一路上一句（4 秒内）的算同一个人，否则不标。
function assign(m, track, voice, at) {
  const b = book(m);
  if (!Array.isArray(voice) || voice.length < 16) {
    const prev = [...m.events].reverse().find(e => e.kind === 'transcript' && e.track === track);
    return prev?.speaker && at - (prev.end ?? prev.at) <= INHERIT_MS ? prev.speaker : null;
  }
  const v = unit(voice);
  let best = null, score = -1;
  for (const s of b.list) if (s.track === track && s.centroid.length === v.length) { const c = dot(unit(s.centroid), v); if (c > score) { score = c; best = s; } }
  const full = b.list.length >= MAX_SPEAKERS;
  if (!best || (score < THRESHOLD && !full)) {
    const s = { id: b.next++, track, name: '', n: 1, centroid: v.map(x => Math.round(x * 1e4) / 1e4) };
    b.list.push(s); return s.id;
  }
  // 平均声纹按句数加权，越聊越稳；四位小数够用，省存储。
  best.centroid = best.centroid.map((x, i) => Math.round(((x * best.n + v[i]) / (best.n + 1)) * 1e4) / 1e4); best.n++;
  return best.id;
}

function names(m) {
  const out = {};
  for (const s of m.speakers?.list || []) out[s.id] = s.name || `发言人${s.id}`;
  return out;
}

function rename(m, id, name) {
  const s = (m.speakers?.list || []).find(x => x.id === Number(id));
  if (!s) throw new Error('没有这位发言人');
  const before = s.name || `发言人${s.id}`;
  s.name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  // 纪要里已经写成「发言人2」的负责人、提议人一并换成新名字（模拟评测里较强的模型也会把行动项记在「发言人N」名下）。
  const after = s.name || `发言人${s.id}`;
  if (m.summary && before !== after) m.summary = m.summary.replace(new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\d)', 'g'), after);
}

// 界面和导出只要名字与句数，不带声纹。
function publicList(m) { return (m.speakers?.list || []).map(s => ({ id: s.id, track: s.track, name: s.name, label: s.name || `发言人${s.id}`, lines: s.n })); }

module.exports = { assign, names, rename, publicList, THRESHOLD };
