'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareMemberWorktree, kickoffLines, mayNeedWorktree } = require('../main/team/member-worktree');
const { createTeamService } = require('../main/team/service');

const git = (args, cwd) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString().trim();
function fixtureRepo(repoName = 'proj') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-member-wt-'));
  const repo = path.join(root, repoName), wtRoot = path.join(root, 'wts');
  fs.mkdirSync(repo); fs.mkdirSync(wtRoot); fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.writeFileSync(path.join(repo, 'node_modules', 'marker.txt'), 'dep');
  fs.mkdirSync(path.join(repo, '.agents'));
  fs.writeFileSync(path.join(repo, '.agents', 'project.json'), JSON.stringify({ trunk: 'master', worktreeRoot: wtRoot }));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  git(['init', '-q'], repo);
  git(['checkout', '-q', '-b', 'master'], repo);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], repo);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], repo);
  return { root, repo, wtRoot };
}
// 先摘目录链接再删，避免递归删除穿透到链接目标。
function cleanup(root) {
  for (const base of [path.join(root, 'wts'), root]) {
    for (const name of fs.existsSync(base) ? fs.readdirSync(base) : []) {
      try { fs.unlinkSync(path.join(base, name, 'node_modules')); } catch {}
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

test('不同中文仓库名生成稳定、互不相同的 ASCII worktree 名称', async t => {
  const slugs = [];
  for (const name of ['中文甲', '中文乙', 'mixed-中文']) {
    const { root, repo } = fixtureRepo(name);
    t.after(() => cleanup(root));
    const now = new Date(2026, 10, 24, 12).getTime();
    const first = await prepareMemberWorktree({ cwd: repo, memberId: 'm1', leadSid: 'lead-id', now });
    const again = await prepareMemberWorktree({ cwd: repo, memberId: 'm2', leadSid: 'lead-id', now });
    assert.ok(first && !first.error, JSON.stringify(first));
    assert.ok(again && !again.error, JSON.stringify(again));
    const slug = path.basename(first.path).replace(/^\d{8}-/, '').replace(/-m1-leadid$/, '');
    assert.match(slug, /^[A-Za-z0-9._-]+-[a-f0-9]{8}$/);
    assert.equal(path.basename(again.path), `20261124-${slug}-m2-leadid`);
    slugs.push(slug);
  }
  assert.equal(new Set(slugs).size, 3);
});

test('仓库主目录：在 worktreeRoot 下建 worktree、分支从主干拉、node_modules 挂链接；撞名加后缀', async t => {
  const { root, repo, wtRoot } = fixtureRepo();
  t.after(() => cleanup(root));
  const wt = await prepareMemberWorktree({ cwd: repo, memberId: 'm1', leadSid: 'abc123-lead', now: new Date(2026, 10, 23, 12).getTime() });
  assert.ok(wt && !wt.error, wt?.error);
  assert.equal(path.dirname(wt.path).toLowerCase(), path.resolve(wtRoot).toLowerCase());
  assert.equal(path.basename(wt.path), '20261123-proj-m1-abc123le');
  assert.equal(wt.branch, 'feat/team-20261123-abc123le-m1');
  assert.equal(wt.base, git(['rev-parse', 'master'], repo));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt.path), wt.branch);
  assert.deepEqual(wt.links, ['node_modules']);
  assert.equal(fs.readFileSync(path.join(wt.path, 'node_modules', 'marker.txt'), 'utf8'), 'dep');
  assert.match(kickoffLines(wt).join('\n'), /已替你建好独立 worktree/);
  // 已是 worktree、显式关闭、非 git 目录、只读：都不建
  assert.equal(await prepareMemberWorktree({ cwd: wt.path, memberId: 'm2', leadSid: 'x' }), null);
  assert.equal(await prepareMemberWorktree({ cwd: repo, memberId: 'm3', leadSid: 'x', enabled: false }), null);
  assert.equal(await prepareMemberWorktree({ cwd: wtRoot, memberId: 'm4', leadSid: 'x' }), null);
  assert.equal(await prepareMemberWorktree({ cwd: repo, memberId: 'm5', leadSid: 'x', access: 'read' }), null);
  assert.equal(mayNeedWorktree({ cwd: wtRoot }), false);
  assert.equal(mayNeedWorktree({ cwd: repo }), true);
  const again = await prepareMemberWorktree({ cwd: repo, memberId: 'm1', leadSid: 'abc123-lead', now: new Date(2026, 10, 23, 12).getTime() });
  assert.ok(again && !again.error, again?.error);
  assert.match(path.basename(again.path), /-2$/); assert.match(again.branch, /-2$/);
  assert.match(kickoffLines({ error: '磁盘满', repo }).join('\n'), /没能替你建独立 worktree/);
});

function harness(t, leadCwd, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-team-wt-svc-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const sessions = new Map([['lead-0001', { id: 'lead-0001', kind: 'codeagent', title: '负责人', cwd: leadCwd, status: 'idle' }]]);
  const created = [], prompts = [];
  let n = 0;
  const service = createTeamService({
    getHubDataDir: () => dataDir, getConfig: () => ({}), autoApproveLeadsDefault: true, logger: { warn() {} },
    sessionManager: { getSession: id => sessions.get(id) || null, isAgentTurnActive: () => false },
    listAccounts: () => ({ recommendedId: 'pool-a', rows: [{ id: 'pool-a', usable: true, models: ['GLM-5.2'], modelsAuthoritative: true }] }),
    createSession: async request => { created.push(request.opts.cwd); const id = `member-${++n}xxx`; const s = { id, kind: 'codeagent', title: request.opts.title, status: 'idle', cwd: request.opts.cwd }; sessions.set(id, s); return s; },
    submitPrompt: async (sid, text) => { prompts.push({ sid, text: String(text) }); return { ok: true }; },
    commandPath: () => 'C:/hub/team/hub-team.cmd', ...extra,
  });
  t.after(() => { service.freeze(); service.stop(); });
  const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setImmediate(r)); await service.flush('lead-0001'); } };
  return { service, sessions, created, prompts, settle };
}

