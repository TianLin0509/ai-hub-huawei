'use strict';
// 升级后找不到以前的会议（2026-11-18 反馈 5.6.47：录屏、纪要、录音、截图都不见了）。
// 会议文件没有被任何版本删掉，只是留在了另一个数据目录里：自定义目录启用失败回退默认目录、换回旧目录时目标已有数据不复制。
// 这里按真实目录结构摆好旧数据，走一遍启动时的目录选择，再看会议页列表能不能把旧会议找回来。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { prepareDataRoot } = require('../core/company-assistant/data-root');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { CompanyAssistant } = require('../core/company-assistant/service');

function sandbox(t) {
  const base = path.join(__dirname, '../artifacts'); fs.mkdirSync(base, { recursive: true });
  const home = fs.mkdtempSync(path.join(base, 'meeting-roots-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
// 旧版本写下的一场已结束会议：meeting.json + 截图 + 录像，和 MeetingCompanion 落盘的结构一致。
function oldMeeting(assistantDir, title, id = randomUUID()) {
  const dir = path.join(assistantDir, 'workspace', 'meetings', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meeting.json'), JSON.stringify({ id, title, startedAt: Date.parse('2026-11-10T02:00:00Z'), state: 'ended', events: [{ seq: 1, kind: 'slide', at: 0 }], answers: [], summary: '纪要', recording: { bytes: 2048 } }), 'utf8');
  fs.writeFileSync(path.join(dir, 'slide-1.jpg'), 'jpg');
  fs.writeFileSync(path.join(dir, 'recording.mp4'), 'mp4');
  return id;
}
// 按 service.js 的接线组一个会议服务：目录选择用真实的 prepareDataRoot，候选目录用真实的 meetingRootCandidates。
function boot(t, defaultDir) {
  const storage = prepareDataRoot(defaultDir);
  const a = { defaultDir, dir: storage.dir, dataRootError: storage.error, workspace: path.join(storage.dir, 'workspace'), changed() {}, sessionBusy: () => false };
  a.meetingRootCandidates = CompanyAssistant.prototype.meetingRootCandidates.bind(a);
  const m = new MeetingCompanion(a, { powerSaveBlocker: false, getSession: () => null, closeSession: async () => {}, meetingAsr: { status: () => ({ ready: false }), close() {} } });
  m.tools = { start: async () => {}, bind() {}, close() {}, unbind() {} };
  t.after(() => m.close());
  return { m, storage };
}
const settings = (defaultDir, value) => { fs.mkdirSync(defaultDir, { recursive: true }); fs.writeFileSync(path.join(defaultDir, 'settings.json'), JSON.stringify(value), 'utf8'); };

test('自定义数据目录这次启用失败、回退默认目录：上次目录里的会议照样列出来，录像和截图可打开', t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant'), custom = path.join(home, 'D-meetings');
  fs.mkdirSync(path.join(defaultDir, 'workspace'), { recursive: true });
  const id = oldMeeting(custom, '上周方案评审');
  // 用户在设置里又改到一个这次建不出来的目录（上级是个文件），启动时只能回退默认目录。
  fs.writeFileSync(path.join(home, 'blocked'), 'file');
  settings(defaultDir, { dataRoot: path.join(home, 'blocked', 'sub'), dataRootActive: custom });
  const { m, storage } = boot(t, defaultDir);
  assert.equal(storage.dir, defaultDir); assert.match(storage.error, /启用失败/);
  const list = m.list();
  assert.deepEqual(list.map(x => x.title), ['上周方案评审'], '旧会议出现在列表里');
  assert.equal(list[0].videoBytes, 2048);
  assert.equal(m.dir(id), path.join(custom, 'workspace', 'meetings', id), '原地读，不复制');
  assert.ok(fs.existsSync(path.join(m.dir(id), 'recording.mp4')));
  assert.equal(m.load(id).summary, '纪要');
  const st = m.status(id).storage;
  assert.equal(st.root, path.join(defaultDir, 'workspace', 'meetings'));
  assert.deepEqual(st.extra, [{ dir: path.join(custom, 'workspace', 'meetings'), count: 1 }]);
  assert.match(st.dataRootError, /启用失败/);
});

test('从自定义目录换回默认目录（默认目录已有数据不复制）：在自定义目录里开过的会议不丢', t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant'), custom = path.join(home, 'D-meetings');
  const before = oldMeeting(defaultDir, '迁移前的会'), after = oldMeeting(custom, '迁移后在 D 盘开的会');
  settings(defaultDir, { dataRoot: '', dataRootActive: custom });
  const { m, storage } = boot(t, defaultDir);
  assert.equal(storage.dir, defaultDir); assert.equal(storage.copied, false, '默认目录已有数据，启动时不复制');
  assert.deepEqual(m.list().map(x => x.id).sort(), [before, after].sort());
  // 再启动一次（dataRootActive 已经改成默认目录）：靠 dataRootHistory 记住的旧目录仍能找回。
  const saved = JSON.parse(fs.readFileSync(path.join(defaultDir, 'settings.json'), 'utf8'));
  assert.equal(saved.dataRootActive, defaultDir); assert.deepEqual(saved.dataRootHistory, [custom]);
  const again = boot(t, defaultDir).m;
  assert.deepEqual(again.list().map(x => x.id).sort(), [before, after].sort());
});

test('迁移复制过的同一场只列一次、一样新时以当前目录为准；确认框选了「一起删」才删旧目录的副本，删后不复活', async t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant'), custom = path.join(home, 'D-meetings');
  const id = oldMeeting(defaultDir, '副本');
  oldMeeting(custom, '当前', id);
  settings(defaultDir, { dataRoot: custom, dataRootActive: custom });
  const { m, storage } = boot(t, defaultDir);
  assert.equal(storage.dir, custom);
  assert.deepEqual(m.list().map(x => x.title), ['当前']);
  assert.deepEqual(m.status().storage.extra, [], '默认目录里的副本不算另有的会议');
  const done = await m.remove(id, { alsoCopies: true });
  assert.equal(fs.existsSync(path.join(defaultDir, 'workspace', 'meetings', id)), false, '旧目录的副本一起删掉');
  assert.equal(done.kept, undefined);
  assert.deepEqual(boot(t, defaultDir).m.list(), [], '重启后也不会冒出来');
});

test('没有自定义目录的普通用户：只看默认目录，行为不变；读不出的会议在页面上说明位置', t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant');
  const id = oldMeeting(defaultDir, '日常会议');
  const bad = randomUUID(), badDir = path.join(defaultDir, 'workspace', 'meetings', bad);
  fs.mkdirSync(badDir, { recursive: true }); fs.writeFileSync(path.join(badDir, 'meeting.json'), '{"id":', 'utf8');
  const { m } = boot(t, defaultDir);
  assert.deepEqual(m.roots(), [path.join(defaultDir, 'workspace', 'meetings')]);
  assert.deepEqual(m.list().map(x => x.id), [id]);
  const st = m.status().storage;
  assert.deepEqual(st.extra, []);
  assert.equal(st.corrupt.length, 1); assert.equal(st.corrupt[0].dir, badDir);
});

