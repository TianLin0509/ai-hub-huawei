'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
function element(tag = 'span') {
  const listeners = new Map();
  return { tagName: tag.toUpperCase(), textContent: '', value: '', style: {}, classList: { add() {}, remove() {} },
    addEventListener(name, fn) { listeners.set(name, fn); }, setAttribute() {}, focus() {}, select() {},
    replaceWith(next) { const p = this.parent; if (p) { p.current = next; next.parent = p; this.parent = null; } },
    async fire(name, event = {}) { return listeners.get(name)?.({ preventDefault() {}, ...event }); },
    blur() { return this.fire('blur'); },
  };
}
test('inline editor remains bound for a second rename; Escape and IME Enter do not save', async () => {
  const { bindInlineNameEditor } = require('../renderer/name-editor');
  const title = element(), host = { current: title }; title.parent = host; let name = '原名';
  bindInlineNameEditor({ element: title, document: { createElement: element }, getName: () => name, save: async value => { name = value; } });
  await title.fire('click'); host.current.value = '第一次'; await host.current.fire('keydown', { key: 'Enter', isComposing: true }); assert.equal(name, '原名');
  await host.current.fire('keydown', { key: 'Enter' }); assert.equal(name, '第一次'); assert.equal(host.current, title); assert.equal(title.textContent, '第一次');
  await title.fire('click'); host.current.value = '第二次'; await host.current.fire('blur'); assert.equal(name, '第二次'); assert.equal(host.current, title);
  await title.fire('click'); host.current.value = '放弃'; await host.current.fire('keydown', { key: 'Escape' }); assert.equal(name, '第二次');
});
test('inline save retry is not mistaken for unchanged input after its first persistence failure', async () => {
  const { bindInlineNameEditor } = require('../renderer/name-editor');
  const title = element(), host = { current: title }; title.parent = host; let name = '原名', saves = 0;
  bindInlineNameEditor({ element: title, document: { createElement: element }, getName: () => name, save: async value => { name = value; if (++saves === 1) throw new Error('temporary disk failure'); } });
  await title.fire('click'); host.current.value = '新名'; await host.current.fire('keydown', { key: 'Enter' });
  assert.notEqual(host.current, title);
  await host.current.fire('keydown', { key: 'Enter' });
  assert.equal(saves, 2); assert.equal(host.current, title);
});
test('renderer changes live, dormant, group and lead names only after the main transaction acknowledges', async () => {
  const { createSessionRenamer } = require('../renderer/session-renaming');
  for (const kind of ['live', 'dormant', 'meeting', 'lead']) {
    const target = { id: kind, title: '原名', kind: 'codeagent', status: kind }, calls = []; let release;
    const renamer = createSessionRenamer({ getSession: () => kind === 'meeting' ? null : target, getMeeting: () => kind === 'meeting' ? target : null,
      ipcRenderer: { invoke: (channel, args) => { calls.push([channel,args]); return new Promise(resolve => { release = resolve; }); } }, render() {} });
    const pending = renamer.rename(kind, '新名');
    assert.equal(target.title, '原名');
    release({ ok: true, record: { title: '新名', titleRevision: 2, userRenamed: true } }); await pending;
    assert.equal(target.title, '新名'); assert.equal(target.titleRevision, 2);
    assert.deepEqual(calls, [['session:rename-title', { type: kind === 'meeting' ? 'meeting' : 'session', id: kind, title: '新名' }]]);
  }
});
test('failed saves leave no name overlay: external names and identical retries remain usable', async () => {
  const { createSessionRenamer } = require('../renderer/session-renaming');
  const target = { id: 'target', title: '原名' }; let calls = 0;
  const renamer = createSessionRenamer({ getSession: () => target, getMeeting: () => null, render() {}, ipcRenderer: { invoke: async () => {
    if (++calls === 1) throw new Error('EIO'); return { ok: true, record: { title: '新名', titleRevision: 2, userRenamed: true } };
  } } });
  await assert.rejects(renamer.rename('target', '新名'), /EIO/); assert.equal(target.title, '原名');
  target.title = '其他窗口的新名'; assert.equal(target.title, '其他窗口的新名');
  await renamer.rename('target', '新名'); assert.equal(calls, 2); assert.equal(target.title, '新名');
});
test('older completed requests cannot overwrite a newer main revision', async () => {
 const target = { id: 'a', title: '最新', titleRevision: 5 };
 const renamer = require('../renderer/session-renaming').createSessionRenamer({ getSession: () => target, getMeeting: () => null, render() {}, ipcRenderer: { invoke: async () => ({ ok:true,record:{title:'较旧',titleRevision:4} }) } });
 await renamer.rename('a','较旧'); assert.equal(target.title,'最新');
});
test('inline Escape closes a queued save and reports its eventual completion without restoring detached input', async () => {
 const title=element(), host={current:title}; title.parent=host; let release,name='原名'; const notices=[];
 require('../renderer/name-editor').bindInlineNameEditor({element:title,document:{createElement:element},getName:()=>name,notify:message=>notices.push(message),save:async value=>{await new Promise(resolve=>release=resolve);name=value;}});
 await title.fire('click'); const input=host.current;input.value='新名'; const saving=input.fire('keydown',{key:'Enter'});
 assert.notEqual(input.disabled,true); await input.fire('keydown',{key:'Escape'});assert.equal(host.current,title);
 release();await saving;assert.equal(host.current,title);assert.equal(notices.length,1);assert.match(notices[0],/已保存/);
});

