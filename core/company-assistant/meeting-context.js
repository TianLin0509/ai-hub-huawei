'use strict';
const { localModelOptions } = require('../codeagent-config');
const { isSafeModelId } = require('../codeagent-models');
const time = ms => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const normalize = text => String(text || '').normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '').toLowerCase();
function similar(a, b) {
  if (a === b) return a.length > 0;
  // Ignore only ASR filler at the ends. A high fuzzy score can hide a changed number or a negation.
  const clean = s => s.replace(/^[嗯呃啊]+|[嗯呃啊]+$/g, '');
  return clean(a).length >= 4 && clean(a) === clean(b);
}
// names：发言人编号 → 名字（core/company-assistant/meeting-speakers.js）；分出了发言人就写名字，否则写音轨。
function compactEvents(events, names = {}) {
  const rows = [];
  for (const e of events.filter(e => ['transcript', 'mark', 'slide'].includes(e.kind))) {
    const duplicate = e.kind === 'transcript' && [...rows].reverse().find(r => r.event.kind === 'transcript' && r.event.track !== e.track && Math.abs(r.event.at - e.at) <= 2500 && Math.min(r.event.end ?? r.event.at + 1000, e.end ?? e.at + 1000) >= Math.max(r.event.at, e.at) && similar(normalize(r.event.text), normalize(e.text)));
    if (duplicate) { duplicate.refs.push(e.seq); continue; }
    rows.push({ event: e, refs: [e.seq] });
  }
  return rows.map(({ event: e, refs }) => `[${refs.join(',')}] ${time(e.at)} ${e.kind === 'slide' ? '截图' : e.kind === 'mark' ? '重点' : names[e.speaker] || (e.track === 'mic' ? '麦克风' : '系统声音')} ${String(e.kind === 'slide' ? e.file : e.text).replace(/[\r\n]+/g, ' ')}`).join('\n');
}
// 「问一下」只带最近 40 条原话，问到更早的内容就答不上（问答不能调工具）。按字的二元组和英文词与问题重合的多少，
// 从更早的原话里挑最相关的几条一起带上（2026-11-07）。不用分词库，中文二元组对会议口语够用。
const STOP = new Set('的了是在我你他们这那就也都和吧啊呢吗么个一不有没要说会对还'.split(''));
function grams(s) {
  const t = String(s || '').toLowerCase().replace(/[^\p{L}\p{N}.]/gu, ''), out = new Set();
  for (let i = 0; i + 1 < t.length; i++) { const a = t[i], b = t[i + 1]; if (!(STOP.has(a) && STOP.has(b))) out.add(a + b); }
  for (const w of t.match(/[a-z0-9.]{2,}/g) || []) out.add(w);
  return out;
}
function relevant(question, events, k = 12) {
  const q = grams(question); if (!q.size) return [];
  const scored = [];
  for (const e of events) { if (e.kind !== 'transcript' && e.kind !== 'mark') continue; const g = grams(e.text); let hit = 0; for (const x of g) if (q.has(x)) hit++; if (hit) scored.push([hit / g.size ** 0.3, e]); }
  const keep = new Set(scored.sort((a, b) => b[0] - a[0]).slice(0, k).map(x => x[1].seq));
  return events.filter(e => keep.has(e.seq));
}
function modelOptions(deps) {
  return (deps.meetingModels ? deps.meetingModels() : localModelOptions(deps.dataDir)).filter(m => isSafeModelId(m.id));
}
function fastModel(models) {
  return models.find(m => m.fast === true || m.speed === 'fast' || /(?:fast|flash|lite|极速|快速)/i.test(`${m.id} ${m.label}`))?.id
    || models.find(m => /minimax/i.test(m.id))?.id || '';
}
function selectedModel(m, deps) {
  if (m.speed !== 'fast') return '';
  const models = modelOptions(deps);
  if (m.fastModel) { if (!models.some(x => x.id === m.fastModel)) throw new Error('快速模型已不在可用清单中，请重新选择'); return m.fastModel; }
  return fastModel(models);
}
module.exports = { compactEvents, similar, relevant, modelOptions, fastModel, selectedModel };
