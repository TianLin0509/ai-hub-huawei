'use strict';
// R64（2026-11-27 群反馈「分身的工作目录不是可信区，不给用 codeagent 的模型」）：
// 公司 CodeAgent 按启动目录管控外部模型（Q-1128-09 公司侧日志核实：git remote 指向公司代码平台按仓库策略，普通文件夹退回部门策略）。
// 分身被拦下时，沿用本人在主页开过 CodeAgent 的公司代码仓库作启动目录，自己的文件经 --add-dir 带上；找不到就给「选公司代码仓库目录」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('../core/avatar/trusted-cwd');
const { AgentSessions, normalizeFailure } = require('../core/avatar/agent-session');
const { FleetService } = require('../core/avatar/fleet');
const welink = require('../core/company-assistant/welink');

const fakeGit = map => (cmd, args) => { assert.equal(cmd, 'git'); const url = map[args[1]]; if (!url) throw new Error('not a git repo'); return `remote.origin.url ${url}\n`; };
const always = () => true;

test('沿用主页的代码仓库：只看本人手动开的 CodeAgent 会话，按最近使用取第一个公司代码仓库', () => {
  const run = fakeGit({ 'D:/repo-a': 'https://codehub-y.example.com/dept/a.git', 'D:/gh': 'https://github.com/x/y.git', 'D:/bg': 'https://codehub.example.com/x/bg.git' });
  const sessions = [
    { kind: 'codeagent', cwd: 'D:/bg', purpose: 'avatar-agent' },          // 后台会话不算
    { kind: 'claude', cwd: 'D:/bg' },                                        // 不是 CodeAgent
    { kind: 'codeagent', cwd: 'D:/gh' },                                     // 不是公司代码平台
    { kind: 'codeagent', cwd: 'D:/plain' },                                  // 不是 git 仓库
    { kind: 'codeagent-resume', cwd: 'D:/repo-a' },
  ];
  assert.equal(T.findTrustedCwd(sessions, { run, exists: always }), 'D:/repo-a');
  assert.equal(T.findTrustedCwd(sessions.slice(0, 4), { run, exists: always }), '');
  assert.equal(T.findTrustedCwd(sessions, { run, exists: p => p !== 'D:/repo-a' }), '', '目录已经不在了就不用');
  assert.equal(T.isCompanyRepo('D:/repo-a', { run, exists: always }), true);
  assert.equal(T.isCompanyRepo('D:/gh', { run, exists: always }), false);
});

test('屏幕报错分类：外部模型管控、不在可信仓认出来，别的不算', () => {
  assert.equal(T.dirPolicyKind({ message: '部门已启用外部模型管控，外部模型不可用。请联系部门管理员关闭管控，或申请开通内部模型。 [SessionRequestError_002]' }), 'external');
  assert.equal(T.dirPolicyKind({ message: '当前目录不在公司可信仓', trustedRepo: true }), 'repo');
  assert.equal(T.dirPolicyKind({ message: '模型已下线', modelRevoked: true }), '');
  assert.equal(T.dirPolicyKind(null), '');
});

test('报错说人话：还在分身自己的目录里给「选公司代码仓库目录」；已在代码仓库里还拦就只让换内部模型', () => {
  const away = normalizeFailure(Object.assign(new Error('部门已启用外部模型管控'), { code: 'AVATAR_DIR_POLICY', dirPolicy: 'external', inRepo: false }));
  assert.equal(away.code, 'external_model_blocked');
  assert.deepEqual(away.actions.map(a => a.kind), ['pick_trusted_cwd', 'open_account_card']);
  assert.match(away.headline, /不在公司代码仓库里/);
  const inRepo = normalizeFailure(Object.assign(new Error('x'), { code: 'AVATAR_DIR_POLICY', dirPolicy: 'repo', inRepo: true }));
  assert.equal(inRepo.code, 'trusted_repo_required');
  assert.deepEqual(inRepo.actions.map(a => a.kind), ['open_account_card']);
});

function sessionsHarness(extra = {}) {
  const world = { created: [], sessions: new Map(), prompts: [], screen: null, final: null, now: 1000 };
  const s = new AgentSessions({ now: () => world.now, pollMs: 1,
    createSession: async (kind, opts) => { world.created.push(opts); world.sessions.set(opts.id, { id: opts.id, status: 'idle', cwd: opts.cwd }); return { id: opts.id }; },
    getSession: id => world.sessions.get(id), closeSession: async id => { world.sessions.delete(id); },
    sendPrompt: async (id, text) => { world.prompts.push(text); return { ok: true }; },
    lastFinal: () => world.final, screenError: () => world.screen, ...extra });
  return { s, world };
}

