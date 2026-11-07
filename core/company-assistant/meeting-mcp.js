'use strict';
const fs=require('node:fs'),readline=require('node:readline');
const number={type:'number',minimum:0},schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const tools=[
 {name:'meeting_index',description:'本场会议材料与录制覆盖索引，含保存范围和缺口；nextOffset非空可分页，不含视频。',inputSchema:schema({offset:{type:'integer',minimum:0}})},
 {name:'meeting_read',description:'按会议相对时间读取转写、重点和截图索引，每次最多15分钟；nextOffset非空可继续取。',inputSchema:schema({startMs:number,endMs:number,offset:{type:'integer',minimum:0}})},
 {name:'meeting_slides',description:'按事件序号读取本场已保存的截图，每次1至4张；序号来自meeting_read或meeting_index。',inputSchema:schema({seqs:{type:'array',items:{type:'integer',minimum:1},minItems:1,maxItems:4}},['seqs'])}
].map(t=>({...t,annotations:{readOnlyHint:true}}));
async function handle(r){
 if(r.method==='initialize')return {protocolVersion:r.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'meeting',version:'4.1.0'}};
 if(r.method==='ping')return {};
 if(r.method==='tools/list')return {tools};
 if(r.method!=='tools/call'||!tools.some(t=>t.name===r.params?.name))throw new Error('未知会议工具');
 try{
  const endpoint=JSON.parse(fs.readFileSync(process.env.HUB_MEETING_ENDPOINT,'utf8'));
  const response=await fetch(endpoint.url,{method:'POST',headers:{Authorization:'Bearer '+endpoint.token,'Content-Type':'application/json'},body:JSON.stringify({name:r.params.name,arguments:r.params.arguments||{}}),signal:AbortSignal.timeout(120000)});
  const data=await response.json();if(!data.ok)throw new Error(data.error);return data.result;
 }catch(e){return {isError:true,content:[{type:'text',text:'会议回查未完成：'+e.message}]};}
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',async line=>{let r;try{r=JSON.parse(line);if(r.id==null)return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:await handle(r)})+'\n');}catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r?.id??null,error:{code:-32000,message:e.message}})+'\n');}});
