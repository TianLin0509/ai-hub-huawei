'use strict';
// Isolated main IPC + real MeetingCompanion/ask-aside + real renderer mouse/keyboard.
// Fixture runs and opt-in real Claude runs are reported as separate evidence.
// node scripts/bench-meeting-ttft.js --model fixture --label before --out <dir>
// CLAUDE_CONFIG_DIR must already be set by the operator for --real-claude.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { randomUUID } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('../tests/helpers/hub-launcher');
const { connectFirstPage } = require('../tests/helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const QUESTIONS = ['这场会最后确定了哪些结论？', '分别由谁负责，期限是什么？', '会上提到的关键数字是多少，分别表示什么？', '现在最后讨论到什么，哪些还没定？', '还有哪些待办，需要下一步做什么？'];

function options(argv, env = process.env) {
  const args = {}, names = new Set(['profile', 'model', 'repeats', 'fixture', 'label', 'out', 'baseline-ref', 'material', 'speeds', 'modes']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--real-claude') { args.realClaude = true; continue; }
    const name = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !names.has(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('参数必须为 --名称 值；真实模式使用 --real-claude');
    args[name] = argv[++i];
  }
  if (args.profile) throw Error('不接收账号配置参数；真实模式仅使用运行者环境中的 CLAUDE_CONFIG_DIR');
  if (!args.model) args.model = args.realClaude ? 'claude-haiku-4-5' : 'fixture';
  if (args.realClaude) {
    if (args.fixture || args['baseline-ref']) throw Error('真实 Claude 新UI测量不能混用 fixture 或旧基线；0186fd5c 是假CLI旧UI，不可混算');
    if (!require('../core/model-id').isSafeModelId(args.model) || args.model === 'fixture') throw Error('真实 Claude 模型名称无效');
    const cfg = String(env.CLAUDE_CONFIG_DIR || '').trim();
    if (!cfg || !path.isAbsolute(cfg)) throw Error('真实 Claude 模式需要运行者预先设置绝对路径 CLAUDE_CONFIG_DIR；不会查找或复制账号凭据');
    args.claudeConfigDir = cfg;
    if ((args.speeds && args.speeds !== 'fast') || (args.modes && args.modes !== 'fresh')) throw Error('真实 Claude 测量固定 fast / fresh（关闭思考）');
    args.speeds = 'fast'; args.modes = 'fresh';
  }
  const repeats = Number(args.repeats || 2);
  if (!Number.isInteger(repeats) || repeats < (args.fixture === '1' ? 1 : 2)) throw Error('真实测量每题至少 2 次；只有夹具自检允许 1 次');
  return args;
}

// Observe product callbacks only. The real branch never replaces command, spawn,
// input, thinking settings or answer generation; runAsk owns those contracts.
function measuredRunner(runAsk, seed, send) {
  return opts => {
    if (seed.realClaude && (opts.config?.flavor !== 'claude' || opts.model !== seed.model || !opts.fresh || !opts.stream || !opts.thinkingOff || opts.effort !== 'low')) {
      throw Error('真实测量要求产品实际选择 claude|model、fast/fresh/stream、low并关闭思考；已拒绝错误接线');
    }
    let seenFirst = false;
    return runAsk({ ...opts, ...(!seed.realClaude ? { config: { ...opts.config, command: seed.fakeCommand },
      // Old snapshot modules have no onProcess callback. Preserve fixture timing.
      spawnFn: (command, argv, options) => { const child = (opts.spawnFn || require('node:child_process').spawn)(command, argv, { ...options, windowsHide: true }); send('bench-meeting:timing', { startedAt: Date.now() }); return child; },
    } : {}),
      onProcess: info => { if (seed.realClaude) send('bench-meeting:timing', { startedAt: Date.now(), execution: {
        engine: opts.config.flavor, model: opts.model, fresh: !!opts.fresh, stream: !!opts.stream,
        thinkingOff: !!opts.thinkingOff, effort: opts.effort || '',
        argvModel: info.args?.[info.args.indexOf('--model') + 1] || '',
        outputFormat: info.args?.[info.args.indexOf('--output-format') + 1] || '',
      } }); opts.onProcess?.(info); },
      onChunk: text => { if (text && !seenFirst) { seenFirst = true; send('bench-meeting:timing', { firstTokenAt: Date.now() }); } opts.onChunk?.(text); },
    });
  };
}

function launchOptions(args, { data, cfg, work, root }, env = process.env) {
  const cleared = Object.fromEntries(Object.keys(env).filter(k => /API_KEY|AUTH_TOKEN|OAUTH_TOKEN|CLAUDECODE/i.test(k)).map(k => [k, '']));
  return { dataDir: data, windowMode: 'hidden', ...(args.realClaude ? { allowExternalState: ['CLAUDE_CONFIG_DIR'] } : {}), extraEnv: {
    ...cleared, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: path.join(root, 'unused-codex'), AI_HUB_WORKSPACE_ROOT: work,
    CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
  } };
}

// Stable selectors read from m1's assistant-tab UI. Never count phase labels,
// question text, backstage controls, or historical answers as response text.
function detectUi(doc) {
  if (doc.querySelector('[data-aside-tab="chat"]') && doc.querySelector('[data-aside-panel="chat"] [data-m="chat-list"]')) {
    return { kind: 'assistant-tab-stream', tab: '[data-aside-tab="chat"]', card: '[data-m="chat-list"] > [data-answer]',
      body: '.meeting-chat-a > .meeting-chat-partial, .meeting-chat-a > .meeting-answer-body' };
  }
  return { kind: doc.querySelector('[data-m="timeline"]') ? 'legacy-timeline' : 'unknown', card: '[data-answer]', body: '.meeting-answer-body' };
}
function requireUi(ui, realClaude) {
  if (realClaude && ui.kind !== 'assistant-tab-stream') throw Error('缺少新版助手对话tab/流式正文标记；当前为' + ui.kind + '，未发送任何真实模型问题，请合入新界面后重跑');
  if (ui.kind === 'unknown') throw Error('无法识别会议问答界面，未发送问题');
  return ui;
}
function sampleDomTiming(timing, doc, ui, now) {
  if (!timing.questionId) return;
  const card = doc.querySelector(ui.card + '[data-answer="' + timing.questionId + '"]');
  if (!card) return;
  const body = card.querySelector(ui.body);
  if (body && !body.hidden && body.textContent.trim() && !timing.domFirstAt) {
    timing.domFirstAt = now; timing.domFirstSource = body.classList.contains('meeting-chat-partial') ? 'streaming-partial-body' : 'completed-answer-body';
  }
  if (['done', 'error'].includes(card.dataset.questionState) && !timing.domDoneAt) timing.domDoneAt = now;
}
function recordSendClick(event, timing, now) {
  const button = event.target?.closest?.('[data-act="ask"]');
  if (!button || button.disabled || event.isTrusted === false) return;
  if (!Number.isFinite(timing.clickedAt)) timing.clickedAt = now;
}
function measurementOrigin(timing, realClaude) {
  if (realClaude && !Number.isFinite(timing.clickedAt)) throw Error('真实测量缺少实际发送点击clickedAt，不能用IPC提交时刻替代');
  return realClaude ? timing.clickedAt : timing.submittedAt;
}
function stats(rows) {
  const out = {};
  for (const row of rows) {
    const key = `${row.material}/${row.speed}/${row.mode}/${row.questionIndex}`;
    (out[key] ||= []).push(row);
  }
  const metric = (items, name) => { const values = items.map(r => r[name]).filter(Number.isFinite).sort((a, b) => a - b); const n = values.length; return n ? { n, median: n % 2 ? values[n >> 1] : (values[n / 2 - 1] + values[n / 2]) / 2, max: values[n - 1] } : { n: 0 }; };
  return Object.fromEntries(Object.entries(out).map(([k, rows]) => [k, { ttftMs: metric(rows, 'ttftMs'), totalMs: metric(rows, 'totalMs'), failures: rows.filter(r => r.error).length }]));
}

// Called inside the owned Electron main process. Only session lifecycle is seeded;
// answering, IPC dispatch, persistence and CLI execution use the product modules.
function installBenchMain(repo, seed) {
  // Snapshot only the baseline modules in this owned process, before bootstrapping Hub.
  const { app, ipcMain, BrowserWindow } = require('electron');
  const send = (channel, value) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, value); };
  const session = { id: seed.sessionId, ccSessionId: seed.nativeId, kind: 'claude', cwd: seed.work, agentRuntime: 'pty', currentModel: { id: seed.model } };
  const env = { ...process.env, CLAUDE_CONFIG_DIR: seed.cfg };
  for (const k of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|CLAUDECODE/i.test(k)) delete env[k];
  const { createAskAsideService, runAsk } = require(path.join(repo, 'main/ask-aside/service'));
  const measuredRun = require(path.join(repo, 'scripts/bench-meeting-ttft')).measuredRunner(runAsk, seed, send);
  const aside = createAskAsideService({ getHubDataDir: () => seed.data,
    sessionManager: { getSession: id => id === session.id ? session : null, sessions: new Map([[session.id, { pty: {}, askAsideEnv: env }]]) },
    getSessionMetadata: id => id === session.id ? session : null, sendToRenderer: send, run: measuredRun, hasHistory: () => true });
  const shell = { dir: path.join(seed.data, 'bench-assistant'), workspace: path.join(seed.data, 'bench-workspace'), changed() {}, sessionBusy: () => false, lastFinal: () => null };
  const { MeetingCompanion } = require(path.join(repo, 'core/company-assistant/meeting'));
  const meeting = new MeetingCompanion(shell, { getMeetingAskAside: () => aside, getSession: id => id === session.id ? session : null,
    getSessionMetadata: id => id === session.id ? session : null, meetingModels: () => [], meetingTerminals: () => ({ claude: [{ id: seed.model, label: seed.model }] }),
    meetingAsr: { status: () => ({ ready: true }), close() {} }, sendToRenderer: send });
  meeting.tools.start = async () => {}; meeting.tools.close = () => {};
  let benchMode;
  const answer = meeting.answer.bind(meeting);
  meeting.answer = (m, q) => { q.mode = benchMode; return answer(m, q); };
  const handlers = require(path.join(repo, 'core/company-assistant/meeting-ipc')).createMeetingHandlers({ meetings: meeting });
  for (const [op, handler] of Object.entries(handlers)) {
    const channel = 'company-assistant:' + op; ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, req = {}) => { try { return await handler(req); } catch (e) { return { ok: false, error: e.message }; } });
  }
  ipcMain.handle('bench-meeting:seed', (_event, value) => {
    benchMode = value.mode;
    for (const priorId of meeting.ids()) { const prior = meeting.load(priorId); if (prior.state === 'paused') { prior.state = 'ended'; prior.finalRequested = false; meeting.save(prior); } }
    const id = require('node:crypto').randomUUID();
    const m = { id, title: value.title, state: 'paused', audio: [], startedAt: Date.now(), capturedMs: value.events.at(-1)?.end || 0,
      transcribedMs: 0, understoodMs: 0, cursor: value.events.length, revision: 1, events: value.events, answers: [], summary: value.summary,
      autoUnderstand: false, primeRequested: false, sessionId: session.id, agent: { state: 'ready' }, speed: value.speed, engine: `claude|${seed.model}`,
      questionSpeed: value.speed, understandingProtocol: 2, questionProtocol: 2, minutesProtocol: 2 };
    meeting.save(m); meeting.start(); return id;
  });
  app.on('before-quit', () => { meeting.close(); void aside.dispose(); });
}

