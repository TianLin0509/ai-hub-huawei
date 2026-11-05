'use strict';
// 卡片视图「工作中」流光在持续来卡时不会退化成一直在扫（s6 一审 P2），且胶囊确实接上了流光（P3）。
// 隔离数据、后台离屏窗口、假 CodeAgent，不调模型。工作中胶囊用页面里真实的 _updateStreamingIndicator 生成（运行判定临时置真）；
// 每秒往卡片区末尾追加一张卡再调它——和真实来卡一样，胶囊会被挪到最新卡片下面。16 秒内数流光开扫次数（animationstart）。
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const opt = { entry: REPO, out: path.join(REPO, 'artifacts', 'sweep-cards-' + Date.now()) };
for (let i = 2; i < process.argv.length; i += 2) opt[process.argv[i].replace(/^--/, '')] = path.resolve(process.argv[i + 1]);

async function run() {
  fs.mkdirSync(opt.out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sweep-cards-')), data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal');
  for (const dir of [data, work, personal, path.join(root, 'scan')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'sweep-cards', expiresAt: Date.now() + 86400000 } }));
  const evidence = { entry: opt.entry, checks: [], rendererErrors: [] };
  const check = (label, ok, detail) => { assert(ok, label + (detail ? ' ' + JSON.stringify(detail) : '')); evidence.checks.push(label); console.log('PASS ' + label); };
  let hub, c, failure;
  try {
    hub = await launchIsolatedHub({ entryPath: opt.entry, cwd: opt.entry, dataDir: data, port: await freePort(), windowMode: 'background', label: 'sweep-cards', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'), CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'),
      CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* framing */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => {
      for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* loading */ } await sleep(150); }
      throw Error('Timeout ' + label);
    };
    await wait('typeof selectSession === "function" && typeof _updateStreamingIndicator === "function"', 'renderer ready');
    check('company shell is on', await c.eval('!!document.documentElement.dataset.hwShell'));
    const created = await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind: 'codeagent', opts: { cwd: work, title: '持续来卡', codeagentAccount: 'personal' } })})`);
    const sid = JSON.stringify(created.id);
    await c.eval(`selectSession(${sid})`);
    await wait(`(()=>{const o=document.getElementById('msg-overlay');return o&&o.getClientRects().length})()`, 'card view');
    await c.eval(`window.isSessionCardWorking=()=>true;_updateStreamingIndicator(${sid})`);
    const pill = await c.eval(`(()=>{const e=document.querySelector('#msg-overlay > .streaming-indicator');if(!e)return null;return {cls:e.className,baseline:getComputedStyle(e).backgroundImage}})()`);
    evidence.pill = pill;
    check('working pill carries the sweep class and its static baseline', !!pill && pill.cls.split(' ').includes('hw-sweep') && /gradient/.test(pill.baseline), pill);

    // 16 秒，每秒来一张卡；记录开扫次数，并每 100ms 采样一次「流光是否在跑」。
    // 页面内每 30ms 采样：新出现的流光动画对象算一次开扫；同一对象的进度倒退也算一次（被重播）。
    await c.eval(`(()=>{window.__sweep={starts:0,restarts:0,ticks:0,on:0,seen:new WeakMap(),life:[],idx:new WeakMap()};setInterval(()=>{__sweep.ticks++;let on=false;for(const e of document.querySelectorAll('.hw-sweep'))for(const a of e.getAnimations({subtree:true})){if(a.id!=='hw-sweep'&&a.animationName!=='hw-sweep')continue;if(a.playState==='running')on=true;const t=a.currentTime||0,p=__sweep.seen.get(a);if(p==null){__sweep.starts++;__sweep.idx.set(a,__sweep.life.push({at:Math.round(performance.now()),states:[]})-1)}else if(t+1<p){__sweep.restarts++}const L=__sweep.life[__sweep.idx.get(a)];if(L.states.length<40)L.states.push(a.playState+'@'+Math.round(t));__sweep.seen.set(a,t)}if(on)__sweep.on++},30)})()`);
    let running = 0, samples = 0, moves = 0;
    const t0 = Date.now(); let nextCard = t0;
    while (Date.now() - t0 < 16000) {
      if (Date.now() >= nextCard) {
        await c.eval(`(()=>{const o=document.getElementById('msg-overlay');const d=document.createElement('div');d.className='turn-card probe-card';d.textContent='新卡';o.append(d);_updateStreamingIndicator(${sid});return document.querySelector('#msg-overlay').lastElementChild.classList.contains('streaming-indicator')})()`) && moves++;
        nextCard += 1000;
      }
      samples++; if (await c.eval(`[...document.querySelectorAll('.hw-sweep')].some(e=>e.getAnimations({subtree:true}).some(a=>(a.id==='hw-sweep'||a.animationName==='hw-sweep')&&a.playState==='running'))`)) running++;
      await sleep(100);
    }
    const { starts, restarts, pageShare, life } = await c.eval('({starts:__sweep.starts,restarts:__sweep.restarts,pageShare:+(__sweep.on/__sweep.ticks).toFixed(2),life:__sweep.life})');
    evidence.cards = { moves, starts, restarts, pageShare, life, runningShare: +(running / samples).toFixed(2), samples };
    check('the pill is moved under every new card', moves >= 15, evidence.cards);
    const light = await c.eval(`(()=>{const l=document.querySelector('#msg-overlay > .streaming-indicator > .hw-sweep-light');return l&&{h:getComputedStyle(l).height,pos:getComputedStyle(l).position}})()`);
    evidence.light = light;
    check('the beat put a 2px light bar inside the pill', !!light && light.h === '2px' && light.pos === 'absolute', light);
    check('one new card per second for 16 s starts the sweep at most 3 times', starts <= 3 && starts >= 1 && restarts === 0, evidence.cards);
    check('the sweep runs at most ~45% of the time while cards keep arriving', running / samples <= 0.45, evidence.cards);
    // 正在扫时来卡（胶囊被挪动）：这一遍既不重播也不被打断，照常扫完
    const moved = await c.eval(`(async()=>{const o=document.getElementById('msg-overlay'),e=o.querySelector(':scope > .streaming-indicator'),l=e.querySelector(':scope > .hw-sweep-light');const {SWEEP_FRAMES,SWEEP_MS}=require('../renderer/sweep-pulse.js');const a=l.animate(SWEEP_FRAMES,{duration:SWEEP_MS,easing:'linear'});a.id='hw-sweep';const seen=[];for(let i=0;i<3;i++){await new Promise(r=>setTimeout(r,330));const d=document.createElement('div');d.className='turn-card probe-card';o.append(d);_updateStreamingIndicator(${sid});seen.push(e.getAnimations({subtree:true}).includes(a))}const t=a.currentTime,st=a.playState,x=new DOMMatrix(getComputedStyle(l).transform).m41;await a.finished.catch(()=>{});return {t:Math.round(t),st,listed:seen.every(Boolean),x:Math.round(x),end:a.playState,last:o.lastElementChild===e}})()`);
    evidence.movedMidSweep = moved;
    check('a pass in progress survives the pill being moved and plays to the end', moved.st === 'running' && moved.listed && moved.t >= 900 && moved.x > 0 && moved.end === 'finished' && moved.last, moved);
    check('no renderer errors', evidence.rendererErrors.length === 0, evidence.rendererErrors);
    evidence.ok = true;
  } catch (error) { failure = error; evidence.ok = false; evidence.error = error.stack; }
  finally {
    if (hub) { try { await gracefulQuit(hub); } catch { /* best effort */ } hub.child?.stdout?.destroy(); hub.child?.stderr?.destroy(); hub.child?.stdin?.destroy(); fs.writeFileSync(path.join(opt.out, 'hub.log'), hub.log().join('\n')); }
    try { await c?.close(); } catch { /* closed */ }
    fs.writeFileSync(path.join(opt.out, 'sweep-cards-e2e.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: evidence.ok, cards: evidence.cards, out: opt.out }));
  }
  if (failure) throw failure;
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