test('一句话组队：负责人开在仓库主目录，成员各自开在 Hub 建好的 worktree 里，开工消息和 status 都写明', async t => {
  const { root, repo } = fixtureRepo();
  t.after(() => cleanup(root));
  const h = harness(t, repo);
  const r = await h.service.invoke('lead-0001', 'propose', { goal: 'g', members: [{ role: '前端', task: 't1' }, { role: '后端', task: 't2' }, { role: '文档', task: 't3', worktree: false }] });
  assert.equal(r.status, 'approved');
  assert.equal(h.created.length, 3);
  assert.notEqual(h.created[0], h.created[1]);
  assert.ok(h.created.slice(0, 2).every(p => /-m[12]-lead0001$/.test(p) && fs.existsSync(p)), h.created.join(' | '));
  assert.equal(h.created[2], repo);
  await h.settle();
  const st = await h.service.invoke('lead-0001', 'status', {});
  const m1 = st.members.find(m => m.memberId === 'm1');
  assert.equal(m1.worktree.path, h.created[0]); assert.match(m1.worktree.branch, /^feat\/team-\d{8}-lead0001-m1$/);
  assert.equal(st.members.find(m => m.memberId === 'm3').worktree, undefined);
  const kick = h.prompts.find(p => p.sid === 'member-1xxx' && /组队开工/.test(p.text));
  assert.ok(kick, 'm1 收到开工消息');
  assert.ok(kick.text.includes(h.created[0]), kick.text.slice(0, 400));
});

test('工作目录经目录链接（或短文件名）指向仓库主目录：照样认成主目录并建 worktree', async t => {
  const { root, repo } = fixtureRepo();
  const link = path.join(root, 'link-to-proj');
  fs.symlinkSync(repo, link, 'junction');
  t.after(() => { try { fs.unlinkSync(link); } catch {} cleanup(root); });
  const wt = await prepareMemberWorktree({ cwd: link, memberId: 'm1', leadSid: 'lead-x' });
  assert.ok(wt && !wt.error, JSON.stringify(wt));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt.path), wt.branch);
});

test('负责人目录不是 git 仓库：照旧开在原目录，不起 git 进程', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-team-plain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = harness(t, dir);
  const r = await h.service.invoke('lead-0001', 'propose', { goal: 'g', members: [{ role: '实现', task: 't' }] });
  assert.equal(r.status, 'approved');
  assert.deepEqual(h.created, [dir]);
  const st = await h.service.invoke('lead-0001', 'status', {});
  assert.equal(st.members.find(m => m.memberId === 'm1').worktree, undefined);
  assert.equal(st.members.find(m => m.memberId === 'm1').worktreeError, undefined);
});

test('worktree 建失败：成员照常开工，status 给 worktreeError，开工消息说明原因', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-team-wtfail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = harness(t, dir, { prepareWorktree: async ({ cwd }) => ({ error: '磁盘满', repo: cwd }) });
  await h.service.invoke('lead-0001', 'propose', { goal: 'g', members: [{ role: '实现', task: 't' }] });
  await h.settle();
  assert.deepEqual(h.created, [dir]);
  const st = await h.service.invoke('lead-0001', 'status', {});
  assert.equal(st.members.find(m => m.memberId === 'm1').worktreeError, '磁盘满');
  assert.ok(h.prompts.some(p => /没能替你建独立 worktree（磁盘满）/.test(p.text)));
});

test('status 给侧栏标红的成员报错：连接断开写进 error，正常成员没有该字段', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-team-err-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = harness(t, dir);
  await h.service.invoke('lead-0001', 'propose', { goal: 'g', members: [{ role: 'a', task: 't' }, { role: 'b', task: 't' }] });
  h.sessions.get('member-1xxx').nativeRuntime = { connection: 'disconnected', reason: '模型通道连不上' };
  const st = await h.service.invoke('lead-0001', 'status', {});
  assert.equal(st.members.find(m => m.memberId === 'm1').error, '连接异常：模型通道连不上');
  assert.equal(st.members.find(m => m.memberId === 'm2').error, undefined);
});
