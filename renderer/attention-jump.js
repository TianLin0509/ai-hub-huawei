'use strict';
// 「待你看」：多开几个会话时，不用挨个点开看谁答完了、谁在等你。侧栏顶上写明有几个，点一下（或 Ctrl+J）跳到下一个；
// 要你回复的排在前面，同类里等得最久的先看。只读现有状态，不改会话。
const { attentionStateOf, sessionHasCompletedUnread, ATTENTION_NEEDS_INPUT } = require('../core/session-attention-state.js');
const { getSessionRuntimeTruth, RUNTIME_WAITING } = require('../core/session-runtime-truth.js');
const { latestActivityTime } = require('../core/session-recency.js');

function attentionQueue(list) {
  const rows = [];
  for (const s of list || []) {
    if (!s || s.hiddenFromSidebar || s.purpose) continue;
    // 和侧栏同一套判断：等你回复看运行状态，有新结果看未读。
    let needsInput = false, ready = false;
    try {
      needsInput = attentionStateOf(s) === ATTENTION_NEEDS_INPUT || getSessionRuntimeTruth(s, { now: Date.now() }).state === RUNTIME_WAITING;
      ready = sessionHasCompletedUnread(s);
    } catch { continue; }
    if (!needsInput && !ready) continue;
    rows.push({ session: s, needsInput, at: latestActivityTime(s) || 0 });
  }
  rows.sort((a, b) => (Number(b.needsInput) - Number(a.needsInput)) || (a.at - b.at));
  return rows;
}

// 下一个要看的：当前打开的这个不算（已经在看了）。
function nextTarget(queue, activeId) {
  const row = queue.find(item => item.session.id !== activeId);
  return row ? row.session : null;
}

function summary(queue) {
  const input = queue.filter(row => row.needsInput).length, ready = queue.length - input;
  const parts = [];
  if (input) parts.push(`${input} 个要你回复`);
  if (ready) parts.push(`${ready} 个有新结果`);
  return parts.join('，');
}

function mount({ document: doc, getSessions, getActiveSessionId, selectSession, intervalMs = 2000 }) {
  const bar = doc.querySelector('.session-detail-bar');
  if (!bar) return null;
  const button = doc.createElement('button');
  button.type = 'button';
  button.id = 'attention-jump';
  button.className = 'attention-jump';
  button.hidden = true;
  bar.append(button);
  let queue = [];
  function refresh() {
    const activeId = getActiveSessionId();
    queue = attentionQueue([...getSessions().values()]).filter(row => row.session.id !== activeId);
    const text = queue.length ? `待你看 ${queue.length}` : '';
    if (button.textContent !== text) button.textContent = text;
    button.hidden = !queue.length;
    const title = queue.length ? `${summary(queue)}。点一下跳到下一个（Ctrl+J）` : '';
    if (button.title !== title) button.title = title;
  }
  function jump() {
    refresh();
    const target = nextTarget(queue, getActiveSessionId());
    if (target) selectSession(target.id);
    return !!target;
  }
  button.addEventListener('click', jump);
  doc.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && (event.key === 'j' || event.key === 'J')) { event.preventDefault(); event.stopPropagation(); jump(); }
  }, true);
  setInterval(refresh, intervalMs).unref?.();
  refresh();
  return { refresh, jump };
}

module.exports = { attentionQueue, nextTarget, summary, mount };
