'use strict';
const {createSessionProjectionCache,sidebarItemClassification,sidebarItemHasUnread}=require('../session-sidebar-state');
const {nativeId}=require('./live-history');
const LABELS={wait:'等你响应',error:'运行异常',run:'运行中',unread:'未读',dorm:'休眠',idle:'就绪',unknown:'状态未知'};
function sessionHubState(s,sessionMap,now,isOpen=s.isOpen,classify=null){
   if(isOpen&&s.sidebarView&&s.sidebarView.nativeSessionId===nativeId(s))return s.sidebarView.hubState;
   const state=isOpen?(classify?classify(s):sidebarItemClassification(s,{now,sessionMap})).state:'unknown';
   return {source:'Hub 侧栏共用的运行状态与未读规则',state,label:LABELS[state],
     isActive:isOpen?(state==='run'||state==='wait'):null,
     group:isOpen?(state==='run'||state==='wait'?'active':state==='error'?'failed':'inactive'):'history',
     hasUnread:isOpen?(classify?classify(s).unread:sidebarItemHasUnread(s,sessionMap)):null,
     unreadCount:isOpen?Math.max(0,Number(s.unreadCount)||0):null,
     needsUserInput:isOpen?state==='wait':null,
     scope:s.meetingId?'群聊成员自身状态；不代表整组都在运行':'单会话状态',
     meaning:isOpen?'已打开、运行中、有未读、等待输入是独立信息；未读不等于需要用户决策。':'未在本窗口打开，当前运行与未读状态未知'};
}
function projectSessionStates(sessions,{now=Date.now()}={}){
 const sessionMap=new Map(sessions.filter(s=>s.isOpen).map(s=>[s.id,s]));
 return sessions.map(s=>({...s,hubState:sessionHubState(s,sessionMap,now)}));
}
// Transfer the sidebar owner's existing projection. Only changed rows cross
// IPC; this transport neither changes runtime truth nor counts unread replies.
function createSessionViewPublisher(send){
 const previous=new Map();
 let previousIds=[];
 const cached=createSessionProjectionCache();
 const rows=new WeakMap();
 // The sidebar passes its own `now` and classification so one render classifies
 // each session once instead of twice; without them the result is unchanged.
 return (sessions,{now=Date.now(),classify=null}={})=>{
  const sessionMap=classify?null:new Map(sessions.map(s=>[s.id,s])),changed=[],updates=[];
  for(const s of sessions){
   const classification=classify?classify(s):sidebarItemClassification(s,{now,sessionMap});
   let memo=rows.get(s),entry;
   // Native IDs and these presentation fields are scalar session metadata.
   // The common path has no sidebarView override; check it directly instead
   // of looping over tracked property names for every dormant session.
   if(!s.sidebarView&&memo&&memo.classification===classification&&memo.id===s.id&&memo.kind===s.kind
     &&memo.cc===s.ccSessionId&&memo.codex===s.codexSid&&memo.gemini===s.geminiChatId&&memo.kimi===s.kimiSid&&memo.acp===s.acpSid
     &&memo.unread===s.unreadCount&&memo.meeting===s.meetingId)entry=memo.entry;
   else {
   entry=cached(s,input=>{
    const row={id:input.id,nativeSessionId:nativeId(input),hubState:{...sessionHubState(input,sessionMap,now,true,()=>classification),source:'Hub 侧栏当前状态快照'}};
    return {row,signature:JSON.stringify(row)};
   },classification);
   if(!s.sidebarView)rows.set(s,{classification,id:s.id,kind:s.kind,cc:s.ccSessionId,codex:s.codexSid,gemini:s.geminiChatId,kimi:s.kimiSid,acp:s.acpSid,
     unread:s.unreadCount,meeting:s.meetingId,entry});
   else rows.delete(s);
   }
   const {row,signature}=entry;
   if(previous.get(s.id)!==signature){changed.push(row);updates.push([s.id,signature]);}
  }
  const sameIds=sessions.length===previousIds.length&&sessions.every((s,i)=>s.id===previousIds[i]);
  const ids=sameIds?null:new Set(sessions.map(s=>s.id));
  const removed=sameIds?[]:previousIds.filter(id=>!ids.has(id));
  if(changed.length||removed.length){
   send({changed,removed});
   for(const id of removed)previous.delete(id);
   for(const [id,signature] of updates)previous.set(id,signature);
   previousIds=sessions.map(s=>s.id);
  }
 };
}
module.exports={projectSessionStates,createSessionViewPublisher};
