'use strict';
// 会议正本常驻内存（2026-11-24 主进程性能）：合并落盘、状态切换立即写、退出刷盘、改名失败退避重试、会话索引、load 副本语义、去重 O(n) 与旧实现一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { compactEvents, similar } = require('../core/company-assistant/meeting-context');

const temp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-mem-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
function companion(t, root = temp(t), deps = {}, a = {}) {
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null, ...a },
    { powerSaveBlocker: false, meetingAsr: { status: () => ({ ready: false }), close() {} }, flushMs: 60000, ...deps });
  m.tools = { start: async () => {}, bind() {}, close() {}, unbind() {} }; m.start = () => {}; m.tick = async () => {};
  t.after(() => { if (!m.closed) m.close(); });
  return { m, root };
}
const disk = (m, id) => JSON.parse(fs.readFileSync(path.join(m.dir(id), 'meeting.json'), 'utf8'));
const mark = (m, id, at, text = '重点') => m.capture(id, { kind: 'mark', at, text });

test('采集中的改动合并落盘：先在内存，flush 后写下；状态切换立即写', t => {
  const { m } = companion(t), meeting = m.create({ title: '合并' });
  assert.equal(disk(m, meeting.id).state, 'recording', '新建立即落盘');
  for (let i = 1; i <= 5; i++) mark(m, meeting.id, i * 1000);
  assert.equal(disk(m, meeting.id).events.length, 0, '采集中不逐条写盘');
  assert.equal(m.load(meeting.id).events.length, 5, '内存是最新的');
  assert.ok(m.flushTimer, '排了一次合并落盘');
  m.flush(); assert.equal(disk(m, meeting.id).events.length, 5);
  mark(m, meeting.id, 6000);
  m.control(meeting.id, 'pause');
  const saved = disk(m, meeting.id); assert.equal(saved.state, 'paused'); assert.equal(saved.events.length, 6, '暂停时连同之前的改动一起写下');
  m.control(meeting.id, 'stop'); assert.equal(disk(m, meeting.id).state, 'ended');
});

test('合并落盘按时触发：flushMs 到了自动写', async t => {
  const { m } = companion(t, undefined, { flushMs: 30 }), meeting = m.create();
  mark(m, meeting.id, 1000);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(disk(m, meeting.id).events.length, 1);
});

test('心跳只改内存、不排落盘、不广播；退出时刷盘', t => {
  let changed = 0; const { m, root } = companion(t, undefined, {}, { changed() { changed++; } });
  const meeting = m.create(); m.flush(); changed = 0; const before = fs.statSync(path.join(m.dir(meeting.id), 'meeting.json')).mtimeMs;
  for (let i = 1; i <= 10; i++) m.capture(meeting.id, { kind: 'heartbeat', at: i * 1000 });
  assert.equal(m.flushTimer, null); assert.equal(changed, 0);
  assert.equal(fs.statSync(path.join(m.dir(meeting.id), 'meeting.json')).mtimeMs, before);
  assert.equal(m.load(meeting.id).capturedMs, 10000);
  mark(m, meeting.id, 11000);
  m.close();
  const fresh = companion(t, root).m; const back = fresh.load(meeting.id);
  assert.equal(back.capturedMs, 11000); assert.equal(back.events.length, 1);
});

test('崩溃（不调 close）：重开后会议能打开，最多丢掉最后一次合并之后的改动', t => {
  const { m, root } = companion(t), meeting = m.create();
  for (let i = 1; i <= 20; i++) mark(m, meeting.id, i * 1000);
  m.flush();
  for (let i = 21; i <= 25; i++) mark(m, meeting.id, i * 1000); // 这 5 条在合并窗口里，崩溃时丢
  m.closed = true; clearTimeout(m.flushTimer); // 模拟进程被直接结束：不刷盘
  const fresh = companion(t, root).m; const back = fresh.load(meeting.id);
  assert.equal(back.events.length, 20); assert.equal(back.state, 'recording');
});

