'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { MeetingRecorder } = require('../renderer/meeting-recorder');
const { MeetingCapture } = require('../renderer/meeting-capture');
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
    recorder.start(); recorder.start(); assert.equal(instances.length, 1);
    now = 4000; await recorder.pause(); assert.equal(instances[0].state, 'paused');
    const before = m.load(meeting.id); assert.equal(before.recording.full.status, 'writing'); assert.equal(before.recording.segments.length, 0); assert.equal(before.recording.full.durationMs, 4000);
    now = 7000; recorder.start(); assert.equal(instances.length, 1, 'resume retains original full recorder'); assert.equal(instances[0].state, 'recording');
    now = 11000; await recorder.close(); await m.recording.repairs.get(meeting.id);
    const ended = m.load(meeting.id), full = ended.recording.full;
    assert.equal(full.status, 'ready'); assert.equal(full.durationMs, 8000, 'duration excludes paused wall time'); assert.equal(full.durationFixed, true);
    assert.equal(duration(fs.readFileSync(m.recording.full(meeting.id).file)), 8000);
    assert.equal(ended.recording.segments.length, 0); assert.equal(m.recording.locate(meeting.id, 1000).segment.file, 'recording-full.webm');
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
test('完整录像正常暂停继续、修复恢复及失败保留旧文件', main);

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('测试保险超时：产品操作未在 waitMs 内结束')), 500);
    })]);
  } finally { clearTimeout(timer); }
}
const timedOut = promise => assert.rejects(() => bounded(promise), error => {
  assert.equal(error.code, 'MEETING_RECORDING_TIMEOUT'); return true;
});

function recorderFaults({ holdPause = false, holdStop = false, save, arrayBuffer = async bytes => bytes, waitMs = 25 } = {}) {
  const instances = [], saved = [], errors = [];
  let now = 1000, closed = 0;
  class ControlledRecorder {
    constructor() { this.state = 'inactive'; this.pauseCalls = 0; this.stopCalls = 0; instances.push(this); }
    start() { this.state = 'recording'; }
    requestData() {
      const bytes = fixture();
      queueMicrotask(() => this.ondataavailable?.({ data: { size: bytes.length, arrayBuffer: () => arrayBuffer(bytes, this) } }));
    }
    pause() { this.pauseCalls++; this.state = 'paused'; if (!holdPause) queueMicrotask(() => this.emitPause()); }
    emitPause() { this.onpause?.(); }
    resume() { assert.equal(this.state, 'paused'); this.state = 'recording'; }
    stop() {
      this.stopCalls++; this.requestData(); this.state = 'inactive';
      if (!holdStop) queueMicrotask(() => this.emitStop());
    }
    emitStop() { this.state = 'inactive'; this.onstop?.(); }
  }
  const recorder = new MeetingRecorder({ window: { MediaRecorder: ControlledRecorder, crypto: { randomUUID } },
    streams: [], elapsed: () => now, waitMs,
    save: save || (async record => { saved.push(record); }), onError: message => errors.push(message) });
  recorder.mime = 'video/webm';
  recorder.stream = { getVideoTracks: () => [{ getSettings: () => ({ width: 100, height: 60 }) }] };
  recorder.schedule = () => {};
  recorder.ctx = { state: 'running', async close() { closed++; this.state = 'closed'; } };
  return { recorder, instances, saved, errors, get closed() { return closed; }, advance(ms) { now += ms; },
    async releaseNative() {
      clearTimeout(recorder.timer);
      for (const instance of instances) { instance.emitPause(); instance.emitStop(); }
      await turn(); await recorder.pending;
    } };
}

