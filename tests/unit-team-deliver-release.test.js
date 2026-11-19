'use strict';
// 组队不停摆：成员 --deliver 交付后负责人处理完约 60 秒自动离队休眠、返工叫回原会话；
// 离线/休眠收件人自动拉起按 1 分钟、1 分钟、之后 10 分钟退避，失败 2 次才合并提醒负责人；全队空转 20 分钟提醒一次。
// 总开关 config team.antiStall=false 完全回到旧行为。
// 替身按真实语义：休眠成功后会话从运行表删除，只剩侧栏登记（resumable）；用户关闭的会话两边都没有。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createTeamService } = require('../main/team/service');
const { buildRequest } = require('../scripts/hub-team');

const SEC = 1000, MIN = 60 * SEC;

function world(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-deliver-'));
  const w = {
    dataDir, config: {}, clock: { t: 1_800_000_000_000 },
    sessions: new Map([['lead-0001', { id: 'lead-0001', title: '总控', kind: 'codeagent', cwd: dataDir, status: 'idle' }]]),
    resumable: new Set(), busy: new Set(), sent: [], lastOut: new Map(), wakes: [], suspends: [], services: [],
  };
  t.after(async () => {
    for (const s of w.services) { s.freeze(); s.stop(); }
    await new Promise(r => setTimeout(r, 20));
    assert.equal(path.dirname(dataDir), os.tmpdir()); fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return w;
}
// 侧栏能恢复：登记过且运行表里没有（或标着休眠）。
const canWake = (w, id) => w.resumable.has(id) && (!w.sessions.get(id) || w.sessions.get(id).status === 'dormant');
function service(w, { wake, suspend } = {}) {
  let n = w.services.length ? 100 : 0;
  const svc = createTeamService({
    getHubDataDir: () => w.dataDir, getConfig: () => ({ team: w.config }), now: () => w.clock.t,
    isResumable: id => canWake(w, id),
    sessionManager: {
      getSession: id => w.sessions.get(id) || null, isAgentTurnActive: id => w.busy.has(id),
      getGroupChatLastActivity: id => w.lastOut.get(id) || 0,
      suspendSession: (id, opts) => {
        w.suspends.push({ id, opts });
        const r = suspend ? suspend(id, opts) : { ok: true };
        if (r.ok) { w.sessions.delete(id); w.resumable.add(id); }
        return r;
      },
    },
    logger: { warn() {} },
    createSession: async request => {
      const id = `member-${++n}xx`;
      const s = { id, kind: 'codeagent', title: request.opts.title, status: 'idle' };
      w.sessions.set(id, s); w.resumable.add(id); return s;
    },
    submitPrompt: async (sessionId, text) => { w.sent.push({ sessionId, text }); return { ok: true }; },
    listAccounts: () => ({ recommendedId: 'acc-a', rows: [{ id: 'acc-a', usable: true, models: ['GLM-5.2'], modelsAuthoritative: true }] }),
    commandPath: () => 'C:/hub/team/hub-team.cmd',
    wakeSession: async id => {
      w.wakes.push({ id, at: w.clock.t });
      if (wake) return wake(id);
      if (!canWake(w, id)) return false;
      w.sessions.set(id, { id, kind: 'codeagent', title: id, status: 'idle' });
      return true;
    },
  });
  w.services.push(svc);
  return svc;
}
function harness(t, opts = {}) {
  const w = world(t);
  Object.assign(w.config, opts.config || {});
  const h = { w, ...w, service: service(w, opts) };
  h.settle = async () => { for (let i = 0; i < 6; i++) { await new Promise(r => setImmediate(r)); await h.service.flush('lead-0001'); } };
  h.readTeam = () => JSON.parse(fs.readFileSync(path.join(w.dataDir, 'teams', 'lead-0001.json'), 'utf8'));
  h.member = id => h.readTeam().members.find(m => m.memberId === id);
  h.hubNotes = re => h.readTeam().messages.filter(m => m.from === 'hub' && m.to === 'lead' && re.test(m.text));
  h.sleep = id => { w.sessions.delete(id); w.resumable.add(id); }; // 真休眠：运行表删除，侧栏留着
  return h;
}
async function oneMember(h) {
  const { planId } = await h.service.invoke('lead-0001', 'propose', { goal: 'g', members: [{ role: 'r', task: 't' }] });
  await h.service.decide({ leadSid: 'lead-0001', planId, approve: true });
  await h.settle();
  h.sent.length = 0;
}
async function deliverAndAck(h) {
  const r = await h.service.invoke('member-1xx', 'send', { to: 'lead', message: '交付：结果在 a.md', deliver: true });
  await h.settle();
  assert.match(r.note, /离队休眠/);
  assert.equal(h.sent.filter(s => s.sessionId === 'lead-0001').length, 1, '交付会叫醒负责人并送达');
  assert.equal(h.member('m1').deliverSentAt, h.clock.t);
  h.sent.length = 0;
}

test('kickoff tells members to deliver with --deliver and the CLI forwards it', async t => {
  const h = harness(t);
  const { planId } = await h.service.invoke('lead-0001', 'propose', { goal: 'g', members: [{ role: 'r', task: 't' }] });
  await h.service.decide({ leadSid: 'lead-0001', planId, approve: true });
  await h.settle();
  assert.match(h.sent.find(s => s.sessionId === 'member-1xx').text, /send --to lead --deliver/);
  assert.equal(buildRequest(['send', '--to', 'lead', '--deliver', '--message', 'x']).args.deliver, true);
  assert.equal(buildRequest(['send', '--to', 'lead', '--message', 'x']).args.deliver, undefined);
});

test('a delivered member is released and really suspended about 60 seconds after the lead finished, once', async t => {
  const h = harness(t);
  await oneMember(h);
  await deliverAndAck(h);
  h.clock.t += 59 * SEC; h.service.watch();
  assert.equal(h.member('m1').status, 'active', '不到 60 秒不收工');
  h.clock.t += 2 * SEC; h.service.watch();
  const m1 = h.member('m1');
  assert.equal(m1.status, 'dismissed');
  assert.equal(m1.dismissReason, 'delivered');
  assert.equal(h.suspends.length, 1);
  assert.equal(h.suspends[0].opts.reason, 'team-delivered');
  assert.equal(h.suspends[0].opts.requireSettledCodeAgent, true);
  assert.ok(m1.suspendedAt);
  assert.equal(h.sessions.has('member-1xx'), false, '真休眠：运行表已删除');
  const notes = h.hubNotes(/已交付、你已收到/);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].passive, true);
  await h.settle();
  h.clock.t += 40 * MIN; await h.settle();
  assert.equal(h.sent.length, 0, '旁听通知放多久也不单独叫醒负责人');
  h.clock.t += MIN; h.service.watch();
  assert.equal(h.suspends.length, 1, '不重复休眠');
});

