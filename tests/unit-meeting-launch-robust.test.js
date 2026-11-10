'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID, createHash } = require('node:crypto');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { createMeetingHandlers } = require('../core/company-assistant/meeting-ipc');
const { MeetingAsr } = require('../core/company-assistant/meeting-asr');
const { MeetingCapture } = require('../renderer/meeting-capture');
const { MeetingRecorder } = require('../renderer/meeting-recorder');

function temp(t) {
  const base = path.join(__dirname, '../artifacts'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'meeting-robust-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function companion(t, deps = {}, root = temp(t)) {
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null }, {
    powerSaveBlocker: false, getSession: () => ({}), meetingAsr: { status: () => ({ ready: false }), close() {} }, ...deps,
  });
  m.tools = { start: async () => {}, bind() {}, close() {} }; t.after(() => m.close()); return m;
}
function captureFixture(error, system = true) {
  const video = { stop() {} }, audio = { stop() {} }, notices = [], tracks = [];
  const stream = { getVideoTracks: () => [video], getAudioTracks: () => system ? [audio] : [], getTracks: () => [video, ...(system ? [audio] : [])] };
  const window = { navigator: { mediaDevices: { getUserMedia: async options => {
    if (options.video !== false) return stream;
    throw Object.assign(new Error('Requested device not found'), { name: error });
  } } } };
  const capture = new MeetingCapture({ document: { createElement: () => ({ play: async () => {} }) }, window, status: s => notices.push(s), save: async () => {} });
  capture.audio = (_stream, track) => tracks.push(track);
  return { capture, tracks, notices };
}

test('没有麦克风、拒绝权限或设备忙：继续系统录制并提示，关闭系统音时只录画面', async t => {
  const open = t.mock.method(MeetingRecorder.prototype, 'open', async () => {});
  for (const name of ['NotFoundError', 'NotAllowedError', 'NotReadableError']) {
    const { capture, tracks, notices } = captureFixture(name), audio = { system: true, mic: true };
    await capture.open('screen:1', audio);
    assert.equal(audio.mic, false); assert.equal(capture.streams.length, 1);
    assert.deepEqual(tracks, ['system']); assert.match(notices[0], /本场只录电脑声音/);
    if (name === 'NotFoundError') assert.equal(capture.warning, '没找到麦克风，本场只录电脑声音');
    await capture.dispose();
  }
  const { capture } = captureFixture('NotFoundError', false);
  await capture.open('screen:1', { system: false, mic: true });
  assert.match(capture.warning, /本场只录画面/); await capture.dispose();
  assert.equal(open.mock.callCount(), 4);
});

test('共享来源的采集错误转换成中文并释放设备', async () => {
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) {
    const { capture } = captureFixture(name);
    capture.w.navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error('Permission denied'), { name }); };
    await assert.rejects(capture.open('screen:1', { system: true }), /请/);
    assert.equal(capture.released, true);
  }
});

test('CodeAgent 明确没发出时隔一会儿重发；确认后不再发，且每次使用新的提交编号', async t => {
  let calls = 0, now = 1000; const submissions = [];
  const m = companion(t, { now: () => now, notReadyRetryMs: 1, sendPrompt: async (_sid, _prompt, token) => {
    calls++; submissions.push(token); now += 61000;
    return calls < 3 ? { notSent: true, error: 'cli-not-ready' } : { ok: true };
  } });
  const meeting = m.create(); const job = m.newJob(meeting, 'understand', 'job');
  meeting.job = job; m.save(meeting); await m.send(meeting.id, job, '整理纪要');
  assert.equal(calls, 3); assert.equal(new Set(submissions).size, 3);
  assert.equal(m.load(meeting.id).job.state, 'running');
  assert.equal(m.load(meeting.id).understandingChars, '整理纪要'.length);
});

