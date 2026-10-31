'use strict';
// Shared by the sidebar and assistant: runtime truth and attention are Hub-owned.
const {isGroupChatMemberRunning,GC_WORKING_FRESH_MS}=require('./groupchat-running-state');
const {sessionHasCompletedUnread}=require('./session-attention-state');
const {sessionRuntimeIssue}=require('./session-runtime-issue');
const {compareLatestActivityDesc,latestActivityTime,positiveTimestamp}=require('./session-recency');
const {RUNTIME_WAITING,RUNTIME_DORMANT,RUNTIME_UNKNOWN,getSessionRuntimeTruth,sessionRuntimeIsActive}=require('./session-runtime-truth');

// Session objects are mutated in place throughout the renderer. Track the
// fields a projection actually reads rather than trusting object identity or
// maintaining a second, easily outdated whitelist. Nested metadata is small;
// a detached snapshot also detects in-place edits to runtime/model metadata.
// Only pure, session-local projections belong here; external inputs use token.
function createSessionProjectionCache() {
  const entries = new WeakMap();
  function capture(value, depth = 0) {
    if (!value || typeof value !== 'object') return value;
    const prototype = Object.getPrototypeOf(value);
    if (depth > 20) throw new TypeError('recursive metadata');
    if (value instanceof Set || value instanceof Map) return { collection: prototype, values: [...value].map(item => capture(item, depth + 1)) };
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) throw new TypeError('non-plain metadata');
    const keys = Object.keys(value);
    return { prototype, length: Array.isArray(value) ? value.length : null, keys,
      values: keys.map(key => capture(value[key], depth + 1)) };
  }
  function matches(value, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return Object.is(value, snapshot);
    if (snapshot.collection) {
      if (!value || Object.getPrototypeOf(value) !== snapshot.collection || value.size !== snapshot.values.length) return false;
      let i = 0;
      for (const item of value) if (!matches(item, snapshot.values[i++])) return false;
      return true;
    }
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== snapshot.prototype
        || (snapshot.length !== null && value.length !== snapshot.length)) return false;
    const keys = Object.keys(value);
    if (keys.length !== snapshot.keys.length) return false;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== snapshot.keys[i] || !matches(value[keys[i]], snapshot.values[i])) return false;
    }
    return true;
  }
  return (session, project, token = null) => {
    const previous = entries.get(session);
    try {
      if (previous && Object.is(previous.token, token)) {
        const shape = previous.shape ? Reflect.ownKeys(session) : null;
        let same = !shape || (shape.length === previous.shape.length && shape.every((key, i) => key === previous.shape[i]));
        for (let i = 0; i < previous.fields.length; i++) {
          const value = session[previous.fields[i]], snapshot = previous.values[i];
          if (!Object.is(value, snapshot) && !matches(value, snapshot)) { same = false; break; }
        }
        if (same) return previous.result;
      }
    } catch { /* Unusual metadata: recompute instead of retaining stale data. */ }
    const fields = new Set();
    let shape = null;
    const input = new Proxy(session, {
      get(target, key) { fields.add(key); return Reflect.get(target, key); },
      ownKeys(target) { shape = Reflect.ownKeys(target); return shape; },
    });
    const result = project(input);
    try {
      const keys = [...fields];
      entries.set(session, { token, shape, fields: keys, values: keys.map(key => capture(session[key])), result });
    } catch { entries.delete(session); }
    return result;
  };
}