test('a busy lead or a new task before the deadline keeps the member on the team', async t => {
  const h = harness(t);
  await oneMember(h);
  await deliverAndAck(h);
  h.busy.add('lead-0001');
  h.clock.t += 2 * MIN; h.service.watch();
  assert.equal(h.member('m1').status, 'active', '负责人还在处理这一轮');
  h.busy.delete('lead-0001');
  await h.service.invoke('lead-0001', 'send', { to: 'm1', message: '返工：补一个用例' });
  await h.settle();
  assert.equal(h.sent.filter(s => s.sessionId === 'member-1xx').length, 1);
  assert.equal(h.member('m1').deliveredAt, undefined, '派新活后交付作废');
  h.clock.t += 5 * MIN; h.service.watch();
  assert.equal(h.member('m1').status, 'active');
  assert.equal(h.suspends.length, 0);
});

test('a member still working after delivering is not released until it stops', async t => {
  const h = harness(t);
  await oneMember(h);
  await deliverAndAck(h);
  h.busy.add('member-1xx'); h.lastOut.set('member-1xx', h.clock.t);
  h.clock.t += 3 * MIN; h.lastOut.set('member-1xx', h.clock.t); h.service.watch();
  assert.equal(h.member('m1').status, 'active', '成员还在干活不收工');
  assert.equal(h.suspends.length, 0);
  h.busy.delete('member-1xx');
  h.clock.t += MIN; h.service.watch();
  assert.equal(h.member('m1').status, 'dismissed', '停下后照常收工');
});

