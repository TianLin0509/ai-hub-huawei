'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSessionListRenderer, getSidebarSearchEntries } = require('../renderer/session-list-renderer');
function el(tagName = 'div') {
  const listeners = new Map();
  const node = { tagName: tagName.toUpperCase(), children: [], dataset: {}, style: { setProperty() {} }, className: '', attributes: [],
    classList: { add() {}, remove() {}, toggle() {} }, setAttribute(key, value) { this[key] = String(value); },
    scrollIntoView() { this.scrolled = true; }, querySelectorAll(selector) { const all = []; const visit = node => { for (const child of node.children) { if (child.className.split(' ').includes(selector.slice(1))) all.push(child); visit(child); } }; visit(this); return all; },
    addEventListener(key, fn) { listeners.set(key, fn); }, emit: (key, event) => listeners.get(key)?.(event),
    appendChild(child) { node.children.push(child); return child; },
    get innerHTML() { return this.html || ''; }, set innerHTML(value) { this.html = value; this.children = []; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 30 }),
  }; node.classList = { add(name) { if (!node.className.split(' ').includes(name)) node.className += ' ' + name; }, remove(name) { node.className = node.className.split(' ').filter(c => c !== name).join(' '); }, toggle() {} }; return node;
}
function find(node, predicate) { if (predicate(node)) return node; for (const child of node.children) { const hit = find(child, predicate); if (hit) return hit; } return null; }
function html(node) { return [node.innerHTML, node.textContent || '', ...node.children.map(html)].join('\n'); }
function row(root, id) { return find(root, node => (node.dataset.sessionId || node.dataset.meetingId) === id); }
function setup({ state, sessions, meetings = {}, storage = new Map(), fail = false, extraOptions = {} }) {
  const { createSidebarFoldersController } = require('../renderer/sidebar-folders');
  const listeners = new Map(), root = el(), document = { createElement: el, getElementById: () => null, addEventListener() {}, head: el() };
  let renderer;
  const ipcRenderer = { on: (name, fn) => listeners.set(name, fn), invoke: async (channel, args) => {
    if (fail) return { ok: false, error: '目录数据损坏，原文件保留' };
    if (channel.endsWith(':assign')) {
      if (args.folderId === null) delete state.assignments[args.key]; else state.assignments[args.key] = args.folderId;
    }
    return { ok: true, state: JSON.parse(JSON.stringify(state)) };
  } };
  const folders = createSidebarFoldersController({ document, ipcRenderer, storage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, onChange: () => renderer?.renderSessionList() });
  renderer = createSessionListRenderer({ document, localStorage: { getItem: key => storage.get(key) || '[]', setItem: (key, value) => storage.set(key, value) },
    sessionListEl: root, sidebarFolders: folders, getSessions: () => sessions, getMeetings: () => meetings, getActiveSessionId: () => null, getActiveMeetingId: () => null,
    isAiKind: () => true, modelShort: () => '', modelClass: () => 'codeagent', escapeHtml: s => String(s ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    formatTime: () => '刚刚', pctClass: () => '', sessionBurnRate: () => null, selectSession() {}, selectMeeting() {}, openContextMenu() {}, ...extraOptions,
  });
  return { ...renderer, root, folders, document, listeners, storage };
}
const recent = (id, extra = {}) => ({ id, kind: 'codeagent', title: id, status: 'idle', lastMessageTime: Date.now(), ...extra });
const data = () => ({ version: 1, folders: [{ id: 'folder-project', name: '接口项目' }], assignments: { 'session:s-project': 'folder-project' } });
test('tree groups roots, default unclassified is expanded, collapse survives updates and reload, search reveals hidden folder', async () => {
  const sessions = new Map([['s-project', recent('s-project')], ['s-free', recent('s-free')]]), storage = new Map();
  const h = setup({ state: data(), sessions, storage }); await h.folders.refresh();
  assert.ok(row(h.root, 's-free')); assert.ok(row(h.root, 's-project'));
  assert.match(html(h.root), /未分类/); assert.match(html(h.root), /接口项目/);
  h.folders.toggle('folder-project'); assert.equal(row(h.root, 's-project'), null); assert.ok(row(h.root, 's-free'));
  sessions.get('s-free').unreadCount = 2; h.renderSessionList(); assert.equal(row(h.root, 's-project'), null);
  assert.equal(getSidebarSearchEntries(h.document).some(s => s.id === 's-project'), true);
  const reloaded = setup({ state: data(), sessions, storage }); await reloaded.folders.refresh(); assert.equal(row(reloaded.root, 's-project'), null);
  reloaded.revealSearchItem('s-project'); assert.ok(row(reloaded.root, 's-project'));
  assert.equal(reloaded.folders.isCollapsed('folder-project'), false);
});
test('moving a root changes its directory after acknowledgement and invalidates the real sidebar cache', async () => {
  const sessions = new Map([['s-project', recent('s-project')], ['s-free', recent('s-free')]]), h = setup({ state: data(), sessions });
  await h.folders.refresh(); await h.folders.assign('session:s-free', 'folder-project');
  const group = find(h.root, n => n.dataset.sidebarFolder === 'folder-project'); assert.ok(row(group, 's-free'));
  await h.folders.assign('session:s-free', null);
  assert.equal(row(find(h.root, n => n.dataset.sidebarFolder === 'unclassified'), 's-free')?.dataset.sessionId, 's-free');
});
test('group members remain nested in the parent directory; archives remain globally available when every folder is collapsed', async () => {
  const sessions = new Map([['child', recent('child', { meetingId: 'group-1' })], ['old-one', recent('old-one', { status: 'dormant', lastMessageTime: Date.now() - 10 * 86400000 })]]);
  const state = data(); state.assignments = { 'meeting:group-1': 'folder-project', 'session:old-one': 'folder-project' };
  const meetings = { 'group-1': { id: 'group-1', title: '群聊', subSessions: ['child'], participants: [0], groupChat: true, status: 'idle', lastMessageTime: Date.now() } };
  const h = setup({ state, sessions, meetings }); await h.folders.refresh();
  const group = find(h.root, n => n.dataset.sidebarFolder === 'folder-project'); assert.ok(row(group, 'group-1'));
  assert.equal(h.root.children.some(n => n.dataset.sessionId === 'child'), false);
  h.folders.toggle('folder-project'); h.folders.toggle(null);
  assert.ok(find(h.root, n => n.dataset.sidebarRenderKey === 'archive')); assert.match(html(h.root), /全部目录归档/);
  h.revealSearchItem('group-1', 'child'); assert.equal(h.folders.isCollapsed('folder-project'), false);
});
test('corrupt folder metadata is visible and read-only, preserving unclassified access without a fake save', async () => {
  const sessions = new Map([['s-free', recent('s-free')]]), h = setup({ state: data(), sessions, fail: true });
  await h.folders.refresh(); assert.match(html(h.root), /目录数据损坏/); assert.ok(row(h.root, 's-free'));
  await assert.rejects(h.folders.assign('session:s-free', 'folder-project'), /目录数据损坏/);
});

test('real creation callbacks reveal the containing folder and section and scroll the activated session/group into view', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createRequire } = require('node:module');
  const filename = path.join(__dirname, '../renderer/renderer.js'), source = fs.readFileSync(filename, 'utf8');
  for (const kind of ['session', 'lead', 'meeting']) {
    let context;
    const sessions = new Map(), meetings = {}, storage = new Map([['hubSidebarCollapsedFolders', '["unclassified"]'], ['hubSidebarCollapsedSections', '["sec-today","sec-active","sec-failed"]']]);
    const h = setup({ state: data(), sessions, meetings, storage, extraOptions: { getActiveSessionId: () => context?.activeSessionId, getActiveMeetingId: () => context?.activeMeetingId } });
    const frames = []; h.document.defaultView = { requestAnimationFrame: fn => frames.push(fn) };
    await h.folders.refresh();
    const listeners = new Map(), created = recent('new-' + kind, { title: kind === 'lead' ? '负责人' : '新会话' });
    context = { console, sessions, meetings, require: createRequire(filename),
      ipcRenderer: { on: (name, fn) => listeners.set(name, fn), send() {} },
      nativeSessionBootstrap: { record() {} }, codexAccountUi: { resumeCodexAccountRestart: () => false },
      _pendingDormantResumes: new Map(), sessionOpenIntent: 0, activeSessionId: null, activeMeetingId: null,
      paintSidebarResumePending() {}, observeSessionRuntime() {}, RUNTIME_IDLE: 'idle', CONFIDENCE_AUTHORITATIVE: 'authoritative', sessionSplit: { handlesCreated: () => false },
      assistantPanel: { isOpen: () => false }, sidebarFoldersController: h.folders, sessionListRenderer: h,
      scheduleSessionListRender: () => h.renderSessionList(), renderSessionList: () => h.renderSessionList(), schedulePersist() {},
      clearSessionAttention() {}, savePreviewState: async () => {}, clearPreviewUI() {}, completionNotificationToggle: { refreshTarget() {} },
      document: { getElementById: () => null }, window: {}, terminalPanelEl: { style: {} }, paintSidebarActiveTarget() {}, _xresearchRequestedSessionViews: new Map(),
      selectionViewModeForSession: () => 'card', applyViewMode() {}, showTerminal() {}, restorePreviewForContext: async () => {},
    };
    const event = kind === 'meeting' ? 'meeting-created' : 'session-created';
    const start = source.indexOf("ipcRenderer.on('" + event + "',");
    const end = kind === 'meeting' ? source.indexOf("ipcRenderer.on('meeting-updated',", start) : source.indexOf('// Spec 3 · W12', start);
    vm.runInNewContext(source.slice(start, end), context, { filename });
    if (kind === 'meeting') Object.assign(created, { groupChat: true, subSessions: [], participants: [] });
    await listeners.get(event)(null, kind === 'meeting' ? { meeting: created } : { session: created });
    for (const frame of frames) frame();
    if (kind === 'meeting') {
      const createFile = path.join(__dirname, '../renderer/meeting-create-modal.js');
      const createSource = fs.readFileSync(createFile, 'utf8');
      const createStart = createSource.indexOf("    if (!meeting || !meeting.id) throw new Error('create-meeting returned empty meeting');");
      const createEnd = createSource.indexOf('  } catch (e) {', createStart);
      vm.runInNewContext(createSource.slice(createStart, createEnd), {
        meeting: created, _presentation: {}, closeMeetingCreateModal() {},
        window: { __revealCreatedMeeting: id => h.revealCreatedItem(id) },
        selectMeeting: id => { context.activeMeetingId = id; },
      }, { filename: createFile });
      // The creation notification can precede the modal's later activation.
      // Exercise the real selection painter after that delayed activation.
      context.activeMeetingId = created.id;
      context.sessionListEl = h.root; context.CSS = { escape: value => value };
      h.root.querySelector = selector => row(h.root, /\[data-(?:session|meeting)-id="([^"]+)"\]/.exec(selector)?.[1]);
      const paintStart = source.indexOf('function paintSidebarActiveTarget('), paintEnd = source.indexOf('function paintSidebarResumePending(', paintStart);
      vm.runInNewContext(source.slice(paintStart, paintEnd) + '\npaintSidebarActiveTarget({ meetingId: activeMeetingId });', context, { filename });
    }
    assert.equal(h.folders.isCollapsed(null), false, kind);
    const visible = row(h.root, created.id); assert.ok(visible, kind + ' must be visible after the creation callback');
    assert.equal(visible.scrolled, true, kind + ' must scroll into view');
    assert.ok(visible.className.includes('selected'), kind + ' must remain selected');
  }
});

