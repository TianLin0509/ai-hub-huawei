'use strict';
// Real isolated Electron, real approval clicks, production hub-team CLI and
// session-bound identity. CodeAgent is a local protocol fixture, not a model.
// Run against a company edition with isolated user data; never replace its marker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pool = require('../core/codeagent-pool');
const quota = require('../core/codeagent-quota');
const { writeProbed } = require('../core/codeagent-model-probe');

const REPO = path.resolve(__dirname, '..');
const options = { entry: REPO };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (['--entry', '--out'].includes(flag) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options[flag.slice(2)] = process.argv[++i];
  else throw Error('Expected --entry/--out value');
}
const ENTRY = path.resolve(options.entry);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-company-team-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal');
const CONTROL = path.join(ROOT, 'fixture-control'), LOG = path.join(ROOT, 'fixture.jsonl');
const ART = path.resolve(options.out || process.env.HUB_E2E_ARTIFACT_DIR || path.join(REPO, 'artifacts', `company-team-${Date.now()}`));
const marker = path.join(ENTRY, 'community-edition.json');
const edition = JSON.parse(fs.readFileSync(marker, 'utf8'));
// Account navigation probes missing model permissions and would consume the
// original approval fixture's deliberately unverified account.
const NAV = { button: '#btn-company-ppt', page: '#company-ppt-page', label: 'PPT' };
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
function entryIdentity() {
  const sourceHashes = {};
  for (const file of ['renderer/meeting-create-modal.js', 'renderer/team-ui.js', 'community-edition.json']) {
    sourceHashes[file] = createHash('sha256').update(fs.readFileSync(path.join(ENTRY, file))).digest('hex');
  }
  try {
    const git = args => execFileSync('git', args, { cwd: ENTRY, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { sha: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain']), sourceHashes };
  } catch { return { sha: null, dirty: null, sourceHashes, note: 'exported source tree without Git metadata' }; }
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
  const evidence = { checks: [], root: ROOT, artifacts: ART, entry: ENTRY, entryIdentity: entryIdentity(), navigation: NAV,
    scriptSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), model: 'none; local CodeAgent protocol fixture' };
  const ok = (label, condition = true) => { assert(condition, label); evidence.checks.push(label); console.log('PASS ' + label); };
  let hub, cdp, failure, seq = 0;
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
    hub = await launchIsolatedHub({ entryPath: ENTRY, cwd: ENTRY, dataDir: DATA, port: await freePort(), windowMode: 'hidden', extraEnv: {
      HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG, CODEAGENT_TEAM_FAKE_CONTROL_DIR: CONTROL,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'empty-scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'),
      HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await wait(() => cdp.eval('!!window.__teamUi && !!window.openMeetingCreateModal'), 'renderer ready');
    await cdp.eval("window.__teamViewportEvents=[];window.addEventListener('resize',()=>window.__teamViewportEvents.push({width:innerWidth,height:innerHeight}))");
    const setViewport = async (width, height) => {
      const before = await cdp.eval('({width:innerWidth,height:innerHeight,eventCount:window.__teamViewportEvents.length})');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      if (before.width !== width || before.height !== height) {
        // Flush the hidden compositor before pointer input. CSS dimensions can
        // update before hit testing and the actual resize event catch up.
        await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await wait(() => cdp.eval(`window.__teamViewportEvents.slice(${before.eventCount}).some(e=>e.width===${width}&&e.height===${height})`), 'viewport resize event');
      }
    };
    await setViewport(1440, 900);
    ok('公司发行标记生效，组队已开启', await cdp.eval("require('../core/distribution').target==='company' && require('../core/distribution').featureEnabled('leadTeam')"));
    await cdp.eval(`window.__teamScrimNavClicks=0;document.querySelector(${JSON.stringify(NAV.button)}).addEventListener('click',()=>window.__teamScrimNavClicks++)`);
    const checkScrim = async (kind, selector, reopen) => {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
        await setViewport(viewport.width, viewport.height);
        await reopen();
        await wait(() => cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&e.getBoundingClientRect().height>0})()`), kind + ' open');
        await shot(`scrim-${kind}-${viewport.width}`);
        const bounds = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),n=document.querySelector(${JSON.stringify(NAV.button)}).getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,coversRail:document.elementFromPoint(n.x+n.width/2,n.y+n.height/2)===e}})()`);
        evidence.scrims ||= []; evidence.scrims.push({ kind, ...viewport, ...bounds });
        // 布局取整会留下万分之一像素的浮点误差（如 right=1440.0001），按半像素以内算贴满。
        ok(`${kind} ${viewport.width} 整屏遮罩覆盖导航区域`, Math.abs(bounds.left) < 0.5 && Math.abs(bounds.top) < 0.5 && Math.abs(bounds.right - bounds.width) < 0.5 && Math.abs(bounds.bottom - bounds.height) < 0.5 && bounds.coversRail);
        const before = await cdp.eval('window.__teamScrimNavClicks');
        // Send a real pointer click at the underlying navigation button's
        // coordinates. Its first click must hit the backdrop, not the button.
        await click(NAV.button);
        await wait(() => cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !e||e.getBoundingClientRect().height===0})()`), kind + ' dismissed');
        ok(`${kind} ${viewport.width} 点击左栏位置只关闭弹窗且不穿透导航`, await cdp.eval(`window.__teamScrimNavClicks===${before}&&(!document.querySelector(${JSON.stringify(NAV.page)})||document.querySelector(${JSON.stringify(NAV.page)}).hidden)`));
        await click(NAV.button);
        await wait(() => cdp.eval(`!!document.querySelector(${JSON.stringify(NAV.page)})&&!document.querySelector(${JSON.stringify(NAV.page)}).hidden`), 'navigation after dismissal');
        ok(`${kind} ${viewport.width} 弹窗关闭后第二次点击正常进入${NAV.label}`, await cdp.eval('window.__teamScrimNavClicks') === before + 1);
        await click('#btn-home');
      }
      await setViewport(1440, 900);
    };
    await checkScrim('group', '#meeting-create-modal', () => cdp.eval("window.openMeetingCreateModal('general')"));
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
    quota.markModelAvoid(DATA, b, { model: ds });
    const paused = await command(lead.id, ['accounts']);
    const pausedRow = paused.rows.find(r => r.id === b);
    ok('accounts 标记当前模型暂停并从推荐中排除', !pausedRow.usable && pausedRow.unavailableReason === '暂停中' && paused.recommendedId !== b);
    ok('模型暂停在提交计划时即拒绝，不创建成员', /账号不可用/.test(await command(lead.id, ['propose', '--plan-file', planFile], true))
      && (await invoke('team:list')).result.every(t => t.members.length === 0));
    quota.clearModelAvoid(DATA, b);
    const plan = await command(lead.id, ['propose', '--plan-file', planFile]);
    ok('propose 仅提交待批准计划', plan.status === 'pending' && (await invoke('team:list')).result[0].members.length === 0);
    await wait(() => cdp.eval(`!!document.querySelector('[data-team-approve="${lead.id}"]')`), 'approval badge');
    // The pending plan was valid when proposed; a model pause can arrive before
    // the user opens it. The unavailable choice must be visible before approval.
    quota.markModelAvoid(DATA, b, { model: ds });
    await click(`[data-team-approve="${lead.id}"]`);
    await wait(() => cdp.eval(`(()=>{const s=document.querySelector('[data-team-account="1"]');return !!s?.selectedOptions[0]?.textContent.includes('暂停中')})()`), 'paused approval loaded');
    ok('审批保留原选号但标暂停且禁批准', await cdp.eval(`(()=>{const s=document.querySelector('[data-team-account="1"]');return s.value===${JSON.stringify(b)} && s.selectedOptions[0].disabled && document.querySelector('[data-team-act="approve"]').disabled})()`));
    // Escape is shared by the baseline dialog and the reskinned drawer.
    await click('[data-team-note]');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait(() => cdp.eval("!document.querySelector('.team-modal')"), 'close approval before navigation checks');
    const reopenApproval = async () => {
      await cdp.eval(`selectSession(${JSON.stringify(lead.id)})`);
      await click(`[data-team-approve="${lead.id}"]`);
      // CDP represents undefined as an object; wait predicates must be boolean.
      await wait(() => cdp.eval("!!document.querySelector('[data-team-account=\"1\"]')?.selectedOptions[0]?.textContent.includes('暂停中')"), 'paused accounts loaded');
    };
    await checkScrim('team', '.team-modal-backdrop', reopenApproval);
    await reopenApproval();
    await shot('02a-model-paused-approval-1440');
    await setViewport(1280, 900);
    await shot('02b-model-paused-approval-1280');
    await cdp.eval(`(()=>{const s=document.querySelector('[data-team-account="1"]');s.value=${JSON.stringify(a)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    ok('审批换成可用号后允许批准', await cdp.eval("!document.querySelector('[data-team-act=approve]').disabled"));
    await click('[data-team-note]'); // Give the modal keyboard focus before Escape.
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait(() => cdp.eval("!document.querySelector('.team-modal')"), 'close paused approval');
    quota.clearModelAvoid(DATA, b);
    ok('解除模型暂停后accounts恢复可用', (await command(lead.id, ['accounts'])).rows.find(r => r.id === b).usable);
    await setViewport(1440, 900);
    await click(`[data-team-approve="${lead.id}"]`);
    await wait(() => cdp.eval("!!document.querySelector('.team-modal') && !document.querySelector('[data-team-act=approve]').disabled"), 'accounts loaded');
    ok('审批界面显示号池和每人模型，不显示 Claude/Codex 额度列', await cdp.eval("(()=>{const e=document.querySelector('.team-modal');return document.querySelectorAll('[data-team-model]').length===2 && e.textContent.includes('号池账号') && !/Claude|Codex|5h|7d|\\u7530\\u54e5/.test(e.textContent)})()"));
    ok('审批表没有水平溢出', await cdp.eval("(()=>{const e=document.querySelector('.team-modal');return e.scrollWidth<=e.clientWidth+1})()"));
    ok('模型权限未核实仅在对应账号行显示', await cdp.eval("document.querySelector('[data-team-model-hint=\"0\"]').getBoundingClientRect().height===0 && document.querySelector('[data-team-model-hint=\"1\"]').getBoundingClientRect().height>0"));
    await shot('02-company-approval'); await click('[data-team-act="approve"]');
    await wait(() => cdp.eval("!document.querySelector('.team-modal')"), 'approved');
    const team = await wait(async () => { const t = (await invoke('team:list')).result[0]; return t.members.length === 2 && t.members.every(m => m.status === 'active') && t; }, 'two members', 60000);
    ok('批准后只创建两名 CodeAgent，保留指定账号和模型', team.members.every(m => m.kind === 'codeagent') && team.members[0].account === a && team.members[1].account === b && team.members[1].model === ds);
    ok('后台创建成员不切走负责人画面', await cdp.eval(`activeSessionId===${JSON.stringify(lead.id)}`));
    for (const m of team.members) {
      await wait(() => nativeReceived(m.sid, '【组队开工'), 'kickoff received', 60000);
      ok(`${m.memberId} 从正确号池目录启动并收到开工任务`, launches().some(v => v.hubSession === m.sid && path.resolve(v.configDir) === path.resolve(pool.accountDir(DATA, m.account))));
    }
    const m1 = team.members[0].sid;
    const liveStatus = await command(lead.id, ['status']);
    ok('status 显示成员最近输出分钟数', liveStatus.members.filter(m=>m.memberId!=='lead').every(m=>Number.isFinite(m.runtime?.lastOutputMinAgo) && m.runtime.lastOutputMinAgo>=0));
    ok('成员不能再招人', /成员不能招人/.test(await command(m1, ['propose', '--plan-file', planFile], true)));
    ok('成员直连保持负责人审批边界', /负责人先开放/.test(await command(m1, ['send', '--to', 'm2', '--message', 'peer'], true)));
    await command(lead.id, ['send', '--to', 'm1', '--message', '负责人发来的验收消息-m4']);
    await wait(() => nativeReceived(m1, '负责人发来的验收消息-m4'), 'lead to member delivered', 60000);
    await command(m1, ['send', '--to', 'lead', '--message', '成员返回的验收回执-m4']);
    await wait(() => nativeReceived(lead.id, '成员返回的验收回执-m4'), 'member to lead delivered', 60000);
    ok('负责人和成员 CLI send 双向消息进入对方原生记录');
    await wait(() => cdp.eval(`document.querySelectorAll('[data-sidebar-render-key="team:${lead.id}"] .session-item.child').length===2`), 'nested sidebar');
    await shot('03-company-team-members');
    await cdp.eval(`selectSession(${JSON.stringify(lead.id)})`);
    await cdp.eval(`sessions.get(${JSON.stringify(m1)}).unreadCount=3`);
    const restarted = await invoke('restart-session', m1);
    ok('成员可通过真实生命周期重启', !!restarted && restarted.ok !== false);
    await wait(() => cdp.eval(`!!sessions.get(${JSON.stringify(m1)}) && sessions.get(${JSON.stringify(m1)}).status!=='dormant' && !sessions.get(${JSON.stringify(m1)})._resumePending`), 'member restarted', 60000);
    ok('后台重启成员仍停在负责人且保留未读', await cdp.eval(`activeSessionId===${JSON.stringify(lead.id)} && sessions.get(${JSON.stringify(m1)}).unreadCount>=3`));
    const suspended = await invoke('suspend-session', m1);
    ok('成员可休眠', suspended.ok === true);
    await wait(() => cdp.eval(`sessions.get(${JSON.stringify(m1)})?.status==='dormant'`), 'member dormant');
    await click(`[data-sidebar-render-key="team:${lead.id}"] .session-item.child[data-session-id="${m1}"]`);
    await wait(() => cdp.eval(`activeSessionId===${JSON.stringify(m1)} && sessions.get(${JSON.stringify(m1)})?.status!=='dormant' && !_pendingDormantResumes.has(${JSON.stringify(m1)})`), 'explicit member resume', 60000);
    ok('用户点击休眠成员仍可进入且清除未读', await cdp.eval(`sessions.get(${JSON.stringify(m1)}).unreadCount===0`));
    await shot('04-company-team-explicit-resume');
    const toggle = `.session-item[data-session-id="${lead.id}"] [data-team-toggle]`;
    const children = `[data-sidebar-render-key="team:${lead.id}"] .session-item.child`;
    await click(toggle);
    await wait(()=>cdp.eval(`document.querySelectorAll(${JSON.stringify(children)}).length===0`),'collapse members');
    ok('折叠仅隐藏成员行，当前成员会话不切走', await cdp.eval(`activeSessionId===${JSON.stringify(m1)} && !!document.querySelector('.session-item[data-session-id="${lead.id}"]')`));
    await command(lead.id,['send','--to','m1','--message','折叠期间后台仍可收消息']);
    await wait(()=>nativeReceived(m1,'折叠期间后台仍可收消息'),'collapsed background message',60000);
    ok('折叠期间成员后台仍正常收消息');
    await shot('05-team-collapsed');
    await click(toggle);
    await wait(()=>cdp.eval(`document.querySelectorAll(${JSON.stringify(children)}).length===2`),'expand members');
    ok('再次点击可展开成员编号', await cdp.eval(`document.querySelectorAll(${JSON.stringify(children+' .team-member-tag')}).length===2`));
    await click(toggle);
    await click('#btn-global-search');
    await wait(()=>cdp.eval("!!document.querySelector('#search-query')?.getBoundingClientRect().width"),'search input');
    await click('#search-query');
    await cdp.send('Input.insertText',{text:'研发成员'});
    await wait(()=>cdp.eval("[...document.querySelectorAll('.session-search-result')].some(e=>e.textContent.includes('研发成员'))"),'collapsed member search hit');
    await cdp.eval("[...document.querySelectorAll('.session-search-result')].find(e=>e.textContent.includes('研发成员')).focus()");
    for(const type of ['keyDown','keyUp']) await cdp.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:2});
    await wait(()=>cdp.eval(`document.querySelectorAll(${JSON.stringify(children)}).length===2 && activeSessionId===${JSON.stringify(m1)}`),'search reveals member');
    ok('搜索命中折叠成员并自动展开所属团队');
    await shot('06-team-search-revealed');
    const longText='  合同原文\n'+'完整证据😀\n'.repeat(400)+'末尾验收标准  ';
    const messageFile=path.join(ROOT,'complete-message.md');fs.writeFileSync(messageFile,longText);
    const archived=await command(lead.id,['send','--to','m1','--message-file',messageFile]);
    const readBack=await command(m1,['read','--id',archived.messageId]);
    ok('真实 CLI read 返回长消息完整正文且保留首尾空白',readBack.text===longText && fs.readFileSync(archived.bodyPath,'utf8')===longText);
    ok('非参与者不能读取该消息原文',/参与者/.test(await command(team.members[1].sid,['read','--id',archived.messageId],true)));
    await wait(()=>nativeReceived(m1,archived.messageId),'archive notice received',60000);
    await click(toggle);
    await wait(()=>cdp.eval(`document.querySelectorAll(${JSON.stringify(children)}).length===0`),'collapse before reload');
    await cdp.send('Page.reload');
    await wait(()=>cdp.eval(`document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-expanded')==='false'`),'collapse restored after reload',60000);
    ok('页面刷新后仍保留折叠偏好',await cdp.eval(`document.querySelectorAll(${JSON.stringify(children)}).length===0`));
    await shot('07-team-collapse-after-reload');
    evidence.uiChecksPassed = true;
  } catch (e) {
    failure = e; evidence.error = e.stack || String(e); if (cdp) await shot('failure').catch(() => {});
  } finally {
    try { if (cdp) await cdp.close(); } catch (e) { failure ||= e; evidence.cdpCloseError = e.stack; }
    try { if (hub) evidence.exit = await gracefulQuit(hub); }
    catch (e) { failure ||= e; evidence.exitError = e.stack; evidence.exit = { exitCode: hub?.exitCode(), exitSignal: hub?.exitSignal(), forced: !!e.termination?.forced }; }
    finally {
      hub?.child.stdout?.destroy(); hub?.child.stderr?.destroy(); hub?.child.stdin?.destroy();
      if (hub) fs.writeFileSync(path.join(ART, 'hub.log'), hub.log().join('\n'), 'utf8');
    }
    try { assert.equal(fs.readFileSync(marker, 'utf8'), markerText, 'The edition marker must stay unchanged'); }
    catch (e) { failure ||= e; evidence.markerError = e.message; }
    evidence.entryIdentityAfter = entryIdentity();
    evidence.ok = evidence.uiChecksPassed === true && !failure;
    fs.writeFileSync(path.join(ART, '20261102-company-team-evidence-m4.json'), JSON.stringify(evidence, null, 2));
    console.log('ARTIFACTS ' + ART);
  }
  if (failure) throw failure;
}
run().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
