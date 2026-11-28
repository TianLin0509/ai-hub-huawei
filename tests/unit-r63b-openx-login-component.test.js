'use strict';
// P0（2026-11-28 黄区实测）：内源 by_id 也要求登录后，R63 只带回了程序版本的详情，组件（PPT Doctor、会议转写等）首装和更新
// 找附件时匿名 by_id 401 → 「内源版本详情没取到」。修法：find 记下正在找的组件版本名，借 Edge 登录查列表时在同一个会话里
// 顺带取它的详情；已有登录结果里没有这一版时，再借一次登录只取这一版。这里不真的拉起 Edge：登录查询用假函数，页面脚本在 vm 里跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const openx = require('../core/app-update/openx-source');
const loginList = require('../main/openx-login-list');
const CONFIG = require('../core/app-update/openx-config');

const ENV = { AI_HUB_OPENX: '1' };
const API = openx.DEFAULT_API;
const FILE_HOST = new URL('files/', CONFIG.fileSite).href;
const INDEX_ID = 90001;
const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const UNAUTH = () => json({ code: '401', message: '未认证的请求', data: null });
const RECORDS = [
  { id: 12790, version: 'v5.6.149', releaseTime: '2026-11-28T21:00:00+08:00' },
  { id: 12801, version: 'ppt-doctor-update-2.1.21', releaseTime: '2026-11-28T18:00:00+08:00' },
  { id: 12650, version: 'ppt-doctor-2.0.7', releaseTime: '2026-11-20T10:00:00+08:00' },
  { id: 12640, version: 'asr-sensevoice-1.0.3', releaseTime: '2026-11-19T10:00:00+08:00' }];
const PKGS = {
  12790: [{ id: 1, originalFileName: 'latest.json', url: FILE_HOST + '149-latest.json' }],
  12650: [{ id: 5, originalFileName: 'PPT-Doctor-v2.0.7.zip.000', url: FILE_HOST + 'doctor.000' }, { id: 6, originalFileName: 'PPT-Doctor-v2.0.7.zip.001', url: FILE_HOST + 'doctor.001' }],
  12640: [{ id: 7, originalFileName: 'asr-sensevoice-1.0.3.zip', url: FILE_HOST + 'asr.zip' }] };
// 内源：列表、索引、by_id 一律 401（2026-11-28 公司实测的现状）。
function lockedFetch(calls = []) { return async url => { calls.push(String(url)); return UNAUTH(); }; }
// 假的「借 Edge 登录」：像页面脚本那样，程序版本 + want / detailIds 命中的版本带回详情。
function fakeLister({ ok = true } = {}) {
  const norm = v => String(v || '').trim().replace(/^v/i, '').toLowerCase();
  const fn = async (args = {}) => {
    fn.calls.push(args);
    if (!ok) return { ok: false, reason: 'Edge 里还没登录内源' };
    const wants = (args.want || []).map(norm), ids = (args.detailIds || []).map(String);
    const pick = RECORDS.filter(r => /^v\d/.test(r.version) || ids.includes(String(r.id)) || wants.some(w => norm(r.version) === w || norm(r.version).startsWith(w + ' ')));
    return { ok: true, name: 'AI-Hub', records: RECORDS, details: pick.map(r => ({ id: r.id, version: r.version, binaryPackages: PKGS[r.id] || [] })) };
  };
  fn.calls = [];
  return fn;
}
const findDoctor = fetchImpl => openx.find({ file: 'PPT-Doctor-v2.0.7.zip', version: '2.0.7', release: 'ppt-doctor-2.0.7', fetchImpl, env: ENV });
const findAsr = fetchImpl => openx.find({ file: 'asr-sensevoice-1.0.3.zip', version: '1.0.3', release: 'asr-sensevoice-1.0.3', fetchImpl, env: ENV });

test.beforeEach(() => { openx._reset({ indexId: INDEX_ID, localVersion: '5.6.149' }); });
test.after(() => { openx._reset(); openx.setLoginLister(null); });

