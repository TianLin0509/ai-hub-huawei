'use strict';
// 「我的反馈」（2026-11-19 用户体验第 9 项）：本机记下自己提交过的反馈——已送达（收件编号）/ 排队中（原因）/ 已放弃，
// 更新日志引用了收件编号就标「已修于」。只存摘要与状态，不存诊断包正文。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHubFeedbackService } = require('../main/hub-feedback-service');

function fixture(t, { intranet, now } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-mine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let n = 0;
  const svc = createHubFeedbackService({
    edition: 'member', endpoint: 'https://me.example.invalid/x', info: () => ({ version: '5.6.62', edition: '测试', platform: 'test' }),
    logsDir: path.join(root, 'logs'), downloadsDir: () => path.join(root, 'downloads'), logger: { warn() {} }, ...(now ? { now } : {}),
    fetchImpl: async () => { throw new Error('成员版不走阿里云'); },
    receiverAddress: { resolve: async () => ({ urls: ['http://10.20.30.40:18767'] }) },
    intranetFetch: async (url, init) => intranet(url, init, ++n),
  });
  return { root, svc };
}
const ok = id => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, id }) });
const down = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };

test('delivered and queued submissions are listed newest first with receipt id or reason; body text is not stored', async t => {
  let clock = Date.parse('2026-11-19T10:00:00Z');
  let up = true;
  const f = fixture(t, { now: () => clock, intranet: (url, init) => (up ? ok('20261119T100000Z-1a2b3c4d') : down()) });
  await f.svc.send({ description: '会话卡住了\n后面还有很多细节' });
  clock += 60000; up = false;
  await f.svc.send({ description: '模型下拉只显示 5 个' });
  const r = f.svc.mine({ page: 1, pageSize: 10 });
  assert.equal(r.total, 2);
  assert.deepEqual(r.items.map(x => [x.summary, x.status]), [['模型下拉只显示 5 个', 'queued'], ['会话卡住了', 'delivered']]);
  assert.equal(r.items[1].receiptId, '20261119T100000Z-1a2b3c4d');
  assert.match(r.items[0].reason, /没有在监听/);
  assert.deepEqual(r.counts, { delivered: 1, queued: 1, fixed: 0 });
  const raw = fs.readFileSync(path.join(f.root, 'hub-feedback-history.json'), 'utf8');
  assert.doesNotMatch(raw, /后面还有很多细节|版本与系统信息/, '只存第一行摘要，不存正文和诊断包');
});

test('a queued item flips to delivered after the outbox is resent, keeping the same entry', async t => {
  let up = false;
  const f = fixture(t, { intranet: () => (up ? ok('20261119T110000Z-99aa88bb') : down()) });
  await f.svc.send({ description: '排队的那条' });
  assert.equal(f.svc.mine().items[0].status, 'queued');
  up = true;
  const res = await f.svc.flushOutbox();
  assert.equal(res.sent, 1);
  const r = f.svc.mine();
  assert.equal(r.total, 1);
  assert.equal(r.items[0].status, 'delivered');
  assert.equal(r.items[0].receiptId, '20261119T110000Z-99aa88bb');
  assert.equal(r.items[0].reason, '');
});

test('outbox items from before this feature still show up as queued', async t => {
  const f = fixture(t, { intranet: down });
  const dir = path.join(f.root, 'hub-feedback-outbox'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '20261118T104500123Z-01abcd.json'), JSON.stringify({ queuedAt: Date.parse('2026-11-18T10:45:00Z'), lastError: '还没拿到维护人电脑的地址', body: { summary: '旧版排队的反馈', text: 'x' } }));
  const r = f.svc.mine();
  assert.equal(r.total, 1);
  assert.equal(r.items[0].status, 'queued');
  assert.equal(r.items[0].summary, '旧版排队的反馈');
  assert.match(r.items[0].reason, /还没拿到/);
});

test('fixedIn: release notes citing the full receipt id or its 8-hex tail mark it fixed in the earliest such version', t => {
  const f = fixture(t, { intranet: down });
  const history = [
    { version: '5.6.70', notes: ['修复：模型下拉（反馈 1a2b3c4d）'] },
    { version: '5.6.65', notes: ['修复会话卡住 20261119T100000Z-1a2b3c4d'] },
    { version: '5.6.60', notes: ['无关 21a2b3c4d9'] },
  ];
  assert.equal(f.svc.fixedInFor('20261119T100000Z-1a2b3c4d', history), '5.6.65');
  assert.equal(f.svc.fixedInFor('20261119T100000Z-ffffffff', history), '');
  assert.equal(f.svc.fixedInFor('', history), '');
});

test('pages follow the requested size', async t => {
  let clock = 1;
  const f = fixture(t, { now: () => ++clock, intranet: (u, i, n) => ok(`20261119T1200${String(n).padStart(2, '0')}Z-0000000${n % 10}`) });
  for (let i = 0; i < 5; i++) await f.svc.send({ description: '第' + i + '条' });
  const p2 = f.svc.mine({ page: 2, pageSize: 2 });
  assert.equal(p2.total, 5); assert.equal(p2.page, 2); assert.equal(p2.items.length, 2);
  assert.equal(f.svc.mine({ page: 9, pageSize: 2 }).page, 3);
});