function createSidebarClassifier() {
  const cached = createSessionProjectionCache();
  const dormant = new WeakMap();
  return (session, { now = Date.now(), sessionMap = new Map(), groupMemberIds = new Set() } = {}) => {
    // Meeting projections depend on other sessions. Keep their existing rule;
    // ordinary rows account for almost all of a large restored sidebar.
    if (session._isMeeting) return sidebarItemClassification(session, { now, sessionMap, groupMemberIds });
    if (session.status === 'dormant') {
      // Dormancy is a hard runtime override in every provider: runtime payload,
      // heartbeat and expiry cannot affect this classification. Only native
      // backend detection, attention/unread and resume-pending are still read.
      // Avoid traversing a whole native snapshot for thousands of closed rows.
      const previous = dormant.get(session);
      if (previous && previous.resume === session._resumePending && previous.backend === session.runtimeBackend
          && previous.agent === session.agentRuntime && previous.kind === session.kind && previous.native === !!session.nativeRuntime
          && previous.attention === session.attentionState && previous.input === session.needsUserInput && previous.reply === session.replyReady
          && previous.waiting === session.isWaiting && previous.reason === session.waitingReason && previous.unread === session.unreadCount) return previous.result;
      const result = sidebarItemClassification(session, { now, sessionMap, groupMemberIds });
      dormant.set(session, { resume: session._resumePending, backend: session.runtimeBackend, agent: session.agentRuntime, kind: session.kind,
        native: !!session.nativeRuntime, attention: session.attentionState, input: session.needsUserInput, reply: session.replyReady,
        waiting: session.isWaiting, reason: session.waitingReason, unread: session.unreadCount, result });
      return result;
    }
    const expiry = Number(session.runtimeTruth?.expiresAt) || 0;
    const heartbeat = Number(session._gcWorkingLastTs);
    // Preserve exact > expiry and inclusive [heartbeat, heartbeat + 8s] rules,
    // including clock rollback and a heartbeat timestamp in the future.
    const timeKey = (expiry && (Number(now) || Date.now()) > expiry ? 1 : 0)
      | (Number.isFinite(heartbeat) && now >= heartbeat && now <= heartbeat + GC_WORKING_FRESH_MS ? 2 : 0)
      | (groupMemberIds.has(session.id) ? 4 : 0);
    return cached(session, input => sidebarItemClassification(input, { now, sessionMap, groupMemberIds }), timeKey);
  };
}
function getMeetingUnreadMemberIds(meeting, sessions = new Map()) {
  return new Set((meeting?.subSessions || []).filter(sid =>
    (meeting.unreadAnswered instanceof Set && meeting.unreadAnswered.has(sid)) || sessionHasCompletedUnread(sessions.get(sid))));
}

function isPinnedToBottom(item) {
  return !!(item && item.bottomed && !item.pinned);
}

function compareSidebarPlacement(left, right) {
  const leftPinned = !!(left && left.pinned);
  const rightPinned = !!(right && right.pinned);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  const leftBottomed = isPinnedToBottom(left);
  const rightBottomed = isPinnedToBottom(right);
  if (leftBottomed !== rightBottomed) return leftBottomed ? 1 : -1;
  return compareLatestActivityDesc(left, right);
}

// The sidebar sorts every session (1,571 on the live Hub, 2026-10-08) about
// three times a second. A plain comparator recomputed latestActivityTime twice
// per comparison (~17k comparisons per sort). These read each key once and
// sort with the same rule; Array#sort is stable, so the order is identical.
function sortBySidebarPlacement(items) {
  return (items || []).map(item => ({ item, pinned: !!(item && item.pinned), bottomed: isPinnedToBottom(item),
    at: latestActivityTime(item), created: positiveTimestamp(item && item.createdAt) }))
    .sort((left, right) => (left.pinned !== right.pinned ? (left.pinned ? -1 : 1)
      : left.bottomed !== right.bottomed ? (left.bottomed ? 1 : -1)
        : (right.at - left.at) || (right.created - left.created)))
    .map(entry => entry.item);
}

function sortByLatestActivityDesc(items) {
  return (items || []).map(item => ({ item, at: latestActivityTime(item), created: positiveTimestamp(item && item.createdAt) }))
    .sort((left, right) => (right.at - left.at) || (right.created - left.created))
    .map(entry => entry.item);
}

function sidebarItemHasUnread(item, sessionMap) {
  if (!item._isMeeting) return sessionHasCompletedUnread(item);
  return getMeetingUnreadMemberIds(item._meeting, sessionMap).size > 0 || item.unreadAnsweredSize > 0;
}

function isSidebarMemberWorking(session, now = Date.now()) {
  return getSessionRuntimeTruth(session, { now }).state !== RUNTIME_WAITING
    && (sessionRuntimeIsActive(session, { now }) || isGroupChatMemberRunning(session, now));
}

// Classification is also used by assistant snapshots, which do not need
// sorted age buckets. Keep one rule while avoiding a whole-list sort there.
function sidebarItemClassification(s, {now=Date.now(),sessionMap=new Map(),groupMemberIds=new Set()}={}) {
  const truth=s._isMeeting?null:getSessionRuntimeTruth(s,{now});
  const meeting=s._isMeeting?_meetingRuntimeAggregate(s._meeting,sessionMap,now):null;
  const dormant=meeting?s.status==='dormant':truth.state===RUNTIME_DORMANT;
  const waiting=meeting?meeting.waiting:truth.state===RUNTIME_WAITING;
  const error=meeting?meeting.failed:!!sessionRuntimeIssue(s,truth);
  const working=s._resumePending||(meeting?meeting.running:(s.meetingId||groupMemberIds.has(s.id))?isSidebarMemberWorking(s,now):sessionRuntimeIsActive(s,{now}));
  const unread=sidebarItemHasUnread(s,sessionMap);
  const state=error?'error':meeting&&working?'run':waiting?'wait':working?'run':unread?'unread':dormant?'dorm':truth?.state === RUNTIME_UNKNOWN?'unknown':'idle';
  return {state,dormant,waiting,error,working,unread};
}

