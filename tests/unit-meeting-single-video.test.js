'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { MeetingRecorder } = require('../renderer/meeting-recorder');
const { MeetingTools } = require('../core/company-assistant/meeting-tools');

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
const webm = Buffer.from('1a45dfa3801853806701ffffffffffffff1549a966872ad7b1830f42401f43b67584a3820102', 'hex');
const MP4 = 'video/mp4;codecs=avc1.42E01F,mp4a.40.2';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-single-'));
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null }, { meetingAsr: { status: () => ({ ready: false }), close() {} } });
  t.after(() => { m.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const meeting = m.create({ title: '周会 / 方案:评审' }); clearInterval(m.timer); m.timer = 1;
  return { m, id: meeting.id };
}
const key = randomUUID();
function record(m, id, mime, bytes) {
  m.capture(id, { kind: 'recording-start', key, full: true, at: 0, mime, width: 100, height: 60 });
  m.capture(id, { kind: 'recording-chunk', key, at: 1000, durationMs: 1000, offset: 0, data: bytes.toString('base64') });
}

test('MP4 存成一个 recording-full.mp4，不走 WebM 时长修复', async t => {
  const { m, id } = setup(t);
  record(m, id, MP4, mp4);
  m.capture(id, { kind: 'recording-finish', key, at: 9000, durationMs: 9000 });
  await m.recording.repairs.get(id);
  const rec = m.load(id).recording;
  assert.equal(rec.full.file, 'recording-full.mp4'); assert.equal(rec.full.status, 'ready');
  assert.equal(rec.segments.length, 0); assert.ok(!rec.full.durationError);
  assert.ok(fs.readFileSync(m.recording.full(id).file).equals(mp4));
  assert.deepEqual(fs.readdirSync(m.dir(id)).filter(f => f.startsWith('recording')), ['recording-full.mp4']);
});

test('MP4 文件头不对时拒收', (t) => {
  const { m, id } = setup(t);
  assert.throws(() => record(m, id, MP4, webm), /文件头/);
});

test('暂停后会议时间和视频时间按缺口换算', (t) => {
  const { m, id } = setup(t);
  record(m, id, MP4, mp4);
  m.capture(id, { kind: 'recording-gap', at: 5000, end: 9000, reason: '暂停' });
  m.capture(id, { kind: 'recording-finish', key, at: 14000, durationMs: 10000 });
  assert.equal(m.recording.locate(id, 3000).offsetMs, 3000);
  const after = m.recording.locate(id, 12000);
  assert.equal(after.offsetMs, 8000, '会议第 12 秒是视频第 8 秒');
  assert.equal(after.segment.file, 'recording-full.mp4');
  assert.deepEqual(after.spans, [{ at: 0, mediaAt: 0 }, { at: 9000, mediaAt: 5000 }]);
  assert.throws(() => m.recording.locate(id, 7000), /缺口/);
});

test('异常退出的 MP4 也能回放，且不尝试修时长', async t => {
  const { m, id } = setup(t);
  record(m, id, MP4, mp4);
  const cur = m.load(id); m.recording.recover(cur); m.save(cur); await m.recording.repairs.get(id);
  const full = m.load(id).recording.full;
  assert.equal(full.status, 'interrupted'); assert.ok(!full.durationError);
  assert.equal(m.recording.locate(id, 500).segment.file, 'recording-full.mp4');
});

test('5.5.0 之前只有分段的老会议仍按分段回放', (t) => {
  const { m, id } = setup(t);
  const k = randomUUID();
  m.capture(id, { kind: 'recording-start', key: k, at: 0, mime: 'video/webm', width: 1, height: 1 });
  m.capture(id, { kind: 'recording-chunk', key: k, at: 1000, offset: 0, data: webm.toString('base64') });
  m.capture(id, { kind: 'recording-finish', key: k, at: 30000 });
  const r = m.recording.locate(id, 2000);
  assert.equal(r.segment.key, k); assert.equal(r.spans, undefined); assert.equal(r.offsetMs, 2000);
});

test('保存视频的默认文件名带日期和会议名，去掉非法字符', (t) => {
  const { m, id } = setup(t);
  record(m, id, MP4, mp4);
  assert.match(m.recording.exportName(id), /^\d{8}-周会 方案 评审\.mp4$/);
});

function harness(fail) {
  const instances = [], saved = [], errors = [];
  class Fake {
    constructor(stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; instances.push(this); if (fail.ctor?.(options.mimeType)) throw new Error('ctor'); }
    static isTypeSupported() { return true; }
    start() { this.state = 'recording'; if (fail.async?.(this.mimeType)) queueMicrotask(() => { this.onerror({ error: { message: '编码器不可用' } }); }); }
    requestData() {}
    pause() { this.state = 'paused'; queueMicrotask(() => this.onpause?.()); }
    resume() { this.state = 'recording'; }
    stop() { const b = webm; this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable({ data: { size: b.length, arrayBuffer: async () => b } }); this.onstop(); }); }
  }
  const recorder = new MeetingRecorder({ window: { MediaRecorder: Fake, crypto: { randomUUID } }, streams: [], elapsed: () => 1000, save: async r => { saved.push(r); }, onError: e => errors.push(e) });
  recorder.mimes = [MP4, 'video/webm;codecs=vp8,opus']; recorder.mime = recorder.mimes[0];
  recorder.stream = { getVideoTracks: () => [{ getSettings: () => ({ width: 100, height: 60 }) }] };
  recorder.ctx = { state: 'running', async close() { this.state = 'closed'; } };
  return { recorder, instances, saved, errors };
}
const turn = () => new Promise(r => setTimeout(r, 5));

