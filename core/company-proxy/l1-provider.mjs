import { randomUUID } from 'node:crypto';

const TOP_FIELDS = new Set(['model','messages','stream','stream_options','tools','temperature','max_tokens','stop']);
const NATIVE_THINKING_MODELS = new Set(['GLM-5.2-WX','deepseek-v4.1-flash-1017']);
const HEADER_TEXT = /^[\x20-\x7e\x80-\xff]+$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const own = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const headerText = value => typeof value === 'string' && value.length > 0 && value.length <= 16384 && value.trim()===value && HEADER_TEXT.test(value);
const publicErrors=new WeakSet();
function error(code,status=502) { const result=new Error(code);result.name='PersonalL1ProviderError';result.code=code;result.status=status;Object.freeze(result);publicErrors.add(result);return result; }
function check(condition,code='L1_CONFIGURATION_INVALID',status=500) { if (!condition) throw error(code,status); }
function fields(value,allowed,code) { check(object(value)&&Object.keys(value).every(key=>allowed.includes(key)),code,422); }
function discardResponse(value,notify) {
  try { Promise.resolve(value?.body?.cancel()).catch(()=>notify('L1_RESPONSE_CLEANUP_FAILED')); }
  catch { notify('L1_RESPONSE_CLEANUP_FAILED'); }
}
function stage(operation,signal,code,onLate) {
  if (signal?.aborted) return Promise.reject(error('L1_ABORTED',499));
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(ok,value)=>{if(settled){if(ok)onLate?.(value);return;}settled=true;signal?.removeEventListener('abort',abort);ok?resolve(value):reject(error(code));};
    const abort=()=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);reject(error('L1_ABORTED',499));};
    signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{if(signal?.aborted){abort();return;}return operation();}).then(value=>finish(true,value),()=>finish(false));
  });
}