test('启动目录换成代码仓库：会话开在仓库里，分身目录经 --add-dir 带上；目录变了重开，没变复用；题目按完整路径指过去', async () => {
  const { s, world } = sessionsHarness();
  const av = { id: 'a', name: '盯消息', backend: { account: 'personal', model: '' }, sources: [] };
  const plain = await s.ensure(av, null, 'C:/hub/avatar/a/work');
  assert.equal(world.created[0].cwd, 'C:/hub/avatar/a/work');
  assert.equal(world.created[0].addDirs, undefined);
  assert.equal(plain.cwd, undefined);
  assert.equal(await s.ensure(av, plain, 'C:/hub/avatar/a/work'), plain, '没换目录就复用');
  const repo = await s.ensure(av, plain, 'C:/hub/avatar/a/work', { runCwd: 'D:/repo-a' });
  assert.notEqual(repo.id, plain.id);
  assert.equal(world.created[1].cwd, 'D:/repo-a');
  assert.deepEqual(world.created[1].addDirs, ['C:/hub/avatar/a/work']);
  assert.equal(repo.cwd, 'D:/repo-a');
  assert.equal(await s.ensure(av, repo, 'C:/hub/avatar/a/work', { runCwd: 'D:/repo-a' }), repo);
  world.final = null;
  const job = s.ask(repo, 'task-1.json', { dir: 'C:/hub/avatar/a/work', timeoutMs: 200 });
  await new Promise(r => setTimeout(r, 5));
  const marker = /\[分身回执:[^\]]+\]/.exec(world.prompts[0])[0];
  world.final = { text: '[]\n' + marker };
  assert.equal(await job, '[]');
  assert.ok(world.prompts[0].includes(path.join('C:/hub/avatar/a/work', 'rules.md')));
  assert.ok(world.prompts[0].includes(path.join('C:/hub/avatar/a/work', 'task-1.json')));
});

test('会话里报「外部模型管控」时立刻收，不干等 5 分钟；在代码仓库里报的标 inRepo', async () => {
  const { s, world } = sessionsHarness();
  const av = { id: 'a', name: '盯消息', backend: { account: 'personal', model: 'ext-model' }, sources: [] };
  const plain = await s.ensure(av, null, 'C:/w');
  world.screen = { at: 900, message: '旧报错' };   // 这一问之前的不算
  const job = s.ask(plain, 'task-1.json', { dir: 'C:/w', timeoutMs: 60000 });
  await new Promise(r => setTimeout(r, 5));
  world.now = 2000; world.screen = { at: 2000, message: '部门已启用外部模型管控，外部模型不可用。 [SessionRequestError_002]' };
  await assert.rejects(job, e => e.code === 'AVATAR_DIR_POLICY' && e.dirPolicy === 'external' && e.inRepo === false && e.restart === true);
  const repo = await s.ensure(av, null, 'C:/w', { runCwd: 'D:/repo' });
  const job2 = s.ask(repo, 'task-2.json', { dir: 'C:/w', timeoutMs: 60000 });
  await new Promise(r => setTimeout(r, 5));
  world.now = 3000; world.screen = { at: 3000, message: '当前目录不在公司可信仓', trustedRepo: true };
  await assert.rejects(job2, e => e.code === 'AVATAR_DIR_POLICY' && e.dirPolicy === 'repo' && e.inRepo === true);
});

