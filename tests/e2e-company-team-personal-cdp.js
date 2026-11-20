'use strict';
// 只有一个个人账号时走完组队：真实隔离 Electron、真实 hub-team CLI，CodeAgent 用本地协议替身，不碰真实凭据。
// 用法：node tests/e2e-company-team-personal-cdp.js [--approval auto|manual] [--out 目录]
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
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const APPROVAL = arg('--approval', 'auto');
const ART = path.resolve(arg('--out', path.join(os.tmpdir(), `team-personal-${Date.now()}`)), APPROVAL);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'team-personal-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal');
const CONTROL = path.join(ROOT, 'fixture-control'), LOG = path.join(ROOT, 'fixture.jsonl');
const MODEL = 'GLM-5.2-WX-Auto', IDENTITY = 'p-fixture';
const SHARED = '这些成员和你共用同一个号的额度与并发，人多会变慢；想更快可以在号池再登一个别的号';
const DUPLICATE = '这就是你的个人账号，组队会自动用它，不用再登进号池';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
async function wait(fn, label, ms = 30000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(200); } throw Error(`Timeout ${label}${last ? ': ' + last.message : ''}`); }
const launches = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(v => v.configDir) : [];
function seed(dir, accountId) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId, expiresAt: Date.now() + 3600e3 } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: MODEL }));
  writeProbed(path.join(dir, 'hub-models.json'), { models: [MODEL], defaultModel: MODEL, source: 'test-fixture' });
}

