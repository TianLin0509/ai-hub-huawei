'use strict';

function meetingMemberTitlePatch(session, meeting) {
  if (!session || !meeting || session.userRenamed || session.meetingId !== meeting.id) return null;
  const topic = String(meeting.title || '').trim();
  if (!topic) return null;
  const index = (meeting.subSessions || []).indexOf(session.id || session.hubId);
  // Creation may publish the session before the meeting has registered it.
  if (index < 0) return null;
  const stableNumber = /^m([1-9]\d*)$/.exec(String(meeting.slotSpecs?.[index]?.memberId || ''));
  const number = stableNumber ? stableNumber[1] : index + 1;
  const title = `成员 ${number} · ${topic}`;
  return session.title === title && session.autoTitleGenerated ? null : { title, autoTitleGenerated: true };
}

// One naming path for new members, title/model changes and dormant restoration.
// read/write retain the main process's existing ownership and persistence rules.
function createMeetingMemberTitleSync({ getMeeting, readSession, writeSession, publish, logger = console }) {
  const updating = new Set();
  const meetingNames = new Map();
  const signature = meeting => JSON.stringify([meeting.title, meeting.subSessions || [], (meeting.slotSpecs || []).map(s => s?.memberId)]);
  function rememberMeeting(meeting) { meetingNames.set(meeting.id, signature(meeting)); }
  function syncSession(session) {
    const id = session?.id || session?.hubId;
    if (!id || updating.has(id)) return session;
    const patch = meetingMemberTitlePatch(session, getMeeting(session.meetingId));
    if (!patch) return session;
    updating.add(id);
    try {
      return writeSession(id, patch) || session;
    } catch (error) {
      logger.warn(`[meeting-member-title] ${id}: ${error.message}`);
      return session;
    } finally {
      updating.delete(id);
    }
  }
  function syncMeeting(meeting) {
    for (const id of meeting?.subSessions || []) {
      const before = readSession(id);
      const after = syncSession(before);
      if (after && after !== before) publish('session-updated', { session: after });
    }
  }
  function onEvent(channel, data) {
    if ((channel === 'meeting-created' || channel === 'meeting-updated') && data?.meeting) {
      const meeting = data.meeting;
      if (meetingNames.get(meeting.id) !== signature(meeting)) {
        rememberMeeting(meeting);
        syncMeeting(meeting);
      }
    }
    if (channel === 'meeting-closed') meetingNames.delete(data?.meetingId);
    if ((channel === 'session-created' || channel === 'session-updated') && data?.session) {
      data = { ...data, session: syncSession(data.session) };
    }
    return data;
  }
  return { rememberMeeting, syncMeeting, onEvent };
}

module.exports = { meetingMemberTitlePatch, createMeetingMemberTitleSync };
