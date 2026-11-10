import {lstat,realpath,open} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {createDpapiDecryptor} from './personal-token.mjs';

const ID=/^[a-z0-9]{6,16}$/;
const MAX_BYTES=256*1024,MAX_TOKEN_BYTES=16*1024;
const HEADER=Buffer.from('01000000d08c9ddf0115d1118c7a00c04fc297eb','hex');
const ownErrors=new WeakSet();
function failure(code,cleanupFailed=false){const e=Object.assign(new Error(code),{name:'PoolAccessTokenError',code,...(cleanupFailed?{cleanupFailed:true}:{})});Object.freeze(e);ownErrors.add(e);return e;}
function requireFact(ok,code){if(!ok)throw failure(code);}
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const localPath=p=>typeof p==='string'&&/^[A-Za-z]:[\\/]/.test(p)&&!p.slice(2).includes(':')&&!/[\r\n\0]/.test(p);
function cancelled(signal){if(signal?.aborted)throw failure('POOL_ACCESS_TOKEN_ABORTED');}
function cipher(value){
 if(typeof value!=='string'||value.length>MAX_BYTES)return null;
 const text=value.trim();if(!/^[A-Za-z0-9+/]+={0,2}$/.test(text))return null;
 const bytes=Buffer.from(text,'base64');
 const valid=bytes.toString('base64')===text&&bytes.length>HEADER.length&&bytes.subarray(0,HEADER.length).equals(HEADER);bytes.fill(0);
 return valid?text:null;
}
async function checkedPath(path,kind,signal){
 cancelled(signal);const absolute=resolve(path);let cursor=absolute;
 for(;;){const stat=await lstat(cursor);requireFact(!stat.isSymbolicLink(),'POOL_PATH_UNSAFE');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
 const canonical=await realpath(absolute);requireFact(canonical.toLowerCase()===absolute.toLowerCase(),'POOL_PATH_UNSAFE');
 const stat=await lstat(absolute);requireFact(kind==='directory'?stat.isDirectory():stat.isFile()&&stat.nlink===1,'POOL_PATH_UNSAFE');
 cancelled(signal);return {absolute,stat};
}
async function readJson(path,signal,kind){
 const {absolute,stat}=await checkedPath(path,'file',signal);
 requireFact(stat.size<=MAX_BYTES,'POOL_'+kind+'_TOO_LARGE');
 let handle,parsed;const buffer=Buffer.alloc(MAX_BYTES+1);
 try{
  handle=await open(absolute,'r');const before=await handle.stat();
  requireFact(before.isFile()&&before.nlink===1&&before.dev===stat.dev&&before.ino===stat.ino,'POOL_PATH_UNSAFE');
  requireFact(before.size<=MAX_BYTES,'POOL_'+kind+'_TOO_LARGE');
  let length=0;
  while(length<buffer.length){cancelled(signal);const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);if(!bytesRead)break;length+=bytesRead;}
  requireFact(length<=MAX_BYTES,'POOL_'+kind+'_TOO_LARGE');
  const after=await handle.stat();const current=await checkedPath(absolute,'file',signal);
  requireFact(before.size===after.size&&before.mtimeMs===after.mtimeMs&&after.dev===current.stat.dev&&after.ino===current.stat.ino&&after.size===current.stat.size&&after.mtimeMs===current.stat.mtimeMs,'POOL_FILE_CHANGED');
  try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)).replace(/^\uFEFF/,''));}
  catch{throw failure('POOL_'+kind+'_FORMAT_INVALID');}
 }finally{
  buffer.fill(0);
  if(handle)try{await handle.close();}catch{throw failure('POOL_FILE_CLOSE_FAILED',true);}
 }
 return parsed;
}
function descriptor(error,key){try{return Object.getOwnPropertyDescriptor(error,key)?.value;}catch{return undefined;}}
const defaultDecrypt=createDpapiDecryptor();
export function createPoolAccessTokenReader(config={}){
 try{
 const {decryptAccessToken=defaultDecrypt}=config;
 requireFact(typeof decryptAccessToken==='function','POOL_CONFIGURATION_INVALID');
 return async function readPoolAccessToken(options={}){
  try{
   const {poolRoot,accountId,minValidityMs=120000,timeoutMs=10000,signal,nowMs=Date.now()}=options;
   const began=performance.now();
   requireFact(localPath(poolRoot),'POOL_ROOT_INVALID');requireFact(typeof accountId==='string'&&ID.test(accountId),'POOL_ACCOUNT_ID_INVALID');
   requireFact(Number.isSafeInteger(minValidityMs)&&minValidityMs>=0&&Number.isSafeInteger(nowMs)&&nowMs>0,'POOL_EXPIRY_POLICY_INVALID');
   requireFact(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000,'POOL_TIMEOUT_INVALID');cancelled(signal);
   const root=(await checkedPath(poolRoot,'directory',signal)).absolute;
   let registry=await readJson(join(root,'pool.json'),signal,'REGISTRY');
   requireFact(object(registry)&&Array.isArray(registry.accounts)&&registry.accounts.every(a=>object(a)&&typeof a.id==='string'&&ID.test(a.id)),'POOL_REGISTRY_FORMAT_INVALID');
   const matches=registry.accounts.filter(a=>a.id===accountId).length;registry=undefined;
   requireFact(matches===1,matches===0?'POOL_ACCOUNT_NOT_REGISTERED':'POOL_ACCOUNT_REGISTRY_AMBIGUOUS');
   // No account enumeration or alternate OAuth fallback. Whole JSON bytes can include mtoken;
   // only the two confirmed IDaaS fields below are accessed, and mtoken is never used/decrypted.
   let credential=await readJson(join(root,'accounts',accountId,'.credentials.json'),signal,'CREDENTIAL');
   // Account-password login (idaasOAuth) or browser login (devUCOAuth, accessToken / expiresAt in ms); token and expiry only.
   const idaas=object(credential?.idaasOAuth)&&credential.idaasOAuth.xAuthToken?credential.idaasOAuth:null;
   const devuc=!idaas&&object(credential?.devUCOAuth)?credential.devUCOAuth:null;
   requireFact(idaas||devuc,'POOL_AUTH_TYPE_UNSUPPORTED');
   const expiry=idaas?idaas.xAuthExpires:devuc.expiresAt,encrypted=idaas?idaas.xAuthToken:devuc.accessToken;credential=undefined;
   requireFact(Number.isSafeInteger(expiry)&&expiry>0,'POOL_EXPIRY_INVALID');
   const validExpiry=()=>requireFact(expiry-(nowMs+performance.now()-began)>minValidityMs,'POOL_ACCESS_TOKEN_EXPIRED_OR_NEAR_EXPIRY');
   validExpiry();const ciphertext=cipher(encrypted);requireFact(ciphertext!==null,'POOL_ACCESS_TOKEN_CIPHERTEXT_INVALID');cancelled(signal);
   let token;
   // The shared decryptor owns timeout/abort and reports cleanup failures; do not
   // race it with a second timer which would hide its final cleanup result.
   try{token=await decryptAccessToken(ciphertext,{signal,timeoutMs});}
   catch(error){
    const code=descriptor(error,'code'),cleanup=descriptor(error,'cleanupFailed')===true;
    throw failure(signal?.aborted||code==='ACCESS_TOKEN_ABORTED'?'POOL_ACCESS_TOKEN_ABORTED':code==='ACCESS_TOKEN_DECRYPT_TIMEOUT'?'POOL_ACCESS_TOKEN_DECRYPT_TIMEOUT':'POOL_ACCESS_TOKEN_DECRYPT_FAILED',cleanup);
   }
   cancelled(signal);validExpiry();
   requireFact(typeof token==='string'&&token.length>0&&Buffer.byteLength(token)<=MAX_TOKEN_BYTES&&/^[\x21-\x7e\x80-\xff]+$/.test(token),'POOL_ACCESS_TOKEN_DECRYPT_FAILED');
   return token; // Internal provider handoff only. Never log, serialize, persist, or return it to a user.
  }catch(error){if(ownErrors.has(error))throw error;throw failure('POOL_ACCESS_TOKEN_READ_FAILED');}
 };
 }catch(error){if(ownErrors.has(error))throw error;throw failure('POOL_CONFIGURATION_INVALID');}
}
export const readPoolAccessToken=createPoolAccessTokenReader();