test('a user title starting with [Team] stays visible and searchable; hidden metadata still hides backend sessions', async () => {
  const user = recent('user-title'), hidden = recent('hidden', { title: '后台任务', hiddenFromSidebar: true });
  const h = setup({ state: data(), sessions: new Map([[user.id, user], [hidden.id, hidden]]) }); await h.folders.refresh();
  const { createSessionRenamer } = require('../renderer/session-renaming');
  const renamer = createSessionRenamer({ getSession: () => user, getMeeting: () => null, ipcRenderer: { invoke: async (_channel,args) => ({ ok: true, record: { title: args.title, titleRevision: 1, userRenamed: true } }) }, persist: async () => {}, render: () => h.renderSessionList() });
  await renamer.rename(user.id, '[Team] 项目讨论');
  assert.ok(row(h.root, user.id)); assert.equal(getSidebarSearchEntries(h.document).some(item => item.id === user.id), true);
  assert.equal(row(h.root, hidden.id), null); assert.equal(getSidebarSearchEntries(h.document).some(item => item.id === hidden.id), false);
});

test('a delayed list snapshot cannot replace a newer changed event or its error-free state', async () => {
  const { createSidebarFoldersController } = require('../renderer/sidebar-folders');
  const listeners = new Map(); let release;
  const old = { version: 1, folders: [], assignments: {} }, newest = data();
  const controller = createSidebarFoldersController({ document: {}, storage: { getItem() {} }, ipcRenderer: {
    on: (name, fn) => listeners.set(name, fn), invoke: () => new Promise(resolve => { release = () => resolve({ ok: true, state: old }); }),
  } });
  const refreshing = controller.refresh();
  listeners.get('sidebar-folders:changed')(null, { state: newest });
  release(); await refreshing;
  assert.equal(controller.getState().folders.length, 1); assert.equal(controller.error(), '');
});

