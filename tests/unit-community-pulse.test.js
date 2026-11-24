'use strict';
// 社区统计·发送端（2026-11-24）：心跳白名单与钳制、心跳内容、安装编号、发送端节奏与无感约束。收件机侧见 unit-community-hub.test.js。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const schema = require('../core/community/schema');
const P = require('../core/community/payload');
const { ensureInstallId, readInstallId } = require('../core/community/install-id');
const C = require('../core/community/client');
const { createCommunityService } = require('../main/community-service');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-community-'));
const IID = 'a'.repeat(32);
const iidOf = n => n.toString(16).padStart(32, '0');
const HOUR = 3600 * 1000, MIN = 60 * 1000, DAY = 24 * HOUR;
// 2026-11-25 周三 北京时间 10:00
const WED = Date.UTC(2026, 10, 25, 2, 0, 0);
const pulseOf = (n, extra = {}) => schema.sanitizePulse({ v: 1, iid: iidOf(n), ed: 'member', ver: '5.6.100', nick: 'u' + n, pet: 'cat', lv: 10, ach: 3, wxp: 100 + n, wtok: 1000 * n, streak: 2, act: 1, days7: 3, ...extra });

test('白名单：多余字段丢弃，数值钳制，编号不对整条丢弃', () => {
  const nul = String.fromCharCode(0), rlo = String.fromCharCode(0x202e);
  const out = schema.sanitizePulse({ iid: IID.toUpperCase(), ed: 'x', ver: '5.6.100', nick: `张${nul}三${rlo}很长很长很长很长很长很长`, pet: 'shiba', lv: 999, ach: -3, wxp: 'abc', wtok: 1e13, streak: 5.7, act: 9, days7: 30,
    name: '真名', employeeId: 'a00123456', dept: 'x', host: 'PC-1', path: 'C:/x', prompt: 'hi' });
  assert.deepEqual(Object.keys(out).sort(), ['ach', 'act', 'days7', 'ed', 'iid', 'lv', 'nick', 'pet', 'streak', 'v', 'ver', 'wtok', 'wxp'].sort());
  assert.equal(out.iid, IID);
  assert.equal(out.ed, 'member');
  assert.equal(out.lv, schema.MAX_LEVEL);
  assert.equal(out.ach, 0); assert.equal(out.wxp, 0); assert.equal(out.wtok, 1e10); assert.equal(out.streak, 5); assert.equal(out.act, 1); assert.equal(out.days7, 7);
  assert.equal([...out.nick].length, 12);
  assert.ok(!out.nick.includes(nul) && !out.nick.includes(rlo));
  assert.equal(schema.sanitizePulse({ iid: 'zz' }), null);
  assert.equal(schema.sanitizePulse([]), null);
  assert.equal(schema.sanitizePulse({ iid: IID, ver: '../../etc', pet: '<b>' }).ver, '');
});

function profileState(now) {
  const days = {};
  // 近 20 天每天都用（含周末），每天 50 经验
  for (let i = 0; i < 20; i++) { const d = new Date(now); d.setDate(d.getDate() - i); days[P.dayKey(d)] = { xp: 50, p: 3, open: 1 }; }
  return { xp: 5000, days, unlocked: { a: 1, b: 2, c: 3 }, nickname: '', identity: { name: '王某某', account: 'w00123456', dept: '无线' } };
}

