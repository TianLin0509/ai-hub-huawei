'use strict';
// R51（2026-11-27 一键反馈，v5.6.116）：录制中软件闪退后回不到原来的会议。
// 界面进程崩溃或整页重新载入时主进程还在，会议原来一直停在「采集中」；重启 Hub 后也只在历史里标成中断，页面是空白新会议。
// 这里验证：页面一没就收成「已中断」、已录内容一点不丢、顶部提示拿得到、「继续录制」接着往这一场里录、回放按时间切到续录片段。
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { wav } = require('../renderer/meeting-capture');

const mp4 = require('./helpers/meeting-media-fixtures').mp4Fixture();
const MP4 = 'video/mp4;codecs=avc1.42E01F,mp4a.40.2';
const companion = root => new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null }, { meetingAsr: { status: () => ({ ready: false }), close() {} } });

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-r51-'));
  const live = [];
  const open = () => { const m = companion(root); live.push(m); return m; };
  t.after(async () => {
    for (const m of live) { await Promise.all([...m.recording.repairs.values(), ...(m.recording.segmentRepairs?.values() || [])]); m.close(); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const m = open(), meeting = m.create({ title: '无线周会', sourceName: '整个屏幕', audio: ['mic'] }); clearInterval(m.timer); m.timer = 1;
  return { root, m, id: meeting.id, open };
}
// 录了 0–12 秒：整场录像一块、一张截图、一段麦克风录音、心跳到 12 秒。
function recordSome(m, id) {
  const key = randomUUID();
  m.capture(id, { kind: 'recording-start', key, full: true, at: 0, mime: MP4, width: 100, height: 60 });
  m.capture(id, { kind: 'recording-chunk', key, at: 10000, durationMs: 10000, offset: 0, data: mp4.toString('base64') });
  m.capture(id, { kind: 'slide', at: 3000, data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64') });
  m.capture(id, { kind: 'audio', track: 'mic', at: 1000, end: 9000, data: wav(new Float32Array(1600), 16000) });
  m.capture(id, { kind: 'heartbeat', at: 12000 });
  return key;
}
const fakePage = (wcId = 7) => Object.assign(new EventEmitter(), { id: wcId });

test('界面进程崩溃（主进程还在）：采集这场的页面一没，会议收成「已中断」，已录内容全在，顶部提示拿得到', async t => {
  const { m, id } = setup(t);
  const page = fakePage();
  m.bindOwner(id, page);
  recordSome(m, id);
  page.emit('render-process-gone', {}, { reason: 'oom', exitCode: -36861 });
  const after = m.load(id);
  assert.equal(after.state, 'interrupted');
  assert.equal(after.interruption.reason, '界面内存不足崩溃');
  assert.equal(after.interruption.savedMs, 12000);
  assert.equal(after.recording.full.status, 'interrupted', '录像不再一直显示「保存中」');
  assert.equal(after.recording.full.bytes, mp4.length);
  assert.deepEqual(after.events.map(e => e.kind), ['slide', 'audio'], '截图和录音段原样保留');
  for (const e of after.events) assert.ok(fs.existsSync(path.join(m.dir(id), e.file)), e.file + ' 文件还在');
  const status = m.status(null);
  assert.deepEqual({ id: status.lastInterrupted.id, title: status.lastInterrupted.title, savedMs: status.lastInterrupted.savedMs }, { id, title: '无线周会', savedMs: 12000 });
  await m.recording.repairs.get(id);
  assert.equal(m.recording.locate(id, 500).segment.file, 'recording-full.mp4', '中断前的录像能回放');
  // 能开新会了（原来会一直报「已有会议在采集」）。
  assert.doesNotThrow(() => { const next = m.create({ title: '下一场' }); m.control(next.id, 'stop'); });
});

test('整页重新载入也算页面没了；页面里的跳转（did-navigate-in-page）不算', t => {
  const { m, id } = setup(t);
  const page = fakePage(9);
  m.bindOwner(id, page); recordSome(m, id);
  page.emit('did-navigate-in-page');
  assert.equal(m.load(id).state, 'recording');
  page.emit('did-navigate');
  assert.equal(m.load(id).state, 'interrupted');
  assert.equal(m.load(id).interruption.reason, '界面重新载入');
});

test('Hub 整个闪退后重启：启动恢复收成「已中断」并记下已保存到哪，会议页顶部提示拿得到', t => {
  const { m, id, open } = setup(t);
  recordSome(m, id);
  m.close(); // 退出前刷盘，模拟进程在录制中途没了
  const again = open(); again.start(); clearInterval(again.timer); again.timer = 1;
  const after = again.load(id);
  assert.equal(after.state, 'interrupted');
  assert.equal(after.interruption.savedMs, 12000);
  assert.match(after.error, /已保存到 00:12/);
  assert.equal(again.status(null).lastInterrupted.id, id);
});

test('继续录制：接着往同一场里录，时间轴从已保存处往后接，续录画面另存一段，回放按时间切过去', async t => {
  const { m, id } = setup(t);
  const page = fakePage(); m.bindOwner(id, page); recordSome(m, id);
  page.emit('render-process-gone', {}, { reason: 'crashed' });
  await m.recording.repairs.get(id);
  const r = m.control(id, 'continue');
  assert.equal(r.meeting.state, 'recording');
  assert.equal(r.meeting.resumeAt, 13000);
  assert.equal(m.status(null).lastInterrupted, null, '继续之后不再提示');
  assert.ok(m.load(id).recording.gaps.some(g => g.at === 10000 && g.end === 13000), '中断那段记成录像缺口');
  const key = randomUUID();
  m.capture(id, { kind: 'recording-start', key, full: false, at: 13000, mime: MP4, width: 100, height: 60 });
  m.capture(id, { kind: 'recording-chunk', key, at: 20000, durationMs: 7000, offset: 0, data: mp4.toString('base64') });
  m.capture(id, { kind: 'slide', at: 15000, data: Buffer.from([0xff, 0xd8, 0xff, 0xe1, 9, 9, 9, 9]).toString('base64') });
  m.capture(id, { kind: 'recording-finish', key, at: 25000, durationMs: 12000 });
  await m.recording.segmentRepairs.get(id + ':' + key);
  m.control(id, 'stop');
  const done = m.load(id), seg = done.recording.segments.find(s => s.key === key);
  assert.equal(seg.file, `recording-${key}.mp4`); assert.equal(seg.status, 'ready'); assert.equal(seg.durationFixed, true);
  assert.equal(done.events.filter(e => e.kind === 'slide').length, 2, '中断前后的截图都在');
  assert.equal(m.recording.locate(id, 2000).segment.file, 'recording-full.mp4');
  const later = m.recording.locate(id, 16000);
  assert.equal(later.segment.key, key); assert.equal(later.offsetMs, 3000);
  assert.throws(() => m.recording.locate(id, 11000), /缺口/);
});

test('不再提示：关掉后不再出现；不是中断的会议不能继续', t => {
  const { m, id } = setup(t);
  const page = fakePage(); m.bindOwner(id, page); recordSome(m, id);
  assert.throws(() => m.control(id, 'continue'), /没有中断/);
  page.emit('destroyed');
  assert.ok(m.status(null).lastInterrupted);
  m.control(id, 'dismiss-interruption');
  assert.equal(m.status(null).lastInterrupted, null);
  assert.equal(m.load(id).state, 'interrupted', '只是不提示，会议照旧可查看');
});

// R51 独立审查 P1-2：续录中途又崩溃，原来把已录的续录片段整段记成缺口、不能回放；整场录像结束之后的时间也会拿整场录像去放。
test('续录中途又崩溃：已录的续录片段照样能回放、补好索引，不整段记成缺口；整场录像结束之后的时间不拿整场录像去放', async t => {
  const { m, id } = setup(t);
  const page = fakePage(); m.bindOwner(id, page); recordSome(m, id);
  page.emit('render-process-gone', {}, { reason: 'crashed' });
  await m.recording.repairs.get(id);
  m.control(id, 'continue');
  const page2 = fakePage(8); m.bindOwner(id, page2);
  const key = randomUUID();
  m.capture(id, { kind: 'recording-start', key, full: false, at: 13000, mime: MP4, width: 100, height: 60 });
  m.capture(id, { kind: 'recording-chunk', key, at: 20000, durationMs: 7000, offset: 0, data: mp4.toString('base64') });
  page2.emit('render-process-gone', {}, { reason: 'oom' });
  await m.recording.segmentRepairs?.get(id + ':' + key);
  const after = m.load(id), seg = after.recording.segments.find(s => s.key === key);
  assert.equal(after.state, 'interrupted');
  assert.equal(seg.status, 'interrupted'); assert.ok(seg.bytes > 0); assert.equal(seg.durationFixed, true, '中断的续录片段也补了索引');
  assert.ok(!after.recording.gaps.some(g => g.at <= 15000 && 15000 < g.end), '已录的续录那段不算缺口');
  const hit = m.recording.locate(id, 15000);
  assert.equal(hit.segment.key, key); assert.equal(hit.offsetMs, 2000);
  assert.throws(() => m.recording.locate(id, 25000), /没有已完成的录制片段/, '整场录像只录到 10 秒，之后的时间不能拿它去放');
  assert.equal(m.status(null).lastInterrupted.id, id, '二次中断照样在顶部提示');
});
test('回放：整场录像播完自动接续录片段；缺口里和整场录像结束之后不给「回放此处」', () => {
  const replay = require('../renderer/company-meeting-replay');
  const full = { key: 'f', full: true, at: 0, end: 10000, bytes: 10, status: 'interrupted', mime: MP4 };
  const seg = { key: 's', at: 13000, end: 20000, bytes: 10, status: 'interrupted', mime: MP4 };
  const rec = { full, segments: [seg], gaps: [{ at: 10000, end: 13000 }] };
  assert.equal(replay.nextSegment(rec, full), seg);
  assert.equal(replay.nextSegment(rec, seg), null);
  assert.deepEqual([5000, 11000, 15000, 25000].map(at => replay.canReplayAt(rec, at)), [true, false, true, false]);
  assert.equal(replay.canReplayAt({ full: { ...full, status: 'ready', end: 10000 }, segments: [], gaps: [] }, 9000), true, '正常会议不受影响');
  const page = fs.readFileSync(path.join(__dirname, '../renderer/company-meeting-page.js'), 'utf8');
  assert.match(page, /addEventListener\('ended',\(\)=>\{if\(!playback\)return;const next=replay\.nextSegment\(/, '带暂停缺口（spans）的整场录像播完也接着放');
  assert.match(page, /function canReplayAt\(at\)\{return replay\.canReplayAt\(/);
});
// R51 独立审查 P1-1：原窗口找不到时，原来先切到这场会议（页面进入 review 态），选窗网格被隐藏，用户没法按提示选窗口。
test('继续录制时原窗口找不到：回到准备页露出选窗网格，第二次点不重刷列表、用刚选的窗口', () => {
  const page = fs.readFileSync(path.join(__dirname, '../renderer/company-meeting-page.js'), 'utf8').replace(/\r\n/g, '\n');
  const body = page.slice(page.indexOf('async function continueInterrupted'), page.indexOf('async function action('));
  assert.ok(body.length > 200);
  assert.doesNotMatch(body, /selectMeeting\(li\.id\)/, '不先切到这场会议');
  assert.doesNotMatch(body, /el\('setup'\)\.open = true/, 'section 没有 open，设了也无效');
  assert.match(body, /root\.dataset\.resumePick = li\.id; if \(id\) selectMeeting\(''\);\s*throw new Error\(`原来共享的窗口/);
  assert.match(body, /if \(!picking \|\| !sourceList\.length\) await action\('sources'\);/);
  const css = fs.readFileSync(path.join(__dirname, '../renderer/styles/company-meeting.css'), 'utf8');
  assert.match(css, /\.company-meeting:not\(\[data-phase=idle\]\) \.meeting-setup-card\{display:none\}/, '选窗网格只在准备页露出，所以要回到准备页');
});
