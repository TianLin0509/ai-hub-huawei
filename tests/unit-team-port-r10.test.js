'use strict';
// 用真实组队服务验证留言、持久化、休眠叫回和号池约束；不调用模型。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createTeamService } = require('../main/team/service');
const { planRecalls, classify } = require('../main/team/recall-match');
const attention = require('../core/session-attention-state');
const { isNoUpdateReply, NO_UPDATE_MARK } = require('../core/team-silent-reply');
const notice = require('../renderer/team-notice-identity');
const { buildRequest } = require('../scripts/hub-team');
const MIN = 60_000, GB = 1024 ** 3;

async function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r10-team-'));
  let clock = Date.parse('2026-11-23T00:00:00Z'), n = 0;
  const sent = [], metadata = new Map(), busy = new Set(), wakes = [];
  const sessions = new Map([['lead-0001', { id: 'lead-0001', kind: 'codeagent', cwd: root }]]);
  const deps = { getHubDataDir: () => root, now: () => clock, commandPath: () => 'D:/hub/team/hub-team.cmd',
    getConfig: () => options.config || {}, memInfo: () => ({ free: 16 * GB, total: 64 * GB }),
    isResumable: id => metadata.has(id), getSessionMetadata: id => metadata.get(id),
    sessionManager: { getSession: id => sessions.get(id), isAgentTurnActive: id => busy.has(id),
      suspendSession: id => { metadata.set(id, sessions.get(id)); sessions.delete(id); return { ok: true }; } },
    listAccounts: () => ({ recommendedId: 'pool-a', rows: [{ id: 'pool-a', usable: true, models: ['GLM-5.2'] }, { id: 'pool-b', usable: true, models: ['GLM-5.2'] }] }),
    createSession: async ({ kind, opts }) => { const s = { id: `member-${++n}xxx`, kind, ...opts, contextPct: 40,
      codeagentPoolAccount: opts.codeagentPoolPick, fixedModel: opts.model || 'GLM-5.2' }; sessions.set(s.id, s); return s; },
    submitPrompt: async (sid, text) => { sent.push({ sid, text }); return { ok: true }; },
    wakeSession: async id => { wakes.push(id); const s = metadata.get(id); if (!s) return false; sessions.set(id, s); return true; },
    logger: { warn() {} }, ...options.deps };
  const service = createTeamService(deps), services = [service];
  const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(r => setImmediate(r)); await service.flush('lead-0001'); } };
  t.after(async () => { for (const s of services) { s.freeze(); s.stop(); } await new Promise(r => setImmediate(r));
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('hub-r10-team-')); fs.rmSync(root, { recursive: true }); });
  const invoke = (sid, action, args) => service.invoke(sid, action, args);
  const propose = members => invoke('lead-0001', 'propose', { goal: '移植验收', members });
  const spec = { role: '消息模块实现', task: '实现消息模块', model: 'GLM-5.2' };
  const p = await propose([spec, { role: '独立模块实现', task: '实现另一模块', model: 'GLM-5.2' }]);
  if (p.status === 'pending') await service.decide({ leadSid: 'lead-0001', planId: p.planId, approve: true });
  await settle(); sent.length = 0;
  return { root, sent, metadata, busy, sessions, service, services, deps, invoke, propose, spec, settle, wakes,
    advance: ms => { clock += ms; }, team: () => service.teamOfLead('lead-0001'), count: () => n,
    async release() {
      await invoke('member-1xxx', 'send', { to: 'lead', message: '功能已交付', deliver: true }); await settle();
      clock += MIN + 1; service.watch(); await settle();
      assert.equal(service.teamOfLead('lead-0001').members[0].status, 'dismissed');
      assert.ok(!sessions.has('member-1xxx')); sent.length = 0;
    } };
}