test('当前目录暂时读不了：沿用上次的位置，不把这场的读写改到旧目录的副本上', t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant'), custom = path.join(home, 'D-meetings');
  const id = oldMeeting(defaultDir, '副本'); oldMeeting(custom, '当前', id);
  settings(defaultDir, { dataRoot: custom, dataRootActive: custom });
  const { m } = boot(t, defaultDir), primary = path.join(custom, 'workspace', 'meetings');
  assert.equal(m.dir(id), path.join(primary, id));
  const real = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (p, ...rest) => { if (path.resolve(String(p)) === primary) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return real(p, ...rest); });
  m.scan();
  assert.equal(m.dir(id), path.join(primary, id), '仍指向当前目录');
});

test('旧目录的副本删不掉（被占用）：已记墓碑，列表里也不会冒出来', async t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant'), custom = path.join(home, 'D-meetings');
  const id = oldMeeting(defaultDir, '副本'); oldMeeting(custom, '当前', id);
  settings(defaultDir, { dataRoot: custom, dataRootActive: custom });
  const { m } = boot(t, defaultDir), copy = path.join(defaultDir, 'workspace', 'meetings', id);
  const real = fs.rmSync;
  t.mock.method(fs, 'rmSync', (p, ...rest) => { if (path.resolve(String(p)) === copy) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return real(p, ...rest); });
  await m.remove(id);
  assert.ok(fs.existsSync(copy), '副本还在（删不掉）');
  assert.deepEqual(m.list(), []);
  t.mock.restoreAll();
  assert.deepEqual(boot(t, defaultDir).m.list(), [], '重启后也不出现');
});

