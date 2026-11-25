'use strict';
// 理解会话不死 · 隔离 Hub 端到端（2026-11-24）：真实主进程里的会议伴侣、真实定时轮询和界面 IPC；
// 只把 CodeAgent 换成主进程里的假会话（秒回带回执的纪要条目），并让关闭会话一直失败（「CodeAgent 任务会话尚未关闭」）。
// 验收：满 3 轮换会话后纪要继续出新版本，旧会话进待关闭清单按退避重试。用法：node tests/e2e-meeting-lane-recovery-cdp.js [输出目录]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2] || 'artifacts/meeting-lane-recovery-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const getJson = url => new Promise((resolve, reject) => http.get(url, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject));

async function mainInspector(port) {
  let list;
  for (let i = 0; i < 60; i++) { try { list = await getJson(`http://127.0.0.1:${port}/json/list`); if (list?.length) break; } catch {} await _waitMs(500); }
  const ws = new WebSocket(list[0].webSocketDebuggerUrl); await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0; const pending = new Map();
  ws.on('message', d => { const msg = JSON.parse(d.toString()); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  const evaluate = expression => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, msg => {
      if (msg.error) return reject(new Error(msg.error.message));
      if (msg.result.exceptionDetails) return reject(new Error(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text));
      resolve(msg.result.result.value);
    });
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => ws.close() };
}

