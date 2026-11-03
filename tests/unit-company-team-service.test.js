'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createTeamService}=require('../main/team/service');
function harness(t, config={}, submit=null) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'company-team-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const rows=[{id:'pool-a',usable:true,models:['GLM-5.2'],modelsAuthoritative:true},{id:'pool-b',usable:true,models:['MiniMax-M2.7'],modelsAuthoritative:true}];
  const sessions=new Map([['lead-0001',{id:'lead-0001',kind:'codeagent',cwd:dir}]]),created=[],sent=[];
  const service=createTeamService({company:true,getHubDataDir:()=>dir,getConfig:()=>config,listAccounts:()=>({recommendedId:'pool-a',rows}),
    sessionManager:{getSession:id=>sessions.get(id),isAgentTurnActive:()=>false},commandPath:()=>path.join(dir,'hub-team.cmd'),
    createSession:async request=>{created.push(request);const s={id:`member-${created.length}xxx`,kind:request.kind};sessions.set(s.id,s);return s;},
    submitPrompt:async(sid,text)=>{sent.push({sid,text});return submit?submit(sid,text):{ok:true};}});
  t.after(()=>service.stop());return {service,rows,created,sent,sessions};
}
const member=(account='pool-a',model='GLM-5.2')=>({role:'实现',task:'在临时目录实现',account,model});
test('company plans create only CodeAgent, preserve account/model intent, and deliver both ways',async t=>{
  const h=harness(t),plan=await h.service.invoke('lead-0001','propose',{goal:'目标',members:[member(),member('pool-b','MiniMax-M2.7')]});
  assert.equal(h.created.length,0);await assert.rejects(h.service.invoke('lead-0001','decide',{}),/未知动作/);
  const approved=await h.service.decide({leadSid:'lead-0001',planId:plan.planId,approve:true});assert.equal(approved.created.length,2);
  assert.deepEqual(h.created.map(r=>[r.kind,r.opts.codeagentPoolPick,r.opts.model,r.opts.codeagentModelPick]),[['codeagent','pool-a','GLM-5.2',true],['codeagent','pool-b','MiniMax-M2.7',true]]);
  assert.ok(h.created.every(r=>r.opts.codeagentAccount==='pool'),'session manager must actually enter the pool-account launch path');
  for(let i=0;i<4;i++){await new Promise(r=>setImmediate(r));await h.service.flush('lead-0001');}
  assert.ok(h.sent.some(s=>s.text.includes('本团队只使用 CodeAgent')));assert.ok(h.sent.every(s=>!s.text.includes('ai-peers')&&!s.text.includes('\u7530\u54e5')));
  await h.service.invoke('member-1xxx','send',{to:'lead',message:'成员回复'});
  await h.service.flush('lead-0001');assert.ok(h.sent.some(s=>s.sid==='lead-0001'&&s.text.includes('成员回复')));
  const dismissed=await h.service.invoke('lead-0001','dismiss',{memberId:'m1'});
  assert.match(dismissed.note,/用户/);assert.doesNotMatch(dismissed.note,/\u7530\u54e5/);
});
test('company rejects unsupported kinds, wrong model permissions, and unavailable accounts',async t=>{
  const h=harness(t);
  for(const value of [{...member(),kind:'claude'},{...member(),kind:'powershell'},member('missing'),member('pool-a','MiniMax-M2.7')])
    await assert.rejects(h.service.invoke('lead-0001','propose',{goal:'目标',members:[value]}));
  h.rows[0].usable=false;await assert.rejects(h.service.invoke('lead-0001','propose',{goal:'目标',members:[member()]}),/账号不可用/);
  assert.equal(h.created.length,0);
});
test('approval revalidates account/model edits before creating any member',async t=>{
  const h=harness(t),p=await h.service.invoke('lead-0001','propose',{goal:'目标',members:[member()]});
  await assert.rejects(h.service.decide({leadSid:'lead-0001',planId:p.planId,approve:true,edits:[{account:'pool-b',model:'GLM-5.2'}]}),/权限/);
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