test('一场只开一个录制器，不再切分段', async () => {
  const h = harness({});
  h.recorder.start(); await turn();
  assert.equal(h.instances.length, 1); assert.equal(h.instances[0].mimeType, MP4);
  await h.recorder.close();
  assert.equal(h.saved.filter(r => r.kind === 'recording-start').length, 1);
  assert.equal(h.saved.find(r => r.kind === 'recording-start').mime, MP4);
  assert.equal(h.saved.filter(r => r.kind === 'recording-finish').length, 1);
});

test('MP4 编码器一开始就报错时退回 WebM，不留错误格式的记录', async () => {
  const h = harness({ async: mime => mime === MP4 });
  h.recorder.start(); await turn();
  assert.equal(h.instances.length, 2); assert.deepEqual(h.errors, []);
  await h.recorder.close();
  const starts = h.saved.filter(r => r.kind === 'recording-start');
  assert.equal(starts.length, 1); assert.match(starts[0].mime, /^video\/webm/);
  assert.equal(h.saved.filter(r => r.kind === 'recording-finish').length, 1);
});

test('MP4 录制器创建失败时直接用 WebM', async () => {
  const h = harness({ ctor: mime => mime === MP4 });
  h.recorder.start();
  assert.match(h.recorder.full.recorder.mimeType, /^video\/webm/);
  await h.recorder.close();
  assert.match(h.saved.find(r => r.kind === 'recording-start').mime, /^video\/webm/);
});

test('伴侣只能读已存截图，读不到录像', async t => {
  const { m, id } = setup(t);
  const cur = m.load(id); cur.sessionId = randomUUID(); m.save(cur);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  m.capture(id, { kind: 'slide', at: 2000, data: jpeg.toString('base64'), forced: true });
  const slide = m.load(id).events.find(e => e.kind === 'slide');
  const tools = new MeetingTools(m), call = (name, args) => tools.invoke({ name, arguments: args, callerSessionId: cur.sessionId });
  const r = await call('meeting_slides', { seqs: [slide.seq] });
  assert.equal(r.content[1].type, 'image'); assert.equal(r.content[1].data, jpeg.toString('base64'));
  await assert.rejects(call('meeting_frames', { timesMs: [1000] }), /未知会议工具/);
  await assert.rejects(call('meeting_slides', { seqs: [1, 2, 3, 4, 5] }), /1至4/);
  await assert.rejects(call('meeting_slides', { seqs: [99999] }), /不是截图/);
  const index = JSON.parse((await call('meeting_index', {})).content[0].text);
  assert.equal(index.recording.segments, undefined);
  const skill = fs.readFileSync(path.join(__dirname, '../core/company-assistant/meeting-companion-skill.md'), 'utf8');
  assert.ok(!skill.includes('meeting_frames'));
});
