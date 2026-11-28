'use strict';
// 主进程：增量包在上一份上拼回的结果与整份完全一致；序号不符、条目缺失要求界面重发整份。
// 界面：首次整份，之后只带变化条目，每 30 次再发一次整份；关 Hub 前的收尾保存一律整份；resync 后下一次整份。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incr-persist-'));
process.env.AI_HUB_DATA_DIR = dataDir;
process.env.CLAUDE_HUB_DATA_DIR = dataDir;
const { registerPersistenceIpc } = require('../main/ipc/persistence-handlers');

function createDeps() {
  let lastSessions = [], lastIds = new Set(), lastMeetings = [], lastMeetingIds = new Set();
  const noop = () => {};
  return {
    sessionManager: { getSession: () => undefined, _openOwners: () => ({ owner: () => null, editClosed: (_i, f) => f(), editSessions: (_i, f) => f() }) },
    sessionStore: { markDirty: noop, deleteSessionFile: noop, cancelDirty: noop, loadSessionFile: () => null, flushPending: async () => {} },
    stateStore: { save: noop, markRemovedSession: noop, markRemovedMeeting: noop, reviveSession: noop },
    meetingStore: { markDirty: noop, deleteMeetingFile: noop, cancelDirty: noop, flushPending: async () => {} },
    meetingManager: { getAllMeetings: () => [], getMeeting: () => null, getMeetingMemberships: () => [] },
    getImmersiveByMeeting: () => ({}),
    getLastPersistedMeetingIds: () => lastMeetingIds, getLastPersistedMeetings: () => lastMeetings,
    getLastPersistedSessionIds: () => lastIds, getLastPersistedSessions: () => lastSessions,
    setLastPersistedMeetingIds: v => { lastMeetingIds = v; }, setLastPersistedMeetings: v => { lastMeetings = v; },
    setLastPersistedSessionIds: v => { lastIds = v; }, setLastPersistedSessions: v => { lastSessions = v; },
    getLiveSession: () => null,
  };
}
function fakeIpc() {
  return { handlers: new Map(), listeners: new Map(), handle(c, fn) { this.handlers.set(c, fn); }, on(c, fn) { this.listeners.set(c, fn); } };
}

test('主进程：增量包拼回的工作现场与整份一致；序号不符、条目缺失要求重发整份', () => {
  const row = (id, extra = {}) => ({ hubId: id, kind: 'codeagent', title: id, cwd: 'C:\\w', lastMessageTime: 5, ...extra });
  const first = [row('keep'), row('b'), row('c')];
  const second = [row('c', { title: 'c2' }), row('keep'), row('new')];
  const run = packets => {
    const ipc = fakeIpc(), deps = createDeps(), out = [];
    registerPersistenceIpc(ipc, deps);
    const event = { sender: { id: 7, send: (...a) => out.push(a) } };
    for (const [channel, ...args] of packets) ipc.listeners.get(channel)(event, ...structuredClone(args));
    return { saved: deps.getLastPersistedSessions(), out };
  };
  const viaFull = run([['persist-sessions', first, [], { seq: 1 }], ['persist-sessions', second, [], { seq: 2 }]]);
  const viaDelta = run([['persist-sessions', first, [], { seq: 1 }],
    ['persist-sessions:delta', { base: 1, seq: 2, order: ['c', 'keep', 'new'], meetingOrder: [], changed: [second[0], second[2]], changedMeetings: [] }]]);
  const noClock = rows => rows.map(({ updatedAt, ...rest }) => rest); // updatedAt 是保存时刻，两次运行差 1 ms 属正常
  assert.ok(viaFull.saved.length === 3);
  assert.deepStrictEqual(noClock(viaDelta.saved), noClock(viaFull.saved));
  assert.deepStrictEqual(viaDelta.out, []);
  const stale = run([['persist-sessions', first, [], { seq: 1 }],
    ['persist-sessions:delta', { base: 9, seq: 10, order: ['keep'], meetingOrder: [], changed: [], changedMeetings: [] }]]);
  assert.deepStrictEqual(stale.out, [['persist-sessions:resync']], '序号对不上：要求重发整份');
  const missing = run([['persist-sessions', first, [], { seq: 1 }],
    ['persist-sessions:delta', { base: 1, seq: 2, order: ['ghost'], meetingOrder: [], changed: [], changedMeetings: [] }]]);
  assert.deepStrictEqual(missing.out, [['persist-sessions:resync']], '条目缺失：要求重发整份');
  const dup = run([['persist-sessions', first, [], { seq: 1 }],
    ['persist-sessions:delta', { base: 1, seq: 2, order: ['keep', 'keep'], meetingOrder: [], changed: [], changedMeetings: [] }]]);
  assert.deepStrictEqual(dup.out, [['persist-sessions:resync']], '条目重复：要求重发整份');
  const noBase = run([['persist-sessions:delta', { base: 1, seq: 2, order: [], meetingOrder: [], changed: [], changedMeetings: [] }]]);
  assert.deepStrictEqual(noBase.out, [['persist-sessions:resync']], '主进程没有底稿（如刚重启）：要求重发整份');
});