test('pause事件丢失会有界报错，close不等待旧pause且stop正常时完成', async () => {
  const h = recorderFaults({ holdPause: true });
  try {
    h.recorder.start(); h.advance(500);
    await timedOut(h.recorder.pause());
    await bounded(h.recorder.close());
    assert.equal(h.closed, 1);
    assert.equal(h.instances[0].stopCalls, 1, 'full recorder is stopped despite missing pause event');
    const starts = h.saved.filter(record => record.kind === 'recording-start');
    for (const record of starts) assert.equal(h.saved.filter(x => x.kind === 'recording-finish' && x.key === record.key).length, 1);
  } finally { await h.releaseNative(); }
});

test('stop事件丢失时close有界报错并释放ctx，晚到或重复stop最多保存一次finish', async () => {
  const h = recorderFaults({ holdStop: true });
  try {
    h.recorder.start(); h.advance(500);
    await timedOut(h.recorder.close());
    assert.equal(h.closed, 1, 'native stop timeout cannot retain the audio context');
    assert.equal(h.saved.filter(record => record.kind === 'recording-finish').length, 0, 'no fabricated completion before native stop');
    for (const instance of h.instances) { instance.emitStop(); instance.emitStop(); }
    await turn(); await h.recorder.pending; await bounded(h.recorder.retry());
    const starts = h.saved.filter(record => record.kind === 'recording-start');
    assert.equal(starts.length, 1);
    for (const record of starts) assert.equal(h.saved.filter(x => x.kind === 'recording-finish' && x.key === record.key).length, 1, 'late/duplicate stop must not duplicate finish');
    assert.equal(h.recorder.active.size, 0);
  } finally { await h.releaseNative(); }
});

test('录制中直接close不发pause请求，stop正常即可保存完整结束', async () => {
  const h = recorderFaults({ holdPause: true });
  try {
    h.recorder.start(); h.advance(500); await bounded(h.recorder.close());
    assert.equal(h.instances[0].pauseCalls, 0, 'close must not depend on a native pause acknowledgement');
    assert.ok(h.instances.every(instance => instance.stopCalls === 1));
    assert.equal(h.saved.filter(record => record.kind === 'recording-finish').length, 1);
    assert.equal(h.closed, 1);
  } finally { await h.releaseNative(); }
});

test('录像save未确认时retry有界报错但不重发，晚resolve后按原队列继续排空', async () => {
  const gate = deferred(), calls = [];
  const h = recorderFaults({ save: async record => { calls.push(record); if (calls.length === 1) await gate.promise; } });
  const first = { kind: 'recording-chunk', key: 'original-meeting-full', offset: 0, data: 'AAAA' };
  const second = { kind: 'recording-finish', key: first.key, at: 500, durationMs: 500 };
  try {
    h.recorder.push(first); h.recorder.push(second); await turn();
    const saving = h.recorder.saving;
    assert.ok(saving);
    await timedOut(h.recorder.retry()); await timedOut(h.recorder.retry());
    assert.equal(h.recorder.saving, saving, 'timeout must not clear ownership of the original save');
    assert.deepEqual(calls, [first], 'retry must not send an unacknowledged append again');
    assert.equal(h.recorder.queue[0], first); assert.equal(h.recorder.queue[1], second);
    gate.resolve(); await turn(); await bounded(h.recorder.retry());
    assert.deepEqual(calls, [first, second]); assert.equal(h.recorder.queue.length, 0);
  } finally { gate.resolve(); await turn(); await h.releaseNative(); }
});

test('full编码器异常inactive后禁止静默只启动segment', async () => {
  const h = recorderFaults();
  try {
    h.recorder.start(); await bounded(h.recorder.pause());
    h.instances[0].emitStop(); await turn(); await h.recorder.pending;
    const count = h.instances.length, fullStarts = h.saved.filter(x => x.kind === 'recording-start' && x.full).length;
    const fullKey = h.saved.find(x => x.kind === 'recording-start' && x.full).key;
    const originalFull = h.saved.filter(x => x.key === fullKey).map(x => ({ ...x }));
    assert.throws(() => h.recorder.start(), 'an ended full recording must not silently resume with segment-only output');
    await bounded(h.recorder.retry());
    assert.throws(() => h.recorder.start(), 'retry saving cannot resurrect an inactive full recorder');
    assert.equal(h.instances.length, count, 'no new segment after full recorder ended');
    assert.equal(h.saved.filter(x => x.kind === 'recording-start' && x.full).length, fullStarts, 'existing full recording must not be replaced');
    assert.deepEqual(h.saved.filter(x => x.key === fullKey), originalFull, 'failed start and retry must not append to or replace original full bytes');
  } finally { await h.releaseNative(); }
});

