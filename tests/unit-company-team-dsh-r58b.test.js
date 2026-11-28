'use strict';
// R58b 第二步：DSH 进公司版组队。DSH 启动时会清掉继承来的 Hub 变量，组队成员靠 hubTeamEnv 补回自己的身份，
// 才能跑 hub-team send 交回执；不是组队成员的 DSH 会话一项都不带（父进程漏下来的组队令牌也清掉）。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const acp = require('../core/acp-profiles');
const proxy = require('../core/company-model-proxy');

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  fs.mkdirSync(proxy.proxyDir(data), { recursive: true });
  fs.writeFileSync(proxy.endpointFile(data), JSON.stringify({ port: 18080, key: 'a'.repeat(40) }));
  const entry = path.join(root, 'dsh.js'); fs.writeFileSync(entry, '');
  const node = path.join(root, 'node.exe'); fs.writeFileSync(node, '');
  const bridge = path.join(root, 'bridge'); fs.mkdirSync(bridge); fs.writeFileSync(path.join(bridge, 'package.json'), '{}');
  const config = { companyCli: true, dshBackend: 'proxy', dshUpstream: '',
    acp: { nodePath: node, providers: { 'deepseek-acp': { entryPath: entry, bridgePath: bridge } } } };
  const parent = { ...process.env, CLAUDE_HUB_TEAM_TOKEN: 'parent-team', CLAUDE_HUB_SESSION_ID: 'parent-sid', CLAUDE_HUB_TOKEN: 'parent-hook' };
  return { build: opts => acp.buildAcpOptions('deepseek-acp', { id: 's1', cwd: root, ...opts }, config, data, parent).launch.env };
}

test('a DSH team member gets back only its own team identity', t => {
  const env = sandbox(t).build({ hubTeamEnv: { CLAUDE_HUB_SESSION_ID: 's1', CLAUDE_HUB_PORT: '4321', CLAUDE_HUB_TOKEN: 'hook', CLAUDE_HUB_TEAM_TOKEN: 'team-s1',
    CLAUDE_HUB_DATA_DIR: 'D:/hub-data', OPENAI_API_KEY: 'must-not-pass' } });
  assert.deepEqual([env.CLAUDE_HUB_SESSION_ID, env.CLAUDE_HUB_PORT, env.CLAUDE_HUB_TOKEN, env.CLAUDE_HUB_TEAM_TOKEN, env.CLAUDE_HUB_DATA_DIR],
    ['s1', '4321', 'hook', 'team-s1', 'D:/hub-data']);
  assert.notEqual(env.OPENAI_API_KEY, 'must-not-pass', '只补回组队身份那几项');
});

test('a DSH session outside a team carries no Hub identity, including a leaked parent team token', t => {
  const env = sandbox(t).build({});
  for (const name of ['CLAUDE_HUB_SESSION_ID', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_TEAM_TOKEN', 'CLAUDE_HUB_HOOK_AUTH', 'CLAUDE_HUB_TEAM_AUTH']) assert.equal(env[name], undefined, name);
});

// 真机发现（DSH 0.2.2-rc.5）：DSH 的命令工具起子进程时去掉名字匹配 /KEY|PASSWORD|SECRET|TOKEN/i 的变量，
// 成员终端里只剩会话号和端口，hub-team 报「缺少 CLAUDE_HUB_TOKEN / CLAUDE_HUB_TEAM_TOKEN」。撤掉别名，下面两条都失败。
test('DSH members also get token aliases that survive the DSH child-process scrub', t => {
  const env = sandbox(t).build({ hubTeamEnv: { CLAUDE_HUB_SESSION_ID: 's1', CLAUDE_HUB_PORT: '4321', CLAUDE_HUB_TOKEN: 'hook', CLAUDE_HUB_TEAM_TOKEN: 'team-s1' } });
  const SENSITIVE = /KEY|PASSWORD|SECRET|TOKEN/i; // 与 @deepseek-ai/dsh-subprocess 的 SENSITIVE_ENV_PATTERN 相同
  const child = Object.fromEntries(Object.entries(env).filter(([k]) => !SENSITIVE.test(k) && !k.toUpperCase().startsWith('DSH_')));
  assert.equal(child.CLAUDE_HUB_HOOK_AUTH, 'hook');
  assert.equal(child.CLAUDE_HUB_TEAM_AUTH, 'team-s1');
  assert.equal(child.CLAUDE_HUB_SESSION_ID, 's1');
  assert.equal(child.CLAUDE_HUB_PORT, '4321');
});

test('hub-team reads the aliases when the original token names were scrubbed', async () => {
  const http = require('node:http');
  let seen = null;
  const server = http.createServer((req, res) => { let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
    seen = JSON.parse(raw); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: { ok: true } })); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const { post } = require('../scripts/hub-team');
    const env = { CLAUDE_HUB_PORT: String(server.address().port), CLAUDE_HUB_SESSION_ID: 'm-sid', CLAUDE_HUB_HOOK_AUTH: 'hook', CLAUDE_HUB_TEAM_AUTH: 'team' };
    assert.deepEqual(await post({ action: 'status', args: {} }, env), { ok: true });
    assert.deepEqual([seen.token, seen.teamToken, seen.sessionId], ['hook', 'team', 'm-sid']);
    await assert.rejects(post({ action: 'status', args: {} }, { CLAUDE_HUB_PORT: env.CLAUDE_HUB_PORT, CLAUDE_HUB_SESSION_ID: 'm-sid' }), /缺少 CLAUDE_HUB_TOKEN \/ CLAUDE_HUB_TEAM_TOKEN/);
  } finally { server.close(); }
});

