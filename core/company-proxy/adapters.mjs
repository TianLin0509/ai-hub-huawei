// Daily-use protocol adapters (v0.1).
// Only *normalization* lives here: it trims client requests down to the shape the
// existing, already-verified converters and the personal L1 provider accept.
// The protocol conversion itself is reused unchanged:
//   Claude  /v1/messages        -> clients/20261105-messages-converter-codex.mjs
//   Codex   /v1/responses       -> proxy/20261105-responses-converter-codex.mjs
//   DSH     /v1/chat/completions -> passthrough (already OpenAI chat shape)
import {convertMessagesRequest,convertChatResponse} from './messages-converter.mjs';
import {convertResponsesRequest,convertChatToResponses} from './responses-converter.mjs';

export const MODEL_GLM='GLM-5.2-WX';
export const MODEL_DS='deepseek-v4.1-flash-1017';
export const MODELS=Object.freeze([MODEL_GLM,MODEL_DS]);
export const KIND=Symbol('daily-client-kind'); // non-enumerable routing tag, never serialized
const REPLAY_MARKER='codeagent-chat-reasoning-v1';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const refused=(message,status=422)=>Object.assign(new Error(message),{code:'unsupported_protocol',status});
const placeholder=type=>`[${type} 内容未转发：公司模型当前只支持文本]`;

export function resolveModel(name,defaultModel){
  if(MODELS.includes(name))return name;
  const lower=typeof name==='string'?name.toLowerCase():'';
  if(lower.includes('glm'))return MODEL_GLM;
  if(lower.includes('deepseek')||lower==='ds')return MODEL_DS;
  return defaultModel; // e.g. claude-haiku-* background calls from Claude Code
}
function tag(body,kind){Object.defineProperty(body,KIND,{value:kind,enumerable:false});return body;}
function capTokens(value,cap){return Number.isSafeInteger(value)&&value>0?Math.min(value,cap):undefined;}

// ---------- Claude Code (Anthropic Messages) ----------
function claudeTextBlocks(content){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return '';
  return content.map(b=>b?.type==='text'?{type:'text',text:String(b.text??'')}:{type:'text',text:placeholder(b?.type||'unknown')});
}
function normalizeClaudeMessages(messages){
  const out=[];
  for(const msg of Array.isArray(messages)?messages:[]){
    if(!object(msg))continue;
    if(typeof msg.content==='string'){out.push({role:msg.role,content:msg.content});continue;}
    const blocks=[];
    for(const b of Array.isArray(msg.content)?msg.content:[]){
      if(!object(b))continue;
      if(b.type==='text')blocks.push({type:'text',text:String(b.text??'')});
      else if(b.type==='tool_use'&&msg.role==='assistant')blocks.push({type:'tool_use',id:b.id,name:b.name,input:object(b.input)?b.input:{}});
      else if(b.type==='tool_result'&&msg.role==='user')blocks.push({type:'tool_result',tool_use_id:b.tool_use_id,is_error:b.is_error===true,content:claudeTextBlocks(b.content??'')});
      else if(b.type==='thinking'&&msg.role==='assistant'){if(b.signature===REPLAY_MARKER)blocks.push({type:'thinking',thinking:String(b.thinking??''),signature:REPLAY_MARKER});}
      else if(['redacted_thinking','server_tool_use','web_search_tool_result'].includes(b.type))continue;
      else blocks.push({type:'text',text:placeholder(b.type||'unknown')});
    }
    out.push({role:msg.role,content:blocks});
  }
  return out;
}
export function createClaudeAdapter({defaultModel,maxTokensCap=32768,onRequest=()=>{}}){
  return {
    convertRequest(body){
      body.model=resolveModel(body.model,defaultModel);
      const thinkingOn=object(body.thinking)&&body.thinking.type!=='disabled';
      const clean={model:body.model,messages:normalizeClaudeMessages(body.messages),stream:true};
      if(body.system!==undefined)clean.system=claudeTextBlocks(body.system);
      if(Array.isArray(body.tools)){
        const tools=body.tools.filter(t=>object(t)&&(!t.type||t.type==='custom')&&typeof t.name==='string');
        if(tools.length)clean.tools=tools.map(t=>({name:t.name,...(typeof t.description==='string'?{description:t.description}:{}),input_schema:object(t.input_schema)?t.input_schema:{type:'object',properties:{}}}));
      }
      const maxTokens=capTokens(body.max_tokens,maxTokensCap);if(maxTokens)clean.max_tokens=maxTokens;
      if(Number.isFinite(body.temperature))clean.temperature=body.temperature;
      if(Array.isArray(body.stop_sequences)&&body.stop_sequences.length)clean.stop_sequences=body.stop_sequences;
      if(thinkingOn)clean.thinking={type:'enabled'};
      const converted=convertMessagesRequest(clean,{mapThinking:()=>({thinking:{type:'enabled'},reasoning_effort:'high'})});
      for(const m of converted.messages)if(m.content===null&&!m.tool_calls)m.content='';
      converted.messages=converted.messages.filter(m=>!(m.role==='assistant'&&m.content===''&&!m.tool_calls&&!m.reasoning_content));
      if(converted.messages.length===0)throw refused('Request has no forwardable messages',400);
      onRequest({kind:'claude',model:converted.model,thinking:thinkingOn});
      return tag(converted,'claude');
    },
    convertResponse(response,options){return convertChatResponse(response,options);},
  };
}
// Collect the converted Anthropic SSE into one non-streaming Message JSON.
export async function collectAnthropicMessage(response){
  const text=await response.text();const content=[];let message=null,stopReason=null,usage={input_tokens:0,output_tokens:0};
  const partial=new Map();
  for(const frame of text.split(/\n\n/)){
    const line=frame.split('\n').find(x=>x.startsWith('data:'));if(!line)continue;
    const e=JSON.parse(line.slice(5).trim());
    if(e.type==='message_start')message=e.message;
    else if(e.type==='content_block_start'){content[e.index]={...e.content_block};if(e.content_block.type==='tool_use')partial.set(e.index,'');}
    else if(e.type==='content_block_delta'){
      const b=content[e.index];
      if(e.delta.type==='text_delta')b.text+=e.delta.text;
      else if(e.delta.type==='thinking_delta')b.thinking+=e.delta.thinking;
      else if(e.delta.type==='signature_delta')b.signature=e.delta.signature;
      else if(e.delta.type==='input_json_delta')partial.set(e.index,partial.get(e.index)+e.delta.partial_json);
    }else if(e.type==='message_delta'){stopReason=e.delta.stop_reason;usage=e.usage||usage;}
  }
  for(const [index,json] of partial){let input={};if(json&&json.trim()){try{input=JSON.parse(json);}catch{input={};}}content[index].input=input;}
  if(!message)throw refused('Upstream produced no message',502);
  return {...message,content:content.filter(Boolean),stop_reason:stopReason,usage};
}

