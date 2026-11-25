'use strict';
// 会议页右栏「助手对话」+ 渲染端鲁棒性（2026-11-24 用户截图：整页被顶走、翻不回去；问了没回应看不出卡在哪）。
// 真实隐藏 Hub 渲染端 + 鼠标键盘；会议数据、AI、推送全部是 IPC 夹具，不调真实模型。
// 用法：node tests/e2e-company-meeting-chat-cdp.js [输出目录]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2] || 'artifacts/meeting-chat-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const fixtureSource = fs.readFileSync(path.join(__dirname, 'e2e-company-meeting-flow-cdp.js'), 'utf8');
const fixtureStart = fixtureSource.indexOf('function installFixture() {'), fixtureEnd = fixtureSource.indexOf('\n(async () => {', fixtureStart);
assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart, 'meeting-flow fixture extraction boundary');
const fixtureFunction = fixtureSource.slice(fixtureStart, fixtureEnd).trim();

// 在 installFixture 之上：长会议、各阶段问答、问答控制操作、后台记录接口。
function installChatFixture() {
  const original = ipcRenderer.invoke.bind(ipcRenderer), f = window.m3Fixture;
  f.asr = { ready: true }; f.clipboard = []; f.seq = 0; f.logCalls = 0;
  require('electron').clipboard.writeText = text => { f.clipboard.push(String(text)); };
  const now = Date.now();
  f.phases = () => [
    { id: 'q-queued', q: '还有哪些问题待确认？', state: 'queued', phase: 'queued', speed: 'fast', queuedAt: now - 8000, live: { queueAhead: 2 } },
    { id: 'q-slot', q: '行动项和负责人是谁？', state: 'queued', phase: 'waiting-slot', speed: 'fast', queuedAt: now - 20000, waitingSince: now - 15000, live: { slot: { running: 3, max: 3 }, queueAhead: 0 } },
    { id: 'q-thinking', q: '35% 是按哪个周期算的？', state: 'running', phase: 'thinking', speed: 'fast', engine: 'claude', model: 'glm-4.6', mode: 'fresh', queuedAt: now - 12000, startedAt: now - 9000,
      steps: [{ at: now - 12000, phase: 'queued', text: '已送达' }, { at: now - 10000, phase: 'starting', text: '启动 Claude Code · glm-4.6（快速档，不带理解会话）' }, { at: now - 9000, phase: 'thinking', text: '材料已送入 1.2 万字' }], live: { pid: 4242 } },
    { id: 'q-stream', q: '高速用户的门限有没有人提过具体数？', state: 'running', phase: 'streaming', speed: 'fast', engine: 'claude', model: 'glm-4.6', queuedAt: now - 15000, startedAt: now - 13000, firstTokenAt: now - 9000,
      live: { phase: 'streaming', partial: '目前会上提到的门限是 120 km/h，', chars: 18, firstTokenAt: now - 9000 } },
    { id: 'q-done', q: '我刚进来，现在讨论到哪了？', state: 'done', phase: 'done', speed: 'fast', engine: 'claude', model: 'glm-4.6', queuedAt: now - 60000, firstTokenAt: now - 55800, durationMs: 12500, at: now - 47500,
      answer: '正在比较方案 A 与 B，**算法 A 暂不采用**。王工周三补测方案 B。 [事件 2] [事件 5]', history: [{ speed: 'fast', engine: 'claude', model: 'glm-4.6', answer: '旧版回答：正在讨论算法。', durationMs: 9000, firstTokenMs: 3000, at: now - 70000 }] },
    { id: 'q-error', q: '上周评审的结论是什么？', state: 'error', phase: 'error', errorKind: 'engine-not-ready', error: '会议 AI 引擎没起来（CodeAgent 启动异常）', errorHint: '换个引擎再问，或打开后台看原因', speed: 'fast', queuedAt: now - 40000, at: now - 30000 },
    { id: 'q-cancel', q: '帮我列一下所有数字', state: 'error', phase: 'cancelled', errorKind: 'cancelled', speed: 'normal', queuedAt: now - 35000, at: now - 33000 },
  ];
  f.longEvents = n => { const m = f.current, base = Math.max(...m.events.map(e => e.seq)); for (let i = 1; i <= n; i++) m.events.push(i % 25 === 0 ? { seq: base + i, kind: 'slide', at: 30000 + i * 1500 } : { seq: base + i, kind: 'transcript', at: 30000 + i * 1500, track: 'system', speaker: 1 + (i % 2), text: '长会议原话第 ' + i + ' 句：讨论信道种子、门限与吞吐对照，避免截图里那种整页被顶走。' }); m.capturedMs = 30000 + n * 1500; return m.events.length; };
  f.append = () => { const m = f.current, seq = Math.max(...m.events.map(e => e.seq)) + 1; m.events.push({ seq, kind: 'transcript', at: m.capturedMs += 1500, track: 'mic', text: '边更新边回看的新原话 ' + seq }); return seq; };
  ipcRenderer.invoke = async (channel, args = {}) => {
    const m = f.current;
    if (channel === 'company-assistant:meeting-status') { const r = await original(channel, args); return { ...r, engines: [{ id: 'claude|glm-4.6', label: 'Claude Code · glm-4.6' }, { id: 'codeagent|glm-4.6', label: 'CodeAgent · glm-4.6' }], recommendedEngine: 'claude|glm-4.6', ...(f.health || {}) }; }
    if (channel === 'company-assistant:meeting-question-log') {
      f.logCalls++; if (f.noLogHandler) throw Error("Error invoking remote method 'company-assistant:meeting-question-log': Error: No handler registered for 'company-assistant:meeting-question-log'");
      const q = m.answers.find(x => x.id === args.questionId);
      return { ok: true, meta: { engine: q.engine || 'claude', model: q.model || 'glm-4.6', mode: 'fresh', speed: q.speed, cwd: 'D:/Temp/meeting-chat-fixture/data/workspace/meetings/7b132972-3b17-44e3-937d-b72a1ea23310', command: 'C:/Users/example-user/AppData/Roaming/npm/claude.cmd --print --no-session-persistence --settings D:/Temp/ask-aside-13cbd0c5-97fb-4261-aba2-e971c80dc470.json --output-format stream-json --permission-mode default --strict-mcp-config --model glm-4.6 --verbose --include-partial-messages --effort low', contextChars: 12000, pid: 4242, slot: { running: 2, max: 3 }, startedAt: q.startedAt, firstTokenAt: q.firstTokenAt },
        lines: [{ at: Date.now() - 3000, kind: 'step', text: '启动 Claude Code · glm-4.6' }, { at: Date.now() - 2000, kind: 'event', text: 'system init' }, { at: Date.now() - 1000, kind: 'stderr', text: 'warning: fixture stderr tail #' + f.logCalls }],
        understanding: { sessionId: 'understanding-fixture', state: 'ready', engineLabel: 'CodeAgent · glm-4.6' } };
    }
    if (channel === 'company-assistant:meeting-control' && ['understand', 'skip-failed-asr', 'close-old-sessions'].includes(args.op)) { f.calls.push({ channel, args: { ...args } }); if (args.op === 'understand') f.health = { ...f.health, understandingStage: { stage: 'running', since: Date.now(), text: 'Claude Code 正在整理（1 秒）', ops: [] }, understandingRetry: undefined }; return { ok: true, meeting: m }; }
    if (channel === 'company-assistant:meeting-control' && ['ask', 'question-speed', 'reanswer', 'cancel-question'].includes(args.op)) {
      f.calls.push({ channel, args: JSON.parse(JSON.stringify(args)) });
      if (args.op === 'ask') m.answers.push({ id: 'ask-' + ++f.seq, q: args.value, state: 'queued', phase: 'queued', speed: m.questionSpeed || 'fast', queuedAt: Date.now(), live: { queueAhead: m.answers.filter(q => ['queued', 'running'].includes(q.state)).length } });
      if (args.op === 'question-speed') m.questionSpeed = args.value;
      if (args.op === 'reanswer') { const q = m.answers.find(x => x.id === args.value.id); (q.history ||= []).push({ speed: q.speed, answer: q.answer, error: q.error, durationMs: q.durationMs }); Object.assign(q, { state: 'queued', phase: 'queued', speed: args.value.speed || q.speed, engine: args.value.engine || q.engine, answer: '', error: '', errorKind: undefined, queuedAt: Date.now() }); }
      if (args.op === 'cancel-question') { const q = m.answers.find(x => x.id === args.value); Object.assign(q, { state: 'error', phase: 'cancelled', errorKind: 'cancelled', at: Date.now() }); }
      return { ok: true, meeting: m };
    }
    if (channel.startsWith('company-assistant:') && !channel.startsWith('company-assistant:meeting-') && !['company-assistant:ppt-lookup-frame', 'company-assistant:ppt-open'].includes(channel)) throw Error('unexpected assistant IPC: ' + channel);
    return original(channel, args);
  };
}

