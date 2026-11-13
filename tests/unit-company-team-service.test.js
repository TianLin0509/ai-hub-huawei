'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createTeamService}=require('../main/team/service');
function harness(t, config={}, submit=null, options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'company-team-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const rows=[{id:'pool-a',usable:true,models:['GLM-5.2'],modelsAuthoritative:true},{id:'pool-b',usable:true,models:['MiniMax-M2.7'],modelsAuthoritative:true}];
  const sessions=new Map([['lead-0001',{id:'lead-0001',kind:'codeagent',cwd:dir}]]),created=[],sent=[];
  const deps={company:true,getHubDataDir:()=>dir,getConfig:()=>config,listAccounts:()=>({recommendedId:'pool-a',rows}),
    sessionManager:{getSession:id=>sessions.get(id),isAgentTurnActive:()=>false},commandPath:()=>path.join(dir,'hub-team.cmd'),
    createSession:async request=>{created.push(request);const s={id:`member-${created.length}xxx`,kind:request.kind};sessions.set(s.id,s);return s;},
    submitPrompt:async(sid,text)=>{sent.push({sid,text});return submit?submit(sid,text):{ok:true};},...options};
  const service=createTeamService(deps);
  t.after(()=>{service.freeze();service.stop();});return {service,rows,created,sent,sessions,deps,dir};
}
const member=(account='pool-a',model='GLM-5.2')=>({role:'实现',task:'在临时目录实现',account,model});
test('company plans create only CodeAgent, preserve account/model intent, and deliver both ways',async t=>{
  const h=harness(t),plan=await h.service.invoke('lead-0001','propose',{goal:'目标',members:[member(),member('pool-b','MiniMax-M2.7')]});
  assert.equal(h.created.length,0);await assert.rejects(h.service.invoke('lead-0001','decide',{}),/未知动作/);
  const approved=await h.service.decide({leadSid:'lead-0001',planId:plan.planId,approve:true});assert.equal(approved.created.length,2);
  assert.deepEqual(h.created.map(r=>[r.kind,r.opts.codeagentPoolPick,r.opts.model,r.opts.codeagentModelPick]),[['codeagent','pool-a','GLM-5.2',true],['codeagent','pool-b','MiniMax-M2.7',true]]);
  assert.ok(h.created.every(r=>r.opts.codeagentAccount==='pool'),'session manager must actually enter the pool-account launch path');
  assert.ok(h.created.every(r=>r.opts.openInBackground===true),'team creation must preserve the current view');
  for(let i=0;i<4;i++){await new Promise(r=>setImmediate(r));await h.service.flush('lead-0001');}
  assert.ok(h.sent.some(s=>s.text.includes('本团队只使用 CodeAgent')));assert.ok(h.sent.every(s=>!s.text.includes('ai-peers')&&!s.text.includes('\u7530\u54e5')));
  await h.service.invoke('member-1xxx','send',{to:'lead',message:'成员回复'});
  await h.service.flush('lead-0001');assert.ok(h.sent.some(s=>s.sid==='lead-0001'&&s.text.includes('成员回复')));
  const dismissed=await h.service.invoke('lead-0001','dismiss',{memberId:'m1'});
  assert.match(dismissed.note,/用户/);assert.doesNotMatch(dismissed.note,/\u7530\u54e5/);
});
test('company rejects unsupported kinds, malformed model names, and unavailable accounts',async t=>{
  const h=harness(t);
  for(const value of [{...member(),kind:'claude'},{...member(),kind:'powershell'},member('missing'),member('pool-a','not a model')])
    await assert.rejects(h.service.invoke('lead-0001','propose',{goal:'目标',members:[value]}));
  h.rows[0].usable=false;await assert.rejects(h.service.invoke('lead-0001','propose',{goal:'目标',members:[member()]}),/账号不可用/);
  assert.equal(h.created.length,0);
});
test('company proposals and approval edits preserve the shared model ID characters and length',async t=>{
  const h=harness(t);
  const model='GLM-5.2-Auto(Volcano-MaaS)@preview+fast[1m]';
  const edited='G'.repeat(164);
  h.rows[0].models.push(model,edited);
  const p=await h.service.invoke('lead-0001','propose',{goal:'保留模型名',members:[member('pool-a',model)]});
  assert.equal(h.service.listTeams()[0].plans[0].members[0].model,model);
  await h.service.decide({leadSid:'lead-0001',planId:p.planId,approve:true,edits:[{model:edited}]});
  assert.equal(h.created[0].opts.model,edited);
});
test('approval revalidates account/model edits before creating any member',async t=>{
  const h=harness(t),p=await h.service.invoke('lead-0001','propose',{goal:'目标',members:[member()]});
  await assert.rejects(h.service.decide({leadSid:'lead-0001',planId:p.planId,approve:true,edits:[{account:'pool-b',model:'not a model'}]}),/模型名称/);
  assert.equal(h.created.length,0);assert.equal(h.service.listTeams()[0].plans[0].status,'pending');
  await h.service.decide({leadSid:'lead-0001',planId:p.planId,approve:true,edits:[{account:'pool-b',model:'MiniMax-M2.7'}]});
  assert.equal(h.created[0].opts.model,'MiniMax-M2.7');
});
test('company rejects a non-CodeAgent lead and preserves a plan when its account becomes unavailable',async t=>{
  const h=harness(t);
  h.sessions.set('shell-0001',{id:'shell-0001',kind:'powershell'});
  await assert.rejects(h.service.invoke('shell-0001','propose',{goal:'目标',members:[member()]}),/CodeAgent 会话/);
  const p=await h.service.invoke('lead-0001','propose',{goal:'目标',members:[member()]});
  h.rows[0].usable=false;
  await assert.rejects(h.service.decide({leadSid:'lead-0001',planId:p.planId,approve:true}),/账号不可用/);
  assert.equal(h.created.length,0);assert.equal(h.service.listTeams()[0].plans[0].status,'pending');
});
test('company omitted or empty model preserves each pool account default despite Hub defaults',async t=>{
  const h=harness(t,{defaultModels:{codeagent:'MiniMax-M2.7'}});
  const omitted=member();delete omitted.model;
  const p=await h.service.invoke('lead-0001','propose',{goal:'沿用号池模型',members:[omitted,member('pool-b','')]});
  const approved=await h.service.decide({leadSid:'lead-0001',planId:p.planId,approve:true});
  assert.equal(approved.created.length,2);assert.deepEqual(approved.failed,[]);
  assert.deepEqual(h.created.map(r=>[r.kind,r.opts.codeagentAccount,r.opts.codeagentPoolPick]),[['codeagent','pool','pool-a'],['codeagent','pool','pool-b']]);
  for(const request of h.created){
    assert.equal(Object.hasOwn(request.opts,'model'),false,'the account must supply its own default model');
    assert.notEqual(request.opts.codeagentModelPick,true,'an omitted model is not an explicit model selection');
  }
});
test('company approval can clear a model and change accounts without inheriting Hub model defaults',async t=>{
  const h=harness(t,{defaultModels:{codeagent:'GLM-5.2'}});
  const p=await h.service.invoke('lead-0001','propose',{goal:'审批时沿用账号模型',members:[member()]});
  const approved=await h.service.decide({leadSid:'lead-0001',planId:p.planId,approve:true,edits:[{account:'pool-b',model:''}]});
  assert.equal(approved.created.length,1);assert.deepEqual(approved.failed,[]);
  assert.equal(h.created[0].opts.codeagentAccount,'pool');assert.equal(h.created[0].opts.codeagentPoolPick,'pool-b');
  assert.equal(Object.hasOwn(h.created[0].opts,'model'),false);assert.notEqual(h.created[0].opts.codeagentModelPick,true);
  assert.equal(h.service.listTeams()[0].plans[0].members[0].model,'');
});
test('company only permits model selection and rejects other tuning at plan and member level',async t=>{
  const h=harness(t);
  for(const key of ['effort','codexSpeedTier','fastMode','speed']){
    await assert.rejects(h.service.invoke('lead-0001','propose',{goal:'无效调优',members:[{...member(),[key]:'high'}]}),/公司组队计划只支持选择账号和模型/);
    await assert.rejects(h.service.invoke('lead-0001','propose',{goal:'无效调优',members:[member()],[key]:'high'}),/公司组队计划只支持选择账号和模型/);
  }
  assert.equal(h.created.length,0);assert.equal(h.service.listTeams().length,0);
});