test('capture dispose在native stop不来时释放轨道且不伪造保存完成', async () => {
  const h = recorderFaults({ holdStop: true }); let stopped = 0;
  const capture = new MeetingCapture({ document: {}, window: { performance: { now: () => 1000 } }, waitMs: 25, save: async () => {}, status() {} });
  const track = { onended() {}, stop() { stopped++; } };
  capture.recorder = h.recorder; capture.streams = [{ getTracks: () => [track] }]; capture.video = { srcObject: capture.streams[0] };
  try {
    h.recorder.start();
    await timedOut(capture.dispose());
    assert.equal(stopped, 1); assert.equal(track.onended, null); assert.equal(capture.video.srcObject, null);
    assert.equal(h.saved.some(x => x.kind === 'recording-finish'), false, 'dispose may release capture resources, not invent a finish receipt');
  } finally { await h.releaseNative(); }
});

test('capture save未确认时retry保留旧归属和队列，晚resolve后不重复保存', async () => {
  const gate = deferred(), calls = [];
  const capture = new MeetingCapture({ document: {}, window: { performance: { now: () => 1000 } }, waitMs: 25,
    save: async record => { calls.push({ owner: 'original-meeting', record }); if (calls.length === 1) await gate.promise; }, status() {} });
  capture.started = 0; capture.paused = true;
  const first = { kind: 'audio', track: 'mic', at: 0, end: 500, data: 'AAAA' }, second = { kind: 'heartbeat', at: 500 };
  try {
    capture.enqueue(first); capture.enqueue(second); await turn(); const saving = capture.saving;
    await timedOut(capture.retry()); await timedOut(capture.retry());
    assert.equal(capture.saving, saving); assert.equal(capture.queue[0], first); assert.equal(capture.queue[1], second);
    assert.deepEqual(calls, [{ owner: 'original-meeting', record: first }]);
    gate.resolve(); await turn(); await bounded(capture.retry());
    assert.deepEqual(calls, [{ owner: 'original-meeting', record: first }, { owner: 'original-meeting', record: second }]);
    assert.equal(capture.queue.length, 0);
  } finally { gate.resolve(); await turn(); }
});

test('capture stop超时释放设备但保留旧场状态，迟到stop后可重试完成结束', async () => {
  const h = recorderFaults({ holdStop: true }), material = []; let stopped = 0;
  const capture = new MeetingCapture({ document: {}, window: { performance: { now: () => 1500 } }, waitMs: 25,
    save: async record => { material.push({ owner: 'original-meeting', record }); }, status() {} });
  const track = { onended() {}, stop() { stopped++; } };
  capture.started = 1000; capture.running = true; capture.paused = false;
  capture.recorder = h.recorder; capture.streams = [{ getTracks: () => [track] }]; capture.video = { srcObject: capture.streams[0] };
  try {
    h.recorder.start();
    await timedOut(capture.stop());
    assert.equal(stopped, 1); assert.equal(track.onended, null); assert.equal(capture.video.srcObject, null);
    assert.equal(capture.running, true, 'unconfirmed stop keeps the old meeting available for retry/end');
    assert.equal(capture.paused, true, 'no more capture after a stop timeout');
    assert.equal(h.saved.some(record => record.kind === 'recording-finish'), false, 'native stop receipt must not be fabricated');
    assert.throws(() => capture.assertCanResume(), 'released devices cannot be resumed while old stop is unresolved');
    for (const instance of h.instances) { instance.emitStop(); instance.emitStop(); }
    await turn(); await h.recorder.pending;
    await bounded(capture.retry()); await bounded(capture.stop());
    assert.equal(capture.running, false); assert.equal(capture.paused, true);
    assert.equal(capture.queue.length, 0); assert.equal(h.recorder.queue.length, 0);
    assert.equal(stopped, 1, 'retrying end must not stop an already released track twice');
    const starts = h.saved.filter(record => record.kind === 'recording-start');
    for (const record of starts) assert.equal(h.saved.filter(x => x.kind === 'recording-finish' && x.key === record.key).length, 1);
    assert.ok(material.every(entry => entry.owner === 'original-meeting'));
  } finally { await h.releaseNative(); }
});

