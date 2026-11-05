'use strict';
const assert = require('node:assert/strict');
const { flowEntries, meetingNavigation } = require('../renderer/company-meeting-flow');
const meeting = {
  startedAt: 100000, capturedMs: 20000, state: 'ended',
  events: [
    { seq: 3, kind: 'mark', at: 15000, text: '需要补测' },
    { seq: 1, kind: 'slide', at: 1000 },
    { seq: 2, kind: 'transcript', at: 7000, text: '算法 A 暂不采用' },
    { seq: 4, kind: 'audio', at: 1000 },
  ],
  answers: [
    { id: 'during', queuedAt: 110000, at: 140000, q: '谁负责？' },
    { id: 'after', queuedAt: 130000, q: '复盘一下' },
    { id: 'legacy', q: '旧问题没有时间' },
  ],
};
const rows = flowEntries(meeting);
assert.deepEqual(rows.map(r => r.key), ['event-1','event-2','question-during','event-3','question-after','question-legacy']);
assert.equal(rows[2].at, 10000, 'anchor the question to when it was asked, not its later answer');
assert.equal(rows[4].afterMeeting, true);
assert.equal(rows[5].at, null, 'missing timestamps must not masquerade as meeting start');
assert.equal(rows[2].afterMeeting, false, 'a slow answer does not turn a live question into a post-meeting question');
assert.equal(meetingNavigation(meeting).kind, 'time');
assert.deepEqual(meetingNavigation(meeting).items.map(t => t.seq), [1,3]);
const topics = meetingNavigation({ ...meeting, summary: '## 议题\n- 算法取舍 [事件 2]\n- 待补测 [事件 3]\n- 无效引用 [事件 999]\n## 结论\n继续验证 [事件 1]' });
assert.equal(topics.kind, 'topics');
assert.deepEqual(topics.items, [{title:'算法取舍',seq:2,at:7000},{title:'待补测',seq:3,at:15000}]);
assert.equal(meetingNavigation({ ...meeting, summary: '## 结论\n继续验证 [事件 1]' }).kind, 'time');
assert.equal(meetingNavigation({ ...meeting, summary: '## 没有出处的标题\n无法定位' }).kind, 'time');
assert.deepEqual(flowEntries(null), []);
const { meetingAsrState } = require('../renderer/company-meeting-asr-state');
assert.equal(meetingAsrState().setupText, '本地转写：未安装（约 500 MB）');
assert.equal(meetingAsrState({ ready: true }).setupText, '本地转写：已就绪');
assert.equal(meetingAsrState({ phase: '下载识别模型' }).installing, true);
assert.match(meetingAsrState({ error: '下载失败' }).setupText, /下载失败/);
const awaiting = { summary: '会中草稿', finalRequested: true, events: [
  { kind: 'audio', asr: 'pending' }, { kind: 'audio', asr: 'error' }, { kind: 'audio', asr: 'done' }, { kind: 'slide' },
] };
const missing = meetingAsrState({ ready: false }, awaiting);
assert.equal(missing.pending, 2);
assert.equal(missing.reviewReady, false, 'a previous draft is not final while audio remains');
assert.equal(missing.reviewAction, 'install');
assert.match(missing.reviewText, /还有 2 段语音（1 段失败）/);
const installed = meetingAsrState({ ready: true }, awaiting);
assert.equal(installed.reviewAction, 'retry-asr', 'failed chunks still need an explicit retry after installation');
const transcribed = { ...awaiting, events: awaiting.events.map(event => ({ ...event, asr: 'done' })) };
assert.equal(meetingAsrState({ ready: true }, transcribed).reviewReady, false, 'final minutes must still be regenerated after transcription');
assert.equal(meetingAsrState({ ready: true }, { ...transcribed, finalRequested: false }).reviewReady, true);
assert.equal(meetingAsrState({ ready: true }, { ...transcribed, finalRequested: false, job: { kind: 'understand', state: 'running' } }).reviewReady, false);
console.log('meeting flow: source ordering, question timing, grounded topics and legacy fallback PASS');

require('node:test')('安装就绪后已有待转写音频自动继续，最终纪要等待转写结束', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { MeetingCompanion } = require('../core/company-assistant/meeting');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-asr-resume-'));
  let ready = false, transcriptions = 0, answer = null;
  const prompts = [];
  const companion = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => answer }, {
    dataDir: root, getSession: () => ({ id: 'fixture' }), sendPrompt: async (_id, prompt) => { prompts.push(prompt); return { ok: true }; },
    meetingAsr: { status: () => ({ ready }), close() {}, transcribe: async () => { transcriptions++; return [{ start: 0, end: 2, text: '下周复核实验结果' }]; } },
  });
  companion.tools = { start: async () => {}, bind() {}, close() {} };
  t.after(() => { companion.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const saved = companion.create({ title: '待转写会议', audio: ['system'] });
  clearInterval(companion.timer); companion.timer = null;
  Object.assign(saved, { state: 'ended', capturedMs: 2000, finalRequested: true, primeRequested: false, questionPrimeRequested: false, autoUnderstand: false });
  companion.event(saved, 'audio', { at: 0, end: 2000, track: 'system', file: 'system-1.wav', asr: 'pending' }); companion.save(saved);
  await companion.transcribeOne(); await companion.runLane(saved.id, 'job');
  assert.equal(transcriptions, 0); assert.equal(prompts.length, 0, 'do not generate final minutes before transcription');
  ready = true;
  await companion.transcribeOne(); await companion.runLane(saved.id, 'job');
  let current = companion.load(saved.id);
  assert.equal(transcriptions, 1); assert.equal(current.events[0].asr, 'done');
  assert.equal(current.job.final, true); assert.equal(current.finalRequested, true);
  assert.match(prompts[0], /会后最终复核/);
  answer = { id: 'final-fixture', text: `下周复核实验结果 [事件 2]\n[会议回执:${current.job.token}]` };
  await companion.collect(current, 'job'); current = companion.load(saved.id);
  assert.equal(current.finalRequested, false);
  assert.equal(meetingAsrState({ ready }, current).reviewReady, true);
});
