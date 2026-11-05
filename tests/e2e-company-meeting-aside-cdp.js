'use strict';
// Real hidden Hub renderer and mouse/keyboard input. Synthetic meeting/AI IPC only.
// Reuse only installFixture from meeting-flow; never execute or modify its V7 suite.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict'), { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2] || 'artifacts/meeting-aside-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const fixtureFile = path.join(__dirname, 'e2e-company-meeting-flow-cdp.js');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8');
const fixtureStart = fixtureSource.indexOf('function installFixture() {'), fixtureEnd = fixtureSource.indexOf('\n(async () => {', fixtureStart);
assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart, 'meeting-flow fixture extraction boundary');
const fixtureFunction = fixtureSource.slice(fixtureStart, fixtureEnd).trim();
assert.ok(fixtureFunction.endsWith('}'), 'complete fixture function extracted');

function installAsideFixture() {
  const original = ipcRenderer.invoke.bind(ipcRenderer), f = window.m3Fixture;
  f.asr = { ready: true }; f.clipboard = []; f.asideSequence = 0;
  // No writes to the operating-system clipboard, including asynchronous browser API.
  const clipboard = require('electron').clipboard;
  f.originalWriteText = clipboard.writeText;
  clipboard.writeText = text => { if(f.failClipboard)throw Error('模拟复制失败');f.clipboard.push(String(text)); };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { f.clipboard.push(String(text)); } } });
  f.advanceMinutes = () => { const m = f.current; m.revision++; m.summary += '\n\n第 ' + m.revision + ' 版补充：保持对照种子。 [事件 5]'; m.job = { kind: 'understand', state: 'running', sentAt: Date.now() }; return m.revision; };
  f.setQuestion = (index, state, answer = '', error = '') => {
    const m = f.current, q = m.answers[index]; Object.assign(q, { state, answer, error });
    if (state === 'done') q.at = Date.now();
    const active = m.answers.find(item => ['queued', 'running'].includes(item.state));
    m.questionJob = active ? { engine: 'ask-aside', kind: 'question', questionId: active.id, state: active.state, sentAt: Date.now() } : null;
  };
  ipcRenderer.invoke = async (channel, args = {}) => {
    if (channel === 'company-assistant:meeting-control' && ['ask', 'retry-question'].includes(args.op)) {
      f.calls.push({ channel, args: { ...args } }); const m = f.meetings[args.id];
      if (args.op === 'ask') {
        const active = m.answers.some(q => ['queued', 'running'].includes(q.state));
        const q = { id: 'aside-' + ++f.asideSequence, q: args.value, state: active ? 'queued' : 'running', queuedAt: Date.now() };
        m.answers.push(q); if (!active) m.questionJob = { engine:'ask-aside',kind:'question',questionId:q.id,state:q.state,sentAt:Date.now() };
      } else {
        const q = m.answers.find(item => item.id === args.value); if (!q) throw Error('unknown retry id');
        q.state = 'queued'; q.error = ''; m.questionJob = { engine:'ask-aside',kind:'question',questionId:q.id,state:'queued',sentAt:Date.now() };
      }
      if(args.op==='ask'&&f.holdNextAsk){f.holdNextAsk=false;f.askHeld=true;await new Promise(resolve=>{f.releaseAsk=resolve;});f.askHeld=false;}
      return { ok: true, meeting: m };
    }
    // Block accidental real backend actions outside the inherited meeting fixture.
    if (channel.startsWith('company-assistant:') && !channel.startsWith('company-assistant:meeting-') && !['company-assistant:ppt-lookup-frame','company-assistant:ppt-open'].includes(channel)) throw Error('unexpected assistant IPC: ' + channel);
    return original(channel, args);
  };
}

