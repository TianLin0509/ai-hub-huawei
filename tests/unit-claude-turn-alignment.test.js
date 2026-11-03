'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { TranscriptTap } = require('../core/transcript-tap');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher');
const { createGroupChatProviderAdapter } = require('../core/groupchat-provider-adapter');

const user = (id, text, at) => ({type:'user', uuid:id, timestamp:new Date(at).toISOString(), message:{content:text}});
const answer = (id, parent, text, at, stop = 'end_turn') => ({type:'assistant',uuid:id,parentUuid:parent,
  timestamp:new Date(at).toISOString(),message:{id,content:text ? [{type:'text',text}] : [],stop_reason:stop}});
function fixture(t, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'m4-turn-alignment-'));
  const file = path.join(dir,'session.jsonl');
  const write = records => fs.writeFileSync(file,records.map(JSON.stringify).join('\n')+'\n');
  write(rows);
  const tap = new TranscriptTap(); tap.registerSession('s','codeagent',{transcriptPath:file});
  t.after(()=>{tap.dispose();fs.rmSync(dir,{recursive:true,force:true});});
  return {tap,file,write};
}

test('Stop cannot adopt the previous answer even when it completed less than five seconds ago', async t=>{
  const now=Date.now(); const {tap,file}=fixture(t,[user('u0','旧问题',now-2000),answer('a0','u0','上一轮残留',now-500)]);
  tap.notePrompt('s','codeagent','新的问题');
  const complete=[];tap.on('turn-complete',e=>complete.push(e));
  await tap.notifyClaudeStop('s',file);
  assert.equal(complete.length,0);
  const extracted=await tap.extractLatestTurn('s',now,{prompt:'新的问题'});
  assert.ok(!extracted?.text);
});

test('Stop requires terminal evidence and preserves the original record time and user id', async t=>{
  const now=Date.now(),rows=[user('u1','本轮问题',now),answer('a1','u1','先检查',now+10,'tool_use')];
  const {tap,file,write}=fixture(t,rows),events=[];tap.on('turn-complete',e=>events.push(e));
  await tap.notifyClaudeStop('s',file);
  assert.equal(events.length,0);
  rows.push(answer('a2','a1','最终答复',now+20));write(rows);
  await tap.notifyClaudeStop('s',file);
  assert.equal(events.length,1);assert.equal(events[0].completedAt,now+20);
  assert.equal(events[0].userRecordId,'u1');assert.equal(events[0].turnId,'u1');
});

test('out-of-order rows and a later round cannot replace the explicitly requested user record', async t=>{
  const now=Date.now();const {tap}=fixture(t,[user('u1','第一轮',now),user('u2','第二轮',now+10),
    answer('a2','u2','第二轮答案',now+40),answer('a1','u1','第一轮答案',now+20)]);
  const r=await tap.extractLatestTurn('s',now,{userRecordId:'u1',untilTs:now+10});
  assert.equal(r.text,'第一轮答案');assert.equal(r.userRecordId,'u1');
});

test('final snapshot can be shorter than its earlier partial snapshot', async t=>{
  const now=Date.now();const {tap}=fixture(t,[user('u','问题',now),answer('a','u','先写的很长的尚未完成的部分',now+1,null),
    answer('a','u','完成',now+2)]);
  const r=await tap.extractLatestTurn('s',now,{userRecordId:'u'});
  assert.equal(r.text,'完成');assert.equal(r.extractMode,'final_answer');
});

test('a later terminal revision with a new UUID replaces an earlier longer terminal answer', async t=>{
  const now=Date.now();const {tap}=fixture(t,[user('u','问题',now),answer('a','u','最初写的很长的答复',now+1),answer('b','a','修订',now+2)]);
  const r=await tap.extractLatestTurn('s',now,{userRecordId:'u'});
  assert.equal(r.text,'修订');assert.equal(r.recordId,'b');
});

test('direct CLI input without hooks advances the binding to its newer human UUID',async t=>{
  const now=Date.now(),rows=[user('u1','第一轮',now),answer('a1','u1','第一答',now+1)];
  const {tap,file}=fixture(t,rows),events=[];tap.on('turn-complete',e=>events.push(e));
  await tap.notifyClaudeStop('s',file);
  fs.appendFileSync(file,[user('u2','第二轮',now+10),answer('a2','u2','第二答',now+11)].map(JSON.stringify).join('\n')+'\n');
  const end=Date.now()+4000;while(events.length<2&&Date.now()<end)await new Promise(r=>setTimeout(r,50));
  assert.equal(events.at(-1).userRecordId,'u2');assert.equal(events.at(-1).text,'第二答');
});

test('terminal without body stays pending and does not recycle earlier commentary', async t=>{
  const now=Date.now();const {tap,file}=fixture(t,[user('u','问题',now),answer('a','u','开场白',now+1,'tool_use'),answer('z','a','',now+2)]);
  let completed=0;tap.on('turn-complete',()=>completed++);await tap.notifyClaudeStop('s',file);
  assert.equal(completed,0);
  const r=await tap.extractLatestTurn('s',now,{userRecordId:'u'});
  assert.equal(r.extractMode,'awaiting_final_text');assert.equal(r.text,'开场白');
});