test('real native and group broadcasts after a rejected save can apply external and automatic names', async () => {
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
 const filename=path.join(__dirname,'../renderer/renderer.js'),source=fs.readFileSync(filename,'utf8');
 for(const kind of ['meeting','native']){
  const target={id:'target',title:'原名',userRenamed:false,runtimeBackend:'claude-stream-json',nativeRuntime:{epoch:1,revision:1}};
  const sessions=new Map([[target.id,target]]),meetings={target};const listeners=new Map();
  const renamer=require('../renderer/session-renaming').createSessionRenamer({getSession:()=>kind==='native'?target:null,getMeeting:()=>kind==='meeting'?meetings.target:null,render(){},persist:async()=>{throw Error('EIO');},ipcRenderer:{invoke:async channel=>{if(channel==='session:rename-title')throw Error('EIO');return kind==='meeting'?true:{id:target.id};}}});
  const context={require:createRequire(filename),ipcRenderer:{on:(name,fn)=>listeners.set(name,fn)},sessions,meetings,activeMeetingId:null,sessionRenamer:renamer,
   queueMicrotask:fn=>fn(),turnCardRenderer:{refreshCardActions(){}},nativeSessionBootstrap:{record(){}},
   window:{dispatchEvent(){}},CustomEvent:function(){},_updateStreamingIndicator(){},scheduleSessionListRender(){},scheduleFloatingBarState(){},meetingUnread:{preserveMeetingAttention(){}},MeetingRoom:{updateMeetingData(){}}};
  const event=kind==='meeting'?'meeting-updated':'session-updated',start=source.indexOf("ipcRenderer.on('"+event+"',"),end=source.indexOf(kind==='meeting'?"ipcRenderer.on('groupchat-turn-targets',":'// --- Session persistence',start);
  vm.runInNewContext(source.slice(start,end),context,{filename});await assert.rejects(renamer.rename('target','本地失败名'),/EIO/);
  for(const [title,userRenamed] of [['其他窗口新名',true],['自动起名主题',false]]){
   const record={...target,title,userRenamed,autoTitleGenerated:!userRenamed,nativeRuntime:{epoch:1,revision:++target.nativeRuntime.revision}};
   listeners.get(event)(null,kind==='meeting'?{meeting:record}:{session:record});
   assert.equal(kind==='meeting'?meetings.target.title:target.title,title);
  }
 }
});

function dialogDocument(){
 const make=tag=>{const listeners=new Map(),node={tagName:tag.toUpperCase(),children:[],value:'',disabled:false,appendChild(child){this.children.push(child);child.parent=this;return child;},remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);},addEventListener:(name,fn)=>listeners.set(name,fn),setAttribute(){},focus(){doc.activeElement=this;},select(){},fire(name,event={}){return listeners.get(name)?.({preventDefault(){},stopPropagation(){},...event});}};return node;};
 const doc={createElement:make,activeElement:null};doc.body=make('body');return doc;
}
test('queued modal saves remain cancellable by button and Escape and report the late outcome',async()=>{
 for(const [action,failed] of [['cancel',false],['escape',true]]){
  const document=dialogDocument(),notices=[];let release;
  const result=require('../renderer/name-editor').openNameEditor({document,value:'原名',notify:m=>notices.push(m),save:()=>new Promise((resolve,reject)=>{release=()=>failed?reject(Error('EIO')):resolve();})});
  const overlay=document.body.children[0],form=overlay.children[0],input=form.children[0].children[0],cancel=form.children[2].children[0];
  input.value='新名';const pending=form.fire('submit');assert.equal(cancel.disabled,false);assert.notEqual(input.disabled,true);
  if(action==='cancel')cancel.fire('click');else overlay.fire('keydown',{key:'Escape'});
  assert.equal(document.body.children.length,0);assert.equal(await result,false);release();await pending;assert.equal(notices.length,1);assert.match(notices[0],failed?/失败.*EIO/:/已保存/);
 }
});

test('invalid, cancelled and read-only edits never reach main; explicit identical submissions can retry',async()=>{
 const target={id:'id',title:'原名'},calls=[];
 const renamer=require('../renderer/session-renaming').createSessionRenamer({getSession:()=>target,getMeeting:()=>null,render(){},ipcRenderer:{invoke:async(channel,args)=>{calls.push(args);return{ok:true,record:{title:args.title,titleRevision:1,userRenamed:true}};}}});
 assert.equal(await renamer.rename('id',null),false);
 for(const name of ['', '  ', 'bad\nname','长'.repeat(121)])await assert.rejects(renamer.rename('id',name),/名称/);
 target.readOnly=true;await assert.rejects(renamer.rename('id','新名'),/只读/);assert.equal(calls.length,0);
 target.readOnly=false;await renamer.rename('id','原名');assert.equal(calls.length,1);assert.equal(target.title,'原名');
});

test('a cancelled inline save completing later cannot close or disable a newly opened editor', async () => {
 const title=element(),host={current:title};title.parent=host;let name='原名';const releases=new Map();
 require('../renderer/name-editor').bindInlineNameEditor({element:title,document:{createElement:element},getName:()=>name,save:async value=>{await new Promise(resolve=>releases.set(value,resolve));name=value;}});
 await title.fire('click');let input=host.current;input.value='第一次';const first=input.fire('keydown',{key:'Enter'});await input.fire('keydown',{key:'Escape'});
 await title.fire('click');const secondInput=host.current;secondInput.value='第二次';releases.get('第一次')();await first;
 assert.equal(host.current,secondInput,'late completion must leave the newer editor mounted');
 const second=secondInput.fire('keydown',{key:'Enter'});assert.ok(releases.has('第二次'),'new editor must still save');releases.get('第二次')();await second;
 assert.equal(host.current,title);assert.equal(name,'第二次');
});
