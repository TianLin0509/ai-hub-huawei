'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { FleetService } = require('../core/avatar/fleet');
const F = require('../core/avatar/fleet-rules');
const { registerAvatarIpc } = require('../main/ipc/avatar-handlers');
const NOW = Date.UTC(2026, 10, 25, 13), GROUP = { id: 'group-synthetic', name: '合成讨论群', group: true };
const msg = (key, text = '导出功能在哪里？', at = NOW, extra = {}) => ({ key: String(key), conv: GROUP.id, text, at, account: 'asker', sender: '同事A', mine: false, contentType: 'TEXT_MSG', ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t, { verified = true, backends } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-b1-'));
  const world = { now: NOW, owner: 'owner-a', verified, messages: {}, events: 0, checks: 0, rows: [], fail: null };
  const assistant = {
    snapshot: () => world.snapshot === null ? null : ({ at: world.now, login: { ok: world.verified, uid: world.owner }, conversations: [GROUP], messages: world.messages }),
    settings: () => ({ myName: '合成用户' }),
    auth: { status: () => ({ state: world.verified ? 'online' : 'unknown', login: world.verified ? { ok: true, uid: world.owner } : null, lastCheckAt: world.verified ? world.now : 0 }),
      check: async () => { world.checks++; if (world.checkWait) await world.checkWait; world.verified = true; } },
    archive: { owner: () => world.verified ? world.owner : null, read: () => [], loadIndex: () => ({ names: {} }) },
    welink: async () => { if (world.waitRead) return world.waitRead; if (world.fail) return world.fail; return { code: 0, stdout: JSON.stringify({ chatInfo: world.rows }), stderr: '' }; },
  };
  const service = new FleetService({ dataDir: dir, getAssistant: () => assistant, now: () => world.now, noTimer: true,
    getSession: () => null, closeSession: async () => {}, listBackends: () => ({ rows: backends || [{ id: 'personal', label: '个人账号', usable: true, models: ['synthetic-model'], defaultModel: 'synthetic-model' }] }),
    onChanged: () => { world.events++; } });
  service.legacy.lookupTitles = async () => false;
  service.owner();
  const install = (id = 'avatar-a', options = {}) => {
    const av = F.newAvatar({ id, tpl: 'blank', now: world.now }, { kind: 'pick', targets: [{ id: GROUP.id, name: GROUP.name, type: 'group', action: 'draft' }], ...options });
    service.saveFleet(world.owner, { avatars: [av], paused: false }); return av;
  };
  t.after(() => { service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { service, world, assistant, install };
}

test('B1：空快照首次预检自动确认；并发合并，5秒冷却不反复查', async t => {
  const { service, world } = fixture(t, { verified: false }); world.snapshot = null;
  const check = deferred(); world.checkWait = check.promise;
  const a = service.status({ autoCheck: true }), b = service.status({ autoCheck: true });
  await Promise.resolve(); assert.equal(world.checks, 1);
  check.resolve(); const [first, second] = await Promise.all([a, b]);
  assert.equal(first.available, true); assert.equal(second.available, true); assert.equal(first.preflight.welink.ok, true);
  assert.ok(world.events > 0); assert.equal(first.preflight.groupsCount, 0);
  world.verified = false; service.owner(); await service.status({ autoCheck: true }); assert.equal(world.checks, 1);
});

test('零分身/巡检停止后身份恢复仍广播；相同助理事件不空广播', t => {
  const { service, world } = fixture(t, { verified: false }); world.snapshot = null;
  service.onAuthChanged(); const before = world.events;
  world.verified = true; service.onAuthChanged(); assert.equal(world.events, before + 1);
  service.onAuthChanged(); assert.equal(world.events, before + 1); assert.equal(service.status().available, true);
});

test('网关configured与selected保持R45语义，失效不亮模型就绪', t => {
  const { service } = fixture(t, { backends: [{ id: 'auto', usable: true }, { id: 'api-gateway', gateway: true, configured: true, selected: false, usable: false, reason: '模型不可用', models: [] }] });
  const agent = service.status().preflight.agent;
  assert.equal(agent.ok, false); assert.equal(agent.configured, true); assert.equal(agent.selected, false); assert.match(agent.label, /不可用/);
});

test('仅auto占位没有真实账号时，预检不能宣称Agent可用', t => {
  const { service } = fixture(t, { backends: [{ id: 'auto', usable: true, models: [] }] });
  assert.equal(service.status().preflight.agent.ok, false);
});

for (let i = 0; i < 30; i++) {
  const kind = i % 3;
  test(`可靠触发样例${i + 1}：${['同毫秒分批到达', '业务失败不当空消息', '切号后只留当前消息'][kind]}`, async t => {
    const { service, world, install } = fixture(t); service.pump = () => {};
    const av = install();
    if (kind === 0) {
      service.merge(GROUP.id, [msg(1000 + i * 2, '导出功能在哪里？')]);
      service.absorb(world.owner, service.fleet(world.owner), av, [GROUP], {});
      service.merge(GROUP.id, [msg(1001 + i * 2, '安装位置怎么选择？', NOW, { account: 'asker-b' })]);
      service.absorb(world.owner, service.fleet(world.owner), av, [GROUP], {});
      const state = service.state(world.owner, av.id);
      assert.equal(Object.keys(state.items).length, 2); assert.equal(typeof state.cursor[GROUP.id], 'object');
    } else if (kind === 1) {
      world.fail = { code: 0, stdout: JSON.stringify({ resultCode: i % 2 ? 401 : 403, message: '合成权限拒绝' }), stderr: '' };
      assert.notEqual(await service.readOne(world.owner, GROUP, new Map()), 'ok');
      const status = service.status(); assert.ok(status.readError); assert.ok(status.activeFailure); assert.equal(status.health.lastReadSuccessAt, 0);
    } else {
      service.merge(GROUP.id, [msg('old-' + i)]); world.owner = 'owner-b'; service.owner(); install('avatar-b');
      await service.tick(); assert.equal(service.messages(GROUP.id).length, 0); assert.equal(service.status().items.length, 0);
    }
  });
}

test('旧数字游标升级保持已有待办，不重新排进生成队列', t => {
  const { service, world, install } = fixture(t); const av = install();
  const item = { id: GROUP.id + ':100', conv: GROUP.id, group: true, firstKey: '100', lastKey: '100', at: NOW, state: 'ready', draft: '旧草稿', account: 'asker', action: 'draft', level: 3, text: '导出怎么做？' };
  service.saveState(world.owner, av.id, { cursor: { [GROUP.id]: NOW }, items: { [item.id]: item } });
  service.merge(GROUP.id, [msg('100')]); service.absorb(world.owner, service.fleet(world.owner), av, [GROUP], {});
  assert.equal(service.state(world.owner, av.id).items[item.id].draft, '旧草稿');
  assert.deepEqual(service.state(world.owner, av.id).cursor[GROUP.id], { at: NOW, id: '100' });
  service.merge(GROUP.id, [msg('101', '安装怎么做？', NOW, { account: 'other' })]); service.absorb(world.owner, service.fleet(world.owner), av, [GROUP], {});
  const state = service.state(world.owner, av.id); assert.equal(Object.keys(state.items).length, 2); assert.deepEqual(state.cursor[GROUP.id], { at: NOW, id: '101' });
});

test('切号后丢弃旧异步读回执，旧账号返回不能污染新live', async t => {
  const { service, world } = fixture(t); const wait = deferred(); world.waitRead = wait.promise;
  const reading = service.readOne(world.owner, GROUP, new Map());
  world.owner = 'owner-b'; service.onAuthChanged();
  wait.resolve({ code: 0, stdout: JSON.stringify({ chatInfo: [{ msgId: '123', sender: 'asker', content: '旧账号内容', serverSendTime: NOW }] }), stderr: '' });
  assert.equal(await reading, 'stop'); assert.equal(service.messages(GROUP.id).length, 0); assert.equal(service.status().health.lastReadSuccessAt, 0);
});

test('无引用本人发言保留题目并可用旧done IPC显式确认结案', async t => {
  const { service, world, install } = fixture(t); const av = install();
  service.merge(GROUP.id, [msg('11')]); service.absorb(world.owner, service.fleet(world.owner), av, [GROUP], {});
  const first = Object.values(service.state(world.owner, av.id).items)[0];
  service.mutate(world.owner, av.id, st => { st.items[first.id].state = 'ready'; st.items[first.id].draft = '可审阅的草稿'; });
  service.merge(GROUP.id, [msg('12', '午餐地点改到二楼', NOW + 1, { account: world.owner, mine: true })]);
  service.absorb(world.owner, service.fleet(world.owner), av, [GROUP], {});
  const row = service.status().items[0]; assert.equal(row.state, 'ready'); assert.ok(row.maybeAnswered); assert.ok(row.replyTarget);
  const handlers = new Map(); registerAvatarIpc({ handle: (name, fn) => handlers.set(name, fn) }, () => service);
  const done = await handlers.get('avatar:done')(null, { avatarId: av.id, itemId: first.id, action: 'confirm-answered' });
  assert.equal(done.items.length, 0); assert.equal(service.state(world.owner, av.id).items[first.id].state, 'answered');
  assert.ok(handlers.has('avatar:recheck'));
});

test('生成阶段和模型失败动作可见；低开销缓存不吞状态变化', async t => {
  const { service, world, install } = fixture(t); const av = install(); const waiting = deferred();
  service.merge(GROUP.id, [msg('20')]); service.absorb(world.owner, service.fleet(world.owner), av, [GROUP], {});
  service.sessions.ensure = async () => ({ id: 'synthetic-session', questions: 0 });
  service.sessions.ask = () => waiting.promise; service.pump = () => {};
  const running = service.runAvatar(world.owner, av.id); await new Promise(r => setImmediate(r));
  const inFlight = service.status(); assert.equal(inFlight.inProgress[0].stage, 'draft'); assert.equal(inFlight.stages.find(s => s.key === 'draft').state, 'running');
  const version = inFlight.statusVersion;
  waiting.resolve(JSON.stringify([{ id: inFlight.inProgress[0].itemId, action: 'draft', reply: '依据不足的回答', confidence: 0, basis: '' }]));
  await running;
  const done = service.status(); assert.ok(done.statusVersion > version); assert.equal(done.items[0].lowConfidenceFallback, true); assert.equal(done.items[0].draft, '');
  assert.equal(done.stages.find(s => s.key === 'draft').state, 'ok'); assert.equal(done.inProgress.length, 0);
});

test('R40b：空分身定时巡检不发空通知，低开销间隔保持4倍', async t => {
  const { service, world } = fixture(t); service.status(); world.events = 0;
  await service.tick(); assert.equal(world.events, 0);
  const optional = require('../core/optional-features'), original = optional.slowedMs;
  t.after(() => { optional.slowedMs = original; }); optional.slowedMs = ms => ms * 4;
  const health = service.status().health; assert.equal(health.hotIntervalMs, 120000); assert.equal(health.wideIntervalMs, 480000); assert.equal(health.pollMode, 'lowOverhead');
});

test('读取恢复会清除读取故障，未知结构不能冒充空消息', async t => {
  const { service, world } = fixture(t);
  world.fail = { code: 0, stdout: '{}', stderr: '' }; await service.readOne(world.owner, GROUP, new Map()); assert.equal(service.status().activeFailure.code, 'read_failed');
  world.fail = null; world.now += 1; assert.equal(await service.readOne(world.owner, GROUP, new Map()), 'ok');
  const status = service.status(); assert.equal(status.activeFailure, null); assert.equal(status.health.readFailStreak, 0); assert.equal(status.health.lastReadSuccessAt, world.now);
});

test('发送队列切号后不以新账号发送旧事项，旧sending锁自行释放', async t => {
  const { service, world, assistant, install } = fixture(t); const av = install(), wait = deferred(); let sends = 0;
  service.merge(GROUP.id, [msg('300')]); service.absorb(world.owner, service.fleet(world.owner), av, [GROUP], {});
  const item = Object.values(service.state(world.owner, av.id).items)[0];
  service.mutate(world.owner, av.id, st => { st.items[item.id].state = 'ready'; st.items[item.id].draft = '请看导出菜单'; });
  assistant.welink = async (_args, options) => { await wait.promise; await options.beforeRun(); sends++; return { code: 0, stdout: '{"code":0}' }; };
  const sending = service.send(av.id, item.id, '请看导出菜单');
  world.owner = 'owner-b'; service.onAuthChanged(); wait.resolve();
  await assert.rejects(sending, /账号已改变.*没有发出/); assert.equal(sends, 0); assert.equal(service.sending.size, 0);
});

test('其它分身仍失败时health不能因当前分身成功而假绿', t => {
  const { service, world, install } = fixture(t); const av = install();
  service.mutate(world.owner, av.id, st => { st.failure = { code: 'model_unavailable', severity: 'error', headline: '模型不可用', at: NOW, actions: [] }; st.lastError = '模型不可用'; });
  service.activeFailure = null;
  const status = service.status(); assert.ok(status.activeFailure); assert.equal(status.health.state, 'error'); assert.equal(status.health.lastError, '模型不可用');
});

test('模型重试只重排指定失败项，普通重查不改变已处理/非失败事项', async t => {
  const { service, world, install } = fixture(t); const av = install(); service.tick = async () => {};
  service.mutate(world.owner, av.id, st => { st.items = {
    failed: { id: 'failed', state: 'remind', tries: 2, failure: { code: 'model_rate_limit' } },
    done: { id: 'done', state: 'done', failure: { code: 'model_rate_limit' } },
    ordinary: { id: 'ordinary', state: 'remind' },
  }; });
  await service.recheckLogin({ retryTick: true }); assert.equal(service.state(world.owner, av.id).items.failed.state, 'remind');
  await service.recheckLogin({ retryTick: true, avatarId: av.id, itemId: 'failed' });
  const state = service.state(world.owner, av.id); assert.equal(state.items.failed.state, 'new'); assert.equal(state.items.failed.tries, 0); assert.equal(state.items.done.state, 'done'); assert.equal(state.items.ordinary.state, 'remind');
});

test('缺CodeAgent或功能显式模型失效时预检不误报可用', t => {
  const { service } = fixture(t);
  const rows = [{ id: 'personal', usable: true, label: '个人账号', models: ['allowed'] }];
  service.d.listBackends = () => ({ rows, codeagentAvailable: false }); assert.equal(service.status().preflight.agent.ok, false);
  service.d.listBackends = () => ({ rows, codeagentAvailable: true, featureChoice: { choice: { kind: 'codeagent', model: 'removed' }, selected: null, warning: '所选模型不可用' } });
  const agent = service.status().preflight.agent; assert.equal(agent.ok, false); assert.equal(agent.configured, true); assert.equal(agent.selected, false);
});

test('切号后旧通讯录查询不落盘，也不继续查下一个人', async t => {
  const { service, world, assistant } = fixture(t), wait = deferred(); let calls = 0;
  const { AvatarService } = require('../core/avatar/service');
  const legacy = new AvatarService({ dataDir: service.d.dataDir, getAssistant: () => assistant, now: () => NOW, noTimer: true });
  assistant.welink = async (_args, opts) => { calls++; await wait.promise; await opts.beforeRun(); return { code: 0, stdout: '{"code":0,"search_cli_person":[]}' }; };
  const owner = world.owner, epoch = service.accountEpoch;
  const lookup = legacy.lookupTitles(owner, ['synthetic-person'], { isCurrent: () => service.current(owner, epoch) });
  world.owner = 'owner-b'; service.onAuthChanged(); wait.resolve();
  assert.equal(await lookup, false); assert.equal(calls, 1); assert.equal(fs.existsSync(legacy.file(owner, 'titles.json')), false);
});

test('普通巡检异常恢复后清除旧故障并广播状态版本', async t => {
  const { service, world, install } = fixture(t); install(); service.pump = () => {};
  service.recordFailure(new Error('合成巡检异常'), 'tick'); const before = service.statusVersion;
  await service.tick(); assert.equal(service.status().activeFailure, null); assert.ok(service.statusVersion > before);
});

for (const kind of ['all', 'groups', 'dm']) {
  test(`会话目录 IM.0000：${kind} 范围继续读取真实列表里的会话`, async t => {
    const { service, world, assistant, install } = fixture(t);
    install('avatar-a', { kind, targets: [] }); let histories = 0;
    // R40b 首轮只建立目录基线；这里模拟已有基线后出现一个新会话。
    service.wideOrder = ['older-conversation'];
    assistant.welink = async args => args[1] === 'query-recent-conversation'
      ? { code: 0, stdout: JSON.stringify({ resultCode: 'IM.0000', respData: { conversation_info: [kind === 'dm'
        ? { recent_conversation_type: 'CHAT_TYPE_P2P_MSG', target_account: 'test-peer', native_name: '合成联系人' }
        : { recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', group_id: GROUP.id, group_name: GROUP.name }] } }), stderr: '' }
      : (histories++, { code: 0, stdout: '{"code":0,"respData":{"chatInfo":[]}}', stderr: '' });
    await service.readWide(world.owner, service.fleet(world.owner), new Set());
    assert.equal(histories, 1); assert.equal(service.status().activeFailure, null);
    assert.equal(service.status().health.lastReadSuccessAt, world.now);
  });
}

test('IM 成功码仅对会话目录生效；未知 IM 业务码和缺列表结构仍为失败', async t => {
  const { service, world, assistant, install } = fixture(t); install('avatar-a', { kind: 'all', targets: [] });
  for (const raw of [{ resultCode: 'IM.0401', conversation_info: [] }, { resultCode: 'IM.0000', respData: {} }]) {
    service.wideAt = 0;
    assistant.welink = async () => ({ code: 0, stdout: JSON.stringify(raw), stderr: '' });
    await service.readWide(world.owner, service.fleet(world.owner), new Set());
    assert.ok(service.status().activeFailure); assert.ok(service.status().readError);
  }
  assistant.welink = async () => ({ code: 0, stdout: '{"resultCode":"IM.0000","chatInfo":[]}', stderr: '' });
  assert.equal(await service.readOne(world.owner, GROUP, new Map()), 'fail');
  assert.equal(service.status().health.lastReadSuccessAt, 0);
});

test('首次检查显示 checking，已知未登录/续期失败后即使 auth.pending 和 authCheck 挂着也持续保留扫码动作', async t => {
  const { service, world, assistant } = fixture(t, { verified: false }); world.snapshot = null;
  const state = { state: '', login: null, error: '', lastCheckAt: 0 };
  assistant.auth.status = () => state;
  const wait = deferred(); assistant.auth.check = async () => { await wait.promise; Object.assign(state, { state: 'unknown', login: { ok: false, reason: 'expired' }, error: '自动续期未成功，十分钟后再试；也可手动登录', lastCheckAt: world.now }); };
  const checking = service.status({ autoCheck: true });
  assert.equal(service.status().preflight.welink.state, 'checking');
  wait.resolve(); await checking;
  for (let i = 0; i < 3; i++) {
    const s = service.status(); assert.equal(s.preflight.welink.state, 'expired');
    assert.equal(s.preflight.welink.ok, false); assert.equal(s.activeFailure.code, 'welink_expired');
    assert.ok(s.activeFailure.actions.some(a => a.kind === 'welink_login'));
    assert.doesNotMatch(s.reason, /正在确认/);
  }
  state.login = null; state.error = '';
  assert.equal(service.login().ok, false); assert.equal(service.status().preflight.welink.state, 'expired');
  state.error = '自动续期被限流，请稍后重试或扫码';
  assert.equal(service.status().activeFailure.actions[0].kind, 'welink_login');
  // 后台自动续期再次占着 pending 且 checkIdentity 也复用该 pending 时，绝不退回 checking 藏掉扫码按钮，且 autoCheck 立即返回不卡死
  const renewWait = deferred();
  assistant.auth.pending = renewWait.promise;
  assistant.auth.check = () => renewWait.promise;
  const immediate = await service.status({ autoCheck: true });
  assert.equal(immediate.preflight.welink.state, 'expired');
  assert.equal(immediate.activeFailure.actions[0].kind, 'welink_login');
  void service.checkIdentity({ force: true });
  const whileChecking = service.status();
  assert.equal(whileChecking.preflight.welink.state, 'expired');
  assert.equal(whileChecking.activeFailure.actions[0].kind, 'welink_login');
  assert.doesNotMatch(whileChecking.reason, /正在确认/);
  renewWait.resolve();
});

test('瞬态失去 uid 保留流水和所有缓存，恢复同 uid 不清空，确定换人后才清空', t => {
  const { service, world } = fixture(t); service.merge(GROUP.id, [msg('cached')]);
  service.stage('draft', 'ok', '已起草'); service.lastReadSuccessAt = world.now;
  service.snapCache = { key: 'synthetic', snap: {} }; service.memo = new Map();
  const live = service.live, snap = service.snapCache, stages = service.stages, memo = service.memo, epoch = service.accountEpoch;
  world.verified = false;
  assert.equal(service.owner(), null); service.switchOwner(null);
  assert.equal(service.runtimeOwner, 'owner-a'); assert.equal(service.accountEpoch, epoch);
  assert.equal(service.live, live); assert.equal(service.snapCache, snap); assert.equal(service.memo, memo); assert.equal(service.stages, stages);
  assert.equal(service.current('owner-a', epoch), false);
  world.verified = true; assert.equal(service.owner(), 'owner-a'); assert.equal(service.live, live);
  world.owner = 'owner-b'; assert.equal(service.owner(), 'owner-b');
  assert.equal(service.accountEpoch, epoch + 1); assert.equal(service.live.size, 0); assert.equal(service.snapCache, null);
  assert.equal(service.lastReadSuccessAt, 0); assert.ok(service.stages.every(s => s.state === 'idle'));
});

const conversationList = (group = 'night-group') => ({ error: { error_code: 'IM.0000', error_msg: 'success' }, respData: { conversation_info: [
  { recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', group_id: group, group_name: '夜间合成群' },
  { recent_conversation_type: 'CHAT_TYPE_P2P_MSG', target_account: 'night-peer', native_name: '合成联系人' },
] } });

test('午夜零快照零分身，经真实 targets IPC 合并并发读取，立即返回群和联系人并缓存', async t => {
  const { service, world, assistant } = fixture(t); world.snapshot = null; world.now = Date.UTC(2026, 10, 25, 16, 13);
  const wait = deferred(); let calls = 0;
  assistant.welink = async (args, options) => { calls++; assert.equal(args[1], 'query-recent-conversation'); assert.equal(options.priority, 'user');
    options.beforeRun(); await wait.promise; return { code: 0, stdout: JSON.stringify(conversationList()), stderr: '' }; };
  const handlers = {}; registerAvatarIpc({ handle: (name, fn) => { handlers[name] = fn; } }, () => service);
  const requests = [handlers['avatar:targets']({}, {}), handlers['avatar:targets']({}, {})];
  await Promise.resolve(); assert.equal(calls, 1); wait.resolve();
  for (const r of await Promise.all(requests)) { assert.equal(r.ready, true); assert.equal(r.groups[0].id, 'night-group'); assert.equal(r.people[0].id, 'night-peer'); }
  const cached = await handlers['avatar:targets']({}, {}); assert.equal(calls, 1); assert.equal(cached.ready, true);
  assert.equal(service.status().preflight.groupsCount, 1);
  assert.equal(service.legacy.read(world.owner, 'targets-cache.json', {}).groups[0].id, 'night-group');
  world.now += 5001; await handlers['avatar:targets']({}, {}); assert.equal(calls, 2);
});

test('名单轻量读失败有原因并冷却，不把业务错误/畸形返回记成成功空名单', async t => {
  const { service, world, assistant } = fixture(t); world.snapshot = null; let calls = 0;
  assistant.welink = async () => { calls++; return { code: 0, stdout: '{"error":{"error_code":"IM.0401","error_msg":"bad request"}}', stderr: '' }; };
  const a = await service.targets({ refresh: true }); assert.equal(a.ready, false); assert.equal(a.reasonKind, 'error');
  assert.equal(service.lastReadSuccessAt, 0); assert.equal(service.targetSnapshot, undefined);
  await service.targets({ refresh: true }); assert.equal(calls, 1);
  world.now += 5001;
  assistant.welink = async () => { calls++; return { code: 0, stdout: '{"code":0,"conversations":[]}', stderr: '' }; };
  const b = await service.targets({ refresh: true }); assert.equal(b.ready, false); assert.equal(service.readError, ''); assert.equal(calls, 2);
});

test('轻量名单读取切号后丢弃旧回执，旧 promise 不覆盖新账号的名单或读取锁', async t => {
  const { service, world, assistant } = fixture(t); world.snapshot = null; const wait = deferred(); let n = 0;
  assistant.welink = async () => { if (n++ === 0) { await wait.promise; return { code: 0, stdout: JSON.stringify(conversationList('old-group')), stderr: '' }; }
    return { code: 0, stdout: JSON.stringify(conversationList('new-group')), stderr: '' }; };
  const old = service.targets({ refresh: true }); await Promise.resolve();
  world.owner = 'owner-b'; service.onAuthChanged();
  const current = await service.targets({ refresh: true }); assert.equal(current.groups[0].id, 'new-group');
  wait.resolve(); await old;
  assert.equal(service.targets().groups[0].id, 'new-group'); assert.equal(service.targetSnapshot.login.uid, 'owner-b');
  assert.equal(service.legacy.read('owner-a', 'targets-cache.json', null), null);
});