test('未确认提交、其他错误不重发；超过五分钟中文提示可重试', async t => {
  for (const receipt of [{ unconfirmed: true, error: 'cli-not-ready' }, { notSent: true, error: 'other-error' }, { ok: false, error: 'cli-not-ready' }]) {
    let calls = 0; const m = companion(t, { sendPrompt: async () => { calls++; return receipt; } });
    const meeting = m.create(), job = m.newJob(meeting, 'understand', 'job'); meeting.job = job; m.save(meeting);
    if (receipt.unconfirmed) { await m.send(meeting.id, job, 'test'); assert.equal(m.load(meeting.id).job.state, 'unconfirmed'); }
    else await assert.rejects(m.send(meeting.id, job, 'test'));
    assert.equal(calls, 1);
  }
  let now = 1000, calls = 0;
  const m = companion(t, { now: () => now, notReadyRetryMs: 1, sendPrompt: async () => { calls++; now += 160000; return { notSent: true, error: 'cli-not-ready' }; } });
  const meeting = m.create(), job = m.newJob(meeting, 'understand', 'job'); meeting.job = job; m.save(meeting);
  await assert.rejects(m.send(meeting.id, job, 'test'), /CodeAgent 还没启动好，稍后点重试/); assert.equal(calls, 2);
  const saved = m.load(meeting.id); saved.answers.push({ id: 'q', q: '问题', state: 'queued' }); m.save(saved);
  m.fail(meeting.id, new Error('cli-not-ready'), 'questionJob');
  assert.equal(m.load(meeting.id).answers[0].error, 'CodeAgent 还没启动好，稍后点重试');
});

test('重试等待期间关闭会议后台或换任务，停止重发', async t => {
  for (const mode of ['close', 'replace']) {
    let calls = 0;
    const m = companion(t, { notReadyRetryMs: 1, sendPrompt: async () => {
      calls++;
      if (mode === 'close') m.close();
      else { const saved = m.load(meeting.id); saved.job.token = 'new-job'; m.save(saved); }
      return { notSent: true, error: 'cli-not-ready' };
    } });
    const meeting = m.create(), job = m.newJob(meeting, 'understand', 'job'); meeting.job = job; m.save(meeting);
    await m.send(meeting.id, job, 'test'); assert.equal(calls, 1);
  }
});

test('重启后只查询状态就恢复旧会议转写和最终纪要；重复查询不会重复启动', async t => {
  const root = temp(t), m = companion(t, {}, root), meeting = m.create();
  Object.assign(meeting, { state: 'ended', primeRequested: false, autoUnderstand: false, finalRequested: true });
  m.event(meeting, 'audio', { at: 0, end: 1000, track: 'system', file: 'system-1.wav', asr: 'pending' }); m.save(meeting); m.close();
  const prompts = [], fresh = companion(t, { meetingAsr: { status: () => ({ ready: true }), close() {}, transcribe: async () => [{ start: 0, end: 1, text: '决定明天复核' }] }, sendPrompt: async (_sid, prompt) => { prompts.push(prompt); return { ok: true }; } }, root);
  const handlers = createMeetingHandlers({ meetings: fresh });
  handlers['meeting-status']({ id: meeting.id }); const timer = fresh.timer;
  handlers['meeting-status']({ id: meeting.id }); assert.equal(fresh.timer, timer);
  assert.ok(fresh.pendingAsr.has(meeting.id));
  await fresh.transcribeOne(); await fresh.runLane(meeting.id);
  assert.equal(fresh.load(meeting.id).events[0].asr, 'done');
  assert.equal(fresh.load(meeting.id).job.final, true); assert.match(prompts[0], /会后最终复核/);
});