test('默认留言满 8 条或满 20 分钟才叫醒空闲负责人，忙时不插话', async t => {
  const h = await setup(t);
  for (let i = 0; i < 7; i++) await h.invoke('member-1xxx', 'send', { to: 'lead', message: `进展 ${i}` });
  await h.settle(); assert.equal(h.sent.length, 0);
  h.busy.add('lead-0001');
  await h.invoke('member-1xxx', 'send', { to: 'lead', message: '进展 8' }); await h.settle(); assert.equal(h.sent.length, 0);
  h.busy.clear(); await h.settle(); assert.equal(h.sent.length, 1); assert.match(h.sent[0].text, /8 条/);
  h.sent.length = 0;
  await h.invoke('member-1xxx', 'send', { to: 'lead', message: '正常状态' });
  h.advance(20 * MIN - 1); await h.settle(); assert.equal(h.sent.length, 0);
  h.advance(1); await h.settle(); assert.equal(h.sent.length, 1);
});

test('显式叫醒、CodeAgent 故障和交付立即送达，no-wake 仍可压住关键词', async t => {
  const h = await setup(t);
  for (const message of ['卡住了', '执行失败', '请负责人拍板', 'blocked', 'Error: command failed']) {
    await h.invoke('member-1xxx', 'send', { to: 'lead', message }); await h.settle(); assert.match(h.sent.at(-1).text, new RegExp(message));
  }
  const before = h.sent.length;
  await h.invoke('member-1xxx', 'send', { to: 'lead', message: '失败原因已经处理', wake: false }); await h.settle(); assert.equal(h.sent.length, before);
  await h.invoke('member-1xxx', 'send', { to: 'lead', message: '判断有变化', wake: true }); await h.settle(); assert.equal(h.sent.length, before + 1);
  await h.invoke('member-1xxx', 'send', { to: 'lead', message: '结果', deliver: true, wake: false }); await h.settle(); assert.equal(h.sent.length, before + 2);
});

test('CLI 省略 wake 交给服务判断，保留显式开关与纯数字短号', () => {
  assert.equal(Object.hasOwn(buildRequest(['send', '--to', 'lead', '--message', '进展']).args, 'wake'), false);
  assert.equal(buildRequest(['send', '--to', 'lead', '--message', '进展', '--wake']).args.wake, true);
  assert.equal(buildRequest(['send', '--to', 'lead', '--message', '失败', '--no-wake']).args.wake, false);
  assert.equal(buildRequest(['read', '--id', '12']).args.messageId, '12');
});

test('短号持久化后按权限读取，消息裁剪重载后仍可找回原文', async t => {
  const h = await setup(t);
  const text = '首尾完整\n' + '证据😀'.repeat(900) + '\n最后一行';
  const r = await h.invoke('lead-0001', 'send', { to: 'm1', message: text }); await h.settle();
  assert.ok(r.seq > 0);
  assert.match(h.sent.at(-1).text, new RegExp(`#${r.seq} 08:00`));
  assert.equal((await h.invoke('member-1xxx', 'read', { messageId: String(r.seq) })).text, text);
  await assert.rejects(h.invoke('member-2xxx', 'read', { messageId: `#${r.seq}` }), /参与者/);
  h.team().messages = []; h.team().updatedAt = Date.now();
  fs.writeFileSync(path.join(h.root, 'teams', 'lead-0001.json'), JSON.stringify(h.team()));
  const restored = createTeamService(h.deps); h.services.push(restored);
  assert.equal((await restored.invoke('member-1xxx', 'read', { messageId: String(r.seq) })).text, text);
  const next = await restored.invoke('lead-0001', 'send', { to: 'm1', message: '后续' }); assert.ok(next.seq > r.seq);
});

