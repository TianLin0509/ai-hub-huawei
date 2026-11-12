'use strict';
// 「个人」页换模型审查（2026-11-12）抓到的问题，逐条回归：多窗口互相覆盖、失败操作也计分、认错人、
// 账本晚到漏补、当天已有会话漏计、卡片徽章没传到。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Profile } = require('../core/profile/service');
const identity = require('../core/profile/identity');
const { installProfileTap } = require('../main/profile-controller');
const { SpeechQueue } = require('../core/hub-pet/state');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-profile-rv-'));
const at = iso => () => new Date(iso);

test('两个 Hub 窗口共用数据：各自的经验、摸摸、称呼都留下，不互相覆盖', () => {
  const dir = tmp(), now = at('2026-11-12T10:00:00');
  const a = new Profile({ dataDir: dir, now, saveDelayMs: 1e9 });
  const b = new Profile({ dataDir: dir, now, saveDelayMs: 1e9 });
  a.record('prompt'); a.record('prompt'); a.save();
  b.record('pet'); b.setNickname('小北'); b.save();
  a.record('prompt'); a.save();
  const fresh = new Profile({ dataDir: dir, now });
  const s = fresh.stats();
  assert.equal(s.prompts, 3);
  assert.equal(s.petPets, 1);
  assert.equal(fresh.state.nickname, '小北');
  assert.equal(fresh.state.xp, Object.values(fresh.state.days).reduce((n, d) => n + d.xp, 0), '总经验等于各天之和');
  // 两边都解锁了「初次启程」这类成就时经验只算一次：a 解锁 first-chat，b 也发一条
  const c = new Profile({ dataDir: tmp(), now, saveDelayMs: 1e9 }), d = new Profile({ dataDir: path.dirname(c.dir), now, saveDelayMs: 1e9 });
  c.record('prompt'); d.record('prompt'); c.save(); d.save();
  const both = new Profile({ dataDir: path.dirname(c.dir), now });
  // 每个窗口：打开 25 + 消息 4 + 首次功能 40 + 当天功能 15 + 成就 50 = 134；合并后成就只留一份
  assert.equal(both.state.xp, 134 * 2 - 50);
  assert.equal(both.stats().prompts, 2);
});

test('操作成功了才计分：没发出去的消息、拒绝组队、只是查看会议室状态都不算', async () => {
  const registered = {};
  const ipcMain = { handle: (channel, fn) => { registered[channel] = fn; } };
  const tap = installProfileTap(ipcMain);
  ipcMain.handle('session:send-prompt', async (_e, req) => (req.fail ? { ok: false, notSent: true } : { ok: true }));
  ipcMain.handle('team:decide', (_e, req) => ({ ok: true, approved: req.approve }));
  ipcMain.handle('company-assistant:room-command', (_e, req) => ({ ok: true, op: req.op }));
  ipcMain.handle('ask-aside:ask', () => { throw new Error('没有会话'); });
  const profile = new Profile({ dataDir: tmp(), now: at('2026-11-12T10:00:00'), saveDelayMs: 0 });
  for (const id of ['team', 'rooms', 'aside']) profile.registerFeature(id);
  tap.bind(profile);
  assert.deepEqual(await registered['session:send-prompt']({}, { fail: true }), { ok: false, notSent: true });
  await Promise.resolve();
  assert.equal(profile.stats().prompts, 0);
  await registered['session:send-prompt']({}, {});
  await Promise.resolve();
  assert.equal(profile.stats().prompts, 1);
  registered['team:decide']({}, { approve: false });
  registered['company-assistant:room-command']({}, { op: 'status' });
  assert.throws(() => registered['ask-aside:ask']({}), /没有会话/);
  assert.deepEqual(Object.keys(profile.stats().features), ['chat']);
  registered['team:decide']({}, { approve: true });
  registered['company-assistant:room-command']({}, { op: 'start' });
  assert.deepEqual(Object.keys(profile.stats().features).sort(), ['chat', 'rooms', 'team']);
});

test('认人：只搜到一个人但工号对不上，不认；保留登录账号自己的姓名', async () => {
  const welink = async args => {
    if (args[0] === 'onebox') return { stdout: JSON.stringify({ name: '用户甲', loginName: 'u00012345' }) };
    if (args[0] === 'search') return { stdout: JSON.stringify({ search_cli_person: { data: [{ chineseName: '别人', employeeNumber: '99999', deptName: '别的部门' }] } }) };
    return { stdout: '{}' };
  };
  const got = await identity.resolveIdentity({ cached: null, local: { name: 'pc', workId: '' }, welink, now: 1 });
  assert.equal(got.name, '用户甲');
  assert.equal(got.dept, '');
  assert.equal(got.uid, 'u00012345');
});

test('历史回溯：先按会话文件补，Token 账本晚到再补一次；当天启动前已建的会话进基数', () => {
  const p = new Profile({ dataDir: tmp(), now: at('2026-11-12T10:00:00'), saveDelayMs: 0 });
  p.backfill({ sessionDays: { '2026-11-10': 2, '2026-11-12': 5 }, ledger: false });
  assert.equal(p.stats().activeDays, 2);
  assert.equal(p.stats().sessions, 7, '今天已有的 5 个会话补进基数');
  const xp = p.state.xp;
  p.backfill({ sessionDays: { '2026-11-09': 1 }, ledger: false });
  assert.equal(p.state.xp, xp, '没有账本时不重复回溯');
  p.backfill({ activeDays: ['2026-11-08', '2026-11-09', '2026-11-10'], sessionDays: { '2026-11-12': 5 }, ledger: true });
  assert.equal(p.stats().activeDays, 4);
  assert.equal(p.stats().sessions, 7);
  assert.equal(p.state.backfill.ledger, true);
  const again = p.state.xp;
  p.backfill({ activeDays: ['2026-11-01'], ledger: true });
  assert.equal(p.state.xp, again, '账本补过后不再补');
});

test('成长卡片的徽章字段从入队带到渲染端；不合规的丢掉', () => {
  const q = new SpeechQueue({ now: () => 1000 });
  q.push({ id: 'g1', kind: 'growth', notify: true, title: '升到 Lv.5', text: 'x', art: 'rank-2' });
  q.tick(() => ({ ok: true }));
  assert.equal(q.snapshot().bubble.art, 'rank-2');
  const q2 = new SpeechQueue({ now: () => 1000 });
  q2.push({ id: 'g2', kind: 'growth', notify: true, title: 't', art: '../x' });
  q2.tick(() => ({ ok: true }));
  assert.equal(q2.snapshot().bubble.art, undefined);
});