async function main(args) {
  // Fail before making files or launching a process if the operator omitted it.
  if (args.realClaude && !args.claudeConfigDir) throw Error('真实 Claude 模式需要 CLAUDE_CONFIG_DIR');
  const repo = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-ttft-m2-'));
  const data = path.join(root, 'data'), cfg = args.realClaude ? args.claudeConfigDir : path.join(root, 'claude'), work = path.join(root, 'work');
  for (const d of [data, work]) fs.mkdirSync(d, { recursive: true });
  if (!args.realClaude) {
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ model: args.model, hooks: {}, disableAllHooks: true, enabledPlugins: {} }));
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [work]: { hasTrustDialogAccepted: true } } }));
  }
  const output = path.resolve(args.out || `artifacts/20261124-meeting-ttft-${args.label || 'run'}-m2`); fs.mkdirSync(output, { recursive: true });
  const report = { label: args.label, repo, sourceSha: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim(),
    model: args.model, engine: `claude|${args.model}`, realModelRequested: !!args.realClaude,
    evidence: args.realClaude ? '真模型新UI测量入口：真实Claude Code→产品ask-aside→会议卡片DOM；fast/fresh关闭思考。仅预置会议理解生命周期与材料，没有模拟答案；是否实际调用见realModelInvoked。测量脚本只取账号目录环境路径，不复制/读取/打印凭据文件。' : '真实隐藏隔离 Hub、主进程真实 IPC、产品问答链路、真实假 CLI 进程；会议理解生命周期预置，模拟转写重放；未调用真实模型，未访问登录凭据',
    comparison: '0186fd5c旧基线为假CLI旧UI，不能与真模型新UI样本混算或计算加速比', root, rows: [], startedAt: Date.now() };
  report.productHashes = Object.fromEntries(['core/company-assistant/meeting.js', 'main/ask-aside/service.js', 'core/ask-aside-codex.js'].map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]));
  const record = () => fs.writeFileSync(path.join(output, '20261124-meeting-ttft-m2.json'), JSON.stringify({ ...report,
    realModelInvoked: !!args.realClaude && report.rows.some(r => r.execution?.engine === 'claude'), summary: stats(report.rows) }, null, 2), 'utf8');
  const nativeId = randomUUID(); let hub, c, auditTimer;
  try {
    const seed = { sessionId: randomUUID(), nativeId, data, work, cfg, model: args.model, realClaude: !!args.realClaude };
    if (!args.realClaude) {
      const fakeCommand = path.join(root, '20261124-fake-claude-m2.cmd'), fakeScript = path.join(root, '20261124-fake-claude-m2.js');
      fs.copyFileSync(path.join(repo, 'tests/fixtures/meeting-ttft-cli.js'), fakeScript);
      fs.writeFileSync(fakeCommand, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`); seed.fakeCommand = fakeCommand;
    }
    const shim = path.join(root, '20261124-meeting-bench-entry-m2.js');
    let snapshot = '';
    if (args['baseline-ref']) {
      const ref = args['baseline-ref']; if (!/^[\w./-]+$/.test(ref)) throw Error('基线引用无效');
      const files = ['core/company-assistant/meeting.js', 'main/ask-aside/service.js', 'core/ask-aside-codex.js'];
      const sources = files.map(file => ({ file: path.join(repo, file), source: require('node:child_process').execFileSync('git', ['show', `${ref}:${file}`], { cwd: repo, windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }) }));
      snapshot = `for(const item of ${JSON.stringify(sources)}){const Module=require('node:module');const m=new Module(item.file,module);m.filename=item.file;m.paths=Module._nodeModulePaths(require('node:path').dirname(item.file));require.cache[item.file]=m;m._compile(item.source,item.file);m.loaded=true;}\n`;
      report.baselineRef = ref;
      report.baselineHashes = Object.fromEntries(sources.map(s => [path.relative(repo, s.file), require('node:crypto').createHash('sha256').update(s.source).digest('hex')]));
    }
    fs.writeFileSync(shim, `'use strict';\nconst path=require('node:path');\n${snapshot}require(${JSON.stringify(path.join(repo, 'main-bootstrap.js'))});\nrequire('electron').app.whenReady().then(()=>setTimeout(()=>(${installBenchMain.toString()})(${JSON.stringify(repo)},${JSON.stringify(seed)}),1500));\n`);
    hub = await launchIsolatedHub({ ...launchOptions(args, { data, cfg, work, root }), port: await freePort(), entryPath: shim, cwd: repo, label: 'meeting TTFT m2' });
    const audit = () => { try {
      const value = JSON.parse(require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'tests/helpers/reskin-window-audit.ps1'), '-RootProcessId', String(hub.pid)], { windowsHide: true, encoding: 'utf8', timeout: 30000 }));
      (report.windowAudits ||= []).push(value); record();
      if (value.visible?.length) { report.windowError = '隔离测试发现可见窗口，已停止自己启动的实例'; void gracefulQuit(hub); }
    } catch (error) { report.auditError = error.message; record(); void gracefulQuit(hub); } };
    audit(); auditTimer = setTimeout(audit, 45000);
    c = await connectFirstPage(hub);
    const until = async (expr, ms = 180000) => { for (const end = Date.now() + ms; Date.now() < end;) { if(report.auditError||report.windowError)throw Error(report.windowError||'窗口审计失败：'+report.auditError);try { const value = await c.eval(expr); if (value) return value; } catch {} await sleep(250); } throw Error('等待超时：' + expr.slice(0, 100)); };
    await until('!!document.querySelector("#btn-company-meeting")'); await sleep(1800);
    const click = async selector => { const p = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('按钮不可用');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 }); };
    await click('#btn-company-meeting');
    await until('!!document.querySelector("[data-m=timeline]")', 15000);
    report.actualUi = await c.eval(`(${detectUi.toString()})(document)`); record(); requireUi(report.actualUi, args.realClaude);
    if (report.actualUi.tab) await click(report.actualUi.tab);
    await c.eval(`(()=>{window.__ttft={};const ui=${JSON.stringify(report.actualUi)},sample=${sampleDomTiming.toString()},captureClick=${recordSendClick.toString()};document.addEventListener('click',event=>captureClick(event,window.__ttft,Date.now()),true);window.__ttftSample=()=>sample(window.__ttft,document,ui,Date.now());const ipc=require('electron').ipcRenderer;const original=ipc.invoke.bind(ipc);ipc.invoke=async(ch,r)=>{if(ch==='company-assistant:meeting-control'&&r.op==='ask'){__ttft.submittedAt=Date.now();const reply=await original(ch,r);__ttft.deliveredAt=Date.now();__ttft.questionId=reply.meeting?.answers?.at(-1)?.id;__ttftSample();return reply;}return original(ch,r);};ipc.on('company-assistant:meeting-question',(_e,r)=>{if(r.questionId===__ttft.questionId&&r.partial&&!__ttft.eventFirstAt)__ttft.eventFirstAt=Date.now();});new MutationObserver(__ttftSample).observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-question-state','data-phase','hidden']});})()`);
    await c.eval(`require('electron').ipcRenderer.on('bench-meeting:timing',(_e,r)=>{if(r.startedAt)__ttft.processStartedAt=r.startedAt;if(r.execution)__ttft.execution=r.execution;if(r.firstTokenAt&&!__ttft.processFirstTokenAt)__ttft.processFirstTokenAt=r.firstTokenAt;})`);
    const materials = (args.material || 'D:/AIWork/20261107-aihubh-meeting-asr-claude/eval').split(',');
    for (const material of materials) {
      const spec = JSON.parse(fs.readFileSync(path.join(material, 'spec.json'), 'utf8'));
      const events = fs.readFileSync(path.join(material, 'meeting.jsonl'), 'utf8').trim().split(/\r?\n/).map((l, i) => { const v = JSON.parse(l); return { seq: i + 1, kind: 'transcript', at: v.t * 1000, end: v.t * 1000 + 4000, who: v.who, text: v.text }; });
      const summary = (spec.flow || []).join('\n');
      for (const speed of (args.speeds || 'fast,normal,deep').split(',')) for (const requestedMode of (args.modes || 'fork').split(',')) {
        const mode = requestedMode === 'auto' ? speed === 'fast' ? 'fresh' : 'fork' : requestedMode;
        const id = await c.eval(`ipcRenderer.invoke('bench-meeting:seed',${JSON.stringify({ title: spec.title, events, summary, speed, mode })})`);
        // Select through the ordinary meeting list; this keeps the real page's polling and rendering.
        await c.eval(`document.querySelector('#btn-company-meeting').click()`);
        await until(`!!document.querySelector('[data-m="history"] option[value="${id}"]')`, 15000);
        await c.eval(`(()=>{const e=document.querySelector('[data-m="history"]');e.value=${JSON.stringify(id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        if (report.actualUi.tab) await click(report.actualUi.tab);
        for (let qi = 0; qi < QUESTIONS.length; qi++) for (let repeat = 0; repeat < Number(args.repeats || 2); repeat++) {
          const row = { material, speed, mode, questionIndex: qi, repeat, question: QUESTIONS[qi] }; report.rows.push(row); record();
          try {
            await until('!!document.querySelector("[data-m=question]")', 15000);
            await c.eval('window.__ttft={}'); await click('[data-m=question]');
            await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
            await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
            await c.send('Input.insertText', { text: QUESTIONS[qi] });
            await click('[data-act=ask]');
            const result = await until(`(async()=>{const r=await ipcRenderer.invoke('company-assistant:meeting-status',{id:${JSON.stringify(id)}});const q=r.meeting?.answers?.at(-1);if(!__ttft.questionId||q?.id!==__ttft.questionId)return false;const text=q.live?.partial||q.answer;if(text&&!__ttft.statusFirstAt)__ttft.statusFirstAt=Date.now();if(['done','error'].includes(q.state))return{q,t:__ttft,completedAt:Date.now()};return false;})()`);
            if (!result.q.error) await until('window.__ttft.domFirstAt&&window.__ttft.domDoneAt', 10000);
            const timing = await c.eval('window.__ttft');
            const origin = measurementOrigin(timing, args.realClaude);
            const mainFirst = result.q.firstTokenAt || result.q.live?.firstTokenAt || timing.processFirstTokenAt;
            const first = mainFirst || (!args.realClaude ? result.t.statusFirstAt : null);
            Object.assign(row, timing, { startedAt: result.q.startedAt || timing.processStartedAt, firstTokenAt: first, completedAt: result.completedAt,
              mainFirstTokenAt: mainFirst || null, mainCompletedAt: result.q.at || null,
              timingOrigin: args.realClaude ? 'actual-send-click' : 'ipc-submission',
              clickToIpcMs: Number.isFinite(timing.clickedAt) ? timing.submittedAt - timing.clickedAt : null,
              ttftMs: timing.domFirstAt ? timing.domFirstAt - origin : null,
              backendTtftMs: first ? first - origin : null, totalMs: (timing.domDoneAt || result.completedAt) - origin,
              backendTotalMs: result.completedAt - origin,
              eventDelayMs: timing.eventFirstAt && first ? timing.eventFirstAt - first : null, answer: result.q.answer, error: result.q.error || '' });
            if (args.realClaude && !row.error && (!row.mainFirstTokenAt || !row.domFirstAt || !row.domDoneAt)) row.error = '真实测量缺少主进程首字/卡片DOM首字/完成测点';
          } catch (e) { try { Object.assign(row, await c.eval('window.__ttft')); } catch {} row.error = e.message; } record();
          if (args.realClaude && row.error) throw Error('真实测量已停止，失败样本原样保留：' + row.error);
        }
      }
    }
    report.passed = report.rows.length > 0 && report.rows.every(row => !row.error);
    if (!report.passed) throw Error('测量存在失败样本，详见原始JSON；未用伪答案或轮询时间补齐真实首字');
  } catch (error) { report.passed = false; report.error = error.message; throw error; }
  finally { clearTimeout(auditTimer); report.endedAt = Date.now(); record(); c?.close(); if (hub) await gracefulQuit(hub); }
}
if (require.main === module) { let args; try { args = options(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; } if (args) main(args).catch(e => { console.error(e.stack); process.exitCode = 1; }); }
module.exports = { stats, options, QUESTIONS, installBenchMain, measuredRunner, launchOptions, detectUi, requireUi, sampleDomTiming, recordSendClick, measurementOrigin };
