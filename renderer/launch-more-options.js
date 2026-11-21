'use strict';
// 启动中心「更多选项」（2026-11-21「一个 Tab 一屏」）：新建会话面板在 1440×900 下要滚 1036/692，
// 账号、MCP、快速模式、权限模式、工作目录都在首屏外。把次要的几项折成一行摘要，点开再看；
// 字段本身（<select>、分段按钮、取值、change 事件、权限模式的记住上次与恢复默认）一律不动，只是收起时不显示。
// 新用户默认收起；展开 / 收起状态保存在本地，下次打开或重启沿用。
(function launchMoreOptionsModule() {
const STORAGE_KEY = 'hub.launch.moreOptionsOpen.v1';
const SECONDARY = [
  'new-session-company-account-field',
  'new-session-mcp-field',
  'new-session-fast-field',
  'new-session-codex-tier-field',
  'new-session-permission-field',
];

function fieldValue(document, field) {
  const label = (field.querySelector(':scope > span')?.textContent || '').trim();
  const select = field.querySelector('select');
  if (select) {
    const text = (select.selectedOptions?.[0]?.textContent || '').trim();
    if (!text) return null;
    // 只取名称：「· 说明」与括号里的补充放在悬停提示里，摘要一行放得下。
    const name = text.split(' · ')[0].replace(/\s*[（(].*$/, '').trim() || text;
    return { label, text: name };
  }
  const box = field.querySelector('input[type="checkbox"]');
  if (box) return box.checked ? { label, text: '开' } : null;
  return null;
}

// 摘要：每个显示着的次要字段「名称 取值」，用 · 连起来。
function summaryText(document) {
  const parts = [];
  for (const id of SECONDARY) {
    const field = document.getElementById(id);
    if (!field || field.hidden) continue;
    const v = fieldValue(document, field);
    if (v) parts.push(v.label ? `${v.label} ${v.text}` : v.text);
  }
  return parts.join(' · ');
}

function mount({ document, window }) {
  const section = document.getElementById('new-session-config-section');
  const grid = document.getElementById('new-session-tuning');
  if (!section || !grid || document.getElementById('new-session-more-toggle')) return null;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'new-session-more-toggle';
  toggle.className = 'lc-more-toggle';
  toggle.setAttribute('aria-controls', 'new-session-tuning');
  toggle.innerHTML = '<span class="lc-more-label">更多选项</span><span class="lc-more-summary" id="new-session-more-summary"></span><span class="lc-more-chev" aria-hidden="true"></span>';
  grid.after(toggle);
  let open = false;
  try { open = window.localStorage.getItem(STORAGE_KEY) === 'true'; } catch { /* 本地存储不可用时默认收起 */ }

  function paint() {
    const any = SECONDARY.some(id => { const f = document.getElementById(id); return f && !f.hidden; });
    toggle.hidden = !any;
    section.classList.toggle('lc-more-collapsed', any && !open);
    toggle.setAttribute('aria-expanded', String(open));
    const text = summaryText(document);
    const summary = toggle.querySelector('.lc-more-summary');
    if (summary.textContent !== text) summary.textContent = text;
    toggle.title = open ? '收起' : (text || '');
  }
  function setOpen(next) {
    open = !!next;
    try { window.localStorage.setItem(STORAGE_KEY, String(open)); } catch { /* 本次展开 / 收起仍然生效 */ }
    paint();
  }
  // 展开后把这一行滚到可视区底部：刚露出来的几项就在它上面，不用再找。
  toggle.addEventListener('click', () => { setOpen(!open); if (open) { try { toggle.scrollIntoView({ block: 'nearest' }); } catch (_) {} } });
  section.addEventListener('change', paint);
  section.addEventListener('click', () => window.setTimeout(paint, 0));
  new window.MutationObserver(paint).observe(grid, { subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled'], childList: true });
  paint();
  return { paint, expand: () => setOpen(true), collapse: () => setOpen(false), get open() { return open; } };
}

function start({ document, window }) {
  if (!document.getElementById('new-session-config-section') && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => start({ document, window }), { once: true });
    return;
  }
  const api = mount({ document, window });
  if (api) window.__launchMoreOptions = api;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById) start({ document, window });
else if (typeof module !== 'undefined') module.exports = { SECONDARY, summaryText, mount };
})();