test('全文尾注 4 小时一次、同批标题只写一次、长批次完整落盘', async t => {
  const h = await setup(t);
  // 首批批准通知已经发送过全文尾注。
  await h.invoke('member-1xxx', 'send', { to: 'lead', message: '普通消息', wake: true }); await h.settle();
  assert.match(h.sent.at(-1).text, /规则同前/); assert.doesNotMatch(h.sent.at(-1).text, /下文 hub-team/);
  h.advance(4 * 60 * MIN);
  h.busy.add('lead-0001');
  await h.invoke('member-1xxx', 'send', { to: 'lead', message: '第一条', wake: true });
  await h.invoke('member-1xxx', 'send', { to: 'lead', message: '第二条' }); h.busy.clear(); await h.settle();
  const full = h.sent.at(-1).text; assert.equal(full.split('消息模块实现').length - 1, 1);
  assert.equal(full.split('D:/hub/team/hub-team.cmd').length - 1, 1); assert.match(full, /短号数字/); assert.match(full, /PowerShell 前加 &/);
  await h.invoke('member-1xxx', 'send', { to: 'lead', message: '甲'.repeat(1700), wake: false });
  for (let i = 0; i < 3; i++) await h.invoke('member-2xxx', 'send', { to: 'lead', message: `第${i}条` + '乙'.repeat(1700), wake: false });
  await h.invoke('member-1xxx', 'send', { to: 'lead', message: '送达', wake: true }); await h.settle();
  const folded = h.sent.at(-1).text; assert.match(folded, /原文已存文件/);
  const file = folded.match(/原文：([^\n]+)/)[1], raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /甲{1700}/); assert.match(raw, /第2条乙{1700}/); assert.match(folded, /\[m1 消息模块实现\] 2 条/);
});

test('全文尾注发送失败不消耗 4 小时周期', async t => {
  let fail = false;
  const h = await setup(t, { deps: { submitPrompt: async sid => sid === 'lead-0001' && fail ? { ok: false, notSent: true, stopped: true } : { ok: true } } });
  h.advance(4 * 60 * MIN); const before = h.team().leadFooterAt;
  fail = true; await h.invoke('member-1xxx', 'send', { to: 'lead', message: '新发现', wake: true }); await h.settle();
  assert.equal(h.team().leadFooterAt, before);
});

test('真实交付休眠后提返工计划叫回原会话，撤销旧待批单，不新建成员', async t => {
  const h = await setup(t); await h.release();
  const pending = await h.propose([{ role: '别的工作', task: '先做别的', fresh: true }]);
  const r = await h.propose([{ ...h.spec, task: '按审查意见返工 m1' }]);
  assert.equal(r.status, 'recalled'); assert.equal(r.recalled[0].memberId, 'm1'); assert.equal(h.count(), 2);
  assert.equal(h.team().plans.find(p => p.id === pending.planId).status, 'withdrawn');
  await h.settle(); assert.deepEqual(h.wakes, ['member-1xxx']);
  assert.ok(h.sent.some(m => m.sid === 'member-1xxx' && m.text.includes('按审查意见返工 m1')));
  assert.equal(h.team().members[0].status, 'active'); assert.equal(h.team().members[0].deliveredAt, undefined);
});

test('运行表缺少上下文占用时，使用侧栏已保存的 CodeAgent 占用', async t => {
  const h = await setup(t); await h.release();
  h.sessions.set('member-1xxx', { ...h.metadata.get('member-1xxx'), contextPct: undefined });
  const r = await h.propose([{ ...h.spec, task: '返工 m1' }]);
  assert.equal(r.status, 'recalled'); assert.equal(h.count(), 2);
});

test('混合计划保留新人审批，审查与 fresh 不叫回作者', async t => {
  const h = await setup(t); await h.release();
  const r = await h.propose([{ ...h.spec, task: '返工 m1' }, { role: '独立审查', task: '接手 m1 分支，独立复审' }]);
  assert.equal(r.status, 'pending'); assert.equal(r.recalled.length, 1);
  assert.equal(h.team().plans.at(-1).members.length, 1);
  assert.equal(h.team().plans.at(-1).members[0].role, '独立审查');
  const fresh = await h.propose([{ ...h.spec, task: '返工 m1', fresh: true }]);
  assert.equal(fresh.status, 'pending'); assert.equal(fresh.recalled, undefined); assert.equal(h.team().plans.at(-1).members[0].fresh, true);
});

