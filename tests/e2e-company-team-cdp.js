'use strict';
// Real isolated Electron, real approval clicks, production hub-team CLI and
// session-bound identity. CodeAgent is a local protocol fixture, not a model.
// Run against the member edition with isolated user data; never replace its marker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pool = require('../core/codeagent-pool');
const { writeProbed } = require('../core/codeagent-model-probe');

const REPO = path.resolve(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-company-team-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal');
const CONTROL = path.join(ROOT, 'fixture-control'), LOG = path.join(ROOT, 'fixture.jsonl');
const ART = process.env.HUB_E2E_ARTIFACT_DIR || path.join(REPO, 'artifacts', `company-team-${Date.now()}`);
const marker = path.join(REPO, 'community-edition.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
async function wait(fn, label, ms = 30000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(200); } throw Error(`Timeout ${label}${last ? ': ' + last.message : ''}`); }
const launches = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(v => v.configDir) : [];
function seed(dir, accountId, model, authoritative = true) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId, expiresAt: Date.now() + 3600e3 } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model }));
  if (authoritative) writeProbed(path.join(dir, 'hub-models.json'), { models: [model], defaultModel: model, source: 'test-fixture' });
}
async function run() {
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.equal(JSON.parse(markerText).target, 'company', 'Run in the company edition');
  for (const dir of [DATA, WORK, ART, CONTROL]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  const glm = 'GLM-5.2-WX-Auto', ds = 'deepseek-v4-flash-0731';
  seed(PERSONAL, 'p-fixture', glm);
  const a = pool.addAccount(DATA, { note: '研发夹具' });
  seed(pool.accountDir(DATA, a), 'a-fixture', glm);
  const evidence = { checks: [], root: ROOT, artifacts: ART, model: 'none; local CodeAgent protocol fixture' };
  const ok = (label, condition = true) => { assert(condition, label); evidence.checks.push(label); console.log('PASS ' + label); };
  let hub, cdp, seq = 0;
  const invoke = (channel, args) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
  const click = async selector => {
    const p = await wait(() => cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`), selector);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  const shot = async name => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(s.data, 'base64')); };
  const command = async (sid, args, fail = false) => {
    await wait(() => fs.existsSync(path.join(CONTROL, `${sid}.ready`)), 'fixture ready');
    const id = ++seq, request = path.join(CONTROL, `${sid}.request`), result = path.join(CONTROL, `${sid}.${id}.response`);
    fs.writeFileSync(request + '.tmp', JSON.stringify({ id, args })); fs.renameSync(request + '.tmp', request);
    await wait(() => fs.existsSync(result), `CLI ${args[0]}`);
    const r = JSON.parse(fs.readFileSync(result, 'utf8'));
    if (fail) { assert.notEqual(r.code, 0); return r.err; }
    assert.equal(r.code, 0, r.err || r.error); return JSON.parse(r.out);
  };
  const nativeReceived = (sid, needle) => launches().filter(v => v.hubSession === sid).some(v => {
    const file = path.join(v.configDir, 'projects', v.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${v.sessionId}.jsonl`);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      .some(r => r.type === 'user' && r.message?.content?.includes(needle));
  });
  try {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await freePort(), windowMode: 'hidden', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG, CODEAGENT_TEAM_FAKE_CONTROL_DIR: CONTROL,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'empty-scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'),
    } });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await wait(() => cdp.eval('!!window.__teamUi && !!window.openMeetingCreateModal'), 'renderer ready');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    ok('公司发行标记生效，组队已开启', await cdp.eval("require('../core/distribution').target==='company' && require('../core/distribution').featureEnabled('leadTeam')"));
    await click('#home-create-group');
    await wait(() => cdp.eval("!!document.querySelector('.mcm-dialog')"), 'group modal');
    ok('建群弹窗只留普通群聊：负责人开关和场景均不可见', await cdp.eval("['#mcm-orch-row','#mcm-scene-row'].every(s=>{const e=document.querySelector(s);return !e||!e.getBoundingClientRect().height})"));
    ok('公司群聊只展示 CodeAgent 成员', await cdp.eval("(()=>{const s=[...document.querySelectorAll('.mcm-ai-select')];return s.length===2 && s.every(e=>e.options.length===1 && e.options[0].value==='codeagent')})()"));
    await shot('01-company-plain-group');
    await cdp.eval(`(()=>{for(const e of document.querySelectorAll('.mcm-model-select')){e.value=${JSON.stringify(glm)};e.dispatchEvent(new Event('change',{bubbles:true}))}document.querySelector('#mcm-title-input').value='普通群聊精简验收';})()`);
    await wait(() => cdp.eval("!document.querySelector('.mcm-create').disabled"), 'group create ready');
    await click('.mcm-create');
    const plain = await wait(async () => (await invoke('get-meetings')).find(m => m.title === '普通群聊精简验收'), 'plain group created', 60000);
    await cdp.eval(`selectMeeting(${JSON.stringify(plain.id)})`);
    await wait(() => cdp.eval("!!document.querySelector('#mr-input-box')"), 'plain group composer');
    ok('普通群聊创建后没有工作流、循环和委员会入口', await cdp.eval("['#mr-workflow-btn','#mr-workflow-controls','[data-committee-open]','[data-committee-history]'].every(s=>{const e=document.querySelector(s);return !e||!e.getBoundingClientRect().height})"));
    ok('普通群聊未附带旧编排或开发工作流', !plain.orchestration?.enabled && !plain.serialWorkflow?.enabled && plain.scene !== 'dev');
    await shot('01b-company-plain-room');
    // Add the unverified account after ordinary group startup. Starting a CLI
    // there first legitimately discovers its menu and makes it authoritative.
    const b = pool.addAccount(DATA, { note: '审查夹具' });
    seed(pool.accountDir(DATA, b), 'z-fixture', ds, false);
    const lead = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title: '公司组队验收负责人', codeagentAccount: 'pool', codeagentPoolPick: a, model: glm, codeagentModelPick: true } });
    ok('负责人是 CodeAgent 会话', !!lead?.id);
    const accounts = await command(lead.id, ['accounts']);
    ok('accounts 返回号池和逐号模型权限', accounts.kind === 'codeagent' && accounts.rows.length === 2 && accounts.rows.every(r => r.usable && r.models.length === 1));
    assert.equal(accounts.rows.find(r => r.id === a).modelsAuthoritative, true);
    assert.equal(accounts.rows.find(r => r.id === b).modelsAuthoritative, false);
    ok('accounts 不暴露凭证内容或账号目录', !JSON.stringify(accounts).includes('local-fixture-only') && !accounts.rows.some(r => r.dir || r.accessToken));
    const planFile = path.join(ROOT, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({ goal: '公司版普通群聊与组队验收', members: [
      { kind: 'codeagent', account: a, model: glm, title: '研发成员', role: '实现', task: '核对功能并汇报' },
      { kind: 'codeagent', account: b, model: ds, title: '审查成员', role: '审查', task: '独立审查并汇报' },
    ] }));
    const plan = await command(lead.id, ['propose', '--plan-file', planFile]);
    ok('propose 仅提交待批准计划', plan.status === 'pending' && (await invoke('team:list')).result[0].members.length === 0);
    await wait(() => cdp.eval(`!!document.querySelector('[data-team-approve="${lead.id}"]')`), 'approval badge');
    await click(`[data-team-approve="${lead.id}"]`);
    await wait(() => cdp.eval("!!document.querySelector('.team-modal') && !document.querySelector('[data-team-act=approve]').disabled"), 'accounts loaded');
    ok('审批界面显示号池和每人模型，不显示 Claude/Codex 额度列', await cdp.eval("(()=>{const e=document.querySelector('.team-modal');return document.querySelectorAll('[data-team-model]').length===2 && e.textContent.includes('号池账号') && !/Claude|Codex|5h|7d|\\u7530\\u54e5/.test(e.textContent)})()"));
    ok('审批表没有水平溢出', await cdp.eval("(()=>{const e=document.querySelector('.team-modal');return e.scrollWidth<=e.clientWidth+1})()"));
    ok('模型权限未核实仅在对应账号行显示', await cdp.eval("document.querySelector('[data-team-model-hint=\"0\"]').getBoundingClientRect().height===0 && document.querySelector('[data-team-model-hint=\"1\"]').getBoundingClientRect().height>0"));
    await shot('02-company-approval'); await click('[data-team-act="approve"]');
    await wait(() => cdp.eval("!document.querySelector('.team-modal')"), 'approved');
    const team = await wait(async () => { const t = (await invoke('team:list')).result[0]; return t.members.length === 2 && t.members.every(m => m.status === 'active') && t; }, 'two members', 60000);
    ok('批准后只创建两名 CodeAgent，保留指定账号和模型', team.members.every(m => m.kind === 'codeagent') && team.members[0].account === a && team.members[1].account === b && team.members[1].model === ds);
    for (const m of team.members) {
      await wait(() => nativeReceived(m.sid, '【组队开工'), 'kickoff received', 60000);
      ok(`${m.memberId} 从正确号池目录启动并收到开工任务`, launches().some(v => v.hubSession === m.sid && path.resolve(v.configDir) === path.resolve(pool.accountDir(DATA, m.account))));
    }
    const m1 = team.members[0].sid;
    ok('成员不能再招人', /成员不能招人/.test(await command(m1, ['propose', '--plan-file', planFile], true)));
    ok('成员直连保持负责人审批边界', /负责人先开放/.test(await command(m1, ['send', '--to', 'm2', '--message', 'peer'], true)));
    await command(lead.id, ['send', '--to', 'm1', '--message', '负责人发来的验收消息-m4']);
    await wait(() => nativeReceived(m1, '负责人发来的验收消息-m4'), 'lead to member delivered', 60000);
    await command(m1, ['send', '--to', 'lead', '--message', '成员返回的验收回执-m4']);
    await wait(() => nativeReceived(lead.id, '成员返回的验收回执-m4'), 'member to lead delivered', 60000);
    ok('负责人和成员 CLI send 双向消息进入对方原生记录');
    await wait(() => cdp.eval(`document.querySelectorAll('[data-sidebar-render-key="team:${lead.id}"] .session-item.child').length===2`), 'nested sidebar');
    await shot('03-company-team-members');
    evidence.ok = true;
  } catch (e) {
    evidence.error = e.stack || String(e); if (cdp) await shot('failure').catch(() => {}); throw e;
  } finally {
    fs.writeFileSync(path.join(ART, '20261102-company-team-evidence-m4.json'), JSON.stringify(evidence, null, 2));
    if (cdp) await cdp.close();
    if (hub) await gracefulQuit(hub);
    // The Hub has exited cleanly. Release the driver's log readers as well:
    // inherited Windows pipe handles can otherwise keep this test alive.
    hub?.child.stdout?.destroy(); hub?.child.stderr?.destroy(); hub?.child.stdin?.destroy();
    assert.equal(fs.readFileSync(marker, 'utf8'), markerText, 'The member edition marker must stay unchanged');
    console.log('ARTIFACTS ' + ART);
  }
}
run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