test('rework after a real suspension recalls and wakes the original session', async t => {
  const h = harness(t);
  await oneMember(h);
  await deliverAndAck(h);
  h.clock.t += 61 * SEC; h.service.watch();
  assert.equal(h.member('m1').status, 'dismissed');
  assert.equal(h.sessions.has('member-1xx'), false);
  const r = await h.service.invoke('lead-0001', 'send', { to: 'm1', message: '返工：改一下标题' });
  assert.match(r.note, /空闲时送达|已排队/);
  await h.settle();
  const m1 = h.member('m1');
  assert.equal(m1.status, 'active');
  assert.equal(m1.sid, 'member-1xx', '叫回原会话');
  assert.equal(h.wakes.length, 1);
  assert.equal(h.sent.filter(s => s.sessionId === 'member-1xx').length, 1, '叫醒后送达');
  // 普通 dismiss 的成员不会被叫回。
  await h.service.invoke('lead-0001', 'dismiss', { memberId: 'm1' });
  await assert.rejects(h.service.invoke('lead-0001', 'send', { to: 'm1', message: 'x' }), /另一位成员编号/);
});

test('a released member whose session the user closed cannot be recalled', async t => {
  const h = harness(t);
  await oneMember(h);
  await deliverAndAck(h);
  h.clock.t += 61 * SEC; h.service.watch();
  h.resumable.delete('member-1xx'); // 用户在侧栏关掉
  await assert.rejects(h.service.invoke('lead-0001', 'send', { to: 'm1', message: '返工' }), /已被关闭/);
  assert.equal(h.member('m1').status, 'dismissed');
});

test('--deliver is only for members reporting to the lead', async t => {
  const h = harness(t);
  await oneMember(h);
  await assert.rejects(h.service.invoke('lead-0001', 'send', { to: 'm1', message: 'x', deliver: true }), /只用于成员向负责人交付/);
});

test('suspend retries while the session is not settled and stops on a user protection', async t => {
  let answer = { ok: false, error: 'codeagent-not-settled' };
  const h = harness(t, { suspend: () => answer });
  await oneMember(h);
  await deliverAndAck(h);
  h.clock.t += 61 * SEC; h.service.watch();
  assert.equal(h.member('m1').status, 'dismissed');
  assert.equal(h.member('m1').suspendPending, true);
  answer = { ok: true };
  h.clock.t += MIN; h.service.watch();
  assert.equal(h.suspends.length, 2);
  assert.equal(h.member('m1').suspendPending, undefined);

  const h2 = harness(t, { suspend: () => ({ ok: false, error: 'pinned' }) });
  await oneMember(h2);
  await deliverAndAck(h2);
  h2.clock.t += 61 * SEC; h2.service.watch();
  h2.clock.t += MIN; h2.service.watch();
  assert.equal(h2.suspends.length, 1, '置顶是用户的意思，不反复尝试');
});

test('turning the switch off stops a pending suspend retry', async t => {
  const h = harness(t, { suspend: () => ({ ok: false, error: 'focused' }) });
  await oneMember(h);
  await deliverAndAck(h);
  h.clock.t += 61 * SEC; h.service.watch();
  assert.equal(h.suspends.length, 1);
  h.w.config.antiStall = false;
  h.clock.t += MIN; h.service.watch();
  h.clock.t += MIN; h.service.watch();
  assert.equal(h.suspends.length, 1, '开关关掉后不再尝试休眠');
});

test('waking a dormant recipient backs off 1, 1, then 10 minutes and alerts the lead once after 2 failures', async t => {
  const h = harness(t, { wake: () => false });
  await oneMember(h);
  h.sleep('member-1xx');
  await h.service.invoke('lead-0001', 'send', { to: 'm1', message: '继续做 B' });
  await h.settle();
  assert.equal(h.wakes.length, 1, '有消息排队立即拉起');
  h.clock.t += 30 * SEC; await h.settle();
  assert.equal(h.wakes.length, 1, '1 分钟内不重试');
  h.clock.t += 31 * SEC; await h.settle();
  assert.equal(h.wakes.length, 2, '第 2 次间隔 1 分钟');
  h.clock.t += 2 * MIN; await h.settle();
  assert.equal(h.wakes.length, 2, '失败 2 次后改为 10 分钟一次');
  h.service.watch(); h.service.watch();
  const alerts = h.hubNotes(/未能启动/);
  assert.equal(alerts.length, 1, '合并提醒一次');
  assert.match(alerts[0].text, /m1 未能启动，Hub 已尝试自动拉起 2 次失败（侧栏里没有可恢复的记录/);
  assert.notEqual(alerts[0].wake, false);
  h.clock.t += 8 * MIN; await h.settle();
  assert.equal(h.wakes.length, 3, '距上次 10 分钟后再试');
  h.service.watch();
  assert.equal(h.hubNotes(/未能启动/).length, 1, '同一批排队消息不重复提醒');
});

