'use strict';
// 会议存储层微基准（2026-11-24 m3）：同一脚本量改前改后。不进 npm test。
// 用法：node tests/perf-meeting-storage-bench.js [输出json路径]
// 场景：30 场历史会议（10 场 6000 事件、20 场 1000 事件）+ 1 场正在采集、已有 6000 事件的会议。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { compactEvents } = require('../core/company-assistant/meeting-context');

const words = '我们这个调度算法在高负载下的吞吐收益大概是百分之三到五然后需要再确认一下干扰场景的表现下周二之前给出结论负责人是小王'.split('');
const text = n => { let s = ''; for (let i = 0; i < n; i++) s += words[(i * 7 + n) % words.length]; return s; };
function gen(n, state = 'ended') {
  const m = { id: randomUUID(), title: '压测会议', sourceName: 'x', audio: ['system', 'mic'], startedAt: Date.now() - 7200000, state, capturedMs: 0, transcribedMs: 0, understoodMs: 0, cursor: 0, revision: 3, events: [], answers: [], summary: text(4000), error: '', autoUnderstand: false, autoIntervalMin: 0, speed: 'normal',
    sessionId: randomUUID(), agent: { state: 'ready' }, questionSessionId: null, questionAgent: { state: 'none' }, understandingProtocol: 2, questionProtocol: 2, minutesProtocol: 2, recording: { segments: [], gaps: [], bytes: 0, savedThrough: 0 } };
  let t = 0;
  while (m.events.length < n) {
    t += 1200; const r = (m.events.length * 13) % 10, seq = m.events.length + 1;
    if (r < 2) m.events.push({ at: t, end: t + 10000, file: `${r ? 'mic' : 'system'}-${seq}.wav`, track: r ? 'mic' : 'system', asr: 'done', seq, kind: 'audio' });
    else if (r < 9) m.events.push({ at: t, end: t + 3000, track: r % 2 ? 'mic' : 'system', audioSeq: 1, text: text(30 + (seq % 40)), speaker: 's' + (r % 4), seq, kind: 'transcript' });
    else m.events.push({ at: t, file: `page-${seq}.jpg`, hash: seq.toString(16).padStart(64, '0'), forced: false, seq, kind: 'slide' });
  }
  for (let i = 0; i < 30; i++) m.answers.push({ id: randomUUID(), q: text(30), state: 'done', answer: text(500), queuedAt: t, at: t });
  m.capturedMs = t; m.transcribedMs = t; m.cursor = m.events.length;
  return m;
}
function seed(root) {
  const dir = path.join(root, 'meetings'); const metas = [];
  const put = m => {
    const d = path.join(dir, m.id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'meeting.json'), JSON.stringify(m, null, 2));
    for (const e of m.events) if (e.kind === 'slide' && e.seq > m.events.length - 30) fs.writeFileSync(path.join(d, e.file), Buffer.alloc(80 * 1024, 1));
    metas.push(m);
  };
  for (let i = 0; i < 10; i++) put(gen(6000));
  for (let i = 0; i < 20; i++) put(gen(1000));
  const live = gen(6000, 'recording'); put(live);
  return { live, metas, bytes: fs.statSync(path.join(dir, live.id, 'meeting.json')).size };
}
const stat = xs => { const s = [...xs].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3), p50: +q(0.5).toFixed(3), p99: +q(0.99).toFixed(3), max: +s.at(-1).toFixed(3) }; };
const ms = fn => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-perf-'));
const { live, metas, bytes } = seed(root);
const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null }, { powerSaveBlocker: false, meetingAsr: { status: () => ({ ready: false }), close() {} } });
m.tools.start = async () => {}; m.tools.bind = () => {}; m.tools.close = () => {};
const r = { version: require('../package.json').version, liveMeetingBytes: bytes, historyMeetings: metas.length - 1, ownsSessionColdMs: +ms(() => m.ownsSession(randomUUID())).toFixed(3) };
const wav = (() => { const b = Buffer.alloc(64); b.write('RIFF', 0, 'ascii'); b.write('WAVE', 8, 'ascii'); return b.toString('base64'); })();
const jpg = i => { const b = Buffer.alloc(2048, i % 251); b[0] = 0xff; b[1] = 0xd8; return b.toString('base64'); };
// 模拟采集 120 秒：每秒心跳；每 5 秒一张新截图；每 3 秒一条重点；每 10 秒两段音频；页面每 2.5 秒拉一次状态；新实现有 flush 时每 2 秒落盘一次并计入。
const per = { heartbeat: [], mark: [], slide: [], audio: [], status: [], flush: [], ownsMiss: [], ownsHit: [], slideRead: [], perSecond: [] };
let at = live.capturedMs;
const run = (list, fn) => { const t = ms(fn); list.push(t); return t; };
for (let sec = 0; sec < 120; sec++) {
  let total = 0; at += 1000;
  total += run(per.heartbeat, () => m.capture(live.id, { kind: 'heartbeat', at }));
  if (sec % 5 === 0) total += run(per.slide, () => m.capture(live.id, { kind: 'slide', at, data: jpg(sec) }));
  if (sec % 3 === 0) total += run(per.mark, () => m.capture(live.id, { kind: 'mark', at, text: text(60) }));
  if (sec % 10 === 0) for (const track of ['system', 'mic']) total += run(per.audio, () => m.capture(live.id, { kind: 'audio', track, at: at - 10000, end: at, data: wav }));
  if (sec % 5 === 0 || sec % 5 === 2) total += run(per.status, () => m.status(live.id));
  if (sec % 2 === 1 && typeof m.flush === 'function') total += run(per.flush, () => m.flush());
  per.perSecond.push(total);
}
for (let i = 0; i < 50; i++) run(per.ownsMiss, () => m.ownsSession(randomUUID()));
for (let i = 0; i < 50; i++) run(per.ownsHit, () => m.ownsSession(metas[i % metas.length].sessionId));
const slideSeq = live.events.filter(e => e.kind === 'slide').at(-1).seq;
for (let i = 0; i < 50; i++) run(per.slideRead, () => m.slide(live.id, slideSeq));
r.ops = Object.fromEntries(Object.entries(per).filter(([, v]) => v.length).map(([k, v]) => [k, stat(v)]));
const events = m.load(live.id).events; let ce;
r.compactEvents6000Ms = stat(Array.from({ length: 5 }, () => ms(() => { ce = compactEvents(events); })));
r.compactLines = ce.split('\n').length;
m.close();
r.finalEventsOnDisk = JSON.parse(fs.readFileSync(path.join(root, 'meetings', live.id, 'meeting.json'), 'utf8')).events.length;
r.finalEventsExpected = events.length;
fs.rmSync(root, { recursive: true, force: true });
const out = JSON.stringify(r, null, 2); if (process.argv[2]) fs.writeFileSync(process.argv[2], out); console.log(out);