test('a stop pressed while a team message is being pasted counts as not delivered and notifies the lead',async t=>{
  const h=harness(t,{},sid=>sid==='lead-0001'?{ok:true}:{ok:true,stopped:true,notSent:true});
  const plan=await h.service.invoke('lead-0001','propose',{goal:'目标',members:[member()]});
  await h.service.decide({leadSid:'lead-0001',planId:plan.planId,approve:true});
  for(let i=0;i<4;i++){await new Promise(r=>setImmediate(r));await h.service.flush('member-1xxx');await h.service.flush('lead-0001');}
  const status=await h.service.invoke('lead-0001','status',{});
  assert.ok((status.undelivered||[]).some(m=>m.to==='m1'&&m.state==='failed'),'stopped paste must stay undelivered');
  assert.ok(h.sent.some(s=>s.sid==='lead-0001'&&s.text.includes('没送达')),'lead must be told the message was not delivered');
});
test('a stop pressed after Enter keeps the message as possibly delivered instead of inviting a duplicate resend',async t=>{
  const h=harness(t,{},sid=>sid==='lead-0001'?{ok:true}:{ok:true,stopped:true,notSent:false});
  const plan=await h.service.invoke('lead-0001','propose',{goal:'目标',members:[member()]});
  await h.service.decide({leadSid:'lead-0001',planId:plan.planId,approve:true});
  for(let i=0;i<4;i++){await new Promise(r=>setImmediate(r));await h.service.flush('member-1xxx');await h.service.flush('lead-0001');}
  const status=await h.service.invoke('lead-0001','status',{});
  assert.ok((status.undelivered||[]).some(m=>m.to==='m1'&&m.state==='unconfirmed'),'stopped after submit must be unconfirmed, not failed');
  assert.ok(!(status.undelivered||[]).some(m=>m.to==='m1'&&m.state==='failed'));
  assert.ok(h.sent.some(s=>s.sid==='lead-0001'&&s.text.includes('可能已送达')),'lead must be asked to check before resending');
});