test('自动批准和关闭 antiStall 的旧路径都保留', async t => {
  const h = await setup(t, { config: { team: { autoApproveLeads: true } } }); await h.release();
  const r = await h.propose([{ ...h.spec, task: '返工 m1' }, { role: '审查', task: '独立审查' }]);
  assert.equal(r.status, 'approved'); assert.equal(r.recalled.length, 1); assert.equal(r.created.length, 1);
  const off = await setup(t, { config: { team: { antiStall: false } } });
  const m = off.team().members[0]; Object.assign(m, { status: 'dismissed', dismissReason: 'delivered', dismissedAt: Date.now() });
  assert.equal((await off.propose([{ ...off.spec, task: '返工 m1' }])).recalled, undefined);
});

const now = Date.parse('2026-11-23T00:00:00Z');
function decision(spec = {}, member = {}, info = {}) {
  return planRecalls([{ role: '消息模块实现', task: '返工 m1', kind: 'codeagent', account: 'pool-a', cwd: 'D:/project', ...spec }],
    { members: [{ memberId: 'm1', sid: 'member-1', role: '消息模块实现', kind: 'codeagent', account: 'pool-a', status: 'dismissed', dismissReason: 'delivered', dismissedAt: now - MIN, ...member }] },
    { now, leadCwd: 'D:/project', sessionInfo: () => ({ exists: true, kind: 'codeagent-resume', cwd: 'd:\\project\\', contextPct: 40, ...info }) })[0];
}
test('返工匹配约束覆盖超时、目录、后端、号池、模型、上下文和转队', () => {
  assert.equal(decision().action, 'recall');
  for (const [spec, m, s] of [
    [{ fresh: true }, {}, {}], [{ role: '独立审查' }, {}, {}], [{ task: '接手 m1 分支，独立复审' }, {}, {}],
    [{ task: '接手 m1 分支，请对代码做审查' }, {}, {}], [{ task: '返工 m1 的提交，同时 review' }, {}, {}],
    [{ account: 'pool-b' }, {}, {}], [{ model: 'different' }, {}, {}], [{ cwd: 'D:/other' }, {}, {}],
    [{ task: '返工 m99' }, {}, {}], [{}, { dismissedAt: now - 49 * 3600_000 }, {}], [{}, { kind: 'claude' }, {}],
    [{}, { dismissReason: 'user' }, {}], [{}, {}, { exists: false }], [{}, {}, { inOtherTeam: true }],
    [{}, {}, { contextPct: 70 }], [{}, {}, { contextPct: undefined }], [{}, {}, { kind: 'claude' }],
  ]) assert.equal(decision(spec, m, s).action, 'new', JSON.stringify([spec, m, s]));
  assert.equal(decision({ task: '实现新的消息功能' }).action, 'hint');
  assert.equal(classify({ role: '消息模块实现（审查由他人负责）', task: '按审查意见修 m1' }), 'rework');
});

test('同一批返工只叫回一次，避免一位作者同时接两份任务', () => {
  const spec = { role: '消息实现', task: '返工 m1', kind: 'codeagent', account: 'pool-a' };
  const result = planRecalls([spec, spec], { members: [{ memberId: 'm1', sid: 'x', role: '消息实现', kind: 'codeagent', account: 'pool-a', status: 'dismissed', dismissReason: 'delivered', dismissedAt: now - MIN }] },
    { now, leadCwd: 'D:/x', sessionInfo: () => ({ exists: true, kind: 'codeagent', cwd: 'D:/x', contextPct: 20 }) });
  assert.deepEqual(result.map(x => x.action), ['recall', 'new']);
});