test('改名失败退避重试：采集不中断，连续失败原因进 status，恢复后自动补写', t => {
  const { m } = companion(t), meeting = m.create(); m.flush();
  const real = fs.renameSync; let fail = true, tries = 0;
  t.mock.method(fs, 'renameSync', (a, b) => { if (fail && String(b).endsWith('meeting.json')) { tries++; throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); } return real(a, b); });
  mark(m, meeting.id, 1000);
  for (let i = 0; i < 3; i++) { m.mem.get(meeting.id).retryAt = 0; m.flush(); }
  assert.equal(tries, 3);
  assert.doesNotThrow(() => mark(m, meeting.id, 2000), '写盘失败不让采集报错');
  const st = m.status(meeting.id);
  assert.match(st.storageError, /写不进硬盘.*EPERM/); assert.match(st.recordingError, /写不进硬盘/);
  assert.ok(m.mem.get(meeting.id).retryAt > Date.now(), '退避：下一次重试排在之后');
  m.flush(); assert.equal(tries, 3, '退避期内不重试');
  fail = false; m.mem.get(meeting.id).retryAt = 0; m.flush();
  assert.equal(disk(m, meeting.id).events.length, 2); assert.equal(m.status(meeting.id).storageError, undefined);
});

test('退出刷盘遇到改名失败：原地再试，仍失败时最新内容留在 .tmp，重开能读回', t => {
  const { m, root } = companion(t), meeting = m.create();
  mark(m, meeting.id, 1000); mark(m, meeting.id, 2000);
  const real = fs.renameSync; let tries = 0;
  t.mock.method(fs, 'renameSync', (a, b) => { if (String(b).endsWith('meeting.json')) { tries++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } return real(a, b); });
  m.close(); t.mock.restoreAll();
  assert.equal(tries, 3, '退出时一共试三次');
  const file = path.join(root, 'meetings', meeting.id, 'meeting.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).events.length, 0, '正式文件还是旧的');
  const later = new Date(Date.now() + 5000); fs.utimesSync(file + '.tmp', later, later);
  assert.equal(companion(t, root).m.load(meeting.id).events.length, 2, '从完整的 .tmp 读回最新内容');
  assert.equal(fs.existsSync(file + '.tmp'), false, '用上的 .tmp 立刻改名成正式文件');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).events.length, 2);
  fs.writeFileSync(file + '.tmp', '{"id":"半截'); // 半截的 .tmp 不用
  assert.equal(companion(t, root).m.load(meeting.id).events.length, 2);
});

test('load 返回独立副本：改了不 save 不进内存也不落盘；save 之后再改不影响已保存的', t => {
  const { m } = companion(t), meeting = m.create(); mark(m, meeting.id, 1000);
  const a = m.load(meeting.id); a.title = '没保存'; a.events[0].text = '改过'; a.events.push({ seq: 99, kind: 'mark' }); a.recording = { bytes: 1 };
  const b = m.load(meeting.id);
  assert.equal(b.title, meeting.title); assert.equal(b.events[0].text, '重点'); assert.equal(b.events.length, 1); assert.equal(b.recording, undefined);
  b.title = '保存了'; m.save(b); b.title = '保存后又改'; b.events[0].text = '保存后又改';
  const c = m.load(meeting.id); assert.equal(c.title, '保存了'); assert.equal(c.events[0].text, '重点');
  m.flush(); assert.equal(disk(m, meeting.id).title, '保存了');
  assert.equal(m.peek(meeting.id), m.peek(meeting.id), 'peek 给正本'); assert.notEqual(m.load(meeting.id), m.peek(meeting.id), 'load 给副本');
});

test('没有未落盘改动时，盘上被外部改过就重读；有未落盘改动时以内存为准', t => {
  const { m } = companion(t), meeting = m.create(); m.control(meeting.id, 'stop');
  const file = path.join(m.dir(meeting.id), 'meeting.json'), saved = disk(m, meeting.id);
  saved.title = '外部改名'; fs.writeFileSync(file, JSON.stringify(saved)); const later = new Date(Date.now() + 10000); fs.utimesSync(file, later, later);
  assert.equal(m.load(meeting.id).title, '外部改名');
});

