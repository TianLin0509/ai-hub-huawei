'use strict';
// 隔离 Hub + 假 CodeAgent（tests/fixtures/codeagent-pool-fake），负责人招一个成员；假 CLI 像真 CLI 一样跑启动 --settings 里的
// PreToolUse hook。验证：成员 git push 被拦（退出码 2、中文原因）、负责人被叫醒、hub-team pass 放行一次、普通命令不受影响、
// 负责人自己的会话不挂守卫。不调用任何模型。
// 用法：node tests/e2e-member-guard-cdp.js [--out <产物目录>]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pool = require('../core/codeagent-pool');
const { writeProbed } = require('../core/codeagent-model-probe');

const REPO = path.resolve(__dirname, '..');
const outAt = process.argv.indexOf('--out');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'member-guard-e2e-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal');
const CONTROL = path.join(ROOT, 'fixture-control'), LOG = path.join(ROOT, 'fixture.jsonl');
const ART = path.resolve(outAt > 0 ? process.argv[outAt + 1] : path.join(REPO, 'artifacts', `member-guard-${Date.now()}`));
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

async function run() {
  for (const dir of [DATA, WORK, ART, CONTROL]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  const glm = 'GLM-5.2-WX-Auto';
  seed(PERSONAL, 'p-fixture', glm);
  const a = pool.addAccount(DATA, { note: '守卫夹具' });
  seed(pool.accountDir(DATA, a), 'a-fixture', glm);
  const checks = [];
  const ok = (label, condition = true) => { assert(condition, label); checks.push(label); console.log('PASS ' + label); };
  let hub, cdp, seq = 0;
  const invoke = (channel, args) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
  const request = async (sid, body) => {
    await wait(() => fs.existsSync(path.join(CONTROL, `${sid}.ready`)), 'fixture ready');
    const id = ++seq, file = path.join(CONTROL, `${sid}.request`), result = path.join(CONTROL, `${sid}.${id}.response`);
    fs.writeFileSync(file + '.tmp', JSON.stringify({ id, ...body })); fs.renameSync(file + '.tmp', file);
    await wait(() => fs.existsSync(result), `fixture ${id}`);
    return JSON.parse(fs.readFileSync(result, 'utf8'));
  };
  const command = async (sid, args) => { const r = await request(sid, { args }); assert.equal(r.code, 0, r.err || r.error); return JSON.parse(r.out); };
  const tool = (sid, command, cwd) => request(sid, { hook: { session_id: 'fixture', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' }, cwd } });
  const received = (sid, needle) => launches().filter(v => v.hubSession === sid).some(v => {
    const file = path.join(v.configDir, 'projects', v.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${v.sessionId}.jsonl`);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      .some(r => r.type === 'user' && String(JSON.stringify(r.message?.content || '')).includes(needle));
  });
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), windowMode: 'hidden', extraEnv: {
      HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', AI_HUB_WORKSPACE_ROOT: WORK,
      AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), CODEAGENT_POOL_FAKE_HELP_SETTINGS: '1',
      AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG, CODEAGENT_TEAM_FAKE_CONTROL_DIR: CONTROL,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'empty-scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'),
    } });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await wait(() => cdp.eval('!!window.__teamUi'), 'renderer ready');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const lead = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title: '守卫验收负责人', codeagentAccount: 'pool', codeagentPoolPick: a, model: glm, codeagentModelPick: true } });
    ok('负责人会话已建', !!lead?.id);
    const planFile = path.join(ROOT, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({ goal: '守卫验收', members: [{ role: '实现', task: '在临时目录实现', account: a, model: glm, worktree: false }] }), 'utf8');
    await command(lead.id, ['propose', '--plan-file', planFile]);
    const team = await wait(async () => { const t = (await invoke('team:list')).result[0]; return t && t.members.length === 1 && t.members[0].status === 'active' && t; }, 'member active');
    const m1 = team.members[0].sid;
    ok('负责人计划自动批准，成员已建', !!m1);
    const memberSettings = JSON.parse(fs.readFileSync(path.join(DATA, 'codeagent-launch', `${m1}.json`), 'utf8'));
    const entry = memberSettings.hooks?.PreToolUse?.[0];
    ok('成员启动设置里挂着合成守卫（命令类工具 + member 参数）', entry && /Bash\|PowerShell/.test(entry.matcher) && / member$/.test(entry.hooks[0].command));
    const leadFile = path.join(DATA, 'codeagent-launch', `${lead.id}.json`);
    const leadHooks = fs.existsSync(leadFile) ? JSON.parse(fs.readFileSync(leadFile, 'utf8')).hooks : undefined;
    ok('负责人自己的会话不挂守卫', !leadHooks);

    const status = await tool(m1, 'git status --short', WORK);
    ok('普通命令放行（hook 跑过、退出码 0）', status.code === 0 && status.ran === 1);
    const push = await tool(m1, 'git push origin feat/x', WORK);
    ok('成员 git push 被拦：退出码 2，中文原因交给模型', push.code === 2 && /已拦截，已报告负责人/.test(push.err) && /推送或改写主干/.test(push.err));
    const data = await tool(m1, `echo {} > ${path.join(DATA, 'config.json').replace(/\\/g, '/')}`, WORK);
    ok('改 Hub 数据目录配置被拦', data.code === 2 && /Hub 生产配置/.test(data.err));
    await wait(() => received(lead.id, '【权限拦截】'), 'lead woken with refusal');
    ok('负责人被叫醒，收到【权限拦截】与 pass 用法', received(lead.id, 'hub-team pass --to m1'));
    // 最近一条被拦的是改配置；再触发一次 push，让放行对准 push
    await tool(m1, 'git push origin feat/x', WORK);
    const pass = await command(lead.id, ['pass', '--to', 'm1']);
    ok('负责人 pass 放行最近一条', pass.ok === true && /git push/.test(pass.command));
    await wait(() => received(m1, '负责人放行了你刚才被拦的命令'), 'member told about pass');
    ok('成员收到放行通知', true);
    ok('放行后原样重试一次通过', (await tool(m1, 'git push origin feat/x', WORK)).code === 0);
    ok('放行只一次', (await tool(m1, 'git push origin feat/x', WORK)).code === 2);
    const log = fs.readFileSync(path.join(DATA, 'logs', 'member-guard.jsonl'), 'utf8');
    ok('拦截与放行都留痕', /"event":"blocked"/.test(log) && /"event":"pass-granted"/.test(log) && /"event":"passed"/.test(log));
    await cdp.eval(`selectSession(${JSON.stringify(lead.id)})`);
    await sleep(800);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ART, '20261128-member-guard-lead-1440.png'), Buffer.from(shot.data, 'base64'));
    fs.writeFileSync(path.join(ART, '20261128-member-guard-e2e.json'), JSON.stringify({ ok: true, checks, root: ROOT }, null, 2));
    console.log(JSON.stringify({ ok: true, checks: checks.length, artifacts: ART }));
  } finally {
    try { cdp?.close?.(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}
run().catch(error => { console.error(error); fs.mkdirSync(ART, { recursive: true }); fs.writeFileSync(path.join(ART, '20261128-member-guard-e2e.json'), JSON.stringify({ ok: false, error: String(error.stack || error), root: ROOT }, null, 2)); process.exit(1); });
