'use strict';
// 2026-11-20 群友截图：新建分身第 2 步一直显示「还没读到群，请稍等」。名单来自助理的 WeLink 消息快照，
// 读不到时要说清是哪一种（没登录 / 助理还没取到会话 / 取数出错），界面据此提示并自动重读。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FleetService } = require('../core/avatar/fleet');

function service(t, assistant) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-targets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new FleetService({ dataDir: dir, getAssistant: () => assistant, noTimer: true, now: () => Date.parse('2026-11-20T08:00:00Z'), pollMs: 1,
    listBackends: () => ({ rows: [] }), createSession: async () => ({}), getSession: () => null, closeSession: async () => {}, sendPrompt: async () => ({}), lastFinal: () => null });
}
const base = over => ({ settings: () => ({ myName: '测试员' }), welink: async () => ({ code: 0, stdout: '{}', stderr: '' }), ...over });

test('no WeLink owner yet → empty list with a login reason, never a bare "please wait"', t => {
  const s = service(t, base({ snapshot: () => null, auth: { status: () => ({ state: 'needs-scan' }) }, archive: { owner: () => null, read: () => [], loadIndex: () => ({ names: {} }) } }));
  const r = s.targets();
  assert.equal(r.ok, true); assert.equal(r.ready, false);
  assert.deepEqual(r.groups, []);
  assert.match(r.reason, /还没确认 WeLink 登录/);
});

test('logged-in owner but the assistant has no conversation snapshot yet → says it is still fetching', t => {
  const s = service(t, base({ snapshot: () => ({ at: 1, login: { ok: true }, conversations: [], messages: {} }),
    auth: { status: () => ({ state: 'online', login: { ok: true } }) }, archive: { owner: () => 'a00000001', read: () => [], loadIndex: () => ({ names: {} }) } }));
  const r = s.targets();
  assert.equal(r.ready, false);
  assert.match(r.reason, /助理还没取到 WeLink 会话列表/);
});

test('login expired with an empty snapshot → reason tells to log in again', t => {
  const s = service(t, base({ snapshot: () => ({ at: 1, conversations: [] }),
    auth: { status: () => ({ state: 'needs-scan', error: 'WeLink 登录已过期' }) }, archive: { owner: () => 'a00000001', read: () => [], loadIndex: () => ({ names: {} }) } }));
  assert.match(s.targets().reason, /WeLink 登录已过期.*重新登录/);
});

test('normal snapshot → groups and people listed, ready', t => {
  const s = service(t, base({ snapshot: () => ({ at: 1, login: { ok: true }, conversations: [{ id: 'g1', name: '用户群', group: true }, { id: 'u1', name: '张三' }], messages: {} }),
    auth: { status: () => ({ state: 'online', login: { ok: true } }) }, archive: { owner: () => 'a00000001', read: () => [], loadIndex: () => ({ names: {} }) } }));
  const r = s.targets();
  assert.equal(r.ready, true);
  assert.deepEqual(r.groups.map(g => g.name), ['用户群']);
  assert.deepEqual(r.people.map(p => p.name), ['张三']);
});

test('avatar page no longer hard-codes 「请稍等」 and retries while the wizard waits for groups', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'avatar-page.js'), 'utf8');
  assert.doesNotMatch(src, /还没读到群，请稍等/);
  assert.match(src, /targetsTries < 36/);
  assert.match(src, /setTimeout\(\(\) => void loadTargets\(true\), 5000\)/);
});

// R34（2026-11-24 WeLink 反馈「展示不了群和人，过一会儿出来了」）：当天快照要等助理整轮取数跑完才有。
// 读到过的名单按账号缓存，下次先显示缓存（stale）再后台刷新；没缓存时用前几天同账号的快照。
test('names read once are cached per account and shown first (stale) while today\'s snapshot is still empty', t => {
  let today = { at: 111, login: { ok: true, uid: 'a00000001' }, conversations: [{ id: 'g1', name: '用户群', group: true }, { id: 'u1', name: '张三' }], messages: {} };
  const s = service(t, base({ snapshot: () => today, auth: { status: () => ({ state: 'online', login: { ok: true } }) },
    archive: { owner: () => 'a00000001', read: () => [], loadIndex: () => ({ names: {} }) } }));
  const fresh = s.targets();
  assert.equal(fresh.stale, undefined);
  assert.equal(fresh.at, 111);
  today = { at: 222, login: { ok: true, uid: 'a00000001' }, conversations: [], messages: {} };
  const cached = s.targets();
  assert.equal(cached.ready, true);
  assert.equal(cached.stale, true);
  assert.equal(cached.at, 111);
  assert.deepEqual(cached.groups.map(g => g.name), ['用户群']);
  assert.match(cached.reason, /助理还没取到 WeLink 会话列表/);
});

test('no cache yet → falls back to an earlier day\'s snapshot of the same account, never another account\'s', t => {
  const days = { '2026-11-20': { at: 0, conversations: [] }, '2026-11-19': { at: 9, login: { uid: 'someone-else' }, conversations: [{ id: 'gx', name: '别人的群', group: true }] },
    '2026-11-18': { at: 8, login: { uid: 'a00000001' }, conversations: [{ id: 'g2', name: '前天的群', group: true }] } };
  const s = service(t, base({ snapshot: day => days[day || '2026-11-20'], snapshotDays: () => Object.keys(days),
    auth: { status: () => ({ state: 'online', login: { ok: true } }) }, archive: { owner: () => 'a00000001', read: () => [], loadIndex: () => ({ names: {} }) } }));
  const r = s.targets();
  assert.equal(r.stale, true);
  assert.deepEqual(r.groups.map(g => g.name), ['前天的群']);
});

test('avatar page shows 「正在读取…」, a cached-list note and a 「重试」 button with the reason on timeout or failure', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'avatar-page.js'), 'utf8');
  assert.match(src, /正在读取…/);
  assert.match(src, /读到的名单，/);
  assert.match(src, /data-av="targets-retry">重试</);
  assert.match(src, /读取超时/);
  assert.match(src, /op === 'targets-retry'/);
});

test('today\'s snapshot of another account (same-day account switch) is neither listed nor cached; login loss keeps its reason kind', t => {
  let login = { ok: true };
  const s = service(t, base({ snapshot: () => ({ at: 333, login: { ok: false, uid: 'old-account' }, conversations: [{ id: 'gx', name: '旧号的群', group: true }], messages: {} }),
    auth: { status: () => ({ state: login.ok ? 'online' : 'needs-scan', login }) }, archive: { owner: () => 'a00000001', read: () => [], loadIndex: () => ({ names: {} }) } }));
  const r = s.targets();
  assert.deepEqual(r.groups, []);
  assert.equal(r.reasonKind, 'waiting');
  assert.equal(s.legacy.read('a00000001', 'targets-cache.json', null), null);
  s.legacy.write('a00000001', 'targets-cache.json', { at: 5, groups: [{ id: 'g1', name: '用户群', type: 'group' }], people: [] });
  login = { ok: false };
  const lost = s.targets();
  assert.equal(lost.stale, true);
  assert.equal(lost.reasonKind, 'login');
});

test('avatar page: stale list shows the main-process failure reason, says when polling stopped, and drops late or closed-page reads', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'avatar-page.js'), 'utf8');
  assert.match(src, /reasonKind !== 'waiting' \? targets\.reason/);
  assert.match(src, /3 分钟还没刷新出来/);
  assert.match(src, /if \(seq !== targetsSeq\) return;/);
  assert.match(src, /function close\(\) \{ stopTargets\(\);/);
});
