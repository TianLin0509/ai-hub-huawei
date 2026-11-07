'use strict';
// Real MediaRecorder + synthetic canvas. Inject errors/late native callbacks, never replace encoding.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict'), { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2] || 'artifacts/meeting-lifecycle-cdp');
const mutateStartCatch = process.argv.includes('--mutation-start-catch');
const startFailureOnly = process.argv.includes('--start-failure-only');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const fixtureFile = path.join(__dirname, 'e2e-company-meeting-flow-cdp.js'), fixtureSource = fs.readFileSync(fixtureFile, 'utf8');
const begin = fixtureSource.indexOf('function installFixture() {'), end = fixtureSource.indexOf('\n(async () => {', begin);
assert.ok(begin >= 0 && end > begin, 'extract only the existing meeting fixture');
const fixtureFunction = fixtureSource.slice(begin, end).trim();

function installStartCatchMutation() {
  const evidence = window.lifecycleMutation = { requested: 'start-catch-guard-false', loader: 'isolated-renderer-module-cache', applied: 0, mountCalls: 0 };
  try {
    const Module = require('node:module'), crypto = require('node:crypto'), fs = require('node:fs'), assert = require('node:assert/strict');
    const target = require.resolve('../renderer/company-meeting-page');
    const anchor = 'if (cleanupError || next.queue.length || next.saving || next.recorder?.queue.length || next.recorder?.saving) {';
    const marker = 'false /* lifecycle mutation: intentionally drop pending owner */';
    evidence.originalHostAbsent = !document.getElementById('company-meeting-page');
    evidence.originalNavCount = document.querySelectorAll('#btn-company-meeting').length;
    assert.equal(evidence.originalHostAbsent, true); assert.equal(evidence.originalNavCount, 1);
    const oldModule = require.cache[target]; assert.ok(oldModule, 'original page module was initialized before fixture');
    let source = fs.readFileSync(target, 'utf8'); evidence.matches = source.split(anchor).length - 1;
    assert.equal(evidence.matches, 1, 'unique start catch guard');
    evidence.file = target; evidence.beforeSha256 = crypto.createHash('sha256').update(source).digest('hex');
    source = source.replace(anchor, 'if (' + marker + ') {');
    evidence.afterSha256 = crypto.createHash('sha256').update(source).digest('hex');
    const isolated = new Module(target, oldModule.parent); isolated.filename = target; isolated.paths = [...oldModule.paths];
    isolated._compile(source, target); evidence.applied++;
    const factory = isolated.exports.createCompanyMeetingPage;
    evidence.factoryMarkerMatches = factory.toString().split(marker).length - 1; assert.equal(evidence.factoryMarkerMatches, 1);
    isolated.exports.createCompanyMeetingPage = function (...args) { evidence.mountCalls++; return factory.apply(this, args); };
    require.cache[target] = isolated;
    document.getElementById('btn-company-meeting').remove();
    const layout = require('../renderer/company-meeting-layout').createMeetingLayout({ document, window, ipcRenderer,
      closeOtherPanels: () => { window.hubWorkspaces?.close(); }, showMessage: message => window.__hubToast?.(message), openSession: null });
    window.__companyMeetingHide = () => layout.close();
    evidence.newNavCount = document.querySelectorAll('#btn-company-meeting').length;
    evidence.cacheUsesMutant = require.cache[target] === isolated;
    assert.equal(evidence.mountCalls, 1); assert.equal(evidence.newNavCount, 1); assert.equal(evidence.cacheUsesMutant, true);
  } catch (error) { evidence.error = error.stack; }
  return evidence;
}

