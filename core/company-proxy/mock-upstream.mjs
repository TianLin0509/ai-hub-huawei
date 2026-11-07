// Neutral stand-ins for the identity endpoint and its fields (the real ones are read from the adapter).
export const MOCK_IDENTITY_PATH = '/mock/identity';
export const MOCK_IDENTITY_FIELDS = Object.freeze({ account: 'mockAccount', dept: 'mockDept' });
// TEST ONLY: a synthetic company upstream (identity + chat SSE) and a synthetic
// signer, so the daily proxy can be exercised end-to-end on the home machine.
// It never touches real credentials, signer DLLs or company endpoints.
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const PATH_RE=/[A-Za-z]:[\\/][^\s"'<>|*?]+?\.txt/g;
const text=c=>typeof c==='string'?c:'';
export function createMockSigner(){
  return {init:async()=>true,isAvailable:()=>true,codeagentVersion:()=> '1.2615.02.03',
    kernelVersion:()=> '1.2615.02.03-win32-x64-1793900000123',
    signHash3:async()=>({hash3:'Z'.repeat(64),timestamp:String(Date.now()),spanId:'abcdef1234567890',traceUuid:randomUUID()})};
}
function pickTool(tools,path){
  const names=new Set((tools||[]).map(t=>t.function?.name));
  if(names.has('Read'))return {name:'Read',args:{file_path:path}};
  if(names.has('read'))return {name:'read',args:{file_path:path}};
  if(names.has('exec_command'))return {name:'exec_command',args:{cmd:`Get-Content -Raw -LiteralPath '${path}'`}};
  if(names.has('shell_command'))return {name:'shell_command',args:{command:`Get-Content -Raw -LiteralPath '${path}'`}};
  return null;
}
// controlFile (optional JSON): { "rateLimitedTokens": ["mock-token-<account>"] } -> those tokens get HTTP 429.
// "lingerAfterDoneMs": n -> the stream stays open n ms after [DONE].
// "deepseekNoThinking": true -> like real DeepSeek without thinking: no reasoning_content, a short text before the
// tool call, and tool arguments with spaces (not the compact form JSON.stringify would produce).
function control(file){if(!file)return {};try{return JSON.parse(readFileSync(file,'utf8'));}catch{return {};}}
export async function startMockUpstream({controlFile}={}){
  const stats={identity:0,chat:0,byModel:{},byToken:{},rateLimited:0,toolCalls:0,finals:0,plain:0,thinkingRequests:0,reasoningReplayed:0,reasoningMissing:0,historyErrors:0,headerFailures:0,bodyFailures:0};
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    if(req.url===MOCK_IDENTITY_PATH){
      stats.identity++;res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({data:{[MOCK_IDENTITY_FIELDS.account]:'mock-user',[MOCK_IDENTITY_FIELDS.dept]:'',region:'y'}}));return;
    }
    if(req.url!=='/api/v2/chat/completions'){res.writeHead(404);res.end();return;}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{stats.bodyFailures++;res.writeHead(400);res.end('{}');return;}
    if(!req.headers.hash3||!req.headers['x-auth-token']||!req.headers['kernel-version'])stats.headerFailures++;
    const token=String(req.headers['x-auth-token']||'');
    if((control(controlFile).rateLimitedTokens||[]).includes(token)){stats.rateLimited++;res.writeHead(429,{'content-type':'application/json','retry-after':'30'});res.end('{"error":{"message":"rate limited"}}');return;}
    stats.chat++;stats.byModel[body.model]=(stats.byModel[body.model]||0)+1;stats.toolNames=[...new Set([...(stats.toolNames||[]),...(body.tools||[]).map(t=>t.function?.name).filter(Boolean)])].slice(0,200);stats.byToken[token]=(stats.byToken[token]||0)+1;
    const ctl=control(controlFile),dsNoThinking=ctl.deepseekNoThinking===true;
    const thinking=body.thinking?.type==='enabled';if(thinking)stats.thinkingRequests++;
    const msgs=body.messages||[];
    // Chat history rule real upstreams enforce: each tool message answers a call of the assistant message before it.
    {let open=new Set();for(const m of msgs){if(m.role==='assistant'){open=new Set((m.tool_calls||[]).map(c=>c.id));}
      else if(m.role==='tool'){if(!open.delete(m.tool_call_id))stats.historyErrors++;}else open=new Set();}}
    for(const m of msgs)if(m.role==='assistant'&&Array.isArray(m.tool_calls)&&m.tool_calls.length&&thinking&&!dsNoThinking){
      if(typeof m.reasoning_content==='string'&&m.reasoning_content.startsWith('mock-reasoning'))stats.reasoningReplayed++;else stats.reasoningMissing++;
    }
    const lastAssistant=msgs.findLastIndex(m=>m.role==='assistant'&&Array.isArray(m.tool_calls)&&m.tool_calls.length);
    // The file the latest instruction names decides the round: once a tool result carries that file's marker the
    // answer is final, otherwise read it. This holds for second turns and branches whatever way a client groups
    // its history (Claude Code folds tool results and the next instruction into one user message).
    let path=null;for(const m of msgs)if(m.role==='user'){const found=text(m.content).match(PATH_RE);if(found)path=found.at(-1);}
    let want=null;try{want=path?readFileSync(path,'utf8').match(/[A-Z]+_MARKER_[0-9A-Za-z]+/)?.[0]||null:null;}catch{}
    const toolAfter=want?msgs.find(m=>m.role==='tool'&&text(m.content).includes(want))||null
      :lastAssistant>=0?msgs.slice(lastAssistant+1).find(m=>m.role==='tool'):null;
    const tool=!toolAfter&&path&&Array.isArray(body.tools)?pickTool(body.tools,path):null;
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=obj=>res.write('data: '+JSON.stringify({id:'chatcmpl-mock',object:'chat.completion.chunk',model:body.model,...obj})+'\n\n');
    if(thinking&&!dsNoThinking)send({choices:[{index:0,delta:{reasoning_content:'mock-reasoning '+stats.chat}}]});
    if(toolAfter){
      stats.finals++;
      const body2=text(toolAfter.content),hit=want?[want]:body2.match(/[A-Z]+_MARKER_[0-9A-Za-z]+/);send({choices:[{index:0,delta:{content:'MOCK_FINAL: '+(hit?hit[0]:body2.slice(0,400))}}]});
      send({choices:[{index:0,delta:{},finish_reason:'stop'}]});
    }else if(tool){
      stats.toolCalls++;
      if(dsNoThinking)send({choices:[{index:0,delta:{content:'先读一下这个文件。'}}]});
      const args=dsNoThinking?JSON.stringify(tool.args,null,1).replace(/\n\s*/g,' '):JSON.stringify(tool.args);
      send({choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_'+randomUUID().slice(0,8),type:'function',function:{name:tool.name,arguments:args}}]}}]});
      send({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]});
    }else{
      stats.plain++;
      send({choices:[{index:0,delta:{content:'MOCK_OK'}}]});
      send({choices:[{index:0,delta:{},finish_reason:'stop'}]});
    }
    send({choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
    if(Number.isSafeInteger(ctl.streamDelayMs)&&ctl.streamDelayMs>0)await new Promise(r=>setTimeout(r,Math.min(ctl.streamDelayMs,10000)));
    // "lingerAfterDoneMs": n -> [DONE] is sent, the stream ends n ms later (like the real upstream). A client that
    // leaves in between must not count as a failure; chatClosedEarly counts streams the proxy let go before our end.
    const linger=Number.isSafeInteger(ctl.lingerAfterDoneMs)&&ctl.lingerAfterDoneMs>0?Math.min(ctl.lingerAfterDoneMs,10000):0;
    if(linger){
      res.write('data: [DONE]\n\n');
      await new Promise(r=>{const t=setTimeout(r,linger);res.once('close',()=>{clearTimeout(t);if(!res.writableEnded)stats.chatClosedEarly=(stats.chatClosedEarly||0)+1;r();});});
      if(!res.destroyed)res.end();return;
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {origin:`http://127.0.0.1:${server.address().port}`,stats,close:()=>new Promise(r=>{server.closeAllConnections();server.close(()=>r());})};
}