test('会话 → 会议索引：新建、换会话、问答会话、改名、删除、重开后都一致，且不逐场读历史会议', async t => {
  const { m, root } = companion(t), deps = m.deps; deps.getSession = () => null;
  const one = m.create({ title: '一' }); m.control(one.id, 'stop');
  const two = m.create({ title: '二' });
  assert.equal(m.meetingOfSession(one.sessionId), one.id); assert.equal(m.meetingOfSession(two.sessionId), two.id);
  assert.equal(m.ownsSession(randomUUID()), false); assert.equal(m.ownsSession(''), false);
  const x = m.load(two.id), old = x.sessionId; x.sessionId = randomUUID(); x.questionSessionId = randomUUID(); m.save(x);
  assert.equal(m.ownsSession(old), false, '换掉的旧会话不再算'); assert.equal(m.meetingOfSession(x.sessionId), two.id); assert.equal(m.meetingOfSession(x.questionSessionId), two.id);
  m.rename(two.id, '二改名'); assert.equal(m.meetingOfSession(x.sessionId), two.id);
  m.control(two.id, 'stop'); await m.remove(one.id);
  assert.equal(m.ownsSession(one.sessionId), false, '删掉的会议的会话不再算');
  m.close();
  const fresh = companion(t, root).m; const load = t.mock.method(fresh, 'load'), read = t.mock.method(fresh, 'entry');
  assert.equal(fresh.meetingOfSession(x.questionSessionId), two.id, '重开后第一次查询建索引');
  const reads = read.mock.callCount();
  for (let i = 0; i < 20; i++) fresh.ownsSession(randomUUID());
  assert.equal(read.mock.callCount(), reads, '之后的查询不再读会议'); assert.ok(load.mock.callCount() <= 2);
  assert.equal(fresh.ownsSession(one.sessionId), false);
});

test('删除会议时丢掉内存正本，合并落盘不会把文件夹写回来', async t => {
  const { m } = companion(t), meeting = m.create(); m.control(meeting.id, 'stop');
  const x = m.load(meeting.id); x.summary = '改'; m.mem.get(meeting.id).dirty = true; // 假设还有未落盘的改动
  const dir = m.dir(meeting.id); await m.remove(meeting.id); m.flush();
  assert.equal(fs.existsSync(dir), false);
});

test('变更广播节流：连续保存最多每秒一次（结尾补发一次），状态切换立即发', async t => {
  let changed = 0; const { m } = companion(t, undefined, {}, { changed() { changed++; } });
  const meeting = m.create(); assert.equal(changed, 1, '新建立即广播');
  for (let i = 1; i <= 30; i++) mark(m, meeting.id, i * 1000);
  assert.equal(changed, 1, '一秒内的保存不逐次广播');
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(changed, 2, '结尾补发一次');
  m.control(meeting.id, 'pause'); assert.equal(changed, 3, '暂停立即广播');
});

test('读截图不复制、不读整份会议', t => {
  const { m } = companion(t), meeting = m.create();
  const jpg = Buffer.alloc(64, 7); jpg[0] = 0xff; jpg[1] = 0xd8;
  m.capture(meeting.id, { kind: 'slide', at: 1000, data: jpg.toString('base64') });
  const load = t.mock.method(m, 'load'), readFile = t.mock.method(fs, 'readFileSync');
  const s = m.slide(meeting.id, 1);
  assert.equal(Buffer.from(s.data, 'base64').length, 64);
  assert.equal(load.mock.callCount(), 0);
  assert.ok(readFile.mock.calls.every(c => !String(c.arguments[0]).endsWith('meeting.json')), '没读 meeting.json');
});

// 旧实现原样保留，用来逐条对比。
const time = ms => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const normalize = text => String(text || '').normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '').toLowerCase();
function compactEventsOld(events, names = {}) {
  const rows = [];
  for (const e of events.filter(e => ['transcript', 'mark', 'slide'].includes(e.kind))) {
    const duplicate = e.kind === 'transcript' && [...rows].reverse().find(r => r.event.kind === 'transcript' && r.event.track !== e.track && Math.abs(r.event.at - e.at) <= 2500 && Math.min(r.event.end ?? r.event.at + 1000, e.end ?? e.at + 1000) >= Math.max(r.event.at, e.at) && similar(normalize(r.event.text), normalize(e.text)));
    if (duplicate) { duplicate.refs.push(e.seq); continue; }
    rows.push({ event: e, refs: [e.seq] });
  }
  return rows.map(({ event: e, refs }) => `[${refs.join(',')}] ${time(e.at)} ${e.kind === 'slide' ? '截图' : e.kind === 'mark' ? '重点' : names[e.speaker] || (e.track === 'mic' ? '麦克风' : '系统声音')} ${String(e.kind === 'slide' ? e.file : e.text).replace(/[\r\n]+/g, ' ')}`).join('\n');
}