(async () => {
  fs.mkdirSync(out, { recursive: true }); let hub, c;
  const shotsDir = process.env.MEETING_CHAT_SHOTS || out; fs.mkdirSync(shotsDir, { recursive: true });
  const result = { passed: false, checks: [], screenshots: [], evidence: 'real hidden Hub renderer + synthetic meeting/AI IPC + locally emitted push events; no real model',
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim() };
  const record = () => fs.writeFileSync(path.join(out, 'meeting-chat-cdp.json'), JSON.stringify(result, null, 2));
  const windowAudit = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(__dirname, 'helpers/reskin-window-audit.ps1'), '-RootProcessId', String(hub.pid)], { windowsHide: true, encoding: 'utf8', timeout: 30000 }));
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-chat-ui-')), dataDir = path.join(root, 'data'), work = path.join(root, 'work'), welink = path.join(root, 'welink-disabled.js');
    for (const p of [dataDir, work, path.join(root, 'personal'), path.join(root, 'scan')]) fs.mkdirSync(p);
    fs.writeFileSync(path.join(work, '.aiwork-root'), ''); fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
    fs.writeFileSync(welink, 'process.stdout.write(JSON.stringify({authenticated:false,loggedIn:false}));');
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'meeting chat UI', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(root, 'missing-cli.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, errorCode: 'offline_test', error: 'offline fixture' }, foreign: { ok: false, errorCode: 'offline_test', error: 'offline fixture' } }),
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_WELINK_CLI: welink,
    } });
    result.hubPid = hub.pid; record();
    c = await connectFirstPage(hub); result.windowAudits = [windowAudit()]; assert.deepEqual(result.windowAudits[0].visible, [], 'no visible windows');
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    const q = s => `document.querySelector(${JSON.stringify(s)})`;
    const until = async (expr, label, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(100); } throw Error('timeout ' + label + ': ' + await c.eval(`${q('[data-m="message"]')}?.textContent`)); };
    const click = async selector => {
      await until(`(()=>{const e=${q(selector)};return !!e&&!e.disabled&&e.getBoundingClientRect().width>0;})()`, selector);
      // 像用户一样只滚它所在的列表（不用 scrollIntoView，免得掩盖外层被滚走的问题）。
      await c.eval(`(()=>{const e=${q(selector)},l=e.closest('.meeting-chat-list,.meeting-flow,.meeting-summary-scroll');if(!l)return;const r=e.getBoundingClientRect(),b=l.getBoundingClientRect();if(r.top<b.top||r.bottom>b.bottom)l.scrollTop+=r.top-b.top-40;})()`);
      const point = await c.eval(`(()=>{const e=${q(selector)},r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);if(!(e===h||e.contains(h)))throw Error('covered '+${JSON.stringify(selector)});return{x,y};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    };
    const size = (width, height, scale = 1) => c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    const shot = async name => { await _waitMs(200); const image = await c.send('Page.captureScreenshot', { format: 'png' }); const file = path.join(shotsDir, '20261124-m1-' + name + '.png'); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); result.screenshots.push(file); record(); };
    // 所有不该滚的外层：会议页内外层容器 + 会议页根到 body。
    const outerScroll = () => c.eval(`(()=>{const r=document.querySelector('.company-meeting'),list=[...r.querySelectorAll('.meeting-columns,.meeting-evidence-pane,.meeting-understanding,.meeting-aside-panel')];for(let n=r;n&&n.tagName!=='HTML';n=n.parentElement)list.push(n);return list.filter(n=>n.scrollTop||n.scrollLeft).map(n=>n.className||n.tagName);})()`);
    const flowHeight = () => c.eval(`${q('[data-m="timeline"]')}.getBoundingClientRect().height`);
    const assertLayout = async label => {
      assert.deepEqual(await outerScroll(), [], label + ': outer containers scrolled');
      assert.deepEqual(await c.eval(`['.meeting-chat-list','.meeting-summary-scroll','.meeting-flow'].filter(s=>{const e=document.querySelector(s);return e&&e.clientWidth&&e.scrollWidth>e.clientWidth+2;})`), [], label + ': horizontal overflow');
      const h = await flowHeight(); assert.ok(h >= 159.5, label + ': timeline squeezed to ' + h);
      const v = await c.eval(`innerHeight>=document.querySelector('.company-meeting').getBoundingClientRect().bottom-1`); assert.ok(v, label + ': page taller than window');
      (result.layout ||= []).push({ label, timelineHeight: Math.round(h) });
    };

    await size(1440, 900);
    await until(`!!${q('#btn-company-meeting')}`, 'meeting nav');
    await c.eval('(' + fixtureFunction + ')()'); await c.eval('(' + installChatFixture.toString() + ')()');
    await click('#btn-company-meeting'); await until(`${q('[data-m="source"]')}?.options.length===1`, 'fixture source');
    await c.eval(`${q('[data-m="system"]')}.checked=false;${q('[data-m="mic"]')}.checked=false;`);
    await click('[data-act="start"]'); await until(`${q('.company-meeting')}?.dataset.phase==='live'`, 'recording');
    if (await c.eval(`${q('[data-act-local="dismiss"]')}?.offsetWidth>0`)) await click('[data-act-local="dismiss"]');

    // 1. 2000+ 事件长会议 + 各阶段问答
    result.events = await c.eval('m3Fixture.longEvents(2100)');
    await c.eval('m3Fixture.current.answers=m3Fixture.phases()');
    await until(`document.querySelectorAll('[data-m="timeline"] > .meeting-flow-event').length>2000`, 'long timeline', 60000);
    assert.equal(await c.eval(`document.querySelectorAll('[data-m="timeline"] [data-answer]').length`), 0, 'no questions in the timeline');
    assert.doesNotMatch(await c.eval(`${q('[data-m="flow-count"]')}.textContent`), /问答/);
    assert.equal(await c.eval(`${q('[data-aside-panel="minutes"]')}.hidden`), false, 'minutes tab is the default');
    await until(`${q('[data-m="chat-badge"]')}.textContent==='3' && ${q('[data-m="chat-busy"]')}.textContent.includes('4 题在答')`, 'busy count + badge for 3 answers finished while on minutes tab');
    result.checks.push('2100-event meeting renders; timeline has no question rows and no 问答 count; minutes tab default; chat tab shows 4 in-flight and badge 3');
    await click('[data-aside-tab="chat"]');
    await until(`document.querySelectorAll('[data-m="chat-list"] [data-answer]').length===7`, 'chat cards');
    const phases = await c.eval(`Object.fromEntries([...document.querySelectorAll('[data-m="chat-list"] [data-answer]')].map(e=>[e.dataset.answer,{phase:e.dataset.phase,status:e.querySelector('.meeting-chat-status')?.textContent.trim()}]))`);
    result.phases = phases;
    assert.match(phases['q-queued'].status, /已送达 · 前面还有 2 题 · 已等 \d+ 秒/);
    assert.match(phases['q-slot'].status, /等回答进程位 · 全机 3\/3 在用 · 已等 \d+ 秒/);
    assert.match(phases['q-thinking'].status, /第 3 步 · 材料已送入 1\.2 万字 · 等第一个字 · 已 \d+ 秒/);
    assert.match(phases['q-stream'].status, /正在回答 · 已出 18 字/);
    assert.match(phases['q-done'].status, /完成 · 首字 4\.2 秒 · 全部 12\.5 秒 · 快速档/);
    assert.equal(phases['q-error'].phase, 'error'); assert.equal(phases['q-cancel'].status, '已取消');
    assert.match(await c.eval(`${q('[data-answer="q-error"]')}.textContent`), /会议 AI 引擎没起来/);
    assert.ok(await c.eval(`!!${q('[data-answer="q-error"] [data-engine-to="codeagent|glm-4.6"]')} && !!${q('[data-answer="q-error"] [data-backstage]')} && !!${q('[data-answer="q-error"] [data-retry-question]')}`), 'engine-not-ready buttons');
    assert.ok(await c.eval(`!!${q('[data-answer="q-done"] [data-speed-to="normal"]')} && !!${q('[data-answer="q-done"] [data-speed-to="deep"]')}`), 'reanswer at normal/deep');
    assert.ok(await c.eval(`!!${q('[data-answer="q-thinking"] [data-cancel-question]')}`), 'in-flight card can be cancelled');
    const t1 = await c.eval(`${q('[data-answer="q-thinking"] [data-wait-since]')}.textContent`); await _waitMs(2200);
    const t2 = await c.eval(`${q('[data-answer="q-thinking"] [data-wait-since]')}.textContent`); assert.notEqual(t1, t2, 'in-flight timer ticks every second');
    result.checks.push('every phase card: queued/waiting-slot/thinking/streaming/done/error/cancelled with step, wait reason, elapsed seconds, first-token and total time; per-kind buttons; 1 s ticker');

    // 截图：四种窗口 × 两个 tab
    const windows = [['1440x900', 1440, 900, 1], ['1280x800', 1280, 800, 1], ['1366x768-125pct', 1093, 614, 1.25], ['1280x650', 1280, 650, 1]];
    for (const [name, w, h, scale] of windows) {
      await size(w, h, scale); await _waitMs(250);
      await click('[data-aside-tab="chat"]'); await assertLayout('chat ' + name); await shot('chat-' + name);
      await click('[data-aside-tab="minutes"]'); await assertLayout('minutes ' + name); await shot('minutes-' + name);
    }
    await size(1440, 900);
    result.checks.push('four window sizes (1440×900, 1280×800, 1366×768@125%, 1280×650): both tabs, no outer scroll, timeline ≥160px, page fits window');

    // 2. 复现截图问题：提问、点议题、点追问后外层都不滚
    // 从「会议理解」用快捷提问：自动切到「助手对话」
    await click('[data-aside-tab="minutes"]');
    await c.eval(`document.querySelector('[data-quick]').click()`);
    await until(`${q('.company-meeting')}.dataset.asideTab==='chat' && !!${q('[data-answer="ask-1"]')}`, 'quick question switches to chat tab');
    await click('[data-m="question"]'); await c.send('Input.insertText', { text: '刚才说的 120 km/h 是谁提的？' });
    await click('[data-act="ask"]');
    await until(`${q('.company-meeting')}.dataset.asideTab==='chat' && !!${q('[data-answer="ask-2"]')}`, 'typed question adds a card');
    await until(`(()=>{const l=${q('[data-m="chat-list"]')};return l.scrollHeight-l.clientHeight-l.scrollTop<4;})()`, 'new card scrolled into view within the list');
    await assertLayout('after ask');
    await click('[data-topic="2"]'); await _waitMs(300); await assertLayout('after topic click');
    await click('[data-followup-question="q-done"]'); await _waitMs(200); await assertLayout('after follow-up');
    assert.equal(await c.eval(`${q('[data-m="question"]')}.value`), '我刚进来，现在讨论到哪了？');
    await c.eval(`${q('[data-m="question"]')}.value=''`);
    // 直接模拟旧代码的做法：在外层容器上 scrollIntoView / 设 scrollTop；overflow:clip 下滚不动，兜底也会复位。
    await c.eval(`(()=>{document.querySelector('.meeting-evidence-pane').scrollTop=200;document.querySelector('.meeting-understanding').scrollTop=120;document.querySelector('.meeting-flow-heading').scrollIntoView({block:'start'});})()`);
    await _waitMs(2800); await assertLayout('after forced outer scroll + one refresh');
    result.checks.push('ask → chat tab + card visible inside list; topic click, follow-up, forced outer scrollIntoView: every outer scrollTop stays 0 and timeline ≥160px');

    // 边更新边往上翻：每 500ms 追加事件，同时把时间流滚到顶
    await c.eval(`(()=>{const l=document.querySelector('[data-m="timeline"]');window.m1Append=setInterval(()=>m3Fixture.append(),500);l.scrollTop=0;})()`);
    const tops = [];
    for (let i = 0; i < 8; i++) { await _waitMs(600); tops.push(await c.eval(`document.querySelector('[data-m="timeline"]').scrollTop`)); }
    await c.eval('clearInterval(window.m1Append)');
    result.scrollWhileUpdating = tops;
    assert.ok(tops.every(t => t < 5), 'stays at the top while new events arrive: ' + tops.join(','));
    assert.equal(await c.eval(`${q('[data-act-local="latest"]')}.hidden`), false, 'back-to-latest is offered');
    await assertLayout('scroll up while updating');
    result.checks.push('timeline scrolled to top stays at top while events append every 500 ms; 回到最新 offered');

    // 切走再回来保留时间流位置
    await c.eval(`document.querySelector('[data-m="timeline"]').scrollTop=4000`);
    const before = await c.eval(`document.querySelector('[data-m="timeline"]').scrollTop`);
    await click('#btn-home'); await until(`${q('#company-meeting-page')}.hidden`, 'left meeting page');
    await click('#btn-company-meeting'); await until(`!${q('#company-meeting-page')}.hidden`, 'back to meeting');
    await _waitMs(300);
    const after = await c.eval(`document.querySelector('[data-m="timeline"]').scrollTop`);
    assert.ok(Math.abs(after - before) < 3, `scroll restored ${before} → ${after}`);
    result.checks.push('leaving the page and coming back restores the timeline scroll position');

    // 3. 推送：卡片 300ms 内更新，不等轮询
    await click('[data-aside-tab="chat"]');
    result.pushLatency = await c.eval(`new Promise(resolve=>{const m=m3Fixture.current,t0=performance.now();
      require('electron').ipcRenderer.emit('company-assistant:meeting-question',{},{meetingId:m.id,questionId:'q-stream',phase:'streaming',partial:'目前会上提到的门限是 120 km/h，由王工提出，周三前确认。',chars:30,firstTokenAt:Date.now()-9000,at:Date.now()});
      const check=()=>{const e=document.querySelector('[data-answer="q-stream"] .meeting-chat-partial');if(e&&e.textContent.includes('周三前确认')&&document.querySelector('[data-answer="q-stream"] .meeting-chat-label').textContent.includes('30 字'))resolve(performance.now()-t0);else if(performance.now()-t0>2000)resolve(-1);else requestAnimationFrame(check);};check();})`);
    assert.ok(result.pushLatency >= 0 && result.pushLatency < 300, 'push applied in ' + result.pushLatency + ' ms');
    result.pushPhaseLatency = await c.eval(`new Promise(resolve=>{const m=m3Fixture.current,t0=performance.now();
      require('electron').ipcRenderer.emit('company-assistant:meeting-question',{},{meetingId:m.id,questionId:'q-slot',phase:'starting',at:Date.now()});
      const check=()=>{const e=document.querySelector('[data-answer="q-slot"]');if(e&&e.dataset.phase==='starting')resolve(performance.now()-t0);else if(performance.now()-t0>2000)resolve(-1);else requestAnimationFrame(check);};check();})`);
    assert.ok(result.pushPhaseLatency >= 0 && result.pushPhaseLatency < 300, 'phase push applied in ' + result.pushPhaseLatency + ' ms');
    await shot('chat-push-streaming-1440x900');
    result.checks.push(`push events update the card in place: streaming text ${result.pushLatency.toFixed(0)} ms, phase switch ${result.pushPhaseLatency.toFixed(0)} ms (<300 ms, no poll)`);

    // 角标：不在「助手对话」时有新回答
    await click('[data-aside-tab="minutes"]');
    await c.eval(`Object.assign(m3Fixture.current.answers.find(x=>x.id==='ask-2'),{state:'done',phase:'done',answer:'是王工提的。 [事件 5]',at:Date.now(),durationMs:8000,firstTokenAt:Date.now()-5000})`);
    await until(`!${q('[data-m="chat-badge"]')}.hidden && ${q('[data-m="chat-badge"]')}.textContent==='1'`, 'badge on new answer');
    await shot('badge-1440x900');
    await click('[data-aside-tab="chat"]'); await until(`${q('[data-m="chat-badge"]')}.hidden`, 'badge cleared');
    result.checks.push('new answer while on 会议理解 → badge 1 on 助手对话; opening the tab clears it');

    // 换档、重答、取消
    await click('[data-qspeed="deep"]'); await until(`m3Fixture.current.questionSpeed==='deep' && ${q('[data-qspeed="deep"]')}.getAttribute('aria-checked')==='true'`, 'question speed deep');
    assert.equal(await c.eval('m3Fixture.current.speed'), 'normal', 'minutes speed untouched by question speed');
    await click('[data-qspeed="fast"]');
    await click('[data-answer="q-done"] [data-speed-to="normal"]');
    await until(`m3Fixture.calls.some(x=>x.args.op==='reanswer'&&x.args.value.id==='q-done'&&x.args.value.speed==='normal')`, 'reanswer dispatched');
    await until(`${q('[data-answer="q-done"]')}.dataset.phase==='queued' && ${q('[data-answer="q-done"] .meeting-chat-history summary')}.textContent.includes('2 版')`, 'old version folded into history');
    await click('[data-answer="q-thinking"] [data-cancel-question]');
    await until(`${q('[data-answer="q-thinking"]')}.dataset.phase==='cancelled'`, 'cancelled');
    result.checks.push('question speed tier independent of minutes tier; reanswer at 中等 folds previous version; cancel turns the card into 已取消');

    // C. 看后台
    // 四档窗口 × 在途 / 结束两种抽屉：底部按钮全部在抽屉内、真实鼠标点得到（m4 复验：矮窗第 2 行按钮被裁）
    const drawerCheck = () => c.eval(`(()=>{const d=document.querySelector('[data-m="backstage"]'),b=d.getBoundingClientRect();return [...d.querySelectorAll('.meeting-backstage-actions > button, .meeting-backstage-actions > details > summary')].map(e=>{const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {text:e.textContent.trim(),inside:r.top>=b.top-1&&r.bottom<=b.bottom+1&&r.bottom<=innerHeight+1,hit:!!h&&(h===e||e.contains(h))};});})()`);
    for (const [name, w, h, scale] of [['1440x900', 1440, 900, 1], ['1280x800', 1280, 800, 1], ['1280x650', 1280, 650, 1], ['1366x768-125pct', 1093, 614, 1.25]]) {
      await size(w, h, scale); await _waitMs(250);
      for (const qid of ['q-stream', 'q-error']) {
        await click(`[data-answer="${qid}"] [data-backstage]`); await until(`!${q('[data-m="backstage"]')}.hidden && ${q('[data-m="backstage"]')}.textContent.includes('--include-partial-messages')`, 'drawer ' + qid);
        await _waitMs(150);
        const btns = await drawerCheck();
        (result.drawerButtons ||= []).push({ name, qid, count: btns.length, allInside: btns.every(x => x.inside), allHit: btns.every(x => x.hit) });
        assert.ok(btns.length >= (qid === 'q-error' ? 5 : 3) && btns.every(x => x.inside && x.hit), `${name} ${qid}: drawer buttons clipped ${JSON.stringify(btns)}`);
        await shot(`backstage-${qid === 'q-error' ? 'finished' : 'inflight'}-${name}-fix7`);
        await click('[data-backstage-close]');
      }
    }
    await size(1440, 900);
    result.checks.push('backstage drawer with a real-length command: every action button inside the drawer and clickable, in-flight and finished, at 1440×900 / 1280×800 / 1280×650 / 1366×768@125%');
    await click('[data-answer="q-stream"] [data-backstage]');
    await until(`!${q('[data-m="backstage"]')}.hidden && ${q('[data-m="backstage"]')}.textContent.includes('4242')`, 'backstage with pid');
    const calls0 = await c.eval('m3Fixture.logCalls'); await _waitMs(2300);
    assert.ok(await c.eval('m3Fixture.logCalls') - calls0 >= 2, 'in-flight backstage refreshes every second');
    assert.match(await c.eval(`${q('[data-m="backstage"]')}.textContent`), /stream-json[\s\S]*system init[\s\S]*fixture stderr tail/);
    await assertLayout('backstage open'); await shot('backstage-1440x900');
    await click('[data-backstage-copy="q-stream"]'); await until('m3Fixture.clipboard.length===1', 'copy log');
    assert.match(await c.eval('m3Fixture.clipboard[0]'), /高速用户的门限[\s\S]*Claude Code[\s\S]*system init/);
    // 抽屉开着时这题答完（推送 done）：补读一次后台记录，拿到结束时的 stderr / 退出码
    const callsBeforeDone = await c.eval('m3Fixture.logCalls');
    await c.eval(`(()=>{const m=m3Fixture.current;Object.assign(m.answers.find(x=>x.id==='q-stream'),{state:'done',phase:'done',answer:'门限是 120 km/h。',at:Date.now(),durationMs:9000});require('electron').ipcRenderer.emit('company-assistant:meeting-question',{},{meetingId:m.id,questionId:'q-stream',phase:'done',partial:'门限是 120 km/h。',at:Date.now()});})()`);
    await until(`m3Fixture.logCalls>${callsBeforeDone} && !${q('[data-m="backstage"]')}.textContent.includes('每秒刷新')`, 'final log read after the answer finished');
    const callsAfterDone = await c.eval('m3Fixture.logCalls'); await _waitMs(2200);
    assert.ok(await c.eval('m3Fixture.logCalls') - callsAfterDone <= 1, 'no per-second polling once finished');
    result.checks.push('backstage re-reads the log once when the open question finishes, then stops polling');
    await click('[data-backstage-close]'); await until(`${q('[data-m="backstage"]')}.hidden`, 'backstage closed');
    await c.eval('m3Fixture.noLogHandler=true');
    await click('[data-answer="q-error"] [data-backstage]');
    await until(`${q('[data-m="backstage"]')}.textContent.includes('详细记录') && ${q('[data-m="backstage"]')}.textContent.includes('会议 AI 引擎没起来')`, 'old backend fallback');
    await shot('backstage-old-backend-1440x900');
    await click('[data-backstage-close]');
    result.checks.push('看后台 drawer: engine/model/pid/command/lines, refreshes every second in flight, copy log; old backend shows persisted fields + 需新版后端 note');

    // 会议 AI 起不来：助手对话顶部醒目提示
    await c.eval(`m3Fixture.current.agent={state:'error',error:'CodeAgent 启动异常：spawn ENOENT'}`);
    await until(`!${q('[data-m="lane-alert"]')}.hidden && ${q('[data-m="lane-alert"]')}.textContent.includes('spawn ENOENT')`, 'lane alert');
    await shot('lane-alert-1440x900');
    await click('[data-act-local="lane-engine"]'); await until(`${q('[data-m="more"]')}.open`, 'engine menu opened');
    await assertLayout('lane alert');
    result.checks.push('engine failure shows a prominent alert at the top of 助手对话 with 换引擎 / 看后台');
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.eval(`m3Fixture.current.agent={state:'ready'}`);

    // 理解线健康（契约 7.1）：「会议理解」tab 顶部按 stage 给白话原因和按钮；状态行用实际引擎名；录像补索引不当卡死
    await c.eval(`m3Fixture.health={engineCurrent:'Claude Code · GLM 5',engineSource:'global',understandingStage:{stage:'error',since:Date.now()-60000,text:'会议理解出错：网关返回 502（Claude Code · GLM 5）',ops:['understand']},understandingRetry:{count:1,max:3,nextAt:Date.now()+30000,nextInMs:30000,retrying:false,lastError:{kind:'gateway',label:'网关报错',text:'502',at:Date.now()}},pendingClose:{count:1,attempts:2,oldestAt:Date.now()-90000,nextAt:Date.now()+60000,gaveUp:false}};m3Fixture.current.recording.full={...(m3Fixture.current.recording.full||{}),repairing:{startedAt:Date.now(),bytesTotal:1}};`);
    await click('[data-aside-tab="minutes"]');
    await until(`!${q('[data-m="und-alert"]')}.hidden && ${q('[data-m="und-alert"]')}.textContent.includes('网关返回 502') && ${q('[data-m="und-alert"]')}.textContent.includes('已自动重试 1/3 次（网关报错）') && ${q('[data-m="und-alert"]')}.textContent.includes('后台第 2 次重试中')`, 'understanding alert');
    assert.equal(await c.eval(`${q('[data-m="engine-line"]')}.textContent`), '会议 AI：Claude Code · GLM 5（来自设置默认）');
    await until(`${q('[data-m="recording-status"]')}.textContent.includes('正在为录像补索引')`, 'repairing recording');
    assert.equal(await c.eval(`${q('[data-m="message"]')}.textContent.includes('502')`), false, 'understanding error not duplicated in the notice bar');
    await shot('understanding-alert-1440x900');
    await click('[data-m="und-alert"] [data-und-op="understand"]');
    await until(`m3Fixture.calls.some(x=>x.args?.op==='understand') && ${q('[data-m="und-alert"]')}.textContent.includes('后台第 2 次') && ${q('[data-m="understanding-status"]')}.textContent.includes('Claude Code 正在整理')`, 'understand op + stage line');
    await c.eval(`m3Fixture.health={engineCurrent:'Claude Code · GLM 5',engineSource:'global'};delete m3Fixture.current.recording.full.repairing;`);
    await until(`${q('[data-m="und-alert"]')}.hidden`, 'alert cleared');
    result.checks.push('understanding health: stage error shows reason + 已自动重试 + 旧会话关不掉 + 重新整理/换引擎; 重新整理 sends op understand; status line uses the real engine; recording repair shown as 正在补索引, not stuck');
    // 会后布局：纪要大卡同样两个 tab
    await click('[data-act="stop"]'); await until(`${q('.company-meeting')}.dataset.phase==='review'`, 'review');
    if (await c.eval(`${q('[data-act-local="dismiss"]')}?.offsetWidth>0`)) await click('[data-act-local="dismiss"]');
    for (const [name, w, h] of [['1440x900', 1440, 900], ['1280x650', 1280, 650]]) {
      await size(w, h); await click('[data-aside-tab="chat"]'); await assertLayout('review chat ' + name); await shot('review-chat-' + name);
      await click('[data-aside-tab="minutes"]'); await assertLayout('review minutes ' + name); await shot('review-minutes-' + name);
    }
    assert.equal(await c.eval(`document.querySelectorAll('[data-m="timeline"] [data-answer]').length`), 0, 'review timeline has no questions');
    result.checks.push('review layout: minutes card has the same two tabs; questions stay out of the timeline');
    result.windowAudits.push(windowAudit()); assert.deepEqual(result.windowAudits.at(-1).visible, [], 'no visible windows at end');
    result.passed = true;
  } catch (error) {
    result.error = error.stack; process.exitCode = 1;
    if (c) try { const image = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'failure.png'), Buffer.from(image.data, 'base64')); } catch {}
  } finally {
    if (c) await c.eval('clearInterval(window.m3DrawTimer);clearInterval(window.m1Append)').catch(() => {});
    try { if (hub) result.teardown = await gracefulQuit(hub); } catch (error) { result.teardownError = error.message; }
    if (c) await c.close().catch(() => {});
    record(); console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, out, error: result.error || null, teardownError: result.teardownError || null }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
