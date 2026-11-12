'use strict';
// 「个人」页内核：经验与等级、每日上限、连续天数、成就、历史回溯、认人、IPC 计分。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../core/profile/rules');
const { Profile } = require('../core/profile/service');
const identity = require('../core/profile/identity');
const { installProfileTap, readHistory } = require('../main/profile-controller');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-profile-'));
function make(start = '2026-11-02T10:00:00') {
  const clock = { at: new Date(start) };
  const profile = new Profile({ dataDir: tmp(), now: () => new Date(clock.at), saveDelayMs: 0 });
  return { profile, clock, setDay: (iso) => { clock.at = new Date(iso); } };
}

test('等级曲线：经验越多等级越高，边界正好升级', () => {
  assert.equal(R.levelOf(0), 1);
  assert.equal(R.levelOf(99), 1);
  assert.equal(R.levelOf(100), 2);
  assert.equal(R.levelOf(R.xpForLevel(10)), 10);
  assert.equal(R.levelOf(R.xpForLevel(10) - 1), 9);
  assert.equal(R.levelOf(1e9), R.MAX_LEVEL);
  assert.equal(R.rankOf(1).n, 1);
  assert.equal(R.rankOf(12).name, '熟练驾驭者');
  assert.equal(R.rankOf(60).n, 8);
});

test('每天打开给一次经验；消息有每日上限，刷不出更多', () => {
  const { profile } = make();
  const first = profile.record('open');
  assert.equal(first, 20 + 5);           // 打开 20 + 连续第 1 天 5
  assert.equal(profile.record('open'), 0);
  for (let i = 0; i < 100; i++) profile.record('prompt');
  const day = profile.state.days['2026-11-02'];
  assert.equal(day.p, 100);
  // 消息经验封顶 60 条 ×4；另有首次用「会话对话」40 + 当天功能 15。
  const stats = profile.stats();
  assert.equal(stats.prompts, 100);
  assert.ok(profile.state.unlocked['first-chat'], '第一条消息解锁初次启程');
  assert.ok(profile.state.unlocked['chat-100']);
  assert.ok(profile.state.unlocked['marathon'], '一天 50 条解锁高频使用');
  const expected = 25 + 60 * 4 + 40 + 15 + 50 + 50 + 120;
  assert.equal(profile.state.xp, expected);
});

test('连续天数：隔一天就断，最长记录保留', () => {
  const { profile, setDay } = make('2026-11-02T10:00:00');
  profile.record('open');
  setDay('2026-11-03T10:00:00'); profile.record('open');
  setDay('2026-11-04T10:00:00'); profile.record('open');
  assert.equal(profile.streak(), 3);
  assert.ok(profile.state.unlocked['streak-3']);
  setDay('2026-11-06T10:00:00');
  assert.equal(profile.streak(), 0);
  profile.record('open');
  assert.equal(profile.streak(), 1);
  assert.equal(profile.stats().bestStreak, 3);
});

test('升级与成就各发一次事件；功能首次使用有奖励', () => {
  const { profile } = make();
  const events = [];
  profile.on('level-up', e => events.push(['level', e.from, e.to]));
  profile.on('achievement', e => events.push(['ach', ...e.list.map(a => a.id)]));
  profile.registerFeature('forum');
  profile.record('feature', { id: 'forum' });   // 25 + 40 + 15 = 80
  assert.equal(profile.state.xp, 80);
  profile.record('prompt');                       // +4 +40 +15 +成就 50 → 189
  assert.deepEqual(events, [['ach', 'first-chat'], ['level', 1, 2]]);
  profile.record('feature', { id: 'not-a-feature' });
  assert.equal(profile.stats().featuresUsed, 2);
});

test('没接上的功能不显示对应成就，也不算进功能总数', () => {
  const { profile } = make();
  const ids = profile.snapshot().achievements.map(a => a.id);
  assert.ok(!ids.includes('rooms-1'));
  assert.ok(ids.includes('first-chat'));
  profile.registerFeature('rooms');
  assert.ok(profile.snapshot().achievements.some(a => a.id === 'rooms-1'));
  assert.equal(profile.snapshot().stats.featuresAvail, 2);
});

test('历史回溯：补记以前的活跃日，只做一次，不发庆祝', () => {
  const { profile } = make('2026-11-12T10:00:00');
  let fired = 0; profile.on('achievement', () => fired++); profile.on('level-up', () => fired++);
  const days = []; for (let d = 1; d <= 11; d++) days.push(`2026-11-${String(d).padStart(2, '0')}`);
  const r = profile.backfill({ activeDays: [...days, '2026-11-12', 'bad'], sessionDays: { '2026-11-05': 30 } });
  assert.equal(r.days, 11);
  assert.equal(profile.state.xp >= 11 * 150 + 60, true);
  assert.equal(fired, 0);
  assert.equal(profile.state.firstDay, '2026-11-01');
  assert.ok(profile.state.unlocked['streak-7']);
  assert.equal(profile.stats().maxDaySessions, 0, '回溯的日子不算单日纪录');
  const again = profile.backfill({ activeDays: ['2026-10-01'] });
  assert.equal(again.days, 11);
  assert.equal(profile.streak(), 12, '回溯入账的成就经验记在今天，今天也算活跃');
});

test('存盘后重开数据还在；快照字段齐全', () => {
  const { profile } = make();
  profile.record('prompt'); profile.record('pet'); profile.setNickname('  小北  ');
  const again = new Profile({ dataDir: path.dirname(profile.dir), saveDelayMs: 0 });
  assert.equal(again.state.xp, profile.state.xp);
  const snap = again.snapshot();
  assert.equal(snap.identity.display, '小北');
  assert.equal(snap.pet.pets, 1);
  assert.equal(snap.heat.length % 1, 0);
  assert.ok(snap.heat.length >= 78 && snap.heat.length <= 84);
  assert.ok(snap.ceil > snap.floor);
  assert.equal(snap.pet.perks.filter(p => p.unlocked).length, 1);
  assert.equal(again.brief().name, '小北');
});

