'use strict';
// Which meeting moments can be replayed, and which piece plays next when one ends.
// A meeting may hold the whole-meeting recording plus pieces recorded after an unexpected
// interruption ("continue recording", R51). Mirrors MeetingRecording.locate in the main process.

const playable = s => !!s && s.bytes > 0 && (s.status === 'ready' || (s.status === 'interrupted' && /^video\/mp4/.test(s.mime || '')));

function inGap(rec, at) {
  if (rec?.openGap && at >= rec.openGap.at) return true;
  return !!rec?.gaps?.some(g => at >= g.at && (g.open || at < g.end));
}

// The whole-meeting recording stops at full.end once it was interrupted or followed by pieces.
function fullCovers(rec, at) {
  const full = rec?.full;
  if (!full?.bytes || full.status === 'writing') return false;
  const capped = full.status === 'interrupted' || (rec.segments || []).length > 0;
  return !capped || at <= (full.end || 0);
}

function canReplayAt(rec, at) {
  if (!rec || !Number.isFinite(at) || inGap(rec, at)) return false;
  return fullCovers(rec, at) || (rec.segments || []).some(s => playable(s) && s.at <= at && s.end > at);
}

// The piece that follows the one that just ended (whole recording or an earlier piece).
function nextSegment(rec, current) {
  if (!rec || !current) return null;
  return (rec.segments || []).filter(s => playable(s) && s.key !== current.key && s.at > current.at)
    .sort((a, b) => a.at - b.at)[0] || null;
}

module.exports = { canReplayAt, nextSegment, playable };