test('capture pause丢回调超时后用stop释放轨道，保留旧场且禁止继续', async () => {
  const h = recorderFaults({ holdPause: true }); let stopped = 0;
  const capture = new MeetingCapture({ document: {}, window: { performance: { now: () => 1500 } }, waitMs: 25, save: async () => {}, status() {} });
  const track = { onended() {}, stop() { stopped++; } };
  capture.started = 1000; capture.running = true; capture.paused = false;
  capture.recorder = h.recorder; capture.streams = [{ getTracks: () => [track] }]; capture.video = { srcObject: capture.streams[0] };
  try {
    h.recorder.start();
    await timedOut(capture.pause());
    assert.equal(stopped, 1); assert.equal(track.onended, null); assert.equal(capture.video.srcObject, null);
    assert.equal(capture.running, true); assert.equal(capture.paused, true);
    assert.throws(() => capture.resume(), 'timeout cleanup must not permit resuming released capture devices');
    assert.ok(h.instances.every(instance => instance.stopCalls === 1));
    assert.equal(h.closed, 1);
    const starts = h.saved.filter(record => record.kind === 'recording-start');
    for (const record of starts) assert.equal(h.saved.filter(x => x.kind === 'recording-finish' && x.key === record.key).length, 1, 'real mocked stop still completes each recording');
  } finally { await h.releaseNative(); }
});

test('清理中source或track抛错仍尝试所有资源，保留第一个错误对象', async () => {
  const h = recorderFaults(), calls = [], firstError = new Error('first-source-disconnect');
  const node = (label, error) => ({ disconnect() { calls.push(label); if (error) throw error; } });
  const track = (label, error) => ({ onended() {}, stop() { calls.push(label); if (error) throw error; } });
  h.recorder.sources = [
    { source: node('source-1', firstError), gain: node('gain-1') },
    { source: node('source-2'), gain: node('gain-2') },
  ];
  const failedSource = h.recorder.sources[0];
  const destinationTracks = [track('destination-1', new Error('later-destination-error')), track('destination-2')];
  h.recorder.destination = { stream: { getTracks: () => destinationTracks } };
  const capture = new MeetingCapture({ document: {}, window: {}, waitMs: 25, save: async () => {}, status() {} });
  capture.recorder = h.recorder;
  const brokenTrack = track('capture-track-1', new Error('later-capture-track-error')), healthyTrack = track('capture-track-2');
  capture.streams = [{ getTracks: () => [brokenTrack, healthyTrack] }];
  capture.nodes = [1, 2].map(n => ({ length: 0, proc: node('proc-' + n), src: node('capture-source-' + n, n === 1 ? new Error('later-capture-source-error') : null),
    ctx: { close() { calls.push('capture-ctx-' + n); if (n === 1) throw new Error('later-context-error'); return Promise.resolve(); } } }));
  const failedNode = capture.nodes[0], failedStream = capture.streams[0];
  try {
    await assert.rejects(() => bounded(capture.dispose()), error => error === firstError);
    for (const name of ['source-1', 'gain-1', 'source-2', 'gain-2', 'destination-1', 'destination-2', 'capture-track-1', 'capture-track-2', 'proc-1', 'proc-2', 'capture-source-1', 'capture-source-2', 'capture-ctx-1', 'capture-ctx-2']) {
      assert.equal(calls.filter(x => x === name).length, 1, name + ' must be attempted even after an earlier cleanup error');
    }
    assert.equal(h.closed, 1); assert.equal(brokenTrack.onended, null); assert.equal(healthyTrack.onended, null);
    assert.equal(capture.nodes.length, 1); assert.equal(capture.nodes[0], failedNode, 'failed context/source keeps its original node for retry');
    assert.equal(capture.streams.length, 1); assert.equal(capture.streams[0], failedStream, 'stream containing failed stop remains reachable');
    assert.equal(h.recorder.sources.length, 1); assert.equal(h.recorder.sources[0], failedSource, 'failed recorder source remains reachable while successful groups are removed');
    await assert.rejects(() => bounded(capture.dispose()), error => error === firstError);
    for (const name of ['source-1', 'destination-1', 'capture-track-1', 'capture-source-1', 'capture-ctx-1']) {
      assert.equal(calls.filter(x => x === name).length, 2, name + ' failure remains reachable for the next cleanup attempt');
    }
    for (const name of ['gain-1', 'source-2', 'gain-2', 'destination-2', 'capture-track-2', 'proc-1', 'proc-2', 'capture-source-2', 'capture-ctx-2']) {
      assert.equal(calls.filter(x => x === name).length, 1, name + ' successful cleanup must not repeat beside a failed resource');
    }
  } finally { await h.releaseNative(); }
});

