'use strict';
// 会议页增量拉取的合并（2026-11-25 后台开销）：主进程 status(id, since) 对得上版本时只回 meetingDelta，
// 这里把它合进页面手里那一份，得到和全量一样的会议。不改 prev（问答卡合并 mergeQuestionState 要拿新旧两份对比）。
function applyMeetingDelta(prev, delta) {
  if (!prev || !delta || prev.id !== delta.id) return null;
  const next = { ...prev, ...(delta.fields || {}) };
  for (const k of delta.unset || []) delete next[k];
  if (delta.events?.length) {
    const events = prev.events.slice();
    for (const e of delta.events) {
      const i = e.seq - 1;
      if (events[i]?.seq === e.seq) events[i] = e;
      else { const j = events.findIndex(x => x.seq === e.seq); if (j >= 0) events[j] = e; else events.push(e); }
    }
    if (events.some((e, i) => i && events[i - 1].seq > e.seq)) events.sort((a, b) => a.seq - b.seq);
    next.events = events;
  }
  if (delta.answers?.length) {
    const answers = prev.answers.slice(), at = new Map(answers.map((q, i) => [q.id, i]));
    for (const q of delta.answers) { if (at.has(q.id)) answers[at.get(q.id)] = q; else { at.set(q.id, answers.length); answers.push(q); } }
    next.answers = answers;
  }
  // 不在本次增量里的问题，上一份带的 live（在答进度）已过时：主进程没再给，说明它已不在途。
  if (next.answers !== prev.answers || prev.answers.some(q => q.live)) {
    const fresh = new Set((delta.answers || []).map(q => q.id));
    next.answers = (next.answers === prev.answers ? prev.answers.slice() : next.answers).map(q => q.live && !fresh.has(q.id) ? (({ live, ...rest }) => rest)(q) : q);
  }
  return next;
}
// 拉状态的规则（复审 2026-11-25 两条 P2）：
// 1. 会议页隐藏时任何入口（定时器、问答推送安排的详情刷新、模型清单更新）都不拉，返回 null；推送照常改页面手里的状态，切回时补全量。
// 2. 全量标记在发起请求时就消费掉；请求失败时还回去。请求在途时又被标记（切走再切回），留给下一次，不会被旧响应清掉。
// getState 在响应回来时取页面当前那份（期间可能被推送改过），增量合进它。
function createStatusPuller({ call, hidden }) {
  let full = true;
  return {
    markFull() { full = true; },
    get fullPending() { return full; },
    async pull(id, getState) {
      if (hidden()) return null;
      const wantFull = full, before = getState(); full = false;
      const since = !wantFull && id && before?.meeting?.id === id && before.meetingRev?.id === id ? before.meetingRev : null;
      let next;
      try { next = await call('meeting-status', since ? { id, since } : { id }); }
      catch (e) { if (wantFull) full = true; throw e; }
      if (next?.meetingDelta) {
        const merged = applyMeetingDelta(getState()?.meeting, next.meetingDelta);
        if (!merged) { full = true; return { retry: true }; } // 手里那份对不上（不该发生）：下一次拉全量
        next.meeting = merged; delete next.meetingDelta;
      }
      return { next, wasFull: !since };
    },
  };
}
module.exports = { applyMeetingDelta, createStatusPuller };
