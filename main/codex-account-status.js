'use strict';

const {Terminal} = require('@xterm/headless');

// In Codex 0.164 SessionStart is queued until the next user turn. /status is
// local and confirms the resumed thread without sending a model message.
async function observeCodexAccountStatus(manager,id,expectedSid) {
  let terminal, disposed=false, replayed=false, chain=Promise.resolve(), baseline=0, confirmation=null;
  const queued=[];
  const write=text=>new Promise(resolve=>terminal.write(text,resolve));
  const listener=event=>{
    if(event.sessionId!==id||disposed)return;
    if(!replayed)queued.push(event);
    else chain=chain.then(()=>write(event.data));
  };
  manager.on('output',listener);
  try {
    const snapshot=await manager.getSessionBufferSnapshot(id);
    terminal=new Terminal({cols:snapshot.baseCols||snapshot.cols||120,rows:snapshot.baseRows||snapshot.rows||30,scrollback:1000,allowProposedApi:true});
    await write(snapshot.text||'');
    for(const operation of snapshot.operations||[]) {
      if(operation.type==='resize')terminal.resize(operation.cols,operation.rows);
      else if(operation.type==='write')await write(operation.data);
    }
    for(const event of queued)if(!event.seq||event.seq>snapshot.seq)await write(event.data);
    replayed=true;
  } catch(error) {disposed=true;manager.removeListener('output',listener);terminal?.dispose();throw error;}
  const lines=()=>{
    const buffer=terminal.buffer.active,result=[];
    for(let i=0;i<buffer.length;i++)result.push(buffer.getLine(i)?.translateToString(true)||'');
    return result;
  };
  const statuses=()=>lines().filter(line=>/\bSession:\s*[0-9a-f-]{36}\b/i.test(line));
  return {
    async ready() {
      await chain;
      return /^›\s*Ask Codex to do anything\s*$/i.test(lines().filter(line=>line.trim().startsWith('›')).at(-1)?.trim()||'');
    },
    async arm(){await chain;baseline=statuses().length;confirmation=null;},
    get confirmation(){return confirmation;},
    async wait(timeoutMs=12000) {
      const deadline=Date.now()+timeoutMs;
      while(!disposed&&Date.now()<deadline) {
        await chain;
        const rows=statuses();
        if(rows.length>baseline) {
          const sid=rows.at(-1).match(/\bSession:\s*([0-9a-f-]{36})\b/i)?.[1];
          const accountLine=lines().filter(line=>/\bAccount:\s*\S/i.test(line)).at(-1);
          if(sid!==expectedSid) return {ok:false,message:'Codex 恢复到了另一条会话，未发送消息'};
          if(!accountLine || /API key|not signed|logged out/i.test(accountLine)) return {ok:false,message:'Codex 订阅登录未确认，未发送消息'};
          confirmation={ok:true,nativeSessionId:sid,accountConfirmed:true};
          return confirmation;
        }
        await new Promise(resolve=>setTimeout(resolve,60));
      }
      return {ok:false,message:'未收到新 Codex 进程的会话状态确认，未发送消息'};
    },
    dispose(){disposed=true;manager.removeListener('output',listener);chain.finally(()=>terminal?.dispose());},
  };
}

async function confirmCodexAccountResume({manager,sendToPty,session,guard,timeoutMs=30000}) {
  const observer=await observeCodexAccountStatus(manager,session.id,session.codexSid);
  try {
    const deadline=Date.now()+timeoutMs;
    while(!await observer.ready()) {
      if(Date.now()>deadline || !guard({allowSuspended:true})) throw new Error('Codex 恢复后的输入状态未就绪，未发送消息');
      await new Promise(resolve=>setTimeout(resolve,80));
    }
    await observer.arm();
    const receipt=await sendToPty(session.id,'/status',session.kind,{requireReady:false,
      localCommandObserver:observer,codexAccountProbe:session.codexAccountAttempt,
      shouldSubmit:()=>guard({allowSuspended:true})});
    if(!receipt?.ok || !observer.confirmation?.ok) throw new Error(observer.confirmation?.message || receipt?.message || 'Codex 恢复状态未确认');
    return true;
  } finally {observer.dispose();}
}

module.exports={observeCodexAccountStatus,confirmCodexAccountResume};