async function run() {
  for (const dir of [DATA, WORK, ART, CONTROL]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  if (APPROVAL === 'manual') fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ team: { autoApproveLeads: false } }), 'utf8');
  seed(PERSONAL, IDENTITY);
  const credentialsBefore = fs.readFileSync(path.join(PERSONAL, '.credentials.json'), 'utf8');
  const ok = (label, condition = true) => { assert(condition, label); console.log('PASS ' + label); };
  let hub, cdp, failure, seq = 0;
  const invoke = (channel, args) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
  const shot = async name => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    const p = await wait(() => cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`), 'click ' + selector);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  const command = async (sid, args) => {
    await wait(() => fs.existsSync(path.join(CONTROL, `${sid}.ready`)), 'fixture ready');
    const id = ++seq, request = path.join(CONTROL, `${sid}.request`), result = path.join(CONTROL, `${sid}.${id}.response`);
    fs.writeFileSync(request + '.tmp', JSON.stringify({ id, args })); fs.renameSync(request + '.tmp', request);
    await wait(() => fs.existsSync(result), `CLI ${args[0]}`);
    const r = JSON.parse(fs.readFileSync(result, 'utf8'));
    assert.equal(r.code, 0, r.err || r.error); return JSON.parse(r.out);
  };
  const received = (sid, needle) => launches().filter(v => v.hubSession === sid).some(v => {
    const file = path.join(v.configDir, 'projects', v.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${v.sessionId}.jsonl`);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      .some(r => r.type === 'user' && r.message?.content?.includes(needle));
  });
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), windowMode: 'hidden', extraEnv: {
      HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', AI_HUB_WORKSPACE_ROOT: WORK,
      AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG, CODEAGENT_TEAM_FAKE_CONTROL_DIR: CONTROL,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'empty-scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'),
    } });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await wait(() => cdp.eval('!!window.__teamUi && !!window.__codeagentAccountsOpen'), 'renderer ready');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    const lead = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title: '单号组队负责人', codeagentAccount: 'personal' } });
    ok('负责人用个人账号启动', !!lead?.id);
    const accounts = await command(lead.id, ['accounts']);
    ok('号池为空时 accounts 推荐个人账号', accounts.recommendedId === 'personal' && accounts.rows.length === 1 && accounts.rows[0].usable);
    ok('accounts 说明共用额度的代价', accounts.note.includes(SHARED) && accounts.rows[0].sharedNote === SHARED);
    ok('accounts 不暴露凭据和目录', !JSON.stringify(accounts).includes('local-fixture-only') && !accounts.rows[0].dir);

    const planFile = path.join(ROOT, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({ goal: '只有一个个人号也能组队', members: [{ title: '单号成员', role: '实现', task: '核对单号组队并汇报' }] }));
    const proposed = await command(lead.id, ['propose', '--plan-file', planFile]);
    if (APPROVAL === 'manual') {
      ok('人工批准模式下计划待批准', proposed.status === 'pending');
      await click(`[data-team-approve="${lead.id}"]`);
      await wait(() => cdp.eval("!!document.querySelector('.team-modal') && !document.querySelector('[data-team-act=approve]').disabled"), 'approval ready');
      ok('审批框选中个人账号并写明代价', await cdp.eval(`(()=>{const s=document.querySelector('[data-team-account="0"]'),h=document.querySelector('[data-team-account-hint="0"]');return s.value==='personal'&&!h.hidden&&h.textContent===${JSON.stringify(SHARED)}&&h.getBoundingClientRect().height>0})()`));
      ok('审批框没有水平溢出', await cdp.eval("(()=>{const e=document.querySelector('.team-modal');return e.scrollWidth<=e.clientWidth+1})()"));
      await shot('01-approval-personal');
      await click('[data-team-act="approve"]');
    } else ok('默认自动批准直接建成且回执写明代价', proposed.status === 'approved' && proposed.created.length === 1 && proposed.note.includes(SHARED));

    const team = await wait(async () => { const t = (await invoke('team:list')).result[0]; return t?.members.length === 1 && t.members[0].status === 'active' && t; }, 'member active', 60000);
    const member = team.members[0];
    ok('成员记在个人账号上', member.account === 'personal' && member.sharedNote === SHARED);
    await wait(() => received(member.sid, '【组队开工'), 'kickoff received', 60000);
    ok('成员从个人配置目录启动并收到开工任务', launches().some(v => v.hubSession === member.sid && path.resolve(v.configDir) === path.resolve(PERSONAL)));
    await wait(() => received(lead.id, SHARED), 'lead receipt', 60000);
    ok('负责人收到的招人回执写明代价');
    const tag = `[data-sidebar-render-key="team:${lead.id}"] .team-member-tag.shared`;
    await wait(() => cdp.eval(`!!document.querySelector(${JSON.stringify(tag)})`), 'shared tag');
    ok('侧栏成员卡标出共用并在悬停时写明代价', await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(tag)});return e.textContent==='共用'&&e.title===${JSON.stringify(SHARED)}})()`));
    await shot('02-sidebar-member');

    const duplicate = pool.addAccount(DATA, { note: '重复登录' });
    seed(pool.accountDir(DATA, duplicate), IDENTITY);
    const after = await command(lead.id, ['accounts']);
    ok('个人号登进号池后提示改为人话', after.recommendedId === 'personal' && after.rows.find(r => r.id === duplicate).unavailableReason === DUPLICATE);
    await click('#btn-rail-accounts');
    await wait(() => cdp.eval(`!!document.querySelector('[data-ca-account="${duplicate}"]')`), 'accounts page row');
    ok('号池页给出同样说明', await cdp.eval(`document.querySelector('[data-ca-account="${duplicate}"]').textContent.includes(${JSON.stringify(DUPLICATE)})`));
    ok('号池页说明完整显示，没有被截断', await cdp.eval(`(()=>{const e=document.querySelector('[data-ca-account="${duplicate}"] .caa-status-cell>.caa-cell-sub');return e.textContent===${JSON.stringify(DUPLICATE)}&&e.scrollWidth<=e.clientWidth+1&&e.scrollHeight<=e.clientHeight+1})()`));
    ok('账号页在 1440 宽下没有水平溢出', await cdp.eval("document.documentElement.scrollWidth<=innerWidth+1"));
    await shot('03-accounts-duplicate');

    // 负责人照着 accounts 点名了号池里那份重复登录的号：照样招到人，成员落在个人账号上（2026-11-20 单号组队）。
    await click('#btn-home'); // 回到主界面再批准：账号页盖住侧栏时点不到「待批准」
    const dupPlan = path.join(ROOT, 'plan-dup.json');
    fs.writeFileSync(dupPlan, JSON.stringify({ goal: '点名重复号也能组队', members: [{ title: '点名重复号', role: '复核', task: '核对点名重复号的组队', account: duplicate }] }));
    const dupProposed = await command(lead.id, ['propose', '--plan-file', dupPlan]);
    if (APPROVAL === 'manual') {
      ok('点名重复号的计划进入待批准', dupProposed.status === 'pending');
      await wait(() => cdp.eval(`!!document.querySelector('[data-team-approve="${lead.id}"]')`), 'dup pending badge');
      // 已有成员在跑时侧栏会频繁重画，按下和松开之间角标可能被换掉；像用户一样没弹出就再点一次。
      for (let i = 0; i < 5 && !(await cdp.eval("!!document.querySelector('.team-modal')")); i++) { await click(`[data-team-approve="${lead.id}"]`); await sleep(1500); }
      await wait(() => cdp.eval("!!document.querySelector('.team-modal') && !document.querySelector('[data-team-act=approve]').disabled"), 'dup approval ready')
        .catch(async e => { throw Error(e.message + ' ' + await cdp.eval(`JSON.stringify({modal:!!document.querySelector('.team-modal'),disabled:document.querySelector('[data-team-act=approve]')?.disabled,err:document.querySelector('.team-error')?.textContent,acc:[...document.querySelectorAll('[data-team-account]')].map(s=>s.value)})`)); });
      ok('审批框把重复号换成个人账号', await cdp.eval(`document.querySelector('[data-team-account="0"]').value==='personal'`));
      await click('[data-team-act="approve"]');
    } else ok('点名重复号的计划自动批准建成', dupProposed.status === 'approved' && dupProposed.created.length === 1);
    const team2 = await wait(async () => { const t = (await invoke('team:list')).result[0]; return t?.members.length === 2 && t.members[1].status === 'active' && t; }, 'dup member active', 60000);
    ok('点名重复号的成员记在个人账号上', team2.members[1].account === 'personal');
    await wait(() => launches().some(v => v.hubSession === team2.members[1].sid), 'dup member launch', 60000);
    ok('点名重复号的成员从个人配置目录启动', launches().some(v => v.hubSession === team2.members[1].sid && path.resolve(v.configDir) === path.resolve(PERSONAL)));

    // 首页与建群弹窗：多 AI 分工统一推荐负责人组队，群聊定位为自己挑成员同场讨论。
    await click('#btn-home');
    await wait(() => cdp.eval(`!!document.querySelector('#home-create-group')&&document.querySelector('#home-create-group').getBoundingClientRect().height>0`), 'home visible');
    ok('首页两张入口卡写明各自用途', await cdp.eval(`document.querySelector('#home-create-session').textContent.includes('自己组队招人')&&document.querySelector('#home-create-group').textContent.includes('同场讨论')`));
    await shot('04-home-entries');
    await click('#home-create-group');
    await wait(() => cdp.eval(`(()=>{const e=document.querySelector('#mcm-team-tip');return !!e&&e.getBoundingClientRect().height>0})()`), 'group modal tip');
    ok('建群弹窗推荐负责人组队且没有溢出', await cdp.eval(`(()=>{const e=document.querySelector('#mcm-team-tip');return e.textContent.includes('需要的话组队做')&&e.scrollWidth<=e.clientWidth+1})()`));
    await shot('05-group-modal-tip');
    ok('个人凭据未被改动', fs.readFileSync(path.join(PERSONAL, '.credentials.json'), 'utf8') === credentialsBefore);
  } catch (e) {
    failure = e; if (cdp) await shot('failure').catch(() => {});
  } finally {
    try { if (cdp) await cdp.close(); } catch (e) { failure ||= e; }
    try { if (hub) await gracefulQuit(hub); } catch (e) { failure ||= e; }
    finally {
      hub?.child.stdout?.destroy(); hub?.child.stderr?.destroy(); hub?.child.stdin?.destroy();
      if (hub) fs.writeFileSync(path.join(ART, 'hub.log'), hub.log().join('\n'), 'utf8');
    }
    console.log('ARTIFACTS ' + ART);
  }
  if (failure) throw failure;
}
run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