test('foreign meeting-created leaves the pinned filter and collapsed folder unchanged', async () => {
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const sessions=new Map([['active',recent('active',{pinned:true})]]),meetings={},storage=new Map([['hubSidebarRange','pinned'],['hubSidebarCollapsedFolders','["unclassified"]']]);
 const h=setup({state:data(),sessions,meetings,storage});await h.folders.refresh();
 const filename=path.join(__dirname,'../renderer/renderer.js'),source=fs.readFileSync(filename,'utf8'),listeners=new Map();
 const start=source.indexOf("ipcRenderer.on('meeting-created',"),end=source.indexOf("ipcRenderer.on('meeting-updated',",start);
 vm.runInNewContext(source.slice(start,end),{ipcRenderer:{on:(name,fn)=>listeners.set(name,fn)},meetings,activeMeetingId:null,sessionListRenderer:h,renderSessionList:()=>h.renderSessionList()},{filename});
 listeners.get('meeting-created')(null,{meeting:{id:'remote',title:'新群',groupChat:true,subSessions:[],participants:[],status:'idle',lastMessageTime:Date.now()}});
 assert.equal(storage.get('hubSidebarRange'),'pinned');assert.equal(h.folders.isCollapsed(null),true);
});

test('own group forks reveal their new root through the creator callback', async t => {
 const meetings={source:{id:'source',title:'源群',subSessions:[],groupChat:true,lastMessageTime:Date.now(),status:'idle'}};
 const h=setup({state:data(),sessions:new Map(),meetings,storage:new Map([['hubSidebarCollapsedFolders','["unclassified"]']])});await h.folders.refresh();
 const selected=[],toast=el();const document={...h.document,getElementById:id=>id==='gc-fork-toast'?toast:null};t.after(()=>clearTimeout(toast._hideTimer));
 const ui=require('../renderer/groupchat-fork-ui').createGroupChatForkUi({document,getMeetings:()=>meetings,notify(){},
  ipcRenderer:{invoke:async()=>{meetings.created={...meetings.source,id:'created'};return{ok:true,meeting:meetings.created};}},
  selectMeeting:(id,options)=>{selected.push([id,options]);if(options?.created)h.revealCreatedItem(id);},confirmAction:async()=>true});
 await ui.forkMeeting('source');assert.equal(h.folders.isCollapsed(null),false);assert.ok(row(h.root,'created'));assert.deepEqual(selected,[['created',{created:true}]]);
});

