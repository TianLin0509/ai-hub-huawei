'use strict';
const { validateName } = require('./name-editor');
const { titleMetadata, titleRevision } = require('../core/title-metadata');

function createSessionRenamer({ getSession, getMeeting, ipcRenderer, render, syncClaude = () => {}, notify = () => {} }) {
  async function rename(id, value) {
    if (value === null) return false;
    const title = validateName(value), meeting = getMeeting(id), session = getSession(id), target = meeting || session;
    if (!target) throw new Error('会话或群聊不存在');
    if (target.readOnly) throw new Error('只读会话不能重命名');
    let result;
    try { result = await ipcRenderer.invoke('session:rename-title', { type: meeting ? 'meeting' : 'session', id, title }); }
    catch (error) { throw new Error('名称保存失败，请重试：' + error.message); }
    if (!result?.ok || !result.record) throw new Error(result?.error || '名称未保存，请重试');
    const current = (meeting ? getMeeting(id) : getSession(id)) || target;
    if (titleRevision(result.record) >= titleRevision(current)) Object.assign(current, titleMetadata(result.record));
    render(id);
    if (!meeting && session.status !== 'dormant' && /^(?:claude|claude-resume)$/.test(session.kind)) syncClaude(id, title);
    if (result.nativeRename?.status === 'failed') notify('Hub 名称已保存；Claude 历史同步失败：' + result.nativeRename.message);
    return true;
  }
  return { rename };
}
module.exports = { createSessionRenamer };
