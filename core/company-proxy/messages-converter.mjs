import {anthropicErrorEvent,midStreamMessage} from './failure-text.mjs';
import {randomUUID} from 'node:crypto';
const replayMarker='codeagent-chat-reasoning-v1';
function fail(message,status=422){return Object.assign(new Error(message),{status,code:'unsupported_protocol'});}
function textContent(content){
 if(typeof content==='string')return content;
 if(!Array.isArray(content))throw fail('Expected text content');
 return content.map(x=>{if(x.type!=='text')throw fail(`Unsupported content block: ${x.type}`);return x.text;}).join('\n');
}
export function convertMessagesRequest(body,{mapThinking,mapOutputConfig}={}){
 if(!body||typeof body.model!=='string'||!Array.isArray(body.messages))throw fail('model and messages are required',400);
 const messages=[];
 if(body.system)messages.push({role:'system',content:textContent(body.system)});
 for(const msg of body.messages){
  if(!['user','assistant','system'].includes(msg.role))throw fail(`Unsupported role: ${msg.role}`);
  if(typeof msg.content==='string'){messages.push({role:msg.role,content:msg.content});continue;}
  if(!Array.isArray(msg.content))throw fail('Message content must be a string or blocks',400);
  let text=[],calls=[],reasoning=[];
  const flush=()=>{if(text.length||calls.length||reasoning.length){const m={role:msg.role,content:text.join('\n')||null};if(calls.length)m.tool_calls=calls;if(reasoning.length)m.reasoning_content=reasoning.join('');messages.push(m);text=[];calls=[];reasoning=[];}};
  for(const b of msg.content){
   if(b.type==='text')text.push(b.text);
   else if(b.type==='tool_use'&&msg.role==='assistant')calls.push({id:b.id,type:'function',function:{name:b.name,arguments:JSON.stringify(b.input)}});
   else if(b.type==='tool_result'&&msg.role==='user'){flush();messages.push({role:'tool',tool_call_id:b.tool_use_id,content:(b.is_error?'[Tool execution error]\n':'')+textContent(b.content??'')});}
   else if(b.type==='thinking'&&msg.role==='assistant'&&b.signature===replayMarker)reasoning.push(b.thinking);
   else throw fail(`Unsupported ${msg.role} content block: ${b.type}; refusing silent loss`);
  }
  flush();
 }
 const out={model:body.model,messages,stream:!!body.stream};
 for(const k of ['max_tokens','temperature','top_p'])if(body[k]!==undefined)out[k]=body[k];
 if(body.stop_sequences!==undefined)out.stop=body.stop_sequences;
 if(body.tools)out.tools=body.tools.map(t=>{if(t.type&&t.type!=='custom')throw fail(`Unsupported tool type: ${t.type}`);return {type:'function',function:{name:t.name,...(t.description!==undefined?{description:t.description}:{}),parameters:t.input_schema}};});
 if(body.tool_choice){const c=body.tool_choice;if(c.type==='auto')out.tool_choice='auto';else if(c.type==='any')out.tool_choice='required';else if(c.type==='none')out.tool_choice='none';else if(c.type==='tool')out.tool_choice={type:'function',function:{name:c.name}};else throw fail(`Unsupported tool choice ${c.type}`);if(c.disable_parallel_tool_use!==undefined)out.parallel_tool_calls=!c.disable_parallel_tool_use;}
 if(body.thinking){if(!mapThinking)throw fail('Explicit thinking requires a verified upstream thinking mapping');Object.assign(out,mapThinking(body.thinking));}
 if(body.output_config){if(!mapOutputConfig)throw fail('output_config needs a verified upstream mapping');Object.assign(out,mapOutputConfig(body.output_config));}
 // cache_control is an Anthropic caching hint; only content is forwarded. No cache-hit claim is made.
 return out;
}
const stopReason=r=>{if(r==='tool_calls')return 'tool_use';if(r==='stop')return 'end_turn';if(r==='length')return 'max_tokens';throw fail(`Unsupported upstream finish reason: ${r}`,502);};
const usage=u=>({input_tokens:u?.prompt_tokens??0,output_tokens:u?.completion_tokens??0});
function reportUsage(callback,value){if(!callback)return;const warn=()=>process.stderr.write('Local proxy usage observer failed\n');try{Promise.resolve(callback(value)).catch(warn);}catch{warn();}}
export function convertChatJson(body){
 const c=body.choices?.[0];if(!c?.message)throw fail('Missing upstream message',502);
 const content=[];if(c.message.reasoning_content)content.push({type:'thinking',thinking:c.message.reasoning_content,signature:replayMarker});
 if(c.message.content)content.push({type:'text',text:c.message.content});
 for(const t of c.message.tool_calls||[]){if(t.type!=='function')throw fail('Unsupported upstream tool',502);let input;try{input=JSON.parse(t.function.arguments);}catch{throw fail('Upstream tool arguments are invalid JSON',502);}if(!input||Array.isArray(input)||typeof input!=='object')throw fail('Upstream tool input must be an object',502);content.push({type:'tool_use',id:t.id,name:t.function.name,input});}
 return {id:body.id||`msg_${randomUUID()}`,type:'message',role:'assistant',model:body.model,content,stop_reason:stopReason(c.finish_reason),stop_sequence:null,usage:usage(body.usage)};
}
async function* frames(body,{signal}={}){
 if(!body)throw fail('Empty upstream stream',502);
 const reader=body.getReader(),decoder=new TextDecoder();let buf='';
 const abort=()=>{reader.cancel(signal.reason).catch(()=>{});};
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 try{while(true){if(signal?.aborted)throw signal.reason||new Error('Cancelled');const {done,value}=await reader.read();if(signal?.aborted)throw signal.reason||new Error('Cancelled');buf=(buf+decoder.decode(value,{stream:!done})).replace(/\r\n/g,'\n');let at;while((at=buf.indexOf('\n\n'))>=0){const frame=buf.slice(0,at);buf=buf.slice(at+2);const data=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(data)yield data;}if(done)break;}if(buf.trim())throw fail('Truncated upstream SSE frame',502);}finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function convertChatResponse(response,{signal,onUsage}={}){
 if(!response.ok)return response;
 if(!(response.headers.get('content-type')||'').includes('text/event-stream')){const body=await response.json();reportUsage(onUsage,{known:body.usage?.prompt_tokens!==undefined&&body.usage?.completion_tokens!==undefined,upstream:body.usage??null});return Response.json(convertChatJson(body),{headers:{'x-codeagent-usage-policy':'upstream-only; missing-values-are-protocol-placeholders'}});}
 const enc=new TextEncoder();
 const streamAbort=new AbortController();let cancelled=false;
 const abort=()=>streamAbort.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const stream=new ReadableStream({async start(controller){
  const emit=(event,data)=>controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  let started=false,nextIndex=0,done=false,finish=null,model='',use={},textIndex=null,thinkingIndex=null;
  const blocks=new Map();const tools=new Map();
  const start=(type,data)=>{const index=nextIndex++;blocks.set(index,type);emit('content_block_start',{type:'content_block_start',index,content_block:data});return index;};
  try{
   for await(const raw of frames(response.body,{signal:streamAbort.signal})){
    if(raw==='[DONE]'){done=true;break;}
    let chunk;try{chunk=JSON.parse(raw);}catch{throw fail('Invalid upstream SSE JSON',502);}
    if(chunk.error)throw fail(chunk.error.message||'Upstream stream error',502);
    model=chunk.model||model;if(chunk.usage)use=chunk.usage;
    if(!started){started=true;emit('message_start',{type:'message_start',message:{id:chunk.id||`msg_${randomUUID()}`,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}});}
    const c=chunk.choices?.[0];if(!c)continue;const d=c.delta||{};
    if(d.reasoning_content){if(thinkingIndex===null)thinkingIndex=start('thinking',{type:'thinking',thinking:'',signature:''});emit('content_block_delta',{type:'content_block_delta',index:thinkingIndex,delta:{type:'thinking_delta',thinking:d.reasoning_content}});}
    if(d.content){if(textIndex===null)textIndex=start('text',{type:'text',text:''});emit('content_block_delta',{type:'content_block_delta',index:textIndex,delta:{type:'text_delta',text:d.content}});}
    for(const t of d.tool_calls||[]){
     if(!Number.isInteger(t.index)||t.index<0)throw fail('Upstream tool index must be a nonnegative integer',502);
     let state=tools.get(t.index);if(!state){state={id:'',name:'',args:''};tools.set(t.index,state);}
     if(t.id)state.id+=t.id;if(t.function?.name)state.name+=t.function.name;
     const fragment=t.function?.arguments||'';state.args+=fragment;
    }
    if(c.finish_reason!==null&&c.finish_reason!==undefined)finish=c.finish_reason;
   }
   if(!done||!started||finish===null)throw fail('Upstream stream ended without DONE and finish_reason',502);
   for(const state of tools.values()){if(!state.id||!state.name)throw fail('Incomplete upstream tool identity',502);if(!state.args.trim())state.args='{}';let input;try{input=JSON.parse(state.args);}catch{throw fail('Invalid upstream tool arguments',502);}if(!input||Array.isArray(input)||typeof input!=='object')throw fail('Upstream tool input must be an object',502);const index=start('tool_use',{type:'tool_use',id:state.id,name:state.name,input:{}});emit('content_block_delta',{type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:state.args}});}
   if(thinkingIndex!==null)emit('content_block_delta',{type:'content_block_delta',index:thinkingIndex,delta:{type:'signature_delta',signature:replayMarker}});
   for(const index of blocks.keys())emit('content_block_stop',{type:'content_block_stop',index});
   reportUsage(onUsage,{known:use.prompt_tokens!==undefined&&use.completion_tokens!==undefined,upstream:Object.keys(use).length?use:null});
   emit('message_delta',{type:'message_delta',delta:{stop_reason:stopReason(finish),stop_sequence:null},usage:usage(use)});
   emit('message_stop',{type:'message_stop'});controller.close();
  }catch(e){
   // Headers are out: report the failure as Anthropic's "event: error" with a readable reason, then end the stream.
   if(cancelled||signal?.aborted){if(!cancelled)controller.error(e);}
   else{try{controller.enqueue(enc.encode(anthropicErrorEvent(midStreamMessage(e))));controller.close();}catch{controller.error(e);}}
  }finally{signal?.removeEventListener('abort',abort);}
 },cancel(reason){cancelled=true;streamAbort.abort(reason||new Error('Consumer cancelled'));}});
 return new Response(stream,{status:200,headers:{'content-type':'text/event-stream','cache-control':'no-cache','x-codeagent-usage-policy':'upstream-only; missing-values-are-protocol-placeholders'}});
}
