'use strict';
// 组队成员危险动作硬拦的 Hub 侧判定、通知负责人、一次性放行，以及和「只允许改工作目录内的文件」合成的同一个 hook 入口
// （main/team/member-guard.js、core/workspace-guard.js、scripts/hub-workspace-guard.ps1、main/team/service.js）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { createMemberGuard, requestFromPayload, handleHttp, memberLaunchInfo } = require('../main/team/member-guard');
const wg = require('../core/workspace-guard');

function fixture({ access } = {}) {
  const notes = [], memberNotes = [];
  const team = { leadSid: 'lead-1', members: [{ memberId: 'm3', sid: 'mem-3', title: '硬拦', role: 'r', status: 'active', joinedAt: Date.now() - 1000, ...(access ? { access } : {}) }] };
  const service = {
    teamOfMember: sid => sid === 'mem-3' ? { team, member: team.members[0] } : null,
    teamOfLead: sid => sid === 'lead-1' ? team : null,
    notifyLead: (leadSid, text, opts) => { notes.push({ leadSid, text, opts }); return { ok: true }; },
    notifyMember: (leadSid, memberId, text) => { memberNotes.push({ leadSid, memberId, text }); return { ok: true }; },
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-'));
  const guard = createMemberGuard({ getTeamService: () => service, getSession: () => ({ info: { cwd: 'D:\\Work\\x' } }),
    hubDataDir: dataDir, isolated: true, logger: { warn() {} }, branchOf: async () => 'feat/x', birthOf: async () => null, workRoots: [] });
  return { guard, notes, memberNotes, dataDir, service };
}
const bash = command => ({ toolName: 'Bash', toolInput: { command } });

test('a member git push is refused: reason to the member, the lead is woken once per command per 10 minutes', async () => {
  const { guard, notes, dataDir } = fixture();
  const v = await guard.check({ sessionId: 'mem-3', ...bash('git push origin feat/x'), cwd: 'D:\\Work\\x' });
  assert.strictEqual(v.decision, 'deny');
  assert.match(v.reason, /^已拦截，已报告负责人/);
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].leadSid, 'lead-1');
  assert.deepStrictEqual(notes[0].opts, { wake: true });
  assert.match(notes[0].text, /m3.*git push/s);
  assert.match(notes[0].text, /hub-team pass --to m3/);
  assert.doesNotMatch(notes[0].text, /\u7530\u54e5/);
  await guard.check({ sessionId: 'mem-3', ...bash('git push origin feat/x') });
  assert.strictEqual(notes.length, 1, 'the same command refused again does not wake the lead again');
  assert.match(fs.readFileSync(path.join(dataDir, 'logs', 'member-guard.jsonl'), 'utf8'), /"event":"blocked"/);
});

test('sessions that are not team members are always let through', async () => {
  const { guard, notes } = fixture();
  assert.deepStrictEqual(await guard.check({ sessionId: 'someone', ...bash('git push') }), { decision: 'allow' });
  assert.strictEqual(notes.length, 0);
});

