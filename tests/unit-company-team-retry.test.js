'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createTeamService } = require('../main/team/service');
const { buildRequest, post } = require('../scripts/hub-team');
const { execFileSync } = require('node:child_process');
const { writeTeamCommand } = require('../main/team/command-shim');
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID', 'CLAUDE_HUB_TEAM_TOKEN']) delete env[key];
  return env;
}

test('documented PowerShell, cmd and Git Bash calls work with a spaced command path', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team shell calls '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'args.js'), shim = path.join(root, 'hub-team.cmd');
  const cli = path.resolve(__dirname, '../scripts/hub-team.js');
  fs.writeFileSync(script, `const argv=process.argv.slice(2);const request=require(${JSON.stringify(cli)}).buildRequest(argv);console.log(JSON.stringify({argv,request,hubEnv:Object.keys(process.env).filter(k=>/^CLAUDE_HUB_(PORT|TOKEN|SESSION_ID|TEAM_TOKEN)$/.test(k))}));`);
  writeTeamCommand(shim, { nodeExecutable: process.execPath, script, runAsNode: false });
  const run = (exe, args, env = {}, extra = {}) => {
    const result = JSON.parse(execFileSync(exe, args, { env: childEnv(env), windowsHide: true, encoding: 'utf8', timeout: 30000, ...extra }).trim());
    assert.deepEqual(result.hubEnv, []);
    return result;
  };
  const psPath = shim.replace(/'/g, "''");
  assert.deepEqual(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& '${psPath}' status`]).argv, ['status']);
  assert.deepEqual(run('cmd.exe', ['/d', '/s', '/c', `""${shim}" status"`], {}, { windowsVerbatimArguments: true }).argv, ['status']);
  const bash = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe');
  if (!fs.existsSync(bash)) { t.diagnostic('Git Bash unavailable; PowerShell/cmd checked'); return; }
  const planFile = path.join(root, '中文 调研计划.json');
  const plan = { goal: '中文计划', members: [{ role: '调研', task: '读取项目文档' }] };
  fs.writeFileSync(planFile, JSON.stringify(plan), 'utf8');
  const messageFile = path.join(root, '中文 成员消息.md'), message = 'hello world 中文消息\n第二行 "引号" 完整保留';
  fs.writeFileSync(messageFile, message, 'utf8');
  const env = { TEAM_SHIM_FIXTURE: shim.replace(/\\/g, '/'), HUB_TEAM_PLAN_FILE: planFile, HUB_TEAM_MESSAGE: 'hello world 中文消息', HUB_TEAM_MESSAGE_FILE: messageFile };
  const invoke = action => run(bash, ['--noprofile', '--norc', '-c',
    'export HUB_TEAM_COMMAND="$(cygpath -w "$TEAM_SHIM_FIXTURE")"; powershell.exe -NoProfile -NonInteractive -Command \'[Console]::OutputEncoding=[Text.Encoding]::UTF8; & $env:HUB_TEAM_COMMAND ' + action + '\''], env);
  assert.deepEqual(invoke('status').argv, ['status']);
  const proposed = invoke('propose --plan-file $env:HUB_TEAM_PLAN_FILE');
  assert.deepEqual(proposed.argv, ['propose', '--plan-file', planFile]);
  assert.deepEqual(proposed.request.args, plan);
  const sent = invoke('send --to lead --message $env:HUB_TEAM_MESSAGE');
  assert.deepEqual(sent.argv, ['send', '--to', 'lead', '--message', env.HUB_TEAM_MESSAGE]);
  assert.equal(sent.request.args.message, env.HUB_TEAM_MESSAGE);
  assert.equal(invoke('send --to lead --message-file $env:HUB_TEAM_MESSAGE_FILE').request.args.message, message);
});

test('CLI preserves option-looking message bodies and keeps boolean flags separate', () => {
  for (const message of ['--foo', '--wake', '--deliver', '--', '--中文\n第二行']) {
    const r = buildRequest(['send', '--wake', '--to', 'lead', '--message', message, '--deliver']);
    assert.equal(r.args.message, message);
    assert.equal(r.args.wake, true);
    assert.equal(r.args.deliver, true);
  }
  assert.throws(() => buildRequest(['send', '--to', 'lead', '--message']), /缺少值/);
});

test('team CLI fixture help and unsupported serve probes terminate without interactive sessions', () => {
  const fixture = path.join(__dirname, 'fixtures/codeagent-pool-fake/codeagent-fake.js');
  for (const settings of ['0', '1']) {
    const output = execFileSync(process.execPath, [fixture, '--help'], {
      windowsHide: true, timeout: 5000, encoding: 'utf8', env: childEnv({ CODEAGENT_POOL_FAKE_HELP_SETTINGS: settings }),
    });
    assert.match(output, /Usage: codeagent/);
    assert.equal(output.includes('--settings'), settings === '1');
  }
  assert.throws(() => execFileSync(process.execPath, [fixture, 'serve'], { windowsHide: true, timeout: 5000, stdio: 'pipe', env: childEnv() }),
    error => error.status === 1 && /does not implement serve/.test(String(error.stderr)));
});

test('missing identity gives an actionable PTY diagnosis without exposing credentials', async () => {
  for (const env of [{}, { CLAUDE_HUB_PORT: '1234', CLAUDE_HUB_SESSION_ID: 'fixture', CLAUDE_HUB_TOKEN: 'private-fixture' },
    { CLAUDE_HUB_PORT: 'bad', CLAUDE_HUB_SESSION_ID: 'fixture', CLAUDE_HUB_TOKEN: 'private-fixture', CLAUDE_HUB_TEAM_TOKEN: 'team-fixture' }]) {
    await assert.rejects(post({ action: 'status' }, env), error => {
      assert.match(error.message, /CodeAgent PTY/);
      assert.match(error.message, /CodeAgent-Lite/);
      assert.match(error.message, /DSH/);
      assert.match(error.message, /无需重启整个 Hub/);
      assert.doesNotMatch(error.message, /private-fixture|team-fixture/);
      return true;
    });
  }
});

function harness(t, { auto = true, failTitle = '', delayed = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retry-'));
  const sessions = new Map([['lead-0001', { id: 'lead-0001', kind: 'codeagent', cwd: root }]]);
  let clock = Date.now(), n = 0, fail = failTitle, release, recommended = 'pool-a';
  const wait = delayed ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const created = [];
  const deps = {
    getHubDataDir: () => root, now: () => clock,
    getConfig: () => ({ team: { autoApproveLeads: auto, antiStall: false } }),
    sessionManager: { getSession: id => sessions.get(id), isAgentTurnActive: () => false },
    listAccounts: () => ({ recommendedId: recommended, rows: ['pool-a', 'pool-b'].map(id => ({ id, usable: true, models: ['GLM-test'], modelsAuthoritative: true })) }),
    createSession: async ({ kind, opts }) => {
      await wait;
      if (opts.title === fail) throw Error('fixture launch failure');
      const s = { id: 'fixture-' + (++n), kind, cwd: opts.cwd, fixedModel: opts.model || 'GLM-test' };
      s.account = opts.codeagentPoolPick;
      sessions.set(s.id, s); created.push(s); return s;
    }, submitPrompt: async () => ({ ok: true }), logger: { warn() {} },
  };
  const services = [], service = createTeamService(deps); services.push(service);
  t.after(() => { for (const s of services) { s.freeze(); s.stop(); } fs.rmSync(root, { recursive: true, force: true }); });
  const plan = tasks => ({ goal: 'retry fixture', members: tasks.map(task => ({ role: 'implementation', task, title: task })) });
  const propose = tasks => service.invoke('lead-0001', 'propose', plan(tasks));
  return { service, propose, plan, created, release, sessions, advance: ms => { clock += ms; }, recover: () => { fail = ''; }, recommend: id => { recommended = id; },
    reload: () => { service.freeze(); service.stop(); const next = createTeamService(deps); services.push(next); return next; } };
}

test('identical proposals reuse pending plans and active members despite resolved default models', async t => {
  for (const auto of [false, true]) {
    const h = harness(t, { auto });
    const first = await h.propose(['same']);
    const repeat = await h.propose(['same']);
    assert.equal(repeat.status, 'duplicate');
    assert.equal(repeat.duplicates[0].planId, first.planId);
    assert.equal(h.service.listTeams()[0].plans.length, 1);
    assert.equal(h.created.length, auto ? 1 : 0);
  }
});

test('automatic account retries remain identical after the recommended account rotates', async t => {
  for (const auto of [false, true]) {
    const h = harness(t, { auto });
    const first = await h.propose(['same']);
    h.recommend('pool-b');
    const retry = await h.propose(['same']);
    assert.equal(retry.status, 'duplicate');
    assert.equal(retry.duplicates[0].planId, first.planId);
    assert.equal(h.created.length, auto ? 1 : 0);
    if (auto) assert.equal(h.created[0].account, 'pool-a');
    const next = h.reload();
    assert.equal((await next.invoke('lead-0001', 'propose', h.plan(['same']))).status, 'duplicate');
  }
});

test('explicit account changes are new intent and a full team may retry the same request', async t => {
  const h = harness(t);
  const proposal = account => { const p = h.plan(['same']); p.members[0].account = account; return p; };
  await h.service.invoke('lead-0001', 'propose', proposal('pool-a'));
  assert.equal((await h.service.invoke('lead-0001', 'propose', proposal('pool-b'))).status, 'approved');
  assert.deepEqual(h.created.map(s => s.account), ['pool-a', 'pool-b']);
  const full = h.plan(Array.from({ length: 98 }, (_, i) => 'task-' + i));
  await h.service.invoke('lead-0001', 'propose', full);
  assert.equal(h.created.length, 100);
  assert.equal((await h.service.invoke('lead-0001', 'propose', full)).status, 'duplicate');
  assert.equal(h.created.length, 100);
});

test('parallel retry while a session is creating cannot reserve a second member', async t => {
  const h = harness(t, { delayed: true });
  const first = h.propose(['same']);
  try {
    assert.equal((await h.propose(['same'])).status, 'duplicate');
    assert.equal(h.service.listTeams()[0].members.length, 1);
  } finally { h.release(); }
  assert.equal((await first).status, 'approved');
  assert.equal(h.created.length, 1);
});

test('an oversized plan is rejected before persisting a team or creating sessions', async t => {
  const h = harness(t);
  await assert.rejects(h.propose(Array.from({ length: 101 }, (_, i) => 'task-' + i)), /最多 100 名成员/);
  assert.deepEqual(h.service.listTeams(), []);
  assert.equal(h.created.length, 0);
});

test('expanding a pending plan preserves old tasks when the prior plan is withdrawn', async t => {
  const h = harness(t, { auto: false });
  await h.propose(['old']);
  const expanded = await h.propose(['old', 'new']);
  assert.equal(expanded.status, 'pending');
  const plans = h.service.listTeams()[0].plans;
  assert.equal(plans[0].status, 'withdrawn');
  assert.deepEqual(plans[1].members.map(m => m.task), ['old', 'new']);
  const approved = await h.service.decide({ leadSid: 'lead-0001', planId: expanded.planId, approve: true });
  assert.equal(approved.created.length, 2);
});

test('partial failure retries only failed entries, and a later mixed plan only creates new tasks', async t => {
  const h = harness(t, { failTitle: 'bad' });
  const first = await h.propose(['good', 'bad']);
  assert.equal(first.failed.length, 1);
  h.recover();
  const retry = await h.propose(['good', 'bad']);
  assert.equal(retry.duplicates.length, 1);
  assert.equal(retry.created.length, 1);
  assert.equal(h.created.length, 2);
  const mixed = await h.propose(['good', 'bad', 'new']);
  assert.equal(mixed.duplicates.length, 2);
  assert.equal(mixed.created.length, 1);
});

test('dedupe compares multiplicity and remains bounded by ten minutes', async t => {
  const h = harness(t);
  await h.propose(['same']);
  const two = await h.propose(['same', 'same']);
  assert.equal(two.duplicates.length, 1);
  assert.equal(two.created.length, 1);
  h.advance(10 * 60 * 1000);
  const expired = await h.propose(['same']);
  assert.equal(expired.status, 'approved');
  assert.equal(expired.duplicates, undefined);
});

test('dismissed members may be replaced, and persisted request fingerprints survive restart', async t => {
  const h = harness(t);
  await h.propose(['same']);
  await h.service.invoke('lead-0001', 'dismiss', { memberId: 'm1' });
  assert.equal((await h.propose(['same'])).status, 'approved');
  const next = h.reload();
  assert.equal((await next.invoke('lead-0001', 'propose', h.plan(['same']))).status, 'duplicate');
  assert.equal(h.created.length, 2);
});

test('invalid tuning and backend fields explain how to choose a DeepSeek model', async t => {
  const h = harness(t);
  for (const extra of [{ effort: 'high' }, { fastMode: true }, { kind: 'deepseek' }]) {
    const plan = h.plan(['same']); Object.assign(plan.members[0], extra);
    await assert.rejects(h.service.invoke('lead-0001', 'propose', plan), error => {
      assert.match(error.message, /accounts/); assert.match(error.message, /models/); assert.match(error.message, /model/); return true;
    });
  }
  assert.equal(h.created.length, 0);
});