test('backoff and the alert mark survive a Hub restart', async t => {
  const h = harness(t, { wake: () => false });
  await oneMember(h);
  h.sleep('member-1xx');
  await h.service.invoke('lead-0001', 'send', { to: 'm1', message: '继续做 B' });
  await h.settle();
  h.clock.t += 61 * SEC; await h.settle();
  h.clock.t += 2 * MIN; h.service.watch();
  assert.equal(h.wakes.length, 2);
  assert.equal(h.hubNotes(/未能启动/).length, 1);
  // Hub 重启：旧实例停掉，新实例从磁盘读队伍。
  h.service.freeze(); h.service.stop();
  const fresh = service(h.w, { wake: () => false });
  await fresh.flush('lead-0001');
  assert.equal(h.wakes.length, 2, '重启后仍在 10 分钟冷却内，不立即拉起');
  h.clock.t += MIN; fresh.watch();
  assert.equal(h.hubNotes(/未能启动/).length, 1, '重启后不重复提醒');
  h.clock.t += 7 * MIN; await fresh.flush('lead-0001');
  assert.equal(h.wakes.length, 3, '冷却满 10 分钟后再试');
});

test('a successful wake delivers the queued message and clears the failure count', async t => {
  let attempts = 0;
  const h = harness(t, { wake: id => { attempts++; if (attempts < 2) return false; h.w.sessions.set(id, { id, kind: 'codeagent', status: 'idle' }); return true; } });
  await oneMember(h);
  h.sleep('member-1xx');
  await h.service.invoke('lead-0001', 'send', { to: 'm1', message: '继续做 B' });
  await h.settle();
  assert.equal(h.readTeam().revive.m1.failures, 1);
  h.clock.t += 61 * SEC; await h.settle();
  assert.equal(h.sent.filter(s => s.sessionId === 'member-1xx').length, 1);
  assert.equal(h.readTeam().revive?.m1, undefined, '成功后清零');
  h.clock.t += 5 * MIN; h.service.watch();
  assert.equal(h.hubNotes(/未能启动|没能叫醒/).length, 0, '拉起成功不打扰负责人');
});

test('an idle team reminds the lead once per idle stretch after 20 minutes', async t => {
  const h = harness(t);
  await oneMember(h);
  h.lastOut.set('member-1xx', h.clock.t);
  h.clock.t += 19 * MIN; h.service.watch();
  assert.equal(h.hubNotes(/全队已空闲/).length, 0);
  h.clock.t += 2 * MIN; h.service.watch();
  assert.equal(h.hubNotes(/全队已空闲/).length, 1);
  await h.settle();
  h.lastOut.set('lead-0001', h.clock.t);
  h.clock.t += 30 * MIN; h.service.watch();
  assert.equal(h.hubNotes(/全队已空闲/).length, 1, '同一段空转不重复提醒');
  h.lastOut.set('member-1xx', h.clock.t);
  h.clock.t += 21 * MIN; h.service.watch();
  assert.equal(h.hubNotes(/全队已空闲/).length, 2);
});

test('a really suspended member still counts as idle for the team reminder', async t => {
  const h = harness(t);
  await oneMember(h);
  h.sleep('member-1xx');
  h.clock.t += 21 * MIN; h.service.watch();
  assert.equal(h.hubNotes(/全队已空闲/).length, 1);
  const st = await h.service.invoke('lead-0001', 'status');
  assert.equal(st.members.find(m => m.memberId === 'm1').state, 'dormant', '侧栏可恢复的显示为休眠');
});

test('a busy member or queued mail suppresses the idle reminder', async t => {
  const h = harness(t);
  await oneMember(h);
  h.busy.add('member-1xx'); h.lastOut.set('member-1xx', h.clock.t);
  h.clock.t += 25 * MIN; h.lastOut.set('member-1xx', h.clock.t - MIN); h.service.watch();
  assert.equal(h.hubNotes(/全队已空闲/).length, 0, '成员在忙');
});