test('Blob读取迟到时close超时不提前finish，重试按同key连续offset排空且finish唯一', async () => {
  const gate = deferred(); let reads = 0;
  const h = recorderFaults({ arrayBuffer: async bytes => { if (++reads === 1) await gate.promise; return bytes; } });
  try {
    h.recorder.start();
    h.instances[0].requestData(); h.instances[0].requestData();
    await turn();
    await timedOut(h.recorder.close());
    assert.equal(h.closed, 1);
    assert.equal(h.saved.some(record => ['recording-chunk', 'recording-finish'].includes(record.kind)), false, 'pending blob blocks finish; completion cannot overtake data');
    gate.resolve(); await turn(); await bounded(h.recorder.retry()); await bounded(h.recorder.close());
    assert.equal(h.recorder.queue.length, 0);
    const starts = h.saved.filter(record => record.kind === 'recording-start');
    assert.equal(starts.length, 1);
    for (const start of starts) {
      const records = h.saved.filter(record => record.key === start.key), chunks = records.filter(record => record.kind === 'recording-chunk');
      assert.equal(chunks.length, start.full ? 3 : 1, 'all data requests remain attached to the original key');
      let offset = 0;
      for (const chunk of chunks) {
        assert.equal(chunk.offset, offset); const bytes = Buffer.from(chunk.data, 'base64');
        assert.deepEqual(bytes, fixture()); offset += bytes.length;
      }
      assert.equal(records.filter(record => record.kind === 'recording-finish').length, 1);
      assert.equal(records.at(-1).kind, 'recording-finish', 'finish follows every chunk for its own key');
    }
  } finally { gate.resolve(); await turn(); await h.releaseNative(); }
});

