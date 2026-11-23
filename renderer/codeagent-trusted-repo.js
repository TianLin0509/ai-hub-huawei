'use strict';

const { isCodeAgentKind } = require('../core/ai-kinds');
const MESSAGE = '当前目录不在公司可信仓，CodeAgent 被风控';
const ACTION = '换到可信仓目录新建会话';

function isBlocked(session, message) {
  const settled = ['completed', 'manual_extracted', 'interrupted', 'superseded'].includes(message?.status);
  return !!(session && isCodeAgentKind(session.kind) && session.codeagentTrustedRepoRequired && !settled)
    || message?.statusReason === 'trusted_repo_required' || message?.failure?.code === 'trusted_repo_required';
}

// 共用启动中心的选目录入口；取消选择时不建会话，也不改原会话目录。
async function openSession(windowRef) {
  const workspace = await windowRef.WorkspaceController.pickWorkspace();
  if (!workspace?.path) return false;
  windowRef.LaunchCenter.open('session', { kind: 'codeagent', workspace });
  return true;
}

function renderNotice(document, overlay, session, onOpen) {
  let notice = overlay.querySelector('.codeagent-trusted-repo-notice');
  if (!isBlocked(session)) { notice?.remove(); return null; }
  if (notice?.dataset.sessionId !== session.id) { notice?.remove(); notice = null; }
  if (notice) return notice;
  notice = document.createElement('div');
  notice.className = 'codeagent-trusted-repo-notice';
  notice.dataset.sessionId = session.id;
  notice.setAttribute('role', 'status');
  const label = document.createElement('span');
  label.textContent = MESSAGE;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = ACTION;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await onOpen(); }
    catch (error) { label.textContent = `${MESSAGE}。选择目录失败：${error.message}`; }
    finally { button.disabled = false; }
  });
  notice.append(label, button);
  overlay.appendChild(notice);
  return notice;
}

module.exports = { MESSAGE, ACTION, isBlocked, openSession, renderNotice };