async function readyTeam(t, submit, options={}) {
  let activeSubmit=null;
  const h=harness(t,{},(sid,text)=>activeSubmit?activeSubmit(sid,text):{ok:true},options);
  const plan=await h.service.invoke('lead-0001','propose',{goal:'送达状态',members:[member()]});
  await h.service.decide({leadSid:'lead-0001',planId:plan.planId,approve:true});
  for(let i=0;i<4;i++){await new Promise(r=>setImmediate(r));await h.service.flush('lead-0001');}
  activeSubmit=submit; h.sent.length=0;
  return h;
}

test('sending is visible to both participants and summary; overdue receipt stays single-flight until confirmed',async t=>{
  let clock=100000,resolve;
  const h=await readyTeam(t,()=>new Promise(r=>{resolve=r;}),{now:()=>clock});
  const {messageId}=await h.service.invoke('lead-0001','send',{to:'m1',message:'等待回执'});
  const pending=h.service.flush('lead-0001');
  const sender=await h.service.invoke('lead-0001','status');
  assert.equal(sender.undelivered.find(m=>m.id===messageId).stage,'sending');
  const receiver=await h.service.invoke('member-1xxx','status');
  assert.equal(receiver.pendingForYou.find(m=>m.id===messageId).state,'sending');
  assert.equal(h.service.listTeams()[0].messages.find(m=>m.id===messageId).targetSessionId,'member-1xxx');
  clock+=60000;
  assert.equal((await h.service.invoke('lead-0001','status')).undelivered.find(m=>m.id===messageId).stage,'sending');
  clock+=2*60000;
  const late=(await h.service.invoke('lead-0001','status')).undelivered.find(m=>m.id===messageId);
  assert.equal(late.stage,'unconfirmed');assert.equal(late.state,'sending');assert.equal(late.waitedMs,180000);
  assert.match(late.reason,/暂未收到确认/);assert.match(late.reason,/不会自动重发/);assert.equal(late.retryAt,null);
  await h.service.flush('lead-0001');assert.equal(h.sent.length,1);
  resolve({ok:true});await pending;
  const delivered=(await h.service.invoke('member-1xxx','read',{messageId})).delivery;
  assert.equal(delivered.state,'sent');assert.match(delivered.reason,/不代表/);
  assert.equal((await h.service.invoke('lead-0001','status')).undelivered.some(m=>m.id===messageId),false);
});

