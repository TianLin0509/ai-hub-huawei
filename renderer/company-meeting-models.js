'use strict';
// 与会话模型菜单共用账号读取入口；读取只补缓存，不设置账号默认或切换会议。
function createMeetingModelSync({ ipcRenderer, onCatalog = () => {}, onUpdate = () => {} }) {
  let pending = null, retrying = null, again = false, disposed = false, started = false;
  const failed = error => { if (!disposed) onCatalog({ state: 'failed', error: String(error?.message || error || '模型清单读取失败') }); };
  function read() {
    if (disposed || !ipcRenderer) return Promise.resolve();
    started = true;
    if (pending) { again = true; return pending; }
    pending = Promise.resolve().then(() => ipcRenderer.invoke('codeagent:models', { account: 'personal' }))
      .then(result => {
        if (disposed) return;
        if (result?.error) throw new Error(result.error);
        if (!result?.catalog) throw new Error('未读到账号模型清单状态');
        onCatalog(result.catalog); return onUpdate();
      }).catch(failed).finally(() => {
        pending = null;
        if (again && !disposed) { again = false; void read(); }
      });
    return pending;
  }
  function retry() {
    if (disposed || !ipcRenderer) return Promise.resolve();
    if (retrying) return retrying;
    onCatalog({ state: 'loading' });
    retrying = Promise.resolve().then(() => ipcRenderer.invoke('codeagent-pool:probe', { id: 'personal' }))
      .then(result => { if (result?.ok === false) throw new Error(result.error || '模型清单读取失败'); return read(); })
      .catch(failed).finally(() => { retrying = null; });
    return retrying;
  }
  const changed = (_event, payload) => { if (started && payload?.id === 'personal') void read(); };
  ipcRenderer?.on?.('codeagent-pool:changed', changed);
  return { read, retry, dispose() { disposed = true; again = false; ipcRenderer?.removeListener?.('codeagent-pool:changed', changed); } };
}
module.exports = { createMeetingModelSync };
