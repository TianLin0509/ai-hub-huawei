'use strict';
// 主页「接着做」：打开 Hub 第一眼就能回到最近的工作。侧栏默认只显示今天的会话，昨天没做完的要点「3 天」才找得到。
// 只读现有会话数据，点一下走和侧栏一样的选中流程（休眠的会话会自动唤醒）。
const { latestActivityTime } = require('../core/session-recency.js');
const { sessionRuntimeIsActive } = require('../core/session-runtime-truth.js');

const LIMIT = 4;
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

function recentSessions(list, now = Date.now(), limit = LIMIT) {
  return (list || [])
    .filter(s => s && !s.hiddenFromSidebar && !s.purpose && s.kind !== 'powershell')
    .map(s => ({ session: s, at: latestActivityTime(s) }))
    .filter(row => row.at && now - row.at < MAX_AGE_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(row => row.session);
}

function relativeTime(at, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '昨天' : `${days} 天前`;
}

function folderName(cwd) {
  const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

function statusOf(s) {
  if (s.status === 'dormant') return { key: 'dormant', text: '已休眠，点开接着做' };
  if (s.waitingText) return { key: 'waiting', text: s.waitingText };
  if (sessionRuntimeIsActive(s)) return { key: 'running', text: '工作中' };
  return { key: 'idle', text: '' };
}

function rowView(s, now = Date.now()) {
  const status = statusOf(s);
  return {
    id: s.id,
    title: String(s.title || s.name || s.kind || '未命名会话'),
    folder: folderName(s.cwd),
    when: relativeTime(latestActivityTime(s), now),
    statusKey: status.key,
    statusText: status.text,
  };
}

function greeting(date = new Date()) {
  const week = '日一二三四五六'[date.getDay()];
  const hour = date.getHours();
  const part = hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 周${week} · ${part}`;
}

function mount({ document: doc, getSessions, selectSession, escapeHtml }) {
  const host = doc.querySelector('.home-welcome-body');
  if (!host) return null;
  const eyebrow = host.querySelector('.home-welcome-eyebrow');
  const section = doc.createElement('section');
  section.className = 'home-recent';
  section.id = 'home-recent';
  section.setAttribute('aria-label', '接着做');
  section.hidden = true;
  const portals = host.querySelector('.home-welcome-portals');
  if (portals) portals.after(section); else host.append(section);
  let lastHtml = '';
  function render() {
    if (eyebrow) eyebrow.textContent = greeting();
    const rows = recentSessions([...getSessions().values()]).map(s => rowView(s));
    section.hidden = !rows.length;
    const html = !rows.length ? '' : '<h2>接着做</h2><div class="home-recent-list">' + rows.map(row =>
      `<button type="button" class="home-recent-row" data-session="${escapeHtml(row.id)}" data-state="${row.statusKey}">`
      + '<span class="home-recent-dot" aria-hidden="true"></span>'
      + `<span class="home-recent-title">${escapeHtml(row.title)}</span>`
      + (row.statusText ? `<span class="home-recent-state">${escapeHtml(row.statusText)}</span>` : '')
      + `<span class="home-recent-meta">${row.folder ? escapeHtml(row.folder) + ' · ' : ''}${escapeHtml(row.when)}</span>`
      + '</button>').join('') + '</div>';
    if (html !== lastHtml) { section.innerHTML = html; lastHtml = html; }
  }
  section.addEventListener('click', event => {
    const row = event.target.closest('[data-session]');
    if (row) selectSession(row.dataset.session);
  });
  const panel = doc.getElementById('terminal-panel');
  const visible = () => !!panel && panel.classList.contains('home-active');
  if (panel) new (doc.defaultView.MutationObserver)(() => { if (visible()) render(); }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  // 主页开着时，相对时间和状态每分钟刷新一次；不在主页时什么都不做。
  setInterval(() => { if (visible()) render(); }, 60000).unref?.();
  render();
  // 启动时会话列表还在恢复，上面这次可能是空的；恢复通常几秒内完成，再补画几次。
  for (const ms of [1500, 4000, 10000]) setTimeout(() => { if (visible()) render(); }, ms).unref?.();
  return { render };
}

module.exports = { recentSessions, relativeTime, folderName, rowView, greeting, mount, LIMIT };
