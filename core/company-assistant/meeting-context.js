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
function compactEvents(events) {
  const rows = [];
  for (const e of events.filter(e => ['transcript', 'mark', 'slide'].includes(e.kind))) {
    const duplicate = e.kind === 'transcript' && [...rows].reverse().find(r => r.event.kind === 'transcript' && r.event.track !== e.track && Math.abs(r.event.at - e.at) <= 2500 && Math.min(r.event.end ?? r.event.at + 1000, e.end ?? e.at + 1000) >= Math.max(r.event.at, e.at) && similar(normalize(r.event.text), normalize(e.text)));
    if (duplicate) { duplicate.refs.push(e.seq); continue; }
    rows.push({ event: e, refs: [e.seq] });
  }
  return rows.map(({ event: e, refs }) => `[${refs.join(',')}] ${time(e.at)} ${e.kind === 'slide' ? '截图' : e.kind === 'mark' ? '重点' : e.track === 'mic' ? '麦克风' : '系统声音'} ${String(e.kind === 'slide' ? e.file : e.text).replace(/[\r\n]+/g, ' ')}`).join('\n');
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
module.exports = { compactEvents, similar, modelOptions, fastModel, selectedModel };