test('restart keeps an in-flight delivery visible and never replays its uncertain result',async t=>{
  let resolve;
  const h=await readyTeam(t,()=>new Promise(r=>{resolve=r;}));
  const {messageId}=await h.service.invoke('lead-0001','send',{to:'m1',message:'重启中的消息'});
  const pending=h.service.flush('lead-0001');
  const restored=createTeamService(h.deps);
  const record=(await restored.invoke('member-1xxx','status')).pendingForYou.find(m=>m.id===messageId);
  assert.equal(record.state,'unconfirmed');assert.match(record.reason,/重启/);
  await restored.flush('lead-0001');assert.equal(h.sent.length,1);
  restored.freeze();resolve({ok:true});await pending;
});

test('unknown submit exceptions and missing receipts stay unconfirmed without automatic replay',async t=>{
  for(const mode of ['throw','empty']) {
    const h=await readyTeam(t,sid=>{if(sid==='lead-0001')return {ok:true};if(mode==='throw')throw Error('transport closed after Enter');return undefined;});
    const {messageId}=await h.service.invoke('lead-0001','send',{to:'m1',message:mode});
    await h.service.flush('lead-0001');
    for(let i=0;i<3;i++){await new Promise(r=>setImmediate(r));await h.service.flush('lead-0001');}
    assert.equal((await h.service.invoke('member-1xxx','status')).pendingForYou.find(m=>m.id===messageId).state,'unconfirmed');
    assert.equal(h.sent.filter(m=>m.sid==='member-1xxx').length,1);
  }
});

test('preflight rejections fail without retrying or restarting the recipient',async t=>{
  for(const error of ['no-session','bad-request']) for(const explicit of [false,true]) {
    let clock=100000,restarts=0;
    const receipt={ok:false,error,...(explicit?{notSent:true}:{})};
    const h=await readyTeam(t,sid=>sid==='lead-0001'?{ok:true}:receipt,{now:()=>clock,restartSession:async()=>{restarts++;return {ok:true};}});
    const {messageId}=await h.service.invoke('lead-0001','send',{to:'m1',message:'preserve rejected message'});
    await h.service.flush('lead-0001');
    const record=(await h.service.invoke('lead-0001','status')).messages.find(m=>m.id===messageId);
    assert.equal(record.state,'failed',error+' explicit='+explicit);
    assert.equal(record.retryAt,null);
    assert.doesNotMatch(record.reason,/可能已送达/);
    assert.equal((await h.service.invoke('member-1xxx','status')).pendingForYou.some(m=>m.id===messageId),false);
    for(let i=0;i<5;i++){clock+=30*60000;await new Promise(r=>setImmediate(r));await h.service.flush('lead-0001');}
    assert.equal(h.sent.filter(m=>m.sid==='member-1xxx').length,1);
    assert.equal(restarts,0);
    assert.ok((await h.service.invoke('lead-0001','status')).undelivered.find(m=>m.id===messageId).text.includes('preserve rejected message'));
  }
});

test('IPC-wrapped exceptions and stuck acknowledgements are uncertain even when ok is true',async t=>{
  for(const receipt of [{ok:false,error:'send-threw'}, {ok:false,error:'cli-exited'}, {ok:false,error:'no-session',unconfirmed:true}, {ok:false,error:'bad-request',notSent:false}, {ok:false,error:'no-session',stopped:true}, {ok:false,error:'bad-request',sendStatus:'stuck'}, {ok:false,error:'transport-error'}, {ok:true,sendStatus:'stuck',acknowledgementSource:null}, {ok:false,sendStatus:'content-mismatch'}]) {
    const h=await readyTeam(t,sid=>sid==='lead-0001'?{ok:true}:receipt);
    const {messageId}=await h.service.invoke('lead-0001','send',{to:'m1',message:'未知送达'});
    await h.service.flush('lead-0001');await new Promise(r=>setImmediate(r));await h.service.flush('lead-0001');
    assert.equal((await h.service.invoke('lead-0001','status')).messages.find(m=>m.id===messageId).state,'unconfirmed');
    assert.equal(h.sent.filter(m=>m.sid==='member-1xxx').length,1);
  }
});

