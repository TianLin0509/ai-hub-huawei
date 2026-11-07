'use strict';
// 一场 meeting.json 坏掉（空文件、半截 JSON）不能拖垮其他会议：list/start/ownsSession 照常，有 .bak 时自动回退。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MeetingCompanion } = require('../core/company-assistant/meeting');

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-corrupt-'));
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null }, { meetingAsr: { status: () => ({ ready: false }), close() {} } });
  m.tools.start = async () => {}; m.tools.bind = () => {}; m.tools.close = () => {};
  return { root, m };
}

test('空文件和缺文件的会议被跳过，其余会议照常 list/start/ownsSession/create', () => {
  const { root, m } = mk();
  const good = m.create({ title: '好的' });
  m.save({ ...m.load(good.id), state: 'finished' });
  const badId = '11111111-1111-1111-1111-111111111111', emptyId = '22222222-2222-2222-2222-222222222222';
  fs.mkdirSync(path.join(root, 'meetings', badId), { recursive: true });
  fs.writeFileSync(path.join(root, 'meetings', badId, 'meeting.json'), '');
  fs.mkdirSync(path.join(root, 'meetings', emptyId), { recursive: true }); // 磁盘满留下的空目录
  const fresh = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null }, { meetingAsr: { status: () => ({ ready: false }), close() {} } });
  fresh.tools.start = async () => {};
  assert.deepEqual(fresh.list().map(x => x.id), [good.id]);
  assert.doesNotThrow(() => fresh.start());
  assert.equal(fresh.ownsSession('nope'), false);
  assert.ok(fresh.corrupt.has(badId));
  assert.doesNotThrow(() => fresh.create({ title: '新会议' }));
  fresh.close(); m.close();
});

test('meeting.json 损坏时回退到 .bak', () => {
  const { root, m } = mk();
  const a = m.create({ title: '带备份' });
  m.save({ ...m.load(a.id), title: '第二次' }); // 第一次写已留下 .bak? 强制留一份
  const file = path.join(root, 'meetings', a.id, 'meeting.json');
  fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, '{"id": "半截');
  assert.equal(m.load(a.id).title, '第二次');
  m.close();
});
