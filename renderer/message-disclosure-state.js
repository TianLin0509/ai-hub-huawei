'use strict';

// Reading state belongs to the source message, not the current DOM position.
const choices = new Map();
// 长消息折叠与团队消息的一行折叠（来源 af253ce0）：用户点开过的，卡片整张重画后仍保持展开。
const FOLDS = 'details.conversation-long-message, details.team-notice-fold';
const boundDocuments = new WeakSet();
function key(details) {
  const card = details.closest?.('[data-turn-id], [data-gc-msg-id]');
  if (!card) return null;
  const message = details.closest('[data-message-id]');
  return JSON.stringify([card.dataset.sessionId || card.dataset.sourceSid || '',
    card.dataset.turnId || card.dataset.gcMsgId, message?.dataset.messageId || '', details.className]);
}
function restore(card) {
  const doc = card?.ownerDocument;
  if (!doc) return;
  if (!boundDocuments.has(doc)) {
    boundDocuments.add(doc);
    // Record the explicit action before a synchronous live patch can replace it.
    // Programmatic `open` restoration must never overwrite the user's choice.
    doc.addEventListener('click', event => {
      const summary = event.target.closest?.('summary');
      const details = summary?.parentElement;
      if (!details?.matches(FOLDS)) return;
      const id = key(details);
      if (id) choices.set(id, !details.open);
    }, true);
  }
  for (const details of card.querySelectorAll(FOLDS)) {
    const id = key(details);
    if (choices.has(id)) details.open = choices.get(id);
  }
}
// 用户亲手点过的展开/收起；没点过返回 undefined（相邻消息分组展开时据此决定单条是否摊开）。
function choice(details) { const id = key(details); return id && choices.has(id) ? choices.get(id) : undefined; }
module.exports = { key, restore, choice };
