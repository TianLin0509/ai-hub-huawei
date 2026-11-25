'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { fixMp4Index, boxes, parseMoov, box } = require('../core/company-assistant/meeting-mp4-index');
const { fixWebmDuration, element } = require('../core/company-assistant/meeting-webm-duration');
const { mp4Fixture, webmFixture } = require('./helpers/meeting-media-fixtures');
async function file(t, name, bytes) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-index-')); t.after(() => fs.rm(root, { recursive: true, force: true })); const p = path.join(root, name); await fs.writeFile(p, bytes); return p; }
function children(b, e) { const out = []; for (let at = e.start; at < e.end;) { const x = element(b, at); assert.ok(x.end <= e.end); out.push(x); at = x.end; } return out; }
for (const version of [0, 1]) for (const absolute of [false, true]) test(`MP4 v${version}, absolute=${absolute}: duration, RAP entries, payload, offsets, idempotence`, async t => {
  const original = mp4Fixture({ version, absolute }), p = await file(t, 'test.mp4', original); await fixMp4Index(p); const b = await fs.readFile(p), top = boxes(b), moov = top.find(x => x.type === 'moov'), info = parseMoov(b.subarray(moov.at, moov.end));
  const d = info.mvhd.start + (version ? 24 : 16); assert.equal(Number(version ? info.b.readBigUInt64BE(d) : info.b.readUInt32BE(d)), 3000);
  const mvex = boxes(info.b, info.mvex.start, info.mvex.end), mehd = mvex.find(x => x.type === 'mehd'); assert.equal(mvex[0].type, 'mehd'); assert.equal(Number(info.b.readBigUInt64BE(mehd.start + 4)), 3000);
  const mfra = top.at(-1); assert.equal(mfra.type, 'mfra'); const tfra = boxes(b, mfra.start, mfra.end)[0], count = b.readUInt32BE(tfra.start + 12); assert.equal(count, 3);
  const moofs = top.filter(x => x.type === 'moof');
  for (let n = 0; n < count; n++) {
    const at = tfra.start + 16 + n * 28; assert.equal(Number(b.readBigUInt64BE(at)), n * 1000); assert.equal(Number(b.readBigUInt64BE(at + 8)), moofs[n].at); assert.equal(b.readUInt32BE(at + 24), 1, 'dependent frame never indexed');
    const traf = boxes(b, moofs[n].start, moofs[n].end)[0], tfhd = boxes(b, traf.start, traf.end).find(x => x.type === 'tfhd'); if (absolute) assert.equal(Number(b.readBigUInt64BE(tfhd.start + 8)), moofs[n].at);
  }
  const beforePayload = boxes(original).filter(x => x.type === 'mdat').map(x => original.subarray(x.start, x.end)); assert.deepEqual(top.filter(x => x.type === 'mdat').map(x => b.subarray(x.start, x.end)), beforePayload);
  assert.equal(b.readUInt32BE(b.length - 4), mfra.size); await fixMp4Index(p); assert.deepEqual(await fs.readFile(p), b);
});
for (const group of [false, true]) for (const finite of [false, true]) test(`WebM group=${group}, finite=${finite}: Duration, SeekHead/Cues and positions, idempotence`, async t => {
  const p = await file(t, 'test.webm', webmFixture({ group, finite })); await fixWebmDuration(p, 3000); const b = await fs.readFile(p), seg = element(b, element(b, 0).end), fields = children(b, seg), info = fields.find(x => x.id === 0x1549a966), cues = fields.find(x => x.id === 0x1c53bb6b), seek = fields.find(x => x.id === 0x114d9b74);
  assert.equal(seg.end, b.length); assert.equal(b.readDoubleBE(children(b, info).find(x => x.id === 0x4489).start), 3000);
  for (const s of children(b, seek)) { const f = children(b, s), id = f.find(x => x.id === 0x53ab), pos = f.find(x => x.id === 0x53ac), dest = element(b, seg.start + Number(b.readBigUInt64BE(pos.start))); assert.equal(dest.id, b.readUIntBE(id.start, id.size)); }
  const points = children(b, cues); assert.equal(points.length, 3);
  for (const point of points) { const pos = children(b, children(b, point).find(x => x.id === 0xb7)).find(x => x.id === 0xf1); assert.equal(element(b, seg.start + Number(b.readBigUInt64BE(pos.start))).id, 0x1f43b675); }
  await fixWebmDuration(p, 3000); assert.deepEqual(await fs.readFile(p), b);
});
for (const [name, fixture, fix] of [['mp4', mp4Fixture, fixMp4Index], ['webm', webmFixture, p => fixWebmDuration(p, 3000)]]) test(`${name}: truncated/corrupt input stays byte-identical, temporary files removed`, async t => {
  const good = fixture(); for (const bad of [good.subarray(0, 7), good.subarray(0, -1), Buffer.alloc(100)]) {
    const p = await file(t, 'bad.' + name, bad); await assert.rejects(() => fix(p)); assert.deepEqual(await fs.readFile(p), bad); assert.deepEqual(await fs.readdir(path.dirname(p)), [path.basename(p)]);
  }
});
test('WebM TimestampScale converts milliseconds to ticks', async t => {
  const p = await file(t, 'ticks.webm', webmFixture({ scale: 100000 })); await fixWebmDuration(p, 3000); const b = await fs.readFile(p), s = element(b, element(b, 0).end), i = children(b, s).find(x => x.id === 0x1549a966), d = children(b, i).find(x => x.id === 0x4489); assert.equal(b.readDoubleBE(d.start), 30000);
});

