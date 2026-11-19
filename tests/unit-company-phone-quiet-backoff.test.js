'use strict';
// 2026-11-20 运行时风暴排查：手机对话群安静久了放慢查新消息，有新消息或 Hub 发话后立刻回到 6 秒。
const test = require('node:test');
const assert = require('node:assert/strict');
const { PhoneChannel, POLL_MS } = require('../core/company-assistant/phone');

function fixture() {
  let now = 1_000_000, messages = [];
  const files = {}, queries = [];
  const a = { now: () => now, snapshot: () => ({ login: { ok: true, uid: 'me01' } }),
    settings: () => ({ phone: { enabled: true, groupId: '123', since: 0 } }),
    read: (n, f) => files[n] ?? f, write: (n, v) => { files[n] = v; }, changed() {},
    ask: () => ({ id: String(queries.length) }),
    welink: async args => { if (args[1] === 'query-history-message') queries.push(now); return { code: 0, stdout: JSON.stringify({ chatInfo: messages }), stderr: '' }; } };
  const phone = new PhoneChannel(a, { noTimer: true });
  return { phone, queries, tick: async ms => { for (let t = 0; t < ms; t += POLL_MS) { now += POLL_MS; await phone.poll(); } },
    say: () => { messages = [...messages, { msgId: String(messages.length + 1), sender: 'me01', content: 'hi', contentType: 'TEXT', serverSendTime: now }]; } };
}

test('前 10 分钟照 6 秒查；安静 30 分钟后约 30 秒一查；来了新消息马上回到 6 秒', async () => {
  const f = fixture();
  await f.tick(10 * 60000);
  const first = f.queries.length;
  assert.ok(first >= 95, `前 10 分钟 ${first} 次`);
  await f.tick(60 * 60000);
  const hour = f.queries.length - first;
  assert.ok(hour <= 200, `之后 1 小时 ${hour} 次（改前 600 次）`);
  f.say();
  await f.tick(31 * 60000 > 0 ? 30000 : 0); // 等到下一次慢查询看到新消息
  const before = f.queries.length;
  await f.tick(60000);
  assert.ok(f.queries.length - before >= 9, '有新消息后回到 6 秒');
});