test('心跳内容：昵称不回落真名，字段只有白名单，本周合计按周一起算', () => {
  const now = new Date(2026, 10, 25, 10, 0, 0);    // 本地 周三
  const state = profileState(now);
  const dayTokens = { [P.dayKey(new Date(2026, 10, 24))]: 1_234_567, [P.dayKey(new Date(2026, 10, 25))]: 100_000, [P.dayKey(new Date(2026, 10, 22))]: 9e9 };
  const p = P.buildPayload({ iid: IID, edition: 'member', version: '5.6.100', state, petRole: '07-shiba', dayTokens, lastActiveAt: now.getTime() - 30 * MIN, now });
  assert.equal(p.nick, '柴犬·AAAA');
  const text = JSON.stringify(p);
  for (const secret of ['王某某', 'w00123456', '无线']) assert.ok(!text.includes(secret), secret);
  assert.equal(p.pet, 'shiba');
  assert.equal(p.ach, 3);
  assert.equal(p.wxp, 150);                          // 周一、周二、周三
  assert.equal(p.wtok, 1_335_000);                   // 上周日不算，按千取整
  assert.equal(p.act, 1);
  assert.equal(p.days7, 7);
  assert.ok(Buffer.byteLength(text) < 1024);
  const idle = P.buildPayload({ iid: IID, edition: 'public', state: { ...state, nickname: '小李子' }, petRole: 'custom-x', lastActiveAt: now.getTime() - 61 * MIN, now });
  assert.equal(idle.act, 0); assert.equal(idle.nick, '小李子'); assert.equal(idle.pet, 'cat'); assert.equal(idle.ed, 'public');
});

test('工作日连胜：周末不断签；今天还没用从上一个工作日数起', () => {
  const k = (m, d) => P.dayKey(new Date(2026, m, d));
  // 11-19 周四 .. 11-25 周三；周末 21/22 没用
  const days = { [k(10, 19)]: {}, [k(10, 20)]: {}, [k(10, 23)]: {}, [k(10, 24)]: {}, [k(10, 25)]: {} };
  assert.equal(P.workdayStreak(days, new Date(2026, 10, 25, 9)), 5);
  assert.equal(P.workdayStreak({ ...days, [k(10, 25)]: undefined }, new Date(2026, 10, 25, 9)), 4);
  delete days[k(10, 20)];
  assert.equal(P.workdayStreak(days, new Date(2026, 10, 25, 9)), 3);
});

test('心跳构建 < 5 ms（400 天的个人数据）', () => {
  const now = new Date(2026, 10, 25, 10);
  const days = {};
  for (let i = 0; i < 400; i++) { const d = new Date(now); d.setDate(d.getDate() - i); days[P.dayKey(d)] = { xp: 40 }; }
  const state = { xp: 16000, days, unlocked: {} };
  P.buildPayload({ iid: IID, state, now });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) P.buildPayload({ iid: IID, state, dayTokens: {}, now });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  assert.ok(ms < 5, `单次 ${ms.toFixed(2)} ms`);
});

test('安装编号：随机生成并持久，和机器无关', () => {
  const dir = tmp();
  const a = ensureInstallId(dir);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(ensureInstallId(dir), a);
  assert.equal(readInstallId(dir), a);
  assert.notEqual(ensureInstallId(tmp()), a);
  assert.ok(fs.existsSync(path.join(dir, 'community', 'install-id.json')));
});

function fakeTimers() {
  const list = [];
  return { list, setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; list.push(h); return h; }, clearTimeout: h => { if (h) h.cleared = true; } };
}
const pending = timers => timers.list.filter(h => !h.cleared && !h.fired);
async function fire(h) { h.fired = true; await h.fn(); }

test('发送端节奏：首次 2–6 分钟，之后 60±5 分钟；失败不重试；关闭立即停发；暂停后本次运行不再发', async () => {
  const timers = fakeTimers();
  const calls = [];
  let enabled = true, mode = 'fail';
  const client = C.createCommunityClient({ timers, random: () => 0.99, isEnabled: () => enabled,
    receiverAddress: { resolve: async () => ({ urls: ['http://10.0.0.1:18767'] }) },
    buildPayload: () => pulseOf(1),
    fetchImpl: async (url, init) => { calls.push({ url, init }); if (mode === 'fail') throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } });
      return { status: 200, ok: true, text: async () => JSON.stringify(mode === 'pause' ? { ok: true, pause: true } : { ok: true, board: { boards: { level: [] } } }) }; } });
  client.start();
  let h = pending(timers).find(x => x.ms > 1000);
  assert.ok(h.ms >= C.FIRST_MIN_MS && h.ms <= C.FIRST_MIN_MS + C.FIRST_SPAN_MS, String(h.ms));
  await fire(h);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://10.0.0.1:18767/community/v1/pulse');
  assert.ok(Buffer.byteLength(calls[0].init.body) < 1024);
  assert.equal(client.status().state, 'offline');
  // 失败后不重试：下一次排在约 1 小时后
  h = pending(timers).find(x => x.ms > 1000);
  assert.ok(h.ms >= C.PERIOD_MS - C.JITTER_MS && h.ms <= C.PERIOD_MS + C.JITTER_MS, String(h.ms));
  mode = 'pause';
  await fire(h);
  assert.equal(calls.length, 2);
  assert.equal(pending(timers).filter(x => x.ms > 1000).length, 0, '暂停后不再排下一次');
  assert.equal((await client.getBoard()).state, 'paused');
  // 关闭：不发
  enabled = false;
  assert.equal((await client.pulse()).state, 'disabled');
  assert.equal(calls.length, 2);
  assert.equal((await client.getBoard()).state, 'disabled');
});

