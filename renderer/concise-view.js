'use strict';
// 「简洁」开关（来源 5e462a33 的 concise-view 部分）：默认关，打开后卡片里只看你和 Agent 的对话，
// 隐藏团队消息（组队开工、成员回执、返工叫回）；「无新进展」回合在 HUB-H 本来就一直不占位置（renderer/team-ui.css），这里的规则只是兜底；关着时这些消息照常显示，相邻的合成一行（renderer/notice-groups.js）。
// HUB-H 默认关：同事第一次组队要看得到成员在回话，相邻合并成一行已够省地方。
// 按会话记住打开的那些；用一张生成的样式表按 data-session-id 生效，分屏和重新渲染的卡片都不用单独处理。
// 规则表第一条的选择器同时是 notice-groups 判断「哪些卡被藏掉」的依据，改选择器时两边一起看。
const STORAGE_KEY = 'hub.conciseView.onSessions.v1';

function createConciseView({ document, storage, getSession, isRelevant = () => true }) {
  let on;
  try { on = new Set(JSON.parse(storage.getItem(STORAGE_KEY) || '[]')); } catch { on = new Set(); }
  const style = document.createElement('style'); style.id = 'concise-view-rules'; document.head.appendChild(style);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-zoom concise-toggle'; button.textContent = '简洁'; button.hidden = true;
  button.title = '打开时只看你和 Agent 的对话，隐藏 Agent 之间的消息和无新进展的回合';
  const quote = id => String(id).replace(/["\\]/g, '\\$&');
  function paint() {
    // 只作用于打开了「简洁」的会话的卡片（带 data-session-id）；一个都没开时第一条是不命中任何卡片的占位规则。
    const sel = [...on].flatMap(id => [`.turn-card[data-session-id="${quote(id)}"].team-notice`, `.turn-card[data-session-id="${quote(id)}"].no-update`]).join(',');
    style.textContent = `${sel || '.turn-card.concise-view-none'}{display:none}`
      + '.concise-toggle{white-space:nowrap;flex:none;width:auto;padding:0 8px}.concise-toggle[aria-pressed="true"]{color:var(--hw-brand,#3478f6);border-color:var(--hw-brand,#3478f6)}';
  }
  function sync(visible, area) {
    const session = getSession();
    // 只在用得上的会话里出现（组队的负责人或成员，或卡片里已有团队消息、无新进展）：普通会话不多占顶栏宽度。
    button.hidden = !visible || !session || !isRelevant(session);
    if (session) button.setAttribute('aria-pressed', String(on.has(session.id)));
    // 放在「问一下」后面；没有「问一下」时放在顶栏操作区最前。顶栏重绘后补回来。
    const anchor = area.querySelector(':scope > .ask-entry');
    if (anchor) { if (anchor.nextSibling !== button) anchor.after(button); }
    else if (area.firstChild !== button) area.insertBefore(button, area.firstChild);
  }
  button.onclick = () => {
    const session = getSession(); if (!session) return;
    if (on.has(session.id)) on.delete(session.id); else on.add(session.id);
    try { storage.setItem(STORAGE_KEY, JSON.stringify([...on])); } catch {}
    button.setAttribute('aria-pressed', String(on.has(session.id)));
    paint();
    // 可见的卡片变了，相邻消息的分组要重算（renderer/notice-groups.js 监听）。
    try { document.dispatchEvent(new (document.defaultView?.CustomEvent || CustomEvent)('hub:concise-changed')); } catch {}
  };
  paint();
  return { sync, button, isOn: id => on.has(id) };
}

function mountConciseView(win = typeof window !== 'undefined' ? window : null) {
  if (!win || win.__conciseView) return win && win.__conciseView;
  const area = win.document?.getElementById?.('toolbar-actions');
  if (!area || typeof win.MutationObserver !== 'function') return null;
  /* global sessions, sessionSplit, activeSessionId, currentAppToolbarView */
  const current = () => { try { return sessions.get((typeof sessionSplit !== 'undefined' && sessionSplit?.focusedId()) || activeSessionId) || null; } catch { return null; } };
  const visible = () => { try { return !!activeSessionId && !(typeof currentAppToolbarView === 'function' && currentAppToolbarView()); } catch { return false; } };
  const relevant = session => {
    try {
      const team = win.__teamUi;
      if (team?.isLead?.(session.id) || team?.memberInfo?.(session.id)) return true;
      const sel = `.msg-overlay > .turn-card.team-notice[data-session-id="${win.CSS?.escape ? win.CSS.escape(session.id) : session.id}"]`;
      return !!win.document.querySelector(sel) || !!win.document.querySelector(sel.replace('.team-notice', '.no-update'));
    } catch { return false; }
  };
  const ui = createConciseView({ document: win.document, storage: win.localStorage, getSession: current, isRelevant: relevant });
  let queued = false;
  new win.MutationObserver(() => {
    if (queued) return; queued = true;
    win.requestAnimationFrame(() => { queued = false; ui.sync(visible(), area); });
  }).observe(area, { childList: true });
  // 卡片挂上来后（notice-groups 每批重算时调用）再判断一次要不要出现。
  ui.refresh = () => { if (queued) return; queued = true; win.requestAnimationFrame(() => { queued = false; ui.sync(visible(), area); }); };
  ui.sync(visible(), area); win.__conciseView = ui; return ui;
}
module.exports = { createConciseView, mountConciseView, STORAGE_KEY };