async function recordingFixture(t, bytes, mime) {
  const { MeetingRecording } = require('../core/company-assistant/meeting-recording'), { randomUUID } = require('node:crypto');
  const isMp4 = mime.startsWith('video/mp4'), name = 'recording-full.' + (isMp4 ? 'mp4' : 'webm'), p = await file(t, name, bytes);
  let state = { id: 'test', summary: '保留新纪要', capturedMs: 3000, recording: { segments: [], gaps: [], bytes: bytes.length, full: { key: randomUUID(), full: true, file: name, mime, status: 'ready', at: 0, end: 3000, durationMs: 3000, bytes: bytes.length, durationFixed: true } } };
  const service = { load: () => structuredClone(state), save: value => { state = structuredClone(value); }, dir: () => path.dirname(p), time: Math.round };
  const recorder = new MeetingRecording(service); t.after(() => { service.closed = true; for (const timer of recorder.retryTimers.values()) clearTimeout(timer); });
  return { service, recorder, file: p, get: () => structuredClone(state) };
}
test('old duration-only WebM repairs once in background, without losing newer meeting state', async t => {
  const f = await recordingFixture(t, webmFixture(), 'video/webm'), r = f.recorder;
  r.full('test'); const pending = r.repairs.get('test'); assert.ok(pending); r.index('test'); assert.equal(r.repairs.get('test'), pending);
  const updated = f.service.load(); updated.summary = '更新后的纪要'; f.service.save(updated); await pending;
  assert.equal(f.get().recording.full.seekIndexVersion, 1); assert.equal(f.get().summary, '更新后的纪要'); assert.equal(f.get().recording.full.repairing, undefined);
  const before = await fs.readFile(f.file); r.full('test'); r.index('test'); r.locate('test', 2000); assert.equal(r.repairs.size, 0); assert.deepEqual(await fs.readFile(f.file), before);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(check, message) { for (const end = Date.now() + 3000; Date.now() < end;) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail(message); }
test('disk preflight reserves 110% plus 512MB and rejects before creating any temporary file', async t => {
  const p = await file(t, 'disk.mp4', mp4Fixture()), original = await fs.readFile(p); let creates = 0;
  const open = fs.open.bind(fs); t.mock.method(fs, 'open', async (...args) => { if (args[1] === 'wx') creates++; return open(...args); });
  t.mock.method(fs, 'statfs', async () => ({ bavail: 1n, bsize: 1n }));
  await assert.rejects(() => fixMp4Index(p), e => e.code === 'ENOSPC' && /磁盘空间不足.*原片可正常播放/.test(e.message));
  assert.equal(creates, 0); assert.deepEqual(await fs.readFile(p), original); assert.deepEqual(await fs.readdir(path.dirname(p)), ['disk.mp4']);
  const webm = await file(t, 'disk.webm', webmFixture()); await assert.rejects(() => fixWebmDuration(webm, 3000), { code: 'ENOSPC' }); assert.equal(creates, 0, 'WebM cues spool also follows preflight');
});
test('rename busy retries three times with bounded backoff and preserves the original on every failure', async t => {
  const original = mp4Fixture(), f = await recordingFixture(t, original, 'video/mp4'), r = f.recorder; r.retryDelays = [10, 20, 30]; let calls = 0;
  t.mock.method(fs, 'rename', async () => { calls++; assert.deepEqual(await fs.readFile(f.file), original); throw Object.assign(Error('held by player'), { code: 'EBUSY' }); });
  r.full('test'); await r.repairs.get('test');
  assert.equal(f.get().recording.full.repairFailure.kind, 'transient'); assert.equal(f.get().recording.full.repairFailure.attempts, 1);
  await until(() => calls === 4 && !r.repairs.size, 'initial attempt plus three retries'); await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(calls, 4); assert.equal(f.get().recording.full.repairFailure.nextAt, null); assert.equal(r.retryTimers.size, 0); assert.deepEqual(await fs.readFile(f.file), original);
});
test('transient rename failure survives restart; explicit save retries immediately and succeeds', async t => {
  const f = await recordingFixture(t, mp4Fixture(), 'video/mp4'), rename = fs.rename.bind(fs); let calls = 0;
  t.mock.method(fs, 'rename', async (...args) => { if (++calls === 1) throw Object.assign(Error('antivirus'), { code: 'EPERM' }); return rename(...args); });
  f.recorder.full('test'); await f.recorder.repairs.get('test'); assert.ok(f.get().recording.full.repairFailure.nextAt > Date.now());
  for (const timer of f.recorder.retryTimers.values()) clearTimeout(timer); f.recorder.retryTimers.clear();
  const { MeetingRecording } = require('../core/company-assistant/meeting-recording'), restart = new MeetingRecording(f.service);
  const prepared = await restart.prepareFull('test'); assert.equal(calls, 2); assert.equal(prepared.recording.seekIndexVersion, 1); assert.equal(prepared.recording.durationError, ''); assert.equal(prepared.recording.repairFailure, undefined);
});
test('low disk is transient, can recover on explicit open, and never consumes original bytes', async t => {
  const f = await recordingFixture(t, mp4Fixture(), 'video/mp4'), statfs = fs.statfs.bind(fs); let low = true;
  t.mock.method(fs, 'statfs', (...args) => low ? Promise.resolve({ bavail: 0n, bsize: 1n }) : statfs(...args));
  f.recorder.full('test'); await f.recorder.repairs.get('test'); assert.equal(f.get().recording.full.repairFailure.code, 'ENOSPC'); assert.match(f.get().recording.full.durationError, /原片可正常播放/);
  low = false; assert.equal((await f.recorder.prepareFull('test')).recording.seekIndexVersion, 1);
});
test('automatic retry succeeds after a temporary antivirus lock is released', async t => {
  const f = await recordingFixture(t, mp4Fixture(), 'video/mp4'), rename = fs.rename.bind(fs); let calls = 0; f.recorder.retryDelays = [10, 20, 30];
  t.mock.method(fs, 'rename', async (...args) => { if (++calls === 1) throw Object.assign(Error('antivirus'), { code: 'EPERM' }); return rename(...args); });
  f.recorder.full('test'); await until(() => f.get().recording.full.seekIndexVersion === 1, 'scheduled retry succeeds without another user click');
  assert.equal(calls, 2); assert.equal(f.get().recording.full.repairFailure, undefined); assert.equal(f.recorder.errors.size, 0); assert.equal(f.recorder.retryTimers.size, 0);
});
test('restart honors persisted retry deadline and resumes automatically', async t => {
  const f = await recordingFixture(t, mp4Fixture(), 'video/mp4'), state = f.service.load();
  state.recording.full.durationError = '播放器占用，稍后重试'; state.recording.full.repairFailure = { kind: 'transient', code: 'EBUSY', attempts: 1, nextAt: Date.now() + 15 }; f.service.save(state);
  f.recorder.index('test'); assert.equal(f.recorder.repairs.size, 0); assert.equal(f.recorder.retryTimers.size, 1);
  await until(() => f.get().recording.full.seekIndexVersion === 1, 'persisted retry resumes'); assert.equal(f.get().recording.full.durationError, '');
});
test('space preflight applies the exact required reserve boundary', async t => {
  const { checkSpace } = require('../core/company-assistant/meeting-media-io'), p = await file(t, 'reserve.mp4', mp4Fixture()), required = 1100n + 512n * 1024n ** 2n; let available = required - 1n;
  t.mock.method(fs, 'statfs', async () => ({ bavail: available, bsize: 1n })); await assert.rejects(() => checkSpace(p, 1000), { code: 'ENOSPC' }); available = required; await checkSpace(p, 1000);
});
test('unsupported filesystem capacity probes allow finalization instead of making a permanent failure', async t => {
  let code; t.mock.method(fs, 'statfs', async () => { throw Object.assign(Error('capacity query unavailable'), { code }); });
  for (code of ['ENOSYS', 'ENOTSUP', 'EINVAL', 'EOPNOTSUPP']) {
    const p = await file(t, code + '.mp4', mp4Fixture()); await fixMp4Index(p); const b = await fs.readFile(p); assert.equal(boxes(b).at(-1).type, 'mfra', code);
  }
});
test('clicking save during atomic repair waits for that task and exports the repaired bytes exactly once', async t => {
  const f = await recordingFixture(t, mp4Fixture(), 'video/mp4'), r = f.recorder, rename = fs.rename.bind(fs);
  let releaseRename, enteredRename, renameCalls = 0, dialogs = 0, revealed, saved = false;
  const held = new Promise(resolve => { releaseRename = resolve; }), entered = new Promise(resolve => { enteredRename = resolve; });
  t.mock.method(fs, 'rename', async (...args) => { renameCalls++; enteredRename(); await held; return rename(...args); });
  const destination = path.join(path.dirname(f.file), 'saved-test.mp4'), Module = require('node:module'), load = Module._load;
  const electron = { dialog: { async showSaveDialog() { dialogs++; return { canceled: false, filePath: destination }; } }, shell: { showItemInFolder(file) { revealed = file; } } };
  t.mock.method(Module, '_load', function (request, ...args) { return request === 'electron' ? electron : load.call(this, request, ...args); });
  f.service.recording = r; r.exportName = () => 'saved-test.mp4';
  const handlers = require('../core/company-assistant/meeting-ipc').createMeetingHandlers({ meetings: f.service });
  r.full('test'); await entered; const repairing = r.repairs.get('test');
  const saving = handlers['meeting-save-video']({ id: 'test' }).then(value => { saved = true; return value; });
  try {
    await turn(); assert.equal(saved, false); assert.equal(dialogs, 0); assert.equal(r.repairs.get('test'), repairing); await assert.rejects(() => fs.stat(destination), { code: 'ENOENT' });
  } finally { releaseRename(); }
  const result = await saving; assert.equal(result.ok, true); assert.equal(result.file, destination); assert.equal(dialogs, 1); assert.equal(renameCalls, 1); assert.equal(revealed, destination);
  assert.equal(f.get().recording.full.seekIndexVersion, 1); assert.deepEqual(await fs.readFile(destination), await fs.readFile(f.file));
});
test('separate timeout marker and legacy timeout message both resume after a process restart', async t => {
  for (const legacy of [false, true]) {
    const f = await recordingFixture(t, mp4Fixture(), 'video/mp4'), state = f.service.load();
    if (legacy) state.recording.full.durationError = '索引还在补，先打开原片；稍后再试可拖动。'; else state.recording.full.repairPending = '索引还在补';
    f.service.save(state); const fixed = await f.recorder.prepareFull('test'); assert.equal(fixed.recording.seekIndexVersion, 1); assert.equal(fixed.recording.repairPending, undefined); assert.equal(fixed.recording.durationError, '');
  }
});
test('finish and save wait for in-flight final chunk and closed descriptor before scanning', async t => {
  const bytes = mp4Fixture(), f = await recordingFixture(t, bytes.subarray(0, -1), 'video/mp4'), r = f.recorder, state = f.service.load();
  state.recording.full.status = 'writing'; state.recording.full.bytes = 0; f.service.save(state);
  let release, drained = false; const pending = new Promise(resolve => { release = resolve; });
  r.drain = async () => { await pending; await fs.appendFile(f.file, bytes.subarray(-1)); drained = true; };
  const live = f.service.load(); r.accept(live, { kind: 'recording-finish', key: live.recording.full.key, at: 3000, durationMs: 3000 }); f.service.save(live);
  const prepared = r.prepareFull('test'); await turn(); assert.equal(drained, false); assert.equal(f.get().recording.full.status, 'writing'); assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['recording-full.mp4']);
  release(); const final = await prepared; assert.equal(drained, true); assert.equal(final.recording.status, 'ready'); assert.equal(final.recording.seekIndexVersion, 1); assert.equal(final.recording.durationError, '');
});
test('recovery removes only stale finalizer temp files belonging to this recording', async t => {
  const f = await recordingFixture(t, mp4Fixture(), 'video/mp4'), { randomUUID } = require('node:crypto'), dir = path.dirname(f.file);
  const names = ['index', 'tfra', 'cues'].map(kind => path.basename(f.file) + '.' + kind + '-' + randomUUID() + '.tmp');
  for (const name of names) await fs.writeFile(path.join(dir, name), 'left from killed process');
  await fs.writeFile(path.join(dir, 'other-recording.index-' + randomUUID() + '.tmp'), 'keep');
  f.recorder.startedAt = Date.now() + 1000; await f.recorder.prepareFull('test');
  const left = await fs.readdir(dir); assert.equal(left.length, 2); assert.ok(left.some(name => name.startsWith('other-recording'))); for (const name of names) assert.ok(!left.includes(name));
});
test('MP4 largesize header is preserved and all tfra offsets account for its 16-byte header', async t => {
  const original = mp4Fixture(), first = boxes(original)[0], header = Buffer.alloc(16); header.writeUInt32BE(1); header.write('ftyp', 4); header.writeBigUInt64BE(BigInt(first.size + 8), 8);
  const p = await file(t, 'large.mp4', Buffer.concat([header, original.subarray(8)])); await fixMp4Index(p); const b = await fs.readFile(p), fields = boxes(b); assert.equal(fields[0].start, 16); assert.deepEqual(b.subarray(0, 16), header);
  const mfra = fields.at(-1), tfra = boxes(b, mfra.start, mfra.end)[0], moofs = fields.filter(x => x.type === 'moof'); for (let i = 0; i < 3; i++) assert.equal(Number(b.readBigUInt64BE(tfra.start + 24 + i * 28)), moofs[i].at);
});
test('nonterminal mfra and truncated moov are deterministic failures with original bytes retained', async t => {
  const p = await file(t, 'mfra.mp4', mp4Fixture()); await fixMp4Index(p); await fs.appendFile(p, box('free', Buffer.alloc(0))); const before = await fs.readFile(p); await assert.rejects(() => fixMp4Index(p), /文件尾/); assert.deepEqual(await fs.readFile(p), before);
  const corrupt = mp4Fixture(), moov = boxes(corrupt).find(x => x.type === 'moov'); corrupt.writeUInt32BE(moov.size, moov.start); const bad = await file(t, 'bad-moov.mp4', corrupt); await assert.rejects(() => fixMp4Index(bad), /长度无效/); assert.deepEqual(await fs.readFile(bad), corrupt);
});
test('zero-duration final sample is retained without rejecting the complete preceding media', async t => {
  const b = mp4Fixture(), moof = boxes(b).filter(x => x.type === 'moof').at(-1), traf = boxes(b, moof.start, moof.end)[0], trun = boxes(b, traf.start, traf.end).find(x => x.type === 'trun'); b.writeUInt32BE(0, trun.start + 24);
  const p = await file(t, 'zero-final.mp4', b); await fixMp4Index(p); const fixed = await fs.readFile(p), moov = boxes(fixed).find(x => x.type === 'moov'), info = parseMoov(fixed.subarray(moov.at, moov.end)); assert.equal(info.b.readUInt32BE(info.mvhd.start + 16), 2500); await fixMp4Index(p); assert.deepEqual(await fs.readFile(p), fixed);
});
test('dual-track moofs generate per-track tfra entries with correct traf number and data positions', async t => {
  const b = mp4Fixture(), fields = boxes(b), moov = fields.find(x => x.type === 'moov'), root = boxes(b, moov.start, moov.end), trak = root.find(x => x.type === 'trak'), mvex = root.find(x => x.type === 'mvex');
  const secondTrack = Buffer.from(b.subarray(trak.at, trak.end)), tkhd = boxes(secondTrack, 8, secondTrack.length).find(x => x.type === 'tkhd'); secondTrack.writeUInt32BE(2, tkhd.start + 12);
  const trex2 = Buffer.from(b.subarray(mvex.start, mvex.end)); trex2.writeUInt32BE(2, 12);
  const header = Buffer.concat([b.subarray(0, moov.at), box('moov', Buffer.concat([...root.filter(x => x.type !== 'mvex').map(x => b.subarray(x.at, x.end)), secondTrack, box('mvex', Buffer.concat([b.subarray(mvex.start, mvex.end), trex2]))]))]);
  const fragments = [];
  for (const m of fields.filter(x => x.type === 'moof')) {
    const source = boxes(b, m.start, m.end)[0], tracks = [1, 2].map(id => { const copy = Buffer.from(b.subarray(source.at, source.end)), tfhd = boxes(copy, 8, copy.length).find(x => x.type === 'tfhd'); copy.writeUInt32BE(id, tfhd.start + 4); return copy; });
    const size = 8 + tracks.reduce((n, t) => n + t.length, 0); tracks.forEach((copy, n) => { const run = boxes(copy, 8, copy.length).find(x => x.type === 'trun'); copy.writeInt32BE(size + 8 + n * 8, run.start + 8); });
    fragments.push(box('moof', Buffer.concat(tracks)), box('mdat', Buffer.alloc(16)));
  }
  const p = await file(t, 'dual.mp4', Buffer.concat([header, ...fragments])); await fixMp4Index(p); const out = await fs.readFile(p), top = boxes(out), mfra = top.at(-1), tfra = boxes(out, mfra.start, mfra.end).filter(x => x.type === 'tfra'); assert.equal(tfra.length, 2);
  for (let track = 0; track < 2; track++) { assert.equal(out.readUInt32BE(tfra[track].start + 4), track + 1); for (let n = 0; n < 3; n++) { const at = tfra[track].start + 16 + 28 * n; assert.equal(Number(out.readBigUInt64BE(at + 8)), top.filter(x => x.type === 'moof')[n].at); assert.equal(out.readUInt32BE(at + 16), track + 1); } }
  await fixMp4Index(p); assert.deepEqual(await fs.readFile(p), out);
});
test('failed old recording is preserved, reason saved, and not retried by polling or next startup', async t => {
  const bad = Buffer.from('truncated media'), f = await recordingFixture(t, bad, 'video/mp4'), r = f.recorder;
  r.full('test'); await r.repairs.get('test'); assert.match(f.get().recording.full.durationError, /已保留.*失败/); assert.deepEqual(await fs.readFile(f.file), bad);
  r.index('test'); r.full('test'); assert.equal(r.repairs.size, 0);
  const { MeetingRecording } = require('../core/company-assistant/meeting-recording'), next = new MeetingRecording(f.service), before = f.get(); await next.repair('test'); assert.deepEqual(f.get(), before); assert.deepEqual(await fs.readFile(f.file), bad);
});
test('prepareFull timeout returns preserved original while existing background repair stays pending', async t => {
  const f = await recordingFixture(t, mp4Fixture(), 'video/mp4'); let finish; const task = new Promise(resolve => { finish = resolve; });
  f.recorder.repairs.set('test', task); const start = Date.now(), result = await f.recorder.prepareFull('test', 5);
  assert.equal(result.file, f.file); assert.ok(Date.now() - start < 1000); assert.match(result.recording.repairPending, /索引还在补/); assert.ok(!result.recording.durationError); assert.equal(f.recorder.repairs.get('test'), task); finish(); await task;
});
test('temporary write failure and concurrent original append never replace the original', async t => {
  const io = require('../core/company-assistant/meeting-media-io'), original = Buffer.from('original'), p = await file(t, 'atomic.bin', original);
  await assert.rejects(() => io.replace(p, async (_input, output) => { await io.write(output, Buffer.from('replacement')); throw Error('ENOSPC injected'); }), /ENOSPC/); assert.deepEqual(await fs.readFile(p), original);
  await assert.rejects(() => io.replace(p, async (_input, output) => { await io.write(output, Buffer.from('replacement')); await fs.appendFile(p, '!'); }), /仍在写入/); assert.equal((await fs.readFile(p)).toString(), 'original!');
  assert.deepEqual(await fs.readdir(path.dirname(p)), ['atomic.bin']);
});
test('MP4 explicit zero base corrects absolute trun data offsets when moov grows', async t => {
  const p = await file(t, 'zero-base.mp4', mp4Fixture({ absolute: true, baseZero: true })); await fixMp4Index(p); const b = await fs.readFile(p), top = boxes(b);
  for (const m of top.filter(x => x.type === 'moof')) { const traf = boxes(b, m.start, m.end)[0], trun = boxes(b, traf.start, traf.end).find(x => x.type === 'trun'); const data = b.readInt32BE(trun.start + 8); assert.equal(data, m.end + 8); assert.equal(b.toString('ascii', data - 4, data), 'mdat'); }
  await fixMp4Index(p); assert.deepEqual(await fs.readFile(p), b);
});
test('bad recordings retain bytes and persisted error; polling/restart never retries', async t => {
  const f = await recordingFixture(t, Buffer.from('invalid recording'), 'video/mp4'), r = f.recorder;
  r.full('test'); await r.repairs.get('test'); assert.match(f.get().recording.full.durationError, /录像已保留/); assert.equal(await fs.readFile(f.file, 'utf8'), 'invalid recording');
  r.index('test'); r.full('test'); assert.equal(r.repairs.size, 0);
  const { MeetingRecording } = require('../core/company-assistant/meeting-recording'), restarted = new MeetingRecording(f.service); restarted.index('test'); assert.equal(restarted.repairs.size, 0);
});
test('prepareFull waits for old-file repair; timeout returns original while repair remains pending', async t => {
  const f = await recordingFixture(t, mp4Fixture(), 'video/mp4'), r = f.recorder;
  const fixed = await r.prepareFull('test'); assert.equal(fixed.recording.seekIndexVersion, 1);
  let release; const pending = new Promise(resolve => { release = resolve; }); r.repairs.set('test', pending);
  const response = await r.prepareFull('test', 5); assert.equal(response.file, f.file); assert.match(response.recording.repairPending, /索引还在补/); assert.ok(!response.recording.durationError); assert.equal(r.repairs.get('test'), pending); release(); await pending;
});