test('当前目录整个不见了（ENOENT，如网络盘掉线）：同样沿用上次位置，不改写旧副本', t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant'), custom = path.join(home, 'D-meetings');
  const id = oldMeeting(defaultDir, '副本'); oldMeeting(custom, '当前', id);
  settings(defaultDir, { dataRoot: custom, dataRootActive: custom });
  const { m } = boot(t, defaultDir), primary = path.join(custom, 'workspace', 'meetings');
  m.list();
  const real = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (p, ...rest) => { if (path.resolve(String(p)) === primary) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return real(p, ...rest); });
  m.scan();
  assert.equal(m.dir(id), path.join(primary, id));
});

test('删除后切换到旧副本所在目录：墓碑在固定的默认目录，对所有目录生效', async t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant'), custom = path.join(home, 'D-meetings');
  const id = oldMeeting(defaultDir, '副本'); oldMeeting(custom, '当前', id);
  settings(defaultDir, { dataRoot: custom, dataRootActive: custom });
  const { m } = boot(t, defaultDir), copy = path.join(defaultDir, 'workspace', 'meetings', id);
  const real = fs.rmSync;
  t.mock.method(fs, 'rmSync', (p, ...rest) => { if (path.resolve(String(p)) === copy) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return real(p, ...rest); });
  await m.remove(id);
  t.mock.restoreAll();
  settings(defaultDir, { ...JSON.parse(fs.readFileSync(path.join(defaultDir, 'settings.json'), 'utf8')), dataRoot: '' }); // 换回默认目录
  const back = boot(t, defaultDir);
  assert.equal(back.storage.dir, defaultDir);
  assert.deepEqual(back.m.list(), [], '默认目录里删不掉的副本不复活');
});

test('一个目录读不了：只把那里的会议记为读不出，其他会议照常列出', t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant'), custom = path.join(home, 'D-meetings');
  const here = oldMeeting(custom, '当前目录的会'), there = oldMeeting(defaultDir, '默认目录的会');
  settings(defaultDir, { dataRoot: custom, dataRootActive: custom });
  const { m } = boot(t, defaultDir);
  assert.equal(m.list().length, 2);
  const lost = path.join(defaultDir, 'workspace', 'meetings');
  const realStat = fs.statSync, realRead = fs.readFileSync, realDir = fs.readdirSync;
  const deny = p => path.resolve(String(p)).startsWith(lost);
  const eacces = () => Object.assign(new Error('denied'), { code: 'EACCES' });
  t.mock.method(fs, 'statSync', (p, ...r) => { if (deny(p)) throw eacces(); return realStat(p, ...r); });
  t.mock.method(fs, 'readFileSync', (p, ...r) => { if (deny(p)) throw eacces(); return realRead(p, ...r); });
  t.mock.method(fs, 'readdirSync', (p, ...r) => { if (deny(p)) throw eacces(); return realDir(p, ...r); });
  m.listMemo = null; /* Hub 之外的改动最多 15 秒后才反映（LIST_TTL_MS），这里直接让列表过期 */ 
  assert.deepEqual(m.list().map(x => x.id), [here]);
  assert.deepEqual(m.status().storage.corrupt.map(x => x.id), [there]);
});