// `classify` lets one render reuse a classification it already computed for the
// same item at the same `now` (the assistant snapshot publishes it too).
function partitionSidebarSessions(items, { now = Date.now(), sessionMap = new Map(), activeSessionId = null, activeMeetingId = null, groupMemberIds = new Set(), classify = null } = {}) {
  const pinned = [], respond = [], failed = [], running = [], completed = [], today = [], archive = [], older = [];
  const states = new Map();
  for (const s of sortBySidebarPlacement(items)) {
    const {state,dormant,waiting,error,working,unread}=classify ? classify(s) : sidebarItemClassification(s,{now,sessionMap,groupMemberIds});
    const fresh = now - latestActivityTime(s, now) < 86400000;
    states.set(s.id,state);
    if (error) failed.push(s);
    else if (s.pinned && (waiting || working)) (waiting ? respond : running).push(s);
    else if (unread) completed.push(s);
    else if (waiting) respond.push(s);
    else if (working) running.push(s);
    else if (s.pinned) pinned.push(s);
    else if (dormant) archive.push(s);
    else if (fresh) today.push(s);
    else older.push(s);
  }
  return { pinned, unread: completed, failed, active: [...respond, ...running], today, archive, older, archiveCount: archive.length, states };
}

function _meetingRuntimeAggregate(meeting, sessionMap, now = Date.now()) {
  const truths = ((meeting && meeting.subSessions) || [])
    .map(id => sessionMap.get(id))
    .filter(Boolean)
    .map(session => ({ session, truth: getSessionRuntimeTruth(session, { now }) }));
  return {
    waiting: truths.some(item => item.truth.state === RUNTIME_WAITING),
    running: meeting && !meeting.groupChat && meeting.status === 'running'
      || truths.some(item => isSidebarMemberWorking(item.session, now)),
    disconnected: truths.some(item => sessionRuntimeIssue(item.session, item.truth)?.label === '连接异常'),
    failed: truths.some(item => !!sessionRuntimeIssue(item.session, item.truth)),
    truths,
  };
}


// Presentation policy only; runtime truth and unread accounting remain owned
// by the existing classifier. Attention flags promote rows, not sections.
function buildSidebarView(parts, { now = Date.now(), days = 1, pinnedOnly = false, excludePinned = false, sessionMap = new Map(), hasUnread = () => false } = {}) {
  const items = [...new Map(['failed', 'active', 'pinned', 'unread', 'today', 'archive', 'older']
    .flatMap(key => parts[key] || []).map(item => [item.id, item])).values()];
  const failed = [], active = [], today = [], archive = [];
  const compare = (a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (!!a.bottomed !== !!b.bottomed) return a.bottomed ? 1 : -1;
    if (!!hasUnread(a, sessionMap) !== !!hasUnread(b, sessionMap)) return hasUnread(a, sessionMap) ? -1 : 1;
    return compareLatestActivityDesc(a, b);
  };
  for (const item of items) {
    if ((pinnedOnly && !item.pinned) || (excludePinned && item.pinned)) continue;
    const state = parts.states.get(item.id);
    if (state === 'error') failed.push(item);
    else if (state === 'run' || state === 'wait') active.push(item);
    else if (item.pinned || hasUnread(item, sessionMap) || now - latestActivityTime(item, now) < (days === 3 ? 3 : 1) * 86400000) today.push(item);
    else archive.push(item);
  }
  failed.sort(compare);
  active.sort((a, b) => {
    const waiting = (parts.states.get(a.id) === 'wait' ? 0 : 1) - (parts.states.get(b.id) === 'wait' ? 0 : 1);
    return waiting || compare(a, b);
  });
  today.sort(compare);
  const archiveSorted = sortByLatestActivityDesc(archive);
  return { ...parts, failed, active, today, archive: archiveSorted, archiveCount: archiveSorted.length };
}


module.exports={createSessionProjectionCache,createSidebarClassifier,getMeetingUnreadMemberIds,compareSidebarPlacement,sortBySidebarPlacement,sortByLatestActivityDesc,isPinnedToBottom,sidebarItemHasUnread,isSidebarMemberWorking,sidebarItemClassification,partitionSidebarSessions,_meetingRuntimeAggregate,buildSidebarView};
