'use strict';
// 隔离 Hub（临时数据目录、不调用模型），预置 N 个休眠会话，在界面里模拟忙时的后台事件流
// （每 100 ms 10 条只改上下文 token 数的状态事件 + 用量事件 + 内容未变的会话快照，每 2 秒一次标题变化），
// 量 30 秒内：侧栏整表重绘次数、单次重绘耗时、界面发给主进程的保存包次数与字节数、state.json 实际写盘次数；
// 再模拟打字（每 80 ms 一个按键）看打字期间的重绘次数；最后截一张 1440 宽的图。
// 用法：node tests/e2e-render-save-perf-cdp.js [输出目录] [会话数]
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const outDir = path.resolve(process.argv[2] || 'artifacts/render-save-perf');
const N = Number(process.argv[3]) || 600;
const tag = process.env.HUB_E2E_TAG || 'hub';

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-render-save-perf-'));
  const data = path.join(root, 'data'), cwd = path.join(root, 'work');
  for (const d of [data, cwd]) fs.mkdirSync(d, { recursive: true });
  const now = Date.now();
  const sessions = Array.from({ length: N }, (_, i) => ({ hubId: `perf-${i}-${now}`, title: `会话 ${i + 1}`, kind: i % 3 ? 'claude' : 'codeagent', cwd,
    currentModel: { id: 'claude-haiku-4-5-20251001' }, lastMessageTime: now - i * 60000, updatedAt: now - i * 60000, savedAt: now, schemaVersion: 1,
    recentArtifacts: [{ path: path.join(cwd, `20261128-样例产物-${i}.md`), at: now - i * 60000 }] }));
  fs.writeFileSync(path.join(data, 'state.json'), j({ version: 1, cleanShutdown: true, meetings: [], immersiveByMeeting: {}, sessions }));
  const entryPath = path.join(root, 'foreground-scheduling.cjs');
  fs.writeFileSync(entryPath, `const {app}=require('electron');app.on('browser-window-created',(_e,w)=>w.webContents.setBackgroundThrottling(false));require(${j(path.join(path.resolve(__dirname, '..'), 'main-bootstrap.js'))});`);
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_PROXY: 'http://127.0.0.1:9', CLAUDE_HUB_AGENT_RUNTIME: 'pty' };
  let hub = null, c = null;
  const report = { tag, sessions: N };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label: 'render-save-perf-' + tag, entryPath, extraEnv: env });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, what, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await c.eval(expr)) return; } catch {} await sleep(100); } throw Error('timeout ' + what); };
    await until(`typeof sessions!=='undefined' && sessions.size>=${N} && document.querySelectorAll('.session-item').length>0`, 'rows');
    await sleep(4000); // 启动期的保存与重绘过去

    // 单次侧栏整表重绘耗时（直接调真实的 renderSessionSurfacesNow，取中位数）。
    report.renderMs = await c.eval(`(()=>{const t=[];for(let i=0;i<15;i++){const a=performance.now();renderSessionSurfacesNow();t.push(performance.now()-a);}t.sort((x,y)=>x-y);return {median:+t[7].toFixed(1),p90:+t[13].toFixed(1)};})()`);

    // 计数器：保存包（次数、字节）与 state.json 写盘次数。
    await c.eval(`(()=>{const ipc=require('electron').ipcRenderer;window.__perf={packets:0,bytes:0,full:0,delta:0};const send=ipc.send.bind(ipc);
      ipc.send=(ch,...a)=>{if(ch==='persist-sessions'||ch==='persist-sessions:delta'){window.__perf.packets++;window.__perf.bytes+=JSON.stringify(a).length;window.__perf[ch==='persist-sessions'?'full':'delta']++;}return send(ch,...a);};return true;})()`);
    const stateFile = path.join(data, 'state.json');
    let writes = 0, lastM = fs.statSync(stateFile).mtimeMs;
    const poll = setInterval(() => { try { const m = fs.statSync(stateFile).mtimeMs; if (m !== lastM) { writes++; lastM = m; } } catch {} }, 100);

    // 忙时事件流（只在界面里发事件，不调用模型）。
    const r0 = await c.eval('sidebarRenderCoalescer.stats().renders');
    await c.eval(`(()=>{const ipc=require('electron').ipcRenderer;const ids=[...sessions.keys()];let k=0;
      window.__perfTimer=setInterval(()=>{for(let n=0;n<10;n++){const id=ids[(k*10+n)%ids.length];const s=sessions.get(id);
        ipc.emit('status-event',{}, {sessionId:id,contextPct:s.contextPct??5,contextUsed:(s.contextUsed||1000)+17,contextMax:200000,apiMs:(s.apiMs||0)+40,model:s.currentModel});
        ipc.emit('session-usage-updated',{}, {sessionId:id,usage:{total:((s.sessionUsage&&s.sessionUsage.total)||0)+33,sourcePath:'x'}});
        ipc.emit('session-updated',{}, {session:{id,kind:s.kind,title:s.title,cwd:s.cwd}});}
        if(k%20===0){const s=sessions.get(ids[k%ids.length]);ipc.emit('session-updated',{}, {session:{id:s.id,kind:s.kind,title:'改名 '+k,titleRevision:k+1}});}
        k++;},100);return true;})()`);
    await sleep(30000);
    await c.eval('clearInterval(window.__perfTimer),true');
    await sleep(1000);
    clearInterval(poll);
    const r1 = await c.eval('sidebarRenderCoalescer.stats().renders');
    const perf = await c.eval('window.__perf');
    report.busy30s = { sidebarRenders: r1 - r0, persistPackets: perf.packets, persistFull: perf.full, persistDelta: perf.delta,
      persistMB: +(perf.bytes / 1048576).toFixed(2), bytesPerPacket: perf.packets ? Math.round(perf.bytes / perf.packets) : 0, stateJsonWrites: writes,
      stateJsonKB: Math.round(fs.statSync(stateFile).size / 1024) };

    // 打字期间：事件流照旧，同时每 80 ms 一个按键（真实键盘事件发到输入框），量 6 秒内的重绘次数。
    await c.eval(`(()=>{const ipc=require('electron').ipcRenderer;const ids=[...sessions.keys()];let k=0;
      window.__perfTimer=setInterval(()=>{const s=sessions.get(ids[k%ids.length]);ipc.emit('session-updated',{}, {session:{id:s.id,kind:s.kind,title:'打字时改名 '+k,titleRevision:1000+k}});k++;},100);return true;})()`);
    const t0 = await c.eval('sidebarRenderCoalescer.stats().renders');
    const end = Date.now() + 6000;
    while (Date.now() < end) { await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' }); await sleep(80); }
    const t1 = await c.eval('sidebarRenderCoalescer.stats().renders');
    await c.eval('clearInterval(window.__perfTimer),true');
    await sleep(2000);
    const t2 = await c.eval('sidebarRenderCoalescer.stats().renders');
    report.typing6s = { sidebarRendersWhileTyping: t1 - t0, rendersAfterStop: t2 - t1 };

    // 落盘核对：增量包期间先后置顶两个会话（界面字段，走增量保存），退出后看 state.json 是否带上。
    report.probeIds = await c.eval(`(()=>{const ids=[...sessions.keys()];const a=ids[3],b=ids[N_LAST];sessions.get(a).pinned=true;schedulePersist();
      setTimeout(()=>{sessions.get(b).pinned=true;schedulePersist();},2500);return [a,b];})()`.replace('N_LAST', String(N - 2)));
    await sleep(5000);
    const shot = path.join(outDir, `20261128-render-save-perf-${tag}.png`);
    fs.writeFileSync(shot, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    report.screenshot = shot;
    report.titlesOk = await c.eval(`[...sessions.values()].some(s=>/^改名 /.test(s.title))`);
  } finally {
    try { if (hub) await gracefulQuit(hub); } catch (e) { report.quitError = e.message; }
  }
  // 退出后重读 state.json：收尾保存是否带上了最后的标题。
  try {
    const st = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
    report.afterQuit = { sessions: st.sessions.length, cleanShutdown: st.cleanShutdown, typedTitleSaved: st.sessions.some(s => /^打字时改名 /.test(s.title || '')), renamedSaved: st.sessions.filter(s => /改名 /.test(s.title || '')).length,
      pinnedSaved: (report.probeIds || []).map(id => st.sessions.find(s => s.hubId === id)?.pinned === true) };
  } catch (e) { report.afterQuit = { error: e.message }; }
  const out = path.join(outDir, `20261128-render-save-perf-${tag}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