// ---------- Codex (OpenAI Responses) ----------
const RESPONSES_FIELDS=new Set(['model','input','instructions','stream','tools','tool_choice','parallel_tool_calls','temperature','max_output_tokens','reasoning','store','include']);
function responsesText(parts){
  if(typeof parts==='string')return parts;
  if(!Array.isArray(parts))return '';
  return parts.map(p=>['input_text','output_text','text'].includes(p?.type)&&typeof p.text==='string'?{type:'input_text',text:p.text}:{type:'input_text',text:placeholder(p?.type||'unknown')});
}
const summaryText=item=>Array.isArray(item?.summary)?item.summary.filter(p=>p?.type==='summary_text'&&typeof p.text==='string').map(p=>p.text).join(''):'';
const CODEX_ITEMS=new Set(['reasoning','function_call','custom_tool_call','function_call_output','custom_tool_call_output','message']);
function normalizeCodexTools(tools){
  const out=[];
  for(const t of Array.isArray(tools)?tools:[]){
    if(!object(t))continue;
    if(t.type==='function'&&typeof t.name==='string'){const {strict,...rest}=t;out.push(rest);}
    else if(t.type==='custom'&&typeof t.name==='string')out.push({type:'custom',name:t.name,...(t.description!==undefined?{description:t.description}:{}),...(t.format!==undefined?{format:t.format}:{})});
    else if(t.type==='namespace'&&Array.isArray(t.tools)){const inner=normalizeCodexTools(t.tools);if(inner.length)out.push({type:'namespace',name:t.name,...(t.description!==undefined?{description:t.description}:{}),tools:inner});}
    // web_search / local_shell / image_generation etc. are dropped: no upstream equivalent.
  }
  return out;
}
export function createCodexAdapter({defaultModel,maxTokensCap=32768,maxReasoningItems=4096,maxReasoningBytes=64*1024*1024,onRequest=()=>{}}){
  const store=new Map();let bytes=0;
  const toolArgs=new Map(); // call id -> original custom-tool argument text, newest maxReasoningItems kept
  const rememberToolArguments=(id,value)=>{toolArgs.delete(id);toolArgs.set(id,value);while(toolArgs.size>maxReasoningItems)toolArgs.delete(toolArgs.keys().next().value);};
  const remember=(id,value)=>{
    if(store.has(id)){bytes-=Buffer.byteLength(store.get(id));store.delete(id);}
    store.set(id,value);bytes+=Buffer.byteLength(value);
    for(const [old,v] of store){if(store.size<=maxReasoningItems&&bytes<=maxReasoningBytes)break;store.delete(old);bytes-=Buffer.byteLength(v);} // oldest first
  };
  return {
    convertRequest(body){
      // The transport passes this same object as `request` to the response side,
      // so the resolved model must be written back in place.
      body.model=resolveModel(body.model,defaultModel);
      const clean={};
      for(const k of Object.keys(body))if(RESPONSES_FIELDS.has(k))clean[k]=body[k];
      clean.store=false;delete clean.previous_response_id;
      if(clean.include!==undefined){clean.include=(Array.isArray(clean.include)?clean.include:[]).filter(x=>x==='reasoning.encrypted_content');if(!clean.include.length)delete clean.include;}
      if(clean.tools!==undefined)clean.tools=normalizeCodexTools(clean.tools);
      if(clean.tool_choice!==undefined&&typeof clean.tool_choice!=='string')clean.tool_choice='auto';
      const input=typeof clean.input==='string'?[{role:'user',content:clean.input}]:Array.isArray(clean.input)?clean.input:[];
      clean.input=input.filter(item=>object(item)&&(item.type===undefined||CODEX_ITEMS.has(item.type))).map(item=>{
        if(!item.type||item.type==='message')return {...item,content:responsesText(item.content)};
        if(item.type==='function_call_output'||item.type==='custom_tool_call_output')return {...item,output:responsesText(item.output)};
        return item;
      });
      clean.reasoning={effort:'high'};
      // Reasoning replay: this process's store first; after a restart or eviction, the full thinking text
      // the client echoes back in the item's summary (Hub sends the whole thinking there). Tool history
      // without any reasoning item is normal when the model did not think (DeepSeek often does not).
      const converted=convertResponsesRequest(clean,{mapReasoning:()=>({thinking:{type:'enabled'},reasoning_effort:'high'}),
        resolveReasoning:item=>store.get(item.id)??summaryText(item),resolveToolArguments:id=>toolArgs.get(id)});
      // The verified Codex upstream contract requires exactly these controls.
      converted.tool_choice='auto';converted.parallel_tool_calls=true;delete converted.top_p;
      for(const t of converted.tools||[])if(t.function&&t.function.strict!==false)delete t.function.strict;
      const maxTokens=capTokens(converted.max_tokens,maxTokensCap);if(maxTokens)converted.max_tokens=maxTokens;else delete converted.max_tokens;
      for(const m of converted.messages)if(m.content===null&&!m.tool_calls)m.content='';
      onRequest({kind:'codex',model:converted.model,thinking:true});
      return tag(converted,'codex');
    },
    convertResponse(response,options){return convertChatToResponses(response,{...options,rememberReasoning:remember,rememberToolArguments,requireUpstreamModel:true});},
    stats:()=>({reasoningItems:store.size,reasoningBytes:bytes}),
  };
}

