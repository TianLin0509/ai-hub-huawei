'use strict';

const { openNameEditor } = require('./name-editor');

function createSidebarFoldersController({ document, ipcRenderer, storage, onChange = () => {}, confirm = null }) {
  let state = { version: 1, folders: [], assignments: {} }, error = '', revision = 0;
  let snapshotSequence = 0, readSequence = 0;
  const collapseKey = 'hubSidebarCollapsedFolders';
  let collapsed = new Set();
  try { const saved = JSON.parse(storage.getItem(collapseKey) || '[]'); if (Array.isArray(saved)) collapsed = new Set(saved.filter(s => typeof s === 'string')); } catch { /* Display preferences do not block classification. */ }
  const idKey = id => id || 'unclassified';
  function accept(next) {
    snapshotSequence++;
    if (!next || next.version !== 1 || !Array.isArray(next.folders) || !next.assignments) throw new Error('目录数据格式无效，请重试');
    if (error || JSON.stringify(state) !== JSON.stringify(next)) { state = next; error = ''; revision++; onChange(); }
  }
  function saveCollapsed() {
    try { storage.setItem(collapseKey, JSON.stringify([...collapsed])); } catch { /* Keep the current window usable. */ }
    revision++; onChange();
  }
  async function refresh() {
    const snapshotAtStart = snapshotSequence, request = ++readSequence;
    const obsolete = () => snapshotAtStart !== snapshotSequence || request !== readSequence;
    let processingResponse = false;
    try {
      const response = await ipcRenderer.invoke('sidebar-folders:list');
      if (obsolete()) return true;
      processingResponse = true;
      if (!response?.ok) throw new Error(response?.error || '目录读取失败，请重试');
      accept(response.state); return true;
    } catch (failure) {
      if (!processingResponse && obsolete()) return true;
      error = failure.message; revision++; onChange(); return false;
    }
  }
  async function mutate(action, args) {
    if (error) throw new Error(error);
    const response = await ipcRenderer.invoke('sidebar-folders:' + action, args);
    if (!response?.ok) throw new Error(response?.error || '目录保存失败，请重试');
    accept(response.state);
    return state;
  }
  function folderOf(item) {
    const key = (item._isMeeting ? 'meeting:' : 'session:') + (item.id || item.hubId);
    const id = state.assignments[key];
    return state.folders.some(folder => folder.id === id) ? id : null;
  }
  const api = {
    refresh,
    getState: () => state,
    error: () => error,
    signature: () => revision,
    folders: () => [{ id: null, name: '未分类' }, ...state.folders],
    folderOf,
    isCollapsed: id => collapsed.has(idKey(id)),
    toggle(id) { const key = idKey(id); if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); saveCollapsed(); },
    reveal(item) { const key = idKey(folderOf(item)); if (collapsed.delete(key)) saveCollapsed(); },
    create: name => mutate('create', { name }),
    rename: (folderId, name) => mutate('rename', { folderId, name }),
    remove: folderId => mutate('remove', { folderId }),
    assign: (key, folderId) => mutate('assign', { key, folderId }),
    showCreate: () => openNameEditor({ document, title: '新建目录', maxLength: 40, save: name => api.create(name) }),
    showRename(folderId) {
      const folder = state.folders.find(f => f.id === folderId);
      if (!folder) return;
      return openNameEditor({ document, title: '重命名目录', value: folder.name, maxLength: 40, save: name => api.rename(folderId, name) });
    },
    async showRemove(folderId) {
      const folder = state.folders.find(f => f.id === folderId);
      if (!folder) return;
      const ask = confirm || ((message, options) => require('./ui-feedback').confirmHubAction(message, { document, ...options }));
      if (await ask(`删除目录“${folder.name}”？里面的会话、群聊和团队会回到“未分类”，内容全部保留。`, { title: '删除目录', acceptLabel: '删除目录', cancelLabel: '保留目录' })) {
        await api.remove(folderId);
        if (collapsed.delete('unclassified')) saveCollapsed();
      }
    },
    showAssign(key) {
      const id = state.assignments[key] || 'unclassified';
      return openNameEditor({ document, title: '移动到目录', value: id,
        choices: api.folders().map(folder => ({ value: folder.id || 'unclassified', label: folder.name })),
        save: value => api.assign(key, value === 'unclassified' ? null : value),
      });
    },
  };
  ipcRenderer.on?.('sidebar-folders:changed', (_event, payload) => {
    try { accept(payload?.state); }
    catch (failure) { error = failure.message; revision++; onChange(); }
  });
  return api;
}

module.exports = { createSidebarFoldersController };
