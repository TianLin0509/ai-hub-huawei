'use strict';

// 「会话已建好，但某一步没成」的一行提示（renderer/session-create-outcome.js 出文案）：
// 底部居中的一次性轻提示，按钮紧跟在文字后面，约 10 秒自动消失，鼠标停在上面时不消失。
// 同一个会话只留一条（按会话编号去重，新内容替换旧内容），不同会话各自一条、按钮各管各的会话。

const STACK_ID = 'session-create-toast-stack';
const DEFAULT_MS = 10000;

const ACTION_LABEL = { 'open-session': '打开会话', 'proxy-restart': '重新启动模型通道', 'pick-model': '换一个' };

function stack(document) {
  let root = document.getElementById(STACK_ID);
  if (root) return root;
  root = document.createElement('div');
  root.id = STACK_ID;
  Object.assign(root.style, {
    position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)', zIndex: '100000',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', maxWidth: 'min(760px, 92vw)',
  });
  document.body.appendChild(root);
  return root;
}

/**
 * @param {Document} document
 * @param {{ sessionId: string, message: string, actions?: string[], onAction?: (action: string, sessionId: string) => Promise<unknown>|unknown,
 *   durationMs?: number, setTimer?: Function, clearTimer?: Function }} input
 */
function showCreateFollowupToast(document, { sessionId, message, actions = [], onAction, durationMs = DEFAULT_MS,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const text = String(message || '').trim();
  if (!sessionId || !text) return null;
  const root = stack(document);
  const id = `session-create-toast-${sessionId}`;
  const old = document.getElementById(id);
  if (old) { if (old._hideTimer) clearTimer(old._hideTimer); old.remove(); }
  const item = document.createElement('div');
  item.id = id;
  item.className = 'session-create-toast';
  item.dataset.sessionId = sessionId;
  item.setAttribute('role', 'status');
  Object.assign(item.style, {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: '10px',
    background: 'rgba(34, 34, 38, .96)', color: '#f5f5f7', boxShadow: '0 8px 28px rgba(0,0,0,.35)',
    font: '13px/1.5 "Microsoft YaHei", "Segoe UI", sans-serif', whiteSpace: 'nowrap', overflow: 'hidden',
  });
  const body = document.createElement('span');
  body.className = 'session-create-toast-text';
  Object.assign(body.style, { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' });
  body.textContent = text;
  body.title = text;
  item.appendChild(body);
  const hide = () => { if (item._hideTimer) clearTimer(item._hideTimer); item._hideTimer = null; item.remove(); };
  const arm = () => { if (item._hideTimer) clearTimer(item._hideTimer); item._hideTimer = setTimer(hide, durationMs); };
  for (const action of actions) {
    const label = ACTION_LABEL[action];
    if (!label) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-create-toast-action';
    button.dataset.action = action;
    button.textContent = label;
    Object.assign(button.style, { flex: 'none', cursor: 'pointer', font: 'inherit', padding: '2px 10px', borderRadius: '6px',
      border: '1px solid rgba(255,255,255,.35)', background: 'transparent', color: 'inherit' });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await onAction?.(action, sessionId); hide(); }
      catch (error) { button.textContent = `${(error && error.message) || '操作失败'}，点击重试`; arm(); }
      finally { button.disabled = false; }
    });
    item.appendChild(button);
  }
  item.addEventListener('mouseenter', () => { if (item._hideTimer) clearTimer(item._hideTimer); item._hideTimer = null; });
  item.addEventListener('mouseleave', arm);
  root.appendChild(item);
  arm();
  return item;
}

module.exports = { showCreateFollowupToast, ACTION_LABEL, DEFAULT_MS };
