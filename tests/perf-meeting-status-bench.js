'use strict';
// 会议页录制期后台开销微基准（2026-11-25 m3，审查口径；改前改后同一脚本，不进 npm test）。
// 场景：20 场历史会议 + 1 场正在采集、已有 3000 事件（约 0.8 MB）的会议。模拟 60 秒：每秒心跳，每 3 秒一条重点，每 10 秒两段音频；
// 会议页每 2.5 秒拉一次 meeting-status（新实现带上手里的版本只要增量；旧实现不认 since，照旧回全量）；每秒 tick 两条车道。
// IPC 字节按 v8.serialize（Electron IPC 的结构化复制）计。用法：node tests/perf-meeting-status-bench.js [输出json]
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), v8 = require('node:v8');
const { randomUUID } = require('node:crypto');
const { MeetingCompanion } = require('../core/company-assistant/meeting');

const words = '我们这个调度算法在高负载下的吞吐收益大概是百分之三到五然后需要再确认一下干扰场景的表现下周二之前给出结论负责人是小王'.split('');
const text = n => { let s = ''; for (let i = 0; i < n; i++) s += words[(i * 7 + n) % words.length]; return s; };
function gen(n, state = 'ended') {
  const m = { id: randomUUID(), title: '压测会议', sourceName: 'x', audio: ['system', 'mic'], startedAt: Date.now() - 7200000, state, capturedMs: 0, transcribedMs: 0, understoodMs: 0, cursor: 0, revision: 3, events: [], answers: [], summary: text(4000), error: '', autoUnderstand: false, autoIntervalMin: 0, speed: 'normal',
    sessionId: randomUUID(), agent: { state: 'ready' }, questionSessionId: null, questionAgent: { state: 'none' }, understandingProtocol: 2, questionProtocol: 2, minutesProtocol: 2, recording: { segments: [], gaps: [], bytes: 0, savedThrough: 0 } };
  let t = 0;
  while (m.events.length < n) {
    t += 2400; const r = (m.events.length * 13) % 10, seq = m.events.length + 1;
    if (r < 2) m.events.push({ at: t, end: t + 10000, file: `${r ? 'mic' : 'system'}-${seq}.wav`, track: r ? 'mic' : 'system', asr: 'done', seq, kind: 'audio' });
    else if (r < 9) m.events.push({ at: t, end: t + 3000, track: r % 2 ? 'mic' : 'system', audioSeq: 1, text: text(30 + (seq % 40)), speaker: 's' + (r % 4), seq, kind: 'transcript' });
    else m.events.push({ at: t, file: `page-${seq}.jpg`, hash: seq.toString(16).padStart(64, '0'), forced: false, seq, kind: 'slide' });
  }
  for (let i = 0; i < 10; i++) m.answers.push({ id: randomUUID(), q: text(30), state: 'done', answer: text(300), queuedAt: t, at: t });
  m.capturedMs = t; m.transcribedMs = t; m.cursor = m.events.length;
  return m;
}
const stat = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3), p50: +q(0.5).toFixed(3), p99: +q(0.99).toFixed(3), max: +s.at(-1).toFixed(3), sum: +s.reduce((a, b) => a + b, 0).toFixed(1) }; };
const ms = fn => { const t0 = process.hrtime.bigint(); const v = fn(); return [Number(process.hrtime.bigint() - t0) / 1e6, v]; };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-status-perf-')), dir = path.join(root, 'meetings');
  const put = m => { const d = path.join(dir, m.id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'meeting.json'), JSON.stringify(m, null, 2)); };
  for (let i = 0; i < 20; i++) put(gen(i < 5 ? 3000 : 800));
  const live = gen(3000, 'recording'); put(live);
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null, sessionGone: () => '' }, { powerSaveBlocker: false, meetingAsr: { status: () => ({ ready: false }), close() {} }, getSession: () => ({}) });
  m.tools.start = async () => {}; m.tools.bind = () => {}; m.tools.close = () => {};
  const r = { version: require('../package.json').version, liveMeetingBytes: fs.statSync(path.join(dir, live.id, 'meeting.json')).size, history: 20 };
  m.status(live.id); // 预热（启动时本来就会做一次全量）
  const wav = (() => { const b = Buffer.alloc(64); b.write('RIFF', 0, 'ascii'); b.write('WAVE', 8, 'ascii'); return b.toString('base64'); })();
  const poll = { ms: [], bytes: [] }, tick = [];
  let at = live.capturedMs, rev = null, first = true;
  for (let tenth = 0; tenth < 600; tenth++) { // 60 秒，按 0.1 秒推进
    if (tenth % 10 === 0) {
      const sec = tenth / 10; at += 1000;
      m.capture(live.id, { kind: 'heartbeat', at });
      if (sec % 3 === 0) m.capture(live.id, { kind: 'mark', at, text: text(60) });
      if (sec % 10 === 0) for (const track of ['system', 'mic']) m.capture(live.id, { kind: 'audio', track, at: at - 10000, end: at, data: wav });
      const [t] = ms(() => 0); void t;
      const t0 = process.hrtime.bigint(); await m.runLane(live.id, 'job'); await m.runLane(live.id, 'questionJob'); tick.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    if (tenth % 25 === 0) {
      const [t, res] = ms(() => { const out = m.status(live.id, first ? null : rev); return { out, size: v8.serialize(out).length }; });
      poll.ms.push(t); poll.bytes.push(res.size); rev = res.out.meetingRev || null; first = false;
    }
  }
  r.visiblePoll = { perPollMs: stat(poll.ms), perPollBytes: stat(poll.bytes), pollsPerMinute: poll.ms.length, mainMsPerMinute: +poll.ms.reduce((a, b) => a + b, 0).toFixed(1), mbPerMinute: +(poll.bytes.reduce((a, b) => a + b, 0) / 1024 / 1024).toFixed(2) };
  r.tick = { perSecondMs: stat(tick), msPerMinute: +tick.reduce((a, b) => a + b, 0).toFixed(1) };
  m.close(); fs.rmSync(root, { recursive: true, force: true });
  const out = JSON.stringify(r, null, 2); if (process.argv[2]) fs.writeFileSync(process.argv[2], out); console.log(out);
})();
