'use strict';
// Native MediaRecorder -> real meeting IPC -> finish repair -> Chromium decoder.
// Synthetic canvas/audio avoids capturing user windows or microphones.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { fixMp4Index } = require('../core/company-assistant/meeting-mp4-index');
const { fixWebmDuration } = require('../core/company-assistant/meeting-webm-duration');
function payloadHash(file, format) {
  const b = fs.readFileSync(file), h = require('node:crypto').createHash('sha256');
  if (format === 'mp4') { for (const e of require('../core/company-assistant/meeting-mp4-index').boxes(b).filter(x => x.type === 'mdat')) h.update(b.subarray(e.start, e.end)); }
  else {
    const { element } = require('../core/company-assistant/meeting-webm-duration'), seg = element(b, element(b, 0).end);
    for (let at = seg.start; at < b.length;) { const e = element(b, at); if (e.id === 0x1f43b675) { at = e.start; continue; } if ([0xa0, 0xa3].includes(e.id)) h.update(b.subarray(e.at, e.end)); if (!Number.isFinite(e.end) || e.end > b.length) throw Error('unexpected WebM structure'); at = e.end; }
  }
  return h.digest('hex');
}
const repo = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2] || 'artifacts/20261124-media-e2e-m6');
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function recordNative(format, output) {
  const fs = require('node:fs'), path = require('node:path'), { ipcRenderer } = require('electron');
  const { MeetingRecorder } = require(path.join(window.__mediaRepo, 'renderer/meeting-recorder.js'));
  const invoke = (name, args) => ipcRenderer.invoke('company-assistant:' + name, args);
  const started = await invoke('meeting-start', { title: '录屏索引验收 ' + format, audio: [] }); if (!started.ok) throw Error(JSON.stringify(started));
  const id = started.meeting.id, canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; document.body.append(canvas);
  const ctx = canvas.getContext('2d'), audio = new AudioContext(), oscillator = audio.createOscillator(), dest = audio.createMediaStreamDestination(); oscillator.connect(dest); oscillator.start();
  const stream = canvas.captureStream(15); for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
  let frame = 0; const draw = setInterval(() => { ctx.fillStyle = frame % 2 ? '#dce8ff' : '#f2f2f2'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#153356'; ctx.font = '42px sans-serif'; ctx.fillText('Real recorder ' + frame++, 30, 150); }, 66);
  const began = performance.now(), errors = []; let original, recorder;
  try {
    recorder = new MeetingRecorder({ window, streams: [stream], elapsed: () => Math.round(performance.now() - began), save: async r => {
      if (r.kind === 'recording-finish') {
        const index = await invoke('meeting-recording', { id }); original = index.recording.full;
        const status = await invoke('meeting-status', { id });
        fs.copyFileSync(path.join(status.storage.current, original.file), path.join(output, 'native-before.' + format));
      }
      const result = await invoke('meeting-capture', { ...r, id }); if (result.ok === false) throw Error(result.error);
    }, onError: e => errors.push(e) });
    await recorder.open();
    const mime = format === 'mp4' ? 'video/mp4;codecs=avc1.42E01F,mp4a.40.2' : 'video/webm;codecs=vp8,opus';
    if (!MediaRecorder.isTypeSupported(mime)) throw Error('encoder unavailable: ' + mime); recorder.mimes = [mime]; recorder.mime = mime;
    recorder.start(); await new Promise(r => setTimeout(r, 8200)); await recorder.close(); if (errors.length) throw Error(errors.join(';'));
    await invoke('meeting-control', { id, op: 'stop' });
    // The actual file location is resolved through the public playback IPC after finish.
    let playback = await invoke('meeting-playback', { id, at: 1000 }); if (!playback.ok) throw Error(JSON.stringify(playback));
    const file = require('node:url').fileURLToPath(playback.url);
    for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
      const s = await invoke('meeting-recording', { id }); if (s.recording.full.seekIndexVersion === 1 || s.recording.full.durationError) break; await new Promise(r => setTimeout(r, 50));
    }
    const final = (await invoke('meeting-recording', { id })).recording.full;
    fs.copyFileSync(file, path.join(output, 'native-fixed.' + format));
    return { id, file, final, bytes: fs.statSync(file).size, events: frame, errors, original };
  } finally { clearInterval(draw); for (const t of stream.getTracks()) t.stop(); oscillator.stop(); await audio.close(); canvas.remove(); }
}
async function seekVideo(file, expected) {
  const v = document.createElement('video'); v.muted = true; document.body.append(v);
  const wait = (event, action) => new Promise((resolve, reject) => { const timer = setTimeout(() => { cleanup(); reject(Error(event + ' timeout')); }, 10000); const ok = () => { cleanup(); resolve(); }, bad = () => { cleanup(); reject(Error(v.error?.message || 'video error')); }; function cleanup() { clearTimeout(timer); v.removeEventListener(event, ok); v.removeEventListener('error', bad); } v.addEventListener(event, ok, { once: true }); v.addEventListener('error', bad, { once: true }); action(); });
  try {
    await wait('loadeddata', () => { v.src = require('node:url').pathToFileURL(file).href + '?probe=' + Date.now(); v.load(); });
    const duration = Number.isFinite(v.duration) ? v.duration : null, seeks = [];
    for (const ratio of [.25, .5, .9]) {
      const target = (duration || expected) * ratio, before = performance.now();
      try { await wait('seeked', () => { v.currentTime = target; }); seeks.push({ ratio, target, actual: v.currentTime, ms: performance.now() - before, readyState: v.readyState, ok: Math.abs(v.currentTime - target) < .25 && v.readyState >= 2 }); }
      catch (e) { seeks.push({ ratio, target, ms: performance.now() - before, ok: false, error: e.message }); }
    }
    return { file, duration, seeks };
  } finally { v.removeAttribute('src'); v.load(); v.remove(); }
}
(async () => {
  fs.mkdirSync(out, { recursive: true }); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-media-e2e-')), dataDir = path.join(root, 'data'), workspace = path.join(root, 'work');
  fs.mkdirSync(workspace); fs.mkdirSync(dataDir); fs.writeFileSync(path.join(workspace, '.aiwork-root'), ''); fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false, tray: false }));
  const result = { root, out, recordings: [], probes: [] }; let hub, c;
  const audit = () => {
    const value = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'helpers/reskin-window-audit.ps1'), '-RootProcessId', String(hub.pid)], { windowsHide: true, encoding: 'utf8', timeout: 30000 }));
    (result.windowAudits ||= []).push(value); assert.deepEqual(value.visible, [], 'isolated Hub stays hidden');
  };
  const welink = path.join(root, '20261124-welink-disabled-m6.js'); fs.writeFileSync(welink, 'process.stdout.write(JSON.stringify({authenticated:false,loggedIn:false}));');
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await port(), windowMode: 'hidden', label: 'm6 recording indexes', extraEnv: {
      CLAUDE_HUB_WELINK_CLI: welink,
      AI_HUB_WORKSPACE_ROOT: workspace, AI_HUB_CODEAGENT_COMMAND: path.join(root, 'missing-cli.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false }, foreign: { ok: false } }),
    } });
    result.pid = hub.pid; c = await connectFirstPage(hub, null, { waitMainMs: 20000 }); await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    result.initialTarget = c.targetSnapshot;
    // Some local runtime builds expose the main target before its initial navigation.
    // Only navigate this owned, isolated target to the repository's own UI.
    if (!/renderer[\\/]index\.html/i.test(c.targetSnapshot.url)) { result.navigatedIsolatedTarget = true; await c.send('Page.navigate', { url: require('node:url').pathToFileURL(path.join(repo, 'renderer/index.html')).href }); }
    for (const end = Date.now() + 20000; Date.now() < end;) { if (await c.eval('!!document.body && location.protocol === "file:" && typeof crypto.randomUUID === "function"')) break; await new Promise(r => setTimeout(r, 100)); }
    result.page = await c.eval('({url:location.href,ready:document.readyState,uuid:typeof crypto.randomUUID})');
    fs.writeFileSync(path.join(out, '20261124-seek-results-m6.json'), JSON.stringify(result, null, 2));
    result.page = await c.eval(`(async()=>{for(const until=Date.now()+30000;Date.now()<until;){if(document.body&&document.readyState==='complete')return location.href;await new Promise(r=>setTimeout(r,100));}throw Error('isolated renderer document did not load: '+location.href);})()`, { timeoutMs: 35000 });
    await c.eval(`window.__mediaRepo=${JSON.stringify(repo)}`);
    audit();
    for (const format of ['mp4', 'webm']) {
      const rec = await c.eval(`(${recordNative.toString()})(${JSON.stringify(format)},${JSON.stringify(out)})`, { timeoutMs: 60000 }); result.recordings.push(rec);
      assert.equal(rec.final.seekIndexVersion, 1, JSON.stringify(rec.final)); assert.equal(rec.final.durationError, '');
      const before = payloadHash(path.join(out, 'native-before.' + format), format), after = payloadHash(path.join(out, 'native-fixed.' + format), format); assert.equal(after, before, 'encoded media payload stays unchanged'); rec.payloadSha256 = after;
    }
    const sourceDir = process.argv[3] || 'D:/Temp/hubh-meeting-review-m3';
    for (const [format, source] of [['mp4', 'probe-full.mp4'], ['webm', 'probe-raw.webm']]) {
    if (!fs.existsSync(path.join(sourceDir, source))) continue;
      const before = path.join(out, 'review-before.' + format), after = path.join(out, 'review-after.' + format); fs.copyFileSync(path.join(sourceDir, source), before); fs.copyFileSync(before, after);
      if (format === 'mp4') await fixMp4Index(after); else await fixWebmDuration(after, 4800);
      result.probes.push(await c.eval(`(${seekVideo.toString()})(${JSON.stringify(before)},4.8)`, { timeoutMs: 45000 }));
      result.probes.push(await c.eval(`(${seekVideo.toString()})(${JSON.stringify(after)},4.8)`, { timeoutMs: 45000 }));
    }
    for (const format of ['mp4', 'webm']) for (const phase of ['before', 'fixed']) result.probes.push(await c.eval(`(${seekVideo.toString()})(${JSON.stringify(path.join(out, 'native-' + phase + '.' + format))},8.2)`, { timeoutMs: 45000 }));
    for (const p of result.probes.filter(x => !x.file.includes('before'))) { assert.ok(p.duration > 0); assert.ok(p.seeks.every(x => x.ok), JSON.stringify(p)); }
    result.passed = true;
    audit();
  } catch (e) { result.error = e.stack; process.exitCode = 1; }
  finally {
    if (hub) { try { result.quit = await gracefulQuit(hub, { timeoutMs: 60000, allowAlreadyExited: true }); } catch (e) { result.quitError = e.stack; result.passed = false; process.exitCode = 1; } fs.writeFileSync(path.join(out, '20261124-hub-m6.log'), hub.log().join('\n')); } if (c) await c.close();
    fs.writeFileSync(path.join(out, '20261124-seek-results-m6.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: result.passed, error: result.error, out }));
  }
})();
