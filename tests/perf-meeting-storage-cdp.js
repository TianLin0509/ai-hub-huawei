'use strict';
// 隔离 HUB-H 里的长会议压测（2026-11-24 m3，改前改后同一脚本；不进 npm test）。
// 场景：30 场历史会议 + 1 场正在采集、已有 6000 事件（约 1.8 MB）的会议；渲染进程按真实节奏走 IPC 采集：
// 每秒心跳，每 5 秒一张新截图，每 3 秒一条重点，每 10 秒两段音频，页面每 2.5 秒拉一次会议状态。
// 量：主进程事件循环延迟（经主进程 inspector 用 perf_hooks.monitorEventLoopDelay）、主进程 CPU、各 IPC 往返耗时。
// --crash：压测结束时直接结束隔离 Hub 进程（只结束本脚本启动的那个 PID），重开后核对会议能打开、丢了几条、文件能解析。
// 用法：node tests/perf-meeting-storage-cdp.js <输出json> [--seconds 90] [--crash]
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { randomUUID } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');

const args = process.argv.slice(2), outFile = path.resolve(args[0] || 'artifacts/perf-meeting-storage.json');
const seconds = Number(args[args.indexOf('--seconds') + 1]) || 90, crash = args.includes('--crash');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const words = '我们这个调度算法在高负载下的吞吐收益大概是百分之三到五然后需要再确认一下干扰场景的表现下周二之前给出结论负责人是小王'.split('');
const text = n => { let s = ''; for (let i = 0; i < n; i++) s += words[(i * 7 + n) % words.length]; return s; };
function events(n) {
  const out = []; let t = 0;
  while (out.length < n) {
    t += 1200; const r = (out.length * 13) % 10, seq = out.length + 1;
    if (r < 2) out.push({ at: t, end: t + 10000, file: `${r ? 'mic' : 'system'}-${seq}.wav`, track: r ? 'mic' : 'system', asr: 'done', seq, kind: 'audio' });
    else if (r < 9) out.push({ at: t, end: t + 3000, track: r % 2 ? 'mic' : 'system', audioSeq: 1, text: text(30 + (seq % 40)), speaker: 's' + (r % 4), seq, kind: 'transcript' });
    else out.push({ at: t, file: `page-${seq}.jpg`, hash: seq.toString(16).padStart(64, '0'), forced: false, seq, kind: 'slide' });
  }
  return { list: out, t };
}
function history(n) {
  const { list, t } = events(n);
  return { id: randomUUID(), title: '历史会议', sourceName: 'x', audio: ['system', 'mic'], startedAt: Date.now() - 86400000, state: 'ended', capturedMs: t, transcribedMs: t, understoodMs: t, cursor: n, revision: 3, events: list,
    answers: Array.from({ length: 30 }, () => ({ id: randomUUID(), q: text(30), state: 'done', answer: text(500), queuedAt: t, at: t })), summary: text(4000), error: '', autoUnderstand: false, autoIntervalMin: 0, speed: 'normal',
    sessionId: randomUUID(), agent: { state: 'ready' }, questionSessionId: null, questionAgent: { state: 'none' }, understandingProtocol: 2, questionProtocol: 2, minutesProtocol: 2, recording: { segments: [], gaps: [], bytes: 0, savedThrough: 0 } };
}
const stat = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), p50: +q(0.5).toFixed(2), p99: +q(0.99).toFixed(2), max: +s.at(-1).toFixed(2) }; };