test('aligned final replaces a longer settled text; a different member cannot patch it', async()=>{
  const tap=new EventEmitter(),patched=[];const now=Date.now();
  const attempt={sid:'s',kind:'codeagent',providerTurnId:'u',startedAt:now};
  const w=createTurnCompletionWatcher({transcriptTap:tap,hubSessionId:'s',kind:'codeagent',attempt,onTurnPatched:e=>patched.push(e)});
  const waiting=w.wait();tap.emit('turn-complete',{hubSessionId:'s',turnId:'u',text:'较长的初始答复',completedAt:now+1,signalSource:'stop_hook'});
  await waiting;
  tap.emit('turn-complete',{hubSessionId:'other',turnId:'u',text:'其他成员',completedAt:now+2,signalSource:'stop_hook'});
  tap.emit('turn-complete',{hubSessionId:'s',turnId:'u',text:'完成',completedAt:now+3,signalSource:'stop_hook'});
  assert.equal(patched.length,1);assert.equal(patched[0].text,'完成');w.cancelPatch();
});

test('Claude-family completion needs the bound turn id and 429 in prose is an answer',()=>{
  const adapter=createGroupChatProviderAdapter('codeagent');
  const attempt={sid:'s',kind:'codeagent',providerTurnId:'u'};
  assert.equal(adapter.completion(attempt,{hubSessionId:'s',text:'旧答案',signalSource:'stop_hook'}).accepted,false);
  const r=adapter.completion(attempt,{hubSessionId:'s',turnId:'u',text:'429 是 HTTP 限流状态码。',signalSource:'stop_hook'});
  assert.equal(r.status,'completed');
});

test('structured API error remains a failure while 429 in ordinary prose remains an answer',async t=>{
  const now=Date.now(),row={...answer('a','u','429 Too many requests',now+1,null),isApiErrorMessage:true};
  const {tap,file}=fixture(t,[user('u','问题',now),row]),failures=[],completions=[];
  tap.on('turn-error',e=>failures.push(e));tap.on('turn-complete',e=>completions.push(e));
  await tap.notifyClaudeStop('s',file);
  assert.equal(completions.length,0);assert.equal(failures.length,1);
  const r=createGroupChatProviderAdapter('codeagent').error({sid:'s',kind:'codeagent',providerTurnId:'u'},failures[0]);
  assert.equal(r.failure.code,'rate_limited');assert.equal(r.status,'errored');
});

test('Chinese CodeAgent buckets are found alongside the legacy ASCII bucket',t=>{
  const {transcriptDirs,projectSlugOf}=require('../core/codeagent-transcript-dirs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'m4-slug-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cwd=path.join(dir,'中文工作区'),configDir=path.join(dir,'profile');
  const expected=path.join(configDir,'projects',projectSlugOf(cwd));
  assert.match(expected,/中文工作区/);
  const dirs=transcriptDirs({cwd,codeagentConfigDir:configDir});
  assert.ok(dirs.includes(expected));assert.equal(dirs.length,2);
});

test('CodeAgent conversation capture reads only the dispatched prompt reply',t=>{
  const now=Date.now();const {file}=fixture(t,[user('old','旧问题',now-10000),answer('old-a','old','不属于本轮',now-9000),
    user('u','当前问题',now),answer('a','u','属于本轮',now+1)]);
  const messages=require('../core/conversation-capture').captureConversationMessages({kind:'codeagent',sourcePath:file,prompt:'当前问题',since:now});
  assert.equal(messages.filter(m=>m.text==='属于本轮').length,1);
  assert.ok(!messages.some(m=>m.text==='不属于本轮'));
});

test('long task timeout retains partial text and a later aligned final patches it',async()=>{
  const tap=new EventEmitter(),now=Date.now(),patches=[];
  const w=createTurnCompletionWatcher({transcriptTap:tap,hubSessionId:'s',kind:'codeagent',
    attempt:{sid:'s',kind:'codeagent',providerTurnId:'u',dispatchAt:now-20*60000},onTurnPatched:e=>patches.push(e)});
  const waiting=w.wait();w.markTimedOut('response_timeout','已得到的本轮原文');
  const r=await waiting;assert.equal(r.text,'已得到的本轮原文');assert.equal(r.finality,'pending_confirmation');
  assert.ok(w.getPatchWindowMs()>=40*60000);
  tap.emit('turn-complete',{hubSessionId:'s',turnId:'u',completedAt:now+1000,text:'最终答案',signalSource:'stop_hook'});
  assert.equal(patches[0].text,'最终答案');w.cancelPatch();
});

test('a delayed stale snapshot cannot overwrite a newer final record',async t=>{
  const now=Date.now();const {tap}=fixture(t,[user('u','问题',now),answer('a','u','最终',now+3),answer('a','u','迟到的旧草稿',now+1,null)]);
  const r=await tap.extractLatestTurn('s',now,{userRecordId:'u'});
  assert.equal(r.text,'最终');assert.equal(r.extractMode,'final_answer');
});

test('the real parser worker applies UUID alignment and keeps its query identities separate',async t=>{
  const {TranscriptParserService}=require('../core/transcript-parser-service');
  const service=new TranscriptParserService();t.after(()=>service.close());
  const now=Date.now(),{file}=fixture(t,[user('u1','一',now),answer('a1','u1','第一答',now+1),user('u2','二',now+2),answer('a2','u2','第二答',now+3)]);
  const [one,two]=await Promise.all(['u1','u2'].map(userRecordId=>service.parse('claude-aligned',file,{userRecordId})));
  assert.equal(one.turns[0].text,'第一答');assert.equal(two.turns[0].text,'第二答');
  assert.ok(one.meta.workerThreadId>0);
});