test('双音轨去重改成分桶后，与旧实现逐条一致（随机会议 200 场 + 边界）', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const phrases = ['决定明天复核', '嗯决定明天复核啊', '步长定为0.4', '步长定为 0.4。', '好', '下周二给结论', '负责人小王', '干扰场景再看'];
  for (let round = 0; round < 200; round++) {
    const events = []; let at = 0;
    for (let i = 1; i <= 300; i++) {
      at += Math.floor(rnd() * 3000) - 600; // 有时倒退：两条音轨转写先后不按时间
      const k = rnd(), track = rnd() < 0.5 ? 'mic' : 'system';
      if (k < 0.75) events.push({ seq: i, kind: 'transcript', at: Math.max(0, at), ...(rnd() < 0.7 ? { end: Math.max(0, at) + Math.floor(rnd() * 4000) } : {}), track, text: phrases[Math.floor(rnd() * phrases.length)], ...(rnd() < 0.3 ? { speaker: 's1' } : {}) });
      else if (k < 0.82) events.push({ seq: i, kind: 'mark', at, text: '重点' });
      else if (k < 0.88) events.push({ seq: i, kind: 'slide', at, file: `page-${i}.jpg` });
      else if (k < 0.92) events.push({ seq: i, kind: 'audio', at, end: at + 10000, track });
      else events.push({ seq: i, kind: 'transcript', at: [NaN, Infinity, -2500, 2500, 0][Math.floor(rnd() * 5)], track, text: '决定明天复核' });
    }
    assert.equal(compactEvents(events, { s1: '张三' }), compactEventsOld(events, { s1: '张三' }), `第 ${round} 场不一致`);
  }
});

test('录像块写入不在主线程 fsync：块照常追加，同步交给后台、同一文件合并', async t => {
  const { m } = companion(t), meeting = m.create(), key = randomUUID();
  const fsync = t.mock.method(fs, 'fsyncSync'), opens = t.mock.method(fs.promises, 'open');
  m.capture(meeting.id, { kind: 'recording-start', key, at: 0, full: true, mime: 'video/webm;codecs=vp8,opus', width: 640, height: 360 });
  let offset = 0;
  for (let i = 0; i < 5; i++) { const b = Buffer.alloc(1024, 3); if (!i) b.set([0x1a, 0x45, 0xdf, 0xa3]); m.capture(meeting.id, { kind: 'recording-chunk', key, at: i * 1000, offset, data: b.toString('base64') }); offset += b.length; }
  assert.equal(fsync.mock.callCount(), 0, '块写入不调用 fsyncSync');
  assert.equal(fs.statSync(path.join(m.dir(meeting.id), 'recording-full.webm')).size, 5120, '块都已追加');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(opens.mock.calls.filter(c => String(c.arguments[0]).endsWith('recording-full.webm')).length, 1, '5 块只在后台同步一次，其余合并到 10 秒后');
  for (const s of m.recording.syncs.values()) clearTimeout(s.timer);
});

test('drain(id)：取消排着的低频同步，等正在做的结束，再同步一次才 resolve；只管这场会议的文件', async t => {
  const { m } = companion(t), meeting = m.create(), key = randomUUID();
  m.capture(meeting.id, { kind: 'recording-start', key, at: 0, full: true, mime: 'video/webm;codecs=vp8,opus', width: 640, height: 360 });
  const head = Buffer.alloc(512, 1); head.set([0x1a, 0x45, 0xdf, 0xa3]);
  m.capture(meeting.id, { kind: 'recording-chunk', key, at: 0, offset: 0, data: head.toString('base64') });
  await new Promise(r => setTimeout(r, 50));
  m.capture(meeting.id, { kind: 'recording-chunk', key, at: 1000, offset: 512, data: Buffer.alloc(512, 2).toString('base64') });
  const file = path.join(m.dir(meeting.id), 'recording-full.webm');
  assert.ok(m.recording.syncs.get(file)?.timer, '第二块的同步排在 10 秒后');
  const opens = t.mock.method(fs.promises, 'open');
  await m.recording.drain(meeting.id);
  assert.equal(m.recording.syncs.has(file), false, '排着的同步已取消');
  assert.equal(opens.mock.calls.filter(c => String(c.arguments[0]) === file).length, 1, 'drain 里补做了一次同步');
  await m.recording.drain(meeting.id); // 没有排着的也能立即返回
});

