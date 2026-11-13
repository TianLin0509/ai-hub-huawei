'use strict';

// 侧栏拖拽归类：把会话、群聊或团队整行拖到目录上（或拖到「＋ 新建目录」上先建再放）。
// 保存走的是右键「移动到目录」同一条路径；侧栏会原地复用节点，所以事件统一挂在列表容器上。
const DRAG_TYPE = 'application/x-hub-sidebar-entity';

function attachSidebarFolderDrag({ listEl, sidebarFolders, folderEntityKey, notify = () => {} }) {
  let dragging = null, marked = null;
  const mark = node => {
    if (marked && marked !== node) marked.classList.remove('drop-target');
    marked = node || null;
    if (marked) marked.classList.add('drop-target');
  };
  const finish = () => { mark(null); listEl.classList.remove('folder-dragging'); dragging = null; };
  function targetOf(event) {
    const create = event.target?.closest?.('[data-folder-create]');
    if (create) return { node: create, create: true };
    const folder = event.target?.closest?.('.sidebar-folder');
    if (!folder) return null;
    const folderId = folder.dataset.sidebarFolder === 'unclassified' ? null : folder.dataset.sidebarFolder;
    return folderId === dragging.from ? null : { node: folder, folderId };
  }
  async function move(key, target) {
    try {
      if (!target.create) return void await sidebarFolders.assign(key, target.folderId);
      const before = new Set(sidebarFolders.getState().folders.map(folder => folder.id));
      await sidebarFolders.showCreate();
      const created = sidebarFolders.getState().folders.find(folder => !before.has(folder.id));
      if (created) await sidebarFolders.assign(key, created.id);
    } catch (error) { notify(error.message); }
  }
  listEl.addEventListener('dragstart', event => {
    const row = event.target?.closest?.('.session-item');
    const id = row?.dataset.sessionId || row?.dataset.meetingId;
    const key = id && !sidebarFolders.error() ? folderEntityKey(id) : null;
    if (!key) { event.preventDefault(); return; }
    const assigned = sidebarFolders.getState().assignments[key];
    dragging = { key, from: sidebarFolders.getState().folders.some(folder => folder.id === assigned) ? assigned : null };
    event.dataTransfer.setData(DRAG_TYPE, key);
    event.dataTransfer.effectAllowed = 'move';
    listEl.classList.add('folder-dragging');
  });
  listEl.addEventListener('dragover', event => {
    if (!dragging) return;
    const target = targetOf(event);
    mark(target?.node);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  listEl.addEventListener('dragleave', event => {
    if (dragging && !listEl.contains?.(event.relatedTarget)) mark(null);
  });
  listEl.addEventListener('drop', event => {
    if (!dragging) return;
    const target = targetOf(event), key = dragging.key;
    finish();
    if (!target) return;
    event.preventDefault();
    void move(key, target);
  });
  listEl.addEventListener('dragend', finish);
}

module.exports = { attachSidebarFolderDrag, DRAG_TYPE };