test('发送端：没有收件地址 = 公司外，不发；榜单 10 分钟缓存；请求 3 秒超时', async () => {
  let t = WED, urls = [];
  const calls = [];
  const client = C.createCommunityClient({ now: () => t, receiverAddress: { resolve: async () => ({ urls }) }, buildPayload: () => pulseOf(1), timeoutMs: 50,
    fetchImpl: async (url, init) => { calls.push(url);
      if (url.includes('slow')) return new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
      return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, boards: { level: [{ rank: 1 }] }, online: 3 }) }; } });
  assert.equal((await client.pulse()).state, 'outside');
  assert.equal((await client.getBoard()).state, 'outside');
  assert.equal(calls.length, 0);
  urls = ['http://10.0.0.1:18767'];
  assert.equal((await client.getBoard({ iid: IID })).online, 3);
  assert.ok(calls[0].endsWith('/community/v1/board?iid=' + IID));
  t += 9 * MIN; await client.getBoard();
  assert.equal(calls.length, 1, '10 分钟内用缓存');
  t += 2 * MIN; await client.getBoard();
  assert.equal(calls.length, 2);
  urls = ['http://slow:1'];
  const started = Date.now();
  const r = await client.getBoard({ force: true });
  assert.ok(Date.now() - started < 1000);
  assert.equal(r.stale, true, '取不到时给旧榜单');
  assert.ok(r.note);
});

test('非公司版：社区页给「仅在公司内网可用」，不发任何请求', async () => {
  const svc = createCommunityService({ dataDir: tmp(), edition: null, profileController: null, isEnabled: () => true, setEnabledFlag: async () => {},
    fetchImpl: async () => { throw new Error('不该发'); } });
  assert.equal((await svc.handlers['get-board']()).state, 'outside');
  svc.start();
  svc.stop();
});

test('底栏在线数：只读缓存，不发请求；没有缓存时给 null', async () => {
  let calls = 0, enabled = true;
  const client = C.createCommunityClient({ isEnabled: () => enabled, receiverAddress: { resolve: async () => ({ urls: ['http://10.0.0.1:1'] }) }, buildPayload: () => pulseOf(1),
    fetchImpl: async () => { calls++; return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, board: { online: 7, activeNow: 3, boards: { level: [] } } }) }; } });
  assert.equal(client.getOnline().online, null);
  assert.equal(calls, 0);
  await client.pulse();
  assert.equal(calls, 1);
  const o = client.getOnline();
  assert.equal(o.online, 7); assert.equal(o.activeNow, 3); assert.equal(o.state, 'ok');
  assert.equal(calls, 1, '读在线数不发请求');
  enabled = false;
  assert.equal(client.getOnline().state, 'disabled');
});

// ---- 审查返工回归（2026-11-24）----