test('有未落盘改动时盘上文件被外部改过：先另存为 meeting.external-*.json 再写，status 给提示', t => {
  const { m } = companion(t), meeting = m.create(); m.flush();
  mark(m, meeting.id, 1000);
  const file = path.join(m.dir(meeting.id), 'meeting.json'), outside = { ...disk(m, meeting.id), title: '外部恢复的旧版' };
  fs.writeFileSync(file, JSON.stringify(outside)); const later = new Date(Date.now() + 10000); fs.utimesSync(file, later, later);
  m.flush();
  const kept = fs.readdirSync(m.dir(meeting.id)).filter(f => /^meeting\.external-.*\.json$/.test(f));
  assert.equal(kept.length, 1, '外部那份另存了');
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.dir(meeting.id), kept[0]), 'utf8')).title, '外部恢复的旧版');
  assert.equal(disk(m, meeting.id).events.length, 1, '正本照常写下');
  assert.match(m.status(meeting.id).storageError, /在 Hub 之外被改过.*meeting\.external-/);
  mark(m, meeting.id, 2000); m.flush();
  assert.equal(fs.readdirSync(m.dir(meeting.id)).filter(f => /^meeting\.external-/.test(f)).length, 1, '自己写的不算外部改动');
});

test('退出时有未落盘改动：close() 刷盘，重开读回（main.js 正常收尾 capture(company-assistant) 与 will-quit 兜底都走这里）', t => {
  const { m, root } = companion(t), meeting = m.create();
  for (let i = 1; i <= 7; i++) mark(m, meeting.id, i * 1000);
  assert.equal(disk(m, meeting.id).events.length, 0);
  m.close();
  assert.equal(companion(t, root).m.load(meeting.id).events.length, 7);
});

test('多数据根：两个根下同一编号，改名、重新扫描后索引一致，删除后副本不复活', async t => {
  const base = temp(t), primary = path.join(base, 'p'), extra = path.join(base, 'x');
  const mk = () => companion(t, primary, {}, { meetingRootCandidates: () => [path.join(extra, 'meetings')] }).m;
  const m = mk(), meeting = m.create({ title: '两边都有' }); m.control(meeting.id, 'stop');
  const copy = path.join(extra, 'meetings', meeting.id); fs.mkdirSync(copy, { recursive: true });
  const old = { ...disk(m, meeting.id), title: '旧副本' }; fs.writeFileSync(path.join(copy, 'meeting.json'), JSON.stringify(old));
  const past = new Date(Date.now() - 86400000); fs.utimesSync(path.join(copy, 'meeting.json'), past, past);
  m.close();
  const a = mk();
  assert.equal(a.meetingOfSession(meeting.sessionId), meeting.id);
  assert.equal(a.load(meeting.id).title, '两边都有', '显示较新的那份');
  a.rename(meeting.id, '改名后'); a.scan(); a.list();
  assert.equal(a.meetingOfSession(meeting.sessionId), meeting.id, '改名、重新扫描后仍指向同一场');
  assert.equal(a.dir(meeting.id), path.join(primary, 'meetings', meeting.id), '写的还是显示的那份');
  assert.equal(disk(a, meeting.id).title, '改名后');
  await a.remove(meeting.id);
  assert.equal(a.ownsSession(meeting.sessionId), false);
  a.close();
  const b = mk(); assert.equal(b.ownsSession(meeting.sessionId), false, '重开后副本不复活'); assert.ok(!b.list().some(x => x.id === meeting.id));
});

