'use strict';
// 2026-11-18：负责人组队按规则自动批准（默认开，config team.autoApproveLeads=false 关回人工批准）。
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createTeamService,MAX_MEMBERS}=require('../main/team/service');
const {buildConfigJsonUpdate,toEditableConfig}=require('../main/ipc/config-handlers');
function harness(t,config={},options={autoApproveLeadsDefault:true}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'company-team-auto-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const rows=[{id:'pool-a',usable:true,models:['GLM-5.2'],modelsAuthoritative:true},{id:'pool-b',usable:false,models:['MiniMax-M2.7'],modelsAuthoritative:true}];
  const sessions=new Map([['lead-0001',{id:'lead-0001',kind:'codeagent',cwd:dir}]]),created=[],sent=[];
  const service=createTeamService({getHubDataDir:()=>dir,getConfig:()=>config,listAccounts:()=>({recommendedId:'pool-a',rows}),
    sessionManager:{getSession:id=>sessions.get(id),isAgentTurnActive:()=>false},commandPath:()=>path.join(dir,'hub-team.cmd'),
    createSession:async request=>{created.push(request);const s={id:`member-${created.length}xxx`,kind:request.kind};sessions.set(s.id,s);return s;},
    submitPrompt:async(sid,text)=>{sent.push({sid,text});return {ok:true};},...options});
  t.after(()=>{service.freeze();service.stop();});
  const settle=async()=>{for(let i=0;i<4;i++){await new Promise(r=>setImmediate(r));await service.flush('lead-0001');}};
  return {service,rows,created,sent,settle};
}
const member=(account='pool-a',model='GLM-5.2')=>({role:'实现',task:'在临时目录实现',account,model});
const plans=h=>h.service.listTeams()[0]?.plans||[];

test('默认开：propose 后计划直接批准、成员建出，负责人收到「已按规则自动批准」',async t=>{
  const h=harness(t);
  const r=await h.service.invoke('lead-0001','propose',{goal:'目标',members:[member(),member()]});
  assert.equal(r.status,'approved');assert.deepEqual(r.created,['m1','m2']);assert.match(r.note,/已按规则自动批准/);
  assert.equal(h.created.length,2);assert.equal(plans(h)[0].status,'approved');
  await h.settle();
  const toLead=h.sent.filter(s=>s.sid==='lead-0001').map(s=>s.text).join('\n');
  assert.match(toLead,/已按规则自动批准招人计划/);assert.doesNotMatch(toLead,/用户批准了/);
});
test('config 未写 team 时按主进程默认开；显式 true 也开',async t=>{
  for(const config of [{},{team:{}},{team:{autoApproveLeads:true}}]){
    const h=harness(t,config);
    const r=await h.service.invoke('lead-0001','propose',{goal:'目标',members:[member()]});
    assert.equal(r.status,'approved');
  }
});
test('autoApproveLeads=false：仍为待批准，界面批准路径与文案不变',async t=>{
  const h=harness(t,{team:{autoApproveLeads:false}});
  const r=await h.service.invoke('lead-0001','propose',{goal:'目标',members:[member()]});
  assert.equal(r.status,'pending');assert.match(r.note,/待批准/);assert.equal(h.created.length,0);
  const ok=await h.service.decide({leadSid:'lead-0001',planId:r.planId,approve:true});
  assert.equal(ok.status,'approved');assert.equal(h.created.length,1);
  await h.settle();
  assert.ok(h.sent.some(s=>s.sid==='lead-0001'&&s.text.includes('用户批准了招人计划')));
});
test('未传主进程默认（单测/旧调用方）时保持人工批准',async t=>{
  const h=harness(t,{},{});
  const r=await h.service.invoke('lead-0001','propose',{goal:'目标',members:[member()]});
  assert.equal(r.status,'pending');assert.equal(h.created.length,0);
});
test(`成员超过上限 ${MAX_MEMBERS} 名：不自动建、不突破上限，报错与人工批准一致`,async t=>{
  const h=harness(t);
  await h.service.invoke('lead-0001','propose',{goal:'先招到差一个满',members:Array.from({length:MAX_MEMBERS-1},()=>member())});
  assert.equal(h.created.length,MAX_MEMBERS-1);
  await assert.rejects(h.service.invoke('lead-0001','propose',{goal:'再招两个',members:[{...member(),task:'new-a'},{...member(),task:'new-b'}]}),new RegExp(`最多 ${MAX_MEMBERS} 名成员`));
  assert.equal(h.created.length,MAX_MEMBERS-1);
  const one=await h.service.invoke('lead-0001','propose',{goal:'补最后一个',members:[{...member(),task:'new-last'}]});
  assert.equal(one.status,'approved');assert.equal(h.created.length,MAX_MEMBERS);
});
test('账号不合规（不在号池 / 已不可用 / 模型名无效）：不自动建，错误说明与人工批准相同',async t=>{
  const h=harness(t);
  await assert.rejects(h.service.invoke('lead-0001','propose',{goal:'目标',members:[member('missing')]}),/号池账号不可用/);
  await assert.rejects(h.service.invoke('lead-0001','propose',{goal:'目标',members:[member('pool-b','MiniMax-M2.7')]}),/号池账号不可用/);
  await assert.rejects(h.service.invoke('lead-0001','propose',{goal:'目标',members:[member('pool-a','not a model')]}),/模型名称无效/);
  assert.equal(h.created.length,0);
});
test('提交后、自动批准时账号才失效：计划留在待批准，报错同人工并说明去向',async t=>{
  const h=harness(t);let calls=0;
  const original=h.rows[0];
  Object.defineProperty(h.rows,0,{get(){calls++;return calls>1?{...original,usable:false}:original;}});
  await assert.rejects(h.service.invoke('lead-0001','propose',{goal:'目标',members:[member()]}),e=>/号池账号不可用/.test(e.message)&&/待批准/.test(e.message));
  assert.equal(h.created.length,0);assert.equal(plans(h)[0].status,'pending');
});
test('设置开关读写 team.autoApproveLeads，且保留 team 下其他字段',()=>{
  assert.equal(toEditableConfig({}).teamAutoApproveLeads,true);
  assert.equal(toEditableConfig({team:{autoApproveLeads:false}}).teamAutoApproveLeads,false);
  const off=buildConfigJsonUpdate({team:{other:1}},{teamAutoApproveLeads:false});
  assert.deepEqual(off.team,{other:1,autoApproveLeads:false});
  const on=buildConfigJsonUpdate({team:{autoApproveLeads:false}},{teamAutoApproveLeads:true});
  assert.equal(on.team.autoApproveLeads,true);
  assert.deepEqual(buildConfigJsonUpdate({team:{autoApproveLeads:false}},{proxy:''}).team,{autoApproveLeads:false});
});