test('审查 P2：等地址期间关掉开关，心跳不发；关开关时在途请求被中止', async () => {
  let enabled = true, release;
  const calls = [];
  const client = C.createCommunityClient({ isEnabled: () => enabled, buildPayload: () => pulseOf(1),
    receiverAddress: { resolve: () => new Promise(r => { release = r; }) },
    fetchImpl: async (url, init) => { calls.push(url); return new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))); } });
  const p = client.pulse();
  await new Promise(r => setImmediate(r));
  client.setEnabled(false);
  release({ urls: ['http://10.0.0.1:1'] });
  assert.equal((await p).sent, false);
  assert.equal(calls.length, 0, '关掉之后不再发出');
  const client2 = C.createCommunityClient({ isEnabled: () => enabled, buildPayload: () => pulseOf(1), timeoutMs: 60000,
    receiverAddress: { resolve: async () => ({ urls: ['http://10.0.0.1:1'] }) },
    fetchImpl: async (url, init) => { calls.push(url); return new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))); } });
  const p2 = client2.pulse();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls.length, 1);
  const started = Date.now();
  enabled = false; client2.setEnabled(false);
  assert.equal((await p2).sent, false);
  assert.ok(Date.now() - started < 1000, '没等到 60 秒超时');
});

test('审查 P2：榜单回复里的 pause 也刹车——清掉定时器，之后不再发心跳', async () => {
  const timers = fakeTimers();
  const calls = [];
  const client = C.createCommunityClient({ timers, random: () => 0.5, buildPayload: () => pulseOf(1),
    receiverAddress: { resolve: async () => ({ urls: ['http://10.0.0.1:1'] }) },
    fetchImpl: async (url) => { calls.push(url); return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, pause: true }) }; } });
  client.start();
  assert.equal(pending(timers).filter(h => h.ms > 1000).length, 1);
  assert.equal((await client.getBoard({ force: true })).state, 'paused');
  assert.equal(pending(timers).filter(h => h.ms > 1000).length, 0, '定时器已清');
  assert.equal((await client.pulse()).state, 'paused');
  assert.equal(calls.filter(u => u.includes('/pulse')).length, 0);
  client.start();
  assert.equal(pending(timers).filter(h => h.ms > 1000).length, 0, '本次运行内不再启动');
});

test('契约：cachedOnly 只读内存或磁盘快照、绝不触网；重启后仍能读到上次的快照；每次结果推 summary', async () => {
  const dir = tmp(), cacheFile = path.join(dir, 'community', 'board-cache.json');
  let calls = 0, t = WED;
  const summaries = [];
  const mk = () => C.createCommunityClient({ now: () => t, cacheFile, onSummary: s => summaries.push(s), buildPayload: () => pulseOf(1),
    receiverAddress: { resolve: async () => { calls++; return { urls: ['http://10.0.0.1:1'] }; } },
    fetchImpl: async () => { calls++; return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, board: { online: 9, boards: { level: [] } } }) }; } });
  const a = mk();
  assert.equal((await a.getBoard({ cachedOnly: true })).state, 'offline');
  assert.equal(calls, 0);
  await a.pulse();
  assert.deepEqual(summaries.at(-1), { state: 'ok', online: 9, at: WED });
  for (let i = 0; i < 50 && !fs.existsSync(cacheFile); i++) await new Promise(r => setTimeout(r, 10));
  const before = calls;
  const b = mk();
  const r = await b.getBoard({ cachedOnly: true });
  assert.equal(r.state, 'ok'); assert.equal(r.online, 9);
  assert.equal(b.getOnline().online, 9);
  assert.equal(calls, before, 'cachedOnly 与 getOnline 都不触网');
  t += 3 * HOUR;
  assert.equal((await b.getBoard({ cachedOnly: true })).stale, true);
  b.setEnabled(false);
  assert.equal(summaries.at(-1).state, 'disabled');
});

// ---- 复审回归（2026-11-24 r2）----

test('复审 P2：取榜单等地址期间关掉开关，不发出带编号的榜单请求', async () => {
  let enabled = true, release;
  const calls = [];
  const client = C.createCommunityClient({ isEnabled: () => enabled, buildPayload: () => pulseOf(1),
    receiverAddress: { resolve: () => new Promise(r => { release = r; }) },
    fetchImpl: async url => { calls.push(url); return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, boards: { level: [] } }) }; } });
  const p = client.getBoard({ force: true, iid: IID });
  await new Promise(r => setImmediate(r));
  enabled = false; client.setEnabled(false);
  release({ urls: ['http://10.0.0.1:1'] });
  assert.equal((await p).state, 'disabled');
  assert.equal(calls.length, 0, '关掉之后没有发出榜单请求');
});