test('合并窗口里重新扫描改选了另一份目录：采集中的正本仍固定读写原目录，另一份不被覆盖、截图照常读到', t => {
  const base = temp(t), primary = path.join(base, 'p'), extra = path.join(base, 'x');
  const { m } = companion(t, primary, {}, { meetingRootCandidates: () => [path.join(extra, 'meetings')] });
  const meeting = m.create({ title: '采集中' }), home = m.dir(meeting.id);
  const jpg = Buffer.alloc(64, 7); jpg[0] = 0xff; jpg[1] = 0xd8;
  m.capture(meeting.id, { kind: 'slide', at: 1000, data: jpg.toString('base64') }); mark(m, meeting.id, 2000);
  const copy = path.join(extra, 'meetings', meeting.id); fs.mkdirSync(copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'meeting.json'), JSON.stringify({ ...disk(m, meeting.id), title: '另一份' }));
  const later = new Date(Date.now() + 60000); fs.utimesSync(path.join(copy, 'meeting.json'), later, later);
  m.scan(); assert.equal(m.where.get(meeting.id), path.join(extra, 'meetings'), '扫描改选了较新的另一份');
  assert.equal(m.dir(meeting.id), home, '采集中固定原目录');
  mark(m, meeting.id, 3000); m.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(copy, 'meeting.json'), 'utf8')).title, '另一份', '另一份没被覆盖');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'meeting.json'), 'utf8')).events.length, 3);
  assert.equal(Buffer.from(m.slide(meeting.id, 1).data, 'base64').length, 64, '截图从原目录读');
  m.control(meeting.id, 'stop'); m.scan();
  assert.equal(m.load(meeting.id).title, '另一份', '结束、落盘后才按扫描结果换到另一份');
});

function videoMeeting(t) {
  const { m } = companion(t), meeting = m.create(), key = randomUUID();
  m.capture(meeting.id, { kind: 'recording-start', key, at: 0, full: true, mime: 'video/webm;codecs=vp8,opus', width: 640, height: 360 });
  let offset = 0;
  const chunk = at => { const b = Buffer.alloc(256, 5); if (!offset) b.set([0x1a, 0x45, 0xdf, 0xa3]); m.capture(meeting.id, { kind: 'recording-chunk', key, at, offset, data: b.toString('base64') }); offset += b.length; };
  t.after(() => { for (const s of m.recording.syncs.values()) clearTimeout(s.timer); });
  return { m, meeting, chunk, file: () => path.join(m.dir(meeting.id), 'recording-full.webm') };
}

test('并发 drain 共用同一次在途同步：第一次 drain 没结束前第二次不会先返回，记录全程保留', async t => {
  const { m, meeting, chunk, file } = videoMeeting(t);
  chunk(0); await new Promise(r => setTimeout(r, 30)); chunk(1000);
  let release; const gate = new Promise(r => { release = r; }), real = fs.promises.open, opened = [];
  t.mock.method(fs.promises, 'open', async (...a) => { opened.push(a[0]); const h = await real(...a); return { sync: async () => { await gate; return h.sync(); }, close: () => h.close() }; });
  const first = m.recording.drain(meeting.id), second = m.recording.drain(meeting.id);
  let secondDone = false; second.then(() => { secondDone = true; });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(secondDone, false, '第二次 drain 等着同一次同步');
  assert.ok(m.recording.syncs.has(file()), '在途期间记录不移除');
  m.recording.syncAllNow(); // 退出时能看到在途的这条并就地同步
  release(); await Promise.all([first, second]);
  assert.equal(opened.filter(f => f === file()).length, 1, '两次 drain 只做了一次最终同步');
});

test('同步出错（EIO）：drain 如实失败、错误进状态、按退避重试；恢复后清掉错误', async t => {
  const { m, meeting, chunk, file } = videoMeeting(t);
  chunk(0); await new Promise(r => setTimeout(r, 30));
  let broken = true; const real = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...a) => { if (broken && String(a[0]).endsWith('.webm')) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return real(...a); });
  chunk(1000);
  await assert.rejects(m.recording.drain(meeting.id), /录像还没同步到磁盘.*EIO/);
  const s = m.recording.syncs.get(file());
  assert.ok(s && s.failures >= 1 && s.timer, '失败的记录留着、排了重试');
  assert.match(m.status(meeting.id).recordingError, /录像同步到磁盘失败/);
  m.control(meeting.id, 'stop');
  await assert.rejects(m.remove(meeting.id), /录像还没同步到磁盘.*会议没有删/);
  assert.ok(fs.existsSync(m.dir(meeting.id)));
  broken = false; await m.recording.drain(meeting.id);
  assert.equal(m.recording.syncs.has(file()), false); assert.doesNotMatch(m.status(meeting.id).recordingError || '', /录像同步/);
});

