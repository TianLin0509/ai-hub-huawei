'use strict';
// r42 一键反馈发送端：成员版只走内网、绝不碰阿里云；公开版按内源连通分流；发不到进待发队列、后台补发；收件地址从内源读、读不到用缓存。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHubFeedbackService } = require('../main/hub-feedback-service');
const { createReceiverAddress, cleanUrls, cacheFile } = require('../core/feedback-receiver-address');

const ALIYUN = 'https://me.example.invalid/hub-update/api/feedback/submit';

function fixture(t, { edition = 'member', urls = ['http://10.20.30.40:18767'], openxReachable = true, intranet, now } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-send-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { aliyun: [], intranet: [], unblock: 0, windowPost: 0, resolve: 0 };
  const address = { urls, openxReachable };
  const svc = createHubFeedbackService({
    edition, endpoint: ALIYUN, info: () => ({ version: '5.6.40', edition: '测试版', platform: 'test' }),
    logsDir: path.join(root, 'logs'), downloadsDir: () => path.join(root, 'downloads'), logger: { warn() {} },
    ...(now ? { now } : {}),
    fetchImpl: async url => { calls.aliyun.push(String(url)); return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"ok":true,"id":"aliyun-1"}' }; },
    unblock: async () => { calls.unblock++; return false; },
    windowPost: async () => { calls.windowPost++; return { error: 'no' }; },
    receiverAddress: { resolve: async () => { calls.resolve++; return { ...address }; } },
    intranetFetch: async (url, init) => {
      calls.intranet.push(String(url));
      if (intranet) return intranet(url, init);
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, id: '20261118T000000Z-00001abc' }) };
    },
  });
  return { root, svc, calls, address, outbox: () => fs.existsSync(path.join(root, 'hub-feedback-outbox')) ? fs.readdirSync(path.join(root, 'hub-feedback-outbox')) : [] };
}

const offline = () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; };