test('capture ctx.close未确认时连续dispose不能假成功，保留引用并等待同一关闭请求', async () => {
  const gate = deferred(), calls = [];
  const capture = new MeetingCapture({ document: {}, window: {}, waitMs: 25, save: async () => {}, status() {} });
  const pendingNode = { length: 0,
    proc: { disconnect() { calls.push('pending-proc'); } }, src: { disconnect() { calls.push('pending-src'); } },
    ctx: { state: 'running', close() { calls.push('pending-close'); return gate.promise.then(() => { this.state = 'closed'; }); } } };
  const doneNode = { length: 0,
    proc: { disconnect() { calls.push('done-proc'); } }, src: { disconnect() { calls.push('done-src'); } },
    ctx: { state: 'running', async close() { calls.push('done-close'); this.state = 'closed'; } } };
  const track = { onended() {}, stop() { calls.push('track-stop'); } };
  capture.nodes = [pendingNode, doneNode]; capture.streams = [{ getTracks: () => [track] }];
  try {
    await timedOut(capture.dispose());
    assert.equal(capture.nodes.length, 1); assert.equal(capture.nodes[0], pendingNode);
    assert.equal(capture.streams.length, 0, 'successfully released tracks need no retry');
    await timedOut(capture.dispose());
    assert.equal(capture.nodes.length, 1); assert.equal(capture.nodes[0], pendingNode);
    assert.equal(calls.filter(x => x === 'pending-close').length, 1, 'a pending close promise is reused rather than issuing another close');
    gate.resolve(); await turn(); await bounded(capture.dispose());
    assert.equal(capture.nodes.length, 0); assert.equal(capture.streams.length, 0);
    for (const name of ['pending-proc', 'pending-src', 'pending-close', 'done-proc', 'done-src', 'done-close', 'track-stop']) {
      assert.equal(calls.filter(x => x === name).length, 1, name + ' must not repeat after successful cleanup');
    }
  } finally { gate.resolve(); await turn(); }
});

test('recorder ctx.close迟到时重复close继续超时且复用原Promise，晚完成后可确认', async () => {
  const gate = deferred(), h = recorderFaults(); let closeCalls = 0;
  h.recorder.ctx = { state: 'running', close() { closeCalls++; return gate.promise.then(() => { this.state = 'closed'; }); } };
  const originalContext = h.recorder.ctx;
  try {
    await timedOut(h.recorder.close()); const pendingClose = h.recorder.contextClosing;
    await timedOut(h.recorder.close());
    assert.equal(closeCalls, 1); assert.equal(h.recorder.ctx, originalContext);
    assert.equal(h.recorder.contextClosing, pendingClose, 'unconfirmed close keeps the same in-flight promise');
    gate.resolve(); await turn(); await bounded(h.recorder.close());
    assert.equal(closeCalls, 1); assert.equal(originalContext.state, 'closed');
  } finally { gate.resolve(); await turn(); await h.releaseNative(); }
});

// Advance virtual monotonic time only after flushing promise continuations. Native
// events and save acknowledgements are controlled separately; no wall-clock races.
function progressClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  t.mock.method(globalThis.performance, 'now', () => Date.now());
}
async function advanceClock(t, ms) { t.mock.timers.tick(ms); await turn(); await turn(); }
function watch(promise) {
  const outcome = { state: 'pending' };
  outcome.done = promise.then(value => { outcome.state = 'fulfilled'; outcome.value = value; }, error => { outcome.state = 'rejected'; outcome.error = error; });
  return outcome;
}
function saveSteps() {
  const calls = []; let automatic = false;
  return {
    calls,
    save(record) { const gate = deferred(), entry = { record, gate, acknowledged: automatic }; calls.push(entry); if (automatic) gate.resolve(); return gate.promise; },
    acknowledge() { const entry = calls.find(x => !x.acknowledged); if (!entry) return false; entry.acknowledged = true; entry.gate.resolve(); return true; },
    finish() { automatic = true; for (const entry of calls) { entry.acknowledged = true; entry.gate.resolve(); } },
  };
}
async function driveProgress(t, outcome, controllers) {
  let elapsed = 0; await turn();
  for (let n = 0; n < 30 && outcome.state === 'pending'; n++) {
    await advanceClock(t, 500); elapsed += 500;
    assert.notEqual(outcome.state, 'rejected', 'confirmed save progress must not hit an overall deadline: ' + outcome.error?.message);
    for (const controller of controllers) controller.acknowledge();
    await turn(); await turn();
  }
  assert.equal(outcome.state, 'fulfilled', 'operation must finish after all confirmations');
  assert.ok(elapsed > 1000, 'fixture must exceed the old overall waitMs');
  return elapsed;
}