// ---------- DSH (OpenAI Chat Completions passthrough) ----------
const CHAT_FIELDS=['model','messages','stream','tools','temperature','max_tokens','stop'];
function chatText(content){
  if(typeof content==='string'||content===null)return content;
  if(!Array.isArray(content))return '';
  return content.map(p=>p?.type==='text'&&typeof p.text==='string'?p.text:placeholder(p?.type||'unknown')).join('\n');
}
export function createDshAdapter({defaultModel,maxTokensCap=32768,onRequest=()=>{}}){
  return {
    convertRequest(body){
      body.model=resolveModel(body.model,defaultModel);
      const clean={};for(const k of CHAT_FIELDS)if(body[k]!==undefined)clean[k]=body[k];
      clean.stream=true;
      if(typeof clean.max_tokens!=='number'&&Number.isSafeInteger(body.max_completion_tokens))clean.max_tokens=body.max_completion_tokens;
      const maxTokens=capTokens(clean.max_tokens,maxTokensCap);if(maxTokens)clean.max_tokens=maxTokens;else delete clean.max_tokens;
      const thinkingOn=(object(body.thinking)&&body.thinking.type!=='disabled')||(typeof body.reasoning_effort==='string'&&!object(body.thinking));
      if(thinkingOn){clean.thinking={type:'enabled'};clean.reasoning_effort='high';}
      clean.messages=(Array.isArray(body.messages)?body.messages:[]).filter(object).map(m=>{
        const role=m.role==='developer'?'system':m.role;
        const out={role,content:chatText(m.content)};
        if(out.content===null&&!(role==='assistant'&&Array.isArray(m.tool_calls)))out.content='';
        if(role==='assistant'&&Array.isArray(m.tool_calls)&&m.tool_calls.length)out.tool_calls=m.tool_calls.map(c=>({id:c.id,type:'function',function:{name:c.function?.name,arguments:typeof c.function?.arguments==='string'?c.function.arguments:JSON.stringify(c.function?.arguments??{})}}));
        else if(out.content===null)out.content='';
        if(role==='tool'&&typeof m.tool_call_id==='string')out.tool_call_id=m.tool_call_id;
        if(role==='assistant'&&typeof m.reasoning_content==='string'&&m.reasoning_content)out.reasoning_content=m.reasoning_content;
        return out;
      });
      if(Array.isArray(clean.tools))clean.tools=clean.tools.filter(t=>t?.type==='function'&&object(t.function)).map(t=>({type:'function',function:{name:t.function.name,
        ...(typeof t.function.description==='string'?{description:t.function.description}:{}),parameters:object(t.function.parameters)?t.function.parameters:{type:'object',properties:{}}}}));
      onRequest({kind:'dsh',model:clean.model,thinking:thinkingOn});
      return tag(clean,'dsh');
    },
    convertResponse(response){return response;}, // bytes pass through unchanged
  };
}
