'use strict';
// 间歇流光（5.5.9）的节拍与开销，按产品默认（动画预算开着）实测。
// 隔离数据、后台离屏窗口（照常出画面）、假 CodeAgent，不调模型。
// 节拍：20 秒里每 0.5 秒记一次流光动画状态，应看到「扫 2.2 秒 → 静止 → 第 8 秒再扫」。
// 开销：同一窗口下比较 idle / 问一下思考中 / 卡片视图 1 个、5 个「工作中」胶囊，记界面与显卡进程 CPU（单核 %）、帧/秒、重画/秒。
// 「工作中」用页面里真实的 _updateStreamingIndicator 生成（把运行判定临时置真）；5 个是把这个胶囊再复制 4 份，
// 代表一屏里同时有 5 个工作中状态（分屏/群成员视图）的最坏情况。
// 用法：node tests/probe-sweep-cost-cdp.js [--out <目录>] [--secs 16] [--rounds 2] [--entry <检出目录>]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const opt = { out: path.join(REPO, 'artifacts', 'sweep-cost-' + Date.now()), secs: 16, rounds: 2, entry: REPO, states: 'idle,ask-thinking,card-1,card-3,card-5' };
for (let i = 2; i < process.argv.length; i += 2) opt[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
opt.secs = Number(opt.secs); opt.rounds = Number(opt.rounds); opt.entry = path.resolve(opt.entry);

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
}
function hubProcesses(rootPid) {
  const all = JSON.parse(ps('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'));
  const kids = new Map(); for (const p of all) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
  const out = [], walk = pid => { for (const p of kids.get(pid) || []) { out.push(p); walk(p.ProcessId); } };
  const root = all.find(p => p.ProcessId === rootPid); if (root) out.push(root); walk(rootPid);
  return out.filter(p => /electron/i.test(p.CommandLine || '')).map(p => ({ pid: p.ProcessId, type: (/--type=([\w-]+)/.exec(p.CommandLine || '') || [, 'browser'])[1] }));
}
function cpuTimes(pids) {
  const text = ps(`Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.TotalProcessorTime.TotalMilliseconds)" }`);
  return Object.fromEntries(text.trim().split(/\r?\n/).filter(Boolean).map(l => l.trim().split(' ').map(Number)));
}