test('会议列表没改文件不重读，mtime变化及保存后更新，删除后清缓存', t => {
  const m = companion(t), first = m.create(); first.state = 'ended'; m.save(first); const second = m.create();
  m.list(); const load = t.mock.method(m, 'load');
  m.list(); m.list(); assert.equal(load.mock.callCount(), 0);
  const file = path.join(m.dir(first.id), 'meeting.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.title = '外部修改的会议'; saved.events.push({ kind: 'slide' }); fs.writeFileSync(file, JSON.stringify(saved));
  const nextTime = new Date(Date.now() + 10000); fs.utimesSync(file, nextTime, nextTime);
  assert.equal(m.list().find(x => x.id === first.id).pages, 1); assert.equal(load.mock.callCount(), 1);
  m.rename(second.id, '重新命名'); assert.equal(m.list().find(x => x.id === second.id).title, '重新命名');
  fs.rmSync(m.dir(first.id), { recursive: true, force: true });
  assert.equal(m.list().length, 1); assert.equal(m.listCache.has(first.id), false);
});

test('拼合分片走流式读写，字节和哈希一致；拼合校验失败不标记安装成功', async t => {
  const sha = b => createHash('sha256').update(b).digest('hex');
  for (const badHash of [false, true]) {
    const root = temp(t), chunks = [Buffer.alloc(90000, 1), Buffer.alloc(80000, 2)], bytes = Buffer.concat(chunks);
    const parts = chunks.map((b, i) => ({ file: `model.${i}`, size: b.length, sha256: sha(b) }));
    const pack = { version: 'small-test', engine: 'sensevoice', files: [{ name: 'model.onnx', parts, size: bytes.length, sha256: badHash ? '0'.repeat(64) : sha(bytes) }] };
    const asr = new MeetingAsr(root, { pack, fetchImpl: async () => { throw Error('不应联网'); } });
    fs.mkdirSync(asr.downloads, { recursive: true }); parts.forEach((p, i) => fs.writeFileSync(path.join(asr.downloads, p.file), chunks[i]));
    asr.smoke = async () => {};
    const originalRead = fs.readFileSync, originalWrite = fs.writeSync;
    const read = t.mock.method(fs, 'readFileSync', (file, ...args) => { assert.ok(!parts.some(p => String(file).endsWith(p.file)), '不能同步读分片'); return originalRead(file, ...args); });
    const write = t.mock.method(fs, 'writeSync', () => { throw Error('不能同步拼合'); });
    try {
      if (badHash) { await assert.rejects(asr.installPack(), /拼合后校验不一致/); assert.equal(fs.existsSync(asr.readyFile), false); }
      else { await asr.installPack(); assert.deepEqual(originalRead(path.join(asr.home, 'model/model.onnx')), bytes); assert.equal(asr.status().ready, true); }
    } finally { read.mock.restore(); write.mock.restore(); assert.equal(fs.writeSync, originalWrite); asr.close(); }
  }
});

test('页面就地显示安装入口，旧错误码也显示中文；开录后保留麦克风降级提示', async () => {
  const module = { exports: {} }, nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, { value: '', checked: true, hidden: true, dataset: {}, classList: { toggle() {} }, setAttribute() {}, pause() {}, remove() {}, removeAttribute() {}, load() {}, async play() {}, querySelector: () => null });
    return nodes.get(key);
  };
  const root = { querySelector: node }, payloads = [];
  node('[data-m="source"]').value = 'screen:1';
  for (const [key, value] of Object.entries({ x: 0, y: 0, w: 100, h: 100 })) node(`[data-crop="${key}"]`).value = value;
  class Capture {
    async open(_source, audio) { audio.mic = false; this.warning = '没找到麦克风，本场只录电脑声音'; this.video = { srcObject: {} }; }
    start() { this.running = true; } displayMs() { return 0; }
  }
  const code = fs.readFileSync(path.join(__dirname, '../renderer/company-meeting-page.js'), 'utf8').replace('return { open, close:', 'return { message, action, questionCard, configure: (r, s) => { root = r; state = s; }, open, close:');
  vm.runInNewContext(code, { module, Buffer, require: name => name === './meeting-capture' ? { MeetingCapture: Capture } : require(name.startsWith('./') ? '../renderer/' + name.slice(2) : name) });
  const window = { addEventListener() {}, HubErrorCard: require('../renderer/hub-error-card') };
  const page = module.exports.createCompanyMeetingPage({ document: {}, window, markdown: s => s, call: async (op, r) => { payloads.push([op, r]); return { meeting: { id: randomUUID() } }; } });
  page.configure(root, { asr: { ready: true } });
  page.message('未找到 CodeAgent CLI'); assert.match(node('[data-m="agent-help"]').innerHTML, /known:codeagent-install/);
  page.message('cli-not-ready'); assert.match(node('[data-m="message"]').textContent, /稍后点重试/);
  const card = page.questionCard({ id: 'old', state: 'error', error: 'cli-not-ready' }, true);
  assert.match(card, /稍后点重试/); assert.doesNotMatch(card, /cli-not-ready/);
  assert.equal(node('[data-m="agent-help"]').innerHTML, '');
  await page.action('start');
  assert.deepEqual(Array.from(payloads[0][1].audio), ['system']);
  assert.equal(node('[data-m="mic"]').checked, false);
  assert.equal(node('[data-m="message"]').textContent, '没找到麦克风，本场只录电脑声音');
});