test('认人：WeLink 拿到中文名、工号、部门；拿不到时退到本机信息', async () => {
  const calls = [];
  const welink = async args => {
    calls.push(args.join(' '));
    if (args[0] === 'onebox') return { stdout: JSON.stringify({ accountId: 1, name: '用户甲', loginName: 'u00012345', email: 'user001@example.com' }) };
    // 真机的形状：结果在 search_cli_person.data 里，工号带前导 0
    if (args[0] === 'search') return { stdout: JSON.stringify({ search_cli_person: { data: [{ chineseName: '同事乙', employeeNumber: '00099999', deptName: '别的部门' }, { chineseName: '用户甲', englishName: 'User A', employeeNumber: '00012345', deptName: '示例部门', departmentName: '公司/示例产品线/示例部门', appointPos: '工程师' }] } }) };
    return { stdout: JSON.stringify({ code: '47111', users: [] }) };
  };
  const local = identity.localIdentity({ assistantSettings: () => ({}), codeAccount: () => 'a001', gitName: () => '', osName: () => 'pcuser' });
  assert.equal(local.name, 'a001');
  const got = await identity.resolveIdentity({ cached: null, local, welink, now: 1000 });
  assert.deepEqual([got.name, got.workId, got.dept, got.title, got.uid, got.from], ['用户甲', '00012345', '示例部门', '工程师', 'u00012345', 'welink']);
  assert.deepEqual(calls, ['onebox user-info', 'search person --text u00012345'], '按账号一次搜到就不再多问');
  // 按账号搜不到时：联系人详情补姓名和工号，再按姓名搜部门（只有一个同名的才认）
  const calls2 = [];
  const welink2 = async args => {
    calls2.push(args[0]);
    if (args[0] === 'onebox') return { stdout: JSON.stringify({ name: '用户甲', loginName: 'user001' }) };
    if (args[0] === 'contact') return { stdout: JSON.stringify({ code: '0', users: [{ w3Account: 'user001', personAccount: 'user001', chineseName: '用户甲', workId: '00000001' }] }) };
    if (args[3] === 'user001') return { stdout: JSON.stringify({ search_cli_person: { data: [] } }) };
    return { stdout: JSON.stringify({ data: [{ chineseName: '用户甲', employeeNumber: '00000001', deptName: '示例部门' }, { chineseName: '用户甲乙', deptName: '别的部门' }] }) };
  };
  const got2 = await identity.resolveIdentity({ cached: null, local, welink: welink2, now: 1000 });
  assert.deepEqual([got2.name, got2.workId, got2.dept], ['用户甲', '00000001', '示例部门']);
  assert.deepEqual(calls2, ['onebox', 'search', 'contact', 'search']);
  // 7 天内不再问
  await identity.resolveIdentity({ cached: got, local, welink, now: 2000 });
  assert.equal(calls.length, 2);
  // WeLink 不可用：用本机信息，30 分钟内不重试
  const down = async () => { throw new Error('没装'); };
  const fallback = await identity.resolveIdentity({ cached: null, local, welink: down, now: 5000 });
  assert.equal(fallback.name, 'a001');
  assert.equal(fallback.triedAt, 5000);
  const sys = identity.localIdentity({ assistantSettings: () => { throw new Error('x'); }, codeAccount: () => '', gitName: () => '', osName: () => 'pcuser' });
  assert.equal(sys.name, 'pcuser');
});

test('IPC 计分：只给登记过的入口套一层，原处理照常执行', async () => {
  const registered = {};
  const ipcMain = { handle: (channel, fn) => { registered[channel] = fn; } };
  let clock = 1000;
  const tap = installProfileTap(ipcMain, { now: () => clock });
  ipcMain.handle('session:send-prompt', async (_e, req) => 'sent:' + req.text);
  ipcMain.handle('company-forum:ensure-today', () => 'forum');
  ipcMain.handle('other:thing', () => 'plain');
  const { profile } = make();
  tap.bind(profile);
  assert.equal(await registered['session:send-prompt']({}, { text: 'hi', codeagentSkill: 'x' }), 'sent:hi');
  assert.equal(registered['company-forum:ensure-today']({}), 'forum');
  // 页面开着时会反复读状态：5 分钟内只算一次
  registered['company-forum:ensure-today']({}); clock += 6 * 60000; registered['company-forum:ensure-today']({});
  assert.equal(registered['other:thing']({}), 'plain');
  const stats = profile.stats();
  assert.equal(stats.prompts, 1);
  assert.deepEqual(Object.keys(stats.features).sort(), ['chat', 'forum', 'skill']);
  assert.ok(profile.available.has('forum'));
  assert.equal(stats.features.forum, 2);
});

test('历史用量：从 Token 账本和会话文件读出活跃日', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'token-usage-ledger.json'), JSON.stringify({ days: { '2026-11-01': [['p', 'm', 'a', 100, 9999, 20, 30]], '2026-11-02': [['p', 'm', 'a', 0, 5, 0, 0]] } }));
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions', 'a.json'), '{}');
  const h = readHistory(dir, d => d.toISOString().slice(0, 10));
  assert.deepEqual(h.activeDays, ['2026-11-01']);
  assert.equal(h.tokens, 150);
  assert.equal(Object.values(h.sessionDays)[0], 1);
});