test('lead pass: lets the last refused command through once; other commands and the second try stay refused', async () => {
  const { guard, memberNotes } = fixture();
  await guard.check({ sessionId: 'mem-3', ...bash('git push origin feat/x') });
  assert.throws(() => guard.pass('mem-3', { to: 'm3' }), /只有负责人/);
  assert.throws(() => guard.pass('lead-1', { to: 'm9' }), /用法/);
  const r = guard.pass('lead-1', { to: 'm3' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(memberNotes.length, 1);
  assert.strictEqual(memberNotes[0].memberId, 'm3');
  assert.strictEqual((await guard.check({ sessionId: 'mem-3', ...bash('git push origin master') })).decision, 'deny', 'another command is not covered');
  guard.pass('lead-1', { to: 'm3' });
  assert.strictEqual((await guard.check({ sessionId: 'mem-3', ...bash('git push origin master') })).decision, 'allow');
  assert.strictEqual((await guard.check({ sessionId: 'mem-3', ...bash('git push origin master') })).decision, 'deny', 'a pass is used once');
});

test('read-only members cannot write files (temp dir excepted) and the lead is not woken', async () => {
  const { guard, notes } = fixture({ access: 'read' });
  const v = await guard.check({ sessionId: 'mem-3', toolName: 'Write', toolInput: { file_path: 'D:\\Work\\x\\a.md' } });
  assert.strictEqual(v.decision, 'deny');
  assert.match(v.reason, /只读成员/);
  assert.strictEqual(notes.length, 0);
  assert.strictEqual((await guard.check({ sessionId: 'mem-3', toolName: 'Write', toolInput: { file_path: path.join(os.tmpdir(), 'r.md') } })).decision, 'allow');
});

test('any error inside the guard lets the call through', async () => {
  const guard = createMemberGuard({ getTeamService: () => { throw new Error('boom'); }, logger: { warn() {} } });
  assert.strictEqual((await guard.check({ sessionId: 'mem-3', ...bash('git push') })).decision, 'allow');
});

test('the configured trunk list is honoured (config teamMemberGuard.protectedBranches)', async () => {
  const { service, dataDir } = fixture();
  const make = cfg => createMemberGuard({ getTeamService: () => service, getSession: () => ({ info: { cwd: 'D:\\Work\\x' } }), hubDataDir: dataDir,
    isolated: true, logger: { warn() {} }, branchOf: async () => 'release', birthOf: async () => null, workRoots: [], getConfig: () => cfg });
  assert.strictEqual((await make({}).check({ sessionId: 'mem-3', ...bash('git rebase feat/y') })).decision, 'allow');
  assert.strictEqual((await make({ teamMemberGuard: { protectedBranches: ['release'] } }).check({ sessionId: 'mem-3', ...bash('git rebase feat/y') })).decision, 'deny');
});

test('payload slimming keeps only what the rules read', () => {
  const r = requestFromPayload('mem-3', { tool_name: 'Write', cwd: 'D:\\x', tool_input: { file_path: 'a.txt', content: 'x'.repeat(100000) } });
  assert.deepStrictEqual(r, { sessionId: 'mem-3', toolName: 'Write', cwd: 'D:\\x', toolInput: { file_path: 'a.txt' } });
  assert.strictEqual(memberLaunchInfo({ teamOfMember: () => ({ member: { access: 'read' } }) }, 'x').access, 'read');
  assert.strictEqual(memberLaunchInfo({ teamOfMember: () => { throw Error('x'); } }, 'x'), null);
});

async function withGuardServer(verdictFor, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/member-guard') { res.writeHead(404); res.end('{}'); return; }
    handleHttp(req, res, { hookToken: 'tok', getGuard: () => ({ check: async request => { seen.push(request); return verdictFor(request); } }) });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(server.address().port, seen); } finally { server.close(); }
}
function post(port, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/member-guard', method: 'POST', headers }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('/api/member-guard: wrong token is 403, bad JSON is allow, a verdict is passed back', async () => {
  await withGuardServer(r => r.toolInput.command === 'git push' ? { decision: 'deny', reason: '已拦截' } : { decision: 'allow' }, async (port, seen) => {
    assert.strictEqual((await post(port, '{}', { 'x-hub-token': 'bad', 'x-hub-session': 'mem-3' })).status, 403);
    assert.deepStrictEqual((await post(port, 'not json', { 'x-hub-token': 'tok', 'x-hub-session': 'mem-3' })).body, { decision: 'allow' });
    const deny = await post(port, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: 'D:\\x' }), { 'x-hub-token': 'tok', 'x-hub-session': 'mem-3' });
    assert.deepStrictEqual(deny.body, { decision: 'deny', reason: '已拦截' });
    assert.deepStrictEqual(seen.at(-1), { sessionId: 'mem-3', toolName: 'Bash', cwd: 'D:\\x', toolInput: { command: 'git push' } });
  });
});