test('墓碑写不进默认目录：改写到当前目录也能挡住副本；两处都写不进且副本删不掉时如实提示', async t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant'), custom = path.join(home, 'D-meetings');
  const id = oldMeeting(defaultDir, '副本'); oldMeeting(custom, '当前', id);
  const id2 = oldMeeting(defaultDir, '副本2'); oldMeeting(custom, '当前2', id2);
  settings(defaultDir, { dataRoot: custom, dataRootActive: custom });
  const { m } = boot(t, defaultDir);
  const copy = p => path.resolve(String(p)).startsWith(path.join(defaultDir, 'workspace', 'meetings'));
  const fixed = path.join(defaultDir, 'meeting-tombstones.json');
  const realRm = fs.rmSync, realWrite = fs.writeFileSync;
  t.mock.method(fs, 'rmSync', (p, ...r) => { if (copy(p)) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return realRm(p, ...r); });
  t.mock.method(fs, 'writeFileSync', (p, ...r) => { if (String(p).startsWith(fixed)) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return realWrite(p, ...r); });
  const first = await m.remove(id);
  assert.equal(first.warning, undefined, '当前目录的备份墓碑写成功，不用提示');
  t.mock.method(fs, 'writeFileSync', (p, ...r) => { if (/tombstones|deleted-meetings/.test(String(p))) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return realWrite(p, ...r); });
  const second = await m.remove(id2);
  assert.match(second.warning, /重启后可能重新出现/);
  t.mock.restoreAll();
  settings(defaultDir, { ...JSON.parse(fs.readFileSync(path.join(defaultDir, 'settings.json'), 'utf8')), dataRoot: '' });
  const ids = boot(t, defaultDir).m.list().map(x => x.id);
  assert.ok(!ids.includes(id), '备份墓碑在切回默认目录后仍生效');
});

test('选中的会议读不了：状态请求照常返回列表和材料位置，单独带回错误', t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant');
  const a = oldMeeting(defaultDir, '好的'), b = oldMeeting(defaultDir, '坏的');
  const { m } = boot(t, defaultDir); m.list();
  const bad = path.join(defaultDir, 'workspace', 'meetings', b), real = fs.readFileSync;
  // 会议正本常驻内存（2026-11-24）：文件没变时直接用内存那份；这里让文件在外面被改过、又读不了，才需要重读。
  const later = new Date(Date.now() + 10000); fs.utimesSync(path.join(bad, 'meeting.json'), later, later);
  t.mock.method(fs, 'readFileSync', (p, ...r) => { if (path.resolve(String(p)).startsWith(bad)) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return real(p, ...r); });
  const st = m.status(b);
  assert.equal(st.meeting, null); assert.match(st.meetingError, /denied/);
  assert.ok(st.meetings.some(x => x.id === a)); assert.ok(st.storage);
});