test('限频：同步完成后紧接着的新块不会立即再同步，要等满 10 秒', async t => {
  const { m, chunk, file } = videoMeeting(t);
  const opens = t.mock.method(fs.promises, 'open');
  chunk(0); await new Promise(r => setTimeout(r, 40));
  chunk(1000); await new Promise(r => setTimeout(r, 40)); chunk(2000); await new Promise(r => setTimeout(r, 40));
  assert.equal(opens.mock.calls.filter(c => String(c.arguments[0]) === file()).length, 1, '45 ms 内只同步一次');
  assert.ok(m.recording.syncs.get(file())?.timer, '下一次排在 10 秒后');
});

test('采集中某道问题到终态（done/error/cancelled）立即落盘，排队/处理中仍合并', t => {
  const { m } = companion(t), meeting = m.create(); m.flush();
  const x = m.load(meeting.id); x.answers.push({ id: 'q1', q: '问', state: 'queued' }); m.save(x);
  assert.equal(disk(m, meeting.id).answers.length, 0, '排队中合并');
  for (const state of ['running', 'done']) { const y = m.load(meeting.id); y.answers[0].state = state; m.save(y); }
  assert.equal(disk(m, meeting.id).answers[0].state, 'done', '答完立即写');
  const z = m.load(meeting.id); z.answers.push({ id: 'q2', q: '问2', state: 'queued' }); m.save(z); z.answers[1].state = 'cancelled'; m.save(z);
  assert.equal(disk(m, meeting.id).answers[1].state, 'cancelled');
});

test('changeMark：内容变了标记就变，没变不变，不读整份会议', t => {
  const { m } = companion(t), meeting = m.create(); const a = m.changeMark(meeting.id);
  assert.equal(m.changeMark(meeting.id), a);
  mark(m, meeting.id, 1000); const b = m.changeMark(meeting.id); assert.notEqual(b, a, '未落盘改动也算');
  m.flush(); const c = m.changeMark(meeting.id); assert.notEqual(c, a);
  const load = t.mock.method(m, 'load'), entry = t.mock.method(m, 'entry'); m.changeMark(meeting.id);
  assert.equal(load.mock.callCount() + entry.mock.callCount(), 0);
  assert.equal(m.changeMark('00000000-0000-0000-0000-000000000000'), '');
});

test('复核 #144-1：drain 接上后台在途同步时，在途那次结束也不移除记录，直到最终 sync→close 收尾', async t => {
  const { m, meeting, chunk, file } = videoMeeting(t);
  let release; const gate = new Promise(r => { release = r; }), real = fs.promises.open; let opens = 0;
  t.mock.method(fs.promises, 'open', async (...a) => { const h = await real(...a); if (String(a[0]).endsWith('.webm')) opens++; return { sync: async () => { if (String(a[0]).endsWith('.webm')) await gate; return h.sync(); }, close: () => h.close() }; });
  chunk(0); await new Promise(r => setTimeout(r, 30)); // 后台同步已开始、卡在 sync
  assert.ok(m.recording.syncs.get(file())?.inflight, '后台同步在途');
  const first = m.recording.drain(meeting.id), second = m.recording.drain(meeting.id);
  let done = false; second.then(() => { done = true; });
  release(); await new Promise(r => setTimeout(r, 0)); // 后台那次结束
  assert.ok(m.recording.syncs.has(file()) || done, '在途那次结束时记录不被提前移除');
  await Promise.all([first, second]);
  assert.equal(opens, 2, '后台一次 + drain 最终一次');
  assert.equal(m.recording.syncs.has(file()), false, '最终同步收尾后才移除');
});

test('复核 #144-2：drain 按记录里的会议编号筛，目录改选后原目录的待同步录像也会同步', async t => {
  const { m, meeting } = videoMeeting(t);
  const other = path.join(temp(t), 'recording-full.webm'); fs.writeFileSync(other, Buffer.alloc(16));
  m.recording.syncedAt.set(other, Date.now()); m.recording.syncLater(other, meeting.id); // 排在 10 秒后
  const opens = t.mock.method(fs.promises, 'open');
  await m.recording.drain(meeting.id);
  assert.ok(opens.mock.calls.some(c => c.arguments[0] === other)); assert.equal(m.recording.syncs.has(other), false);
});