test('antiStall=false restores the previous behavior for all three parts', async t => {
  const h = harness(t, { config: { antiStall: false }, wake: () => false });
  const { planId } = await h.service.invoke('lead-0001', 'propose', { goal: 'g', members: [{ role: 'r', task: 't' }] });
  await h.service.decide({ leadSid: 'lead-0001', planId, approve: true });
  await h.settle();
  assert.doesNotMatch(h.sent.find(s => s.sessionId === 'member-1xx').text, /--deliver/, '开工说明不提交付休眠');
  h.sent.length = 0;
  // 1. 交付后不收工
  const r = await h.service.invoke('member-1xx', 'send', { to: 'lead', message: '交付', deliver: true });
  assert.doesNotMatch(r.note, /离队休眠/);
  await h.settle();
  h.clock.t += 5 * MIN; h.service.watch();
  assert.equal(h.member('m1').status, 'active');
  assert.equal(h.suspends.length, 0);
  // 3. 全队空转不提醒
  h.clock.t += 60 * MIN; h.service.watch();
  assert.equal(h.hubNotes(/全队已空闲/).length, 0);
  // 2. 拉起每分钟一次不退避，3 分钟后按旧文案逐人提醒；真休眠按旧判断显示为不在运行
  h.sleep('member-1xx');
  await h.service.invoke('lead-0001', 'send', { to: 'm1', message: '继续' });
  await h.settle();
  for (let i = 0; i < 3; i++) { h.clock.t += 61 * SEC; await h.settle(); }
  assert.equal(h.wakes.length, 4, '旧行为：每分钟一次');
  h.service.watch();
  assert.equal(h.hubNotes(/未能启动/).length, 0);
  assert.equal(h.hubNotes(/不在运行/).length, 1);
});

test('antiStall=false ignores --deliver and preserves --no-wake as an ordinary queued message', async t => {
  const h = harness(t, { config: { antiStall: false } });
  await oneMember(h);
  const { args } = buildRequest(['send', '--to', 'lead', '--deliver', '--no-wake', '--message', '交付结果']);
  const r = await h.service.invoke('member-1xx', 'send', args);
  await h.settle();
  assert.equal(h.sent.filter(s => s.sessionId === 'lead-0001').length, 0, '关闭总开关后，交付标记不能覆盖不叫醒负责人的选择');
  assert.match(r.note, /已留言/);
  const message = h.readTeam().messages.find(m => m.id === r.messageId);
  assert.equal(message.state, 'queued');
  assert.equal(message.wake, false);
  assert.equal(message.deliver, undefined, '按普通留言排队，不记成交付消息');
  for (const key of ['deliveredAt', 'deliverMsgId', 'deliverSentAt']) {
    assert.equal(h.member('m1')[key], undefined, '不记录成员交付状态');
  }
  await h.service.invoke('member-1xx', 'send', { to: 'lead', message: '请处理留言' });
  await h.settle();
  assert.equal(h.sent.filter(s => s.sessionId === 'lead-0001').length, 1, '普通叫醒消息到来后才一起投递');
  assert.equal(h.readTeam().messages.find(m => m.id === r.messageId).state, 'sent');
});

test('a team saved by the previous version loads unchanged', async t => {
  const h = harness(t);
  const old = { leadSid: 'lead-0001', createdAt: 1, updatedAt: 1, plans: [], grants: [], messages: [],
    members: [{ memberId: 'm1', sid: 'member-old', role: 'r', kind: 'codeagent', account: 'acc-a', title: '老成员', planId: 'p', status: 'active', joinedAt: h.clock.t }] };
  h.sessions.set('member-old', { id: 'member-old', kind: 'codeagent', title: '老成员', status: 'idle' });
  fs.mkdirSync(path.join(h.w.dataDir, 'teams'), { recursive: true });
  fs.writeFileSync(path.join(h.w.dataDir, 'teams', 'lead-0001.json'), JSON.stringify(old));
  const st = await h.service.invoke('lead-0001', 'status');
  assert.equal(st.members.find(m => m.memberId === 'm1').status, 'active');
  h.clock.t += 5 * MIN; h.service.watch();
  assert.equal(h.member('m1').status, 'active', '没交付过的老成员不会被收工');
  assert.equal(h.suspends.length, 0);
});