function runScript(args, env, payload) {
  return new Promise(resolve => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wg.scriptPath(), ...args],
      { env: { ...process.env, ...env }, windowsHide: true });
    const err = [];
    child.stderr.on('data', c => err.push(c));
    child.on('close', code => resolve({ code, err: Buffer.concat(err).toString('utf8') }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('one hook script: work-folder refusal first, then the Hub member verdict; Hub down or no session lets through', { skip: process.platform !== 'win32' }, async () => {
  await withGuardServer(r => /git push/.test(r.toolInput.command || '') ? { decision: 'deny', reason: '已拦截，已报告负责人：测试' } : { decision: 'allow' }, async (port, seen) => {
    const env = { CLAUDE_HUB_SESSION_ID: 'mem-3', CLAUDE_HUB_PORT: String(port), CLAUDE_HUB_TOKEN: 'tok' };
    const none = wg.encodeRoots([]);
    const deny = await runScript([none, 'member'], env, { tool_name: 'Bash', tool_input: { command: 'git push', description: 'x' }, cwd: 'D:\\x' });
    assert.strictEqual(deny.code, 2, deny.err);
    assert.match(deny.err, /已拦截，已报告负责人：测试/);
    assert.deepStrictEqual(seen.at(-1).toolInput, { command: 'git push' });
    assert.strictEqual((await runScript([none, 'member'], env, { tool_name: 'Bash', tool_input: { command: 'git status' } })).code, 0);
    assert.strictEqual((await runScript([none, 'member'], { ...env, CLAUDE_HUB_PORT: '1' }, { tool_name: 'Bash', tool_input: { command: 'git push' } })).code, 0, 'Hub not answering');
    assert.strictEqual((await runScript([none, 'member'], { ...env, CLAUDE_HUB_SESSION_ID: '' }, { tool_name: 'Bash', tool_input: { command: 'git push' } })).code, 0, 'not a Hub session');
    assert.strictEqual((await runScript([none], env, { tool_name: 'Bash', tool_input: { command: 'git push' } })).code, 0, 'without "member" the Hub is never asked');
    // 两项都开：工作目录外的写由本地判定拒绝，不再问 Hub
    const ws = path.join(os.tmpdir(), 'mg-ps-ws');
    const before = seen.length;
    const outside = await runScript([wg.encodeRoots([ws]), 'member'], env, { tool_name: 'Write', cwd: ws, tool_input: { file_path: 'C:\\elsewhere\\x.txt' } });
    assert.strictEqual(outside.code, 2);
    assert.match(outside.err, /Refused by AI Hub/);
    assert.strictEqual(seen.length, before);
    assert.strictEqual((await runScript([wg.encodeRoots([ws]), 'member'], env, { tool_name: 'Write', cwd: ws, tool_input: { file_path: path.join(ws, 'a.txt') } })).code, 0);
    assert.strictEqual(seen.length, before + 1, 'inside the work folder the Hub is asked next');
  });
});

test('overlay: members get one combined entry with the command tools; roster decides on resume; others get nothing', () => {
  const cwd = path.join(os.tmpdir(), 'mg-ws');
  assert.strictEqual(wg.settingsOverlay('codeagent', {}, { cwd, sessionId: 'x' }), null);
  const member = wg.settingsOverlay('codeagent', { memberGuard: true }, { cwd, env: {} });
  assert.strictEqual(member.hooks.PreToolUse.length, 1);
  assert.strictEqual(member.hooks.PreToolUse[0].matcher, wg.MEMBER_MATCHER);
  assert.match(member.hooks.PreToolUse[0].hooks[0].command, /hub-workspace-guard\.ps1" W10= member$/);
  const both = wg.settingsOverlay('codeagent', { memberGuard: true, workspaceGuard: true }, { cwd, env: {} });
  assert.strictEqual(both.hooks.PreToolUse.length, 1, 'one entry point, one PowerShell per call');
  assert.match(both.hooks.PreToolUse[0].hooks[0].command, /\s[A-Za-z0-9+/=]{8,} member$/);
  assert.strictEqual(wg.settingsOverlay('codex', { memberGuard: true }, { cwd }), null);
  wg.setMemberPredicate(id => id === 'resumed-member');
  try {
    assert.ok(wg.settingsOverlay('codeagent-resume', {}, { cwd, env: {}, sessionId: 'resumed-member' }));
    assert.ok(wg.settingsOverlay('codeagent', { id: 'resumed-member' }, { cwd, env: {} }));
    assert.strictEqual(wg.settingsOverlay('codeagent', {}, { cwd, env: {}, sessionId: 'other' }), null);
  } finally { wg.setMemberPredicate(null); }
  // 只勾工作目录、不是成员：沿用原来的 matcher 与参数
  const ws = wg.settingsOverlay('claude', { workspaceGuard: true }, { cwd, env: {} });
  assert.strictEqual(ws.hooks.PreToolUse[0].matcher, wg.MATCHER);
  assert.doesNotMatch(ws.hooks.PreToolUse[0].hooks[0].command, /member$/);
});

test('CodeAgent terminal launch of a member writes the combined hook into the launch settings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-ca-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const load = Module._load;
  Module._load = function (id, ...args) { return id === 'node-pty' ? { spawn() { throw Error('No PTY'); } } : load.call(this, id, ...args); };
  let helpers;
  try { helpers = require('../core/session-manager')._private; } finally { Module._load = load; }
  const prior = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = path.join(root, 'hub-data');
  t.after(() => { if (prior === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prior; });
  fs.mkdirSync(path.join(root, 'hub-data'), { recursive: true });
  const configDir = path.join(root, 'cac');
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  const config = { command: 'codeagent-probe-not-installed', configDir, configDirEnv: 'CODEAGENT3_CONFIG_DIR', stateFile: '.cac.json' };
  const warn = console.warn; console.warn = () => {};
  t.after(() => { console.warn = warn; });
  const launch = helpers.buildCodeAgentPtyLaunch('ca-member', 'codeagent', { memberGuard: true }, root, { USERPROFILE: root, HOME: root }, config);
  const file = path.join(root, 'hub-data', 'codeagent-launch', 'ca-member.json');
  assert.ok(launch.cmd.includes(file), launch.cmd);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse[0];
  assert.strictEqual(entry.matcher, wg.MEMBER_MATCHER);
  assert.match(entry.hooks[0].command, / member$/);
});

test('kickoff guidance names the five refused actions in company wording; read-only adds one line', () => {
  const { guardGuidance } = require('../main/team/member-guidance');
  const text = guardGuidance().join('\n');
  assert.match(text, /Hub 会直接拦下并报告负责人/);
  assert.match(text, /部门 API key/);
  assert.doesNotMatch(text, /只读成员|DeepSeek|\u7530\u54e5/);
  assert.match(guardGuidance('read').join('\n'), /你是只读成员/);
});

test('team service: plans take access read/write, members start with memberGuard, kickoff carries the boundary, pass routes to the guard', async t => {
  const { createTeamService } = require('../main/team/service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-team-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = [{ id: 'pool-a', usable: true, models: ['GLM-5.2'], modelsAuthoritative: true }];
  const sessions = new Map([['lead-0001', { id: 'lead-0001', kind: 'codeagent', cwd: dir }]]), created = [], sent = [];
  const service = createTeamService({ company: true, getHubDataDir: () => dir, getConfig: () => ({}), listAccounts: () => ({ recommendedId: 'pool-a', rows }),
    sessionManager: { getSession: id => sessions.get(id), isAgentTurnActive: () => false }, commandPath: () => path.join(dir, 'hub-team.cmd'),
    createSession: async request => { created.push(request); const s = { id: `member-${created.length}xxx`, kind: request.kind }; sessions.set(s.id, s); return s; },
    submitPrompt: async (sid, text) => { sent.push({ sid, text }); return { ok: true }; } });
  t.after(() => { service.freeze(); service.stop(); });
  const m = extra => ({ role: '审查', task: '只读审查', account: 'pool-a', model: 'GLM-5.2', ...extra });
  await assert.rejects(service.invoke('lead-0001', 'propose', { goal: 'g', members: [m({ access: 'admin' })] }), /access 只能写 read 或 write/);
  const plan = await service.invoke('lead-0001', 'propose', { goal: 'g', members: [m({ access: 'read' }), m({ role: '实现' })] });
  await service.decide({ leadSid: 'lead-0001', planId: plan.planId, approve: true });
  assert.ok(created.every(r => r.opts.memberGuard === true));
  const team = service.listTeams()[0];
  assert.deepStrictEqual(team.members.map(x => x.access || 'write'), ['read', 'write']);
  for (let i = 0; i < 4; i++) { await new Promise(r => setImmediate(r)); await service.flush('lead-0001'); }
  const kick = sent.filter(s => s.text.includes('【组队开工'));
  assert.strictEqual(kick.length, 2);
  assert.ok(kick.every(s => /权限边界：以下 5 类动作 Hub 会直接拦下/.test(s.text)));
  assert.strictEqual(kick.filter(s => /你是只读成员/.test(s.text)).length, 1);
  await assert.rejects(service.invoke('lead-0001', 'pass', { to: 'm1' }), /成员权限守卫没有启动/);
  const calls = [];
  service.setMemberGuard({ pass: (sid, args) => { calls.push([sid, args]); return { ok: true }; } });
  assert.deepStrictEqual(await service.invoke('lead-0001', 'pass', { to: 'm1' }), { ok: true });
  assert.deepStrictEqual(calls, [['lead-0001', { to: 'm1' }]]);
  // 拦截通知走组队消息：叫醒负责人；放行通知发给成员
  assert.ok(service.notifyLead('lead-0001', '【权限拦截】测试'));
  assert.ok(service.notifyMember('lead-0001', 'm2', '放行了'));
  assert.strictEqual(service.notifyMember('lead-0001', 'm9', 'x'), null);
  assert.strictEqual(service.notifyLead('nobody', 'x'), null);
  for (let i = 0; i < 4; i++) { await new Promise(r => setImmediate(r)); await service.flush('lead-0001'); }
  assert.ok(sent.some(s => s.sid === 'lead-0001' && s.text.includes('【权限拦截】测试')), 'the lead is woken with the refusal');
  assert.ok(sent.some(s => s.sid === 'member-2xxx' && s.text.includes('放行了')), 'the member hears about the pass');
});
