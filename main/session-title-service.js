'use strict';

const { validateUserTitle, titleMetadata, preserveTitleMetadata } = require('../core/title-metadata');

function createTitleService(deps) {
  const { sessionManager, meetingManager, sessionStore, meetingStore, stateStore, sendToRenderer = () => {} } = deps;
  const queues = new Map();
  async function commit({ type, id, title }) {
    if (!['session', 'meeting'].includes(type) || typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) throw new Error('会话或群聊标识无效');
    title = validateUserTitle(title);
    const live = type === 'session' ? sessionManager.getSession(id) : meetingManager.getMeeting(id);
    const base = live || (type === 'session' && deps.getLastPersistedSessions().find(record => (record.hubId || record.id) === id));
    if (!base) throw new Error('会话或群聊不存在');
    const native = type === 'session' && (sessionManager.getNativeCodex?.(id) || sessionManager.getNativeClaude?.(id));
    if (base.readOnly || native?.control?.shared && native.control.role !== 'controller') throw new Error('只读会话不能重命名');
    const store = type === 'session' ? sessionStore : meetingStore;
    const record = await store.withWriteLock(id, () => stateStore.commitTitle({ type, id, base, title,
      getBase: () => {
        const current = type === 'session' ? sessionManager.getSession(id) : meetingManager.getMeeting(id);
        const kept = type === 'session' ? deps.getLastPersistedSessions().find(row => (row.hubId || row.id) === id) : null;
        if (!current && !kept) return null;
        const backup = type === 'session' ? store.loadSessionFile(id, { strict: true }) : store.loadMeetingFile(id, { strict: true });
        return preserveTitleMetadata(current ? { ...backup, ...current } : { ...kept, ...backup }, backup);
      },
      writeBackup: value => {
        const saved = type === 'session' ? store.saveSessionFile(id, value) : store.saveMeetingFile(id, value);
        if (saved === false) throw new Error('标题版本已更新，名称未保存，请重试');
      },
      guard: run => {
        const owners = type === 'session' && sessionManager._openOwners?.();
        return owners ? owners.editSessions([id], run, { allowOwn: !!sessionManager.getSession(id) }) : run();
      },
    }));
    const patch = titleMetadata(record);
    if (type === 'session') {
      if (sessionManager.getSession(id)) sessionManager.updateSessionMeta(id, patch);
      const rows = deps.getLastPersistedSessions();
      deps.setLastPersistedSessions(rows.some(row => (row.hubId || row.id) === id)
        ? rows.map(row => (row.hubId || row.id) === id ? { ...row, ...patch } : row)
        : [...rows, { ...record, hubId: id }]);
      sendToRenderer('session-updated', { session: { ...(sessionManager.getSession(id) || record), ...patch, id } });
    } else {
      meetingManager.updateMeeting(id, patch);
      deps.setLastPersistedMeetings(deps.getLastPersistedMeetings().map(row => row.id === id ? { ...row, ...patch } : row));
      sendToRenderer('meeting-updated', { meeting: meetingManager.getMeeting(id) });
    }
    let nativeRename;
    const claude = type === 'session' && sessionManager.getNativeClaude?.(id);
    if (claude) {
      try { await claude.rename(title); }
      catch (error) { nativeRename = { status: 'failed', message: error.message }; }
    }
    return { ok: true, record: { id, ...patch }, ...(nativeRename ? { nativeRename } : {}) };
  }
  function rename(request) {
    const key = request?.type + ':' + request?.id;
    const task = (queues.get(key) || Promise.resolve()).catch(() => {}).then(() => commit(request || {}));
    queues.set(key, task);
    const clean = () => { if (queues.get(key) === task) queues.delete(key); };
    task.then(clean, clean);
    return task;
  }
  return { rename };
}
module.exports = { createTitleService };
