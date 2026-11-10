'use strict';
const { getSessionRuntimeTruth } = require('../core/session-runtime-truth');
const { isNativeRecordId } = require('../core/codeagent-record-id');
const FORK_TITLE = '文件不会回退，跨会话记忆共享';
let enabled = false;
let statusInvoke = null, changed = () => {};
const availability = new Map();
function setEnabled(value) { enabled = value === true; availability.clear(); changed(); }
function configureStatus(invoke, onChange) { statusInvoke = invoke; changed = onChange || (() => {}); }
function invalidateStatus(id) { availability.delete(id); }
function dormantStatus(session) {
  const key = [session.ccSessionId, session.transcriptPath].join('|');
  let cached = availability.get(session.id);
  if (cached?.key === key) return cached;
  cached = { key, ok: false, message: '正在确认会话占用和记录状态' };
  availability.set(session.id, cached);
  if (!statusInvoke) { cached.message = '无法确认会话占用状态'; return cached; }
  Promise.resolve().then(() => statusInvoke('session:prefix-fork-status', { sourceSessionId: session.id }))
    .then(result => { if (availability.get(session.id) === cached) Object.assign(cached, { ok: result?.ok === true,
      message: result?.message || (result?.ok ? '' : '无法确认会话占用状态') }); })
    .catch(() => { cached.ok = false; cached.message = '无法确认会话占用状态'; })
    .finally(() => { if (availability.get(session.id) === cached) changed(); });
  return cached;
}

function nativeUserRecordId(turn) {
  if (!turn || turn.inherited || turn.queuedSupplement || turn.codeagentCommand || turn.nativeActivity
    || !['user', 'assistant'].includes(turn.role) || ['commentary', 'activity'].includes(turn.phase)
    || String(turn.id || '').startsWith('branch-inherited:')) return null;
  const id = turn.nativeUserRecordId || (['claude-transcript', 'claude-stream-json'].includes(turn.source)
    ? (turn.role === 'user' ? turn.id : turn.userMessageId) : null);
  return isNativeRecordId(id) ? id : null;
}

function branchAction(turn, session) {
  if (!enabled || turn?.role !== 'assistant' || !turn.text?.trim() || !/^codeagent(?:-resume)?$/.test(session?.kind || '') || session.meetingId) return null;
  // Projection marks the final body owner before pagination splits the cards.
  if (turn.logicalTurnId && !turn.deliveryContext) return null;
  const cutUserUuid = nativeUserRecordId(turn);
  if (!cutUserUuid) return null;
  const state = getSessionRuntimeTruth(session).state;
  const dormant = state === 'dormant' ? dormantStatus(session) : null;
  const disabled = dormant ? !dormant.ok : !['idle', 'completed', 'interrupted'].includes(state);
  const reason = dormant ? dormant.message : disabled ? ['running', 'starting', 'waiting'].includes(state) ? '回答进行中' : '无法确认会话空闲' : '';
  return { cutUserUuid, replyId: turn.logicalTurnId || turn.id, disabled, title: [reason, FORK_TITLE].filter(Boolean).join('；') };
}

function patchCardActions(cards, turns, getSession) {
  const last = new Map();
  for (const card of cards) {
    const turn = turns?.get(card.dataset.turnId), action = branchAction(turn, getSession(card.dataset.sessionId));
    if (action) last.set(card.dataset.sessionId + ':' + action.cutUserUuid, card);
  }
  for (const card of cards) {
    const turn = turns?.get(card.dataset.turnId), action = branchAction(turn, getSession(card.dataset.sessionId));
    let button = card.querySelector('[data-action="fork-before-turn"]');
    const visible = !!action && last.get(card.dataset.sessionId + ':' + action.cutUserUuid) === card;
    card.classList.toggle('tc-prefix-branch-action', visible);
    // Staged history and cards drawn before config arrives may lack the node.
    // Reconcile it on the primary surface without rerendering the card body.
    if (!button && visible) {
      const actions = card.querySelector('.card-actions-popover');
      if (actions && card.ownerDocument) {
        button = card.ownerDocument.createElement('button'); button.type = 'button';
        button.className = 'ta-btn'; button.dataset.action = 'fork-before-turn';
        button.textContent = '从此处分支'; actions.append(button);
      }
    }
    if (!button) continue;
    button.hidden = !visible;
    // Removing the option also restores the exact baseline menu when disabled.
    if (!visible) button.remove?.();
    button.disabled = !visible || action.disabled;
    button.title = action?.title || FORK_TITLE;
  }
}

function showFallback({ button, session, invoke, notify, selectSession, openNewSession }, reason) {
  const doc = button.ownerDocument;
  if (!doc) { notify(reason, 'error'); return; }
  const content = button.closest('.turn-content') || button.parentElement;
  content.querySelector('.prefix-fork-fallback')?.remove();
  const box = doc.createElement('div'); box.className = 'prefix-fork-fallback'; box.setAttribute('role', 'alert');
  box.setAttribute('data-copy-exclude', '');
  const text = doc.createElement('span'); text.textContent = reason + '。' + FORK_TITLE + '。'; box.append(text);
  for (const [label, run] of [
    ['普通分支（保留当前全部对话）', async () => {
      const result = await invoke(session.status === 'dormant' ? 'session:prefix-fork-ordinary' : 'fork-session', { sourceSessionId: session.id });
      if (!result?.ok) throw new Error(result?.message || '普通分支失败');
      await selectSession(result.session.id);
    }], ['新开会话', async () => openNewSession?.()],
  ]) {
    const choice = doc.createElement('button'); choice.type = 'button'; choice.className = 'ta-btn'; choice.textContent = label;
    choice.addEventListener('click', async event => {
      event.stopPropagation(); choice.disabled = true;
      try { await run(); box.remove(); }
      catch (error) {
        text.textContent = (error?.message || '操作失败，请重试或新开会话') + '。' + FORK_TITLE;
        try { await invoke('session:prefix-fork-client-failed', { sourceSessionId: session.id }); } catch {}
      }
      finally { choice.disabled = false; }
    }); box.append(choice);
  }
  content.append(box);
}

async function forkBeforeTurn(args) {
  const { turn, session, button, invoke, notify, selectSession } = args;
  const action = branchAction(turn, session);
  if (!action || action.disabled) { notify(action?.title || '这条消息不能从此处创建分支', 'warning'); return null; }
  const menu = button.closest?.('.card-actions-menu');
  if (menu) menu.open = false;
  button.disabled = true;
  try {
    const result = await invoke('session:fork-before-turn', { sourceSessionId: session.id, replyId: action.replyId });
    if (!result?.ok) {
      if (session.status === 'dormant') { invalidateStatus(session.id); dormantStatus(session); }
      const reason = result?.message || '分支创建失败';

      button.title = reason + '；' + FORK_TITLE;
      showFallback(args, reason);
      return result;
    }
    await selectSession(result.session.id);
    return result;
  } catch {
    try { await invoke('session:prefix-fork-client-failed', { sourceSessionId: session.id }); } catch {}
    showFallback(args, '分支请求或界面切换失败，请先检查是否已创建会话');
    return null;
  } finally { button.disabled = branchAction(turn, session)?.disabled ?? true; }
}

module.exports = { setEnabled, configureStatus, invalidateStatus, showFallback, branchAction, nativeUserRecordId, patchCardActions, forkBeforeTurn, FORK_TITLE };
