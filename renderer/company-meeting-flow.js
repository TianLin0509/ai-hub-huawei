'use strict';

// Capture time includes pauses. Question timestamps use the same wall-clock origin.
function flowEntries(meeting) {
  const events = (meeting?.events || []).filter(e => ['slide', 'transcript', 'mark'].includes(e.kind));
  const entries = events.map(event => ({ key: `event-${event.seq}`, kind: event.kind, at: event.at, event }));
  const pending = (meeting?.answers || []).filter(q => ['queued', 'running'].includes(q.state));
  const active = pending.find(q => q.id === meeting?.questionJob?.questionId && meeting.questionJob.state !== 'error')
    || pending.find(q => q.state === 'running');
  // A retried older card keeps its timestamp, but cannot jump ahead of the claimed request.
  const queue = active ? [active, ...pending.filter(q => q !== active)] : pending;
  for (const question of meeting?.answers || []) {
    const asked = question.queuedAt ?? question.at;
    const at = Number.isFinite(asked) && Number.isFinite(meeting.startedAt) ? Math.max(0, asked - meeting.startedAt) : null;
    entries.push({ key: `question-${question.id}`, kind: 'question', at, question,
      queueAhead: question.state === 'queued' ? queue.indexOf(question) : null,
      afterMeeting: ['ended', 'interrupted'].includes(meeting.state) && at !== null && at > meeting.capturedMs });
  }
  return entries.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || (a.event?.seq || 0) - (b.event?.seq || 0));
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

module.exports = { flowEntries, meetingNavigation };
