'use strict';
// 负责人提交 race 计划 → 自动批准建 2 位参赛者 → 两人各在真实 git worktree 提交并 --deliver → Hub 收齐后出成绩单，
// 负责人原生记录里只多出一条【赛马结果】；侧栏截图 1440 宽。
// 用法：node tests/e2e-team-race-cdp.js [--out 目录]
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pool = require('../core/codeagent-pool');
const { writeProbed } = require('../core/codeagent-model-probe');

const REPO = path.resolve(__dirname, '..');
const outIdx = process.argv.indexOf('--out');
const ART = path.resolve(outIdx > 0 ? process.argv[outIdx + 1] : path.join(REPO, 'artifacts', `team-race-${Date.now()}`));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-race-e2e-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal');
const CONTROL = path.join(ROOT, 'fixture-control'), LOG = path.join(ROOT, 'fixture.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
async function wait(fn, label, ms = 60000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(200); } throw Error(`Timeout ${label}${last ? ': ' + last.message : ''}`); }
const launches = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(v => v.configDir) : [];
function seed(dir, accountId, model) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId, expiresAt: Date.now() + 3600e3 } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model }));
  writeProbed(path.join(dir, 'hub-models.json'), { models: [model], defaultModel: model, source: 'test-fixture' });
}
const nativeTexts = sid => launches().filter(v => v.hubSession === sid).flatMap(v => {
  const file = path.join(v.configDir, 'projects', v.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${v.sessionId}.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(r => r.type === 'user').map(r => String(r.message?.content || '')) : [];
});

(async () => {
  for (const dir of [DATA, WORK, ART, CONTROL]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ team: { autoApproveLeads: true } }), 'utf8');
  const glm = 'GLM-5.2-WX-Auto';
  seed(PERSONAL, 'p-fixture', glm);
  const a = pool.addAccount(DATA, { note: '赛马甲' }); seed(pool.accountDir(DATA, a), 'a-fixture', glm);
  const b = pool.addAccount(DATA, { note: '赛马乙' }); seed(pool.accountDir(DATA, b), 'b-fixture', glm);
  // 候选仓库：两份真实 worktree、各一次提交；项目没有 .agents/project.json（公司仓库常见），成绩单只比提交与规模。
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const repo = path.join(ROOT, 'proj'); fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'user.email', 't@example.com'); g(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'login.js'), 'module.exports = () => 1;\n'); g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'base');
  const candidate = (name, files) => {
    const wt = path.join(ROOT, name); g(repo, 'worktree', 'add', '-q', '-b', name, wt);
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(wt, f), t);
    g(wt, 'add', '.'); g(wt, 'commit', '-qm', name);
    return `CANDIDATE: ${wt} ${g(wt, 'rev-parse', 'HEAD')}`;
  };
  const evidence = { checks: [], root: ROOT, artifacts: ART, model: 'none; local CodeAgent protocol fixture' };
  const ok = (label, condition = true) => { assert(condition, label); evidence.checks.push(label); console.log('PASS ' + label); };
  let hub, cdp, failure, seq = 0;
  const invoke = (channel, args) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
  const command = async (sid, args, fail = false) => {
    await wait(() => fs.existsSync(path.join(CONTROL, `${sid}.ready`)), 'fixture ready');
    const id = ++seq, request = path.join(CONTROL, `${sid}.request`), result = path.join(CONTROL, `${sid}.${id}.response`);
    fs.writeFileSync(request + '.tmp', JSON.stringify({ id, args })); fs.renameSync(request + '.tmp', request);
    await wait(() => fs.existsSync(result), `CLI ${args[0]}`);
    const r = JSON.parse(fs.readFileSync(result, 'utf8'));
    if (fail) { assert.notEqual(r.code, 0); return r.err; }
    assert.equal(r.code, 0, r.err || r.error); return JSON.parse(r.out);
  };
  const shot = async name => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(ART, `20261128-team-race-${name}.png`); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); return f; };
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), windowMode: 'hidden', label: 'team-race', extraEnv: {
      HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG, CODEAGENT_TEAM_FAKE_CONTROL_DIR: CONTROL,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'empty-scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'),
    } });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait(() => cdp.eval('!!window.__teamUi'), 'renderer ready');
    const lead = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title: '赛马验收负责人', codeagentAccount: 'pool', codeagentPoolPick: a, model: glm, codeagentModelPick: true } });
    ok('负责人是 CodeAgent 会话', !!lead?.id);
    const planFile = path.join(ROOT, 'race-plan.json');
    fs.writeFileSync(planFile, JSON.stringify({ goal: '修登录竞态', race: true, task: '修复 login.js 的竞态并补测试', members: [
      { account: a, model: glm, title: '赛马甲' }, { account: b, model: glm, title: '赛马乙' }] }));
    const plan = await command(lead.id, ['propose', '--plan-file', planFile]);
    ok('race 计划经 hub-team 提交并自动批准', plan.status === 'approved' && plan.created.length === 2);
    const team = await wait(async () => { const t = (await invoke('team:list')).result[0]; return t.members.length === 2 && t.members.every(m => m.status === 'active') && t; }, 'two racers');
    ok('团队计划标记为赛马', team.plans[0].race === true && /login\.js/.test(team.plans[0].task));
    for (const m of team.members) {
      await wait(() => nativeTexts(m.sid).some(t => t.includes('这是一场赛马') && t.includes('修复 login.js 的竞态') && t.includes('CANDIDATE:')), 'race kickoff ' + m.memberId);
    }
    ok('两位参赛者都收到同一道题和赛马规则');
    const leadBefore = nativeTexts(lead.id).length;
    const d1 = await command(team.members[0].sid, ['send', '--to', 'lead', '--deliver', '--message', `甲完成\n${candidate('race-a', { 'login.js': 'let busy=false;\nmodule.exports = () => 1;\n', 'login.test.js': 'ok\n' })}`]);
    ok('第一位交付由 Hub 收着', d1.status === 'held' && /还有 1 位/.test(d1.note));
    await sleep(4000);
    ok('一人先交不叫醒负责人', !nativeTexts(lead.id).some(t => t.includes('【赛马结果')));
    const d2 = await command(team.members[1].sid, ['send', '--to', 'lead', '--deliver', '--message', `乙完成\n${candidate('race-b', { 'login.js': 'module.exports = () => 2;\n' })}`]);
    ok('第二位交付后 Hub 出成绩单', d2.status === 'held' && /最后一位/.test(d2.note));
    const result = await wait(() => nativeTexts(lead.id).find(t => t.includes('【赛马结果')), 'race result to lead', 90000);
    ok('负责人只收到一条赛马结果', nativeTexts(lead.id).filter(t => t.includes('【赛马结果')).length === 1 && !nativeTexts(lead.id).some(t => t.includes('甲完成')));
    const card = result.match(/成绩单：(\S+赛马成绩单\.md)/)[1];
    const md = fs.readFileSync(card, 'utf8');
    ok('成绩单核对了两份候选并统计改动规模（无测试闸门不跑测试）', /2 个文件 \+\d+\/-\d+/.test(md) && /1 个文件 \+\d+\/-\d+/.test(md) && /没有声明测试命令/.test(md));
    fs.copyFileSync(card, path.join(ART, '20261128-team-race-成绩单.md'));
    evidence.leadMessage = result; evidence.leadMessagesBefore = leadBefore;
    await cdp.eval(`selectSession(${JSON.stringify(lead.id)})`);
    await sleep(800);
    evidence.screenshot = await shot('sidebar-1440');
    evidence.ok = true;
  } catch (e) {
    failure = e; evidence.error = e.stack || String(e); if (cdp) await shot('failure').catch(() => {});
  } finally {
    try { if (cdp) await cdp.close(); } catch {}
    try { if (hub) await gracefulQuit(hub); } catch (e) { evidence.exitError = e.message; }
    fs.writeFileSync(path.join(ART, '20261128-team-race-evidence.json'), JSON.stringify(evidence, null, 2));
    if (!failure) try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  }
  if (failure) { console.error(failure); process.exit(1); }
  console.log('e2e-team-race: ok');
})();