test('queued retry reports its delay; stopped not-sent bodies are excluded from recipient tasks',async t=>{
  let clock=100000,stopped=false;
  const h=await readyTeam(t,sid=>sid==='lead-0001'?{ok:true}:{ok:false,notSent:true,stopped,message:'输入框有草稿'}, {now:()=>clock});
  const first=await h.service.invoke('lead-0001','send',{to:'m1',message:'草稿保护'});
  await h.service.flush('lead-0001');clock+=1000;
  let record=(await h.service.invoke('lead-0001','status')).messages.find(m=>m.id===first.messageId);
  assert.equal(record.stage,'queued');assert.equal(record.retryAt,160000);assert.equal(record.waitedMs,1000);assert.match(record.reason,/草稿/);
  stopped=true;clock=160000;await h.service.flush('lead-0001');
  const receiver=await h.service.invoke('member-1xxx','status');
  assert.equal(receiver.pendingForYou.some(m=>m.id===first.messageId),false);
  record=receiver.messages.find(m=>m.id===first.messageId);
  assert.equal(record.state,'failed');assert.equal(record.retryAt,null);
  assert.equal(Object.hasOwn(record,'text'),false);
  assert.ok((await h.service.invoke('lead-0001','status')).undelivered.find(m=>m.id===first.messageId).text.includes('草稿保护'));
});

test('stale busy reconciliation holds the delivery lock and sends one message after same-turn completion',async t=>{
  let busy=false,release,checks=0;
  const h=await readyTeam(t,()=>({ok:true}),{reconcileTurn:async()=>{checks++;await new Promise(r=>{release=r;});busy=false;return {reconciled:true,reason:'同回合已完成'};}});
  h.deps.sessionManager.isAgentTurnActive=sid=>sid==='member-1xxx'&&busy;
  busy=true;
  const {messageId}=await h.service.invoke('lead-0001','send',{to:'m1',message:'只送一次'});
  const pending=h.service.flush('lead-0001');
  await h.service.flush('lead-0001');assert.equal(checks,1);assert.equal(h.sent.length,0);
  release();await pending;await h.service.flush('lead-0001');
  assert.equal(h.sent.length,1);
  assert.equal((await h.service.invoke('lead-0001','status')).messages.find(m=>m.id===messageId).state,'sent');
});

test('missing completion evidence and reconciliation errors preserve busy state without sending or restarting',async t=>{
  for(const throws of [false,true]) {
    const h=await readyTeam(t,()=>({ok:true}),{reconcileTurn:async()=>{if(throws)throw Error('record unavailable');return {reconciled:false,reason:'缺少同回合完成证据，等待核对'};}});
    h.deps.sessionManager.isAgentTurnActive=sid=>sid==='member-1xxx';
    const {messageId}=await h.service.invoke('lead-0001','send',{to:'m1',message:'保持排队'});
    await h.service.flush('lead-0001');
    assert.equal(h.sent.length,0);
    const row=(await h.service.invoke('lead-0001','status')).undelivered.find(m=>m.id===messageId);
    assert.equal(row.state,'queued');assert.match(row.reason,/核对/);
  }
});

test('a member dismissed during reconciliation never receives the pending task',async t=>{
  let busy=false,release;
  const h=await readyTeam(t,()=>({ok:true}),{reconcileTurn:async()=>{await new Promise(r=>{release=r;});busy=false;return {reconciled:true};}});
  h.deps.sessionManager.isAgentTurnActive=sid=>sid==='member-1xxx'&&busy;busy=true;
  const {messageId}=await h.service.invoke('lead-0001','send',{to:'m1',message:'离队时不可发送'});
  const pending=h.service.flush('lead-0001');
  await h.service.invoke('lead-0001','dismiss',{memberId:'m1'});
  release();await pending;
  assert.equal(h.sent.length,0);
  assert.equal((await h.service.invoke('lead-0001','status')).messages.find(m=>m.id===messageId).state,'failed');
});
