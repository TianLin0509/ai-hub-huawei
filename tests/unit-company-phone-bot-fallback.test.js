'use strict';
// 私聊助理离线回落（2026-11-27）：选了私聊助理、它离线超过 2 分钟、且配过专用群 → 临时改回群轮询（60 秒一次），
// 切换时往群里推一行；私聊助理恢复就停。回落期间群里问的回群里，私聊里问的仍只回私聊。没配过群的不回落。
const test = require('node:test');
const assert = require('node:assert/strict');
const { PhoneChannel, POLL_MS } = require('../core/company-assistant/phone');
const F = require('../core/welink-native/fallback');

function fixture({ groupId = '123', transport = 'bot' } = {}) {
  let now = 1_800_000_000_000, messages = [], phase = 'ready';
  const files = {}, queries = [], sent = [], botSent = [];
  const a = { now: () => now, snapshot: () => ({ login: { ok: true, uid: 'me01' } }),
    settings: () => ({ phone: { enabled: true, transport, groupId, since: 0 } }),
    read: (n, f) => files[n] ?? f, write: (n, v) => { files[n] = v; }, changed() {},
    ask: text => ({ id: 'q' + text }),
    bot: { hasCred: () => true, status: () => ({ phase, talked: true }), reply: (_e, body) => { if (phase !== 'ready') return false; botSent.push(body); return true; }, state: () => ({ routes: {} }) },
    welink: async args => {
      if (args[1] === 'query-history-message') { queries.push(now); return { code: 0, stdout: JSON.stringify({ chatInfo: messages }), stderr: '' }; }
      if (args[1] === 'send-to-group') { sent.push({ group: args[3], text: args[5] }); return { code: 0, stdout: '{"code":"0"}', stderr: '' }; }
      return { code: 0, stdout: '', stderr: '' };
    } };
  const phone = new PhoneChannel(a, { noTimer: true });
  const run = async ms => { for (let t = 0; t < ms; t += POLL_MS) { now += POLL_MS; await phone.poll(); } await phone.outbox; };
  return { phone, a, queries, sent, botSent, run, setPhase: p => { phase = p; },
    say: text => { messages = [...messages, { msgId: String(messages.length + 1), sender: 'me01', content: text, contentType: 'TEXT', serverSendTime: now }]; } };
}

test('私聊助理在线：群一次都不查', async () => {
  const f = fixture();
  await f.run(10 * 60000);
  assert.equal(f.queries.length, 0);
  assert.equal(f.phone.status().channel, 'bot');
});

test('离线不到 2 分钟不回落；超过 2 分钟改群轮询 60 秒一次，并推一行；恢复后停查并推「已恢复」', async () => {
  const f = fixture();
  f.setPhase('connecting');
  await f.run(90000);
  assert.equal(f.queries.length, 0, '2 分钟内只算抖动');
  await f.run(60000);
  assert.equal(f.phone.status().channel, 'group-fallback');
  assert.ok(f.sent.some(s => s.group === '123' && s.text.includes(F.OFFLINE_TEXT)));
  const start = f.queries.length;
  await f.run(10 * 60000);
  const n = f.queries.length - start;
  assert.ok(n >= 9 && n <= 11, `10 分钟查 ${n} 次（约 60 秒一次）`);
  f.setPhase('ready');
  await f.run(5 * 60000);
  assert.equal(f.queries.length - start, n, '恢复后不再查群');
  assert.equal(f.phone.status().channel, 'bot');
  assert.ok(f.sent.some(s => s.text.includes(F.RECOVERED_TEXT)));
});

test('回落期间群里问的：回答回群里；私聊里问的仍只回私聊', async () => {
  const f = fixture();
  f.setPhase('idle');
  await f.run(3 * 60000);
  f.say('现在有哪些会话');
  await f.run(60000);
  const pending = f.phone.state().pending;
  const id = Object.keys(pending)[0];
  assert.ok(id, '群里的问题交给了助理');
  assert.equal(pending[id].group, '123');
  f.phone.settle({ id, state: 'done', a: '有 3 个会话在跑' });
  await f.phone.outbox;
  assert.ok(f.sent.some(s => s.group === '123' && s.text.includes('有 3 个会话在跑')));
  assert.equal(f.botSent.length, 0);
  // 私聊里问的那条（带路由）不回落到群
  f.phone.update(cur => ({ pending: { ...cur.pending, p2: { at: 1, acked: false, entry: { tsid: 't', wsid: '' } } } }));
  const before = f.sent.length;
  f.phone.settle({ id: 'p2', state: 'done', a: '私聊的回答' });
  await f.phone.outbox;
  assert.equal(f.sent.slice(before).some(s => s.text.includes('私聊的回答')), false);
});

