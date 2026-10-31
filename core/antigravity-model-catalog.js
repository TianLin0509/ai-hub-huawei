'use strict';
const {resolveCommand,cliEnv,runCli}=require('./antigravity-config');
const crypto=require('node:crypto');
// `agy models` starts a full language server and refreshes OAuth (5-15 s). The
// new-session dialog asks on open and again on submit, so share one call.
const SUCCESS_TTL_MS=10*60*1000,FAILURE_TTL_MS=60*1000;
const cached=new Map(),inflight=new Map();
const NAMESPACE_ENV=/^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|CLAUDE_HUB_HOME_DIR|AI_HUB_ANTIGRAVITY_COMMAND|AI_HUB_ANTIGRAVITY_HOME|AI_HUB_ANTIGRAVITY_PROFILE|SSH_TTY|SSH_CLIENT|SSH_CONNECTION|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_STATE_HOME|XDG_RUNTIME_DIR|(?:AGY|ANTIGRAVITY|GEMINI|GOOGLE)_.+)$/i;
function namespaceKey({profileId='default',home='',authScope='',env}){
  // Hash only authentication/storage namespace inputs, never publish them.
  // This isolates observations; it does not make changing HOME an auth switch.
  const entries=Object.entries(env).filter(([key])=>NAMESPACE_ENV.test(key))
    .map(([key,value])=>[process.platform==='win32'?key.toUpperCase():key,String(value)])
    .sort((a,b)=>a[0].localeCompare(b[0]));
  return crypto.createHash('sha256').update(JSON.stringify([profileId,home,authScope,resolveCommand(env),entries])).digest('hex');
}
function parseModels(text){
  const seen=new Set(),models=[];
  for(const line of String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split(/\r?\n/)){
    const m=/^\s*((?:gemini|claude|gpt-oss)[\w.-]+)\s+(.+?)\s*$/.exec(line);
    if(m&&!seen.has(m[1])){seen.add(m[1]);models.push({id:m[1],label:m[2]});}
  }
  return models;
}
async function fetchModelCatalog({env,runImpl}){
  if(env.CLAUDE_HUB_HOME_DIR&&!env.AI_HUB_ANTIGRAVITY_COMMAND)return {ok:false,models:[],error:'隔离 Hub 不读取真实 Antigravity 账号'};
  try{
    const r=await runImpl(resolveCommand(env),['models'],env,30000),models=parseModels(r.stdout);
    const loginRequired=/please sign in|not signed in|sign in to view|not logged in/i.test(r.stdout+'\n'+r.stderr);
    if(r.code!==0||!models.length)return {ok:false,models:[],loginRequired,error:loginRequired?'请先完成 Antigravity Google 登录':'未收到有效的 Antigravity 模型清单'};
    return {ok:true,models,source:'agy models',observedAt:Date.now()};
  }catch(error){return {ok:false,models:[],error:error.message};}
}
// account-adapters' gemini check passes its own default runner (plain execFile of
// agy.exe), which flashes a Windows Terminal window from Electron; swap that one
// for runCli. Injected test doubles pass through unchanged.
function backgroundRunner(runImpl){return !runImpl||runImpl===require('./account-adapters').run?runCli:runImpl;}
function readModelCatalog({env=process.env,runImpl=runCli,force=false,now=Date.now,
  profileId='default',home='',authScope=''}={}){
  let effectiveEnv,key;
  try {effectiveEnv=cliEnv(env);key=namespaceKey({profileId,home,authScope,env:effectiveEnv});}
  catch(error){return Promise.resolve({ok:false,models:[],error:error.message});}
  const entry=cached.get(key);
  if(!force&&entry&&now()-entry.at<(entry.value.ok?SUCCESS_TTL_MS:FAILURE_TTL_MS))return Promise.resolve(entry.value);
  if(inflight.has(key))return inflight.get(key);
  const task=fetchModelCatalog({env:effectiveEnv,runImpl:backgroundRunner(runImpl)}).then(value=>{
    if(inflight.get(key)===task)cached.set(key,{at:now(),value});return value;
  }).finally(()=>{if(inflight.get(key)===task)inflight.delete(key);});
  inflight.set(key,task);
  return task;
}
function resetModelCatalogCache(){cached.clear();inflight.clear();}
module.exports={parseModels,readModelCatalog,resetModelCatalogCache,backgroundRunner};