for (const method of ['pause', 'close', 'retry']) test('recorder ' + method + '持续确认保存时总耗时可超过waitMs', { timeout: 5000 }, async t => {
  progressClock(t); const steps = saveSteps(), h = recorderFaults({ waitMs: 1000, save: record => steps.save(record) });
  try {
    if (method === 'retry') for (let n = 0; n < 5; n++) h.recorder.push({ kind: 'recording-chunk', key: 'original-full', offset: n });
    else { h.recorder.start(); for (let n = 0; n < 5; n++) h.recorder.push({ kind: 'recording-chunk', key: 'original-full', offset: n }); }
    const outcome = watch(h.recorder[method]());
    await driveProgress(t, outcome, [steps]);
    assert.equal(h.recorder.queue.length, 0);
    assert.equal(new Set(steps.calls.map(x => x.record)).size, steps.calls.length, 'every original queued record is sent once');
    if (method === 'pause') {
      assert.equal(h.closed, 0); const full = h.instances[0]; h.recorder.start();
      assert.equal(h.instances[0], full); assert.equal(full.state, 'recording', 'slow but progressing pause remains resumable');
    }
  } finally { steps.finish(); await turn(); await h.releaseNative(); }
});

for (const method of ['flushAll', 'retry']) test('capture ' + method + '外层不截断持续确认的长队列', { timeout: 5000 }, async t => {
  progressClock(t); const steps = saveSteps();
  const capture = new MeetingCapture({ document: {}, window: {}, waitMs: 1000, save: record => steps.save(record), status() {} });
  capture.paused = true;
  try {
    for (let n = 0; n < 5; n++) capture.enqueue({ kind: 'heartbeat', at: n });
    await driveProgress(t, watch(capture[method]()), [steps]);
    assert.equal(capture.queue.length, 0); assert.equal(steps.calls.length, 5);
  } finally { steps.finish(); await turn(); }
});

test('capture正常pause持续排空超过waitMs后可resume且不dispose', { timeout: 5000 }, async t => {
  progressClock(t); const video = saveSteps(), materials = saveSteps(); let stopped = 0;
  const h = recorderFaults({ waitMs: 1000, save: record => video.save(record) });
  const capture = new MeetingCapture({ document: {}, window: { performance: { now: () => Date.now() } }, waitMs: 1000, save: record => materials.save(record), status() {} });
  const track = { stop() { stopped++; } }, stream = { getTracks: () => [track] };
  capture.started = Date.now(); capture.running = true; capture.recorder = h.recorder; capture.streams = [stream];
  try {
    h.recorder.start(); for (let n = 0; n < 5; n++) capture.enqueue({ kind: 'heartbeat', at: n });
    await driveProgress(t, watch(capture.pause()), [video, materials]);
    assert.equal(stopped, 0); assert.equal(h.closed, 0); assert.equal(capture.streams[0], stream);
    assert.equal(capture.running, true); assert.equal(capture.paused, true);
    assert.equal(capture.queue.length, 0); assert.equal(h.recorder.queue.length, 0);
    capture.resume(); assert.equal(capture.paused, false); assert.equal(h.instances[0].state, 'recording');
  } finally { video.finish(); materials.finish(); await turn(); await h.releaseNative(); }
});

