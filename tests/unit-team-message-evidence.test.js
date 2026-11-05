'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createTeamService } = require('../main/team/service');
const cli = require('../scripts/hub-team');

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-evidence-'));
  const sessions = new Map([['lead-001', { id: 'lead-001', kind: 'codeagent', status: 'idle' }]]);
  const sent = [], busy = new Set();
  let n = 0;
  const deps = { listAccounts:()=>({recommendedId:'pool-a',rows:[{id:'pool-a',usable:true,models:['GLM-5.2'],modelsAuthoritative:true}]}), getHubDataDir: () => root, commandPath: () => 'C:/hub/team.cmd',
    sessionManager: { getSession: id => sessions.get(id), isAgentTurnActive: id => busy.has(id) },
    createSession: async ({ kind, opts }) => { const s = { id: `member-00${++n}`, kind, ...opts, status: 'idle' }; sessions.set(s.id, s); return s; },
    submitPrompt: async (id, text) => { sent.push({ id, text }); return { ok: true }; },
    logger: { warn() {} },
  };
  const service = createTeamService(deps);
  const invoke = (sid, action, args) => service.invoke(sid, action, args);
  const { planId } = await invoke('lead-001', 'propose', { goal: 'fixture', members: [
    { role: '作者', task: 'implementation', kind: 'codeagent' },
    { role: '审查', task: 'review', kind: 'codeagent' },
    { role: '旁支', task: 'independent', kind: 'codeagent' },
  ] });
  await service.decide({ leadSid: 'lead-001', planId, approve: true });
  const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise(r => setImmediate(r)); await service.flush('lead-001'); } };
  await settle();
  t.after(async () => { service.freeze(); await settle();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('hub-team-evidence-'));
    fs.rmSync(root, { recursive: true, force: true }); });
  return { root, service, invoke, settle, sent, sessions, deps, busy };
}

test('long multiline body survives delivery, disk reload and rolling queue pruning', async t => {
  const h = await setup(t);
  const text = '  开头保留空格\n' + '上下游合同😀\n'.repeat(400) + '\n末尾：仅空域分支适用  ';
  const r = await h.invoke('lead-001', 'send', { to: 'm1', message: text });
  await h.settle();
  const read = await h.invoke('member-001', 'read', { messageId: r.messageId });
  assert.equal(read.text, text);
  assert.equal(read.id, r.messageId);
  assert.equal(fs.readFileSync(r.bodyPath, 'utf8'), text);
  const delivered = h.sent.at(-1).text;
  assert.ok(delivered.includes(r.bodyPath));
  assert.ok(delivered.includes(r.messageId));
  assert.ok(delivered.length < 1800, '完整正文不再塞进通知');
  h.service.teamOfLead('lead-001').messages = [];
  const file = path.join(h.root, 'teams', 'lead-001.json');
  fs.writeFileSync(file, JSON.stringify(h.service.teamOfLead('lead-001')));
  const reloaded = createTeamService(h.deps);
  assert.equal((await reloaded.invoke('member-001', 'read', { messageId: r.messageId })).text, text);
});

test('read enforces team and original recipient, including after member links are revoked', async t => {
  const h = await setup(t);
  await h.invoke('lead-001', 'allow', { memberA: 'm1', memberB: 'm2', allow: true });
  const r = await h.invoke('member-001', 'send', { to: 'm2', message: '只供作者审查；结论在最后\n末句' });
  await h.settle();
  assert.equal((await h.invoke('lead-001', 'read', { messageId: r.messageId })).text.endsWith('末句'), true);
  await assert.rejects(h.invoke('member-003', 'read', { messageId: r.messageId }), /参与者/);
  await assert.rejects(h.invoke('member-002', 'read', { messageId: '../../secret' }), /编号/);
  h.sessions.set('other-001', { id: 'other-001' });
  await assert.rejects(h.invoke('other-001', 'read', { messageId: r.messageId }), /团队/);
  await h.invoke('lead-001', 'allow', { memberA: 'm1', memberB: 'm2', allow: false });
  assert.ok((await h.invoke('member-002', 'read', { messageId: r.messageId })).text.includes('末句'));
});

test('peer copies coalesce by pair without losing original ids or waking the lead', async t => {
  const h = await setup(t);
  await h.invoke('lead-001', 'allow', { memberA: 'm1', memberB: 'm2', allow: true });
  await h.settle(); h.sent.length = 0;
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await h.invoke('member-001', 'send', { to: 'm2', message: `第${i}次：` + '证据'.repeat(240) })).messageId);
  await h.settle();
  assert.equal(h.sent.filter(m => m.id === 'lead-001').length, 0);
  await h.invoke('member-002', 'send', { to: 'lead', message: '交付就绪' });
  await h.settle();
  const lead = h.sent.filter(m => m.id === 'lead-001').at(-1).text;
  assert.equal((lead.match(/（抄送汇总）/g) || []).length, 1);
  for (const id of ids) {
    assert.ok(lead.includes(id));
    assert.ok((await h.invoke('lead-001', 'read', { messageId: id })).text.includes('证据'));
  }
  assert.ok(lead.includes('交付就绪'));
  assert.ok(lead.length < 1400);
});

test('member kickoff respects caller backend and ordinary notices do not demand acknowledgments', async t => {
  const h = await setup(t);
  const kickoff = h.sent.find(m => m.id === 'member-001').text;
  assert.match(kickoff, /CodeAgent/);
  assert.doesNotMatch(kickoff, /ai-peers/);
  await h.invoke('lead-001', 'send', { to: 'm1', message: '普通告知' });
  await h.settle();
  assert.match(h.sent.at(-1).text, /普通告知无需回执/);
});

test('status separates planned account from current Hub session configuration', async t => {
  const h = await setup(t);
  Object.assign(h.sessions.get('member-001'), { codeagentPoolAccount: 'new-account', currentModel: { id: 'test-model' }, cwd: 'D:/task' });
  const m = (await h.invoke('lead-001', 'status')).members.find(m => m.memberId === 'm1');
  assert.equal(m.runtime.account, 'new-account');
  assert.equal(m.runtime.model, 'test-model');
  assert.equal(m.runtime.cwd, 'D:/task');
  assert.notEqual(m.account, m.runtime.account);
});

test('CLI reads full evidence by message id; multiline input is preserved', () => {
  assert.deepEqual(cli.buildRequest(['read', '--id', 'msg-example']), { action: 'read', args: { messageId: 'msg-example' } });
  assert.throws(() => cli.buildRequest(['read']), /--id/);
  assert.equal(cli.buildRequest(['send', '--to', 'm1', '--message', '第一行\n第二行']).args.message, '第一行\n第二行');
});
