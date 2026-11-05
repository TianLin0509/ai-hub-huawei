'use strict';
// Real renderer, IPC, account/usage stores and serve HTTP; all credentials and
// CodeAgent processes are local fixtures. Run under the private-desktop guard.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const REPO = path.resolve(__dirname, '..');
const options = { entry: REPO };
for (let i = 2; i < process.argv.length; i++) {
  if (!['--entry', '--out'].includes(process.argv[i]) || !process.argv[i + 1]) throw Error('Expected --entry / --out');
  options[process.argv[i].slice(2)] = process.argv[++i];
}
const ENTRY = path.resolve(options.entry), OUT = path.resolve(options.out || path.join(REPO, 'artifacts', `20261104-quota-ui-${Date.now()}`));
const { launchIsolatedHub, gracefulQuit, _verifyCdpPortOwner } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pool = require(path.join(ENTRY, 'core/codeagent-pool'));
const quota = require(path.join(ENTRY, 'core/codeagent-quota'));
const usage = require(path.join(ENTRY, 'core/codeagent-usage-menu'));
const { writeProbed } = require(path.join(ENTRY, 'core/codeagent-model-probe'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quota-ui-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal'), SCAN = path.join(ROOT, 'scan');
const LOG = path.join(ROOT, 'fixture.jsonl'), FAIL = path.join(ROOT, 'fail-serve'), DELAY = path.join(ROOT, 'delay-serve');
const MODEL = 'GLM-5.2-WX-Auto';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function wait(fn, label, timeout = 45000) {
  const end = Date.now() + timeout; let error;
  while (Date.now() < end) { try { if (await fn()) return; } catch (e) { error = e; } await sleep(120); }
  throw Error(`Timeout ${label}${error ? ': ' + error.message : ''}`);
}
function seed(dir, accountId, expiresAt = Date.now() + 72 * 3600e3) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId, expiresAt } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: MODEL }));
  writeProbed(path.join(dir, 'hub-models.json'), { models: [MODEL], defaultModel: MODEL, source: 'test-fixture' });
}
function identity() {
  try { const git = args => execFileSync('git', args, { cwd: ENTRY, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { sha: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain']) }; } catch { return { exported: true }; }
}
function hashes() {
  return Object.fromEntries(['core/codeagent-quota-panel.js', 'renderer/codeagent-quota-panel.js', 'renderer/codeagent-quota-panel-view.js', 'renderer/renderer.js', 'renderer/styles/account-quota-panel.css', 'renderer/codeagent-accounts-page.js']
    .map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(ENTRY, file))).digest('hex')]));
}
async function run() {
  for (const dir of [DATA, WORK, SCAN, OUT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), ''); seed(PERSONAL, 'personal-fixture');
  const ids = ['算法研发', '材料整理', '会议纪要', '额度暂停', '待登录'].map((note, i) => {
    const id = pool.addAccount(DATA, { note }); seed(pool.accountDir(DATA, id), `pool-${i}-fixture`, i === 4 ? Date.now() - 86400e3 : Date.now() + 72 * 3600e3); return id;
  });
  const observedAt = Date.now() - 60000;
  const setReading = (id, busy, month, extra = {}, at = observedAt) => usage.recordUsage(DATA, id, { credit: {
    busyDay: busy == null ? { pct: null } : { pct: 100 - busy, used: 100 - busy, total: 100 },
    monthly: month == null ? { pct: null } : { pct: 100 - month, used: (100 - month) * 5, total: 500 }, ...extra,
  } }, { now: at, source: 'screen' });
  setReading('personal', 84, 91); setReading(ids[0], 62, 88, { idleDiscount: '2折', idleDiscountIn: '1小时57分钟' });
  setReading(ids[1], 16, 64); setReading(ids[2], null, 42); setReading(ids[3], 0, 40);
  quota.markAvoid(DATA, ids[3], { source: 'quota', kind: 'credit', reason: '额度用完', until: Date.now() + 2 * 3600e3 });
  const command = path.join(ROOT, 'quota-codeagent.cmd'), router = path.join(ROOT, 'quota-codeagent.cjs');
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${router}" %*\r\n`);
  fs.writeFileSync(router, `const fs=require('fs');if(process.argv[2]==='serve'&&fs.existsSync(${JSON.stringify(FAIL)}))process.exit(3);const run=()=>require(${JSON.stringify(path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent-fake.js'))});if(process.argv[2]==='serve'&&fs.existsSync(${JSON.stringify(DELAY)}))setTimeout(run,6000);else run();`);
  const evidence = { entry: ENTRY, identity: identity(), startHashes: hashes(), root: ROOT, checks: [], shots: [],
    boundary: 'Real isolated Electron/IPC/cache/serve HTTP with synthetic credentials and local CLI; no remote login/model call.' };
  const check = (label, condition = true) => { assert(condition, label); evidence.checks.push(label); console.log('PASS ' + label); };
  let hub, c, failure;
  const invoke = (name, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(name)},${JSON.stringify(payload)})`);
  const state = () => c.eval('window.codeagentQuotaPanel.getState()');
  const reload = () => c.eval('window.codeagentQuotaPanel.reload()');
  const click = async selector => {
    let prior, xy;
    await wait(async () => {
      const pos = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height||e.disabled)return null;const x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return h&&(h===e||e.contains(h))?{x,y}:null})()`);
      const stable = pos && prior && Math.abs(pos.x-prior.x)<1 && Math.abs(pos.y-prior.y)<1;
      prior = pos; xy = pos; return stable;
    }, selector);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...xy, button: 'left', clickCount: 1 });
  };
  const resize = async width => {
    await c.send('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 900 : 800, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.captureScreenshot', { format: 'png' });
    await wait(() => c.eval(`innerWidth===${width}&&window.codeagentQuotaPanel.getState().narrow===${width <= 1360}`), 'resize');
    await sleep(180);
  };
  const expanded = async () => { if ((await state()).collapsed) await click('#account-quota-panel [data-qp-action=expand]'); };
  const collapsed = async () => { if (!(await state()).collapsed) await click('#account-quota-panel [data-qp-action=collapse]'); };
  const shot = async (name, width, keepPointer = false) => {
    if (!keepPointer) await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 100 });
    await sleep(150);
    const image = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = `20261104-${name}-${width}-m1.png`; fs.writeFileSync(path.join(OUT, file), Buffer.from(image.data, 'base64'));
    const layout = await c.eval(`(()=>{const p=document.getElementById('account-quota-panel'),r=p.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,overlay:p.classList.contains('is-overlay'),overflow:document.documentElement.scrollWidth>innerWidth,small:[...p.querySelectorAll('*')].filter(e=>e.offsetHeight&&e.textContent.trim()&&parseFloat(getComputedStyle(e).fontSize)<12).map(e=>e.className),clipped:[...p.querySelectorAll('.qp-h,.qp-idle,.qp-f')].filter(e=>e.offsetHeight&&e.scrollWidth>e.clientWidth+1).map(e=>e.className),font:getComputedStyle(p).fontFamily}})()`);
    check(`${name} ${width} fits without overflow or small text`, !layout.overflow && !layout.small.length && !layout.clipped.length);
    const occluded = await c.eval(`(()=>{const p=document.getElementById('account-quota-panel');return [...p.querySelectorAll('.qp-row,.qp-ring,.qp-h button')].filter(e=>{const r=e.getBoundingClientRect();return !e.disabled&&r.width&&r.height&&!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}).map(e=>e.dataset.qpAccount||e.dataset.qpAction)})()`);
    evidence.shots.push({ name, width, file, layout, occluded });
    check(`${name} ${width} enabled controls are not covered (${occluded.join(',')})`, !occluded.length);
  };
  const serveCount = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.args?.[0]==='serve').length : 0;
  try {
    // Check the unmodified ownership verifier before launching a UI. A failed
    // check remains fatal; capture timing rather than bypassing identity checks.
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    try {
      const start = Date.now(), port = listener.address().port;
      const own = await _verifyCdpPortOwner(port, process.pid);
      evidence.portPreflight = { milliseconds: Date.now()-start, own };
      check('port verifier accepts this exact process', own);
      check('port verifier rejects another process', !await _verifyCdpPortOwner(port, 1));
    } finally { await new Promise(resolve => listener.close(resolve)); }
    hub = await launchIsolatedHub({ entryPath: ENTRY, cwd: ENTRY, dataDir: DATA, port: await freePort(), label: 'quota-panel-m1', windowMode: 'hidden', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, AI_HUB_CODEAGENT_SERVE: '1',
      CODEAGENT_POOL_FAKE_LOG: LOG, AI_HUB_CODEAGENT_POOL_SCAN_ROOT: SCAN, CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0',
      CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    await wait(() => c.eval('!!window.codeagentQuotaPanel && !!window.__codeagentAccountsOpen'), 'quota panel ready');
    await c.eval("window.__quotaCalls=[];window.__quotaErrors=[];addEventListener('error',e=>__quotaErrors.push(e.message));{const ipc=require('electron').ipcRenderer,invoke=ipc.invoke.bind(ipc);ipc.invoke=(...args)=>{if(args[0]==='codeagent:quota-panel')__quotaCalls.push(args);return invoke(...args)}}");
    const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title: '额度侧栏验收', codeagentAccount: 'pool', codeagentPoolPick: ids[0] } });
    assert(created?.id, JSON.stringify(created));
    await c.eval(`selectSession(${JSON.stringify(created.id)})`); await reload();
    await wait(() => c.eval(`!!document.querySelector('.qp-row.is-current[data-qp-account="${ids[0]}"]')`), 'current account');
    check('current session uses the stored pool account ID');
    check('company side panel excludes subscription provider sections', await c.eval("!document.querySelector('#account-quota-panel .cq-group')"));
    check('unknown busy bucket and empty login account remain unread', await c.eval(`document.querySelector('.qp-row[data-qp-account="${ids[2]}"] [data-qp-bucket=busyDay]').textContent==='未读取'&&!!document.querySelector('.qp-row[data-qp-account="${ids[4]}"] .qp-none')`));
    check('pool count excludes paused and login accounts, personal stays separate', await c.eval("document.querySelector('.qp-n').textContent==='3/5 可用'&&document.querySelectorAll('.qp-g').length===2"));
    for (const width of [1440, 1280]) {
      await resize(width);
      if (width === 1280) check('1280 starts as a 48px rail', (await state()).collapsed);
      if (width === 1440) await expanded();
      await shot('quota', width);
      await collapsed();
      const hover = await c.eval(`(()=>{const r=document.querySelector('.qp-ring[data-qp-account="${ids[0]}"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await c.send('Input.dispatchMouseEvent', { type:'mouseMoved', ...hover });
      await wait(()=>c.eval("!!document.querySelector('.qp-tip')"), 'rail tooltip');
      check(`${width} rail tooltip includes account and both measured balances`, await c.eval("['算法研发','62%','88%','读取'].every(text=>document.querySelector('.qp-tip').textContent.includes(text))"));
      check(`${width} ring uses one tooltip instead of a duplicate global title popup`, await c.eval("!document.querySelector('.qp-ring').hasAttribute('title')&&!document.querySelector('.qp-ring').hasAttribute('data-hub-tip')"));
      await shot('quota-rail', width, true);
      await expanded(); await shot('quota-overlay', width);
      if (width === 1280) {
        check('narrow expansion floats without consuming extra layout width', await c.eval("document.querySelector('.qp-ph').getBoundingClientRect().width===48&&document.getElementById('account-quota-panel').classList.contains('is-overlay')"));
        const outsideX = await c.eval("document.getElementById('account-quota-panel').getBoundingClientRect().left-30");
        await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: outsideX, y: 190, button: 'left', clickCount: 1 });
        await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: outsideX, y: 190, button: 'left', clickCount: 1 });
        check('click outside collapses the overlay', (await state()).collapsed);
      }
    }
    setReading(ids[0], 62, 88, { idleDiscount: '2折', idleDiscountActive: true }, Date.now()); await reload();
    for (const width of [1440, 1280]) { await resize(width); if(width===1440) await expanded(); await shot('quota-idle-on', width); }
    check('idle countdown appears once at the top', await c.eval("document.querySelectorAll('.qp-idle').length===1&&document.querySelector('.qp-idle').classList.contains('on')"));
    // A real bulk serve refresh stays pending long enough to capture both widths.
    fs.writeFileSync(DELAY, '1'); await resize(1440); await expanded();
    const beforeServe = serveCount(); await click('#account-quota-panel [data-qp-action=refresh]');
    await wait(() => c.eval('window.codeagentQuotaPanel.getState().refreshing'), 'refresh started');
    await shot('quota-refresh', 1440); await resize(1280); await shot('quota-refresh', 1280);
    check('refresh button is disabled while one bulk request runs', await c.eval("document.querySelector('.qp-refresh').disabled"));
    await wait(async () => !(await state()).refreshing, 'serve refresh finishes', 110000); fs.unlinkSync(DELAY);
    await expanded();
    const result = await invoke('codeagent:quota-panel');
    check('real serve updates five ready accounts and preserves the expired account failure', result.rows.filter(r=>r.usage?.source==='serve').length===5 && result.rows.find(r=>r.id===ids[4]).refresh.status==='failed');
    check('real serve refresh does not remove a quota pause', !!result.rows.find(r=>r.id===ids[3]).avoid);
    const count = serveCount(); assert.equal(count-beforeServe, 5);
    await click('#account-quota-panel [data-qp-action=refresh]'); await wait(async () => !(await state()).refreshing, 'cooldown refresh finishes');
    check('second click uses ten-minute cooldown without starting another serve', serveCount()===count);
    // Exercise actual row navigation, including an account hidden by the current filter.
    await click(`#account-quota-panel .qp-row[data-qp-account="${ids[1]}"]`);
    await wait(() => c.eval(`document.querySelector('[data-ca-account="${ids[1]}"]').classList.contains('is-located')`), 'pool row located');
    check('pool row opens account page and focuses the selected account', await c.eval(`document.activeElement.dataset.caAccount===${JSON.stringify(ids[1])}`));
    await click('[data-ca=filter][data-filter=needs]');
    await click('#btn-home'); await expanded(); await click('#account-quota-panel .qp-row[data-qp-account=personal]');
    await wait(() => c.eval("document.querySelector('[data-ca-account=personal]').classList.contains('is-located')"), 'personal located');
    check('personal row navigation resets filter and keeps the original personal-session action', await c.eval("document.querySelector('[data-ca=filter][data-filter=all]').getAttribute('aria-pressed')==='true'&&!!document.querySelector('[data-ca=session][data-id=personal]')"));
    await click('#btn-home'); await expanded();
    const failedId = pool.addAccount(DATA, { note: '失败缓存验收' }); seed(pool.accountDir(DATA, failedId), 'failed-fixture'); setReading(failedId, 35, 65);
    fs.writeFileSync(FAIL, '1'); await reload(); await click('#account-quota-panel [data-qp-action=refresh]');
    await wait(async () => !(await state()).refreshing, 'failed serve returns', 60000);
    const failed = (await invoke('codeagent:quota-panel')).rows.find(r=>r.id===failedId);
    check('serve failure keeps original Credit timestamp and cache values', failed.refresh.status==='failed'&&failed.creditAt===observedAt&&failed.credit.busyDay.pct===65);
    check('failure text is visible on the account row', await c.eval(`document.querySelector('.qp-row[data-qp-account="${failedId}"]').textContent.includes('保留上次读数')`));
    check('no renderer errors', (await c.eval('__quotaErrors')).length===0);
    evidence.requests = await c.eval('__quotaCalls'); evidence.refreshResult = result; evidence.failedResult = failed;
    evidence.ok = true;
  } catch (error) { failure = error; evidence.ok = false; evidence.error = error.stack; evidence.launchLog = error.logTail; evidence.termination = error.termination; }
  finally {
    if (failure && c) { try { fs.writeFileSync(path.join(OUT, '20261104-quota-failure-m1.png'), Buffer.from((await c.send('Page.captureScreenshot', { format:'png' })).data, 'base64')); } catch {} }
    try { evidence.exit = await gracefulQuit(hub); } catch (error) { failure ||= error; evidence.ok = false; evidence.teardownError = error.stack; }
    await c?.close();
    if (hub) { fs.writeFileSync(path.join(OUT, '20261104-quota-hub-m1.log'), hub.log().join('\n')); hub.child?.stdout?.destroy(); hub.child?.stderr?.destroy(); hub.child?.stdin?.destroy(); }
    evidence.endHashes = hashes(); assert.deepEqual(evidence.endHashes, evidence.startHashes);
    fs.writeFileSync(path.join(OUT, '20261104-quota-ui-m1.json'), JSON.stringify(evidence, null, 2));
  }
  console.log(JSON.stringify({ ok: evidence.ok, checks: evidence.checks.length, shots: evidence.shots.length, out: OUT }));
  if (failure) throw failure;
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