function requestBody(body,modelMap,experimentalNativeThinking,experimentalCodexControls) {
  check(object(body),'L1_REQUEST_INVALID',422);
  check(Object.keys(body).every(key=>TOP_FIELDS.has(key)||(experimentalNativeThinking&&(key==='thinking'||key==='reasoning_effort'))||(experimentalCodexControls&&(key==='tool_choice'||key==='parallel_tool_calls'))),'L1_REQUEST_FIELD_UNVERIFIED',422);
  check(typeof body.model==='string'&&modelMap.has(body.model),'L1_MODEL_NOT_ALLOWED',422);
  if(experimentalCodexControls){
    check(NATIVE_THINKING_MODELS.has(body.model)&&modelMap.get(body.model)===body.model,'L1_CODEX_MODEL_UNVERIFIED',422);
    check(body.tool_choice==='auto'&&body.parallel_tool_calls===true,'L1_CODEX_CONTROLS_INVALID',422);
    check(own(body,'thinking')&&own(body,'reasoning_effort'),'L1_THINKING_PAIR_REQUIRED',422);
  }
  if(own(body,'thinking')||own(body,'reasoning_effort')){
    // Explicit experiment against the native vendor contract; company forwarding is not yet verified.
    check(experimentalNativeThinking&&NATIVE_THINKING_MODELS.has(body.model)&&modelMap.get(body.model)===body.model,'L1_THINKING_MODEL_UNVERIFIED',422);
    check(own(body,'thinking')&&own(body,'reasoning_effort'),'L1_THINKING_PAIR_REQUIRED',422);
    fields(body.thinking,['type'],'L1_THINKING_INVALID');
    check(own(body.thinking,'type')&&body.thinking.type==='enabled'&&body.reasoning_effort==='high','L1_THINKING_INVALID',422);
  }
  check(body.stream===true,'L1_STREAM_REQUIRED',422);
  check(Array.isArray(body.messages)&&body.messages.length>0,'L1_MESSAGES_INVALID',422);
  for(const message of body.messages){
    fields(message,['role','content','tool_calls','tool_call_id','name','reasoning_content'],'L1_MESSAGE_FIELD_UNVERIFIED');
    check(['system','user','assistant','tool'].includes(message.role),'L1_MESSAGE_ROLE_UNVERIFIED',422);
    check(typeof message.content==='string'||(message.role==='assistant'&&message.content==null&&Array.isArray(message.tool_calls)), 'L1_MESSAGE_CONTENT_UNVERIFIED',422);
    // Q2 r7: historical assistant reasoning is a plain string alongside tool_calls.
    if(own(message,'reasoning_content'))check(message.role==='assistant'&&typeof message.reasoning_content==='string','L1_REASONING_REPLAY_INVALID',422);
    if(own(message,'name'))check(typeof message.name==='string','L1_MESSAGE_INVALID',422);
    if(own(message,'tool_call_id'))check(typeof message.tool_call_id==='string'&&message.tool_call_id.length>0,'L1_MESSAGE_INVALID',422);
    if(own(message,'tool_calls')){
      check(message.role==='assistant'&&Array.isArray(message.tool_calls),'L1_TOOL_CALL_INVALID',422);
      for(const call of message.tool_calls){
        fields(call,['id','type','function'],'L1_TOOL_CALL_FIELD_UNVERIFIED');
        fields(call.function,['name','arguments'],'L1_TOOL_CALL_FIELD_UNVERIFIED');
        check(call.type==='function'&&typeof call.id==='string'&&call.id.length>0&&typeof call.function.name==='string'&&typeof call.function.arguments==='string','L1_TOOL_CALL_INVALID',422);
      }
    }
  }
  if(own(body,'stream_options')){
    fields(body.stream_options,['include_usage'],'L1_STREAM_OPTIONS_UNVERIFIED');
    check(body.stream_options.include_usage===true,'L1_INCLUDE_USAGE_REQUIRED',422);
  }
  if(own(body,'tools')){
    check(Array.isArray(body.tools),'L1_TOOLS_INVALID',422);
    for(const tool of body.tools){
      fields(tool,['type','function'],'L1_TOOL_FIELD_UNVERIFIED');
      fields(tool.function,experimentalCodexControls?['name','description','parameters','strict']:['name','description','parameters'],'L1_TOOL_FIELD_UNVERIFIED');
      if(own(tool.function,'strict'))check(tool.function.strict===false,'L1_CODEX_STRICT_INVALID',422);
      check(tool.type==='function'&&typeof tool.function.name==='string'&&tool.function.name.length>0&&object(tool.function.parameters),'L1_TOOLS_INVALID',422);
      if(own(tool.function,'description'))check(typeof tool.function.description==='string','L1_TOOLS_INVALID',422);
    }
  }
  if(own(body,'temperature'))check(Number.isFinite(body.temperature),'L1_TEMPERATURE_INVALID',422);
  if(own(body,'max_tokens'))check(Number.isSafeInteger(body.max_tokens)&&body.max_tokens>0,'L1_MAX_TOKENS_INVALID',422);
  if(own(body,'stop'))check(typeof body.stop==='string'||(Array.isArray(body.stop)&&body.stop.every(x=>typeof x==='string')),'L1_STOP_INVALID',422);
  let serialized;
  try { serialized=JSON.stringify({...body,model:modelMap.get(body.model),stream_options:{include_usage:true}}); }
  catch { throw error('L1_REQUEST_INVALID',422); }
  return {serialized,wireModel:modelMap.get(body.model)};
}

/** No defaults for identity, signing metadata, model mapping, endpoint, client id or credential source.
 * The endpoint and client id come from the local upstream profile (CodeAgent package or user config). */