// 界面侧：直接跑 renderer.js 里真实的 persistWorkscene 片段。
const rendererPath = path.join(__dirname, '..', 'renderer', 'renderer.js');
const source = fs.readFileSync(rendererPath, 'utf8');
function harness() {
  let now = 10000;
  const sent = [], invoked = [], listeners = new Map(), sessions = new Map(), meetings = {};
  const context = { sessions, meetings, window: {}, require: createRequire(rendererPath), console,
    isAiKind: require('../core/ai-kinds').isAiKind,
    claudeSessionAccountMeta: require('../core/session-capabilities').claudeSessionAccountMeta,
    Date: { now: () => now }, setTimeout, clearTimeout,
    ipcRenderer: {
      on: (name, fn) => listeners.set(name, fn),
      // 把 delta 按主进程的规则拼回完整的 [channel, sessions, meetings]，断言看完整列表。
      send: (...args) => {
        const a = structuredClone(args);
        if (a[0] === 'persist-sessions:delta') {
          const d = a[1], prev = sent.filter(p => p[0] === 'persist-sessions').at(-1);
          const byId = new Map(prev[1].map(r => [r.hubId, r])), mById = new Map(prev[2].map(r => [r.id, r]));
          for (const r of d.changed) byId.set(r.hubId, r);
          for (const r of d.changedMeetings) mById.set(r.id, r);
          sent.push(['persist-sessions', d.order.map(id => byId.get(id)), d.meetingOrder.map(id => mById.get(id)), { seq: d.seq, delta: true, changed: d.changed.length }]);
        } else sent.push(a);
      },
      invoke: (...args) => { invoked.push(structuredClone(args)); return Promise.resolve({ ok: true }); },
    } };
  vm.createContext(context);
  const start = source.indexOf('const PERSIST_DELAY_MS =');
  const end = source.indexOf('const restartController', start);
  assert.ok(start >= 0 && end > start, '找到 renderer.js 的保存片段');
  // 片段里可能引用其他界面全局；缺什么补什么，没有就以 undefined 跑（只关心保存包）。
  vm.runInContext(source.slice(start, end), context);
  return { sessions, meetings, sent, invoked, listeners, context, persist: (flush, full) => context.persistWorkscene(flush, full), tick: () => { now += 1000; } };
}

test('界面：首次整份，之后只带变化条目，每 30 次补一次整份；收尾保存整份；resync 后整份', async () => {
  const h = harness();
  for (let i = 0; i < 50; i++) h.sessions.set('s' + i, { id: 's' + i, hubId: 's' + i, kind: 'claude', title: 't' + i, cwd: 'C:\\w', lastMessageTime: i + 1 });
  h.persist();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][3]?.delta, undefined, '首次整份');
  assert.equal(h.sent[0][1].length, 50);
  for (let k = 1; k <= 31; k++) { h.sessions.get('s3').title = 'renamed' + k; h.tick(); h.persist(); }
  const kinds = h.sent.map(p => (p[3]?.delta ? 'delta' : 'full'));
  assert.equal(kinds[1], 'delta');
  assert.equal(h.sent[1][3].changed, 1, '增量包只带改了的那一条');
  assert.equal(kinds.filter(k => k === 'full').length, 2, '30 次增量后再发一次整份');
  assert.equal(h.sent.at(-1)[1].find(r => r.hubId === 's3').title, 'renamed31');
  assert.equal(h.sent.at(-1)[1].length, 50);

  // 关 Hub 前的收尾保存（hub:flush-workscene）一律发整份，哪怕没有任何变化。
  const before = h.sent.length;
  h.listeners.get('hub:flush-workscene')(null, { requestId: 'r1' });
  const tail = h.sent.slice(before);
  assert.equal(tail[0][0], 'persist-sessions');
  assert.equal(tail[0][3]?.delta, undefined, '收尾保存是整份');
  assert.equal(tail[0][1].length, 50);
  assert.deepEqual(tail[1], ['hub:flush-workscene:done', 'r1'], '整份发出后才回执');

  // 主进程要求 resync：下一次发整份。
  h.sessions.get('s4').title = 'x'; h.tick(); h.tick(); h.tick();
  const count = h.sent.length;
  h.listeners.get('persist-sessions:resync')();
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(h.sent.length, count + 1, 'resync 后补发一次');
  const last = h.sent.at(-1);
  assert.equal(last[3]?.delta, undefined, 'resync 后整份');
  assert.equal(last[1].find(r => r.hubId === 's4').title, 'x');

  // 显式 flush（重启前保存）走 invoke，之后的下一次也是整份。
  h.sessions.get('s5').title = 'y'; h.tick();
  await h.persist(true);
  assert.equal(h.invoked.at(-1)[0], 'persist-sessions:flush');
  h.sessions.get('s6').title = 'z'; h.tick(); h.persist();
  assert.equal(h.sent.at(-1)[3]?.delta, undefined, 'flush 之后的下一次整份');
});