function installLifecycleFixture() {
  const f = window.m3Fixture, original = ipcRenderer.invoke.bind(ipcRenderer);
  f.asr = { ready: true }; f.sequence = 0; f.saveOwners = []; f.partOwners = new Map(); f.opened = []; f.held = []; f.captures = []; f.stopFaults = [];
  const { MeetingCapture } = require('../renderer/meeting-capture');
  const open = MeetingCapture.prototype.open;
  MeetingCapture.prototype.open = async function (...args) {
    this.waitMs = 500; window.lifecycleCapture = this; f.captures.push(this);
    await open.apply(this, args);
    this.testTracks = this.streams.flatMap(s => s.getTracks());
  };
  f.holdStops = () => {
    const capture = window.lifecycleCapture;
    for (const part of capture.recorder.active) {
      const nativeCallback = part.recorder.onstop;
      const held = { recorder: part.recorder, nativeCallback, owner: f.current.id, arrived: false, released: false };
      part.recorder.onstop = event => { held.arrived = true; held.event = event; };
      f.held.push(held);
    }
  };
  f.releaseStops = () => {
    for (const h of f.held) if (h.arrived && !h.released) { h.released = true; h.recorder.onstop = h.nativeCallback; h.nativeCallback.call(h.recorder, h.event); }
  };
  f.holdFullPause = () => {
    const part = window.lifecycleCapture.recorder.full, recorder = part.recorder, originalPause = recorder.pause;
    const held = f.heldPause = { arrived: false, recorder, originalPause };
    recorder.pause = function () {
      held.nativeCallback = this.onpause; held.fallback = part.paused;
      this.onpause = event => { held.arrived = true; held.event = event; };
      return originalPause.call(this);
    };
  };
  f.failLivePlayWithHeldSave = () => {
    const live = document.querySelector('[data-m="live"]'), originalPlay = live.play;
    const held = f.startSave = { blocked: 0, released: false, live, originalPlay };
    held.pending = new Promise(resolve => { held.release = resolve; });
    live.play = async function () {
      live.play = originalPlay;
      // Wait for actual encoder output before rejecting only the page preview's play call.
      for (const end = performance.now() + 10000; performance.now() < end;) {
        if (f.current?.recording.full?.bytes > 0) {
          held.id = f.current.id; held.bytesBeforeFailure = f.current.recording.full.bytes;
          held.enabled = true; throw Error('预览播放拒绝夹具');
        }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw Error('start failure fixture did not receive real encoded bytes');
    };
  };
  f.releaseStartSave = () => { if (f.startSave) { f.startSave.released = true; f.startSave.release(); f.startSave.live.play = f.startSave.originalPlay; } };
  f.lifecycleSnapshot = () => {
    const capture = window.lifecycleCapture, recorder = capture?.recorder, m = f.current;
    const part = p => p ? { key: p.key, bytes: p.bytes, status: p.status, full: p.full, mime: p.mime } : null;
    const native = p => p ? { state: p.recorder.state, full: p.full, finished: !!p.finished, mediaMs: p.mediaMs } : null;
    const item = x => ({ kind: x.kind, key: x.key, offset: x.offset, id: x.id, full: x.full });
    const calls = f.calls.filter(x => x.channel === 'company-assistant:meeting-capture' && /^recording-(start|chunk|finish)$/.test(x.args.kind));
    const counts = {}; for (const call of calls) counts[call.args.kind] = (counts[call.args.kind] || 0) + 1;
    return {
      meeting: m ? { id: m.id, state: m.state, recording: { bytes: m.recording.bytes, full: part(m.recording.full), segments: m.recording.segments.map(part) } } : null,
      capture: capture ? { released: capture.released, running: capture.running, ending: capture.ending, paused: capture.paused, saving: capture.saving, saveError: capture.saveError, queue: capture.queue.map(item), tracks: capture.testTracks?.map(t => t.readyState) } : null,
      recorder: recorder ? { full: native(recorder.full), active: [...recorder.active].map(native), saving: recorder.saving, running: recorder.running, closing: recorder.closing, pauseTask: !!recorder.pauseTask, closeTask: !!recorder.closeTask, error: recorder.error, lifecycleError: recorder.lifecycleError, queue: recorder.queue.map(item) } : null,
      buttons: [...document.querySelectorAll('[data-act="open-full"]')].map(b => ({ disabled: b.disabled, width: b.getBoundingClientRect().width, html: b.outerHTML })),
      message: document.querySelector('[data-m="message"]')?.textContent,
      startSave: f.startSave ? { id: f.startSave.id, blocked: f.startSave.blocked, released: f.startSave.released, bytesBeforeFailure: f.startSave.bytesBeforeFailure,
        backendStops: f.calls.filter(x => x.channel === 'company-assistant:meeting-control' && x.args.id === f.startSave.id && x.args.op === 'stop').length } : null,
      calls: { counts, recent20: calls.slice(-20).map(x => item(x.args)) },
      saveOwners: f.saveOwners.map(x => ({ ...x })),
    };
  };
  f.cleanup = async () => {
    clearInterval(window.m3DrawTimer);
    f.releaseStartSave();
    if (f.heldPause) { const h = f.heldPause; h.recorder.pause = h.originalPause; h.recorder.onpause = h.nativeCallback; if (h.arrived) h.nativeCallback.call(h.recorder, h.event); }
    // Restore handlers even if a failure happened before the intercepted native stop arrived.
    for (const h of f.held) h.recorder.onstop = h.nativeCallback;
    f.releaseStops(); f.failSave = false;
    const errors = [];
    for (const capture of f.captures) {
      try { await capture.retry(); } catch (e) { errors.push('retry: ' + e.message); }
      try { await capture.stop(); } catch (e) { errors.push('stop: ' + e.message); try { await capture.dispose(); } catch (x) { errors.push('dispose: ' + x.message); } }
    }
    return { errors, tracks: f.captures.flatMap(c => c.testTracks || []).map(t => t.readyState), running: f.captures.map(c => c.running) };
  };
  ipcRenderer.invoke = async (channel, args = {}) => {
    if (channel === 'company-assistant:meeting-control' && args.op === 'stop') {
      if (f.failNextControlStop) {
        f.failNextControlStop = false; f.calls.push({ channel, args, injectedRejection: true });
        f.stopFaults.push({ id: args.id, kind: 'before-state-change', state: f.meetings[args.id].state });
        throw Error('后台拒绝结束夹具');
      }
      if (f.loseNextControlStopAck) {
        f.loseNextControlStopAck = false; await original(channel, args);
        f.stopFaults.push({ id: args.id, kind: 'reply-lost-after-ended', state: f.meetings[args.id].state });
        throw Error('后台结束回执丢失夹具');
      }
    }
    if (channel === 'company-assistant:meeting-start') {
      const reply = await original(channel, args), m = reply.meeting;
      delete f.meetings[m.id]; m.id = 'lifecycle-' + ++f.sequence; m.title = '生命周期会议 ' + f.sequence;
      f.meetings[m.id] = m; f.current = m; return reply;
    }
    if (channel === 'company-assistant:meeting-capture') {
      if (args.kind === 'recording-start') f.partOwners.set(args.key, args.id);
      const expected = args.key ? f.partOwners.get(args.key) : args.id;
      f.saveOwners.push({ id: args.id, expected, key: args.key, kind: args.kind, at: args.at, bytes: args.data ? Buffer.byteLength(args.data, 'base64') : 0 });
      if (expected !== args.id) throw Error('capture crossed meeting ownership: ' + args.key);
      if (f.startSave?.enabled && !f.startSave.released && args.id === f.startSave.id && args.kind === 'recording-finish') {
        f.startSave.blocked++; await f.startSave.pending;
      }
    }
    if (channel === 'company-assistant:meeting-open-full') {
      const m = f.meetings[args.id], full = m?.recording?.full;
      if (!full?.bytes || full.status !== 'ready' || !full.url) throw Error('full recording is not saved');
      f.calls.push({ channel, args }); f.opened.push({ id: args.id, key: full.key, bytes: full.bytes }); return { ok: true };
    }
    if (channel.startsWith('company-assistant:') && !channel.startsWith('company-assistant:meeting-')) throw Error('unexpected external assistant IPC');
    return original(channel, args);
  };
}

(async () => {
  fs.mkdirSync(out, { recursive: true }); let hub, c, timer, auditError;
  const startedAt = Date.now();
  const result = { passed: false, checks: [], screenshots: [], windowAudits: [], startFailureOnly, mutationRequested: mutateStartCatch, evidence: 'real canvas capture/MediaRecorder; meeting IPC, recorder errors and delayed native stop callbacks are fixtures; no company/account/OS player',
    fixtureSource: { file: fixtureFile, sha256: createHash('sha256').update(fixtureSource).digest('hex') },
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim(),
    productHashes: Object.fromEntries(['renderer/meeting-capture.js', 'renderer/meeting-recorder.js', 'renderer/company-meeting-page.js', 'renderer/styles/company-meeting.css'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')])) };
  const record = () => fs.writeFileSync(path.join(out, 'meeting-lifecycle-cdp.json'), JSON.stringify(result, null, 2));
  const assertFrozen = () => { for (const [file, expected] of Object.entries(result.productHashes)) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex'), expected, 'frozen product changed: ' + file); };
  const diagnostic = async label => {
    if (!c) return;
    assertFrozen();
    const value = await c.eval('window.m3Fixture?.lifecycleSnapshot ? m3Fixture.lifecycleSnapshot() : null');
    (result.diagnostics ||= []).push({ label, elapsedMs: Date.now() - startedAt, value }); record();
  };
  process.on('exit', code => fs.writeFileSync(path.join(out, 'node-exit.txt'), String(code) + '\n'));
  const windowAudit = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'helpers/reskin-window-audit.ps1'), '-RootProcessId', String(hub.pid)], { windowsHide: true, encoding: 'utf8', timeout: 30000 }));
  const audit = label => { const value = windowAudit(); result.windowAudits.push({ label, elapsedMs: Date.now() - startedAt, ...value }); record(); assert.deepEqual(value.visible, [], 'owned Hub has no visible windows'); };
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-lifecycle-ui-')), dataDir = path.join(root, 'data'), work = path.join(root, 'work'), welink = path.join(root, 'welink-disabled.js');
    for (const p of [dataDir, work, path.join(root, 'personal'), path.join(root, 'scan')]) fs.mkdirSync(p);
    fs.writeFileSync(path.join(work, '.aiwork-root'), ''); fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
    fs.writeFileSync(welink, 'process.stdout.write(JSON.stringify({authenticated:false,loggedIn:false}));');
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'meeting recording lifecycle', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(root, 'missing-cli.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline fixture' }, foreign: { ok: false, error: 'offline fixture' } }),
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_WELINK_CLI: welink,
    } }); result.hubPid = hub.pid; result.root = root; record();
    fs.writeFileSync(path.join(out, 'hub-startup-combined.log'), hub.log().join('\n'));
    for (const stream of ['stdout', 'stderr']) {
      fs.writeFileSync(path.join(out, 'hub-' + stream + '.log'), '');
      hub.child[stream]?.on('data', data => fs.appendFileSync(path.join(out, 'hub-' + stream + '.log'), data));
    }
    timer = setTimeout(() => { try { audit('within-60s'); } catch (e) { auditError = e; } }, Math.max(1, 45000 - (Date.now() - startedAt)));
    c = await connectFirstPage(hub); audit('early'); await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    if (mutateStartCatch) {
      for (const end = Date.now() + 15000; Date.now() < end;) {
        if ((await c.eval('document.querySelectorAll("#btn-company-meeting").length===1')) === true) break;
        await _waitMs(120);
      }
      result.mutation = await c.eval('(' + installStartCatchMutation.toString() + ')()'); record();
      assert.equal(result.mutation.error, undefined, 'mutation preflight: fixture loader has no error');
      assert.equal(result.mutation?.applied, 1, 'mutation preflight: source compiled exactly once');
      assert.equal(result.mutation.matches, 1, 'mutation preflight: unique start catch guard');
      assert.equal(result.mutation.originalHostAbsent, true); assert.equal(result.mutation.originalNavCount, 1);
      assert.equal(result.mutation.factoryMarkerMatches, 1); assert.equal(result.mutation.mountCalls, 1);
      assert.equal(result.mutation.newNavCount, 1); assert.equal(result.mutation.cacheUsesMutant, true);
      assert.equal(result.mutation.beforeSha256, result.productHashes['renderer/company-meeting-page.js']);
      assert.notEqual(result.mutation.afterSha256, result.mutation.beforeSha256);
      assertFrozen();
      result.mutation.preflightPassed = true; record();
    }
    const q = s => `document.querySelector(${JSON.stringify(s)})`;
    const until = async (expr, label, timeoutMs = 15000) => { for (const end = Date.now() + timeoutMs; Date.now() < end;) { if (auditError) throw auditError; if ((await c.eval(expr)) === true) return; await _waitMs(120); } throw Error('timeout ' + label + ': ' + await c.eval(`${q('[data-m="message"]')}?.textContent`)); };
    const click = async selector => {
      await until(`(()=>{const e=${q(selector)};if(!e||e.disabled)return false;e.scrollIntoView({block:'nearest'});return e.getBoundingClientRect().width>0;})()`, selector);
      const pos = await c.eval(`(()=>{const e=${q(selector)},r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);if(e!==h&&!e.contains(h))throw Error('covered '+${JSON.stringify(selector)});return{x,y};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...pos });
    };
    const message = () => c.eval(`${q('[data-m="message"]')}.textContent`);
    const settled = () => until(`!${q('[data-act="stop"]')}.disabled`, 'UI action releases busy');
    const captureState = () => c.eval(`(()=>{const c=lifecycleCapture,m=m3Fixture.current;return {id:m.id,backendState:m.state,title:document.querySelector('[data-m=session-title]').textContent,running:c.running,paused:c.paused,tracks:c.testTracks.map(t=>t.readyState),fullKey:m.recording.full.key,fullState:c.recorder.full.recorder.state,bytes:m.recording.full.bytes,segments:m.recording.segments.length,starts:m3Fixture.calls.filter(x=>x.channel==='company-assistant:meeting-capture'&&x.args.id===m.id&&x.args.kind==='recording-start').length,resumes:m3Fixture.calls.filter(x=>x.channel==='company-assistant:meeting-control'&&x.args.id===m.id&&['resume','auto'].includes(x.args.op)).length};})()`);
    const liveCopy = async (header, status) => {
      await until(`${q('[data-m="record-label"]')}.textContent===${JSON.stringify(header)}`, 'recording header ' + header);
      const actual = await c.eval(`(()=>{const stage=${q('.meeting-stage')};return {header:${q('[data-m="record-label"]')}.textContent,title:${q('[data-m="viewer-label"]')}.textContent,badge:getComputedStyle(stage,'::after').content,dot:getComputedStyle(stage,'::before').content,view:stage.dataset.view};})()`);
      assert.deepEqual(actual, { header, title: '共享画面 · ' + status, badge: JSON.stringify(status), dot: status === '实时' ? '""' : 'none', view: 'live' });
      (result.liveStateCopy ||= []).push(actual); record();
    };
    const snap = async (label, widths = [1440, 1280]) => {
      await diagnostic('screenshot-' + label);
      for (const width of widths) {
        await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }); await _waitMs(160);
        assert.deepEqual(await c.eval(`['.company-meeting','.meeting-columns','.meeting-evidence-pane','.meeting-understanding','.meeting-flow','.meeting-message'].filter(s=>{const e=document.querySelector(s);return e&&e.clientWidth&&e.scrollWidth>e.clientWidth+2;})`), [], 'no horizontal overflow');
        const name = label + '-' + width + '.png', image = await c.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, name), Buffer.from(image.data, 'base64')); result.screenshots.push(name); record();
      }
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    };
    const start = async () => {
      await c.eval(`${q('[data-m="system"]')}.checked=false;${q('[data-m="mic"]')}.checked=false;`);
      await click('[data-act="start"]'); await until('window.lifecycleCapture?.running && m3Fixture.current.recording.full?.bytes>0', 'native full recording writes bytes');
      await until(`${q('.company-meeting')}.dataset.phase==='live'`, 'live UI');
      await liveCopy('采集中', '实时');
      if (await c.eval(`${q('[data-act-local="dismiss"]')}.offsetWidth>0`)) await click('[data-act-local="dismiss"]');
      const state = await captureState();
      assert.ok(state.bytes > 0, 'start requires a real saved full recording chunk');
      await diagnostic('start-real-full-bytes');
      return state;
    };
    const stopAndOpen = async () => {
      await diagnostic('before-stopAndOpen');
      await click('[data-act="stop"]'); await until(`!lifecycleCapture.running&&m3Fixture.current.state==='ended'&&${q('.company-meeting')}.dataset.phase==='review'`, 'successful stop');
      await diagnostic('after-stop-before-open');
      await until(`!${q('[data-act="open-full"]')}.disabled`, 'full recording open enabled'); await click('[data-act="open-full"]');
      const playable = await c.eval(`(async()=>{const f=m3Fixture.current.recording.full,v=document.createElement('video');v.muted=true;const ready=new Promise((resolve,reject)=>{v.onloadedmetadata=()=>resolve({key:f.key,bytes:f.bytes,width:v.videoWidth,height:v.videoHeight});v.onerror=()=>reject(Error('encoded full cannot decode'));});v.src=f.url;try{return await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('metadata timeout')),5000))]);}finally{v.removeAttribute('src');v.load();}})()`);
      assert.ok(playable.width > 0 && playable.bytes > 0, 'native recorded full has readable video metadata'); return playable;
    };
    const next = async () => { await click('[data-act="new"]'); await until(`${q('.company-meeting')}.dataset.phase==='idle'`, 'new meeting after settled stop'); return start(); };
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`!!${q('#btn-company-meeting')}`, 'nav'); await c.eval('(' + fixtureFunction + ')()'); await c.eval('(' + installLifecycleFixture.toString() + ')()');
    await click('#btn-company-meeting'); await until(`${q('[data-m="source"]')}?.options.length===1`, 'source');
    await assert.rejects(until('undefined', 'undefined must not satisfy wait', 180), /timeout undefined must not satisfy wait/);
    result.waitPreflight = { undefinedRejected: true, comparison: 'strict true' }; record();

    // Run this regression first so a targeted start-catch mutation fails at its own invariant.
    await c.eval(`${q('[data-m="system"]')}.checked=false;${q('[data-m="mic"]')}.checked=false;m3Fixture.failLivePlayWithHeldSave();`);
    await click('[data-act="start"]');
    await until(`m3Fixture.startSave.blocked>0&&lifecycleCapture.released&&lifecycleCapture.testTracks.every(t=>t.readyState==='ended')&&(m3Fixture.calls.some(x=>x.channel==='company-assistant:meeting-control'&&x.args.id===m3Fixture.startSave.id&&x.args.op==='stop')||${q('[data-m="message"]')}.textContent.includes('会议没能开始：预览播放拒绝夹具'))`, 'failed preview settles while its real recording save remains blocked');
    await diagnostic('start-catch-save-blocked');
    const startFailed = await captureState();
    const prematureStops = await c.eval(`m3Fixture.calls.filter(x=>x.channel==='company-assistant:meeting-control'&&x.args.id===m3Fixture.startSave.id&&x.args.op==='stop').length`);
    assert.equal(prematureStops, 0, 'start catch must not stop backend while original recording save is pending');
    assert.equal(startFailed.id, await c.eval('m3Fixture.startSave.id')); assert.equal(startFailed.backendState, 'recording');
    assert.equal(startFailed.running, true); assert.equal(startFailed.paused, true); assert.ok(startFailed.bytes > 0); assert.ok(startFailed.tracks.every(x => x === 'ended'));
    assert.equal(await message(), '会议没能开始：预览播放拒绝夹具。请先点「重试保存」，再点「结束会议」。');
    await settled(); assert.ok(await c.eval(`${q('[data-m="history"]')}.disabled`)); assert.equal(await c.eval(`${q('[data-act="new"]')}.getBoundingClientRect().width`), 0);
    await snap('07-start-failure-save-owned');
    await c.eval(`${q('[data-act="new"]')}.click()`); await until(`${q('[data-m="message"]')}.textContent==='请先点「结束会议」，没存完的内容会留在这一场里。'`, 'start failure cannot move to new meeting'); await settled();
    assert.equal((await captureState()).title, startFailed.title); assert.equal(await c.eval('m3Fixture.sequence'), 1, 'failed start retains its single created meeting');
    await c.eval('m3Fixture.releaseStartSave()'); await click('[data-act="retry-save"]'); await settled();
    await until(`${q('[data-m="message"]')}.textContent==='已补存好，请再点一次「结束会议」。'`, 'failed start save recovers');
    const startRecovered = await stopAndOpen(); assert.equal(startRecovered.key, startFailed.fullKey); assert.ok(startRecovered.bytes >= startFailed.bytes);
    result.startFailure = { blocked: startFailed, backendStopsWhileBlocked: prematureStops, playable: startRecovered }; result.checks.push('created meeting with rejected preview and blocked native save retains ownership without backend stop; release/retry/stop preserves playable full'); record();

    if (startFailureOnly) {
      result.saveOwners = await c.eval('m3Fixture.saveOwners'); assert.ok(result.saveOwners.every(s => s.id === s.expected));
      result.opened = await c.eval('m3Fixture.opened'); assert.equal(result.opened.length, 1);
      audit('final'); result.passed = true;
    } else {
    const normal = await next();
    await click('[data-act="pause"]'); await until(`lifecycleCapture.paused&&lifecycleCapture.recorder.full.recorder.state==='paused'&&m3Fixture.current.state==='paused'`, 'normal pause'); await settled();
    assert.equal(await c.eval(`${q('[data-act="pause"]')}.disabled`), false, 'normal pause can still continue');
    assert.equal(await c.eval(`${q('[data-act="pause"]')}.title`), '', 'normal continue has no failure explanation');
    await liveCopy('已暂停', '已暂停'); await snap('00-normal-paused', [1440]);
    // A successful pause has no visible retry control; exercise the same public retry method directly.
    await c.eval('lifecycleCapture.retry()'); await click('[data-act="pause"]'); await until('!lifecycleCapture.paused&&lifecycleCapture.recorder.full.recorder.state==="recording"', 'normal resume');
    const resumed = await captureState(); assert.equal(resumed.fullKey, normal.fullKey); assert.equal(resumed.starts, normal.starts, 'resume keeps the one video, no new recorder');
    const normalFull = await stopAndOpen(); assert.equal(normalFull.key, normal.fullKey);
    result.normal = { before: normal, resumed, playable: normalFull }; result.checks.push('normal pause/retry/resume/stop retains one full recorder; encoded full opens and decodes'); record();

    const failed = await next();
    await c.eval(`lifecycleCapture.recorder.full.recorder.stop();`); await until('lifecycleCapture.recorder.full.finished', 'native full stop completes');
    await c.eval(`lifecycleCapture.recorder.full.recorder.onerror({error:new Error('原生整场录像错误夹具')});`);
    await until('lifecycleCapture.paused&&!!lifecycleCapture.recorder.error', 'native error pauses capture'); await settled();
    await until(`!${q('[data-act="retry-save"]')}.hidden`, 'retry error visible'); await click('[data-act="retry-save"]'); await settled();
    await until(`${q('[data-m="message"]')}.textContent==='已补存好。录像已中断，请点「结束会议」，再新开一场。'`, 'retry saved old data');
    const beforeRejected = await captureState();
    const inactiveButton = await c.eval(`({disabled:${q('[data-act="pause"]')}.disabled,title:${q('[data-act="pause"]')}.title})`);
    assert.deepEqual(inactiveButton, { disabled: true, title: '这场不能再继续录了，请结束会议' });
    const inactiveDefense = await c.eval(`(()=>{try{lifecycleCapture.assertCanResume();return null;}catch(e){return e.message;}})()`);
    assert.equal(inactiveDefense, '录像已中断，已录的内容都在。请点「结束会议」，再新开一场。');
    const rejected = await captureState(); assert.equal(rejected.resumes, beforeRejected.resumes, 'no backend resume/auto on rejected continue'); assert.equal(rejected.starts, beforeRejected.starts, 'no new recorder after full died'); assert.equal(rejected.fullKey, failed.fullKey); assert.ok(rejected.bytes >= failed.bytes); assert.equal(rejected.paused, true);
    await liveCopy('已中断', '已中断');
    await snap('01-full-inactive-rejected'); const failedFull = await stopAndOpen(); assert.equal(failedFull.key, failed.fullKey);
    result.inactiveFull = { before: failed, beforeRejected, rejected, button: inactiveButton, defense: inactiveDefense, playable: failedFull }; result.checks.push('inactive full + native error cannot resume after retry; disabled UI and assertCanResume defense; no backend resume or extra segment; old full bytes remain and final stop succeeds'); record();

    const held = await next(); await c.eval('m3Fixture.holdStops()'); await click('[data-act="stop"]');
    await until(`lifecycleCapture.released&&lifecycleCapture.testTracks.every(t=>t.readyState==='ended')&&!${q('[data-act="stop"]')}.disabled&&${q('[data-m="message"]')}.textContent==='录像还没收尾，已录的内容都在。请再点一次「结束会议」，先别关 Hub。'`, 'stop deadline releases UI and devices');
    const timedOut = await captureState(); assert.equal(timedOut.running, true, 'old capture remains owned until save settles'); assert.equal(timedOut.id, held.id); assert.ok(timedOut.bytes >= held.bytes);
    assert.ok(await c.eval(`${q('[data-m="history"]')}.disabled`), 'history cannot switch while old capture owns pending data');
    // The new-meeting button is hidden during live capture; also test its defensive handler without changing CSS.
    assert.equal(await c.eval(`${q('[data-act="new"]')}.getBoundingClientRect().width`), 0);
    await c.eval(`${q('[data-act="new"]')}.click()`); await until(`${q('[data-m="message"]')}.textContent==='请先点「结束会议」，没存完的内容会留在这一场里。'`, 'new-meeting guard'); await settled();
    assert.equal((await captureState()).title, timedOut.title, 'old UI meeting retained'); await snap('02-stop-timeout-owned');
    await click('[data-act="retry-save"]'); await settled();
    await until(`${q('[data-m="message"]')}.textContent==='录像还没存完，已录的内容都在。请稍后点「重试保存」，先别关 Hub。'`, 'retry still reports pending native stop'); assert.doesNotMatch(await message(), /已补存好|已重试保存/);
    assert.equal((await captureState()).running, true); await snap('03-retry-still-pending');
    await until('m3Fixture.held.every(h=>h.arrived)', 'held real native stop events arrived'); await c.eval('m3Fixture.releaseStops()');
    await click('[data-act="retry-save"]'); await settled(); await until(`${q('[data-m="message"]')}.textContent==='已补存好，请再点一次「结束会议」。'`, 'late native stop allows saved retry');
    const heldFull = await stopAndOpen(); assert.equal(heldFull.key, held.fullKey); result.heldStop = { before: held, timedOut, playable: heldFull }; await snap('04-late-stop-recovered');
    const fourth = await next(); assert.notEqual(fourth.id, held.id, 'fixture uses unique meeting ids'); await stopAndOpen();
    result.checks.push('held native stop times out without discarding data; busy clears/devices end/old meeting stays; late callbacks permit retry+stop');

    const backendBefore = await next(); await c.eval('m3Fixture.failNextControlStop=true'); await click('[data-act="stop"]');
    await until(`${q('[data-m="message"]')}.textContent.includes('后台拒绝结束夹具')&&!${q('[data-act="stop"]')}.disabled`, 'backend rejection releases busy');
    const backendRejected = await captureState(); assert.equal(backendRejected.id, backendBefore.id); assert.equal(backendRejected.backendState, 'recording', 'backend still ACTIVE after rejecting stop');
    assert.equal(backendRejected.running, true); assert.equal(backendRejected.paused, true); assert.ok(backendRejected.tracks.every(s => s === 'ended'));
    assert.equal(backendRejected.fullKey, backendBefore.fullKey); assert.equal(backendRejected.starts, backendBefore.starts); assert.ok(backendRejected.bytes >= backendBefore.bytes);
    assert.ok(await c.eval(`${q('[data-m="history"]')}.disabled`)); assert.equal(await c.eval(`${q('[data-act="new"]')}.getBoundingClientRect().width`), 0);
    await snap('05-backend-stop-rejected'); const backendRecovered = await stopAndOpen(); assert.equal(backendRecovered.key, backendBefore.fullKey);
    result.backendRejection = { before: backendBefore, rejected: backendRejected, playable: backendRecovered }; result.checks.push('backend stop rejection keeps old active meeting locked after media stops; retry stop succeeds without new full'); record();

    const lostBefore = await next(); await c.eval('m3Fixture.loseNextControlStopAck=true'); const lostPlayable = await stopAndOpen();
    const lostAfter = await captureState(); assert.equal(lostAfter.backendState, 'ended'); assert.equal(lostAfter.running, false); assert.equal(lostPlayable.key, lostBefore.fullKey);
    assert.ok(await c.eval(`m3Fixture.calls.some(x=>x.channel==='company-assistant:meeting-status'&&x.args.id===m3Fixture.current.id)`), 'status queried for ended confirmation');
    result.lostAck = { before: lostBefore, after: lostAfter, playable: lostPlayable }; result.stopFaults = await c.eval('m3Fixture.stopFaults');
    assert.deepEqual(result.stopFaults.map(x => x.state), ['recording', 'ended']); result.checks.push('lost stop reply after backend ended is confirmed by status; UI exits live state and original full still opens');
    const pauseBefore = await next(); await c.eval('m3Fixture.holdFullPause()'); await click('[data-act="pause"]');
    await until(`lifecycleCapture.released&&lifecycleCapture.testTracks.every(t=>t.readyState==='ended')&&!${q('[data-act="stop"]')}.disabled&&${q('[data-m="message"]')}.textContent==='已停止录制，但暂停没能完成，已录的内容都在。请点「结束会议」。'`, 'pause deadline disposes devices and explains ending');
    const pauseTimedOut = await captureState();
    assert.equal(pauseTimedOut.id, pauseBefore.id); assert.equal(pauseTimedOut.backendState, 'recording'); assert.equal(pauseTimedOut.running, true); assert.equal(pauseTimedOut.paused, true);
    assert.equal(pauseTimedOut.fullKey, pauseBefore.fullKey); assert.equal(pauseTimedOut.starts, pauseBefore.starts); assert.ok(pauseTimedOut.bytes >= pauseBefore.bytes);
    assert.equal(await c.eval('m3Fixture.heldPause.arrived && m3Fixture.heldPause.fallback === lifecycleCapture.recorder.full.paused && lifecycleCapture.recorder.full.finished'), true, 'hold only native onpause; real onstop retains and resolves part.paused fallback');
    assert.ok(await c.eval(`${q('[data-m="history"]')}.disabled`)); assert.equal(await c.eval(`${q('[data-act="new"]')}.getBoundingClientRect().width`), 0);
    const pauseButton = await c.eval(`({disabled:${q('[data-act="pause"]')}.disabled,title:${q('[data-act="pause"]')}.title})`);
    assert.deepEqual(pauseButton, { disabled: true, title: '这场不能再继续录了，请结束会议' });
    await liveCopy('已中断', '已中断');
    await snap('06-pause-timeout-ended-tracks');
    const pauseDefense = await c.eval(`(()=>{try{lifecycleCapture.assertCanResume();return null;}catch(e){return e.message;}})()`);
    assert.equal(pauseDefense, '本场已停止录制，请再点一次「结束会议」。这场不能再继续录了。');
    const pauseRejected = await captureState(); assert.equal(pauseRejected.resumes, pauseTimedOut.resumes); assert.equal(pauseRejected.starts, pauseTimedOut.starts); assert.equal(pauseRejected.running, true); assert.equal(pauseRejected.backendState, 'recording');
    const pausePlayable = await stopAndOpen(); assert.equal(pausePlayable.key, pauseBefore.fullKey);
    result.pauseTimeout = { before: pauseBefore, timedOut: pauseTimedOut, rejected: pauseRejected, button: pauseButton, defense: pauseDefense, playable: pausePlayable };
    result.checks.push('held native onpause times out; real onstop fallback releases devices, keeps old ACTIVE meeting, rejects resume and permits final full playback');
    result.saveOwners = await c.eval('m3Fixture.saveOwners'); assert.ok(result.saveOwners.every(s => s.id === s.expected), 'every native save belongs to its original meeting');
    for (const key of [startFailed.fullKey, normal.fullKey, failed.fullKey, held.fullKey, fourth.fullKey, backendBefore.fullKey, lostBefore.fullKey, pauseBefore.fullKey]) assert.equal(new Set(result.saveOwners.filter(s => s.key === key).map(s => s.id)).size, 1);
    result.opened = await c.eval('m3Fixture.opened'); assert.equal(result.opened.length, 8);
    assertFrozen(); audit('final'); result.passed = true;
    }
  } catch (error) {
    result.error = error.stack; process.exitCode = 1;
    if (mutateStartCatch) result.expectedMutationFailure = !!result.mutation?.preflightPassed && error.message.includes('start catch must not stop backend while original recording save is pending');
    try { await diagnostic('failure'); } catch (e) { result.diagnosticError = e.stack; }
    if (c) try { const image = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'failure.png'), Buffer.from(image.data, 'base64')); } catch (_) {}
  } finally {
    clearTimeout(timer);
    if (mutateStartCatch) {
      result.mutationDiskUnchanged = createHash('sha256').update(fs.readFileSync(path.join(repo, 'renderer/company-meeting-page.js'))).digest('hex') === result.productHashes['renderer/company-meeting-page.js'];
      if (!result.mutationDiskUnchanged) { result.passed = false; process.exitCode = 1; }
    }
    if (c) try { result.captureCleanup = await c.eval('window.m3Fixture?.cleanup ? m3Fixture.cleanup() : null'); if (result.captureCleanup) { assert.ok(result.captureCleanup.tracks.every(s => s === 'ended')); assert.ok(result.captureCleanup.running.every(s => !s)); } } catch (e) { result.captureCleanupError = e.stack; result.passed = false; process.exitCode = 1; }
    try { if (hub) { result.teardown = await gracefulQuit(hub); result.postTeardownAudit = windowAudit(); assert.deepEqual(result.postTeardownAudit.processIds, []); assert.deepEqual(result.postTeardownAudit.visible, []); } } catch (e) { result.teardownError = e.stack; result.passed = false; process.exitCode = 1; }
    if (auditError) { result.auditError = auditError.stack; result.passed = false; process.exitCode = 1; }
    if (hub) fs.writeFileSync(path.join(out, 'hub-final-ring.log'), hub.log().join('\n'));
    if (c) await c.close(); record(); console.log(JSON.stringify({ passed: result.passed, out, checks: result.checks.length, screenshots: result.screenshots.length, error: result.error, teardown: result.teardown }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
