'use strict';
const fs=require('fs');
const path=require('path');
const {EventEmitter}=require('events');
const {UUID,isAntigravity}=require('./antigravity-config');
const {parseAntigravityTranscriptToTurns,hash}=require('./antigravity-transcript-parser');
const STOP_FLUSH_GRACE_MS=20000;
// 从字节位置 pos 读 n 个字节（事件记录增量续读用）。
function readRange(file,pos,n){const fd=fs.openSync(file,'r');try{const b=Buffer.alloc(n);const got=fs.readSync(fd,b,0,n,pos);return b.subarray(0,got);}finally{fs.closeSync(fd);}}
function readHeadHex(file,len){const n=Math.min(64,len||0);return n>0?readRange(file,0,n).toString('hex'):'';}
function statIdentity(st){return `${st.dev||0}:${st.ino||0}:${Math.round(st.birthtimeMs||0)}`;}
const EVENTS=['turn-complete','progress-update','turn-started','turn-aborted','turn-error','session-bound','prompt-submitted','background-work-changed','context-window-observed'];
class AntigravityTap extends EventEmitter {
  constructor(){super();this._bound=new Map();}
  hasSession(id){return this._bound.has(id);}
  registerSession(id,ctx){
    this.unregisterSession(id);
    if(!ctx.antigravityEventsFile)throw Error('Antigravity 原生事件路径缺失');
    const s={...ctx,id,offset:0,turns:[],lastText:null,active:false,lastStop:null,error:null};
    this._read(s);s.lastUser=s.turns.filter(t=>t.role==='user').at(-1)?.id;
    this._bound.set(id,s);
    s.timer=setInterval(()=>this._poll(s),400);s.timer.unref?.();this._poll(s);
  }
  unregisterSession(id){const s=this._bound.get(id);if(s)clearInterval(s.timer);this._bound.delete(id);}
  notePrompt(id){const s=this._bound.get(id);if(s)s.lastText=null;}
  _receiptPath(s){return path.join(path.dirname(s.antigravityEventsFile),'native-'+s.geminiChatId+'.json');}
  _read(s){
    if(!s.transcriptPath)return;
    const files=[path.join(path.dirname(s.transcriptPath),'transcript.jsonl'),path.join(path.dirname(s.transcriptPath),'transcript_full.jsonl'),this._receiptPath(s)];
    const signature=files.map(f=>{try{const st=fs.statSync(f);return `${st.size}:${st.mtimeMs}`;}catch(e){if(e.code==='ENOENT')return 'missing';throw e;}}).join('|');
    if(signature===s.signature)return;
    s.turns=parseAntigravityTranscriptToTurns(s.transcriptPath,{rawSteps:true,expectedSessionId:s.geminiChatId,receiptsFile:this._receiptPath(s)});s.signature=signature;
  }
  _fail(s,error){
    if(s.error===error.message)return;
    s.error=error.message;console.warn('[antigravity-tap]',s.id,error.message);
    this.emit('turn-error',{hubSessionId:s.id,kind:'gemini',error:error.message,message:error.message,source:'antigravity-cli'});
  }
  _poll(s){
    try{
      const st=fs.existsSync(s.antigravityEventsFile)?fs.statSync(s.antigravityEventsFile):null;
      if(st){
        const size=st.size,fileId=statIdentity(st),from=s.bytes||0;
        let reset=false;
        if(size<from)reset=true;
        else if(s.fileId && fileId!==s.fileId)reset=true;
        else if(from>0 && s.headSig && st.mtimeMs!==s.mtimeMs && readHeadHex(s.antigravityEventsFile,s.headSig.length/2)!==s.headSig)reset=true;
        if(reset){s.bytes=0;s.offset=0;s.headSig=null;}
        const curFrom=s.bytes||0;
        if(size>curFrom){
          // 每 400ms 一轮：只读上次读到的字节位置之后新增的部分，截断或同尺寸轮转时自动归零重读（2026-11-23 开销优化）。
          const buf=readRange(s.antigravityEventsFile,curFrom,size-curFrom);
          const end=buf.lastIndexOf(0x0a)+1;
          let pos=0;
          // Advance past each line before handling it: one bad line must not make
          // the next poll replay the lines before it (a second turn-started).
          while(pos<end){
            const next=buf.indexOf(0x0a,pos)+1,line=buf.subarray(pos,next-1).toString('utf8');
            pos=next;s.bytes=curFrom+pos;s.offset=(s.offset||0)+line.length+1;
            if(!line.trim())continue;
            try{this._event(s,JSON.parse(line));}catch(error){this._fail(s,error);}
          }
          s.bytes=curFrom+pos;
        }
        s.fileId=fileId;s.mtimeMs=st.mtimeMs;
        if((s.bytes||0)>0 && (!s.headSig || (s.headSig.length<128 && size>s.headSig.length/2)))s.headSig=readHeadHex(s.antigravityEventsFile,size);
      }
      this._read(s);
      if(s.pendingStop)this._finishStop(s);
      if(s.active)this._observeUser(s);
      if(s.active)this.emit('progress-update',{hubSessionId:s.id,kind:'gemini',source:'antigravity-cli'});
      s.error=null;
    }catch(error){this._fail(s,error);}
  }
  _observeUser(s){
    const u=s.turns.filter(t=>t.role==='user').at(-1);
    if(u&&u.id!==s.lastUser){s.lastUser=u.id;this.emit('prompt-submitted',{hubSessionId:s.id,kind:'gemini',text:u.text,
      transcriptPath:s.transcriptPath,submittedAt:u.ts||Date.now(),signalSource:'antigravity_user_message'});}
  }
  _event(s,e){
    if(e.hubSessionId!==s.id||!UUID.test(e.conversationId||''))throw Error('Antigravity 事件身份无效');
    if(e.transcriptPath && !new RegExp('[\\\\/]brain[\\\\/]'+e.conversationId+'[\\\\/]','i').test(e.transcriptPath))throw Error('Antigravity 转录路径身份无效');
    // The hook env is private to this PTY, so another conversation id means the
    // user switched conversations inside agy (/new, /resume). Follow it, like
    // Codex /new rebinding, instead of rejecting every later event forever.
    if(s.geminiChatId && s.geminiChatId!==e.conversationId){
      console.log('[antigravity-tap]',s.id,'conversation switched',s.geminiChatId,'->',e.conversationId);
      Object.assign(s,{turns:[],signature:null,lastUser:null,lastText:null,active:false,pendingStop:null,transcriptPath:null});
    }
    const fresh=!s.geminiChatId||s.geminiChatId!==e.conversationId||s.transcriptPath!==e.transcriptPath;
    s.geminiChatId=e.conversationId;
    if(e.transcriptPath)s.transcriptPath=e.transcriptPath;
    if(fresh)this.emit('session-bound',{hubSessionId:s.id,kind:'gemini',geminiChatId:s.geminiChatId,
      geminiProjectHash:'antigravity',geminiProjectRoot:s.cwd,sessionPath:s.transcriptPath});
    // Read native content before publishing lifecycle so collectors see this turn.
    this._read(s);
    if(e.observedAt < (s.registeredAt||0))return;
    const ev={hubSessionId:s.id,kind:'gemini',source:'antigravity-cli',signalSource:'antigravity_hook',startedAt:e.observedAt,transcriptPath:s.transcriptPath,ts:e.observedAt,modelId:e.modelName};
    if(e.event==='PreInvocation'){
      if(!s.active){s.active=true;s.lastText=null;s.pendingStop=null;this.emit('turn-started',ev);}
      this._observeUser(s);
    }
    if(e.event==='Stop' && e.fullyIdle===true){
      const key=`${e.executionNum}:${e.observedAt}`;if(s.lastStop===key)return;s.active=false;
      if(e.error||e.terminationReason==='error'){s.lastStop=key;const error=e.error||'Antigravity 执行失败';this.emit('turn-error',{...ev,error,message:error});return;}
      // 1.3.3 emits NO_TOOL_CALL for a successful final response; newer hook
      // documentation calls the same normal completion model_stop.
      if(!['model_stop','NO_TOOL_CALL'].includes(e.terminationReason)){s.lastStop=key;this.emit('turn-aborted',{...ev,reason:e.terminationReason||'未收到正常结束原因'});return;}
      s.pendingStop={key,ev,observedAt:e.observedAt,since:Date.now()};
      this._finishStop(s);
    }
  }
  // Stop can arrive before agy flushes the final step to transcript.jsonl.
  // Wait for the text on later polls; only a long absence is a real failure.
  _finishStop(s){
    const p=s.pendingStop;if(!p)return;
    const lastUser=s.turns.findLastIndex(t=>t.role==='user');
    const latest=s.turns.slice(lastUser+1).filter(t=>t.role==='assistant').at(-1);
    // A tool hand-off/result is not the final answer. Stop may be ahead of
    // the last planner row on disk; wait rather than publishing the progress.
    const answer=latest?.text && !latest.toolCalls?.length ? latest : null;
    if(!answer){
      if(Date.now()-p.since<STOP_FLUSH_GRACE_MS)return;
      s.pendingStop=null;s.lastStop=p.key;
      const error='Antigravity 已停止，但最终正文没有写入原生记录';
      this.emit('turn-error',{...p.ev,error,message:error});return;
    }
    s.pendingStop=null;s.lastText=answer.text;
    // The receipt only upgrades the card label to final; failing to write it must
    // never swallow the completion that group chat and status are waiting for.
    const file=this._receiptPath(s),tmp=file+'.'+process.pid+'.tmp';
    try{
      let receipts={};try{receipts=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};}catch{receipts={};}
      receipts[answer.id]={ts:answer.ts,textHash:hash(answer.text),outcome:'completed',completedAt:p.observedAt};
      fs.writeFileSync(tmp,JSON.stringify(receipts),'utf8');fs.renameSync(tmp,file);
      this._read(s);
    }catch(error){console.warn('[antigravity-tap]',s.id,'completion receipt not written:',error.message);try{fs.rmSync(tmp,{force:true});}catch{}}
    s.lastStop=p.key;
    this.emit('turn-complete',{...p.ev,text:s.lastText||'',completedAt:p.observedAt});
  }
  getLastAssistantText(id){return this._bound.get(id)?.lastText||null;}
  getStreamingText(id){const s=this._bound.get(id);if(!s?.active)return null;
    const lastUser=s.turns.findLastIndex(t=>t.role==='user');
    const a=s.turns.slice(lastUser+1).filter(t=>t.role==='assistant'&&t.text).at(-1);
    return a?[{type:'text',text:a.text}]:null;}
  clearStreamingBuf(){}
  getLastTokens(){return null;}
  clearLastTokens(){}
  async extractLatestGeminiTurn(id,since=0){const s=this._bound.get(id);if(!s)return null;this._read(s);const t=s.turns.filter(t=>t.role==='assistant'&&t.text&&(!since||t.ts>=since)).at(-1);return t?{text:t.text,source:'antigravity-cli'}:null;}
  getDebugSnapshot(){return [...this._bound.values()].map(s=>({hubSessionId:s.id,conversationId:s.geminiChatId,transcriptPath:s.transcriptPath,active:s.active,error:s.error}));}
}
// Existing Gemini transcripts stay readable; every new session uses the native agy adapter.
class GoogleCliTap extends EventEmitter {
  constructor(legacy){super();this.legacy=legacy;this.agy=new AntigravityTap();for(const b of [legacy,this.agy])for(const e of EVENTS)b.on(e,v=>this.emit(e,v));}
  get _bound(){return new Map([...this.legacy._bound,...this.agy._bound]);}
  get _pending(){return this.legacy._pending;}
  _for(id){return this.agy.hasSession(id)?this.agy:this.legacy;}
  registerSession(id,ctx){this.unregisterSession(id);(isAntigravity(ctx)?this.agy:this.legacy).registerSession(id,ctx);}
  unregisterSession(id){this.legacy.unregisterSession(id);this.agy.unregisterSession(id);}
  hasSession(id){return this.agy.hasSession(id)||this.legacy.hasSession(id);}
  getDebugSnapshot(){return {legacy:this.legacy.getDebugSnapshot(),antigravity:this.agy.getDebugSnapshot()};}
}
for(const method of ['notePrompt','getLastAssistantText','getStreamingText','clearStreamingBuf','getLastTokens','clearLastTokens','extractLatestGeminiTurn'])
  GoogleCliTap.prototype[method]=function(id,...args){return this._for(id)[method](id,...args);};
module.exports={AntigravityTap,GoogleCliTap};