// 审查建议 1、2、4（m11 审查 20261128-审查-render-save-m10-m4.md）。
test('主进程：保存被拒或出错时不推进底稿，下一次增量要求整份；显式 flush 与窗口销毁都清掉底稿', async () => {
  const row = (id, extra = {}) => ({ hubId: id, kind: 'codeagent', title: id, cwd: 'C:\w', lastMessageTime: 5, ...extra });
  const first = [row('a'), row('b')];
  const setup = () => {
    const ipc = fakeIpc(), deps = createDeps(), out = [], once = new Map();
    registerPersistenceIpc(ipc, deps);
    const event = { sender: { id: 9, send: (...a) => out.push(a), once: (name, fn) => once.set(name, fn) } };
    const fire = (channel, ...args) => ipc.listeners.get(channel)(event, ...structuredClone(args));
    return { ipc, deps, out, once, event, fire };
  };
  const delta = (base, seq, order) => ({ base, seq, order, meetingOrder: [], changed: [], changedMeetings: [] });
  const quiet = fn => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return fn(); } finally { console.warn = w; console.error = e; } };

  // 1a. 空列表被护栏拒绝：底稿不推进到 seq 2，也不保留 seq 1 → 基于 2 或 1 的增量都要求整份。
  let t = setup();
  t.fire('persist-sessions', first, [], { seq: 1 });
  assert.equal(t.deps.getLastPersistedSessions().length, 2);
  quiet(() => t.fire('persist-sessions', [], [], { seq: 2 }));
  t.fire('persist-sessions:delta', delta(2, 3, ['a', 'b']));
  assert.deepStrictEqual(t.out.at(-1), ['persist-sessions:resync'], '被拒的那份不当底稿');
  t.fire('persist-sessions:delta', delta(1, 4, ['a', 'b']));
  assert.deepStrictEqual(t.out.at(-1), ['persist-sessions:resync'], '旧底稿也已删掉');

  // 1b. 增量拼回后保存抛错：同样删底稿。
  t = setup();
  t.fire('persist-sessions', first, [], { seq: 1 });
  const setSessions = t.deps.setLastPersistedSessions;
  t.deps.setLastPersistedSessions = () => { throw new Error('EIO'); };
  quiet(() => t.fire('persist-sessions:delta', { ...delta(1, 2, ['a', 'b']), changed: [row('a', { title: 'a2' })] }));
  assert.equal(t.out.at(-1)[0], 'session-persistence-error');
  t.deps.setLastPersistedSessions = setSessions;
  t.fire('persist-sessions:delta', delta(2, 3, ['a', 'b']));
  assert.deepStrictEqual(t.out.at(-1), ['persist-sessions:resync'], '保存出错的那份不当底稿');

  // 2. 显式 flush 后主进程不留底稿。
  t = setup();
  t.fire('persist-sessions', first, [], { seq: 1 });
  t.deps.stateStore.saveForRestart = async () => {};
  await t.ipc.handlers.get('persist-sessions:flush')(t.event, structuredClone(first), []);
  t.fire('persist-sessions:delta', delta(1, 2, ['a', 'b']));
  assert.deepStrictEqual(t.out.at(-1), ['persist-sessions:resync'], 'flush 之后旧底稿作废');

  // 4. 窗口销毁后底稿随之清掉。
  t = setup();
  t.fire('persist-sessions', first, [], { seq: 1 });
  assert.equal(typeof t.once.get('destroyed'), 'function');
  t.once.get('destroyed')();
  t.fire('persist-sessions:delta', delta(1, 2, ['a', 'b']));
  assert.deepStrictEqual(t.out.at(-1), ['persist-sessions:resync'], '销毁的窗口不留底稿');

  // 对照：正常情况下同一底稿上的增量照常保存，不要求整份。
  t = setup();
  t.fire('persist-sessions', first, [], { seq: 1 });
  t.fire('persist-sessions:delta', { ...delta(1, 2, ['b', 'a']), changed: [row('a', { pinned: true })] });
  assert.deepStrictEqual(t.out, []);
  assert.deepStrictEqual(t.deps.getLastPersistedSessions().map(r => [r.hubId, r.pinned === true]), [['b', false], ['a', true]]);
});

test('界面：显式 flush 后哪怕没有变化，下一次后台保存也发整份（不因引用缓存被跳过）', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) h.sessions.set('s' + i, { id: 's' + i, hubId: 's' + i, kind: 'claude', title: 't' + i, cwd: 'C:\w', lastMessageTime: i + 1 });
  h.persist(); h.tick();
  h.sessions.get('s1').title = 'changed'; h.persist(); h.tick();
  const before = h.sent.length;
  h.persist(); h.tick();
  assert.equal(h.sent.length, before, '没变化时照旧跳过');
  await h.persist(true); h.tick();
  h.persist();
  assert.equal(h.sent.length, before + 1, 'flush 之后没变化也补发一次');
  assert.equal(h.sent.at(-1)[3]?.delta, undefined, '而且是整份');
  assert.equal(h.sent.at(-1)[1].length, 5);
});
