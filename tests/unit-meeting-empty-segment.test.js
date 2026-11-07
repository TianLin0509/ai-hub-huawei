'use strict';
// 录像分段 0 字节时结束会议不能永远失败：标记 empty、记缺口、正常结束，且不进回放列表。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MeetingCompanion } = require('../core/company-assistant/meeting');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-empty-'));
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null }, { meetingAsr: { status: () => ({ ready: false }), close() {} } });
  clearInterval(m.timer);
  const meeting = m.create({ title: '空分段' });
  return { m, id: meeting.id };
}

test('0 字节分段结束不抛错，标记 empty 并记缺口', () => {
  const { m, id } = setup();
  const key = randomUUID();
  m.capture(id, { kind: 'recording-start', key, at: 1000, mime: 'video/webm', width: 100, height: 60 });
  m.capture(id, { kind: 'recording-finish', key, at: 1200 });
  m.capture(id, { kind: 'recording-finish', key, at: 1200 }); // 重试同样成功
  const rec = m.load(id).recording;
  assert.equal(rec.segments[0].status, 'empty');
  assert.equal(rec.segments.filter(s => s.status === 'ready').length, 0);
  assert.ok(rec.gaps.some(g => /没有录到内容/.test(g.reason)));
});

test('完整录像 0 字节也允许结束', () => {
  const { m, id } = setup();
  const key = randomUUID();
  m.capture(id, { kind: 'recording-start', key, full: true, at: 0, mime: 'video/webm', width: 100, height: 60 });
  m.capture(id, { kind: 'recording-finish', key, at: 300 });
  const rec = m.load(id).recording;
  assert.equal(rec.full.status, 'empty');
  assert.ok(rec.gaps.some(g => /完整录像没有录到内容/.test(g.reason)));
});

test('对照：有字节的分段仍然是 ready', () => {
  const { m, id } = setup();
  const key = randomUUID();
  const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  m.capture(id, { kind: 'recording-start', key, at: 0, mime: 'video/webm', width: 1, height: 1 });
  m.capture(id, { kind: 'recording-chunk', key, at: 100, offset: 0, data: bytes.toString('base64') });
  m.capture(id, { kind: 'recording-finish', key, at: 200 });
  assert.equal(m.load(id).recording.segments[0].status, 'ready');
});
