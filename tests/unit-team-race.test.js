'use strict';
// 一张 race 计划招多位 CodeAgent 成员做同一道题；交付由 Hub 收着，交齐后只叫醒负责人一次、给成绩单；
// 个人账号超过同时干活上限要提示排队；没有 .agents/project.json 测试闸门时成绩单只比提交与改动规模。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTeamService } = require('../main/team/service');
const TeamRace = require('../main/team/race');
const { PERSONAL_ACCOUNT_ID } = require('../main/team/codeagent-accounts');

const RELEASE_AFTER_ACK_MS = 60 * 1000;

async function harness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-race-'));
  const sessions = new Map([['lead-0001', { id: 'lead-0001', title: '总控', kind: 'codeagent', cwd: dataDir, status: 'idle' }]]);
  const resumable = new Set();
  const sent = [], clock = { t: 1_800_000_000_000 };
  let n = 0;
  const service = createTeamService({
    getHubDataDir: () => dataDir, getConfig: () => ({ team: {} }), autoApproveLeadsDefault: true, now: () => clock.t, logger: { warn() {} },
    isResumable: id => resumable.has(id) && !sessions.has(id),
    sessionManager: {
      getSession: id => sessions.get(id) || null, isAgentTurnActive: () => false, getGroupChatLastActivity: () => 0,
      suspendSession: id => { sessions.delete(id); resumable.add(id); return { ok: true }; },
    },
    createSession: async request => { const id = `member-${++n}xx`; const s = { id, kind: 'codeagent', title: request.opts.title, status: 'idle' }; sessions.set(id, s); resumable.add(id); return s; },
    submitPrompt: async (sessionId, text) => { sent.push({ sessionId, text }); return { ok: true }; },
    listAccounts: () => ({ recommendedId: 'acc-a', rows: [
      { id: 'acc-a', usable: true, models: ['GLM-5.2', 'MiniMax-M3'], modelsAuthoritative: true },
      { id: 'acc-b', usable: true, models: ['GLM-5.2', 'MiniMax-M3'], modelsAuthoritative: true },
      { id: PERSONAL_ACCOUNT_ID, personal: true, usable: true, models: ['GLM-5.2'] }] }),
    commandPath: () => 'hub-team.cmd',
  });
  const settle = async () => { for (let i = 0; i < 8; i++) { await new Promise(r => setImmediate(r)); await service.flush('lead-0001'); } };
  const until = async (pred, label) => { const end = Date.now() + 20000; while (Date.now() < end) { await settle(); if (pred()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('timeout ' + label); };
  return { service, sent, clock, settle, until, dataDir, toLead: () => sent.filter(x => x.sessionId === 'lead-0001'),
    close: () => { service.freeze(); service.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const racePlan = members => ({ goal: '修登录竞态', race: true, task: '修复 login.js 的竞态并补测试', members });
const two = () => [{ account: 'acc-a', model: 'GLM-5.2', title: '甲' }, { account: 'acc-b', model: 'MiniMax-M3', title: '乙' }];

test('赛马计划校验：要同一道题、至少 2 人', async () => {
  const h = await harness();
  try {
    await assert.rejects(h.service.invoke('lead-0001', 'propose', { goal: 'g', race: true, members: two() }), /要写 task/);
    await assert.rejects(h.service.invoke('lead-0001', 'propose', racePlan([{ account: 'acc-a' }])), /至少 2 位/);
  } finally { h.close(); }
});

test('参赛者同题开工；交付由 Hub 收着，交齐后只叫醒负责人一次并给成绩单', async () => {
  const h = await harness();
  try {
    const r = await h.service.invoke('lead-0001', 'propose', racePlan(two()));
    assert.match(r.note, /自动批准/);
    assert.equal(r.raceQueueNote, undefined, '没用个人账号不提示排队');
    await h.settle();
    const kick = h.sent.filter(x => x.sessionId !== 'lead-0001');
    assert.equal(kick.length, 2);
    for (const k of kick) { assert.match(k.text, /修复 login\.js 的竞态/); assert.match(k.text, /这是一场赛马/); assert.match(k.text, /CANDIDATE:/); }
    const before = h.toLead().length;
    const d1 = await h.service.invoke('member-1xx', 'send', { to: 'lead', deliver: true, message: '方案甲完成，非代码任务成品见 X' });
    assert.equal(d1.status, 'held'); assert.match(d1.note, /还有 1 位/);
    h.clock.t += 5 * 60 * 1000; await h.settle();
    assert.equal(h.toLead().length, before, '一人先交不叫醒负责人');
    const d2 = await h.service.invoke('member-2xx', 'send', { to: 'lead', deliver: true, message: '方案乙完成' });
    assert.match(d2.note, /最后一位/);
    await h.until(() => h.toLead().length === before + 1, 'race result');
    const msg = h.toLead().at(-1).text;
    assert.match(msg, /【赛马结果 · 计划 /); assert.match(msg, /2\/2 位参赛者已交付/);
    const card = msg.match(/成绩单：(\S+赛马成绩单\.md)/)[1];
    assert(fs.existsSync(card)); assert.match(fs.readFileSync(card, 'utf8'), /m1 甲（GLM-5\.2）[\s\S]*m2 乙（MiniMax-M3）/);
    assert.doesNotMatch(msg, /方案甲完成/, '交付正文不灌进负责人上下文，只给交付文件路径');
    const team = h.service.listTeams()[0];
    assert.equal(team.plans[0].race, true); assert.equal(team.plans[0].raceState, 'done');
    const again = await h.service.invoke('member-1xx', 'send', { to: 'lead', deliver: true, message: '已按指令合入' });
    assert.notEqual(again.status, 'held', '赛马结束后的交付按普通交付送达');
  } finally { h.close(); }
});

test('个人账号参赛者超过同时干活上限：提交时提示排队', async () => {
  const h = await harness();
  try {
    const r = await h.service.invoke('lead-0001', 'propose', racePlan(Array.from({ length: 4 }, (_, i) => ({ account: PERSONAL_ACCOUNT_ID, title: '个人' + i }))));
    assert.match(r.raceQueueNote, /4 位参赛者用个人账号，个人账号同时最多 3 位在干活，其余 1 位排队/);
    assert.match(r.note, /排队/);
  } finally { h.close(); }
});

test('有人被请离，其余交齐也出成绩单', async () => {
  const h = await harness();
  try {
    await h.service.invoke('lead-0001', 'propose', racePlan(two()));
    await h.settle();
    await h.service.invoke('lead-0001', 'dismiss', { memberId: 'm2' });
    await h.service.invoke('member-1xx', 'send', { to: 'lead', deliver: true, message: '完成' });
    await h.until(() => h.toLead().some(x => /【赛马结果/.test(x.text)), 'race with dismissal');
    assert.match(h.toLead().find(x => /【赛马结果/.test(x.text)).text, /1\/2 位参赛者已交付/);
  } finally { h.close(); }
});

test('赛马未出结果时返工：旧交付作废，等重新交付再出成绩单', async () => {
  const h = await harness();
  try {
    await h.service.invoke('lead-0001', 'propose', racePlan(two()));
    await h.settle();
    await h.service.invoke('member-1xx', 'send', { to: 'lead', deliver: true, message: '第一版' });
    await h.service.invoke('lead-0001', 'send', { to: 'm1', message: '第一版漏了边界情况，返工' });
    await h.service.invoke('member-2xx', 'send', { to: 'lead', deliver: true, message: '乙完成' });
    h.clock.t += 5 * 60 * 1000; await h.settle();
    assert(!h.toLead().some(x => /【赛马结果/.test(x.text)), 'm1 返工中，不提前出成绩单');
    await h.service.invoke('member-1xx', 'send', { to: 'lead', deliver: true, message: '第二版' });
    await h.until(() => h.toLead().some(x => /【赛马结果/.test(x.text)), 'race after rework');
    const card = h.toLead().find(x => /【赛马结果/.test(x.text)).text;
    const m1 = card.split('\n').find(l => /^- \S+ m1/.test(l)).match(/交付 (\S+\.md)/)[1];
    assert.equal(fs.readFileSync(m1, 'utf8'), '第二版');
  } finally { h.close(); }
});

test('第二场赛马也全部新招参赛者，不被自动叫回挪走；结果送达后参赛者按常规离队', async () => {
  const h = await harness();
  try {
    await h.service.invoke('lead-0001', 'propose', racePlan(two()));
    await h.settle();
    for (const sid of ['member-1xx', 'member-2xx']) await h.service.invoke(sid, 'send', { to: 'lead', deliver: true, message: '完成' });
    await h.until(() => h.toLead().some(x => /【赛马结果/.test(x.text)), 'first race');
    h.clock.t += RELEASE_AFTER_ACK_MS + 1000; h.service.watch(); await h.settle();
    assert(h.service.listTeams()[0].members.every(m => m.status === 'dismissed'), '赛马结果送达、负责人处理完后参赛者离队');
    const r = await h.service.invoke('lead-0001', 'propose', { goal: '继续修登录竞态', race: true, task: '继续修复 login.js 的竞态，返工上一版', members: two() });
    assert.equal((r.recalled || []).length, 0);
    await h.settle();
    assert.deepEqual(h.service.listTeams()[0].members.map(m => m.memberId), ['m1', 'm2', 'm3', 'm4'], '两位参赛者都是新招的');
  } finally { h.close(); }
});

test('掉队兜底：首位交付满时限后先出成绩单，并点名没交的人', () => {
  const plan = { id: 'p1', race: true };
  const team = { members: [{ memberId: 'm1', planId: 'p1', status: 'active', raceDeliveryPath: 'a.md', raceDeliveredAt: 1000 },
    { memberId: 'm2', planId: 'p1', status: 'active' }] };
  assert.equal(TeamRace.ready(team, plan, { now: 1000 + 10 * 60000, stragglerMs: 45 * 60000 }), false);
  assert.equal(TeamRace.ready(team, plan, { now: 1000 + 45 * 60000, stragglerMs: 45 * 60000 }), true);
  assert.deepEqual(TeamRace.stragglers(team, plan).map(m => m.memberId), ['m2']);
  const text = TeamRace.leadMessage({ plan, file: 'card.md', rows: [{ name: 'm1', deliveryPath: 'a.md', gate: { state: 'skipped' } }, { name: 'm2', gate: { state: 'skipped' } }], cmd: 'hub-team', late: ['m2'], stragglerMin: 45 });
  assert.match(text, /m2 在首位交付 45 分钟后仍未交付/);
  assert.equal(TeamRace.ready({ members: [{ memberId: 'm2', planId: 'p1', status: 'active' }] }, plan, { now: 1e12 }), false);
});

// 成绩单：真实 git 仓库与 worktree。没有 .agents/project.json 时不跑测试，但核对提交并统计改动规模；有测试命令时照跑。
test('成绩单：没有测试闸门只比提交与改动规模；有闸门时在候选提交上跑测试', async () => {
  const Race = require('../main/groupchat/race-scorecard');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-race-card-'));
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  try {
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
    g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'user.email', 't@example.com'); g(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'base');
    const cand = (name, files, withGate) => {
      const wt = path.join(root, name); g(repo, 'worktree', 'add', '-q', '-b', name, wt);
      for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(wt, f), text);
      if (withGate) { fs.mkdirSync(path.join(wt, '.agents')); fs.writeFileSync(path.join(wt, '.agents', 'project.json'), JSON.stringify({ trunk: 'main', test: ['node -e "process.exit(0)"'] })); }
      g(wt, 'add', '.'); g(wt, 'commit', '-qm', name);
      const delivery = path.join(root, name + '.md');
      fs.writeFileSync(delivery, `做完了\nCANDIDATE: ${wt} ${g(wt, 'rev-parse', 'HEAD')}\n`);
      return delivery;
    };
    const dA = cand('race-a', { 'a.txt': 'a\nb\n', 'b.txt': 'x\n' }, false);
    const dB = cand('race-b', { 'a.txt': 'z\n' }, true);
    const dir = path.join(root, 'card');
    const result = await Race.scorecard({ goal: '改 a', dir, entries: [
      { memberId: 'm1', name: 'm1 甲', deliveryPath: dA, elapsedMs: 120000 },
      { memberId: 'm2', name: 'm2 乙', deliveryPath: dB, elapsedMs: 60000 },
      { memberId: 'm3', name: 'm3 丙', deliveryPath: '', elapsedMs: 0 }] });
    const [a, b, c] = result.rows;
    assert.equal(a.stat.files.length, 2, '没有测试闸门也统计改动规模');
    assert.equal(a.stat.commits, 1);
    assert.equal(a.gate.state, 'skipped'); assert.match(a.gate.reason, /未声明测试命令/);
    assert.equal(b.gate.state, 'passed', '有测试命令时在候选提交上跑');
    assert.equal(b.stat.files.length, 2);
    assert.match(c.gate.reason, /没有交付/);
    assert.match(result.markdown, /a\.txt/, '两份都改了的文件列出来');
    // 候选目录有未提交改动：不认这份候选。
    fs.writeFileSync(path.join(root, 'race-a', 'a.txt'), 'dirty\n');
    const dirty = await Race.scorecard({ goal: '改 a', dir, entries: [{ memberId: 'm1', name: 'm1', deliveryPath: dA, elapsedMs: 1 }] });
    assert.match(dirty.rows[0].gate.reason, /未提交改动/);
    assert.equal(dirty.rows[0].stat, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// 审查建议 2、3（20261128-审查-race-m10-m4.md）。
test('Hub 关闭中止成绩单：不写半份成绩单、不发结果，抛出 cancelled 交给调用方保留「出分中」', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-race-cancel-'));
  try {
    const controller = new AbortController();
    const plan = { id: 'p1', race: true, task: 't' };
    const team = { members: [{ memberId: 'm1', planId: 'p1', status: 'active', raceDeliveryPath: 'a.md', raceDeliveredAt: 2 }] };
    let seen = null;
    const scorecard = async ({ signal }) => { seen = signal; controller.abort(); return { state: 'cancelled' }; };
    await assert.rejects(TeamRace.score({ team, plan, dir, signal: controller.signal, scorecard }), e => e.cancelled === true);
    assert.equal(seen, controller.signal, '取消信号透传到成绩单');
    assert.equal(fs.existsSync(path.join(dir, '赛马成绩单.md')), false, '不写半份成绩单');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('排队提示里的掉队时限跟着配置走', () => {
  const plan = { members: Array.from({ length: 4 }, () => ({ account: PERSONAL_ACCOUNT_ID })) };
  assert.match(TeamRace.personalQueueNote(plan, PERSONAL_ACCOUNT_ID, 3, 20 * 60000), /首位交付 20 分钟后/);
  assert.match(TeamRace.personalQueueNote(plan, PERSONAL_ACCOUNT_ID, 3), /首位交付 45 分钟后/);
});