test('全新用户首装 Doctor：列表和 by_id 都 401 → 一次借 Edge 登录，同一个会话里带回 ppt-doctor-2.0.7 的详情，找到分片', async () => {
  const lister = fakeLister(); openx.setLoginLister(lister);
  const calls = [];
  const hit = await findDoctor(lockedFetch(calls));
  assert.ok(hit, openx.lastReason());
  assert.deepEqual(hit.urls, [FILE_HOST + 'doctor.000', FILE_HOST + 'doctor.001']);
  assert.equal(lister.calls.length, 1, '只开一次 Edge');
  assert.ok(lister.calls[0].want.includes('ppt-doctor-2.0.7'), '把正在找的组件版本交给页面脚本');
  assert.ok(!calls.includes(`${API}by_id?id=12650`), '没有再匿名请求这一版的 by_id');
});

test('先查过程序更新（登录结果里没有组件详情）→ 装组件时再借一次登录只取这一版；同一版之后直接复用', async () => {
  const lister = fakeLister(); openx.setLoginLister(lister);
  // 模拟：10 分钟内先有一次只为程序更新开的登录（want 为空）
  openx.clearDown();
  const first = await openx.find({ file: 'latest.json', version: '5.6.149', fetchImpl: lockedFetch(), env: ENV });
  assert.ok(first);
  const before = lister.calls.length;
  // 这一轮的登录结果已缓存（10 分钟），里面没有会议转写组件的详情 → 匿名 by_id 401 → 借登录取这一版
  const asr = await findAsr(lockedFetch());
  assert.ok(asr, openx.lastReason());
  assert.equal(asr.url, FILE_HOST + 'asr.zip');
  assert.equal(lister.calls.length, before + 1);
  assert.deepEqual(lister.calls.at(-1).detailIds, [12640]);
  // 同一版再找：详情已缓存，不再开 Edge
  assert.ok(await findAsr(lockedFetch()));
  assert.equal(lister.calls.length, before + 1);
});

test('借登录也没取到 → 如实说「借 Edge 登录也没取到这一版的详情」，不报成连不上', async () => {
  const good = fakeLister(); openx.setLoginLister(good);
  await openx.find({ file: 'latest.json', version: '5.6.149', fetchImpl: lockedFetch(), env: ENV });
  openx.setLoginLister(fakeLister({ ok: false }));
  const miss = await findAsr(lockedFetch());
  assert.equal(miss, null);
  assert.match(openx.lastReason(), /内源版本详情没取到.*借 Edge 登录也没取到这一版的详情/);
  assert.notEqual(openx.reachability(), 'down');
});

test('没注入登录查询（纯 Node、内源未生效）：行为和以前一样，直接报详情没取到', async () => {
  openx.setLoginLister(null);
  assert.equal(await findDoctor(lockedFetch()), null);
  assert.doesNotMatch(openx.lastReason(), /借 Edge 登录也没取到这一版/);
});

// 页面脚本：want / detailIds 命中的组件版本也取详情，不重复取程序版本。
test('页面脚本：带上正在找的组件版本名和指定 id，在同一个会话里一起取详情', async () => {
  const apiPath = new URL(API).pathname, seen = [];
  const ctx = {
    localStorage: { getItem: k => (k === 'token' ? 'T' : null) }, sessionStorage: { getItem: () => null },
    document: { querySelectorAll: () => [] }, window: {}, AbortSignal, Date, Math, Number, String, Array, JSON, Promise, encodeURIComponent,
    fetch: async url => {
      seen.push(url);
      const body = /by_project_id/.test(url) ? { code: '0', data: { total: RECORDS.length, name: 'AI-Hub', records: RECORDS } }
        : { code: '0', data: { version: 'x', binaryPackages: [] } };
      return { status: 200, json: async () => body };
    },
  };
  ctx.window = ctx;
  const value = await vm.runInNewContext(loginList.buildLoginListScript({ apiPath, projectId: 7938, want: ['ppt-doctor-2.0.7'], detailIds: [12640] }), ctx);
  assert.equal(value.ok, true);
  const got = seen.filter(u => /by_id\?id=/.test(u)).map(u => Number(/id=(\d+)/.exec(u)[1])).sort();
  assert.deepEqual(got, [12640, 12650, 12790], '程序版本 + 想要的 Doctor 版本 + 指定 id 的转写组件，各取一次');
  // 不带 want 时和以前一样只取程序版本
  seen.length = 0;
  await vm.runInNewContext(loginList.buildLoginListScript({ apiPath, projectId: 7938 }), ctx);
  assert.deepEqual(seen.filter(u => /by_id\?id=/.test(u)).map(u => Number(/id=(\d+)/.exec(u)[1])), [12790]);
});