function buildPersonalL1Provider({readAccessToken,getIdentity,signer,modelMap,endpoint,appId,sessionId:fixedSessionId,fetchImpl=globalThis.fetch,testOnlyAllowLoopback=false,experimentalNativeThinking=false,experimentalCodexControls=false,onDiagnostic=event=>process.stderr.write(event.code+'\n')}={}) {
  check(typeof readAccessToken==='function'&&typeof getIdentity==='function'&&typeof fetchImpl==='function');
  check(typeof experimentalNativeThinking==='boolean');
  check(typeof experimentalCodexControls==='boolean'&&(!experimentalCodexControls||experimentalNativeThinking));
  check(typeof onDiagnostic==='function');
  const observerFailed=()=>process.stderr.write('L1_DIAGNOSTIC_OBSERVER_FAILED\n');
  const notify=code=>{
    try { Promise.resolve(onDiagnostic(Object.freeze({code}))).catch(observerFailed); }
    catch { observerFailed(); }
  };
  check(object(signer)&&typeof signer.signHash3==='function');
  // Caller captures these exact strings after safe initialization, including the DLL creation kernel version.
  const codeagentVersion=signer.codeagentVersion,kernelVersion=signer.kernelVersion;
  check(headerText(codeagentVersion)&&/^[0-9]+(?:\.[0-9]+)+$/.test(codeagentVersion));
  const kernelBase=`${codeagentVersion}-win32-x64`;
  check(headerText(kernelVersion)&&(kernelVersion===kernelBase||(kernelVersion.startsWith(kernelBase+'-')&&kernelVersion.length>kernelBase.length+1)));
  const signHash3=signer.signHash3.bind(signer);
  check(headerText(appId)&&appId.length<=200,'L1_APP_ID_REQUIRED');
  check(typeof endpoint==='string');
  let url;try{url=new URL(endpoint);}catch{throw error('L1_ENDPOINT_UNVERIFIED',500);}
  const production=url.protocol==='https:'&&url.pathname==='/api/v2/chat/completions';
  const loopback=testOnlyAllowLoopback===true&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)&&url.pathname==='/api/v2/chat/completions';
  check((production||loopback)&&!url.username&&!url.password&&!url.search&&!url.hash,'L1_ENDPOINT_UNVERIFIED');
  check(object(modelMap)&&Object.keys(modelMap).length>0,'L1_MODEL_MAPPING_REQUIRED');
  const models=new Map(Object.entries(modelMap));
  for(const [client,wire] of models)check(MODEL_ID.test(client)&&typeof wire==='string'&&MODEL_ID.test(wire),'L1_MODEL_MAPPING_INVALID');
  check(fixedSessionId===undefined||(typeof fixedSessionId==='string'&&UUID.test(fixedSessionId)));
  const sessionId=fixedSessionId||randomUUID();
  return Object.freeze({
    async listModels({signal}={}) {if(signal?.aborted)throw error('L1_ABORTED',499);return [...models.keys()];},
    async complete(body,{signal}={}) {
      try {
      if(signal?.aborted)throw error('L1_ABORTED',499);
      // Reject unknown capabilities before touching credentials or signing.
      const {serialized,wireModel}=requestBody(body,models,experimentalNativeThinking,experimentalCodexControls);
      const token=await stage(()=>readAccessToken({signal}),signal,'L1_ACCESS_TOKEN_FAILED');
      check(headerText(token)&&!/[\x00-\x20\x7f]/.test(token),'L1_ACCESS_TOKEN_INVALID');
      const identity=await stage(()=>getIdentity(token,{signal}),signal,'L1_IDENTITY_FAILED');
      check(object(identity)&&headerText(identity.account)&&(identity.deptPath===''||headerText(identity.deptPath)),'L1_IDENTITY_UNVERIFIED');
      const signature=await stage(()=>signHash3(token,wireModel),signal,'L1_SIGNATURE_FAILED');
      check(object(signature)&&headerText(signature.hash3)&&signature.hash3.length===64
        &&typeof signature.timestamp==='string'&&/^\d+$/.test(signature.timestamp)
        &&typeof signature.spanId==='string'&&/^[0-9a-f]{16}$/i.test(signature.spanId)
        &&typeof signature.traceUuid==='string'&&UUID.test(signature.traceUuid),'L1_SIGNATURE_INVALID');
      let headers;
      try {headers=new Headers({
        'content-type':'application/json','accept':'text/event-stream','x-auth-token':token,
        timestamp:signature.timestamp,'x-snap-span-id':signature.spanId,'X-snap-traceid':signature.traceUuid,hash3:signature.hash3,
        'kernel-version':kernelVersion,'app-id':appId,
        'plugin-version':`cli-${codeagentVersion}`,'x-agent-client-version':codeagentVersion,
        'x-agent-user-account':identity.account,'x-agent-user-department':identity.deptPath,depart:identity.deptPath,
        'x-codeagent-request-kind':'main_conversation','is-need-queue':'true','x-error-propagation':'true','x-session-id':sessionId,
      });}catch{throw error('L1_HEADERS_INVALID');}
      const response=await stage(()=>fetchImpl(url.href,{method:'POST',headers,body:serialized,signal,redirect:'error'}),signal,'L1_REQUEST_FAILED',value=>discardResponse(value,notify));
      if(signal?.aborted){discardResponse(response,notify);throw error('L1_ABORTED',499);}
      check(response instanceof Response,'L1_RESPONSE_INVALID');
      return response; // Preserve status, Retry-After, model identity and SSE exactly; no retry/refresh/fallback.
      } catch(caught) {
        if(publicErrors.has(caught))throw caught;
        throw error('L1_PROVIDER_FAILED');
      }
    },
  });
}

export function createPersonalL1Provider(config){
  try{return buildPersonalL1Provider(config);}
  catch(caught){if(publicErrors.has(caught))throw caught;throw error('L1_CONFIGURATION_INVALID',500);}
}
