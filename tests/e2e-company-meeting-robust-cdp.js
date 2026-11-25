'use strict';
// 会议页渲染端鲁棒性（2026-11-24 用户截图：整页被顶走、翻不回去；m4 走查：错误卡竖排、按钮锁、窄窗控件被挤走）。
// 真实隐藏 Hub 渲染端 + 鼠标键盘；会议数据、AI、推送全部是 IPC 夹具，不调真实模型。
// 用法：node tests/e2e-company-meeting-robust-cdp.js [输出目录]（截图目录可用 MEETING_CHAT_SHOTS 指定）
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2] || 'artifacts/meeting-robust-cdp');
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
    if (channel === 'company-assistant:meeting-status') { const r = await original(channel, args); return { ...r, engines: [{ id: 'claude:glm', label: 'Claude Code · glm-4.6' }, { id: 'codeagent:glm', label: 'CodeAgent · glm-4.6' }], recommendedEngine: 'claude:glm' }; }
    if (channel === 'company-assistant:meeting-question-log') {
      f.logCalls++; if (f.noLogHandler) throw Error("Error invoking remote method 'company-assistant:meeting-question-log': Error: No handler registered for 'company-assistant:meeting-question-log'");
      const q = m.answers.find(x => x.id === args.questionId);
      return { ok: true, meta: { engine: q.engine || 'claude', model: q.model || 'glm-4.6', mode: 'fresh', speed: q.speed, cwd: 'D:/fixture/meeting', command: 'claude --print --model glm-4.6 --output-format stream-json', contextChars: 12000, pid: 4242, slot: { running: 2, max: 3 }, startedAt: q.startedAt, firstTokenAt: q.firstTokenAt },
        lines: [{ at: Date.now() - 3000, kind: 'step', text: '启动 Claude Code · glm-4.6' }, { at: Date.now() - 2000, kind: 'event', text: 'system init' }, { at: Date.now() - 1000, kind: 'stderr', text: 'warning: fixture stderr tail #' + f.logCalls }],
        understanding: { sessionId: 'understanding-fixture', state: 'ready', engineLabel: 'CodeAgent · glm-4.6' } };
    }
    if (channel === 'company-assistant:meeting-control' && ['ask', 'question-speed', 'reanswer', 'cancel-question'].includes(args.op)) {
      f.calls.push({ channel, args: JSON.parse(JSON.stringify(args)) });
      if (args.op === 'ask') m.answers.push({ id: 'ask-' + ++f.seq, q: args.value, state: 'queued', phase: 'queued', speed: m.questionSpeed || 'fast', queuedAt: Date.now(), live: { queueAhead: m.answers.filter(q => ['queued', 'running'].includes(q.state)).length } });
      if (args.op === 'question-speed') m.questionSpeed = args.value;
      if (args.op === 'reanswer') { const q = m.answers.find(x => x.id === args.value.id); (q.history ||= []).push({ speed: q.speed, answer: q.answer, error: q.error, durationMs: q.durationMs }); Object.assign(q, { state: 'queued', phase: 'queued', speed: args.value.speed || q.speed, engine: args.value.engine || q.engine, answer: '', error: '', errorKind: undefined, queuedAt: Date.now() }); }
      if (args.op === 'cancel-question') { const q = m.answers.find(x => x.id === args.value); Object.assign(q, { state: 'error', phase: 'cancelled', errorKind: 'cancelled', at: Date.now() }); }
      if (args.op === 'ask' && f.holdNextAsk) { f.holdNextAsk = false; f.askHeld = true; await new Promise(resolve => { f.releaseAsk = resolve; }); f.askHeld = false; }
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
  const record = () => fs.writeFileSync(path.join(out, 'meeting-robust-cdp.json'), JSON.stringify(result, null, 2));
  const windowAudit = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(__dirname, 'helpers/reskin-window-audit.ps1'), '-RootProcessId', String(hub.pid)], { windowsHide: true, encoding: 'utf8', timeout: 30000 }));
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-robust-ui-')), dataDir = path.join(root, 'data'), work = path.join(root, 'work'), welink = path.join(root, 'welink-disabled.js');
    for (const p of [dataDir, work, path.join(root, 'personal'), path.join(root, 'scan')]) fs.mkdirSync(p);
    fs.writeFileSync(path.join(work, '.aiwork-root'), ''); fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
    fs.writeFileSync(welink, 'process.stdout.write(JSON.stringify({authenticated:false,loggedIn:false}));');
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'meeting robustness UI', extraEnv: {
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
    // 准备页：右上角「功能使用的 Agent」入口是长后端名（设置里选「部门 API key（网关）」，真机实测按钮 209px）时也不压「刷新」。
    // 真实按钮会被功能 Agent 设置模块随时改回本机配置的名字，所以放一个同样式的副本代替它来量和截图，量完还原。
    await until(`!!document.querySelector('.meeting-actions .fa-entry')`, 'feature agent entry');
    await c.eval(`(()=>{const e=document.querySelector('.meeting-actions .fa-entry'),x=e.cloneNode(false);x.dataset.m1Clone='1';x.textContent='⚙ 部门 API key（网关）';x.title='部门 API key（网关） · 选择这个功能使用的 Agent 与模型';e.after(x);e.style.display='none';})()`);
    for (const [name, w, h, scale] of [['1366x768-125pct', 1093, 614, 1.25], ['1280x800', 1280, 800, 1]]) {
      await size(w, h, scale); await _waitMs(250);
      const overlap = await c.eval(`(()=>{const r=document.querySelector('.meeting-setup-sources-head [data-act="sources"]').getBoundingClientRect();return ['[data-m1-clone]','.meeting-more>summary'].map(s=>{const e=document.querySelector(s);if(!e||!e.offsetParent)return 0;const b=e.getBoundingClientRect();return Math.max(0,Math.min(r.right,b.right)-Math.max(r.left,b.left))*(Math.min(r.bottom,b.bottom)>Math.max(r.top,b.top)?1:0);});})()`);
      assert.deepEqual(overlap, [0, 0], name + ': top-right buttons overlap 刷新 by ' + overlap);
      const lab = await c.eval(`(()=>{const e=document.querySelector('[data-m1-clone]');return {text:e.textContent,sw:e.scrollWidth,cw:e.clientWidth,width:e.getBoundingClientRect().width};})()`);
      assert.ok(lab.sw > lab.cw, name + ': long label is ellipsized ' + JSON.stringify(lab));
      (result.idleOverlap ||= []).push({ name, overlap, label: lab });
      await shot('A-idle-gateway-label-' + name);
    }
    await c.eval(`(()=>{document.querySelector('[data-m1-clone]').remove();document.querySelector('.meeting-actions .fa-entry').style.display='';})()`);
    await size(1440, 900);
    result.checks.push('idle page: a long feature-agent label (部门 API key（网关）) is ellipsized and never overlaps 刷新 at 1366×768@125% and 1280×800');
    await c.eval(`${q('[data-m="system"]')}.checked=false;${q('[data-m="mic"]')}.checked=false;`);
    await click('[data-act="start"]'); await until(`${q('.company-meeting')}?.dataset.phase==='live'`, 'recording');
    if (await c.eval(`${q('[data-act-local="dismiss"]')}?.offsetWidth>0`)) await click('[data-act-local="dismiss"]');


    // 1. 2000+ 事件长会议
    result.events = await c.eval('m3Fixture.longEvents(2100)');
    await until(`document.querySelectorAll('[data-m="timeline"] > .meeting-flow-event').length>2000`, 'long timeline', 60000);
    result.checks.push('2100-event meeting renders in the timeline');

    // 四种窗口：外层不滚、时间流 ≥160px、整页不超出窗口；画面放大态的控件仍在可视区
    const controlsVisible = () => c.eval(`(()=>{const v=document.querySelector('.meeting-viewer'),b=v.getBoundingClientRect();return ['[data-act-local="expand-viewer"]','[data-act="snap"]','[data-act="mark"]'].map(s=>{const e=document.querySelector(s);if(!e||!e.offsetParent)return null;const r=e.getBoundingClientRect();return r.top>=b.top-1&&r.bottom<=b.bottom+1?null:s;}).filter(Boolean);})()`);
    const windows = [['1440x900', 1440, 900, 1], ['1280x800', 1280, 800, 1], ['1366x768-125pct', 1093, 614, 1.25], ['1280x650', 1280, 650, 1], ['1092x650', 1092, 650, 1]];
    for (const [name, w, h, scale] of windows) {
      await size(w, h, scale); await _waitMs(250);
      await assertLayout('live ' + name); await shot('A-live-' + name);
      await click('[data-act-local="expand-viewer"]'); await _waitMs(200);
      assert.equal(await c.eval(`${q('.meeting-viewer')}.classList.contains('is-expanded')`), true);
      (result.geom ||= {})[name] = await c.eval("(()=>{const r=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();const cs=getComputedStyle(e);return [Math.round(b.top),Math.round(b.height),cs.display,cs.flexBasis,cs.minHeight,cs.maxHeight];};return {pane:r('.meeting-evidence-pane'),viewer:r('.meeting-viewer'),stage:r('.meeting-stage'),controls:r('.meeting-viewer-controls'),mark:r('.meeting-mark-bar'),replay:r('.meeting-replay'),heading:r('.meeting-section-heading')};})()");
      assert.deepEqual(await controlsVisible(), [], name + ': viewer controls pushed out of view when expanded');
      await assertLayout('expanded ' + name); await shot('A-expanded-' + name);
      await click('[data-act-local="expand-viewer"]');
    }
    await size(1440, 900);
    result.checks.push('four window sizes (1440×900, 1280×800, 1366×768@125%, 1280×650): no outer scroll, timeline ≥160px, page fits; expanded viewer keeps 收起/截图/记重点 visible');

    // 2. 复现截图问题：提问、点议题、点追问后外层都不滚
    await click('[data-aside-tab="chat"]'); await click('[data-m="question"]'); await c.send('Input.insertText', { text: '刚才说的 120 km/h 是谁提的？' });
    await click('[data-act="ask"]'); await until(`m3Fixture.calls.some(x=>x.args?.op==='ask')`, 'ask dispatched');
    await _waitMs(600); await assertLayout('after ask');
    await click('[data-topic="2"]'); await _waitMs(300); await assertLayout('after topic click');
    await c.eval(`(()=>{document.querySelector('.meeting-evidence-pane').scrollTop=200;document.querySelector('.meeting-understanding').scrollTop=120;document.querySelector('.meeting-flow-heading').scrollIntoView({block:'start'});})()`);
    await _waitMs(2800); await assertLayout('after forced outer scroll + one refresh');
    result.checks.push('ask, topic click, forced outer scrollIntoView: every outer scrollTop stays 0, timeline ≥160px');

    // 边更新边往上翻
    await c.eval(`(()=>{const l=document.querySelector('[data-m="timeline"]');window.m1Append=setInterval(()=>m3Fixture.append(),500);l.scrollTop=0;})()`);
    const tops = [];
    for (let i = 0; i < 8; i++) { await _waitMs(600); tops.push(await c.eval(`document.querySelector('[data-m="timeline"]').scrollTop`)); }
    await c.eval('clearInterval(window.m1Append)');
    result.scrollWhileUpdating = tops;
    assert.ok(tops.every(t => t < 5), 'stays at the top while new events arrive: ' + tops.join(','));
    result.checks.push('timeline scrolled to top stays at top while events append every 500 ms');

    // 切走再回来保留时间流位置（含隐藏原话时）
    for (const hide of [false, true]) {
      if (hide) await c.eval(`document.querySelector('[data-act-local="toggle-transcript"]').click()`);
      await c.eval(`document.querySelector('[data-m="timeline"]').scrollTop=${hide ? 300 : 4000}`);
      const before = await c.eval(`document.querySelector('[data-m="timeline"]').scrollTop`);
      await click('#btn-home'); await until(`${q('#company-meeting-page')}.hidden`, 'left meeting page');
      await click('#btn-company-meeting'); await until(`!${q('#company-meeting-page')}.hidden`, 'back to meeting');
      await _waitMs(2800);
      const after = await c.eval(`document.querySelector('[data-m="timeline"]').scrollTop`);
      assert.ok(Math.abs(after - before) < 3, `scroll restored ${before} → ${after} (hide transcripts ${hide})`);
      (result.restore ||= []).push({ hide, before, after });
    }
    await c.eval(`document.querySelector('[data-act-local="toggle-transcript"]').click()`);
    result.checks.push('leaving the page and coming back restores the timeline scroll position (also with transcripts hidden), not pulled to the bottom');

    // 提示条：轮询来的错误关掉不再弹；用户操作的提示照常显示；长错误卡不竖排挤爆
    // m4 的 04 场景：很长的「未找到 CodeAgent CLI」错误 + 帮助卡
    await c.eval(`m3Fixture.current.error='未找到 CodeAgent CLI。请从首页「安装说明」安装 CodeAgent，或在设置里指定命令路径。'.repeat(14)`);
    await until(`${q('[data-m="message"]')}.textContent.includes('未找到 CodeAgent')`, 'poll error shown');
    for (const [name, w, h, scale] of [['1280x800', 1280, 800, 1], ['1440x900', 1440, 900, 1], ['1366x768-125pct', 1093, 614, 1.25]]) {
      await size(w, h, scale); await _waitMs(300);
      await c.eval(`document.querySelector('.meeting-notice').scrollTop=9999`);
      const box = await c.eval(`(()=>{const m=document.querySelector('[data-m="message"]').getBoundingClientRect(),el=document.querySelector('.meeting-notice'),n=el.getBoundingClientRect(),x=document.querySelector('[data-act-local="dismiss"]').getBoundingClientRect(),hit=document.elementFromPoint(x.x+x.width/2,x.y+x.height/2);return{msgW:m.width,noticeH:n.height,winH:innerHeight,scrollable:el.scrollHeight>el.clientHeight,scrolled:el.scrollTop,closeInside:x.top>=n.top-1&&x.bottom<=n.bottom+1,closeHit:!!hit?.closest('[data-act-local="dismiss"]')};})()`);
      assert.ok(box.msgW > 200, name + ': message text squeezed to ' + box.msgW + 'px');
      assert.ok(box.noticeH <= 181, name + ': notice too tall ' + box.noticeH);
      assert.ok(box.scrollable && box.scrolled > 0, name + ': long notice should scroll inside ' + JSON.stringify(box));
      assert.ok(box.closeInside && box.closeHit, name + ': close button not clickable after scrolling the notice ' + JSON.stringify(box));
      await c.eval(`document.querySelector('.meeting-notice').scrollTop=0`);
      await assertLayout('long error ' + name); await shot('A-long-error-' + name);
      (result.notice ||= []).push({ name, ...box });
    }
    await size(1440, 900);
    await click('[data-act-local="dismiss"]'); await _waitMs(2800);
    assert.equal(await c.eval(`${q('[data-m="message"]')}.textContent`), '', 'dismissed poll error stays closed');
    await click('[data-act="open-folder"]').catch(() => {}); // 用户操作：消息清零后能正常显示
    await c.eval(`m3Fixture.current.error=''`); await _waitMs(2800);
    await c.eval(`m3Fixture.current.error='未找到 CodeAgent CLI。请从首页「安装说明」安装 CodeAgent，或在设置里指定命令路径。'.repeat(3)`);
    await until(`${q('[data-m="message"]')}.textContent.includes('未找到 CodeAgent')`, 'same error returns after it had cleared');
    await c.eval(`m3Fixture.current.error=''`);
    result.checks.push('long error notice (m4 scenario 04) wraps, stays ≤180px with inner scroll and a clickable × at 1280×800, 1440×900 and 1366×768@125%; dismissed poll error stays closed; after it clears, the same error shows again');

    // 按钮锁拆开：提问没跑完时，记重点照样生效
    await c.eval('m3Fixture.holdNextAsk=true');
    await click('[data-aside-tab="chat"]'); await click('[data-m="question"]'); await c.send('Input.insertText', { text: '锁测试' });
    await click('[data-act="ask"]'); await until('m3Fixture.askHeld', 'ask held');
    const marks0 = await c.eval(`m3Fixture.current.events.filter(e=>e.kind==='mark').length`);
    await click('[data-m="note"]'); await c.send('Input.insertText', { text: '提问进行中也能记' });
    await click('[data-act="mark"]');
    await until(`m3Fixture.current.events.filter(e=>e.kind==='mark').length>${marks0}`, 'mark while ask in flight');
    await c.eval('m3Fixture.releaseAsk()');
    result.checks.push('ask in flight no longer swallows a 记重点 click (per-button locks)');

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

