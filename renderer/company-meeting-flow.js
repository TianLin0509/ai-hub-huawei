'use strict';

// 时间流只放会议本身：截图、原话、重点。问答 2026-11-24 起移到右栏「助手对话」，不再夹进时间流被新转写推走。
function flowEntries(meeting) {
  const events = (meeting?.events || []).filter(e => ['slide', 'transcript', 'mark'].includes(e.kind));
  const entries = events.map(event => ({ key: `event-${event.seq}`, kind: event.kind, at: event.at, event }));
  return entries.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || (a.event?.seq || 0) - (b.event?.seq || 0));
}

// 每条的版本号：只拼会影响显示的字段，不整条 JSON 序列化（长会议几千条，每 2.5 秒一轮）。
function entryVersion(entry) {
  if (!entry) return '';
  const e = entry.event || {};
  return [entry.kind, entry.at, e.seq, e.text, e.speaker, e.track, e.revisit ? 1 : 0, e.forced ? 1 : 0, e.audioSeq].join('\u0001');
}

// 发言人名字存在会议上、不在事件里，要算进指纹，否则改名后时间流不重画。
function flowStamp(id, meeting, entries) {
  const speakers = (meeting?.speakers?.list || []).map(s => s.id + ':' + s.name).join(',');
  return [id, speakers, entries.length, ...entries.map(entryVersion)].join('\u0002');
}

// Only index topics grounded by an existing event; never invent topics from timestamps.
function meetingNavigation(meeting) {
  const events = new Map((meeting?.events || []).map(e => [e.seq, e]));
  const topics = [];
  let inTopics = false, heading = '';
  const generic = /^(?:会议纪要|实时理解|会议理解|关键事实|事实|结论|决定(?:及其变化原因)?|决定及修订原因|行动项|待确认(?:问题)?|会议总结|出处|来源)$/;
  for (const line of String(meeting?.summary || '').split('\n')) {
    const header = line.match(/^#{1,6}\s+(.+)$/);
    if (header) {
      const name = header[1].replace(/\*\*/g, '').trim();
      inTopics = /^(?:当前)?(?:议题|主题)(?:索引|概览)?$/.test(name);
      heading = inTopics || generic.test(name) ? '' : name;
    }
    if (!inTopics && !heading) continue;
    const refs = [...line.matchAll(/\[事件\s*(\d+)\]/g)].map(m => events.get(Number(m[1]))).filter(e => Number.isFinite(e?.at));
    if (!refs.length) continue;
    const first = refs.sort((a, b) => a.at - b.at)[0];
    const title = (heading || line).replace(/^\s*(?:[-*+]\s+|\d+[.、]\s*)/, '').replace(/\[(?:事件[^\]]*|画面[^\]]*|[TFDAQ]\d{1,3})\]/g, '').replace(/[*#`]/g, '').trim();
    if (title && !topics.some(t => t.seq === first.seq && t.title === title)) topics.push({ title, seq: first.seq, at: first.at });
    heading = '';
  }
  if (topics.length) return { kind: 'topics', items: topics.sort((a, b) => a.at - b.at).slice(0, 16) };
  const anchors = [...events.values()].filter(e => e.kind === 'slide' || e.kind === 'mark').sort((a, b) => a.at - b.at || a.seq - b.seq);
  return { kind: 'time', items: anchors.map(e => ({ seq: e.seq, at: e.at, title: e.kind === 'mark' ? e.text || '会议重点' : '共享画面' })) };
}

module.exports = { flowEntries, flowStamp, entryVersion, meetingNavigation };