test('没配过专用群：私聊助理离线也不回落、不查群', async () => {
  const f = fixture({ groupId: '' });
  f.setPhase('idle');
  await f.run(10 * 60000);
  assert.equal(f.queries.length, 0);
  assert.equal(f.phone.status().channel, 'bot');
});

test('只用专用群的用户：行为不变（照旧 6 秒一查）', async () => {
  const f = fixture({ transport: 'group' });
  await f.run(60000);
  assert.ok(f.queries.length >= 9, `1 分钟 ${f.queries.length} 次`);
  assert.equal(f.phone.status().channel, 'group');
});

test('回落期间：会话答完/卡住这类提醒按当时实际通道发到群里，不往已断的私聊发', async () => {
  const f = fixture();
  f.setPhase('idle');
  await f.run(3 * 60000);
  assert.equal(f.phone.status().channel, 'group-fallback');
  await f.phone.send('「无线仿真」这一轮答完了', 'done');
  assert.ok(f.sent.some(s => s.group === '123' && s.text.includes('无线仿真')));
  assert.equal(f.botSent.length, 0);
});

test('私聊里问的回答赶上私聊助理离线：排队，恢复后按原对话补发；超过 2 小时的不再发并记一行', async () => {
  const f = fixture();
  f.setPhase('idle');
  await f.run(3 * 60000);
  f.phone.update(cur => ({ pending: { ...cur.pending, p1: { at: 1, acked: false, entry: { tsid: 't1', wsid: '' } }, p2: { at: 1, acked: false, entry: { tsid: 't2', wsid: '' } } } }));
  f.phone.settle({ id: 'p1', state: 'done', a: '旧回答' });
  await f.phone.outbox;
  assert.equal(f.phone.state().botQueue.length, 1);
  assert.equal(f.sent.some(s => s.text.includes('旧回答')), false, '私聊的回答不串到群里');
  await f.run(2 * 3600000 + 60000);                   // 过了 2 小时
  f.phone.settle({ id: 'p2', state: 'done', a: '新回答' });
  await f.phone.outbox;
  f.setPhase('ready');
  await f.run(POLL_MS);
  await f.phone.outbox;
  assert.deepEqual(f.botSent, ['新回答'], '恢复后只补发没过期的');
  assert.ok(f.phone.state().log.some(l => l.kind === 'stale' && l.text.includes('1 条超过 2 小时')));
  assert.deepEqual(f.phone.state().botQueue, []);
});

test('状态页只读：看状态不会切换通道、不会往群里推', async () => {
  const f = fixture();
  f.setPhase('idle');
  await f.run(POLL_MS);
  const sentBefore = f.sent.length;
  for (let i = 0; i < 5; i += 1) f.phone.status();
  assert.equal(f.sent.length, sentBefore);
  assert.equal(f.phone.status().channel, 'bot', '还没到 2 分钟，状态页照实说');
});

test('回落时只执行切入之后发到群里的话；查群途中私聊助理恢复，这批不执行', async () => {
  const f = fixture();
  f.setPhase('idle');
  await f.run(60000);
  f.say('回落前说的');                                   // 离线 1 分钟时发的，回落还没开始
  await f.run(70000);
  assert.equal(f.phone.status().channel, 'group-fallback');
  await f.run(70000);
  assert.equal(Object.keys(f.phone.state().pending).length, 0, '回落前发的不补执行');
  f.say('回落后说的');
  // 查群命令发出后、结果回来前恢复
  const origWelink = f.a.welink;
  f.a.welink = async args => { const r = await origWelink(args); if (args[1] === 'query-history-message') f.setPhase('ready'); return r; };
  await f.run(70000);
  assert.equal(Object.keys(f.phone.state().pending).length, 0, '通道变了，这批不执行');
});

test('恢复瞬间：私聊助理刚连上、巡检还没切回，提醒已按私聊发，不再发群', async () => {
  const f = fixture();
  f.setPhase('idle');
  await f.run(3 * 60000);
  assert.equal(f.phone.status().channel, 'group-fallback');
  f.setPhase('ready');                                  // 刚恢复，还没轮到巡检
  const before = f.sent.length;
  await f.phone.send('「写周报」这一轮答完了', 'done');
  assert.equal(f.sent.length, before, '不再发群');
  assert.deepEqual(f.botSent, ['「写周报」这一轮答完了']);
});
