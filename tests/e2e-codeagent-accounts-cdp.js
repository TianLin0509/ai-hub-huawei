'use strict';
// Real isolated UI/IPC/registry/session routing; login and CodeAgent use local fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pool = require('../core/codeagent-pool');
const quota = require('../core/codeagent-quota');
const { writeProbed } = require('../core/codeagent-model-probe');
const REPO = path.resolve(__dirname, '..');
const MEMBER = require('../community-edition.json').repo.endsWith('-member');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-page-m1-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal'), SCAN = path.join(ROOT, 'scan');
const ART = process.env.HUB_E2E_ARTIFACT_DIR || path.join(REPO, 'artifacts', `20261103-accounts-${Date.now()}-m1`);
const MODEL = 'GLM-5.2-WX-Auto', LOG = path.join(ROOT, 'fixture.jsonl');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function wait(fn, label, timeout = 40000) { const end = Date.now() + timeout; let error; while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (e) { error = e; } await sleep(150); } throw Error(`Timeout ${label}${error ? ': ' + error.message : ''}`); }
function seed(dir, accountId, expiry = Date.now() + 72 * 3600e3) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId, expiresAt: expiry } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: MODEL }));
  writeProbed(path.join(dir, 'hub-models.json'), { models: [MODEL, 'deepseek-v4-flash-0731', 'MiniMax-M2.5'], defaultModel: MODEL, source: 'test-fixture' });
}
async function run() {
  for (const dir of [DATA, WORK, SCAN, ART]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), ''); seed(PERSONAL, 'personal-fixture');
  const evidence = { root: ROOT, artifacts: ART, checks: [], model: 'local protocol fixture; no remote login or inference' };
  const ok = (label, condition = true) => { assert(condition, label); evidence.checks.push(label); console.log('PASS ' + label); };
  let hub, cdp;
  const invoke = (name, payload) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(name)},${JSON.stringify(payload)})`);
  const click = async selector => {
    let prior;
    const xy = await wait(async () => {
      const pos = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height||e.disabled)return null;const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return hit&&(hit===e||e.contains(hit))?{x,y}:null})()`);
      const stable = pos && prior && Math.abs(pos.x-prior.x)<1 && Math.abs(pos.y-prior.y)<1;
      prior = pos; return stable ? pos : null;
    }, selector);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...xy, button: 'left', clickCount: 1 });
  };
  const shot = async name => { const image = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(image.data, 'base64')); };
  const text = () => cdp.eval("document.querySelector('#codeagent-accounts-page')?.textContent || ''");
  const open = async () => { await click('#btn-rail-accounts'); await wait(() => cdp.eval("!!document.querySelector('[data-ca-account=personal]') && !document.getElementById('codeagent-accounts-page').hidden"), 'accounts open'); };
  const refresh = async () => { await click('[data-ca=refresh]'); await wait(() => cdp.eval("!document.querySelector('[data-ca=refresh]').disabled"), 'accounts refreshed'); };
  try {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await freePort(), windowMode: 'hidden', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL,
      CODEAGENT_POOL_FAKE_LOG: LOG, AI_HUB_CODEAGENT_POOL_SCAN_ROOT: SCAN, AI_HUB_CODEAGENT_POOL_LOGIN_FIXTURE: 'accountstest',
      CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'),
    } });
    cdp = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await wait(() => cdp.eval('!!window.__codeagentAccountsOpen && !!window.WorkspaceController'), 'renderer ready');
    await cdp.eval("(()=>{window.__accountCalls=[];const ipc=require('electron').ipcRenderer;const invoke=ipc.invoke.bind(ipc);ipc.invoke=(...args)=>{if(args[0]==='create-session'||args[0].startsWith('codeagent-pool:'))window.__accountCalls.push(args);if(args[0]==='codeagent-pool:list'&&window.__accountListFailure)return Promise.resolve({ok:false,error:'fixture list unavailable'});return invoke(...args)};window.confirm=()=>true})()");
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await open();
    ok('公司左栏账号可见且直接打开新页', await cdp.eval("getComputedStyle(document.getElementById('btn-rail-accounts')).display!=='none' && !document.getElementById('btn-rail-accounts').closest('.rail-group-menu') && document.getElementById('account-page').hidden"));
    ok('空池呈现添加与导入入口', (await text()).includes('号池里还没有账号'));
    await shot('20261103-accounts-empty-1440-m1');
    await click('#btn-options'); await click('#options-settings');
    await wait(() => cdp.eval("!document.getElementById('config-modal').classList.contains('hidden')"), 'settings modal open');
    await click('#btn-config-accounts');
    await wait(() => cdp.eval("document.getElementById('config-modal').classList.contains('hidden')&&!document.getElementById('codeagent-accounts-page').hidden"), 'settings closes before accounts');
    ok('设置中的账号入口真实点击后关闭遮罩，账号页可直接操作');
    await shot('20261104-accounts-settings-entry-m1');
    await cdp.eval("window.LaunchCenter.open('session',{kind:'codeagent'})");
    await wait(() => cdp.eval("[...document.querySelector('#new-session-codeagent-account').options].some(o=>o.value==='manage-accounts')"), 'empty pool guide');
    await click('#new-session-codeagent-choice'); await click('.launch-select-option[data-value="manage-accounts"]');
    ok('空池启动中心真实下拉能返回账号页', await cdp.eval("!document.getElementById('codeagent-accounts-page').hidden && document.getElementById('new-session-menu').style.display==='none'"));
    const good = pool.addAccount(DATA, { note: '研发账号' }), paused = pool.addAccount(DATA, { note: '额度暂停' }), manual = pool.addAccount(DATA, { note: '手动暂停' }), expired = pool.addAccount(DATA, { note: '待登录' });
    seed(pool.accountDir(DATA, good), 'good-fixture'); seed(pool.accountDir(DATA, paused), 'paused-fixture'); seed(pool.accountDir(DATA, manual), 'manual-fixture'); seed(pool.accountDir(DATA, expired), 'expired-fixture', Date.now() - 86400e3);
    quota.markAvoid(DATA, paused, { source: 'quota', kind: 'credit', reason: '额度用完', until: Date.now() + 3600e3 });
    quota.markAvoid(DATA, manual, { source: 'manual', reason: '手动暂停', until: null });
    seed(path.join(SCAN, '.cac-local'), 'local-fixture');
    await refresh();
    ok('非空池区分额度暂停、手动暂停与需登录', /暂停中（额度）/.test(await text()) && /暂停中（手动）/.test(await text()) && /登录已过期/.test(await text()));
    const quotaView = await cdp.eval("({column:[...document.querySelectorAll('.caa-list-head>span')].some(e=>e.textContent==='额度'),foot:!!document.querySelector('.caa-footnote'),text:document.getElementById('codeagent-accounts-page').textContent})");
    ok(MEMBER ? '成员版保留额度列和现有自动暂停说明' : '公开版无读数时无额度列、脚注及会话后读数承诺', MEMBER
      ? quotaView.column && quotaView.foot : !quotaView.column && !quotaView.foot && !/会话运行后显示|自动暂停/.test(quotaView.text));
    for (const width of [1440, 1280]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
      ok(`${width}模型仅首项加余数，完整名称可见于title且采用省略显示`, await cdp.eval(`(()=>{const row=document.querySelector('[data-ca-account="${good}"]'),chips=row.querySelectorAll('.caa-chips>.caa-chip'),s=getComputedStyle(chips[0]);return chips.length===2&&chips[0].title===${JSON.stringify(MODEL)}&&chips[1].textContent==='+2'&&s.textOverflow==='ellipsis'&&s.display==='block'})()`));
      ok(`${width}暂停原因不暴露来源英文和旧标点`, !/（quota）|预计|额度上限/.test(await text()));
      const pauseDetail = await cdp.eval(`(()=>{const e=document.querySelector('[data-ca-account="${paused}"]>.caa-cell .caa-cell-sub');return {text:e.textContent,title:e.title,scrollWidth:e.scrollWidth,width:e.clientWidth}})()`);
      const until = (await invoke('codeagent-pool:list')).accounts.find(a => a.id === paused).avoid.until;
      const recovery = new Date(until + 8 * 3600e3).toISOString(), today = new Date(Date.now() + 8 * 3600e3).toISOString();
      const sameDay = recovery.slice(0, 10) === today.slice(0, 10);
      const expected = '额度用完 · 约 ' + (sameDay ? recovery.slice(11, 16) : recovery.slice(5, 16).replace('T', ' ')) + ' 恢复';
      ok(`${width}当天恢复不带日期且完整显示，跨天保留日期`, pauseDetail.text === expected && pauseDetail.title === expected && (!sameDay || pauseDetail.scrollWidth <= pauseDetail.width + 1));
      await shot(`20261103-accounts-${width}-m1`);
      ok(`${width}账号表无水平溢出`, await cdp.eval("(()=>{const e=document.querySelector('.caa-main');return e.scrollWidth<=e.clientWidth+1})()"));
      await click(`[data-ca=session][data-id="${good}"]`);
      await wait(() => cdp.eval(`document.getElementById('new-session-codeagent-account').value===${JSON.stringify('account:' + good)} && !document.getElementById('new-session-submit').disabled`), 'preselected launcher');
      ok(`${width}只显示一个富账号控件，原生与第二级号池select不可见`, await cdp.eval("document.getElementById('new-session-codeagent-choice').getClientRects().length===1&&!document.getElementById('new-session-codeagent-account').getClientRects().length&&document.getElementById('new-session-codeagent-pool-field').hidden"));
      await click('#new-session-codeagent-choice');
      ok(`${width}统一下拉分组、状态/会话数和禁用账号正确`, await cdp.eval(`(()=>{const opts=[...document.querySelector('#new-session-codeagent-account').options];return opts.find(o=>o.value===${JSON.stringify('account:' + paused)}).disabled&&opts.find(o=>o.value===${JSON.stringify('account:' + expired)}).disabled&&opts.filter(o=>o.value.startsWith('account:')).every(o=>o.textContent.includes('个进行中会话'))&&document.querySelector('.caa-menu-cap').textContent==='指定号池账号'&&opts.at(-1).value==='manage-accounts'&&!opts.some(o=>o.value==='pool-manual')})()`));
      await shot(`20261103-accounts-launcher-${width}-m1`);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await click('#new-session-cancel'); await open();
    }
    // A newly added account with no credential file is the polling state.
    // An expired credential warns too, but does not schedule login polling.
    const pollingCredentials = path.join(pool.accountDir(DATA, expired), '.credentials.json');
    const pollingBackup = path.join(pool.accountDir(DATA, expired), '.credentials.fixture-polling.json');
    fs.renameSync(pollingCredentials, pollingBackup);
    await refresh();
    assert.equal((await invoke('codeagent-pool:list')).accounts.find(a => a.id === expired).state, 'login-required');
    await click('[data-ca=drawer]');
    await shot('20261103-accounts-drawer-1280-m1');
    await click('#ca-note');
    await cdp.send('Input.insertText', { text: '甲乙' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await cdp.eval("(()=>{window.__note=document.getElementById('ca-note');window.__imeEvents=[];for(const name of ['compositionstart','compositionupdate','compositionend'])window.__note.addEventListener(name,e=>window.__imeEvents.push({type:e.type,data:e.data}));window.__pollCalls=window.__accountCalls.filter(c=>c[0]==='codeagent-pool:list').length})()");
    await cdp.send('Input.imeSetComposition', { text: 'zhang', selectionStart: 5, selectionEnd: 5 });
    await wait(() => cdp.eval("window.__accountCalls.filter(c=>c[0]==='codeagent-pool:list').length>window.__pollCalls&&!document.querySelector('[data-ca=refresh]').disabled"), 'real three second polling during IME');
    ok('3秒轮询期间保留原输入框、焦点和中文输入法组合状态', await cdp.eval("document.getElementById('ca-note')===window.__note&&document.activeElement===window.__note&&window.__note.value==='甲zhang乙'&&window.__imeEvents.some(e=>e.type==='compositionstart')&&!window.__imeEvents.some(e=>e.type==='compositionend')"));
    await shot('20261104-accounts-ime-composing-m1');
    await cdp.send('Input.insertText', { text: '张工' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await invoke('codeagent-pool:pause', { id: manual, hours: 4 });
    await wait(() => cdp.eval("!document.querySelector('[data-ca=refresh]').disabled"), 'pool event refresh during edit');
    ok('中文提交后账号推送保持文本和中间光标位置', await cdp.eval("document.getElementById('ca-note')===window.__note&&document.activeElement===window.__note&&window.__note.value==='甲张工乙'&&window.__note.selectionStart===2&&window.__note.selectionEnd===2"));
    evidence.ime = await cdp.eval("({events:window.__imeEvents,text:window.__note.value,selectionStart:window.__note.selectionStart,sameNode:document.getElementById('ca-note')===window.__note})");
    await shot('20261104-accounts-ime-committed-m1');
    await cdp.eval('window.__note.select()');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    fs.copyFileSync(pollingBackup, pollingCredentials);
    await click('[data-ca=import]');
    await wait(async () => (await invoke('codeagent-pool:list')).accounts.length === 5, 'local import');
    ok('添加抽屉真实点击导入，原IPC写入旧格式注册表');
    await click('[data-ca=close-drawer]');
    await click(`[data-ca=resume][data-id="${manual}"]`);
    await wait(async () => !(await invoke('codeagent-pool:list')).accounts.find(a => a.id === manual).avoid, 'resume');
    await click(`[data-ca=menu][data-id="${manual}"]`); await click(`[data-ca=pause-menu][data-id="${manual}"]`); await click(`[data-ca=pause][data-id="${manual}"][data-hours="2"]`);
    await wait(async () => !!(await invoke('codeagent-pool:list')).accounts.find(a => a.id === manual).avoid, 'pause');
    ok('恢复与暂停时长按钮真实调用原IPC并刷新账号状态');
    await click(`[data-ca=session][data-id="${good}"]`);
    await wait(() => cdp.eval("!document.getElementById('new-session-submit').disabled"), 'create ready');
    await click('#new-session-submit');
    const request = await wait(() => cdp.eval("window.__accountCalls.find(c=>c[0]==='create-session') || null"), 'create-session request');
    ok('真实创建按钮传递pool和精确预选ID', request[1].opts.codeagentAccount === 'pool' && request[1].opts.codeagentPoolPick === good);
    const session = await wait(async () => (await invoke('get-sessions')).find(s => s.kind === 'codeagent'), 'created session', 60000);
    await wait(() => fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse).some(l => l.hubSession === session.id && path.resolve(l.configDir) === path.resolve(pool.accountDir(DATA, good))), 'fixture launch routed', 60000);
    ok('CodeAgent夹具确实由预选账号目录启动');
    await open(); await refresh();
    ok('创建后列表显示进行中会话数', await cdp.eval(`document.querySelector('[data-ca-account="${good}"] .caa-sessions').textContent==='1'`));
    await click(`[data-ca=session][data-id="${good}"]`);
    await wait(() => cdp.eval("!document.getElementById('new-session-submit').disabled"), 'stale selection ready');
    await invoke('codeagent-pool:pause', { id: good, hours: 1 });
    await wait(() => cdp.eval("document.getElementById('new-session-submit').disabled"), 'changed selection disabled');
    const before = (await invoke('get-sessions')).length;
    await cdp.eval('window.WorkspaceController.submitNewSession()');
    ok('预选号失效时阻断提交，不切到个人号或其他号', (await invoke('get-sessions')).length === before);
    const blocked = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, codeagentAccount: 'pool', codeagentPoolPick: good } }).then(v => v, error => ({ error: error.message }));
    ok('主进程拒绝绕过界面的暂停账号新建请求', !!blocked?.error && /暂停/.test(blocked.error));
    await click('#new-session-codeagent-choice');
    for (const key of ['Home', 'ArrowDown', 'Enter']) await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
    await wait(() => cdp.eval("document.getElementById('new-session-codeagent-account').value==='pool'&&!document.getElementById('new-session-submit').disabled"), 'automatic rich selection');
    await click('#new-session-submit');
    const auto = await wait(async () => (await invoke('get-sessions')).find(s => s.kind === 'codeagent' && s.id !== session.id), 'automatic session');
    const autoRequest = await cdp.eval("window.__accountCalls.filter(c=>c[0]==='create-session').at(-1)");
    ok('富下拉键盘选择自动账号保留pool参数且不携带手选ID', autoRequest[1].opts.codeagentAccount === 'pool' && !autoRequest[1].opts.codeagentPoolPick);
    await wait(() => fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse).some(l => l.hubSession === auto.id), 'automatic fixture launch');
    const route = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(l => l.hubSession === auto.id);
    const excluded = [good, paused, manual, expired].map(id => path.resolve(pool.accountDir(DATA, id)));
    ok('自动选号实际启动可用导入号，跳过暂停与过期账号', !excluded.includes(path.resolve(route.configDir)));
    await cdp.eval("window.LaunchCenter.open('session',{kind:'codeagent'})");
    await click('#new-session-codeagent-choice'); await click('.launch-select-option[data-value="personal"]');
    await wait(() => cdp.eval("!document.getElementById('new-session-submit').disabled"), 'personal ready');
    await click('#new-session-submit');
    const personalSession = await wait(async () => (await invoke('get-sessions')).find(s => s.kind === 'codeagent' && ![session.id, auto.id].includes(s.id)), 'personal session');
    const personalRequest = await cdp.eval("window.__accountCalls.filter(c=>c[0]==='create-session').at(-1)");
    await wait(() => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse).some(l => l.hubSession === personalSession.id && path.resolve(l.configDir) === path.resolve(PERSONAL)), 'personal fixture directory');
    ok('富下拉个人账号恢复个人目录且不继承号池预选', personalRequest[1].opts.codeagentAccount !== 'pool' && !personalRequest[1].opts.codeagentPoolPick);
    const credentials = path.join(PERSONAL, '.credentials.json'), original = path.join(PERSONAL, '.credentials.fixture-original.json');
    fs.copyFileSync(credentials, original);
    for (const state of ['unreadable', 'login-required', 'quota-paused', 'list-failed']) {
      fs.copyFileSync(original, credentials); quota.clearAvoid(DATA, 'personal', { by: 'test' });
      if (state === 'unreadable') fs.writeFileSync(credentials, '{fixture-format-unreadable');
      if (state === 'login-required') fs.renameSync(credentials, path.join(PERSONAL, '.credentials.fixture-missing.json'));
      if (state === 'quota-paused') quota.markAvoid(DATA, 'personal', { source: 'credit', kind: 'quota', until: Date.now() + 3600e3 });
      if (state !== 'list-failed') {
        await open(); await refresh();
        await click('[data-ca=session][data-id=personal]');
      } else {
        await cdp.eval("window.__accountListFailure=true;window.LaunchCenter.open('session',{kind:'codeagent',codeagentAccount:'personal'})");
      }
      await wait(() => cdp.eval("document.getElementById('new-session-codeagent-account').value==='personal'&&!document.getElementById('new-session-submit').disabled"), 'personal state does not block: ' + state);
      await click('#new-session-codeagent-choice');
      ok(`个人账号${state}仍可选，状态不禁用个人路径`, await cdp.eval("!document.querySelector('.launch-select-option[data-value=personal]').classList.contains('disabled')"));
      await click('.launch-select-option[data-value=personal]');
      ok(`个人账号${state}保留提示`, await cdp.eval("document.getElementById('new-session-codeagent-account-note').textContent.includes('仍可创建')"));
      await shot(`20261104-accounts-personal-${state}-m1`);
      const existing = new Set((await invoke('get-sessions')).map(s => s.id));
      await click('#new-session-submit');
      const created = await wait(async () => (await invoke('get-sessions')).find(s => s.kind === 'codeagent' && !existing.has(s.id)), 'personal fixture session: ' + state);
      await wait(() => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse).some(l => l.hubSession === created.id && path.resolve(l.configDir) === path.resolve(PERSONAL)), 'personal actual config route: ' + state);
      const request = await cdp.eval("window.__accountCalls.filter(c=>c[0]==='create-session').at(-1)");
      ok(`个人账号${state}真实创建仍用个人目录、不转号池`, !request[1].opts.codeagentPoolPick && request[1].opts.codeagentAccount !== 'pool');
      await cdp.eval('window.__accountListFailure=false');
      if (state === 'quota-paused') {
        await open(); await click('[data-ca=menu][data-id=personal]'); await click('[data-ca=resume][data-id=personal]');
        await wait(async () => !(await invoke('codeagent-pool:list')).personal.avoid, 'personal resume from menu');
        ok('个人账号放行后仍可从更多菜单恢复使用');
      }
    }
    fs.copyFileSync(original, credentials); quota.clearAvoid(DATA, 'personal', { by: 'test' });
    await open();
    await click(`[data-ca=login][data-id="${expired}"]`);
    await wait(async () => (await invoke('codeagent-pool:list')).accounts.find(a => a.id === expired)?.state === 'ready', 'pool fixture login');
    ok('需登录账号行真实点击重新登录，隔离登录夹具写入后自动刷新');
    await click('[data-ca=menu][data-id=personal]'); await click('[data-ca=login][data-id=personal]');
    await wait(() => cdp.eval("window.__accountCalls.some(c=>c[0]==='codeagent-pool:personal-login')"), 'personal login dispatch');
    ok('个人账号更多菜单真实调用个人登录IPC');
    await click('[data-ca=drawer]'); await click('#ca-note');
    await cdp.send('Input.insertText', { text: '新增验收账号' }); await click('[data-ca=add]');
    const added = await wait(async () => (await invoke('codeagent-pool:list')).accounts.find(a => a.note === '新增验收账号'), 'added account');
    ok('添加抽屉备注进入旧pool.json，模拟登录成功后账号可用', added.state === 'ready');
    await click(`[data-ca=probe][data-id="${good}"]`);
    await wait(async () => (await text()).includes('模型权限已更新'), 'explicit model probe', 180000);
    ok('账号行真实获取模型权限成功（本地CodeAgent菜单夹具）');
    await click(`[data-ca=menu][data-id="${added.id}"]`); await click(`[data-ca=remove][data-id="${added.id}"]`);
    await wait(async () => !(await invoke('codeagent-pool:list')).accounts.some(a => a.id === added.id), 'remove account');
    ok('更多菜单真实移出未被会话使用的账号');
    await click('#btn-home');
    ok('切回会话关闭账号页并恢复导航', await cdp.eval("document.getElementById('codeagent-accounts-page').hidden && !document.body.classList.contains('codeagent-accounts-page-open')"));
    evidence.ok = true;
  } catch (error) { evidence.error = error.stack; if (cdp) { await shot('20261103-accounts-failure-m1').catch(() => {}); evidence.failureUi = await cdp.eval("({intent:window.LaunchCenter?.getActiveIntent(), calls:window.__accountCalls, message:document.getElementById('new-session-error')?.textContent, selected:document.getElementById('new-session-codeagent-pool')?.value})").catch(() => null); } throw error; }
  finally {
    fs.writeFileSync(path.join(ART, '20261103-accounts-evidence-m1.json'), JSON.stringify(evidence, null, 2));
    if (cdp) await cdp.close(); if (hub) await gracefulQuit(hub);
    hub?.child.stdout?.destroy(); hub?.child.stderr?.destroy(); hub?.child.stdin?.destroy();
    console.log('ARTIFACTS ' + ART);
  }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