// 整条巡检：第一次在分身目录里被管控拦下 → 自动换到主页用过的代码仓库 → 重来成功；草稿照常交给本人确认。
test('巡检：被外部模型管控拦下后自动沿用主页的代码仓库重来，草稿照常出来；状态里写明启动目录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-r64-cwd-')), repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-r64-repo-'));
  const ME = 'm00000001', G = { id: 'g1', name: '项目群', group: true };
  const world = { now: Date.UTC(2026, 10, 28, 3, 0, 0), messages: {}, created: [], sessions: new Map(), prompts: [], screen: null, final: null, lookups: 0 };
  const assistant = {
    snapshot: () => ({ at: world.now, login: { ok: true, uid: ME }, conversations: [G], messages: world.messages }),
    settings: () => ({ myName: '测试员' }), auth: { status: () => ({ state: 'online', login: { ok: true } }) },
    archive: { owner: () => ME, read: () => [], loadIndex: () => ({ names: {} }) },
    welink: async (args, opts = {}) => { welink.checkArgs(args, opts); if (args[1] === 'query-history-message') return { code: 0, stdout: JSON.stringify({ chatInfo: [] }), stderr: '' }; return { code: 0, stdout: '{}', stderr: '' }; },
  };
  const service = new FleetService({ dataDir: dir, getAssistant: () => assistant, noTimer: true, now: () => world.now, pollMs: 1,
    listBackends: () => ({ rows: [{ id: 'auto', usable: true, models: [] }] }),
    createSession: async (kind, opts) => { world.created.push(opts); world.sessions.set(opts.id, { id: opts.id, status: 'idle', cwd: opts.cwd, addDirs: opts.addDirs }); return { id: opts.id }; },
    getSession: id => world.sessions.get(id), closeSession: async id => { world.sessions.delete(id); },
    screenError: id => (world.sessions.get(id)?.cwd === repoDir ? null : world.screen),
    findTrustedCwd: () => { world.lookups += 1; return repoDir; },
    sendPrompt: async (id, text) => {
      world.prompts.push(text);
      const meta = world.sessions.get(id);
      if (meta.cwd !== repoDir) { world.screen = { at: world.now, message: '部门已启用外部模型管控，外部模型不可用。 [SessionRequestError_002]' }; return { ok: true }; }
      const file = /处理 (.+?task-\d+\.json)/.exec(text)[1], task = JSON.parse(fs.readFileSync(file, 'utf8')), marker = /\[分身回执:[^\]]+\]/.exec(text)[0];
      world.final = { text: JSON.stringify(task.items.map(i => ({ id: i.id, action: 'remind', why: '点名要你确认排期', confidence: 80 }))) + '\n' + marker };
      return { ok: true };
    },
    lastFinal: () => world.final });
  const settle = async () => { for (let i = 0; i < 400 && (service.running.size || service.ticking); i += 1) await new Promise(r => setTimeout(r, 2)); };
  try {
    const r = await service.create({ tpl: 'watch', targets: [{ id: 'g1', name: '项目群', type: 'group' }] }); await settle();
    const id = r.createdId;
    world.now += 60000;
    world.messages.g1 = [{ key: '1', conv: 'g1', account: 'zhang', sender: '张三', mine: false, text: '@测试员 明天之前确认一下排期', at: world.now, atMe: true, contentType: 'TEXT_MSG' }];
    await settle(); await service.tick(); await settle();
    for (let i = 0; i < 5 && !service.status().items.length; i += 1) { await service.tick(); await settle(); }
    const st = service.status();
    assert.equal(world.lookups, 1, '只在被拦下时找一次');
    assert.equal(st.workCwd.path, repoDir); assert.equal(st.workCwd.source, 'auto');
    const inRepo = world.created.filter(o => o.cwd === repoDir);
    assert.ok(inRepo.length >= 1, '重开在代码仓库里');
    assert.ok(inRepo[0].addDirs.some(d => d.endsWith(path.join(id, 'work'))), '分身目录经 --add-dir 带上');
    assert.equal(st.items.length, 1); assert.equal(st.items[0].state, 'remind');
    assert.equal(st.avatars[0].state.failure, null);
    // 恢复默认：下一轮回到分身自己的目录
    const back = service.setWorkCwd('');
    assert.equal(back.workCwd, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(repoDir, { recursive: true, force: true }); }
});

// ---- 审查 1 返修（P1 / P2） ----
function fleetHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-r64-fix-')), repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-r64-fixrepo-'));
  const ME = 'm00000001', G = { id: 'g1', name: '项目群', group: true };
  const world = { now: Date.UTC(2026, 10, 28, 3, 0, 0), messages: {}, created: [], sessions: new Map(), prompts: [], screen: null, final: null, lookups: 0 };
  const assistant = {
    snapshot: () => ({ at: world.now, login: { ok: true, uid: ME }, conversations: [G], messages: world.messages }),
    settings: () => ({ myName: '测试员' }), auth: { status: () => ({ state: 'online', login: { ok: true } }) },
    archive: { owner: () => ME, read: () => [], loadIndex: () => ({ names: {} }) },
    welink: async (args, opts = {}) => { welink.checkArgs(args, opts); if (args[1] === 'query-history-message') return { code: 0, stdout: JSON.stringify({ chatInfo: [] }), stderr: '' }; return { code: 0, stdout: '{}', stderr: '' }; },
  };
  const service = new FleetService({ dataDir: dir, getAssistant: () => assistant, noTimer: true, now: () => world.now, pollMs: 1,
    listBackends: () => ({ rows: [{ id: 'auto', usable: true, models: [] }, { id: 'p1', label: '号 1', pool: true, usable: true, models: ['GLM-5.2-WX'], activeSessions: 0 }] }),
    createSession: async (kind, opts) => { world.created.push(opts); world.sessions.set(opts.id, { id: opts.id, status: 'idle', cwd: opts.cwd, addDirs: opts.addDirs }); return { id: opts.id }; },
    getSession: id => world.sessions.get(id), closeSession: async id => { world.sessions.delete(id); },
    screenError: id => (world.sessions.get(id)?.cwd === repoDir ? null : world.screen),
    findTrustedCwd: () => { world.lookups += 1; return repoDir; },
    sendPrompt: async (id, text) => {
      world.prompts.push(text);
      if (world.sessions.get(id).cwd !== repoDir) { world.screen = { at: world.now, message: '部门已启用外部模型管控，外部模型不可用。 [SessionRequestError_002]' }; return { ok: true }; }
      const file = /处理 (.+?task-[\w-]+\.json)/.exec(text)[1], task = JSON.parse(fs.readFileSync(file, 'utf8')), marker = /\[分身回执:[^\]]+\]/.exec(text)[0];
      world.final = { text: JSON.stringify(task.items.map(i => ({ id: i.id, action: 'draft', reply: '收到，我确认下排期', basis: '最近的对话', why: '点名要你确认', confidence: 80 }))) + '\n' + marker };
      return { ok: true };
    },
    lastFinal: () => world.final });
  const settle = async () => { for (let i = 0; i < 400 && (service.running.size || service.ticking); i += 1) await new Promise(r => setTimeout(r, 2)); };
  return { service, world, repoDir, settle, cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(repoDir, { recursive: true, force: true }); } };
}

