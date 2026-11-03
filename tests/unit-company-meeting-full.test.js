'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { MeetingRecorder } = require('../renderer/meeting-recorder');
const { durationHeader, element, fixWebmDuration } = require('../core/company-assistant/meeting-webm-duration');
const fixture = () => Buffer.from('1a45dfa3801853806701ffffffffffffff1549a966872ad7b1830f42401f43b67584a3820102', 'hex');
function duration(buffer) { let seg = element(buffer, element(buffer, 0).end), info = element(buffer, seg.start); for (let p = info.start; p < info.end;) { const e = element(buffer, p); if (e.id === 0x4489) return buffer.readDoubleBE(e.start); p = e.end; } }
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-full-unit-'));
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null }, { meetingAsr: { status: () => ({ ready: false }), close() {} } });
  let recorder;
  try {
    const original = fixture(), header = durationHeader(original, 120000), fixed = Buffer.concat([header.prefix, original.subarray(header.offset)]);
    assert.equal(duration(fixed), 120000); assert.ok(fixed.subarray(-8).equals(original.subarray(-8)));
    assert.throws(() => durationHeader(original.subarray(0, 22), 1), /完整/);
    const file = path.join(root, 'truncated.webm'); fs.writeFileSync(file, original.subarray(0, -2)); await fixWebmDuration(file, 1000); assert.equal(duration(fs.readFileSync(file)), 1000);
    const invalid = path.join(root, 'invalid.webm'); fs.writeFileSync(invalid, original.subarray(0, 8)); await assert.rejects(() => fixWebmDuration(invalid, 1000)); assert.equal(fs.readFileSync(invalid).length, 8, 'invalid header never overwrites preserved recording');
    let now = 0; const saved = [], instances = [];
    class FakeRecorder {
      constructor() { this.state = 'inactive'; this.first = true; instances.push(this); }
      start() { this.state = 'recording'; }
      requestData() { const b = this.first ? fixture() : Buffer.from([0xa3, 0x81, 0]); this.first = false; queueMicrotask(() => this.ondataavailable({ data: { size: b.length, arrayBuffer: async () => b } })); }
      pause() { this.state = 'paused'; queueMicrotask(() => this.onpause?.()); }
      resume() { assert.equal(this.state, 'paused'); this.state = 'recording'; }
      stop() { this.requestData(); this.state = 'inactive'; queueMicrotask(() => this.onstop()); }
    }
    const meeting = m.create({ title: '完整录像' }); clearInterval(m.timer); m.timer = 1;
    recorder = new MeetingRecorder({ window: { MediaRecorder: FakeRecorder, crypto: { randomUUID } }, streams: [], elapsed: () => now, save: async r => { saved.push(r); m.capture(meeting.id, r); }, onError: e => { throw Error(e); } });
    recorder.mime = 'video/webm'; recorder.stream = { getVideoTracks: () => [{ getSettings: () => ({ width: 100, height: 60 }) }] }; recorder.schedule = () => {};
    recorder.start(); recorder.start(); assert.equal(instances.length, 2);
    now = 4000; await recorder.pause(); assert.equal(instances[0].state, 'paused'); assert.equal(instances[1].state, 'inactive');
    const before = m.load(meeting.id); assert.equal(before.recording.full.status, 'writing'); assert.equal(before.recording.segments.length, 1); assert.equal(before.recording.full.durationMs, 4000);
    now = 7000; recorder.start(); assert.equal(instances.length, 3, 'resume retains original full recorder'); assert.equal(instances[0].state, 'recording');
    now = 11000; await recorder.close(); await m.recording.repairs.get(meeting.id);
    const ended = m.load(meeting.id), full = ended.recording.full;
    assert.equal(full.status, 'ready'); assert.equal(full.durationMs, 8000, 'duration excludes paused wall time'); assert.equal(full.durationFixed, true);
    assert.equal(duration(fs.readFileSync(m.recording.full(meeting.id).file)), 8000);
    assert.equal(ended.recording.segments.length, 2); assert.notEqual(m.recording.locate(meeting.id, 1000).segment.file, 'recording-full.webm');
    assert.equal(saved.filter(r => r.kind === 'recording-start' && r.full).length, 1); assert.equal(saved.filter(r => r.kind === 'recording-finish' && r.key === full.key).length, 1);
    const interrupted = m.load(meeting.id); interrupted.recording.full.status = 'writing'; interrupted.recording.full.durationFixed = false; m.save(interrupted);
    m.recording.recover(interrupted); m.save(interrupted); await m.recording.repairs.get(meeting.id); assert.equal(m.load(meeting.id).recording.full.status, 'interrupted'); assert.equal(m.load(meeting.id).recording.full.durationFixed, true);
    const stopped = m.load(meeting.id); stopped.state = 'ended'; stopped.recording.full.status = 'ready'; stopped.recording.full.durationFixed = false; m.save(stopped);
    const restart = new MeetingCompanion(m.a, m.deps);
    try { restart.start(); await restart.recording.repairs.get(meeting.id); assert.equal(restart.load(meeting.id).recording.full.durationFixed, true, 'startup resumes a repair interrupted after meeting ended'); }
    finally { restart.close(); }
    const fullFile = m.recording.full(meeting.id).file; fs.writeFileSync(fullFile, Buffer.from([0x1a,0x45,0xdf,0xa3]));
    const save = m.save.bind(m); m.save = state => { if (state.recording?.full?.durationError) throw Error('ENOSPC test status'); return save(state); };
    await m.recording.repair(meeting.id); assert.match(m.status(meeting.id).recordingError, /状态保存失败.*ENOSPC/, 'disk-full error remains visible even when recording metadata cannot be written'); assert.equal(fs.statSync(fullFile).size, 4, 'repair failure preserves original bytes'); m.save = save;
    console.log('full meeting recording: dual lifecycle, pause duration, streaming repair, recovery and truncated-file retention PASS');
  } finally { clearTimeout(recorder?.timer); await Promise.all(m.recording.repairs.values()); m.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
