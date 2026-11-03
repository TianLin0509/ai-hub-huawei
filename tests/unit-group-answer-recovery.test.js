'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const A=require('../core/group-answer-files'),{getOrchestrator}=require('../core/group-chat-orchestrator');
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'m4-answer-recovery-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const orch=getOrchestrator(dir,'room');orch.beginTurn('问题');
  const add=(sid,member,answerId='run-first')=>{
    const e=A.entryFor({dataDir:dir,meetingId:'room',turnNum:1,memberId:member,answerId});
    fs.mkdirSync(e.dir,{recursive:true});orch.registerAnswerFile(1,sid,e);return e;
  };
  return {dir,orch,add,msg:sid=>orch.state.messages.find(m=>m.sid===sid && m.role==='assistant')};
}
test('a temporary read failure keeps the previous answer and retries without an mtime change',t=>{
  const {orch,add,msg}=setup(t),e=add('s1','m1');fs.writeFileSync(e.ready,'原始答案');A.reconcile(orch);
  const stored=orch.answerFileFor(1,'s1');delete stored.sig;
  const read=fs.readFileSync;
  try {
    fs.readFileSync=function(file,...args){if(file===e.ready)throw Object.assign(new Error('临时占用'),{code:'EACCES'});return read.call(this,file,...args);};
    assert.equal(A.reconcile(orch),true);assert.equal(msg('s1').content,'原始答案');assert.match(msg('s1').answer.readError,/临时占用/);
  } finally {fs.readFileSync=read;}
  assert.equal(A.reconcile(orch),true);assert.equal(msg('s1').answer.state,'delivered');assert.equal(msg('s1').answer.readError,undefined);
});
test('rolled back turn numbers cannot adopt an old file, even if its writer finishes late',t=>{
  const {orch,add,msg}=setup(t),old=add('s1','m1','old-message');
  fs.writeFileSync(old.ready,'旧答案');A.reconcile(orch);orch.rollbackTurn(1);orch.beginTurn('重提的问题');
  const current=add('s1','m1','new-message');assert.notEqual(current.ready,old.ready);
  fs.writeFileSync(old.ready,'迟到的旧答案');A.reconcile(orch);assert.ok(!msg('s1')?.content);
  fs.writeFileSync(current.ready,'本轮答案');A.reconcile(orch);assert.equal(msg('s1').content,'本轮答案');
});
test('two members updating together stay separate and a shorter corrected file replaces the partial',t=>{
  const {orch,add,msg}=setup(t),a=add('s1','m1'),b=add('s2','m2');
  fs.writeFileSync(a.ready,'长的第一份内容尚未更正');fs.writeFileSync(b.ready,'成员二');A.reconcile(orch);
  fs.writeFileSync(a.ready,'完成');A.reconcile(orch);
  assert.equal(msg('s1').content,'完成');assert.equal(msg('s2').content,'成员二');
});
test('oversized answer is a visible failure instead of an empty successful read',t=>{
  const {orch,add,msg}=setup(t),e=add('s1','m1');fs.writeFileSync(e.ready,'x'.repeat(2*1024*1024+1));
  assert.equal(A.reconcile(orch),true);assert.equal(msg('s1').answer.state,'unreadable');assert.match(msg('s1').answer.readError,/2 MB/);
});