test('审查 P1：新建后先试答、巡检还没被拦过时，试答撞上外部模型管控也自动沿用主页的代码仓库重答一次', async () => {
  const h = fleetHarness();
  try {
    const r = await h.service.create({ tpl: 'watch', targets: [{ id: 'g1', name: '项目群', type: 'group' }] }); await h.settle();
    assert.equal(h.service.status().workCwd, null, '试答之前还没换过目录');
    const out = await h.service.runTryout(r.createdId, { question: '明天之前能确认排期吗？', kind: 'own' });
    assert.equal(out.ok, true, JSON.stringify(out.failure || out.error));
    assert.equal(h.world.lookups, 1);
    assert.equal(h.service.status().workCwd.path, h.repoDir);
    assert.ok(h.world.created.some(o => o.cwd === h.repoDir), '重答开在代码仓库里');
    assert.ok(['draft', 'remind', 'skip'].includes(out.result.action), '试答拿到了模型的判断');
  } finally { h.cleanup(); }
});

test('审查 P1：换到代码仓库后就地重跑这一批，调用方（纠错重答等）等到的是重跑后的结果', async () => {
  const h = fleetHarness();
  try {
    const r = await h.service.create({ tpl: 'watch', targets: [{ id: 'g1', name: '项目群', type: 'group' }] }); await h.settle();
    h.service.pump = () => {}; // 只看 runAvatar 自己：不让巡检顺手把事项跑掉
    h.world.now += 60000;
    h.world.messages.g1 = [{ key: '1', conv: 'g1', account: 'zhang', sender: '张三', mine: false, text: '@测试员 明天之前确认一下排期', at: h.world.now, atMe: true, contentType: 'TEXT_MSG' }];
    await h.service.tick(); await h.settle();
    const owner = h.service.owner(), before = Object.values(h.service.state(owner, r.createdId).items);
    assert.equal(before.length, 1); assert.equal(before[0].state, 'new');
    await h.service.runAvatar(owner, r.createdId, { itemId: before[0].id });
    const after = h.service.state(owner, r.createdId).items[before[0].id];
    assert.equal(after.state, 'remind', '返回时已经是重跑后的结果（盯消息只提醒），不是还在排队');
    assert.ok(after.draftedAt, '模型已经处理过这条');
    assert.equal(h.service.status().workCwd.path, h.repoDir);
  } finally { h.cleanup(); }
});

test('审查 P2：分身后台会话的屏幕报错不走前台的模型撤销恢复（不弹选模型、不挂常驻横幅）；页面选好目录后撤掉试答里的同类报错', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = main.slice(main.indexOf('async function recoverCodeAgentModelRevocation'), main.indexOf('async function recoverCodeAgentModelRevocation') + 600);
  assert.match(fn, /session\.purpose === 'avatar-agent' \|\| !modelRevoked/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'avatar-page.js'), 'utf8');
  const pick = page.slice(page.indexOf('async function pickWorkCwd'), page.indexOf('async function pickWorkCwd') + 700);
  assert.match(pick, /for \(const t of Object\.values\(tryouts\)\) if \(\['trusted_repo_required', 'external_model_blocked'\]\.includes\(t\?\.failure\?\.code\)\) t\.failure = null;/);
});
