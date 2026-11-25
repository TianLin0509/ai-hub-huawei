'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {MeetingCompanion}=require('../core/company-assistant/meeting');
const {createAskAsideService,runAsk}=require('../main/ask-aside/service');
const {freshTarget}=require('../main/ask-aside/fresh-target');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {StreamCapabilities}=require('../main/ask-aside/stream-capabilities');
const turn=()=>new Promise(r=>setImmediate(r));
function fixture(t,{run,kind='codeagent',applyGatewayEnv}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'m2-q-flow-')),cfg=path.join(root,'cfg');fs.mkdirSync(cfg);const sessions=new Map(),entries=new Map(),events=[],calls=[];
 let service;const deps={dataDir:root,powerSaveBlocker:false,meetingModels:()=>[{id:'model',label:'model'}],meetingTerminals:()=>({codeagent:true,claude:[{id:'model',label:'model'}]}),
  meetingAsr:{status:()=>({ready:false}),close(){}},getSession:id=>sessions.get(id),getSessionMetadata:id=>sessions.get(id),getMeetingAskAside:()=>service};
 const m=new MeetingCompanion({dir:root,workspace:root,deps:{dataDir:root},changed(){},sessionBusy:()=>false,lastFinal:()=>null},deps);
 m.tools={start:async()=>{},bind(){},close(){}};m.tick=async()=>{};
 const meeting=m.create({title:'question test',speed:'deep'});clearInterval(m.timer);m.timer=1;
 Object.assign(meeting,{autoUnderstand:false,primeRequested:false,agent:{state:'error'},summary:'纪要：由小王周五前完成。',engine:kind+'|model'});m.event(meeting,'transcript',{at:0,end:100,text:'小王负责，周五前。',track:'system'});m.save(meeting);
 const source={id:meeting.sessionId,kind,cwd:root,agentRuntime:'pty',currentModel:{id:'model'}};sessions.set(source.id,source);
 entries.set(source.id,{confirmedExit:{code:1},askAsideEnv:{CLAUDE_CONFIG_DIR:cfg}});
 service=createAskAsideService({sessionManager:{getSession:id=>sessions.get(id),sessions:entries},getSessionMetadata:id=>sessions.get(id),getHubDataDir:()=>root,
  resolveConfig:()=>({command:'fake-codeagent',configDir:cfg,configDirEnv:'CODEAGENT3_CONFIG_DIR'}),findCommand:()=> 'fake-claude',hasHistory:()=>true,
  resolveClaudeProfile:()=>({home:cfg,networkEnv:{}}),
  resolveMode:()=>({input:'stdin'}),...(applyGatewayEnv?{applyGatewayEnv}:{}),sendToRenderer:(ch,p)=>events.push({ch,p}),run:async o=>{calls.push(o);return run?run(o):{answer:'小王，周五前。'};}});
 t.after(async()=>{m.close();await service.dispose();fs.rmSync(root,{recursive:true,force:true});});return{m,id:meeting.id,service,root,cfg,source,entries,sessions,events,calls};
}
test('快速档 fresh 绕过理解会话启动异常，流式只存内存，结束即回填并写后台日志',async t=>{
 let finish;const done=new Promise(r=>finish=r);const fx=fixture(t,{run:async o=>{o.onProcess({pid:42,command:'fake',args:['--token','secret'],cwd:fx.root});o.onChunk('部分首字');await done;return{answer:'完整答案'};}});
 fx.m.control(fx.id,'ask','谁负责？');await fx.m.runQuestion(fx.m.load(fx.id));await turn();
 const q=fx.m.load(fx.id).answers[0];assert.equal(q.speed,'fast');assert.equal(q.mode,'fresh');assert.equal(q.phase,'streaming');assert.equal(q.state,'running');assert.ok(q.firstTokenAt);
 assert.equal(fx.m.status(fx.id).meeting.answers[0].live.partial,'部分首字');
 assert.ok(!fs.readFileSync(path.join(fx.m.dir(fx.id),'meeting.json'),'utf8').includes('部分首字'));
 finish();await fx.service.drain();const final=fx.m.load(fx.id).answers[0];assert.equal(final.state,'done');assert.equal(final.answer,'完整答案');assert.equal(fx.m.load(fx.id).questionJob,null);
 assert.ok(fs.existsSync(path.join(fx.m.dir(fx.id),'question-logs',q.id+'.json')));const log=require('../core/company-assistant/meeting-questions').log(fx.m,{meetingId:fx.id,questionId:q.id});assert.equal(log.meta.pid,42);assert.ok(!log.meta.command.includes('secret'));
 assert.equal(fx.calls[0].fresh,true);assert.equal(fx.calls[0].thinkingOff,true);assert.equal(fx.calls[0].effort,'low');assert.equal(fx.m.load(fx.id).speed,'deep');
});
test('问答档位独立、重答保留历史且最多5版；无效操作不污染活动对象',async t=>{
 const fx=fixture(t);fx.m.control(fx.id,'question-speed','normal');assert.equal(fx.m.load(fx.id).speed,'deep');
 fx.m.control(fx.id,'ask',{q:'谁负责？',speed:'fast'});await fx.m.runQuestion(fx.m.load(fx.id));await fx.service.drain();
 const id=fx.m.load(fx.id).answers[0].id;
 for(let i=0;i<6;i++){fx.m.control(fx.id,'reanswer',{id,speed:'fast',engine:'claude|model'});await fx.m.runQuestion(fx.m.load(fx.id));await fx.service.drain();}
 const q=fx.m.load(fx.id).answers[0];assert.equal(q.history.length,5);assert.equal(q.engine,'claude');assert.equal(q.state,'done');assert.equal(fx.calls.at(-1).config.flavor,'claude');
 assert.throws(()=>fx.m.control(fx.id,'reanswer',{id,speed:'invalid'}),/速度/);assert.equal(fx.m.load(fx.id).answers[0].history.length,5);
});
test('显式换引擎清掉旧model，原引擎选型不可用也能派发，engine始终是规范枚举',async t=>{
 const fx=fixture(t);fx.m.control(fx.id,'ask','初问');await fx.m.runQuestion(fx.m.load(fx.id));await fx.service.drain();const id=fx.m.load(fx.id).answers[0].id;
 fx.m.engineFor=()=>{throw Error('原引擎已不可用');};fx.m.control(fx.id,'reanswer',{id,engine:'claude|'});
 let q=fx.m.load(fx.id).answers[0];assert.equal(q.engine,'claude');assert.equal(q.model,'');await fx.m.runQuestion(fx.m.load(fx.id));await fx.service.drain();q=fx.m.load(fx.id).answers[0];assert.equal(q.state,'done');assert.equal(fx.calls.at(-1).model,'');assert.equal(q.model,'');
});
test('未派发的排队题也有live/queueAhead，重答的旧题排在正在答的题后面',async t=>{
 let finish;const fx=fixture(t,{run:()=>new Promise(r=>finish=r)});fx.m.control(fx.id,'ask','题一');await fx.m.runQuestion(fx.m.load(fx.id));await turn();fx.m.control(fx.id,'ask','题二');fx.m.control(fx.id,'ask','题三');
 const views=fx.m.status(fx.id).meeting.answers;assert.deepEqual(views.map(q=>q.live.queueAhead),[0,1,2]);assert.ok(views.every(q=>q.live.slot.max===3));
 const m=fx.m.load(fx.id);m.answers[0].state='queued';m.answers[1].state='running';m.questionJob.questionId=m.answers[1].id;fx.m.save(m);assert.deepEqual(fx.m.status(fx.id).meeting.answers.map(q=>q.live.queueAhead),[1,0,2]);
 const restore=fx.m.load(fx.id);restore.answers[0].state='running';restore.answers[1].state='queued';restore.questionJob.questionId=restore.answers[0].id;fx.m.save(restore);finish({answer:'完成'});await fx.service.drain();
});
test('入队写盘失败会释放会议预留位，普通问一下仍可正常三并发',async t=>{
 const releases=[];const fx=fixture(t,{run:()=>new Promise(resolve=>releases.push(resolve))});fx.m.control(fx.id,'ask','写盘故障');
 const write=fs.writeFileSync;fs.writeFileSync=function(file,...args){if(String(file).startsWith(path.join(fx.root,'ask-aside')))throw Error('fixture disk busy');return write.call(fs,file,...args);};
 try{await fx.m.runQuestion(fx.m.load(fx.id));}finally{fs.writeFileSync=write;}
 assert.equal(fx.m.load(fx.id).answers[0].state,'error');
 for(let i=0;i<3;i++){const id='ordinary-'+i;fx.sessions.set(id,{...fx.source,id,ccSessionId:'11111111-1111-4111-8111-111111111111'});fx.service.ask({sessionId:id,question:'ordinary'});}
 await turn();assert.equal(fx.calls.length,3);for(const resolve of releases)resolve({answer:'ok'});await fx.service.drain();
});
test('中等与深入保持原思考默认，fork 使用既有会话，问答不改纪要档位',async t=>{
 const fx=fixture(t);fx.source.ccSessionId='11111111-1111-4111-8111-111111111111';const entry=fx.entries.get(fx.source.id);entry.confirmedExit=null;entry.pty={};
 for(const tier of ['normal','deep']){fx.m.control(fx.id,'ask',{q:'核对负责人',speed:tier});await fx.m.runQuestion(fx.m.load(fx.id));await fx.service.drain();const call=fx.calls.at(-1);assert.equal(call.fresh,false);assert.equal(call.thinkingOff,false);assert.equal(call.effort,tier==='deep'?'high':'');assert.equal(fx.m.load(fx.id).answers.at(-1).state,'done');}
 assert.equal(fx.m.load(fx.id).speed,'deep');
});
test('排队中直接取消，正在回答的取消等待执行器结束再标 cancelled',async t=>{
 const fx=fixture(t,{run:o=>new Promise((resolve,reject)=>{o.onChunk('已收到片段');o.signal.addEventListener('abort',()=>reject(o.signal.reason),{once:true});})});
 fx.m.control(fx.id,'ask','第一题');await fx.m.runQuestion(fx.m.load(fx.id));await turn();const id=fx.m.load(fx.id).answers[0].id;
 fx.m.control(fx.id,'ask','第二题');const queued=fx.m.load(fx.id).answers[1].id;fx.m.control(fx.id,'cancel-question',queued);assert.equal(fx.m.load(fx.id).answers[1].phase,'cancelled');
 assert.ok(fs.existsSync(path.join(fx.m.dir(fx.id),'question-logs',queued+'.json')),'未派发题取消后也有持久后台记录');
 assert.throws(()=>fx.m.control(fx.id,'reanswer',{id}),/还在答/);fx.m.control(fx.id,'cancel-question',id);await fx.service.drain();const result=fx.m.load(fx.id).answers[0];assert.equal(result.phase,'cancelled');assert.equal(result.state,'error');assert.equal(result.errorKind,'cancelled');
});
test('fresh 引擎映射：Lite 复用 CodeAgent，网关复用原连接覆盖，退出终端不挡问答',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'m2-fresh-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const base={cwd:root,hubDataDir:root,resolveConfig:()=>({command:'codeagent',configDir:root}),accountDir:()=>root,findCommand:()=> 'claude-native',applyGatewayEnv:(env,{model})=>{Object.assign(env,{ANTHROPIC_BASE_URL:'http://127.0.0.1:1',ANTHROPIC_AUTH_TOKEN:'mock-local-proxy'});return model;}};
 assert.equal(freshTarget({...base,selection:'codeagent-lite|model',session:{kind:'codeagent',currentModel:{id:'model'}}}).engine,'codeagent');
 assert.equal(freshTarget({...base,selection:'codeagent|',inheritModel:false,session:{kind:'codeagent',currentModel:{id:'old-model'}}}).model,'');
 assert.equal(freshTarget({...base,selection:'codeagent|',inheritModel:true,session:{kind:'codeagent',currentModel:{id:'old-model'}}}).model,'old-model');
 const r=freshTarget({...base,selection:'api-gateway|model',session:{kind:'claude',apiGatewayRoute:true},entry:{confirmedExit:{code:1},askAsideEnv:{CLAUDE_CONFIG_DIR:root,ANTHROPIC_BASE_URL:'http://127.0.0.1:1',ANTHROPIC_AUTH_TOKEN:'mock-local-proxy'}}});
 assert.equal(r.engine,'claude');assert.equal(r.config.command,'claude-native');assert.equal(r.config.settingsEnv.ANTHROPIC_BASE_URL,'http://127.0.0.1:1');
 assert.equal(freshTarget({...base,selection:'api-gateway|model',session:{}}).config.settingsEnv.ANTHROPIC_BASE_URL,'http://127.0.0.1:1');
 assert.throws(()=>freshTarget({...base,selection:'api-gateway|model',session:{},applyGatewayEnv:()=>{throw Error('proxy offline');}}),e=>e.errorKind==='engine-not-ready');
});
test('Claude 快速档两个思考开关与 Track2 网关设置合并，临时覆盖层结束清理',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'m2-q-settings-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let overlay,opts;
 const spawnFn=(_cmd,args,options)=>{opts=options;const file=args[args.indexOf('--settings')+1];overlay={file,data:JSON.parse(fs.readFileSync(file,'utf8'))};const c=new EventEmitter();c.pid=42;c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.stdin.on('finish',()=>setImmediate(()=>{c.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'回答'}]}})+'\n');c.emit('close',0);}));return c;};
 const result=await runAsk({config:{flavor:'claude',command:'claude',configDir:root,settingsDir:root,settingsEnv:{ANTHROPIC_BASE_URL:'http://127.0.0.1:1'}},cwd:root,question:'q',fresh:true,stream:true,thinkingOff:true,model:'model',platform:'linux',spawnFn});
 assert.equal(result.answer,'回答');assert.equal(overlay.data.alwaysThinkingEnabled,false);assert.equal(overlay.data.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:1');assert.equal(opts.env.MAX_THINKING_TOKENS,'0');assert.equal(fs.existsSync(overlay.file),false);
});
test('功能选型为部门网关时快速fresh全链路保留连接覆盖并关闭思考，不依赖理解终端健康',async t=>{
 let overlay,launchArgs,launchEnv;const fx=fixture(t,{kind:'claude',applyGatewayEnv:(env,{model})=>{Object.assign(env,{ANTHROPIC_BASE_URL:'http://127.0.0.1:1',ANTHROPIC_AUTH_TOKEN:'mock-gateway-local-token'});return model;},run:o=>runAsk({...o,platform:'linux',spawnFn:(_command,args,opts)=>{
  launchArgs=args;launchEnv=opts.env;overlay=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
  const c=new EventEmitter();c.pid=77;c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.stdin.on('finish',()=>setImmediate(()=>{c.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'网关回答'}]}})+'\n');c.emit('close',0);}));return c;}})});
 fx.source.apiGatewayRoute=true;fx.sessions.delete(fx.source.id);fx.entries.clear();const stopped=fx.m.load(fx.id);stopped.agent={state:'error',error:'understanding unavailable'};fx.m.save(stopped);
 fx.m.engineFor=()=>({harness:'api-gateway',model:'model',key:'gateway-fixture'});
 fx.m.control(fx.id,'ask','谁负责');await fx.m.runQuestion(fx.m.load(fx.id));await fx.service.drain();const q=fx.m.load(fx.id).answers[0];
 assert.equal(q.answer,'网关回答');assert.equal(q.mode,'fresh');assert.equal(q.engine,'claude');assert.ok(!launchArgs.includes('--resume'));assert.equal(overlay.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:1');assert.equal(overlay.alwaysThinkingEnabled,false);assert.equal(launchEnv.MAX_THINKING_TOKENS,'0');
 const record=fs.readFileSync(path.join(fx.m.dir(fx.id),'question-logs',q.id+'.json'),'utf8');assert.ok(!record.includes('mock-gateway-local-token'));
});
test('runAsk 明确拒绝 stream-json 参数后退回text只重试一次，随后按引擎缓存兼容能力',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'m2-q-capability-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const calls=[],caps=new StreamCapabilities();
 const spawnFn=(_cmd,args)=>{calls.push(args);const c=new EventEmitter();c.pid=42;c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.stdin.on('finish',()=>setImmediate(()=>{if(calls.length===1){c.stderr.write('unknown option --output-format stream-json');c.emit('close',1);}else{c.stdout.write('兼容回答');c.emit('close',0);}}));return c;};
 const options={config:{command:'fake-codeagent',configDir:root},cwd:root,question:'q',fresh:true,stream:true,platform:'linux',spawnFn,capabilities:caps};
 assert.equal((await runAsk(options)).answer,'兼容回答');assert.equal(calls.length,2);assert.equal(calls[0][calls[0].indexOf('--output-format')+1],'stream-json');assert.equal(calls[1][calls[1].indexOf('--output-format')+1],'text');
 await runAsk(options);assert.equal(calls.length,3);assert.equal(calls[2][calls[2].indexOf('--output-format')+1],'text');
});
test('runAsk 取消真实拥有的Windows进程树：根进程和子进程均退出', {skip:process.platform!=='win32',timeout:60000},async t=>{
 const {spawn}=require('node:child_process'),{killProcessTree,cancelled}=require('../core/help-ask/request-lifecycle');
 const controller=new AbortController();let root,grandchildPid,ready,failReady,timer,stderr='';const pending=new Promise((resolve,reject)=>{ready=resolve;failReady=reject;});
 const request=runAsk({config:{command:'owned-fixture',configDir:os.tmpdir()},cwd:os.tmpdir(),question:'q',fresh:true,stream:true,signal:controller.signal,
  spawnFn:(_cmd,_args,opts)=>{root=spawn(process.execPath,[path.join(__dirname,'fixtures/meeting-cancel-process.js')],{...opts,windowsVerbatimArguments:false,windowsHide:true});root.once('error',failReady);root.once('close',()=>{if(!grandchildPid)failReady(Error('fixture closed before init: '+stderr));});root.stderr.on('data',b=>stderr=(stderr+String(b)).slice(-1000));root.stdout.on('data',b=>{try{const e=JSON.parse(String(b));if(e.grandchildPid){grandchildPid=e.grandchildPid;ready();}}catch{}});return root;}});
 request.catch(()=>{});t.after(async()=>{if(root?.exitCode==null)await killProcessTree(root);});
 try{await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture init timeout: '+stderr)),45000);})]);}finally{clearTimeout(timer);}
 const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};assert.ok(alive(root.pid));assert.ok(alive(grandchildPid));
 controller.abort(cancelled());await assert.rejects(request,e=>e.cancelled===true);
 for(let i=0;i<40&&(alive(root.pid)||alive(grandchildPid));i++)await new Promise(r=>setTimeout(r,50));
 assert.equal(alive(root.pid),false);assert.equal(alive(grandchildPid),false);
 t.diagnostic('owned root '+root.pid+' and child '+grandchildPid+' both exited after cancellation');
});