for (const kind of ['recorder', 'capture']) test(kind + '保存进展停止后超时，新增入队不续期且retry不重发', { timeout: 5000 }, async t => {
  progressClock(t); const steps = saveSteps();
  const h = kind === 'recorder' ? recorderFaults({ waitMs: 1000, save: record => steps.save(record) }) : null;
  const owner = h?.recorder || new MeetingCapture({ document: {}, window: {}, waitMs: 1000, save: record => steps.save(record), status() {} });
  const enqueue = record => kind === 'recorder' ? owner.push(record) : owner.enqueue(record);
  try {
    for (let n = 0; n < 5; n++) enqueue({ kind: 'heartbeat', at: n });
    const outcome = watch(owner.retry()); await turn();
    for (let n = 0; n < 2; n++) { await advanceClock(t, 500); assert.equal(outcome.state, 'pending'); assert.equal(steps.acknowledge(), true); await turn(); }
    const heldRecord = owner.queue[0], saving = owner.saving, count = steps.calls.length;
    await advanceClock(t, 500); assert.equal(outcome.state, 'pending', 'less than waitMs since last confirmed save');
    enqueue({ kind: 'heartbeat', at: 999 });
    await advanceClock(t, 600);
    assert.equal(outcome.state, 'rejected', 'adding work is not confirmed save progress');
    assert.equal(outcome.error.code, 'MEETING_RECORDING_TIMEOUT');
    assert.equal(owner.saving, saving); assert.equal(owner.queue[0], heldRecord); assert.equal(steps.calls.length, count);
    const retry = watch(owner.retry()); await turn(); await advanceClock(t, 1100);
    assert.equal(retry.state, 'rejected'); assert.equal(retry.error.code, 'MEETING_RECORDING_TIMEOUT');
    assert.equal(steps.calls.length, count, 'retry must not resend the unresolved record');
    steps.finish(); await turn(); await turn(); const recovered = watch(owner.retry()); await turn(); await turn();
    assert.equal(recovered.state, 'fulfilled'); assert.equal(owner.queue.length, 0);
  } finally { steps.finish(); await turn(); if (h) await h.releaseNative(); }
});

for (const method of ['pause', 'close']) test('save持续确认不能延长recorder ' + method + '的native事件等待', { timeout: 5000 }, async t => {
  progressClock(t); const steps = saveSteps();
  const h = recorderFaults({ holdPause: method === 'pause', holdStop: method === 'close', waitMs: 1000, save: record => steps.save(record) });
  try {
    h.recorder.start(); for (let n = 0; n < 4; n++) h.recorder.push({ kind: 'recording-chunk', key: 'original-full', offset: n });
    const outcome = watch(h.recorder[method]()); await turn();
    for (let n = 0; n < 3; n++) {
      await advanceClock(t, 300); assert.equal(outcome.state, 'pending'); assert.equal(steps.acknowledge(), true); await turn();
    }
    await advanceClock(t, 200);
    assert.equal(outcome.state, 'rejected', 'unrelated save progress must not hide the missing native event');
    assert.equal(outcome.error.code, 'MEETING_RECORDING_TIMEOUT');
  } finally { steps.finish(); await turn(); await h.releaseNative(); }
});

test('recorder pause的native、Blob和saving阶段独立计时，不按整段累计截断', { timeout: 5000 }, async t => {
  progressClock(t); const blob = deferred(), saves = deferred(); let holdSave = false;
  const h = recorderFaults({ holdPause: true, waitMs: 1000, arrayBuffer: async bytes => { await blob.promise; return bytes; }, save: async () => { if (holdSave) await saves.promise; } });
  try {
    h.recorder.start(); await turn(); holdSave = true;
    const outcome = watch(h.recorder.pause()); await turn();
    await advanceClock(t, 800); assert.equal(outcome.state, 'pending'); h.instances[0].emitPause(); await turn(); await turn();
    await advanceClock(t, 800); assert.equal(outcome.state, 'pending', 'pending Blob has its own deadline after native pause');
    blob.resolve(); await turn(); await turn();
    await advanceClock(t, 800); assert.equal(outcome.state, 'pending', 'saving has its own deadline after Blob conversion');
    saves.resolve(); await turn(); await turn();
    assert.equal(outcome.state, 'fulfilled', 'three 800ms stages may total 2400ms with waitMs=1000');
    assert.equal(h.recorder.queue.length, 0); assert.equal(h.closed, 0); h.recorder.start(); assert.equal(h.instances[0].state, 'recording');
  } finally { blob.resolve(); saves.resolve(); await turn(); await h.releaseNative(); }
});
