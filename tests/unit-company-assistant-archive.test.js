'use strict';
// WeLink 长期档案与人物卡材料：全部用合成会话，不含真实 WeLink 数据或账号。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WelinkArchive, archiveTextOf } = require('../core/company-assistant/archive');

const ME = 'me001', PEER = 'peer01', OTHER = 'other9';
const T0 = Date.parse('2026-11-10T09:00:00+08:00');

// 假 WeLink：不带 --message-id 回最新 100 条；带 --message-id + --query-direction 0 回比它旧的 100 条。
function fakeWelink(world) {
  const calls = [];
  const run = async args => {
    calls.push(args.join(' '));
    if (args[0] === 'im' && args[1] === 'query-recent-conversation') {
      return { code: 0, stderr: '', stdout: JSON.stringify({ resultCode: 0, respData: { conversation_info: world.recent.map(c => c.group
        ? { recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', group_id: c.id, group_name: c.name }
        : { recent_conversation_type: 'CHAT_TYPE_P2P_MSG', target_account: c.id, native_name: c.name }) } }) };
    }
    if (args[0] === 'im' && args[1] === 'query-history-message') {
      const id = args[3], list = (world.msgs[id] || []).slice().sort((a, b) => a.msgId - b.msgId);
      const i = args.indexOf('--message-id');
      const pool = i > 0 ? list.filter(m => m.msgId < Number(args[i + 1])) : list;
      const page = pool.slice(-100);
      return { code: 0, stderr: '', stdout: JSON.stringify({ resultCode: 0, respData: { chatInfo: page.map(m => ({ ...m, msgId: String(m.msgId) })) } }) };
    }
    if (args[0] === 'contact' && args[1] === 'detail') return { code: 0, stderr: '', stdout: JSON.stringify({ code: '0', users: args.slice(2).map(a => ({ w3Account: a, chineseName: a === OTHER ? '王五' : '某人' })) }) };
    throw new Error('unexpected ' + args.join(' '));
  };
  return { run, calls };
}
function msgs(from, count, { sender = PEER, start = T0, step = 60000, text = i => '消息' + i, at = () => [] } = {}) {
  return Array.from({ length: count }, (_, k) => ({ msgId: from + k, sender: typeof sender === 'function' ? sender(k) : sender, content: text(k), contentType: 'TEXT_MSG', serverSendTime: start + k * step, atAccountList: at(k) }));
}
function setup(now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-archive-'));
  const clock = { now };
  const world = { recent: [{ id: PEER, name: '张三', group: false }, { id: 'g1', name: '项目群', group: true }], msgs: {} };
  const fake = fakeWelink(world);
  const assistant = { dir, now: () => clock.now, auth: { status: () => ({ state: 'online', login: { ok: true, uid: ME } }) }, settings: () => ({}), changed() {} };
  const archive = new WelinkArchive(assistant, { run: fake.run, now: () => clock.now });
  return { dir, clock, world, fake, assistant, archive };
}

test('第一次补档翻完全部历史，第二次只取新消息，账号和姓名都存下', async () => {
  const { clock, world, fake, archive } = setup(T0 + 3 * 86400000);
  world.msgs[PEER] = msgs(1000, 250, { sender: k => (k % 2 ? ME : PEER) });
  world.msgs.g1 = msgs(5000, 30, { sender: k => (k === 3 ? PEER : OTHER), at: k => (k === 5 ? [PEER] : []) });
  const first = await archive.start();
  assert.equal(first.ok, true, first.error);
  const st = archive.status(ME);
  assert.equal(st.messages, 280);
  assert.equal(st.backfillPending, 0);
  assert.equal(fake.calls.filter(c => c.includes(PEER) && c.includes('query-history')).length, 3); // 100 + 100 + 50
  world.msgs[PEER].push(...msgs(2000, 12, { start: T0 + 2 * 86400000 }));
  fake.calls.length = 0; clock.now += 86400000;
  const second = await archive.start();
  assert.equal(second.added, 12);
  assert.equal(fake.calls.filter(c => c.includes('query-history')).length, 2); // 每个会话一页就接上
  assert.equal(archive.read(ME, PEER).length, 262);
  const idx = archive.loadIndex(ME);
  assert.equal(idx.names[PEER], '张三');
  assert.equal(idx.names[OTHER], '王五');
});

test('掉出最近 100 个会话的会话照样接着存', async () => {
  const { world, archive } = setup(T0 + 86400000);
  world.msgs[PEER] = msgs(1, 5); world.msgs.g1 = msgs(100, 5);
  await archive.start();
  world.recent = [{ id: 'g1', name: '项目群', group: true }];
  world.msgs[PEER].push(...msgs(50, 3, { start: T0 + 3600000 }));
  const r = await archive.start();
  assert.equal(r.added, 3);
});

test('人物材料：私聊和群里相关的消息都在，超长时两边各自截尾', async () => {
  const { world, archive } = setup(T0 + 86400000);
  world.msgs[PEER] = msgs(1, 300, { sender: k => (k % 2 ? ME : PEER), text: k => '私聊内容'.repeat(10) + k });
  world.msgs.g1 = msgs(1000, 300, { sender: k => (k % 3 ? OTHER : PEER), text: k => '群里讨论'.repeat(10) + k });
  await archive.start();
  const m = archive.personMaterial(ME, { account: PEER, name: '张三', days: 60, maxChars: 8000 });
  assert.ok(m.stats.private === 300 && m.stats.privateKept > 0 && m.stats.privateKept < 300);
  assert.match(m.text, /## 私聊（300 条，较长，只保留最近 \d+ 条）/);
  assert.match(m.text, /## 群「项目群」/);
  assert.match(m.text, /私聊内容{0,1}.*299/); // 最新一条私聊保留
  assert.ok(m.text.length < 8000 + 400);
});

test('非文字消息留下可检索的字：文件名、卡片标题', () => {
  assert.equal(archiveTextOf({ contentType: 'FILE_MSG', content: JSON.stringify({ fileName: '周报.pptx' }) }, {}), '[文件] 周报.pptx');
  assert.equal(archiveTextOf({ contentType: 'CARD_MSG', content: JSON.stringify({ title: '评审通知' }) }, {}), '[卡片] 评审通知');
  assert.equal(archiveTextOf({ contentType: 'IMAGE_MSG', content: '' }, { text: '' }), '[图片]');
});

test('自动补档只在夜里或周末起跑，一个归档日只跑一次', async () => {
  const { clock, world, archive } = setup(Date.parse('2026-11-11T15:00:00+08:00')); // 周三白天
  world.msgs[PEER] = msgs(1, 3); world.msgs.g1 = [];
  assert.equal(archive.maybeRun(), false);
  clock.now = Date.parse('2026-11-11T23:20:00+08:00');
  assert.equal(archive.maybeRun(), true);
  await archive.job.promise;
  clock.now = Date.parse('2026-11-12T01:00:00+08:00');
  assert.equal(archive.maybeRun(), false); // 同一归档日
  clock.now = Date.parse('2026-11-12T23:15:00+08:00');
  assert.equal(archive.maybeRun(), true);
  await archive.job.promise;
});

test('welink_history：按人、按关键词检索，人名对不上时不猜', async () => {
  const { world, archive } = setup(T0 + 86400000);
  world.msgs[PEER] = msgs(1, 10, { text: k => (k === 4 ? 'MSG 交付延期' : '日常') });
  world.msgs.g1 = msgs(100, 10, { sender: OTHER, text: k => (k === 2 ? 'MSG 评审定在周五' : '其他') });
  await archive.start();
  const hit = archive.tool({ keyword: 'MSG', days: 30 });
  assert.equal(hit.ok, true); assert.equal(hit.total, 2);
  const byPerson = archive.tool({ person: '张三', days: 30 });
  assert.equal(byPerson.total, 10);
  assert.equal(archive.tool({ person: '李四' }).ok, false);
});

test('增量翻页中途失败：水位不前进，下次补齐中间缺口，本归档日 30 分钟后重试', async () => {
  const { clock, world, fake, archive } = setup(T0 + 86400000);
  world.msgs[PEER] = msgs(1, 50); world.msgs.g1 = [];
  await archive.start();
  world.msgs[PEER].push(...msgs(1000, 250, { start: T0 + 3600000 })); // 3 页新消息
  let n = 0; const run = fake.run;
  archive.run = async args => { if (args.includes('query-history-message') && args.includes(PEER) && args.includes('--message-id') && ++n === 1) return { code: 1, stdout: '', stderr: 'boom' }; return run(args); };
  const bad = await archive.start();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /1 个会话没取全，30 分钟后重试/);
  assert.notEqual(archive.loadIndex(ME).lastDay, archive.archiveDay(clock.now));
  archive.run = run;
  const good = await archive.start();
  assert.equal(good.ok, true);
  assert.equal(archive.read(ME, PEER).length, 300);
});

test('一晚上新消息超过 80 页：记断点，下次从断点接上，不留缺口', async () => {
  const { world, archive } = setup(T0 + 86400000);
  world.msgs[PEER] = msgs(1, 10); world.msgs.g1 = [];
  await archive.start();
  world.msgs[PEER].push(...msgs(100000, 8150, { start: T0 + 3600000, step: 1000 }));
  const first = await archive.start();
  assert.equal(first.ok, false);
  assert.ok(archive.loadIndex(ME).convs[PEER].resume);
  world.msgs[PEER].push(...msgs(900000, 5, { start: T0 + 5 * 3600000 }));
  const second = await archive.start();
  assert.equal(second.ok, true, second.error);
  assert.equal(archive.read(ME, PEER).length, 10 + 8150 + 5);
  assert.equal(archive.loadIndex(ME).convs[PEER].resume, undefined);
});

test('群聊材料跨群按时间挑最近的，排在前面的群不会挤掉别的群的新消息', async () => {
  const { world, archive } = setup(T0 + 86400000);
  world.recent = [{ id: PEER, name: '张三', group: false }, { id: 'gOld', name: '老群', group: true }, { id: 'gNew', name: '新群', group: true }];
  world.msgs[PEER] = [];
  world.msgs.gOld = msgs(1, 200, { start: T0 - 20 * 86400000, text: k => '旧群发言'.repeat(8) + k });
  world.msgs.gNew = msgs(5000, 3, { start: T0 + 3600000, text: k => '今天的新进展' + k });
  await archive.start();
  const m = archive.personMaterial(ME, { account: PEER, name: '张三', days: 60, maxChars: 3000 });
  assert.match(m.text, /## 群「新群」（相关 3 条）/);
  assert.match(m.text, /今天的新进展2/);
  assert.match(m.text, /## 群「老群」（相关 200 条，下面只是最近的 \d+ 条）/);
});


test('存档前抹掉明文凭据，会议链接和普通文字不受影响', () => {
  const { scrub } = require('../core/company-assistant/archive');
  const fake = 'sk-' + 'ant-sid02-' + 'A'.repeat(30);
  assert.equal(scrub('key ' + fake + ' end'), 'key [已隐去:密钥] end');
  assert.equal(scrub('a.b@example.com----pw123----c@example.org'), '[已隐去:账号密码]');
  assert.equal(scrub('2fa ' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' + ' ok'), '2fa [已隐去:2FA] ok');
  assert.equal(scrub('密码：abcdef12'), '密码：[已隐去]');
  assert.equal(scrub('MSG 交付 id=98048979&token=98048979'), 'MSG 交付 id=98048979&token=98048979');
});