test('main background task groups stay outside folders, ignore folder assignments and preserve automatic expansion', async () => {
 const task=recent('background-task',{purpose:'company-ai',title:'后台摘要',_resumePending:true}),user=recent('personal');
 const state=data();state.assignments['session:background-task']='folder-project';const sessions=new Map([[task.id,task],[user.id,user]]);
 const h=setup({state,sessions});await h.folders.refresh();
 const section=()=>find(h.root,node=>node.dataset.sidebarRenderKey==='section:sec-background');
 assert.ok(section());assert.ok(h.root.children.includes(row(h.root,task.id)),'background root is outside directory wrappers');
 for(const wrapper of h.root.children.filter(node=>node.dataset.sidebarFolder))assert.equal(row(wrapper,task.id),null);
 assert.equal(h.root.querySelectorAll('.session-item').filter(node=>node.dataset.sessionId===task.id).length,1);
 const toggle=()=>section().emit('click',{target:{className:'sec-collapse',closest:selector=>selector==='.sec-collapse'?{}:null},preventDefault(){},stopPropagation(){}});
 toggle();assert.equal(row(h.root,task.id),null);h.renderSessionList();assert.equal(row(h.root,task.id),null,'manual collapse survives normal repaint');
 task._resumePending=false;h.renderSessionList();assert.equal(row(h.root,task.id),null,'finished group automatically folds');
 task._resumePending=true;h.renderSessionList();assert.ok(row(h.root,task.id),'new running phase opens background group');
 h.folders.toggle(null);h.folders.toggle('folder-project');assert.ok(row(h.root,task.id),'all directories can fold without hiding background tasks');
});
test('locating background results opens only their global group and keeps current directory and pinned filter', async () => {
 const task=recent('background-result',{purpose:'company-ai',title:'后台结果'}),storage=new Map([['hubSidebarRange','pinned'],['hubSidebarCollapsedFolders','["unclassified","folder-project"]']]);
 const h=setup({state:data(),sessions:new Map([[task.id,task]]),storage});await h.folders.refresh();assert.equal(row(h.root,task.id),null);
 assert.ok(getSidebarSearchEntries(h.document).some(item=>item.id===task.id));h.revealSearchItem(task.id);
 assert.equal(h.folders.isCollapsed(null),true);assert.equal(h.folders.isCollapsed('folder-project'),true);assert.equal(storage.get('hubSidebarRange'),'pinned');assert.ok(row(h.root,task.id));
 task._resumePending=true;h.renderSessionList();const section=find(h.root,node=>node.dataset.sidebarRenderKey==='section:sec-background');section.emit('click',{target:{className:'sec-collapse',closest:()=>({})},preventDefault(){},stopPropagation(){}});task._resumePending=false;h.revealSearchItem(task.id);assert.ok(row(h.root,task.id),'a just-finished result can be located before the queued repaint');
});
test('known background purposes do not acquire legacy hidden flags while ordinary legacy [Team] records still migrate', async () => {
 const {migrateLegacyBranchSessionMeta}=require('../core/session-title-guards');
 const sessions=new Map();
 for(const purpose of ['company-assistant','company-ai','company-forum']){
  const task=migrateLegacyBranchSessionMeta(recent('legacy-'+purpose,{purpose,title:'[Team] 旧任务',_resumePending:true}));
  assert.notEqual(task.hiddenFromSidebar,true,purpose);sessions.set(task.id,task);
 }
 const old=migrateLegacyBranchSessionMeta(recent('legacy-hidden',{title:'[Team] 旧后台'}));assert.equal(old.hiddenFromSidebar,true);sessions.set(old.id,old);
 const hiddenBackground=migrateLegacyBranchSessionMeta(recent('explicit-hidden-background',{purpose:'company-ai',title:'[Team] 明确隐藏',hiddenFromSidebar:true,_resumePending:true}));assert.equal(hiddenBackground.hiddenFromSidebar,true);sessions.set(hiddenBackground.id,hiddenBackground);
 const manual=migrateLegacyBranchSessionMeta(recent('manual-prefix',{title:'[Team] 我的标题',userRenamed:true}));sessions.set(manual.id,manual);
 const h=setup({state:data(),sessions});await h.folders.refresh();
 for(const task of sessions.values()){
  if(task.id==='legacy-hidden'||task.id==='explicit-hidden-background')assert.equal(row(h.root,task.id),null);
  else assert.ok(row(h.root,task.id),task.id);
 }
 const unclassified=find(h.root,node=>node.dataset.sidebarFolder==='unclassified');assert.ok(row(unclassified,manual.id));
 for(const purpose of ['company-assistant','company-ai','company-forum'])assert.equal(row(unclassified,'legacy-'+purpose),null);
});
test('the resident assistant remains outside folders and appears only once with background tasks', async t => {
 const before=process.env.CLAUDE_HUB_COMPANY_ASSISTANT,oldData=process.env.CLAUDE_HUB_DATA_DIR;process.env.CLAUDE_HUB_COMPANY_ASSISTANT='1';process.env.CLAUDE_HUB_DATA_DIR||='/isolated/test';
 t.after(()=>{if(before===undefined)delete process.env.CLAUDE_HUB_COMPANY_ASSISTANT;else process.env.CLAUDE_HUB_COMPANY_ASSISTANT=before;if(oldData===undefined)delete process.env.CLAUDE_HUB_DATA_DIR;else process.env.CLAUDE_HUB_DATA_DIR=oldData;});
 const resident=recent('resident',{purpose:'company-assistant',title:'公司助理'}),task=recent('ppt-task',{purpose:'company-assistant',title:'PPT 找页 · 内容',_resumePending:true});
 const h=setup({state:data(),sessions:new Map([[resident.id,resident],[task.id,task]])});await h.folders.refresh();
 assert.ok(h.root.children.includes(row(h.root,resident.id)));assert.ok(h.root.children.includes(row(h.root,task.id)));
 assert.equal(h.root.querySelectorAll('.session-item').filter(node=>node.dataset.sessionId===resident.id).length,1);
});
test('background tasks cannot be moved into personal folders through the real context menu',async()=>{
 const task=recent('background-menu',{purpose:'company-ai'}),move=el('button'),menu=el();move.dataset.action='folder-move';menu.querySelector=selector=>selector.includes('folder-move')?move:null;menu.querySelectorAll=()=>[move];
 let moves=0;const h=setup({state:data(),sessions:new Map([[task.id,task]])});
 const controller=require('../renderer/context-menus').createSessionContextMenuController({document:h.document,window:{},contextMenuEl:menu,sessions:new Map([[task.id,task]]),meetings:{},ipcRenderer:{},getActiveSessionId:()=>null,getActiveMeetingId:()=>null,renderSessionList(){},schedulePersist(){},sidebarFolders:{error:()=>'',showAssign:async()=>{moves++;}},folderEntityKey:id=>'session:'+id,requestAnimationFrameFn:fn=>fn()});
 controller.init();controller.open(task.id,0,0);assert.equal(move.disabled,true);assert.match(move.title,/后台任务/);await move.emit('click');assert.equal(moves,0);
});