// 主进程里执行：抓到会议伴侣实例，把 CodeAgent 换成假会话，关闭一律失败。
const installFake = repoDir => `(() => {
  const M = process.mainModule.require(${JSON.stringify(path.join(repoDir, 'core/company-assistant/meeting.js'))}).MeetingCompanion;
  if (!M.prototype.__m5Patched) { const orig = M.prototype.status; M.prototype.status = function (...a) { globalThis.__m5 = this; return orig.apply(this, a); }; M.prototype.__m5Patched = true; }
  return 'patched';
})()`;
const wireFake = `(() => {
  const inst = globalThis.__m5; if (!inst) throw new Error('会议伴侣实例还没建');
  const sessions = new Map(), finals = new Map(), log = globalThis.__m5log = { closes: [], creates: [], prompts: 0 };
  inst.tools = { start: async () => {}, bind() {}, close() {}, entry() { return null; } };
  Object.assign(inst.deps, {
    getSession: id => sessions.get(id), getSessionMetadata: () => null, resumeSession: async () => {},
    createSession: async (_k, opts) => { log.creates.push({ id: opts.id, at: Date.now() }); await new Promise(r => setTimeout(r, 300)); sessions.set(opts.id, { id: opts.id }); return { ok: true }; },
    closeSession: async id => { log.closes.push({ id, at: Date.now() }); throw new Error('CodeAgent 任务会话尚未关闭'); },
    sendPrompt: async (sid, prompt) => {
      log.prompts++; const token = /\\[会议回执:([0-9a-f-]+)\\]/.exec(prompt)?.[1], n = log.prompts;
      setTimeout(() => finals.set(sid, { id: 'f' + n, text: (/准备/.test(prompt) && !/纪要/.test(prompt) ? '已就绪' : '- [D' + n + '] 第 ' + n + ' 次理解的决定 [事件 1]\\n本轮小结：第 ' + n + ' 轮') + '\\n[会议回执:' + token + ']' }), 400);
      return { ok: true };
    } });
  inst.a.lastFinal = sid => finals.get(sid) || null; inst.a.sessionBusy = () => false; inst.a.sessionGone = () => '';
  const m = inst.create({ title: '理解不死端到端' });
  m.autoUnderstand = false; inst.save(m); globalThis.__m5id = m.id; return m.id;
})()`;
const addSpeech = n => `(() => { const inst = globalThis.__m5, m = inst.load(globalThis.__m5id); inst.event(m, 'transcript', { at: ${n} * 10000, end: ${n} * 10000 + 2000, track: 'system', text: '第 ${n} 段发言' }); inst.save(m); return m.events.length; })()`;

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-lane-e2e-')), port = await freePort(), inspect = await freePort();
  const result = { startedAt: new Date().toISOString(), timeline: [] }; let hub, page, main;
  try {
    hub = await launchIsolatedHub({ dataDir, port, label: 'm5-lane', extraEnv: { CLAUDE_HUB_COMPANY_ASSISTANT: '1' }, extraArgs: [`--inspect=${inspect}`] });
    result.hubPid = hub.pid;
    page = await connectFirstPage(hub);
    main = await mainInspector(inspect);
    await main.evaluate(installFake(repo));
    const ipc = (ch, args) => page.eval(`(async () => await (globalThis.ipcRenderer || require("electron").ipcRenderer).invoke(${JSON.stringify(ch)}, ${JSON.stringify(args)}))()`);
    await ipc('company-assistant:meeting-status', {});
    const id = await main.evaluate(wireFake);
    const snap = async label => {
      const s = await ipc('company-assistant:meeting-status', { id }), m = s.meeting;
      const row = { label, t: Date.now(), revision: m.revision, sessionId: m.sessionId.slice(0, 8), turns: m.understandingTurns, agent: m.agent?.state, job: m.job ? `${m.job.kind}/${m.job.state}` : null,
        error: m.error || '', pendingClose: s.pendingClose || null, understandingRetry: s.understandingRetry || null, lastRotation: m.lastRotation || null };
      result.timeline.push(row); return { s, m };
    };
    const waitRevision = async (rev, ms = 30000) => { const until = Date.now() + ms; for (;;) { const { m } = await snap('poll'); if (m.revision >= rev) return m; if (m.job?.state === 'error') throw new Error('理解线停在 error：' + m.error); if (Date.now() > until) throw new Error('等第 ' + rev + ' 版纪要超时'); await _waitMs(500); } };
    // 预热 + 第 1..6 轮：第 4 轮前满 3 轮触发换会话，关闭失败。
    for (let n = 1; n <= 6; n++) {
      await main.evaluate(addSpeech(n));
      await ipc('company-assistant:meeting-control', { id, op: 'understand' });
      await waitRevision(n);
      await snap('rev' + n);
    }
    const final = (await snap('final')).s;
    const log = await main.evaluate('globalThis.__m5log');
    result.log = log; result.final = { revision: final.meeting.revision, summaryHead: final.meeting.summary.slice(0, 400), pendingClose: final.pendingClose, rawPendingClose: final.meeting.pendingClose, lastRotation: final.meeting.lastRotation };
    const sessionsUsed = new Set(result.timeline.map(r => r.sessionId));
    assert.equal(final.meeting.revision, 6, '换会话后纪要继续出到第 6 版');
    assert.ok(sessionsUsed.size >= 2, '确实换过会话');
    assert.ok(log.closes.length >= 1, '尝试关过旧会话');
    assert.ok(final.meeting.pendingClose?.length >= 1 && final.meeting.pendingClose[0].count >= 1, '关不掉的旧会话记进待关闭清单');
    assert.ok(final.pendingClose?.count >= 1, 'status 带待关闭摘要');
    assert.ok(!result.timeline.some(r => r.job && r.job.endsWith('/error')), '全程理解线没有停在 error');
    try { const shot = await page.send?.('Page.captureScreenshot', { format: 'png' }); if (shot?.data) fs.writeFileSync(path.join(out, '20261124-m5-lane-recovery.png'), Buffer.from(shot.data, 'base64')); } catch {}
    result.ok = true;
  } catch (e) { result.ok = false; result.error = e.stack || e.message; }
  finally {
    try { main?.close(); } catch {}
    try { await page?.close(); } catch {}
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.quitError = e.message; } }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    fs.writeFileSync(path.join(out, '20261124-m5-lane-recovery-result.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: result.ok, error: result.error, revisions: result.final?.revision, closes: result.log?.closes?.length, sessions: [...new Set(result.timeline.map(r => r.sessionId))], pendingClose: result.final?.pendingClose, lastRotation: result.final?.lastRotation }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  }
})();
