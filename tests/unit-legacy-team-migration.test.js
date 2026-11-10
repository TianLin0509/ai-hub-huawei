'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
test('legacy background titles migrate once on boot into state and backups; explicit and manual titles keep their identity',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'team-migration-')),previous=process.env.CLAUDE_HUB_DATA_DIR;process.env.CLAUDE_HUB_DATA_DIR=dir;
 t.after(()=>{if(previous===undefined)delete process.env.CLAUDE_HUB_DATA_DIR;else process.env.CLAUDE_HUB_DATA_DIR=previous;fs.rmSync(dir,{recursive:true,force:true});});
 fs.mkdirSync(path.join(dir,'sessions'));
 const records=[{hubId:'old-0001',title:'[Team] Worker'}, {hubId:'manual-0001',title:'[Team] 用户的名字',userRenamed:true},{hubId:'explicit-0001',title:'[Team] 可见记录',hiddenFromSidebar:false},{hubId:'background-0001',title:'[Team] 已知后台任务',purpose:'company-ai'}].map(s=>({schemaVersion:1,kind:'codeagent',updatedAt:1,...s}));
 for(const s of records)fs.writeFileSync(path.join(dir,'sessions',s.hubId+'.json'),JSON.stringify(s));
 fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({version:1,sessions:records,meetings:[]}));
 const store=require('../core/session-store'),state=require('../core/state-store');
 assert.equal(store.loadSessionFile('old-0001').hiddenFromSidebar,true);
 const boot=state.loadAndSelfHeal({sessionStore:store});
 assert.equal(boot.sessions.find(s=>s.hubId==='old-0001').hiddenFromSidebar,true);
 for(const location of ['state.json','sessions/old-0001.json']){const value=JSON.parse(fs.readFileSync(path.join(dir,location)));assert.equal((value.sessions?value.sessions.find(s=>s.hubId==='old-0001'):value).hiddenFromSidebar,true);}
 for(const id of ['manual-0001','explicit-0001','background-0001'])assert.notEqual(store.loadSessionFile(id).hiddenFromSidebar,true);
 assert.notEqual(JSON.parse(fs.readFileSync(state.STATE_FILE,'utf8')).sessions.find(row=>row.hubId==='background-0001').hiddenFromSidebar,true);
 assert.equal(fs.readFileSync(path.join(dir,'sessions','background-0001.json'),'utf8'),JSON.stringify(records.find(row=>row.hubId==='background-0001')));
 const fault={schemaVersion:1,hubId:'old-fault',kind:'codeagent',title:'[Team] 写盘故障',updatedAt:1};
 fs.writeFileSync(path.join(dir,'sessions','old-fault.json'),JSON.stringify(fault));
 const save=store.saveSessionFile;store.saveSessionFile=(id,...args)=>{if(id==='old-fault')throw Object.assign(Error('migration EIO'),{code:'EIO'});return save(id,...args);};
 try{const after=state.loadAndSelfHeal({sessionStore:store});assert.equal(after.storageWriteError.code,'EIO');assert.equal(after.sessions.find(s=>s.hubId==='old-fault').hiddenFromSidebar,true);}
 finally{store.saveSessionFile=save;}
 const file=path.join(dir,'sessions','old-0001.json'),before=fs.readFileSync(file,'utf8');state.loadAndSelfHeal({sessionStore:store});assert.equal(fs.readFileSync(file,'utf8'),before,'migration must not rewrite backups every boot');
});

test('boot migration uses the production object callback and does not write another process owned backup',async t=>{
 const {spawn}=require('node:child_process'),vm=require('node:vm');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'team-owner-migration-'));const previous=process.env.CLAUDE_HUB_DATA_DIR;process.env.CLAUDE_HUB_DATA_DIR=dir;
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 const {SessionOpenOwnership}=require('../core/session-open-ownership');const owners=new SessionOpenOwnership({directory:dir}),claimant=new SessionOpenOwnership({directory:dir,pid:child.pid});const lease=claimant.claim('owned-background');
 t.after(async()=>{claimant.release(lease);claimant.close();owners.close();await new Promise(resolve=>{child.once('exit',resolve);child.kill();});if(previous===undefined)delete process.env.CLAUDE_HUB_DATA_DIR;else process.env.CLAUDE_HUB_DATA_DIR=previous;fs.rmSync(dir,{recursive:true,force:true});});
 const store=require('../core/session-store');const raw={schemaVersion:1,hubId:'owned-background',kind:'codeagent',title:'[Team] Owned',updatedAt:1};fs.mkdirSync(path.join(dir,'sessions'));const file=path.join(dir,'sessions',raw.hubId+'.json');fs.writeFileSync(file,JSON.stringify(raw));
 // Reload state-store so this fixture uses its own captured data path.
 delete require.cache[require.resolve('../core/state-store')];const state=require('../core/state-store');fs.writeFileSync(state.STATE_FILE,JSON.stringify({version:1,sessions:[raw],meetings:[]}));
 const mainFile=path.join(__dirname,'../main.js'),source=fs.readFileSync(mainFile,'utf8'),start=source.indexOf('const bootState = bootOwners.editSessions([],'),end=source.indexOf('\n}));',start)+'\n}));'.length;
 const writes=[],save=store.saveSessionFile;store.saveSessionFile=(id,...args)=>{writes.push(id);return save(id,...args);};
 try{const context={bootOwners:owners,stateStore:state,sessionStore:store,meetingStore:require('../core/meeting-store')};vm.runInNewContext(source.slice(start,end),context,{filename:mainFile});assert.ok(owners.owner(raw.hubId));assert.equal(writes.includes(raw.hubId),false);assert.equal(fs.readFileSync(file,'utf8'),JSON.stringify(raw));}
 finally{store.saveSessionFile=save;}
});
