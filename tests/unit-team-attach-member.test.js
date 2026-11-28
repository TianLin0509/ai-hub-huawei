'use strict';
// 用户手动加成员（来源 22dff5bd、deda1cae）：启动中心选了负责人 / 右键负责人「创建子会话…」建的会话，直接挂到负责人名下：
// 通知负责人、给成员发组队说明；不占个人账号同时干活的名额、不计入每队人数；组队只支持 CodeAgent。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createTeamService } = require('../main/team/service');

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-attach-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = new Map(), sent = [];
  const add = (id, extra = {}) => { const s = { id, title: '会话 ' + id, kind: 'codeagent', cwd: dir, status: 'idle', ...extra }; sessions.set(id, s); return s; };
  let clock = 1_800_000_000_000;
  const service = createTeamService({
    company: true, getHubDataDir: () => dir, getConfig: () => ({}), now: () => clock,
    listAccounts: () => ({ recommendedId: 'pool-a', rows: [{ id: 'pool-a', usable: true, models: ['GLM-5.2'], modelsAuthoritative: true }] }),
    sessionManager: { getSession: id => sessions.get(id) || null, isAgentTurnActive: () => false, getGroupChatLastActivity: id => sessions.get(id)?.out || 0,
      updateSessionMeta: (id, fields) => Object.assign(sessions.get(id), fields) },
    commandPath: () => path.join(dir, 'hub-team.cmd'),
    createSession: async request => add(`member-${sessions.size}xxx`, { kind: request.kind }),
    submitPrompt: async (sid, text) => { sent.push({ sid, text }); return { ok: true }; },
  });
  t.after(() => { service.freeze(); service.stop(); });
  const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise(r => setImmediate(r)); for (const l of [...sessions.keys()]) await service.flush(l); } };
  return { service, sessions, add, sent, settle, dir, tick: ms => { clock += ms; } };
}

test('attached member is marked manual; lead is told at once, member gets team rules and the task', async t => {
  const h = harness(t);
  h.add('lead-0001', { title: '接口迁移负责人' });
  h.add('child-0001', { title: '未命名任务' });
  const r = h.service.attachMember({ leadSid: 'lead-0001', sessionId: 'child-0001', task: '核对启动中心下拉', title: '核对下拉' });
  assert.equal(r.memberId, 'm1');
  await h.settle();
  const team = JSON.parse(fs.readFileSync(path.join(h.dir, 'teams', 'lead-0001.json'), 'utf8'));
  assert.deepEqual([team.members[0].manual, team.members[0].sid, team.members[0].status, team.members[0].title], [true, 'child-0001', 'active', '核对下拉']);
  const toLead = h.sent.find(s => s.sid === 'lead-0001');
  assert.match(toLead.text, /用户手动加了成员 m1（核对下拉），任务是：核对启动中心下拉/);
  const toMember = h.sent.find(s => s.sid === 'child-0001');
  assert.match(toMember.text, /【组队说明 · 来自 Hub】用户把你手动加入了负责人「接口迁移负责人」的团队，你是成员 m1/);
  assert.match(toMember.text, /你的任务：核对启动中心下拉/);
  assert.match(toMember.text, /send --to lead/);
  assert.doesNotMatch(toMember.text, /\u7530\u54e5/);
  assert.equal(h.service.listTeams()[0].members[0].manual, true, '侧栏用的 publicView 带 manual');
  assert.equal(h.sessions.get('child-0001').hubTeamMember, true, '和招来的成员一样标成团队成员，恢复时不再带组队指路');
  // 成员能用 hub-team 和负责人说话。
  await h.service.invoke('child-0001', 'send', { to: 'lead', message: '已入队', wake: true });
  await h.settle();
  assert.ok(h.sent.some(s => s.sid === 'lead-0001' && s.text.includes('已入队')));
});

test('without a task the member only acknowledges; lead is told the user will brief it directly', async t => {
  const h = harness(t);
  h.add('lead-0001'); h.add('child-0001', { title: '临时会话' });
  h.service.attachMember({ leadSid: 'lead-0001', sessionId: 'child-0001' });
  await h.settle();
  assert.match(h.sent.find(s => s.sid === 'child-0001').text, /只回复一句「已入队，等待任务」/);
  assert.match(h.sent.find(s => s.sid === 'lead-0001').text, /m1（临时会话），任务是：用户会在它的会话里直接布置/);
});

test('guards: CodeAgent only, no self, no double membership, members cannot lead', async t => {
  const h = harness(t);
  h.add('lead-0001'); h.add('child-0001'); h.add('child-0002'); h.add('shell-0001', { kind: 'powershell' });
  assert.throws(() => h.service.attachMember({ leadSid: 'lead-0001', sessionId: 'shell-0001' }), /只支持 CodeAgent/);
  assert.throws(() => h.service.attachMember({ leadSid: 'lead-0001', sessionId: 'lead-0001' }), /不能把负责人加成自己的成员/);
  assert.throws(() => h.service.attachMember({ leadSid: 'gone-0001', sessionId: 'child-0001' }), /负责人会话已不在/);
  h.service.attachMember({ leadSid: 'lead-0001', sessionId: 'child-0001' });
  assert.throws(() => h.service.attachMember({ leadSid: 'lead-0001', sessionId: 'child-0001' }), /已经是某个团队的成员/);
  assert.throws(() => h.service.attachMember({ leadSid: 'child-0001', sessionId: 'child-0002' }), /别人团队的成员，不能当负责人/);
  assert.throws(() => h.service.attachMember({ leadSid: 'child-0002', sessionId: 'lead-0001' }), /本身是负责人/);
});

test('manual members do not count toward team size and plan members still number after them', async t => {
  const h = harness(t);
  h.add('lead-0001'); h.add('child-0001');
  h.service.attachMember({ leadSid: 'lead-0001', sessionId: 'child-0001' });
  const plan = await h.service.invoke('lead-0001', 'propose', { goal: 'g', members: [{ role: 'r', task: 't', account: 'pool-a', model: 'GLM-5.2' }] });
  const r = await h.service.decide({ leadSid: 'lead-0001', planId: plan.planId, approve: true });
  assert.deepEqual(r.created.map(m => m.memberId || m), ['m2']);
});

test('lead options list existing leads by recent activity and skip closed ones', async t => {
  const h = harness(t);
  h.add('lead-0001', { title: '甲', out: 1000 }); h.add('lead-0002', { title: '乙', out: 1_900_000_000_000 });
  h.add('child-0001'); h.add('child-0002');
  h.service.attachMember({ leadSid: 'lead-0001', sessionId: 'child-0001' });
  h.service.attachMember({ leadSid: 'lead-0002', sessionId: 'child-0002' });
  assert.deepEqual(h.service.leadOptions().map(o => [o.title, o.members]), [['乙', 1], ['甲', 1]]);
  h.sessions.get('lead-0002').status = 'dormant';
  assert.deepEqual(h.service.leadOptions().map(o => o.sid), ['lead-0001'], '休眠的负责人不列');
  h.sessions.get('lead-0002').status = 'idle';
  h.sessions.delete('lead-0002');
  assert.deepEqual(h.service.leadOptions().map(o => o.sid), ['lead-0001']);
});
