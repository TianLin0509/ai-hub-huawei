'use strict';
// Synthetic ended meetings only. No model, account, production Hub, or credentials.
// node tests/e2e-meeting-search-cdp.js [artifact-directory]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { killProcessTree } = require('../core/help-ask/request-lifecycle');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { HubTools } = require('../core/company-assistant/hub-tools');

const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(repo, 'artifacts/20261124-search-e2e-m2'));
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const fingerprint = file => createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex');
const unique = hit => [hit.meetingId, hit.sourceType, hit.seq ?? '', hit.itemId ?? ''].join(':');

function fixtureMeetings() {
  const aAt = Date.parse('2026-11-24T09:00:00+08:00'), bAt = Date.parse('2026-11-23T23:59:59.999+08:00');
  const base = (id, title, startedAt) => ({ id, title, startedAt, endedAt: startedAt + 300000, state: 'ended', audio: [],
    sourceName: 'synthetic search fixture', capturedMs: 300000, transcribedMs: 300000, understoodMs: 300000, cursor: 4,
    revision: 1, autoUnderstand: false, primeRequested: false, finalRequested: false, sessionId: randomUUID(), agent: { state: 'ready' },
    questionSessionId: null, questionPrimeRequested: false, questionAgent: { state: 'none' }, speed: 'normal', questionSpeed: 'fast', events: [], answers: [], summary: '', error: '' });
  const a = base(randomUUID(), '会议搜测 L2容量排查周会', aAt);
  a.summary = '## 决定\n- [D1] OLLA 步长采用0.4，先核对高负载数据 [事件 2]\n## 行动项\n- [A1] 张伟周三给出固定秩四仿真结论 [事件 3]';
  a.events = [
    { seq: 1, kind: 'transcript', at: 30000, end: 35000, track: 'system', text: '高负载吞吐从120下降到110，需验证调度器影响。' },
    { seq: 2, kind: 'transcript', at: 75000, end: 80000, track: 'system', text: 'OLLA 步长0.4已确认，张伟周三给出仿真结论。' },
    { seq: 3, kind: 'mark', at: 90000, text: '重点：固定秩四仿真由张伟负责，周三完成。' },
    { seq: 4, kind: 'transcript', at: 125000, end: 130000, track: 'system', text: '早期上下文'.repeat(30) + '长文定位 OLLA 0.4 的原始片段 😀 ' + '后续上下文'.repeat(40) },
  ];
  a.answers = [{ id: randomUUID(), q: '本次回归什么时候完成？', answer: '答复独有：周三全量回归完成。', state: 'done',
    queuedAt: aAt + 12000, at: aAt + 45000 }];
  const b = base(randomUUID(), '会议搜测 工具组版本评审会', bAt);
  b.summary = '## 决定\n- [D1] 工具版本3.2延后到下周一发布 [事件 1]\n- [A1] 回归412条用例，快捷键修复后再提测 [事件 2]';
  b.events = [{ seq: 1, kind: 'mark', at: 20000, text: '版本3.2延期至下周一。' },
    { seq: 2, kind: 'transcript', at: 60000, end: 65000, track: 'system', text: '快捷键修复由钱坤负责，周五前完成提测。' }];
  b.answers = [{ id: randomUUID(), q: '版本什么时候发布？', answer: '版本答复独有：下周一发布。', state: 'done', queuedAt: bAt + 12000, at: bAt + 45000 }];
  return { a, b };
}
function writeMeeting(root, meeting) {
  const dir = path.join(root, meeting.id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'meeting.json'), JSON.stringify(meeting), 'utf8');
}
function validateHits(result, ids) {
  assert.equal(result.ok, true, result.error); assert.ok(Array.isArray(result.items));
  for (const hit of result.items) {
    assert.ok(ids.has(hit.meetingId)); assert.ok(['title', 'summary', 'mark', 'transcript', 'question'].includes(hit.sourceType));
    assert.ok(Array.from(hit.snippet).length <= 120, '片段不得超过120字');
    for (const range of hit.highlights || []) assert.ok(range.start >= 0 && range.end <= hit.snippet.length && range.end > range.start);
    if (['mark', 'transcript'].includes(hit.sourceType)) assert.ok(Number.isInteger(hit.seq) && hit.seq > 0, '原话/重点可按seq定位');
    if (['summary', 'question'].includes(hit.sourceType)) assert.ok(typeof hit.itemId === 'string' && hit.itemId, '纪要/问答可按itemId定位');
  }
}
function isolatedNodeEnv(extra) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'windir', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'COMSPEC']) if (process.env[key] != null) env[key] = process.env[key];
  return { ...env, ...extra, NO_COLOR: '1' };
}
function mcpClient(entry, toolset) {
  const child = spawn(entry.command, entry.args, { cwd: repo, env: isolatedNodeEnv(entry.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(), record = { toolset, pid: child.pid, stderr: '', protocolErrors: [], exited: false, exitCode: null, calls: [] };
  let nextId = 0, buffer = '';
  const rejectAll = error => { for (const row of pending.values()) { clearTimeout(row.timer); row.reject(error); } pending.clear(); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => {
    buffer += text; if (buffer.length > 1024 * 1024) { rejectAll(Error('MCP输出超过安全上限')); return; }
    let i; while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { record.protocolErrors.push('stdout出现非JSON行'); continue; }
      const row = pending.get(message.id); if (!row) continue;
      clearTimeout(row.timer); pending.delete(message.id); message.error ? row.reject(Error(message.error.message)) : row.resolve(message.result);
    }
  });
  child.stderr.on('data', text => { record.stderr = (record.stderr + text).slice(-8192).replace(/[a-f\d]{64}/gi, '[已隐藏]'); });
  child.on('error', error => rejectAll(error)); child.on('exit', code => { record.exited = true; record.exitCode = code; rejectAll(Error('MCP进程已退出')); });
  child.stdin.on('error', error => rejectAll(error));
  return { child, record,
    rpc(method, params = {}) {
      const id = ++nextId; record.calls.push({ id, method, name: params.name || '' });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('MCP请求超时：' + method)); }, 15000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    async close() {
      if (record.exited) return;
      const exited = new Promise(resolve => child.once('exit', resolve)); child.stdin.end();
      let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 8000); })]); clearTimeout(timer);
      if (!record.exited) { record.forcedOwnedCleanup = true; await killProcessTree(child); await Promise.race([exited, _waitMs(1000)]); }
    },
  };
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const report = { passed: false, evidence: '真实隐藏隔离Hub IPC + 真MCP stdio子进程 + 自建HubTools localhost桥；两场模拟已结束会议；没有模型/账号调用', checks: [], windowAudits: [], mcp: [], startedAt: Date.now(), ownedRootPid: process.pid };
  const reportFile = path.join(out, '20261124-meeting-search-e2e-m2.json');
  const record = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  const check = async (name, run) => { const started = Date.now(); try { const detail = await run(); report.checks.push({ name, ok: true, durationMs: Date.now() - started, ...(detail ? { detail } : {}) }); } catch (error) { report.checks.push({ name, ok: false, durationMs: Date.now() - started, error: error.stack || String(error) }); } record(); };
  let hub, c, writer, tools; const clients = [];
  const productFiles = ['core/company-assistant/meeting-search.js', 'core/company-assistant/hub-tools.js', 'core/company-assistant/mcp.js'];
  const audit = label => {
    const value = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'tests/helpers/reskin-window-audit.ps1'), '-RootProcessId', String(process.pid)], { cwd: repo, windowsHide: true, encoding: 'utf8', timeout: 30000 }));
    report.windowAudits.push({ label, at: Date.now(), ...value }); record(); assert.deepEqual(value.visible, [], '自己启动的进程不得有可见窗口');
  };
  try {
    report.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim();
    report.productHashesBefore = Object.fromEntries(productFiles.map(file => [file, fingerprint(file)]));
    // hub-launcher requires a dedicated OS temp root. Keep it for failure review;
    // all delivered evidence/logs are written under the requested artifact directory.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-search-e2e-m2-')), dataDir = path.join(root, 'data'), work = path.join(root, 'work');
    const assistantDir = path.join(dataDir, 'company-assistant'), workspace = path.join(assistantDir, 'workspace'), meetingsDir = path.join(workspace, 'meetings');
    for (const dir of [dataDir, work, meetingsDir, path.join(root, 'personal'), path.join(root, 'scan'), path.join(root, 'unused-claude'), path.join(root, 'unused-codex')]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(work, '.aiwork-root'), ''); fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
    const welink = path.join(root, 'welink-disabled.js'); fs.writeFileSync(welink, 'process.stdout.write(JSON.stringify({authenticated:false,loggedIn:false}));');
    const seeds = fixtureMeetings(), ids = new Set([seeds.a.id, seeds.b.id]); writeMeeting(meetingsDir, seeds.a); writeMeeting(meetingsDir, seeds.b);
    const badId = randomUUID(), badDir = path.join(meetingsDir, badId); fs.mkdirSync(badDir); fs.writeFileSync(path.join(badDir, 'meeting.json'), '{broken fixture');
    Object.assign(report, { root, dataDir, meetingIds: [...ids], badMeetingId: badId }); fs.writeFileSync(path.join(out, '20261124-search-seeds-m2.json'), JSON.stringify(seeds, null, 2), 'utf8'); record();
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'meeting search e2e m2', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(root, 'missing-cli.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline fixture' }, foreign: { ok: false, error: 'offline fixture' } }),
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_WELINK_CLI: welink,
    } }); report.hubPid = hub.pid; record(); c = await connectFirstPage(hub);
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    for (const end = Date.now() + 30000;;) { if (await c.eval('typeof ipcRenderer !== "undefined"')) break; if (Date.now() >= end) throw Error('真实renderer IPC未就绪'); await _waitMs(100); }
    audit('hidden Hub ready');
    const search = args => c.eval(`ipcRenderer.invoke('company-assistant:meeting-search',${JSON.stringify(args)})`);
    let originalAnd;
    await check('IPC 空格AND、英文大小写和纪要/原话定位', async () => {
      const r = await search({ query: 'olla 0.4', limit: 20 }); validateHits(r, ids); assert.equal(r.total, 3); assert.equal(r.items[0].sourceType, 'summary'); assert.equal(r.items[0].itemId, 'D1');
      assert.equal(r.items[0].seq, 2); assert.equal(r.items[0].time, '01:15'); originalAnd = r;
      assert.equal((await search({ query: 'OLLA 不存在词' })).total, 0); assert.equal((await search({ query: '容量排查 0.4' })).total, 0, 'AND不能跨来源拼出命中'); return r;
    });
    await check('IPC 分页总数稳定、无重复、末页边界', async () => {
      const pages = []; for (let offset = 0; offset < 4; offset++) { const r = await search({ query: 'OLLA 0.4', offset, limit: 1 }); validateHits(r, ids); assert.equal(r.total, 3); pages.push(r); }
      assert.deepEqual(pages.map(r => r.items.length), [1, 1, 1, 0]); assert.deepEqual(pages.map(r => r.hasMore), [true, true, false, false]); assert.equal(new Set(pages.flatMap(r => r.items).map(unique)).size, 3); return pages;
    });
    await check('IPC 上海日期边界、单场过滤、错误参数', async () => {
      const day = await search({ query: '会议搜测', from: '2026-11-24', to: '2026-11-24' }); assert.deepEqual(day.items.map(r => r.meetingId), [seeds.a.id]);
      const single = await search({ query: '会议搜测', meetingId: seeds.b.id }); assert.deepEqual(single.items.map(r => r.meetingId), [seeds.b.id]);
      assert.equal((await search({ query: '会议搜测', from: '2026-11-25', to: '2026-11-24' })).ok, false); assert.equal((await search({ query: '会议搜测', meetingId: '../outside' })).ok, false); return { day, single };
    });
    await check('IPC 实际answers.answer正文可搜，问答wall-clock时间转为会议内定位', async () => {
      const r = await search({ query: '答复独有 周三' }); validateHits(r, ids); assert.equal(r.total, 1); assert.equal(r.items[0].sourceType, 'question');
      assert.equal(r.items[0].itemId, seeds.a.answers[0].id); assert.equal(r.items[0].at, 12000); assert.equal(r.items[0].time, '00:12'); return r;
    });
    await check('IPC 坏会议不拖垮有效数据、长片段不超过120字', async () => {
      const r = await search({ query: 'OLLA 0.4' }); validateHits(r, ids); assert.equal(r.total, 3); assert.ok(!r.items.some(i => i.meetingId === badId));
      const long = await search({ query: '长文定位' }); assert.equal(long.total, 1); validateHits(long, ids); assert.equal(long.items[0].seq, 4); assert.ok(long.items[0].snippet.includes('长文定位')); return { skipped: r.skipped, long };
    });
    const shell = { dir: assistantDir, workspace, changed() {}, sessionBusy: () => false, lastFinal: () => null };
    writer = new MeetingCompanion(shell, { powerSaveBlocker: false, meetingAsr: { status: () => ({ ready: false }), close() {} } });
    await check('真实save后新纪要与转写立即可见，已结束会议立即落盘', async () => {
      assert.equal((await search({ query: '搜索刷新唯一新词' })).total, 0);
      const m = writer.load(seeds.a.id); m.summary += '\n- [A2] 搜索刷新唯一新词：保存即见，周五归档 [事件 5]'; m.events.push({ seq: 5, kind: 'transcript', at: 200000, end: 205000, text: '搜索刷新唯一新词 保存即见。', track: 'system' });
      const started = Date.now(); writer.save(m); assert.ok(fs.readFileSync(path.join(meetingsDir, m.id, 'meeting.json'), 'utf8').includes('搜索刷新唯一新词'), 'ended保存应立即写盘');
      let found; for (const end = Date.now() + 10000; Date.now() < end;) { found = await search({ query: '搜索刷新唯一新词' }); if (found.total === 2) break; await _waitMs(100); }
      assert.equal(found.total, 2); validateHits(found, ids); return { visibleAfterMs: Date.now() - started, result: found };
    });
    const deskId = randomUUID(), phoneId = randomUUID();
    const assistant = { dir: path.join(root, 'owned-mcp-assistant'), meetings: writer, now: Date.now, changed() {}, state: () => ({ sessionId: 'unused-legacy-fixture' }), toolsetFor: id => id === deskId ? 'desk' : id === phoneId ? 'phone' : null };
    tools = new HubTools(assistant, { nodeExecutable: process.execPath }); await tools.start(); report.bridge = { url: tools.bridge.url, endpointFile: tools.endpointFile, identity: 'independently generated local token; not recorded' };
    for (const [toolset, id] of [['desk', deskId], ['phone', phoneId]]) {
      const client = mcpClient(tools.mcpEntry(id, toolset), toolset); clients.push(client); report.mcp.push(client.record);
      await check(`真实MCP ${toolset} 握手、tools/list与meeting_search调用`, async () => {
        const hello = await client.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'isolated-meeting-search-e2e', version: '1' } }); assert.ok(hello.capabilities.tools);
        const list = await client.rpc('tools/list'); const tool = list.tools.find(t => t.name === 'meeting_search'); assert.ok(tool); assert.equal(tool.annotations.readOnlyHint, true);
        const reply = await client.rpc('tools/call', { name: 'meeting_search', arguments: { query: 'olla 0.4', from: '2026-11-24', to: '2026-11-24', limit: 20 } }); assert.equal(reply.isError, false, JSON.stringify(reply));
        const parsed = JSON.parse(reply.content.find(c => c.type === 'text').text); validateHits(parsed, ids); assert.equal(parsed.total, 3);
        const same = await search({ query: 'olla 0.4', from: '2026-11-24', to: '2026-11-24', limit: 20 }); assert.deepEqual(parsed.items, same.items, 'MCP桥与IPC共用搜索结果');
        assert.match(parsed.note, /meetingId.*seq/); assert.equal(client.record.protocolErrors.length, 0); return { listed: list.tools.map(t => t.name), search: parsed };
      });
    }
    audit('Hub and both real MCP children');
    assert.ok(originalAnd, 'AND基准应成功');
    report.passed = report.checks.every(c => c.ok);
  } catch (error) { report.error = error.stack || String(error); report.logTail = error.logTail || (hub?.log ? hub.log().slice(-30).join('\n') : ''); }
  finally {
    for (const client of clients) { try { await client.close(); } catch (error) { report.cleanupError = error.message; } }
    try { tools?.close(); writer?.close(); c?.close(); } catch (error) { report.cleanupError = error.message; }
    if (hub) try { await gracefulQuit(hub); report.ownedHubClosed = true; } catch (error) { report.cleanupError = error.message; }
    report.productHashesAfter = Object.fromEntries(productFiles.map(file => [file, fingerprint(file)])); report.codeChangedDuringRun = JSON.stringify(report.productHashesBefore) !== JSON.stringify(report.productHashesAfter);
    report.endedAt = Date.now(); if (report.error || report.cleanupError) report.passed = false; record();
  }
  if (!report.passed) process.exitCode = 1;
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failed: report.checks.filter(c => !c.ok).map(c => c.name), error: report.error?.split('\n')[0], reportFile }));
})();