async function run() {
  fs.mkdirSync(opt.out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sweep-')), data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal');
  for (const dir of [data, work, personal, path.join(root, 'scan')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'sweep-personal', expiresAt: Date.now() + 86400000 } }));
  const result = { entry: opt.entry, secs: opt.secs, rounds: opt.rounds, budget: 'on (product default)', rhythm: {}, cost: [] };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: opt.entry, cwd: opt.entry, dataDir: data, port: await freePort(), windowMode: 'background', label: 'sweep-cost', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'), CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'),
      CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    const events = []; let tracingDone = null;
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Tracing.dataCollected') events.push(...m.params.value); if (m.method === 'Tracing.tracingComplete' && tracingDone) tracingDone(); } catch { /* framing */ } });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => {
      for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* loading */ } await sleep(150); }
      throw Error('Timeout ' + label);
    };
    await wait('typeof selectSession === "function" && !!window.__askAsideUi', 'renderer ready');
    const created = await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind: 'codeagent', opts: { cwd: work, title: '流光开销', codeagentAccount: 'personal' } })})`);
    const sid = JSON.stringify(created.id);
    await c.eval(`selectSession(${sid})`);
    await wait(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'session visible');
    result.companyShell = await c.eval('!!document.documentElement.dataset.hwShell');
    const at = () => new Date(Date.now() - 4000).toISOString();
    const askItems = running => [
      { id: 'q0', q: '为什么这么做？', a: '先把旧的分支收口，再接新的入口。', status: 'done', at: at(), wall_s: 31 },
      running ? { id: 'q1', q: '现在卡在哪？', status: 'running', at: at(), startedAt: at() } : { id: 'q1', q: '现在卡在哪？', a: '在等编译。', status: 'done', at: at(), wall_s: 40 },
    ];
    const setAsk = async running => {
      if (running == null) { await c.eval('window.__askAsideUi.hide()'); return; }
      await c.eval('window.__askAsideUi.open()'); await wait(`!document.querySelector('.ask').hidden`, 'drawer open'); await sleep(1200);
      await c.eval(`ipcRenderer.emit('ask-aside:changed',{},${JSON.stringify({ sessionId: created.id, supported: true, account: 'personal', items: askItems(running) })})`);
    };
    const setCards = async n => {
      await c.eval(`(()=>{document.querySelectorAll('.probe-clone').forEach(e=>e.remove());window.isSessionCardWorking=()=>${n > 0};_updateStreamingIndicator(${sid});
        const ind=document.querySelector('#msg-overlay > .streaming-indicator');if(${n}>1&&ind)for(let i=1;i<${n};i++){const k=ind.cloneNode(true);k.classList.add('probe-clone');k.removeAttribute('data-session-id');ind.parentElement.append(k)}})()`);
      if (!n) await sleep(1700); // 原逻辑延迟 1.5 秒移除
    };
    const STATES = { idle: { ask: null, cards: 0 }, 'ask-thinking': { ask: true, cards: 0 }, 'card-1': { ask: null, cards: 1 }, 'card-3': { ask: null, cards: 3 }, 'card-5': { ask: null, cards: 5 } };
    const sweepState = `(()=>{const out=[];for(const e of document.querySelectorAll('.hw-sweep'))for(const a of e.getAnimations({subtree:true}))out.push((a.id||a.animationName)+':'+a.playState);return out.join(',')||'static'})()`;

    // 节拍（问一下思考中 + 1 个工作中胶囊同时在）
    await setCards(1); await setAsk(true);
    const t0 = Date.now(), rhythm = [];
    for (let i = 0; i < 40; i++) { rhythm.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${await c.eval(sweepState)}`); await sleep(500); }
    result.rhythm.timeline = rhythm;
    result.rhythm.counts = await c.eval(`({sweeps:document.querySelectorAll('.hw-sweep').length, beats: 'see timeline'})`);
    const shot = async file => fs.writeFileSync(path.join(opt.out, file), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    // s1 验收图：卡片「工作中」扫的瞬间 / 两次之间 / 减少动效，1440 与 1280（问一下抽屉同屏开着）
    for (const width of [1440, 1280]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await setAsk(true); await setCards(1); await sleep(600);
      // 改前的检出没有间歇流光：等不到就记下来，照样往下测（用于拍改前图、测改前开销）
      // 扫中：先等到全部静止，再等下一拍刚开始，0.9 秒后（匀速 2.2 秒，约扫到 40%）拍
      try { await wait(`${sweepState}==='static'`, 'quiet', 10000); await wait(`${sweepState}.includes('hw-sweep')`, 'next beat', 10000); await sleep(900); await shot(`sweep-mid-${width}.png`); } catch { result.noSweep = true; }
      // 两次之间：等到页面上没有任何流光动画在跑再拍
      await wait(`${sweepState}==='static'||!document.querySelector('.hw-sweep')`, 'between beats', 10000).catch(() => {}); await sleep(300); await shot(`sweep-static-${width}.png`);
      await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await sleep(300); const reduced = [];
      for (let i = 0; i < 18; i++) { const st = await c.eval(sweepState); if (/hw-sweep/.test(st)) reduced.push(st); await sleep(500); }
      (result.reducedMotion ||= {})[width] = { sweepAnimationsSeen: reduced.length };
      await shot(`sweep-reduced-${width}.png`);
      await c.send('Emulation.setEmulatedMedia', { features: [] });
    }
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    const procs = hubProcesses(hub.pid); result.processes = procs;
    const names = opt.states.split(',');
    const order = []; for (let r = 0; r < opt.rounds; r++) order.push(...(r % 2 ? [...names].reverse() : names));
    for (const name of order) {
      const s = STATES[name];
      await setAsk(s.ask); await setCards(s.cards);
      await sleep(2500);
      const visible = await c.eval(`({sweeps:[...document.querySelectorAll('.hw-sweep')].filter(e=>e.getClientRects().length).length, drawer:!document.querySelector('.ask').hidden})`);
      const before = cpuTimes(procs.map(p => p.pid)), tc0 = Date.now();
      await sleep(opt.secs * 1000);
      const after = cpuTimes(procs.map(p => p.pid)), wall = Date.now() - tc0;
      const cpu = {}; for (const p of procs) cpu[p.type] = (cpu[p.type] || 0) + (after[p.pid] ?? 0) - (before[p.pid] ?? 0);
      for (const k of Object.keys(cpu)) cpu[k] = +(cpu[k] / wall * 100).toFixed(1);
      events.length = 0;
      await c.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline.frame', transferMode: 'ReportEvents' });
      await sleep(8000); // 正好一个节拍，帧数按占空比算
      const done = new Promise(r => { tracingDone = r; }); await c.send('Tracing.end'); await done; tracingDone = null;
      const count = n => events.filter(e => e.name === n).length;
      const paints = events.filter(e => e.name === 'Paint' && e.ph === 'X');
      const row = { name, visible, cpuPctOfOneCore: cpu, perSec: { frames: +(count('DrawFrame') / 8).toFixed(1), paints: +(paints.length / 8).toFixed(1), styleRecalcs: +(count('UpdateLayoutTree') / 8).toFixed(1) } };
      result.cost.push(row); console.log(JSON.stringify(row));
      fs.writeFileSync(path.join(opt.out, 'sweep-cost.json'), JSON.stringify(result, null, 2));
    }
    result.ok = true;
  } catch (error) { result.error = error.stack; console.error(error.stack); process.exitCode = 1; }
  finally {
    if (hub) { try { await gracefulQuit(hub); } catch { /* best effort */ } hub.child?.stdout?.destroy(); hub.child?.stderr?.destroy(); hub.child?.stdin?.destroy(); fs.writeFileSync(path.join(opt.out, 'hub.log'), hub.log().join('\n')); }
    try { await c?.close(); } catch { /* closed */ }
    // 两轮平均
    const avg = {}; for (const r of result.cost) { const a = avg[r.name] ||= { n: 0, renderer: 0, gpu: 0, frames: 0, paints: 0 }; a.n++; a.renderer += r.cpuPctOfOneCore.renderer || 0; a.gpu += r.cpuPctOfOneCore['gpu-process'] || 0; a.frames += r.perSec.frames; a.paints += r.perSec.paints; }
    result.average = Object.fromEntries(Object.entries(avg).map(([k, a]) => [k, { renderer: +(a.renderer / a.n).toFixed(1), gpu: +(a.gpu / a.n).toFixed(1), frames: +(a.frames / a.n).toFixed(1), paints: +(a.paints / a.n).toFixed(1) }]));
    fs.writeFileSync(path.join(opt.out, 'sweep-cost.json'), JSON.stringify(result, null, 2));
    console.log('AVG ' + JSON.stringify(result.average)); console.log('OUT ' + opt.out);
  }
}
run();
