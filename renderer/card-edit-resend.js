'use strict';

const { isCodeAgentKind } = require('../core/ai-kinds');
const STOPPED_KEY = 'hub.stopped-user-turns.v1';
const STOPPED_PER_SESSION_LIMIT = 50, STOPPED_TOTAL_LIMIT = 500;
function stoppedRecords(storage) {
  try { return JSON.parse(storage?.getItem(STOPPED_KEY) || '{}'); }
  catch { return {}; }
}
function turnKeys(turn) {
  return [turn.id && 'turn:' + turn.id, turn.clientSubmissionId && 'submission:' + turn.clientSubmissionId].filter(Boolean);
}
function isStoppedUserTurn(turn, storage, sessionId) {
  return turn.role === 'user' && (turn.stopped === true || ['stopped', 'interrupted'].includes(turn.deliveryStatus)
    || turn.commandResult?.stopped === true && !turn.commandResult.notSent
    || (stoppedRecords(storage)[sessionId] || []).some(row => turnKeys(turn).some(key => turnKeys(row).includes(key))));
}
function rememberStoppedTurn(storage, sessionId, turn) {
  if (!storage || !sessionId) return;
  const records = stoppedRecords(storage), keys = turnKeys(turn);
  const at = Math.max(Date.now(), ...Object.values(records).flat().map(row => row.at + 1));
  records[sessionId] = [{ id: turn.id, clientSubmissionId: turn.clientSubmissionId, at },
    ...(records[sessionId] || []).filter(row => !turnKeys(row).some(key => keys.includes(key)))].slice(0, STOPPED_PER_SESSION_LIMIT);
  const all = Object.entries(records).flatMap(([sid, rows]) => rows.map(row => ({ sid, row }))).sort((a, b) => b.row.at - a.row.at);
  for (const { sid, row } of all.slice(STOPPED_TOTAL_LIMIT)) records[sid] = records[sid].filter(item => item !== row);
  for (const sid of Object.keys(records)) if (!records[sid].length) delete records[sid];
  storage.setItem(STOPPED_KEY, JSON.stringify(records));
}
function clearStoppedTurns(storage, sessionId) {
  const records = stoppedRecords(storage); delete records[sessionId];
  try { storage?.setItem(STOPPED_KEY, JSON.stringify(records)); }
  catch { console.warn('[stopped-card] state could not be cleared'); }
}

async function editResend({ input, sessionId, session, text, document, window, readText, replaceText, saveDraft,
  invoke, notify, storage, historyChanged = () => {}, isCurrent = () => true }) {
  const skills = require('./composer-codeagent-skills');
  let skill = null;
  const match = /^\/([^\s]+)(?:\s([\s\S]*))?$/.exec(text);
  if (isCodeAgentKind(session?.kind) && match) {
    try {
      const inventory = await invoke('codeagent:skills', { sessionId });
      const available = [...(inventory?.skills || []), ...(inventory?.commands || []).filter(row => row.kind === 'skill')];
      skill = available.find(row => row.name.toLowerCase() === match[1].toLowerCase()) || null;
    } catch { /* An unconfirmed skill is restored as plain text. */ }
  }
  // A skill inventory read may finish after the user changes the active pane.
  if (!input.isConnected || !isCurrent()) { notify('这条消息不属于当前会话', 'warning'); return false; }
  const draft = skills.skillPrompt(input, readText(input), session);
  if (draft.trim()) {
    require('./floating-input-history').createFloatingInputHistory({ storage }).push(sessionId, draft);
    notify('原草稿已存入历史，按 ↑ 找回', 'info');
  }
  replaceText(input, skill ? match[2] || '' : text);
  if (skill) skills.insertSkillTag(input, skill, { document, window, session, focus: false,
    onChange: () => saveDraft(sessionId, input) });
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  saveDraft(sessionId, input); input.focus();
  if (draft.trim()) historyChanged();
  const range = document.createRange(); range.selectNodeContents(input); range.collapse(false);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  return true;
}

module.exports = { editResend, isStoppedUserTurn, rememberStoppedTurn, clearStoppedTurns, STOPPED_PER_SESSION_LIMIT, STOPPED_TOTAL_LIMIT };
