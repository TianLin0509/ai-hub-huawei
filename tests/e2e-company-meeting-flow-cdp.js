'use strict';
// Real isolated Hub renderer and mouse input; meeting data / AI / external actions are explicit IPC fixtures.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve(process.argv[2] || 'artifacts/meeting-flow-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

function installFixture() {
  const original = ipcRenderer.invoke.bind(ipcRenderer);
  const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
  const ctx = canvas.getContext('2d');
  const draw = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 960, 540); ctx.fillStyle = '#e5484d'; ctx.fillRect(40, 40, 5, 38); ctx.fillStyle = '#233044'; ctx.font = '28px Microsoft YaHei'; ctx.fillText('算法比较 · 界面验收夹具', 60, 70); ctx.fillStyle = '#3478f6'; ctx.fillRect(80, 160, 490, 52); ctx.fillRect(80, 250, 350, 52); ctx.fillStyle = '#cbd5e5'; ctx.fillRect(80, 340, 260, 52); ctx.font = '22px Microsoft YaHei'; ctx.fillStyle = '#64748b'; ctx.fillText('示意数据，非模型测量', 80, 470); };
  draw(); window.m3DrawTimer = setInterval(draw, 250);
  const image = canvas.toDataURL('image/jpeg').split(',')[1];
  navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(5);
  const make = id => ({ id, title: id === 'fixture-live' ? '界面验收夹具 · 算法评审' : '历史会议夹具', sourceName: '合成共享画面', startedAt: Date.now() - 120000, state: 'recording', capturedMs: 120000, transcribedMs: 110000, understoodMs: 100000, cursor: 8, revision: 1, speed: 'normal', autoUnderstand: true, autoIntervalMin: 3, audio: [], sessionId: 'understanding-fixture', questionSessionId: 'question-fixture', agent: { state: 'ready' }, questionAgent: { state: 'ready' },
    summary: '## 议题\n- 算法取舍 [事件 2]\n- 补测与分工 [事件 5]\n\n## 结论\n算法 A 暂不采用，继续对照方案 B。 [事件 2]\n\n## 待确认\n不同信道种子的稳定性还需要验证。 [事件 5]\n\n## 行动项\n王工补测，周三回看结果。 [事件 5]',
    events: [{seq:1,kind:'slide',at:1000},{seq:2,kind:'transcript',at:4000,track:'system',text:'算法 A 暂不采用，先比较方案 B。'},{seq:3,kind:'transcript',at:8000,track:'mic',text:'下一步用相同信道种子对照。'},{seq:4,kind:'slide',at:13000},{seq:5,kind:'mark',at:17000,text:'王工补测方案 B，周三给出结果。'},{seq:6,kind:'transcript',at:22000,track:'system',text:'检查重传率、时延和吞吐。'}],
    answers: [], recording: { bytes:0, savedThrough:0, segments:[], gaps:[], full:null } });
  const fixture = window.m3Fixture = { meetings: {}, calls: [], current: null, image, parts: new Map(), failPpt: false, failSave: false };
  fixture.meetings['fixture-old'] = { ...make('fixture-old'), state: 'ended', summary: '## 历史结论\n之前已经结束。 [事件 2]' };
  ipcRenderer.invoke = async (channel, args = {}) => {
    if (!channel.startsWith('company-assistant:meeting-') && !['company-assistant:ppt-lookup-frame','company-assistant:ppt-open'].includes(channel)) return original(channel, args);
    fixture.calls.push({ channel, args: { ...args, data: args.data ? '<omitted>' : undefined } });
    const op = channel.slice('company-assistant:'.length);
    if (op === 'meeting-sources') return { ok:true, sources:[{id:'fixture-screen',name:'合成共享画面',thumbnail:'data:image/jpeg;base64,'+image}] };
    if (op === 'meeting-status') return { ok:true, meeting:args.id ? fixture.meetings[args.id] : null, meetings:Object.values(fixture.meetings), asr:{ready:true}, models:[{id:'fixture-fast',label:'快速模型夹具'},{id:'fixture-normal',label:'标准模型夹具'}], defaultFastModel:'fixture-fast' };
    if (op === 'meeting-start') { const m = make('fixture-live'); fixture.current = m; fixture.meetings[m.id] = m; return {ok:true,meeting:m}; }
    const m = fixture.meetings[args.id];
    if (op === 'meeting-capture') {
      if (fixture.failSave) throw Error('保存失败夹具');
      if (args.kind === 'recording-start') { const part = {key:args.key,at:args.at,end:args.at,status:'writing',bytes:0,chunks:[],full:args.full,mime:args.mime}; fixture.parts.set(args.key,part); if(args.full)m.recording.full=part;else m.recording.segments.push(part); }
      else if (args.kind === 'recording-chunk') { const p=fixture.parts.get(args.key);p.chunks.push(Buffer.from(args.data,'base64'));p.bytes+=Buffer.byteLength(args.data,'base64');m.recording.bytes+=Buffer.byteLength(args.data,'base64');m.recording.savedThrough=args.at;p.end=args.at; }
      else if (args.kind === 'recording-finish') { const p=fixture.parts.get(args.key);p.end=args.at;p.status='ready';p.url=URL.createObjectURL(new Blob(p.chunks,{type:p.mime})); }
      else if (['mark','slide'].includes(args.kind)) m.events.push({ ...args, seq:Math.max(...m.events.map(e=>e.seq))+1 });
      return {ok:true,meeting:m};
    }
    if (op === 'meeting-control') {
      if (args.op === 'pause') m.state='paused';
      if (args.op === 'resume') m.state='recording';
      if (args.op === 'stop') { m.state='ended';m.job=null;m.questionJob=null; }
      if (args.op === 'speed') m.speed=args.value;
      if (args.op === 'fast-model') m.fastModel=args.value;
      if (args.op === 'interval') {m.autoIntervalMin=args.value;m.autoUnderstand=!!args.value;}
      if (args.op === 'understand') {m.job={kind:'understand',state:'running',sentAt:Date.now()};}
      if (args.op === 'ask') {m.answers.push({id:'question-'+m.answers.length,q:args.value,state:'running',queuedAt:Date.now()});m.questionJob={kind:'question',state:'running',sentAt:Date.now()};}
      if (args.op === 'retry-question') {const q=m.answers.find(q=>q.id===args.value);q.state='done';q.answer='王工负责补测方案 B。 [事件 5]';q.error='';m.questionJob=null;}
      return {ok:true,meeting:m};
    }
    if (op === 'meeting-asset') return {ok:true,data:image,path:'D:/fixture/meeting-slide.jpg'};
    if (op === 'meeting-frames') return {ok:true,frames:[{at:args.timesMs[0],data:image,path:'D:/fixture/extracted.jpg'}]};
    if (op === 'meeting-playback') {const segment=m.recording.segments.find(p=>p.status==='ready'&&p.at<=args.at&&p.end>args.at)||m.recording.segments.find(p=>p.status==='ready');if(!segment)throw Error('没有可播放片段');return {ok:true,segment,url:segment.url,offsetMs:100};}
    if (op === 'ppt-lookup-frame') {if(fixture.failPpt)throw Error('Doctor不可用夹具');return {ok:true,candidates:[{id:'fixture-ppt',ref:{name:'算法评审.pptx',page:3},snippet:'候选原稿，请核对画面'}]};}
    if (op === 'ppt-open') return {ok:true,pageFocused:false};
    return {ok:true};
  };
}

