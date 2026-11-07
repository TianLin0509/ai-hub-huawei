'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const start = renderer.indexOf("ipcRenderer.on('session-created', async (_e, { session }) => {");
const end = renderer.indexOf('  const activatedSession = sessions.get(session.id);', start);
assert(start >= 0 && end > start);
const registration = renderer.slice(start, end) + ' activated = true; });';

async function route({ existing, session, pending = false, active = 'current' }) {
  let handler;
  const sessions = new Map(existing ? [[session.id, existing]] : []);
  const ctx = { sessions, activeSessionId:active, activated:false,
    require:id=>require(path.join(__dirname,'../renderer',id)),
    ipcRenderer:{ on:(_name,fn)=>{handler=fn;} }, nativeSessionBootstrap:{record(){}},
    codexAccountUi:{resumeCodexAccountRestart:()=>false},
    _pendingDormantResumes:new Map(pending ? [[session.id,{forceScrollBottom:true}]] : []),
    paintSidebarResumePending(){}, observeSessionRuntime(){}, RUNTIME_IDLE:'idle',CONFIDENCE_AUTHORITATIVE:'authoritative',
    scheduleSessionListRender(){},schedulePersist(){},sessionSplit:null,
    assistantPanel:{isOpen:()=>false}, Date };
  vm.runInNewContext(registration, ctx);
  await handler(null, { session });
  return { ...ctx, saved:sessions.get(session.id) };
}
test('background creation and recovery preserve current view and unread metadata',async()=>{
  assert.equal((await route({session:{id:'other',openInBackground:true}})).activated,false);
  for(const status of ['dormant','idle']){
    const r=await route({existing:{id:'other',kind:'codeagent',status,unreadCount:4,pinned:true,lastOutputPreview:'keep'},session:{id:'other',kind:'codeagent',unreadCount:0}});
    assert.equal(r.activated,false); assert.equal(r.saved.unreadCount,4);assert.equal(r.saved.pinned,true);assert.equal(r.saved.lastOutputPreview,'keep');
  }
});
test('explicit pending resume and currently selected session still activate',async()=>{
  assert.equal((await route({session:{id:'new'}})).activated,true);
  const existing={id:'other',kind:'codeagent',status:'dormant',unreadCount:4,currentModel:{id:'GLM-5.2',displayName:'GLM-5.2'}};
  const r=await route({existing,session:{id:'other',kind:'codeagent',currentModel:'',openInBackground:true},pending:true,active:'other'});
  assert.equal(r.activated,true);assert.equal(r._pendingDormantResumes.size,0);assert.equal(r.saved.currentModel.id,'GLM-5.2');
  assert.equal((await route({existing,session:{id:'other',openInBackground:true},active:'other'})).activated,true);
});
test('session manager includes the background creation hint in live metadata',()=>{
  assert.match(fs.readFileSync(path.join(__dirname,'../core/session-manager.js'),'utf8'),/opts\.openInBackground \? \{ openInBackground: true \}/);
});