// 同一场会两个目录都有、两边都改过（2026-11-19 审查必改）：显示较新的那份，材料位置提示另一份，删除默认只删显示的这份。
const touch = (dir, when) => { for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), when, when); };
test('默认目录是旧版、自定义目录是带纪要的新版：显示新版，材料位置提示另一份较旧', t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant'), custom = path.join(home, 'D-meetings');
  const id = oldMeeting(defaultDir, '旧版');
  oldMeeting(custom, '新版', id);
  const oldDir = path.join(defaultDir, 'workspace', 'meetings', id), newDir = path.join(custom, 'workspace', 'meetings', id);
  touch(oldDir, new Date('2026-11-10T03:00:00Z'));
  touch(newDir, new Date('2026-11-10T03:00:00Z'));
  fs.writeFileSync(path.join(newDir, 'minutes.md'), '# 新版纪要'); // 在自定义目录里整理出了纪要
  // 当前数据目录是默认目录（自定义目录是以前用过的），按旧规则会显示默认目录里的旧版。
  settings(defaultDir, { dataRoot: '', dataRootActive: custom });
  const { m, storage } = boot(t, defaultDir);
  assert.equal(storage.dir, defaultDir);
  assert.deepEqual(m.list().map(x => x.title), ['新版'], '只列一次，显示新版');
  assert.equal(m.dir(id), newDir);
  const st = m.status(id).storage;
  assert.equal(st.current, newDir);
  assert.deepEqual(st.copies, [{ dir: oldDir, relation: 'older' }]);
});

test('两个目录都有同一场：删除默认只删显示的这份并记墓碑，另一份留在原处、重启也不再显示', async t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant'), custom = path.join(home, 'D-meetings');
  const id = oldMeeting(defaultDir, '旧版'); oldMeeting(custom, '新版', id);
  const oldDir = path.join(defaultDir, 'workspace', 'meetings', id), newDir = path.join(custom, 'workspace', 'meetings', id);
  touch(oldDir, new Date('2026-11-10T03:00:00Z'));
  settings(defaultDir, { dataRoot: '', dataRootActive: custom });
  const { m } = boot(t, defaultDir);
  assert.equal(m.dir(id), newDir);
  const done = await m.remove(id);
  assert.equal(fs.existsSync(newDir), false, '显示的这份删掉');
  assert.ok(fs.existsSync(path.join(oldDir, 'meeting.json')), '另一份没动');
  assert.deepEqual(done.kept, [oldDir]); assert.equal(done.warning, undefined);
  assert.deepEqual(m.list(), []);
  assert.deepEqual(boot(t, defaultDir).m.list(), [], '重启后另一份也不冒出来');
});

test('墓碑文件坏了：认得出的编号照样算删过；再删一场时先备份坏文件，不整份覆盖', async t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant');
  const gone = randomUUID(), keep = oldMeeting(defaultDir, '留着'), next = oldMeeting(defaultDir, '要删');
  oldMeeting(defaultDir, '删过的副本', gone);
  const file = path.join(defaultDir, 'meeting-tombstones.json'), broken = `["${gone}","${randomUUID().slice(0, 10)}`;
  fs.writeFileSync(file, broken, 'utf8'); // 断电留下的半截
  const { m } = boot(t, defaultDir);
  assert.deepEqual(m.list().map(x => x.id).sort(), [keep, next].sort(), '坏墓碑里能认出的那场仍算删过');
  await m.remove(next);
  const backups = fs.readdirSync(defaultDir).filter(f => f.startsWith('meeting-tombstones.json.bad-'));
  assert.equal(backups.length, 1, '坏文件先备份');
  assert.equal(fs.readFileSync(path.join(defaultDir, backups[0]), 'utf8'), broken);
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(now.includes(gone) && now.includes(next), '新墓碑合并了旧编号和新删的');
  assert.deepEqual(boot(t, defaultDir).m.list().map(x => x.id), [keep]);
});

test('打开材料文件夹：单场文件夹不在了就报错、不建空文件夹', async t => {
  const home = sandbox(t), defaultDir = path.join(home, 'company-assistant');
  const id = oldMeeting(defaultDir, '会');
  const { m } = boot(t, defaultDir); m.list();
  const dir = path.join(defaultDir, 'workspace', 'meetings', id);
  fs.rmSync(dir, { recursive: true, force: true });
  const handlers = require('../core/company-assistant/meeting-ipc').createMeetingHandlers({ meetings: m });
  await assert.rejects(handlers['meeting-open-folder']({ id }), /文件夹不在了/);
  assert.equal(fs.existsSync(dir), false, '没有建空文件夹');
});