test('内存提醒不拦创建，同负责人 15 分钟去重，其他队单独提醒', async t => {
  const h = await setup(t, { deps: { memInfo: () => ({ free: 5 * GB, total: 32 * GB }) } });
  assert.equal(h.count(), 2); const notes = () => h.team().messages.filter(m => /【内存提醒/.test(m.text));
  assert.equal(notes().length, 1); assert.equal(notes()[0].wake, false);
  h.advance(15 * MIN);
  const p = await h.propose([{ role: '另一位', task: '继续' }]); await h.service.decide({ leadSid: 'lead-0001', planId: p.planId, approve: true });
  assert.equal(notes().length, 2);
  h.sessions.set('lead-0002', { kind: 'codeagent', cwd: h.root });
  const q = await h.invoke('lead-0002', 'propose', { goal: '另一队', members: [{ role: '作者', task: '实现' }] });
  await h.service.decide({ leadSid: 'lead-0002', planId: q.planId, approve: true });
  assert.equal(h.service.teamOfLead('lead-0002').messages.filter(m => /【内存提醒/.test(m.text)).length, 1);
});

test('内存相对门限、零剩余与读取失败均不会阻止创建', async t => {
  for (const memInfo of [() => ({ free: 7 * GB, total: 128 * GB }), () => ({ free: 0, total: 32 * GB }), () => { throw Error('不可用'); }]) {
    const h = await setup(t, { deps: { memInfo } }); assert.equal(h.count(), 2);
  }
  const normal = await setup(t);
  assert.equal(normal.team().messages.some(m => /【内存提醒/.test(m.text)), false);
});

test('静默回执只隐藏整条暗号，保留旧未读并继续记录真实回复和等输入', () => {
  assert.equal(isNoUpdateReply(` \n\`${NO_UPDATE_MARK}\` \n`), true);
  assert.equal(isNoUpdateReply(`${NO_UPDATE_MARK}\n真实坏消息`), false);
  const s = { kind: 'codeagent', status: 'idle', unreadCount: 0 };
  attention.applyReplyCompleted(s, { text: NO_UPDATE_MARK, completedAt: now }); assert.equal(s.unreadCount, 0); assert.equal(attention.attentionStateOf(s), 'none');
  attention.applyPromptSubmitted(s, { submittedAt: now + 1 }); attention.applyReplyCompleted(s, { completedAt: now + 2, text: '真实结论' });
  attention.applyPromptSubmitted(s, { submittedAt: now + 3, acknowledgesReply: false });
  attention.applyReplyCompleted(s, { completedAt: now + 4, text: NO_UPDATE_MARK });
  assert.equal(s.unreadCount, 1); assert.equal(s.replyReadyText, '真实结论');
  attention.applyReplyCompleted(s, { completedAt: now + 5, text: NO_UPDATE_MARK, needsUserInput: true }); assert.equal(s.attentionState, 'needs-input');
});

test('新旧团队索引、短号、返工消息正确署名与折叠，保留普通提问', () => {
  const text = '【团队消息 · 2 条】\n- [m1 消息实现 · 留言] #12 08:00\n第一条结论\n- [m1] #13 08:01\n第二条';
  assert.equal(notice.teamNoticeSender(text).label, 'm1 消息实现'); assert.equal(notice.teamNoticeSummary(text).summary, '2 条 · 第一条结论');
  for (const line of ['- msg-xxx · m1 消息实现 · 汇报 · 300 字', '- #12 m1 消息实现 · 汇报 · 300 字', '- [m1 消息实现] 2 条 · 300 字 · #12、#13']) {
    const msg = `【团队消息 · 2 条 · 原文已存文件】\n${line}\n原文：D:/a.md`;
    assert.equal(notice.isTeamMessage(msg), true); assert.equal(notice.teamNoticeSender(msg).label, 'm1 消息实现'); assert.match(notice.teamNoticeSummary(msg).summary, /原文已存文件/);
  }
  assert.equal(notice.isTeamMessage('【回到队里 · 新任务】返工'), true);
  assert.equal(notice.teamNoticeSummary('【回到队里 · 新任务】返工').kind, 'kickoff');
  assert.equal(notice.isTeamMessage('请看看'), false);
});