test('non-DSH sessions never inherit the DSH token aliases from a parent process', () => {
  const { SessionManager } = require('../core/session-manager');
  const env = { CLAUDE_HUB_HOOK_AUTH: 'stale', CLAUDE_HUB_TEAM_AUTH: 'stale' };
  SessionManager.prototype._applyHubSessionEnv.call({ teamTokenFor: () => null }, env, 'x');
  assert.equal(env.CLAUDE_HUB_HOOK_AUTH, undefined);
  assert.equal(env.CLAUDE_HUB_TEAM_AUTH, undefined);
});

test('session manager builds the DSH team identity from the same per-session token as other members', () => {
  const { SessionManager } = require('../core/session-manager');
  const fake = { teamTokenFor: id => 'tok-' + id, hookPort: 5555, hookToken: 'hook-token',
    _applyHubSessionEnv: SessionManager.prototype._applyHubSessionEnv };
  const env = SessionManager.prototype._hubTeamEnv.call(fake, 'member-1');
  assert.equal(env.CLAUDE_HUB_SESSION_ID, 'member-1');
  assert.equal(env.CLAUDE_HUB_TEAM_TOKEN, 'tok-member-1');
  assert.equal(env.CLAUDE_HUB_PORT, '5555');
  assert.equal(env.CLAUDE_HUB_TOKEN, 'hook-token');
  assert.ok(env.CLAUDE_HUB_DATA_DIR, '数据目录一并给，成员按说明书能找到 hub-team 命令');
});

test('DSH is a team member kind, first in the mix recipe only on a company route', () => {
  const B = require('../main/team/backends');
  assert.ok(B.TEAM_MEMBER_KINDS.includes('deepseek-acp'));
  assert.equal(B.resolveKind('DSH'), 'deepseek-acp');
  const own = B.recommendedMix([{ kind: 'deepseek-acp', label: 'DSH', ready: true, companyRoute: false }]);
  assert.deepEqual(own.heterogeneous, [], '自有接口花用户自己的钱，不推荐');
  const company = B.recommendedMix([{ kind: 'claude', label: 'Claude Code', ready: true, companyRoute: true, routeLabel: 'x' },
    { kind: 'deepseek-acp', label: 'DSH', ready: true, companyRoute: true, routeLabel: '公司模型' }]);
  assert.deepEqual(company.heterogeneous, ['deepseek-acp', 'claude']);
  assert.equal(company.slots.find(s => s.slot === '审查/复核').kind, 'deepseek-acp');
});

test('the shipped skill and hub-team error now cover DSH members', () => {
  const text = fs.readFileSync(require('../core/codeagent-bundled-skills').BUNDLE_FILE, 'utf8');
  assert.match(text, /\| `deepseek-acp`（可写 `dsh`） \| DSH \|/);
  assert.doesNotMatch(text, /DSH、外部终端尚未接通/);
  const hubTeam = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'hub-team.js'), 'utf8');
  assert.doesNotMatch(hubTeam, /DSH 与外部终端目前未接通/);
});

// Antigravity 审查 P2-1：从带组队令牌的进程树里拉起的 Hub，启动时清掉这些令牌，不漏给不经 _applyHubSessionEnv 的会话。
test('a Hub launched from a team member process drops inherited team tokens and their aliases', () => {
  const clean = require('../core/clean-launch-env');
  const names = Object.keys(clean.SESSION_VARS || {});
  for (const name of ['CLAUDE_HUB_TEAM_TOKEN', 'CLAUDE_HUB_HOOK_AUTH', 'CLAUDE_HUB_TEAM_AUTH']) assert.ok(names.includes(name), name);
});

// Antigravity 审查 P2-2：定位中心首轮探测前，DSH 只找到命令、运行环境缺终端界面包时不能报就绪。
test('DSH is not reported ready before the first probe when its runtime is incomplete', () => {
  const B = require('../main/team/backends');
  const deps = (runtime) => ({ locator: { peek: () => null, launchSpec: () => ({ command: 'dsh.cmd' }) },
    proxy: { companyModelIds: () => ['m'], gatewayModelIds: () => ['m'] },
    apiConfig: { assertLaunchConfigured: () => {}, ownSource: () => ({}) }, readRaw: () => ({}), kindAllowed: () => true,
    dshDiagnose: () => (runtime ? { state: 'ready', runtime } : { state: 'tui-no-core', missing: [] }) });
  const config = { dshBackend: 'proxy' };
  const broken = B.listTeamBackends({ config, kinds: ['deepseek-acp'], deps: deps(null) })[0];
  assert.equal(broken.installed, false); assert.equal(broken.ready, false); assert.ok(broken.unavailableReason);
  const ok = B.listTeamBackends({ config, kinds: ['deepseek-acp'], deps: deps({ root: 'x' }) })[0];
  assert.equal(ok.installed, true); assert.equal(ok.ready, true);
});
