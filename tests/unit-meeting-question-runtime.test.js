'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AnswerStream,errorInfo,trimContext}=require('../main/ask-aside/answer-stream');
const {QuestionRuntime,safeCommand,redact}=require('../main/ask-aside/question-runtime');
const {StreamCapabilities}=require('../main/ask-aside/stream-capabilities');
const {QuestionSlots}=require('../main/ask-aside/question-slots');
const line = v => JSON.stringify(v)+'\n';
const delta = text => ({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}});
test('流式协议：半行/跨字节中文、乱码行、工具与思考不进入回答，最终文本不重复',()=>{
 let thinking=0;const seen=[],events=[],p=new AnswerStream({onText:s=>seen.push(s),onEvent:s=>events.push(s),onThinking:()=>thinking++});
 const wire=Buffer.from('坏协议\n'+line({type:'system',subtype:'init'})+line({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'不要展示'}}})+line(delta('首字中文'))+line(delta('继续'))+line({type:'assistant',message:{id:'a',content:[{type:'text',text:'首字中文继续'},{type:'tool_use',name:'Read',input:{secret:'do not show'}}]}})+line({type:'result',subtype:'success',result:'首字中文继续'}));
 for(let i=0;i<wire.length;i+=2)p.write(wire.subarray(i,i+2));
 const result=p.end();assert.equal(result.answer,'首字中文继续');assert.equal(result.sawJson,true);assert.equal(thinking,1);assert.ok(seen.includes('首字中文'));assert.ok(seen.every(s=>!s.includes('不要展示')&&!s.includes('secret')));assert.ok(events.includes('tool_use Read'));
});
test('CodeAgent 没有 partial 时，assistant 到达即提供首字，EOF 未换行也处理',()=>{
 const seen=[],p=new AnswerStream({onText:s=>seen.push(s)});p.write(line({type:'system',subtype:'init'}));assert.equal(seen.length,0);
 p.write(JSON.stringify({type:'assistant',message:{id:'a',content:[{type:'text',text:'整段回答'}]}}));assert.equal(seen.length,0);assert.equal(p.end().answer,'整段回答');assert.deepEqual(seen,['整段回答']);
});
test('同一 assistant message id 分批发 thinking/text 块时正文保留，重复块不重复拼接',()=>{
 const p=new AnswerStream();const id='msg_shared';
 for(const content of [[{type:'thinking',thinking:'不展示'}],[{type:'text',index:1,text:'第一块'}],[{type:'text',index:2,text:'第二块'}],[{type:'text',index:2,text:'第二块'}]])p.write(line({type:'assistant',message:{id,content}}));
 assert.equal(p.end().answer,'第一块第二块');
});
test('真实订阅协议归一化样本：system thinking_tokens只报进度，首字从正文delta开始',()=>{
 const sample=require('./fixtures/meeting-real-stream-samples.json');let thinking=0;const seen=[];const p=new AnswerStream({onThinking:()=>thinking++,onText:s=>seen.push(s)});
 for(const event of sample.thinkingEvents)p.write(line(event));assert.equal(thinking,1);assert.equal(seen.length,0);
 const text=sample.assistantEvents.flatMap(e=>e.message.content.filter(c=>c.type==='text').map(c=>c.text)).join('');
 p.write(line(delta(text.slice(0,2))));assert.equal(seen[0],text.slice(0,2));for(const event of sample.assistantEvents)p.write(line(event));assert.equal(p.end().answer,text.trim());assert.equal(thinking,1);
});
test('协议字段形状错误不导致主进程崩溃，失败 result 不是成功答案',()=>{
 const p=new AnswerStream();p.write(line({type:'assistant',message:{content:'bad shape'}}));p.write(line({type:'result',is_error:true,errors:'quota'}));const r=p.end();assert.equal(r.answer,'');assert.equal(r.error,'quota');
});
test('无 JSON 行直接采用当次 text，支持后续按引擎记兼容模式，无需再次请求模型',()=>{
 const p=new AnswerStream();p.write(Buffer.from('\x1b[32m普通文本回答\x1b[0m'));assert.deepEqual(p.end(),{answer:'普通文本回答',truncated:false,sawJson:false,fallbackText:true});
 const q=new AnswerStream({format:'text',maxAnswer:3});q.write('abcdef');assert.equal(q.end().answer,'abc');assert.equal(q.end().truncated,true);
});
test('Codex JSON 只接回答步骤，updated/completed 同一条消息不重复',()=>{
 const p=new AnswerStream();for(const e of [{type:'item.completed',item:{id:'cmd',type:'command_execution',aggregated_output:'不能进入回答'}},{type:'item.updated',item:{id:'a',type:'agent_message',text:'先答'}},{type:'item.completed',item:{id:'a',type:'agent_message',text:'先答完'}},{type:'item.completed',item:{id:'b',type:'agent_message',text:'下一段'}}])p.write(line(e));assert.equal(p.end().answer,'先答完\n下一段');
});
test('失败类别覆盖取消、两种超时、未就绪、进程失败和空回答，每项有下一步',()=>{
 for(const [input,kind]of [[{cancelled:true},'cancelled'],[{timedOut:true,timeoutKind:'idle'},'idle-timeout'],[{timedOut:true,timeoutKind:'total'},'total-timeout'],[{code:'MEETING_CONTEXT_NOT_READY'},'context-not-ready'],[{code:'ENOENT'},'spawn-failed'],[{message:'会议问答后台尚未就绪'},'service-not-ready'],[{message:'会议模型尚未就绪'},'engine-not-ready'],[{exitCode:2},'exit-nonzero'],[{message:'没有返回内容'},'empty-answer'],[{message:'Hub 重启中断'},'interrupted'],[{},'unknown']]){const result=errorInfo(input);assert.equal(result.errorKind,kind);assert.ok(result.errorHint);}
});
test('超长材料保纪要开头和最新原话，始终满足 6 万字',()=>{
 const input='纪要开头'+ '中'.repeat(90000)+'最近原话';const r=trimContext(input);assert.equal(r.context.length,60000);assert.ok(r.context.startsWith('纪要开头')&&r.context.endsWith('最近原话'));assert.equal(r.trimmed,true);assert.deepEqual(trimContext('短材料'),{context:'短材料',trimmed:false});
});
test('CLI 参数兼容缓存按引擎隔离，只有明确参数拒绝且未收到模型内容才允许兜底',()=>{
 const c=new StreamCapabilities({limit:2}),claude={flavor:'claude',command:'claude'},company={flavor:'codeagent',command:'codeagent'};
 assert.equal(c.rejected(claude,Error("unknown option '--effort'")).effort,false);
 assert.equal(c.get(company).effort,true);assert.equal(c.rejected(claude,Error("unknown option '--effort'")),null);
 assert.equal(c.rejected(company,Error('unsupported stream-json'),{sawJson:true}),null);
 assert.equal(c.rejected(company,Error('unsupported stream-json'),{answer:'部分回答'}),null);
 assert.equal(c.rejected(company,Error('network timeout')),null);
 assert.equal(c.rejected(company,Error('unknown --include-partial-messages')).partial,false);
 assert.equal(c.get(company).stream,true);c.observed(company,{fallbackText:true});assert.equal(c.get(company).stream,false);
 c.update({flavor:'codex',command:'codex'},{stream:false});assert.equal(c.entries.size,2);
});
test('会议保留一个进程位，排队取消不泄漏，释放不重复扣减',async()=>{
 const slots=new QuestionSlots(),a=await slots.acquire(),b=await slots.acquire();assert.deepEqual(slots.stats(),{running:2,max:3});
 const abort=new AbortController();let waiting;
 const ordinary=slots.acquire({signal:abort.signal,onWait:s=>waiting=s});assert.equal(waiting.running,2);
 const meeting=await slots.acquire({meeting:true});assert.equal(slots.running,3);abort.abort(Object.assign(Error('cancel'),{cancelled:true}));await assert.rejects(ordinary,/cancel/);
 assert.equal(slots.waiters.length,0);slots.release(a);slots.release(a);slots.release(b);slots.release(meeting);assert.equal(slots.running,0);
});
test('进程位满时会议优先接空位；服务退出解除全部等待',async()=>{
 const slots=new QuestionSlots(),a=await slots.acquire(),b=await slots.acquire(),c=await slots.acquire({meeting:true});
 let ordinaryStarted=false;const normal=slots.acquire().then(x=>{ordinaryStarted=true;return x;});const question=slots.acquire({meeting:true});slots.release(c);const d=await question;assert.equal(d.meeting,true);assert.equal(ordinaryStarted,false);
 slots.dispose();assert.equal(await normal,null);slots.release(a);slots.release(b);slots.release(d);assert.equal(slots.running,0);
});
function clock(){let t=1000,id=0;const timers=new Map();return{now:()=>t,setTimer:(fn,ms)=>{timers.set(++id,{fn,at:t+ms});return id;},clearTimer:id=>timers.delete(id),advance:ms=>{t+=ms;for(const[id,v]of[...timers])if(v.at<=t){timers.delete(id);v.fn();}},timers};}
test('阶段切换立即推送与持久回调；普通片段 250ms，超过8千字 1s，结束无悬挂计时器',()=>{
 const c=clock(),push=[],phases=[];const r=new QuestionRuntime({...c,meetingId:'m',questionId:'q',emit:(_ch,v)=>push.push(v),onPhase:s=>phases.push(s)});
 r.phase('queued','已送达');r.phase('starting','启动');r.start({pid:1,cwd:'D:/tmp',command:'claude'});r.chunk('首');const n=push.length;
 r.chunk('首字');r.chunk('首字继续');assert.equal(push.length,n);c.advance(249);assert.equal(push.length,n);c.advance(1);assert.equal(push.at(-1).partial,'首字继续');
 const saved=phases.length;r.chunk('字'.repeat(9000));c.advance(250);assert.equal(push.at(-1).chars,4);c.advance(750);assert.equal(push.at(-1).chars,9000);assert.equal(phases.length,saved,'出字不调用阶段落盘');
 r.chunk('字'.repeat(9100));r.finish('done','完成');assert.equal(push.at(-1).phase,'done');assert.equal(c.timers.size,0);assert.equal(r.meta.firstTokenAt,1000);assert.equal(r.meta.endedAt,2250);
});
test('后台环形记录、stdout 2千字、stderr 8KB、脱敏和终态落盘≤64KB',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'m2-question-log-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const r=new QuestionRuntime({questionId:'11111111-1111-4111-8111-111111111111'});
 r.start({command:'claude',args:['--api-key','SENSITIVE_A','--settings','{"env":{"ANTHROPIC_AUTH_TOKEN":"SENSITIVE_B"}}','--header','Authorization: Bearer SENSITIVE_C']});
 for(let i=0;i<300;i++)r.log('event','事件'+i+'中'.repeat(1500));assert.equal(r.lines.length,128);
 r.log('stdout','文'.repeat(3000));r.log('stdout','后续');r.log('stderr','e'.repeat(12000));r.finish('error','失败');
 assert.equal(r.lines.filter(l=>l.kind==='stdout').map(l=>l.text).join('').length,2000);assert.equal(r.lines.find(l=>l.kind==='stderr').text.length,8192);
 const file=r.save(root,{sessionId:'original',state:'error'});assert.ok(fs.statSync(file).size<=65536);const record=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(record.understanding.sessionId,'original');assert.ok(!record.meta.command.includes('SENSITIVE_'));assert.ok(record.lines.length<=128);
 for(const s of [safeCommand('cli',['--token','SENSITIVE_D']),redact('api_key="SENSITIVE_E"'),redact('Authorization: Bearer SENSITIVE_F'),redact('stderr bare sk-ant-SENSITIVE_G'),redact('Cookie: sessionid=SENSITIVE_H; csrftoken=SENSITIVE_I'),redact('< Set-Cookie: SID=SENSITIVE_J; Path=/; HttpOnly'),redact('{"headers":{"cookie":"SENSITIVE_K"}}')])assert.ok(!s.includes('SENSITIVE_'));
 assert.equal(redact('会话已关闭\nCookie: a=SENSITIVE_L\n下一行照常'),'会话已关闭\nCookie: [已隐藏]\n下一行照常');
 r.log('stderr','错'.repeat(10000));assert.ok(Buffer.byteLength(r.lines.find(l=>l.kind==='stderr').text)<=8192);
 r.log('stderr','裸令牌 sk-ant-SENSITIVE_G');r.save(root);assert.ok(!fs.readFileSync(file,'utf8').includes('SENSITIVE_G'));
});
test('窗口关闭或阶段写盘失败不从 stdout 回调抛出，状态仍可轮询补齐',()=>{
 const r=new QuestionRuntime({emit:()=>{throw Error('closed window');},onPhase:()=>{throw Error('disk busy');}});
 assert.doesNotThrow(()=>{r.phase('starting','启动');r.chunk('回答');r.finish('done','完成');});assert.equal(r.view().partial,'回答');assert.ok(r.lines.some(l=>l.text.includes('暂不可用')));assert.ok(r.callbackError);
});