async function launch(dataDir, inspectPort, stub) {
  return launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'm3 meeting perf',
    extraEnv: { CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_WELINK_CLI: stub },
    extraArgs: inspectPort ? [`--inspect=127.0.0.1:${inspectPort}`] : [] });
}
async function renderer(hub) {
  const page = await connectFirstPage(hub, null, { waitMainMs: 30000, commandTimeoutMs: 600000 });
  const ev = async expression => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 60; i++) { try { if (await ev(`typeof require === 'function'`)) break; } catch {} await _waitMs(500); }
  await ev(`(() => { const { ipcRenderer } = require('electron'); window.__inv = (n, a = {}) => ipcRenderer.invoke('company-assistant:' + n, a); return true; })()`);
  return { page, ev };
}
async function mainInspector(port) {
  let list;
  for (let i = 0; i < 60 && !list?.length; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch {} if (!list?.length) await _waitMs(500); }
  const client = await connectCDP(list[0].webSocketDebuggerUrl, { commandTimeoutMs: 60000 });
  const ev = async expression => {
    const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, includeCommandLineAPI: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { client, ev };
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-meeting-perf-')), dataDir = path.join(testRoot, 'data'), stub = path.join(testRoot, 'welink-disabled.js');
  fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
  fs.writeFileSync(stub, 'process.exit(1)\n');
  const result = { version: require('../package.json').version, commit: require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.join(__dirname, '..'), windowsHide: true }).toString().trim(), seconds, testRoot };
  let hub;
  try {
    const inspectPort = await freePort();
    hub = await launch(dataDir, inspectPort, stub); result.pid = hub.pid;
    const r = await renderer(hub), main = await mainInspector(inspectPort);
    const started = await r.ev(`__inv('meeting-start', { title: '长会议压测', audio: ['system', 'mic'] })`);
    if (!started?.ok) throw new Error('meeting-start 失败：' + JSON.stringify(started));
    const id = started.meeting.id, st = await r.ev(`__inv('meeting-status', { id: ${JSON.stringify(id)} })`), root = st.storage.root;
    for (let i = 0; i < 30; i++) { const h = history(i < 10 ? 6000 : 1000), d = path.join(root, h.id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'meeting.json'), JSON.stringify(h, null, 2)); }
    // 把进行中的这场换成已有 6000 事件的版本（保留编号与会话），不让它去预热 AI。
    // 会议正本常驻内存后，采集中的会议可能有未落盘改动（内存为准）：先「暂停」让它立即落盘，再改文件、再「继续」；没生效就重来（最多 5 次）。
    const file = path.join(root, id, 'meeting.json'), seeded = events(6000); let check = 0;
    for (let attempt = 0; attempt < 5 && check !== 6000; attempt++) {
      await _waitMs(1500); await r.ev(`__inv('meeting-control', { id: ${JSON.stringify(id)}, op: 'pause' })`);
      const live = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.assign(live, { state: 'paused', events: seeded.list, capturedMs: seeded.t, transcribedMs: seeded.t, cursor: 6000, summary: text(4000), primeRequested: false, agent: { state: 'ready' }, job: null, autoUnderstand: false, autoIntervalMin: 0, answers: history(1).answers });
      fs.writeFileSync(file, JSON.stringify(live, null, 2)); const later = new Date(Date.now() + 2000 + attempt * 1000); fs.utimesSync(file, later, later);
      await r.ev(`__inv('meeting-control', { id: ${JSON.stringify(id)}, op: 'resume' })`);
      check = await r.ev(`__inv('meeting-status', { id: ${JSON.stringify(id)} }).then(s => s.meeting?.events?.length)`);
      result.seedAttempts = attempt + 1;
    }
    result.liveMeetingBytes = fs.statSync(file).size;
    if (check !== 6000) throw new Error('播种没生效：' + check);
    await main.ev(`(() => { const ph = process.mainModule.require('perf_hooks'); globalThis.__m3eld?.disable(); globalThis.__m3eld = ph.monitorEventLoopDelay({ resolution: 5 }); globalThis.__m3eld.enable(); globalThis.__m3cpu = process.cpuUsage(); globalThis.__m3t = Date.now(); return true; })()`);
    // 渲染进程按节奏发 IPC，记每类往返耗时与确认收下的重点条数。
    const load = await r.ev(`(async () => {
      const id = ${JSON.stringify(id)}, words = ${JSON.stringify(words.join(''))}, lat = { heartbeat: [], slide: [], mark: [], audio: [], status: [], video: [] }, errors = [];
      const wav = (() => { const b = new Uint8Array(64); 'RIFF'.split('').forEach((c, i) => b[i] = c.charCodeAt(0)); 'WAVE'.split('').forEach((c, i) => b[8 + i] = c.charCodeAt(0)); return btoa(String.fromCharCode(...b)); })();
      const jpg = i => { const b = new Uint8Array(2048).fill(i % 251); b[0] = 0xff; b[1] = 0xd8; let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
      let at = ${seeded.t}, marks = 0, lastMarkAt = 0;
      // 录像：每秒一块约 140 KB（0.5 GB/小时），首块带 WebM 文件头。
      const key = crypto.randomUUID(), videoChunk = first => { const b = new Uint8Array(140 * 1024).fill(7); if (first) b.set([0x1a, 0x45, 0xdf, 0xa3]); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return btoa(s); };
      let videoOffset = 0; const plain = videoChunk(false), head = videoChunk(true);
      await __inv('meeting-capture', { id, kind: 'recording-start', key, at, full: true, mime: 'video/webm;codecs=vp8,opus', width: 1920, height: 1080 });
      const call = async (kind, name, payload) => { const t0 = performance.now(); try { const res = await __inv(name, payload); if (res && res.ok === false) errors.push(kind + ':' + res.error); return res; } finally { lat[kind].push(performance.now() - t0); } };
      const end = performance.now() + ${seconds} * 1000; let sec = 0; const inflight = [];
      while (performance.now() < end) {
        const tick = performance.now(); at += 1000;
        inflight.push(call('heartbeat', 'meeting-capture', { id, kind: 'heartbeat', at }));
        { const off = videoOffset; videoOffset += 140 * 1024; await call('video', 'meeting-capture', { id, kind: 'recording-chunk', key, at, offset: off, data: off ? plain : head, durationMs: at - ${seeded.t} }); }
        if (sec % 5 === 0) inflight.push(call('slide', 'meeting-capture', { id, kind: 'slide', at, data: jpg(sec) }));
        if (sec % 3 === 0) { const a = at; inflight.push(call('mark', 'meeting-capture', { id, kind: 'mark', at: a, text: words.slice(0, 60) }).then(res => { if (res?.ok) { marks++; lastMarkAt = a; } })); }
        if (sec % 10 === 0) for (const track of ['system', 'mic']) inflight.push(call('audio', 'meeting-capture', { id, kind: 'audio', track, at: at - 10000, end: at, data: wav }));
        if (sec % 5 === 0 || sec % 5 === 2) inflight.push(call('status', 'meeting-status', { id }));
        sec++; await new Promise(r => setTimeout(r, Math.max(0, 1000 - (performance.now() - tick))));
      }
      await Promise.all(inflight);
      return { lat, errors: errors.slice(0, 10), errorCount: errors.length, marks, lastMarkAt, finalAt: at, videoBytes: videoOffset };
    })()`);
    const loop = await main.ev(`(() => { const h = globalThis.__m3eld; h.disable(); const cpu = process.cpuUsage(globalThis.__m3cpu), wall = Date.now() - globalThis.__m3t;
      return { p50: h.percentile(50) / 1e6, p90: h.percentile(90) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6, mean: h.mean / 1e6, over50ms: null, cpuPercent: +((cpu.user + cpu.system) / 1000 / wall * 100).toFixed(1) }; })()`);
    result.mainEventLoopDelayMs = Object.fromEntries(Object.entries(loop).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v]));
    result.ipcMs = Object.fromEntries(Object.entries(load.lat).map(([k, v]) => [k, stat(v)]));
    result.ipcErrors = { count: load.errorCount, sample: load.errors };
    result.marksAcked = load.marks;
    if (crash) {
      // 采集中直接结束隔离 Hub（只结束本脚本起的这个进程），重开核对。
      const killedAt = Date.now(); hub.child.kill('SIGKILL');
      for (let i = 0; i < 100 && hub.isAlive(); i++) await _waitMs(100);
      result.crash = { killedAlive: hub.isAlive(), killedAt };
      let parsed = null, parseError = '';
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { parseError = e.message; }
      const marksOnDisk = parsed ? parsed.events.filter(e => e.kind === 'mark').length : -1;
      Object.assign(result.crash, { fileParses: !!parsed, parseError, marksOnDisk, marksAcked: load.marks, lostMarks: load.marks - marksOnDisk, lostCaptureSeconds: parsed ? +((load.finalAt - parsed.capturedMs) / 1000).toFixed(1) : null });
      let videoOnDisk = -1; try { videoOnDisk = fs.statSync(path.join(root, id, 'recording-full.webm')).size; } catch {}
      Object.assign(result.crash, { videoBytesAcked: load.videoBytes, videoOnDisk });
      await _waitMs(2000);
      hub = await launch(dataDir, 0, stub); const r2 = await renderer(hub);
      const back = await r2.ev(`__inv('meeting-status', { id: ${JSON.stringify(id)} }).then(s => ({ ok: s.ok, state: s.meeting?.state, events: s.meeting?.events?.length, marks: s.meeting?.events?.filter(e => e.kind === 'mark').length, error: s.meetingError || '' }))`);
      result.crash.reopened = back;
    }
  } catch (error) { result.error = error.stack || error.message; process.exitCode = 1; }
  finally {
    if (hub?.isAlive?.()) { try { await gracefulQuit(hub, { timeoutMs: 30000 }); } catch (e) { result.quitError = e.message; } }
    try { fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { result.cleanupError = e.message; }
    fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  }
})();