(async () => {
  fs.mkdirSync(out,{recursive:true}); let hub,c;
  const result = {passed:false,evidence:'real isolated Hub UI with synthetic meeting/AI IPC fixtures; no model calls',checks:[]};
  const record = () => fs.writeFileSync(path.join(out,'meeting-flow-cdp.json'),JSON.stringify(result,null,2));
  try {
    const testRoot=fs.mkdtempSync(path.join(os.tmpdir(),'meeting-flow-ui-')),dataDir=path.join(testRoot,'data'),welinkStub=path.join(testRoot,'welink-disabled.js');
    fs.mkdirSync(dataDir);fs.writeFileSync(path.join(dataDir,'optional-features.json'),JSON.stringify({assistant:false,forum:false}));
    fs.writeFileSync(welinkStub,'process.stdout.write(JSON.stringify({ authenticated:false, loggedIn:false }));');
    hub=await launchIsolatedHub({dataDir,port:await freePort(),windowMode:'hidden',label:'meeting C fixture',extraEnv:{CLAUDE_HUB_COMPANY_ASSISTANT:'1',CLAUDE_HUB_ASSISTANT_TIMER:'0',CLAUDE_HUB_FORUM_TIMER:'0',CLAUDE_HUB_WELINK_CLI:welinkStub}});
    result.hubPid=hub.pid;record();c=await connectFirstPage(hub);
    const until=async(expr,label)=>{for(const end=Date.now()+30000;Date.now()<end;){if(await c.eval(expr))return;await _waitMs(200);}throw Error('timeout '+label+': '+await c.eval('document.querySelector("[data-m=message]")?.textContent'));};
    const click=async(selector)=>{const p=await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('missing/disabled '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('hidden '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...p});};
    const shot=async(name)=>{await _waitMs(200);const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
    const noOverflow=async()=>assert.deepEqual(await c.eval(`['.company-meeting','.meeting-columns','.meeting-evidence-pane','.meeting-understanding','.meeting-flow'].filter(s=>{const e=document.querySelector(s);return e.clientWidth&&e.scrollWidth>e.clientWidth+2})`),[],'no horizontal overflow');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    result.systemReducedMotion = await c.eval(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
    await c.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await until('!!document.getElementById("btn-company-meeting")','nav');await c.eval('('+installFixture.toString()+')()');await click('#btn-company-meeting');
    await until('document.querySelector("[data-m=source]")?.options.length===1','setup');await noOverflow();await shot('01-idle');
    await c.eval(`document.querySelector('[data-m=system]').checked=false;document.querySelector('[data-m=mic]').checked=false;`);
    await click('[data-act=start]');await until('document.querySelector(".company-meeting").dataset.phase==="live"','live');
    await click('[data-act-local=dismiss]');await until('document.querySelectorAll("[data-topic]").length===2','topics');await noOverflow();await shot('02-live');
    assert.ok(await c.eval(`document.querySelector('.company-meeting').dataset.recording==='true'`));
    result.checks.push('idle/live states and grounded topic links at 1440px');
    const activity = async (job, questionJob, expected, label, reducedMotion = false) => {
      const revision = await c.eval(`(()=>{const m=m3Fixture.current;m.job=${JSON.stringify(job)};m.questionJob=${JSON.stringify(questionJob)};return ++m.revision;})()`);
      await until(`document.querySelector('[data-m=understanding-status]').textContent.startsWith('第 ${revision} 版')`,label+' refresh');
      const actual = await c.eval(`({thinking:document.querySelector('.company-meeting').dataset.thinking,animation:getComputedStyle(document.querySelector('[data-m=understanding-status]'),'::after').animationName})`);
      assert.equal(actual.thinking,String(expected),label);
      assert.equal(actual.animation,expected&&!reducedMotion?'meeting-ai-flow':'none',label+' animation');
      (result.activity ||= []).push({label,...actual});
    };
    const prime={kind:'prime',state:'running'}, understanding={kind:'understand',state:'running'}, question={kind:'question',state:'running'};
    await activity(prime,null,false,'understanding session prewarm');
    await activity(null,prime,false,'question session prewarm');
    await activity(prime,prime,false,'both sessions prewarm');await shot('08-prime');
    await activity(understanding,prime,true,'understanding alongside question prewarm');
    await activity(prime,question,true,'question alongside understanding prewarm');
    await c.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await activity(understanding,null,true,'real task with reduced motion',true);
    await c.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await activity({...understanding,state:'error'},{...question,state:'error'},false,'failed tasks');
    await activity(null,null,false,'idle tasks');
    assert.ok(await c.eval(`!!document.querySelector('.meeting-summary-heading [data-act=export]')`),'live export stays in minutes');
    await click('[data-act=export]');await until('m3Fixture.calls.filter(x=>x.channel==="company-assistant:meeting-export").length===1','live export');
    result.checks.push('prewarm in either lane stays static; real understanding/question animates even alongside prewarm; errors stop animation; live export retained');
    await click('[data-m=more] > summary');await shot('03-more');
    for(const [name,value] of [['interval','5'],['fast-model','fixture-fast']])await c.eval(`(()=>{const e=document.querySelector('[data-m=${name}]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.ok(await c.eval('m3Fixture.current.autoIntervalMin===5 && m3Fixture.current.fastModel==="fixture-fast"'));
    await click('[data-act-local=toggle-transcript]');assert.ok(await c.eval(`document.querySelector('.company-meeting').dataset.hideTranscripts==='true'`));
    await click('[data-act-local=toggle-transcript]');await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert.ok(await c.eval(`!document.querySelector('[data-m=more]').open`));
    await click('[data-speed=fast]');await until('m3Fixture.current.speed==="fast"','speed');await click('[data-speed=normal]');await click('[data-speed=deep]');
    await click('[data-act=understand]');await until('document.querySelector(".company-meeting").dataset.thinking==="true"','thinking');
    await c.eval(`document.querySelector('[data-m=question]').value='下一步谁负责？'`);await click('[data-act=ask]');await until('!!document.querySelector("[data-answer]")','question in stream');await shot('04-thinking');
    assert.ok(await c.eval('m3Fixture.current.job.kind==="understand" && m3Fixture.current.questionJob.kind==="question"'));
    await c.eval(`m3Fixture.current.answers[0].state='error';m3Fixture.current.answers[0].error='回答失败夹具';m3Fixture.current.questionJob.state='error';`);
    await until('!!document.querySelector("[data-retry-question]")','retry');await click('[data-retry-question]');await until('document.querySelector("[data-answer]").textContent.includes("王工")','retried answer');
    result.checks.push('More controls, Escape, transcript visibility, three speeds, parallel question UI and retry');
    await click('[data-answer] summary');
    await c.eval(`(()=>{m3Fixture.current.events.push(...Array.from({length:45},(_,n)=>({seq:200+n,kind:'transcript',at:30000+n*1000,track:'system',text:'回看位置验收 '+n})));m3Fixture.current.job=null;})()`);
    await until('document.querySelectorAll(".meeting-flow-event").length>45','long stream');
    await c.eval(`document.querySelector('[data-m=timeline]').scrollTop=100;window.m3Anchor=document.querySelector('[data-flow-key="event-200"]');window.m3AnchorTop=m3Anchor.getBoundingClientRect().top;`);
    await c.eval(`m3Fixture.current.events.push({seq:300,kind:'transcript',at:99000,track:'mic',text:'新增一句，不打断回看'});`);
    await until('!!document.querySelector("[data-flow-key=event-300]")','append');
    result.scroll = await c.eval(`({before:m3AnchorTop,after:m3Anchor.getBoundingClientRect().top,scrollTop:document.querySelector('[data-m=timeline]').scrollTop,scrollHeight:document.querySelector('[data-m=timeline]').scrollHeight,clientHeight:document.querySelector('[data-m=timeline]').clientHeight})`);
    assert.ok(Math.abs(result.scroll.after-result.scroll.before)<2,'preserve reading position: '+JSON.stringify(result.scroll));
    assert.ok(await c.eval(`!document.querySelector('[data-answer]').open`),'preserve closed answer on append');
    await click('[data-act-local=latest]');
    await c.eval('m3Fixture.current.events=m3Fixture.current.events.filter(e=>e.seq<200)');
    await until('document.querySelectorAll(".meeting-flow-event").length<20','remove scroll stress fixture');
    await click('[data-answer] summary');
    await click('[data-act=pause]');await until('document.querySelector(".company-meeting").dataset.recording==="false"','pause animation');await shot('05-paused');
    await click('[data-act=pause]');await until('document.querySelector(".company-meeting").dataset.recording==="true"','resume animation');
    await click('[data-act=stop]');await until('document.querySelector(".company-meeting").dataset.phase==="review"','review');await click('[data-act-local=dismiss]');
    if(await c.eval(`document.querySelector('.meeting-viewer').classList.contains('is-expanded')`))await click('[data-act-local=expand-viewer]');
    await shot('06-review');await noOverflow();
    assert.ok(await c.eval(`document.querySelector('.company-meeting').dataset.thinking==='false'`));
    assert.ok(await c.eval(`(()=>{const e=document.querySelector('.meeting-topbar [data-act=export]');return e&&e.classList.contains('primary')&&e.innerText.trim()==='导出纪要'&&e.getBoundingClientRect().width>80&&!e.disabled&&document.querySelectorAll('[data-act=export]').length===1;})()`),'review export is one visible text primary action in topbar');
    await click('[data-act=open-full]');await click('.meeting-topbar [data-act=export]');
    await until('m3Fixture.calls.filter(x=>x.channel==="company-assistant:meeting-export").length===2','review export');
    await click('[data-topic="2"]');await until('document.querySelector("[data-m=viewer-label]").textContent.includes("00:04")','topic evidence');
    await click('[data-find-ppt="1"]');await until('!!document.querySelector("[data-ppt-open]")','PPT lookup');await noOverflow();await shot('07-evidence');
    assert.ok(await c.eval(`document.querySelector('.meeting-slide').getBoundingClientRect().height>=140`),'evidence remains readable with candidate list');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await noOverflow();
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await click('[data-m=more] > summary');await c.eval(`(()=>{const e=document.querySelector('[data-m=history]');e.value='fixture-old';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until('document.querySelector("[data-m=session-title]").textContent==="历史会议夹具"','history');assert.equal(await c.eval('document.querySelectorAll("[data-answer]").length'),0);
    await click('[data-act=new]');await until('document.querySelector(".company-meeting").dataset.phase==="idle"','new meeting');
    result.checks.push('scroll anchoring, answer expansion, recording/AI animation lifetimes, full recording/export, topic evidence, history and new meeting');
    result.calls=await c.eval('m3Fixture.calls.filter(c=>!c.channel.endsWith("meeting-status")&&!c.channel.endsWith("meeting-capture"))');
    result.passed=true;
  } catch(e) {result.error=e.stack;if(e.logTail)result.launchLog=e.logTail;if(e.termination)result.launchTermination=e.termination;process.exitCode=1;if(c){try{const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'failure.png'),Buffer.from(shot.data,'base64'));}catch{}}}
  finally {if(c)await c.eval('clearInterval(window.m3DrawTimer)').catch(()=>{});try{if(hub)result.teardown=await gracefulQuit(hub);}catch(e){result.teardownError=e.message;result.passed=false;process.exitCode=1;}if(c)await c.close();record();console.log(JSON.stringify({passed:result.passed,checks:result.checks,error:result.error,teardown:result.teardown}));}
})().catch(e=>{console.error(e);process.exitCode=1;});