(async () => {
  fs.mkdirSync(out, { recursive: true }); let hub, c, timer, auditError;
  const result = { passed: false, checks: [], screenshots: [], windowAudits: [], evidence: 'real renderer + synthetic meeting/AI IPC, no real model/company/credentials', clipboard: 'renderer in-memory mock; no system clipboard access',
    fixtureSource: { file: fixtureFile, function: 'installFixture', sha256: createHash('sha256').update(fixtureSource).digest('hex') },
    productHashes: Object.fromEntries(['renderer/company-meeting-page.js','renderer/company-meeting-template.js','renderer/styles/company-meeting.css'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex')])),
    head: execFileSync('git', ['rev-parse','HEAD'], { cwd:repo,windowsHide:true,encoding:'utf8' }).trim() };
  const record = () => fs.writeFileSync(path.join(out,'meeting-aside-cdp.json'),JSON.stringify(result,null,2));
  const windowAudit = () => JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'helpers/reskin-window-audit.ps1'),'-RootProcessId',String(hub.pid)],{windowsHide:true,encoding:'utf8',timeout:30000}));
  const audit = () => { const value=windowAudit();result.windowAudits.push(value);record();assert.deepEqual(value.visible,[],'no visible windows from owned Hub'); };
  try {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'meeting-aside-ui-')),dataDir=path.join(root,'data'),work=path.join(root,'work'),welink=path.join(root,'welink-disabled.js');
    for(const p of [dataDir,work,path.join(root,'personal'),path.join(root,'scan')])fs.mkdirSync(p);
    fs.writeFileSync(path.join(work,'.aiwork-root'),'');fs.writeFileSync(path.join(dataDir,'optional-features.json'),JSON.stringify({assistant:false,forum:false}));
    fs.writeFileSync(welink,'process.stdout.write(JSON.stringify({authenticated:false,loggedIn:false}));');
    hub=await launchIsolatedHub({entryPath:repo,cwd:repo,dataDir,port:await freePort(),windowMode:'hidden',label:'C3 independent aside UI',extraEnv:{
      AI_HUB_WORKSPACE_ROOT:work,AI_HUB_CODEAGENT_COMMAND:path.join(root,'missing-cli.cmd'),AI_HUB_CODEAGENT_CONFIG_DIR:path.join(root,'personal'),AI_HUB_CODEAGENT_POOL_SCAN_ROOT:path.join(root,'scan'),
      CLAUDE_CONFIG_DIR:path.join(root,'unused-claude'),CODEX_HOME:path.join(root,'unused-codex'),HUB_SESSION_SEARCH_DISABLE_NATIVE:'1',
      CLAUDE_HUB_EGRESS_FIXTURE:JSON.stringify({domestic:{ok:false,errorCode:'offline_test',error:'offline fixture'},foreign:{ok:false,errorCode:'offline_test',error:'offline fixture'}}),
      CLAUDE_HUB_COMPANY_ASSISTANT:'1',CLAUDE_HUB_ASSISTANT_TIMER:'0',CLAUDE_HUB_FORUM_TIMER:'0',CLAUDE_HUB_WELINK_CLI:welink,
    }});result.hubPid=hub.pid;result.root=root;record();
    timer=setTimeout(()=>{try{audit();}catch(e){auditError=e;}},45000);
    c=await connectFirstPage(hub);audit();await c.send('Network.enable');await c.send('Network.setBlockedURLs',{urls:['http://*','https://*']});
    const q=s=>`document.querySelector(${JSON.stringify(s)})`;
    const until=async(expr,label)=>{for(const end=Date.now()+30000;Date.now()<end;){if(auditError)throw auditError;if(await c.eval(expr))return;await _waitMs(120);}throw Error('timeout '+label+': '+await c.eval(`${q('[data-m="message"]')}?.textContent`));};
    const click=async selector=>{await until(`(()=>{const e=${q(selector)};if(!e||e.disabled)return false;e.scrollIntoView({block:'nearest'});return e.getBoundingClientRect().width>0;})()`,selector);const point=await c.eval(`(()=>{const e=${q(selector)},r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);if(!(e===h||e.contains(h)))throw Error('covered '+${JSON.stringify(selector)});return{x,y};})()`);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});};
    const shot=async name=>{await _waitMs(160);const image=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(image.data,'base64'));result.screenshots.push(name+'.png');record();};
    const resize=width=>c.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    const noOverflow=async()=>assert.deepEqual(await c.eval(`['.company-meeting','.meeting-columns','.meeting-evidence-pane','.meeting-understanding','.meeting-flow',...Array.from(document.querySelectorAll('[data-answer]')).map(e=>'[data-answer="'+e.dataset.answer+'"]')].filter(s=>{const e=document.querySelector(s);return e&&e.clientWidth&&e.scrollWidth>e.clientWidth+2})`),[],'no horizontal overflow');
    const card=id=>`[data-answer="${id}"]`;
    const minutes=async label=>{const revision=await c.eval('m3Fixture.advanceMinutes()');await until(`${q('[data-m="understanding-status"]')}?.textContent.startsWith('第 ${revision} 版')`,label);assert.equal(await c.eval(`${q('.company-meeting')}.dataset.recording`),'true');(result.minutesProgress ||= []).push({label,revision});};
    const allScreens=async label=>{for(const width of [1440,1280]){await resize(width);await _waitMs(120);if(await c.eval(`${q('[data-act-local="latest"]')}?.offsetWidth>0`))await click('[data-act-local="latest"]');await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:580,y:100});await noOverflow();await shot(label+'-'+width);}await resize(1440);};
    await resize(1440);await c.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await until(`!!${q('#btn-company-meeting')}`,'meeting nav');await c.eval('('+fixtureFunction+')()');await c.eval('('+installAsideFixture.toString()+')()');
    const initialSessions=await c.eval(`ipcRenderer.invoke('get-sessions')`);
    await click('#btn-company-meeting');await until(`${q('[data-m="source"]')}?.options.length===1`,'fixture source');
    const questionEntry='[data-act-local="open-question-agent"]';
    const assertQuestionEntry=async(hidden,label)=>{
      await until(`(()=>{const e=${q(questionEntry)};return e&&e.hidden===${hidden}&&${hidden ? 'e.getBoundingClientRect().width===0' : '!e.disabled&&e.getBoundingClientRect().width>0'};})()`,label);
      const entry=await c.eval(`(()=>{const e=${q(questionEntry)},r=e.getBoundingClientRect();return {hidden:e.hidden,disabled:e.disabled,width:r.width,height:r.height,menuOpen:${q('[data-m="more"]')}.open};})()`);
      assert.equal(entry.menuOpen,true,'inspect question-session entry in the open More menu');
      assert.equal(entry.hidden,hidden);assert.equal(entry.disabled,hidden);
      if(hidden)assert.equal(entry.width,0,'hidden question-session entry takes no layout width');
      else assert.ok(entry.width>0,'legacy question-session entry is actually visible');
      (result.questionSessionEntry ||= []).push({label,...entry});
    };
    await click('[data-m="more"] > summary');await assertQuestionEntry(true,'idle meeting has no question session entry');
    await click('[data-m="more"] > summary');
    await c.eval(`${q('[data-m="system"]')}.checked=false;${q('[data-m="mic"]')}.checked=false;`);
    await click('[data-act="start"]');await until(`${q('.company-meeting')}?.dataset.phase==='live'`,'recording');
    if(await c.eval(`${q('[data-act-local="dismiss"]')}?.offsetWidth>0`))await click('[data-act-local="dismiss"]');
    const legacyQuestionSessionId=await c.eval('m3Fixture.current.questionSessionId');
    assert.ok(legacyQuestionSessionId,'legacy fixture provides a question session id');
    await click('[data-m="more"] > summary');await assertQuestionEntry(false,'legacy question session visible and enabled');
    await c.eval('m3Fixture.current.questionSessionId=null');await assertQuestionEntry(true,'new meeting without question session hides entry');
    for(const width of [1440,1280]){await resize(width);await assertQuestionEntry(true,'new meeting menu at '+width);await shot('00-new-meeting-menu-'+width);}
    await resize(1440);
    await c.eval(`m3Fixture.current.questionSessionId=${JSON.stringify(legacyQuestionSessionId)}`);await assertQuestionEntry(false,'restoring legacy question session restores entry');
    await click('[data-m="more"] > summary');
    result.checks.push('question-session entry is hidden with zero layout width for idle/new meetings; legacy session id restores a visible enabled entry; no session-opening click issued');
    assert.equal(await c.eval(`${q('[data-m="question"]')}.placeholder`),'问一下这场会议，不打断纪要');
    await click('[data-act="understand"]');
    const questions=['35% 是按哪个周期算的？','高速用户的门限有没有人提过具体数？','上周评审的结论是什么？'];
    for(let i=0;i<questions.length;i++){
      if(i===0)await c.eval('m3Fixture.holdNextAsk=true');
      if(i!==1){await click('[data-m="question"]');await c.send('Input.insertText',{text:questions[i]});}
      await click('[data-act="ask"]');
      if(i===0){
        await until('m3Fixture.askHeld','delayed first submission');await click('[data-m="question"]');
        for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
        await c.send('Input.insertText',{text:questions[1]});await c.eval('m3Fixture.releaseAsk()');
      }
      await until(`document.querySelectorAll('[data-answer]').length===${i+1}`,'question '+(i+1)+' in timeline');
      assert.equal(await c.eval(`${q('[data-m="question"]')}.value`),i===0?questions[1]:'');await minutes('while question '+(i+1)+' queued/running');
    }
    assert.deepEqual(await c.eval(`m3Fixture.current.answers.map(q=>q.q)`),questions);
    assert.deepEqual(await c.eval(`m3Fixture.current.answers.map(q=>q.state)`),['running','queued','queued']);
    assert.deepEqual(await c.eval(`Array.from(document.querySelectorAll('[data-answer]')).map(e=>e.dataset.questionState)`),['running','queued','queued']);
    assert.match(await c.eval(`${q(card('aside-1'))}.textContent`),/回答中|正在/);
    assert.equal(await c.eval(`document.querySelectorAll('[data-question-state="running"] .meeting-question-dots').length`),1,'only the running question has activity dots');
    assert.equal(await c.eval(`document.querySelectorAll('[data-question-state="queued"] .meeting-question-dots').length`),0,'queued questions have no activity dots');
    const queueTexts=()=>c.eval(`['aside-2','aside-3'].map(id=>document.querySelector('[data-answer="'+id+'"] .meeting-question-thinking')?.textContent.trim())`);
    const assertQueueAhead=async(expected,label)=>{
      const texts=expected.map(n=>'排队中 · 前面还有 '+n+' 个问题，可继续提问');
      await until(`JSON.stringify(['aside-2','aside-3'].map(id=>document.querySelector('[data-answer="'+id+'"] .meeting-question-thinking')?.textContent.trim()))===${JSON.stringify(JSON.stringify(texts))}`,label);
      assert.deepEqual(await queueTexts(),texts);
      assert.equal(await c.eval(`Array.from(document.querySelectorAll('[data-question-state="queued"]')).some(el=>el.textContent.includes('等待回答'))`),false,'queued cards never say waiting for answer');
      (result.queueProgress ||= []).push({label,ahead:expected,texts:await queueTexts()});
    };
    await assertQueueAhead([1,2],'initial second/third queue positions');
    assert.equal(await c.eval(`Array.from(document.querySelectorAll('[data-m="timeline"] [data-answer]')).map(e=>e.dataset.answer).join(',')`),'aside-1,aside-2,aside-3');
    await until(`${q('[data-m="question-pending"]')}?.textContent.includes('3')`,'pending count 3');
    result.checks.push('three real input submissions remain in timeline with running/queued states; input typed while delayed IPC waits is preserved; minutes revisions advance during recording');await allScreens('01-queued');
    const answer='按 20 ms 周期核对，王工负责补测方案 B。 [事件 5] [画面 00:13]';
    const pendingBefore=await c.eval('JSON.stringify(m3Fixture.current.answers.slice(1))');
    await c.eval(`m3Fixture.setQuestion(0,'done',${JSON.stringify(answer)});`);
    await assertQueueAhead([0,1],'first done updates unchanged queued cards');
    assert.equal(await c.eval('JSON.stringify(m3Fixture.current.answers.slice(1))'),pendingBefore,'queued question data stays unchanged when predecessor finishes');
    assert.deepEqual(await c.eval(`['aside-2','aside-3'].map(id=>document.querySelector('[data-answer="'+id+'"]').dataset.questionState)`),['queued','queued']);
    result.checks.push('queued copy shows second N=1 / third N=2, then N=0 / N=1 after first completes without modifying queued question data; no waiting-for-answer wording');
    await c.eval(`m3Fixture.current.answers[0].truncated=true;m3Fixture.setQuestion(1,'running');m3Fixture.setQuestion(2,'error','已收到部分：旧评审还需核实。','CodeAgent 暂时没有响应。');`);
    await until(`!!${q('[data-copy-answer="aside-1"]')}&&!!${q('[data-retry-question="aside-3"]')}`,'done/running/error card actions');
    assert.match(await c.eval(`${q(card('aside-3'))}.textContent`),/纪要不受影响/);
    assert.match(await c.eval(`${q(card('aside-3'))}.textContent`),/已收到部分：旧评审还需核实。/);
    assert.match(await c.eval(`${q(card('aside-3'))}.textContent`),/CodeAgent 暂时没有响应/);
    assert.match(await c.eval(`${q(card('aside-1'))}.textContent`),/截断|不完整|部分内容/);
    await c.eval('m3Fixture.current.job=null');await until(`${q('.company-meeting')}.dataset.thinking==='false'`,'question alone does not animate minutes');
    await minutes('mixed done/running/error');
    await allScreens('02-three-states');
    await click('[data-copy-answer="aside-1"]');await until('m3Fixture.clipboard.length===1','mock clipboard');
    result.copied=await c.eval('m3Fixture.clipboard[0]');assert.match(result.copied,/王工负责补测方案 B/);assert.doesNotMatch(result.copied,/\[(?:事件|画面)/);assert.doesNotMatch(result.copied,/复制|追问|单独回答/);
    await c.eval('m3Fixture.failClipboard=true');await click('[data-copy-answer="aside-1"]');await until(`${q('[data-m="message"]')}.textContent.includes('模拟复制失败')`,'copy failure visible');
    assert.equal(await c.eval('m3Fixture.clipboard.length'),1,'failed copy never records success');await c.eval('m3Fixture.failClipboard=false');
    await click('[data-followup-question="aside-1"]');assert.equal(await c.eval(`${q('[data-m="question"]')}.value`),questions[0]);assert.equal(await c.eval('m3Fixture.current.answers.length'),3,'follow-up prefills without auto-submitting');
    await c.eval(`${q('[data-m="question"]')}.value=''`);
    const cite=card('aside-1')+' .ca-link[data-event="5"]';assert.equal(await c.eval(`${q(cite)}.textContent`),'事件 5');assert.match(await c.eval(`${q(cite)}.title||${q(cite)}.dataset.hubTip`),/^跳到 00:17$/);
    await click(cite);await until(`${q('[data-m="viewer-label"]')}?.textContent.includes('00:17')`,'event citation destination');
    const frame=card('aside-1')+' .ca-link[data-play-at="13000"]';assert.equal(await c.eval(`${q(frame)}.textContent`),'画面 00:13');await click(frame);
    await until(`m3Fixture.calls.some(x=>x.channel==='company-assistant:meeting-playback'&&x.args.at===13000)`,'frame timestamp dispatch');
    // The synthetic live recording may not have a completed replay segment yet; verify exact V7 dispatch without inventing a video.
    result.checks.push('copy success/failure stays in mock clipboard without raw bracket citations; follow-up prefills original question; V7 event jumps and frame timestamp dispatch preserved');
    const animations=()=>c.eval(`(()=>{const roots=[document.querySelector('[data-m="question-pending"]'),document.querySelector('[data-answer="aside-2"]')].filter(Boolean),a=[];for(const root of roots)for(const el of [root,...root.querySelectorAll('*')])for(const pseudo of [null,'::before','::after']){const s=getComputedStyle(el,pseudo);if(s.animationName!=='none')a.push({tag:el.tagName,cls:el.className,pseudo,name:s.animationName,duration:s.animationDuration,playState:s.animationPlayState});}return a;})()`);
    result.motionNormal=await animations();assert.ok(result.motionNormal.some(a=>parseFloat(a.duration)>0&&a.playState!=='paused'),'question progress animates normally');
    await c.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    result.motionReduced=await animations();assert.ok(result.motionReduced.every(a=>a.duration.split(',').every(d=>parseFloat(d)<=0.001)||a.playState==='paused'),'question dots/spinner stop for reduced motion');await shot('03-reduced-motion');
    await c.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await click('[data-retry-question="aside-3"]');await until(`m3Fixture.current.answers[2].state==='queued'`,'retry queues original');
    assert.equal(await c.eval('m3Fixture.current.answers.length'),3);assert.equal(await c.eval(`${q(card('aside-3'))}.dataset.answer`),'aside-3');
    await c.eval(`m3Fixture.setQuestion(1,'done','门限尚未明确。 [事件 2]');m3Fixture.setQuestion(2,'running');`);await minutes('retry while minutes continue');
    await c.eval(`m3Fixture.setQuestion(2,'done','旧评审结论仍需核对。 [事件 5]');`);
    await until(`!!${q('[data-copy-answer="aside-3"]')}&&(!${q('[data-m="question-pending"]')}||${q('[data-m="question-pending"]')}.hidden||!${q('[data-m="question-pending"]')}.offsetHeight)`,'retry completion clears pending');
    assert.equal(await c.eval(`document.querySelectorAll('[data-answer]').length`),3);assert.deepEqual(await c.eval('m3Fixture.current.answers.map(q=>q.state)'),['done','done','done']);
    await click(card('aside-1')+' summary');assert.equal(await c.eval(`${q(card('aside-1'))}.open`),false);await minutes('collapsed answer persists across minute refresh');assert.equal(await c.eval(`${q(card('aside-1'))}.open`),false);
    assert.ok(await c.eval(`m3Fixture.calls.filter(x=>x.channel==='company-assistant:meeting-control').every(x=>!['pause','stop'].includes(x.args.op))`));
    assert.deepEqual(await c.eval(`ipcRenderer.invoke('get-sessions')`),initialSessions);
    result.checks.push('partial answer and error reason coexist; truncated answer warns; question-only does not animate minutes; retry uses original card/id; all done clears pending; details collapse survives refresh; reduced motion stops indicators; recording and minutes never stopped');
    await allScreens('04-all-done');audit();result.calls=await c.eval(`m3Fixture.calls.filter(x=>!x.channel.endsWith('meeting-status')&&!x.channel.endsWith('meeting-capture'))`);result.passed=true;
  } catch(error){result.error=error.stack;process.exitCode=1;if(c)try{const image=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'failure.png'),Buffer.from(image.data,'base64'));}catch{}}
  finally{
    clearTimeout(timer);if(c)await c.eval('clearInterval(window.m3DrawTimer)').catch(()=>{});
    try{if(hub){result.teardown=await gracefulQuit(hub);result.postTeardownAudit=windowAudit();assert.deepEqual(result.postTeardownAudit.processIds,[],'owned process tree exited');}}
    catch(error){result.teardownError=error.message;result.passed=false;process.exitCode=1;}
    if(c)await c.close();record();console.log(JSON.stringify({passed:result.passed,checks:result.checks.length,out,error:result.error||null,teardown:result.teardown}));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