test('member edition sends to the intranet receiver and never touches the Aliyun address', async t => {
  const f = fixture(t);
  const r = await f.svc.send({ description: '会话卡住了' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'intranet');
  assert.deepEqual(f.calls.intranet, ['http://10.20.30.40:18767/feedback/v1/submit']);
  assert.deepEqual(f.calls.aliyun, []);
  assert.equal(f.calls.unblock + f.calls.windowPost, 0, '内网路径不做放行页自动点击');
  assert.equal(await f.svc.route(), 'intranet');
});

test('member edition: receiver offline → queued + saved to Downloads + copyable text, still no Aliyun', async t => {
  const f = fixture(t, { intranet: offline });
  const r = await f.svc.send({ description: '会话卡住了' });
  assert.equal(r.ok, false);
  assert.equal(r.queued, true);
  assert.match(r.reason, /连不上维护人电脑/);
  assert.ok(r.savedTo && fs.existsSync(r.savedTo));
  assert.match(r.text, /会话卡住了/);
  assert.equal(f.outbox().length, 1);
  assert.deepEqual(f.calls.aliyun, []);
  assert.equal(f.calls.unblock + f.calls.windowPost, 0);
  assert.equal(f.svc.preview().pending, 1);
});

test('member edition without any receiver address still queues instead of going to Aliyun', async t => {
  const f = fixture(t, { urls: [], openxReachable: false });
  const r = await f.svc.send({ description: 'x' });
  assert.equal(r.queued, true);
  assert.match(r.reason, /还没拿到维护人电脑的地址/);
  assert.deepEqual(f.calls.aliyun, []);
  assert.deepEqual(f.calls.intranet, []);
});

test('outbox is resent when the receiver comes back, and cleared after delivery', async t => {
  let up = false;
  const delivered = [];
  const f = fixture(t, { intranet: async (url, init) => { if (!up) offline(); delivered.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{"ok":true,"id":"20261118T000000Z-00002abc"}' }; } });
  await f.svc.send({ description: '第一条' });
  await f.svc.send({ description: '第二条' });
  assert.equal(f.outbox().length, 2);
  // 收件机仍不在线：一轮只试第一条就停，次数加一
  const r0 = await f.svc.flushOutbox();
  assert.deepEqual(r0, { sent: 0, expired: 0, left: 2 });
  const item = JSON.parse(fs.readFileSync(path.join(f.root, 'hub-feedback-outbox', f.outbox()[0]), 'utf8'));
  assert.equal(item.attempts, 2);
  up = true;
  const r1 = await f.svc.flushOutbox();
  assert.deepEqual(r1, { sent: 2, expired: 0, left: 0 });
  assert.deepEqual(f.outbox(), []);
  assert.deepEqual(delivered.map(b => b.summary), ['第一条', '第二条']);
  assert.deepEqual(f.calls.aliyun, []);
});

test('outbox items older than 30 days are dropped without sending (7-day-old items are kept)', async t => {
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const f = fixture(t, { intranet: offline, now: () => clock });
  await f.svc.send({ description: '旧的' });
  assert.equal(f.outbox().length, 1);
  clock += 7 * 24 * 60 * 60 * 1000 + 1000;
  assert.deepEqual(await f.svc.flushOutbox(), { sent: 0, expired: 0, left: 1 }, '7 天的还留着（11-18 黑洞后放宽）');
  clock += 23 * 24 * 60 * 60 * 1000;
  const before = f.calls.intranet.length;
  assert.deepEqual(await f.svc.flushOutbox(), { sent: 0, expired: 1, left: 0 });
  assert.equal(f.calls.intranet.length, before);
  assert.deepEqual(f.outbox(), []);
});

test('public edition inside the company (inner source reachable) goes intranet, outside goes Aliyun', async t => {
  const inside = fixture(t, { edition: 'public', openxReachable: true });
  assert.equal((await inside.svc.send({ description: 'x' })).via, 'intranet');
  assert.deepEqual(inside.calls.aliyun, []);
  // 公司内但收件机不在线：进队列，不发阿里云
  const insideDown = fixture(t, { edition: 'public', openxReachable: true, intranet: offline });
  assert.equal((await insideDown.svc.send({ description: 'x' })).queued, true);
  assert.deepEqual(insideDown.calls.aliyun, []);
  // 公司外：从没拿到过地址、内源也连不上
  const outside = fixture(t, { edition: 'public', urls: [], openxReachable: false });
  const r = await outside.svc.send({ description: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'aliyun-1');
  assert.deepEqual(outside.calls.aliyun, [ALIYUN]);
  assert.deepEqual(outside.calls.intranet, []);
  assert.equal(await outside.svc.route(), 'aliyun');
});

test('intranet body is trimmed to the receiver limit even when JSON escaping inflates it', async t => {
  let size = 0;
  const f = fixture(t, { intranet: async (_url, init) => { size = Buffer.byteLength(init.body); return { ok: true, status: 200, text: async () => '{"ok":true,"id":"20261118T000000Z-00003abc"}' }; } });
  fs.mkdirSync(path.join(f.root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'logs', 'quotes.jsonl'), Array.from({ length: 3000 }, (_, i) => JSON.stringify({ i, a: '"q"\\"q"', b: '\\\\'.repeat(10) })).join('\n'));
  assert.equal((await f.svc.send({ description: 'big' })).ok, true);
  assert.ok(size > 0 && size <= 94 * 1024, `body ${size}`);
});

// ---- 收件地址：从内源读、缓存、读不到用缓存 ----
function openxFake({ records, packages, file, fail = false }) {
  const seen = [];
  const json = obj => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  return { seen, fetchImpl: async url => {
    seen.push(String(url));
    if (fail) throw new Error('getaddrinfo ENOTFOUND');
    if (/by_project_id/.test(url)) return json({ code: '0', data: { records } });
    if (/by_id/.test(url)) return json({ code: '0', data: { binaryPackages: packages } });
    if (/feedback-receiver\.json/.test(url)) return json(file);
    return { ok: false, status: 404, text: async () => '' };
  } };
}
const CFG = { api: 'https://openx.example.invalid/api/', projectId: 7938, fileSite: 'https://openx.example.invalid/' };

test('receiver address is read from the fixed inner-source release and cached; unreachable falls back to cache', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-addr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const good = openxFake({
    records: [{ id: 1, version: 'v5.6.40' }, { id: 7, version: 'feedback-receiver', releaseTime: '2026-11-18 10:00:00' }],
    packages: [{ originalFileName: 'feedback-receiver.json', url: 'https://openx.example.invalid/files/feedback-receiver.json' }],
    file: { urls: ['http://10.20.30.41:18767', 'http://user:pw@bad:1', 'ftp://bad', 'http://10.20.30.42:18767/path', 'http://10.20.30.41:18767/'] },
  });
  const a = createReceiverAddress({ dataDir: dir, fetchImpl: good.fetchImpl, config: CFG });
  const r = await a.resolve();
  assert.deepEqual(r, { urls: ['http://10.20.30.41:18767'], boardReleaseId: 0, from: 'openx', openxReachable: true, reason: '' });
  assert.ok(good.seen.some(u => /by_id\?id=7$/.test(u)), '查的是 feedback-receiver 那个版本');
  assert.ok(!good.seen.some(u => /by_id\?id=1$/.test(u)), '不去翻别的版本');
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile(dir), 'utf8')).urls, ['http://10.20.30.41:18767']);
  // 10 分钟内复用，不再发请求
  const n = good.seen.length; await a.resolve(); assert.equal(good.seen.length, n);
  // 连不上内源：用缓存，并报告「内源连不上」（公开版据此判断在公司外）
  const down = createReceiverAddress({ dataDir: dir, fetchImpl: openxFake({ fail: true }).fetchImpl, config: CFG });
  const d = await down.resolve();
  assert.deepEqual(d.urls, ['http://10.20.30.41:18767']);
  assert.equal(d.from, 'cache'); assert.equal(d.openxReachable, false);
  // 连得上但还没发布：照样算在公司内，地址用缓存
  const none = createReceiverAddress({ dataDir: dir, fetchImpl: openxFake({ records: [{ id: 1, version: 'v5.6.40' }], packages: [] }).fetchImpl, config: CFG });
  const n2 = await none.resolve();
  assert.equal(n2.openxReachable, true); assert.equal(n2.from, 'cache');
  // 附件地址不在内源域名下：不取
  const evil = createReceiverAddress({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fb-addr2-')), config: CFG,
    fetchImpl: openxFake({ records: [{ id: 7, version: 'feedback-receiver' }], packages: [{ originalFileName: 'feedback-receiver.json', url: 'https://evil.example/feedback-receiver.json' }], file: { urls: ['http://x:1'] } }).fetchImpl });
  assert.deepEqual((await evil.resolve()).urls, []);
});

test('cleanUrls keeps only bare http(s) origins on private IPv4 or the company domain', () => {
  // 公司域名放行的用例在成员版专有的 tests/unit-feedback-receiver.test.js（公开版泄露扫描不允许出现内网域名样例）。
  assert.deepEqual(cleanUrls(['http://10.0.0.1:18767', 'https://10.0.0.2', 'http://10.0.0.1:18767/', 'http://10.0.0.3/x', 'http://10.0.0.4?q=1', 'javascript:alert(1)', 5, null]),
    ['http://10.0.0.1:18767', 'https://10.0.0.2']);
  assert.deepEqual(cleanUrls('http://10.0.0.1'), []);
  // 私网 IPv4 与回环可以
  assert.deepEqual(cleanUrls(['http://10.1.2.3:18767', 'http://172.16.0.9:1', 'http://192.168.3.4:2', 'http://100.64.0.1:3']),
    ['http://10.1.2.3:18767', 'http://172.16.0.9:1', 'http://192.168.3.4:2', 'http://100.64.0.1:3']);
  assert.deepEqual(cleanUrls(['http://127.0.0.1:4']), ['http://127.0.0.1:4']);
  // 公网 IP、其他域名、冒充域名、单段计算机名、IPv6 一律拒绝（审查探针里的两个公网地址也在内）
  assert.deepEqual(cleanUrls(['https://example.com', 'http://8.8.8.8:18767', 'http://47.100.1.1:1', 'http://172.32.0.1:1',
    'http://pc123:18767', 'http://[::1]:1', 'http://[fd00::1]:1', 'http://x.example.invalid:1']), []);
});

test('public edition with a valid cached address keeps going intranet when the inner source is temporarily unreadable', async t => {
  // 有缓存地址、内源这次读不到（地址服务回报 openxReachable=false，但 urls 来自缓存）：发缓存的内网地址
  const cached = fixture(t, { edition: 'public', urls: ['http://10.20.30.40:18767'], openxReachable: false });
  const r = await cached.svc.send({ description: 'x' });
  assert.equal(r.via, 'intranet'); assert.equal(r.ok, true);
  assert.deepEqual(cached.calls.aliyun, []);
  // 发不出：进队列，仍不走阿里云
  const down = fixture(t, { edition: 'public', urls: ['http://10.20.30.40:18767'], openxReachable: false, intranet: offline });
  const q = await down.svc.send({ description: 'x' });
  assert.equal(q.queued, true);
  assert.deepEqual(down.calls.aliyun, []);
  // 真实地址服务：缓存里有地址、内源返回 HTML（临时网关错误）→ 仍走内网
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-addr-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(cacheFile(dir), JSON.stringify({ urls: ['http://10.20.30.40:18767'], at: Date.now() }));
  const addr = createReceiverAddress({ dataDir: dir, config: CFG, fetchImpl: async () => ({ ok: true, text: async () => '<html>temporary gateway error</html>' }) });
  const real = createHubFeedbackService({ edition: 'public', endpoint: ALIYUN, info: () => ({ version: 'x' }), logsDir: path.join(dir, 'logs'), downloadsDir: () => path.join(dir, 'dl'),
    logger: { warn() {} }, receiverAddress: addr, fetchImpl: async () => { throw new Error('must not call Aliyun'); } });
  assert.equal(await real.route(), 'intranet');
  // 缓存里的地址不合规（公网）：当作没有缓存 → 公司外，走阿里云
  fs.writeFileSync(cacheFile(dir), JSON.stringify({ urls: ['http://8.8.8.8:18767'], at: Date.now() }));
  const addr2 = createReceiverAddress({ dataDir: dir, config: CFG, fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  const real2 = createHubFeedbackService({ edition: 'public', endpoint: ALIYUN, info: () => ({ version: 'x' }), logsDir: path.join(dir, 'logs'), downloadsDir: () => path.join(dir, 'dl'),
    logger: { warn() {} }, receiverAddress: addr2 });
  assert.equal(await real2.route(), 'aliyun');
});

test('member edition decides first: missing address provider still routes intranet and queues, never Aliyun', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-member-noaddr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aliyun = [];
  for (const extra of [{ receiverAddress: null }, { receiverAddress: null, endpoint: null }, { receiverAddress: { resolve: async () => { throw new Error('boom'); } } }, { receiverAddress: { resolve: async () => null } }]) {
    const svc = createHubFeedbackService({ edition: 'member', endpoint: ALIYUN, info: () => ({ version: 'x' }), logsDir: path.join(root, 'logs'), downloadsDir: () => path.join(root, 'dl'),
      logger: { warn() {} }, fetchImpl: async u => { aliyun.push(u); throw new Error('no'); }, intranetFetch: async () => { throw new Error('no intranet call expected'); }, ...extra });
    assert.equal(await svc.route(), 'intranet');
    const r = await svc.send({ description: '缺参' });
    assert.equal(r.via, 'intranet'); assert.equal(r.queued, true);
    assert.equal(svc.preview().available, true);
  }
  assert.deepEqual(aliyun, []);
});

test('submission id is generated once, persisted with the queued item, and reused on every retry', async t => {
  const seen = [];
  let up = false;
  const f = fixture(t, { intranet: async (_url, init) => { seen.push(JSON.parse(init.body).submitId); if (!up) offline(); return { ok: true, status: 200, text: async () => '{"ok":true,"id":"20261118T000000Z-00004abc"}' }; } });
  await f.svc.send({ description: '同一条' });
  await f.svc.send({ description: '同一条' });
  const queued = f.outbox().map(n => JSON.parse(fs.readFileSync(path.join(f.root, 'hub-feedback-outbox', n), 'utf8')).body.submitId);
  assert.equal(queued.length, 2);
  assert.ok(queued.every(id => /^[a-f0-9]{32}$/.test(id)));
  assert.notEqual(queued[0], queued[1], '用户点了两次发送：是两条，编号不同（不按正文去重）');
  assert.deepEqual(seen, queued);
  await f.svc.flushOutbox(); // 仍不在线
  up = true;
  await f.svc.flushOutbox();
  assert.deepEqual(seen.slice(2), [queued[0], queued[0], queued[1]]);
  // 老版本入队、没有编号的条目：补发前补一个并写回
  const dir = path.join(f.root, 'hub-feedback-outbox');
  fs.writeFileSync(path.join(dir, '20261118T000000000Z-01abcd.json'), JSON.stringify({ queuedAt: Date.now(), attempts: 1, body: { text: 'old', summary: 'old' } }));
  up = false; await f.svc.flushOutbox();
  const fixed = JSON.parse(fs.readFileSync(path.join(dir, '20261118T000000000Z-01abcd.json'), 'utf8')).body.submitId;
  assert.match(fixed, /^[a-f0-9]{32}$/);
  up = true; await f.svc.flushOutbox();
  assert.deepEqual(seen.slice(-2), [fixed, fixed]);
});

test('no receiver address or receiver source is ever compiled into the code', () => {
  for (const file of ['core/feedback-receiver-address.js', 'main/hub-feedback-service.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(src, /https?:\/\/[A-Za-z][A-Za-z0-9.-]*:18767/i, file);
    assert.doesNotMatch(src, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:18767\b/, file);
  }
});

test('Aliyun body carries the edition suffix and target agreed with the relay (public edition outside the company)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-ed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sent = null;
  const svc = createHubFeedbackService({ edition: 'public', endpoint: ALIYUN, logsDir: path.join(root, 'logs'), downloadsDir: () => path.join(root, 'dl'), logger: { warn() {} },
    info: () => ({ version: '5.6.40', edition: '内测先锋版·公开版', target: 'company' }),
    receiverAddress: { resolve: async () => ({ urls: [], openxReachable: false }) },
    fetchImpl: async (_u, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"ok":true,"id":"a"}' }; } });
  assert.equal((await svc.send({ description: 'x' })).ok, true);
  assert.equal(sent.edition, '内测先锋版·公开版');
  assert.equal(sent.target, 'company');
});

test('main.js labels feedback edition as member/public and sends target', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /feedbackEdition === 'member' \? '·成员版' : '·公开版'/);
  assert.match(src, /info: \(\) => \(\{ productName: distribution\.productName, target: distribution\.target/);
});
