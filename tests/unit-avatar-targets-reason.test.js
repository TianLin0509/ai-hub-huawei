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
