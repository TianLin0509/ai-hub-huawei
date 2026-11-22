'use strict';
// 「待你看」：多开几个会话时，不用挨个点开看谁答完了、谁在等你。侧栏顶上写明有几个，点一下（或 Ctrl+J）跳到下一个；
// 要你回复的排在前面，同类里等得最久的先看。只读现有状态，不改会话。
const { attentionStateOf, sessionHasCompletedUnread, ATTENTION_NEEDS_INPUT } = require('../core/session-attention-state.js');
const { getSessionRuntimeTruth, RUNTIME_WAITING } = require('../core/session-runtime-truth.js');
const { latestActivityTime } = require('../core/session-recency.js');

const { sessionRuntimeIssue } = require('../core/session-runtime-issue.js');

// 每个会话自己的状态：等你回复看运行状态，有新结果看未读（和侧栏同一套判断）。
function ownState(s) {
  const needsInput = attentionStateOf(s) === ATTENTION_NEEDS_INPUT || getSessionRuntimeTruth(s, { now: Date.now() }).state === RUNTIME_WAITING;
  return { needsInput, ready: sessionHasCompletedUnread(s) };
}

// 负责人的子会话（组队成员、「创建子会话」建的子会话）不单独进「待你看」（2026-11-22：用户更关心负责人自己的进度）。
// 成员的新回复不计；成员等你拍板或出错卡住，汇总到负责人那一条（每位负责人只占一条），点它跳到负责人，成员行在它下面。
// leadOf(id) 返回该会话所属负责人的 id，不是成员返回 null。
function attentionQueue(list, { leadOf = null } = {}) {
  const visible = s => !!s && !s.hiddenFromSidebar && !s.purpose;
  const sessions = list || [];
  const byId = new Map(sessions.map(s => [s && s.id, s]));
  const rows = [];
  const rowOf = new Map();
  const escalations = new Map();
  for (const s of sessions) {
    if (!visible(s)) continue;
    let st;
    try { st = ownState(s); } catch { continue; }
    const at = latestActivityTime(s) || 0;
    const lead = typeof leadOf === 'function' ? leadOf(s.id) : null;
    if (lead && lead !== s.id) {
      if (s.status === 'dormant') continue;
      let issue = null;
      try { issue = sessionRuntimeIssue(s); } catch {}
      const reason = st.needsInput ? '等你拍板' : issue ? (issue.label || '出错卡住') : '';
      if (reason) {
        if (!escalations.has(lead)) escalations.set(lead, []);
        escalations.get(lead).push({ session: s, reason, at });
      }
      continue;
    }
    if (!st.needsInput && !st.ready) continue;
    const row = { session: s, needsInput: st.needsInput, at, memberAlerts: [] };
    rows.push(row); rowOf.set(s.id, row);
  }
  for (const [leadId, alerts] of escalations) {
    let row = rowOf.get(leadId);
    const leadSession = byId.get(leadId);
    if (!row && visible(leadSession)) {
      row = { session: leadSession, needsInput: true, at: Math.min(...alerts.map(a => a.at)), memberAlerts: [] };
      rows.push(row); rowOf.set(leadId, row);
    }
    if (row) { row.needsInput = true; row.memberAlerts.push(...alerts); continue; }
    // 负责人本身不在侧栏（被隐藏或已关闭）：成员的拍板/出错不能因此丢，退回成员自己那一条。
    for (const a of alerts) rows.push({ session: a.session, needsInput: true, at: a.at, memberAlerts: [] });
  }
  rows.sort((a, b) => (Number(b.needsInput) - Number(a.needsInput)) || (a.at - b.at));
  return rows;
}

// 由组队界面（renderer/team-ui.js）算出「成员 → 负责人」对照，每次刷新算一次。
function leadMapFrom(teamUi, sessionMap, meetings) {
  const map = new Map();
  if (!teamUi || typeof teamUi.isLead !== 'function' || typeof teamUi.membersOf !== 'function') return map;
  for (const id of sessionMap.keys()) {
    if (!teamUi.isLead(id)) continue;
    for (const member of teamUi.membersOf(id, sessionMap, meetings) || []) if (member !== id) map.set(member, id);
  }
  return map;
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
  const alerts = queue.filter(row => row.memberAlerts && row.memberAlerts.length).map(row =>
    `${row.session.title || '负责人'}：${row.memberAlerts.map(a => `${a.session.title || '成员'}${a.reason}`).join('、')}`);
  return parts.join('，') + (alerts.length ? `（${alerts.join('；')}）` : '');
}

function mount({ document: doc, getSessions, getActiveSessionId, selectSession, getLeadMap = null, intervalMs = 2000 }) {
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
    let leads = null;
    try { leads = typeof getLeadMap === 'function' ? getLeadMap() : null; } catch { leads = null; }
    queue = attentionQueue([...getSessions().values()], { leadOf: leads ? id => leads.get(id) || null : null })
      .filter(row => row.session.id !== activeId);
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

module.exports = { attentionQueue, leadMapFrom, nextTarget, summary, mount };