test('复核 #144-3：退出时同步 EIO 不吞：记日志、写进会议，下次启动再同步并提示', t => {
  const { m, meeting, chunk } = videoMeeting(t), root = path.dirname(path.dirname(m.dir(meeting.id)));
  chunk(0); const s = m.recording.syncs.values().next().value; clearTimeout(s.timer); s.timer = setTimeout(() => {}, 60000); // 让它还排着
  const realSync = fs.fsyncSync; let broken = true;
  t.mock.method(fs, 'fsyncSync', fd => { if (broken) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return realSync(fd); });
  const warn = t.mock.method(console, 'warn', () => {});
  m.close();
  assert.ok(warn.mock.calls.some(c => /退出时录像没能同步到磁盘/.test(c.arguments[0])));
  assert.match(disk(m, meeting.id).recording.syncError.error, /EIO/, '写进会议');
  const again = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null }, { powerSaveBlocker: false, meetingAsr: { status: () => ({ ready: false }), close() {} } });
  again.tools = { start: async () => {}, bind() {}, close() {}, unbind() {} }; again.tick = async () => {}; t.after(() => again.close());
  again.start();
  assert.match(again.status(meeting.id).recordingError, /上次退出时录像没能同步到磁盘.*仍失败/);
  broken = false; again.recovered = false; clearInterval(again.timer); again.timer = null; again.start();
  assert.equal(disk(again, meeting.id).recording.syncError, undefined, '再同步成功后清掉');
});

test('listIds：只读目录名不解析，已删的不列', async t => {
  const { m, root } = companion(t), a = m.create(); m.control(a.id, 'stop'); const b = m.create(); m.control(b.id, 'stop');
  await m.remove(a.id); m.close();
  const fresh = companion(t, root).m, read = t.mock.method(fs, 'readFileSync');
  assert.deepEqual(fresh.listIds(), [b.id]);
  assert.ok(read.mock.calls.every(c => !String(c.arguments[0]).endsWith('meeting.json')), '没解析 meeting.json');
});

test('复核 #182：drain 第一次 EIO 保留错误码 → 补索引按瞬时失败排重试 → 第二次成功后 seekIndexVersion=1', async t => {
  const { webmFixture } = require('./helpers/meeting-media-fixtures');
  const { m } = companion(t), meeting = m.create(), key = randomUUID(); m.recording.retryDelays = [30, 30, 30];
  t.after(() => { for (const s of m.recording.syncs.values()) clearTimeout(s.timer); for (const x of m.recording.retryTimers.values()) clearTimeout(x); });
  m.capture(meeting.id, { kind: 'recording-start', key, at: 0, full: true, mime: 'video/webm;codecs=vp8,opus', width: 640, height: 360 });
  const bytes = webmFixture();
  m.capture(meeting.id, { kind: 'recording-chunk', key, at: 1000, offset: 0, data: bytes.toString('base64'), durationMs: 3000 });
  let broken = true; const realSync = fs.fsyncSync, realOpen = fs.promises.open;
  const eio = () => Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
  t.mock.method(fs, 'fsyncSync', fd => { if (broken) throw eio(); return realSync(fd); });
  t.mock.method(fs.promises, 'open', async (...a) => { if (broken && String(a[0]).endsWith('.webm')) throw eio(); return realOpen(...a); });
  await assert.rejects(m.recording.drain(meeting.id), e => e.code === 'EIO' && /录像还没同步到磁盘/.test(e.message), 'drain 保留原错误码');
  m.capture(meeting.id, { kind: 'recording-finish', key, at: 3000, durationMs: 3000 });
  await m.recording.repairs.get(meeting.id);
  const first = m.load(meeting.id).recording.full;
  assert.equal(first.repairFailure?.kind, 'transient', 'EIO 判为瞬时失败'); assert.equal(first.repairFailure?.code, 'EIO');
  assert.ok(m.recording.retryTimers.has(meeting.id), '排了重试');
  broken = false;
  for (let i = 0; i < 100 && m.load(meeting.id).recording.full.seekIndexVersion !== 1; i++) { await new Promise(r => setTimeout(r, 20)); await m.recording.repairs.get(meeting.id); }
  const done = m.load(meeting.id).recording.full;
  assert.equal(done.seekIndexVersion, 1); assert.equal(done.status, 'ready'); assert.equal(done.repairFailure, undefined);
});
