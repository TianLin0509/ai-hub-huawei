'use strict';

// 底栏「用户群」入口（r46，2026-11-18）：VPN/xGate 按钮左侧一个小按钮，点开列出 AI HUB-H 用户群的
// WeLink 群号，一键复制后到 WeLink 搜索框粘贴即可找到群。
// 群号属于公司内部信息；内源统一包只在公司内网分发，2026-11-28 起公开版（统一包）也带本文件。
// 群号只写在 core/welink-user-groups.js 一处（r47 起收件机的一键入群也读它），以后加群只改那里；
// 按显示顺序排列，第一个没满的群标「推荐」；full: true 的群标「已满 500 人」。
const { WELINK_USER_GROUPS } = require('../core/welink-user-groups');

const COPIED_HINT = '已复制，在 WeLink 搜索框粘贴即可找到';
const BUTTON_TITLE = 'AI HUB-H 用户群：点开查看 WeLink 群号，复制后在 WeLink 搜索框粘贴，就能找到群并申请加入';
const PANEL_ID = 'welink-user-groups-panel';

// 弹层挂在 body 上，状态栏心跳重绘按钮时弹层不受影响；按钮的展开状态从这里读，重绘后保持一致。
const state = { open: false };

function listGroups(groups = WELINK_USER_GROUPS) {
  return (Array.isArray(groups) ? groups : [])
    .filter(group => group && /^\d{6,}$/.test(String(group.id || '')) && String(group.name || '').trim())
    .map(group => ({ name: String(group.name).trim(), id: String(group.id), full: group.full === true }));
}

const ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><circle cx="6" cy="5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.8 13c.4-2.4 2.1-3.7 4.2-3.7s3.8 1.3 4.2 3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M10.6 3.2a2.2 2.2 0 0 1 0 4.1M12 9.6c1.2.5 2 1.6 2.2 3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

function userGroupsButtonHtml({ groups = WELINK_USER_GROUPS, open = state.open } = {}) {
  if (!listGroups(groups).length) return '';
  return `<button type="button" class="strip-user-groups" data-welink-user-groups aria-haspopup="dialog" aria-controls="${PANEL_ID}" aria-expanded="${open ? 'true' : 'false'}" title="${BUTTON_TITLE}">${ICON}<span class="strip-user-groups-label">用户群</span></button>`;
}

const STYLE = `
#sidebar-strip .strip-user-groups { display:inline-flex; align-items:center; gap:3px; flex:none; height:22px; padding:0 6px; border:1px solid var(--border-subtle, #d7dde6); border-radius:11px; background:transparent; color:var(--brand, #3478f6); font:500 11px/1 var(--font-sans, 'Microsoft YaHei', sans-serif); white-space:nowrap; cursor:pointer; }
#sidebar-strip .strip-user-groups:hover, #sidebar-strip .strip-user-groups[aria-expanded='true'] { background:var(--brand-tint, #eaf2ff); border-color:var(--brand, #3478f6); }
#sidebar-strip .strip-user-groups:focus-visible { outline:2px solid var(--brand, #3478f6); outline-offset:1px; }
#hub-system-footer[data-density='minimal'] #sidebar-strip .strip-user-groups-label { display:none; }
#hub-system-footer[data-density='minimal'] #sidebar-strip .strip-user-groups { padding:0 5px; }
#${PANEL_ID} { position:fixed; z-index:2200; width:320px; max-width:calc(100vw - 16px); box-sizing:border-box; padding:12px 14px; border:1px solid var(--border-mid, #c9d1dc); border-radius:10px; background:var(--surface-overlay, #fff); color:var(--fg-default, #1f2933); box-shadow:0 8px 26px rgba(20,35,55,.12); font:12px/1.6 var(--font-sans, 'Microsoft YaHei', sans-serif); }
#${PANEL_ID}[hidden] { display:none; }
#${PANEL_ID} .wug-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
#${PANEL_ID} .wug-head strong { font-size:13px; }
#${PANEL_ID} .wug-close { width:22px; height:22px; border:0; border-radius:5px; background:transparent; color:var(--fg-muted, #66707d); font-size:16px; line-height:1; cursor:pointer; }
#${PANEL_ID} .wug-close:hover { background:var(--surface-hover, #eef1f5); }
#${PANEL_ID} .wug-hint { margin:0 0 8px; color:var(--fg-muted, #66707d); }
#${PANEL_ID} .wug-row { display:flex; align-items:center; gap:10px; padding:7px 0; border-top:1px solid var(--border-subtle, #e3e7ee); }
#${PANEL_ID} .wug-main { flex:1; min-width:0; display:flex; flex-direction:column; }
#${PANEL_ID} .wug-name { font-weight:600; }
#${PANEL_ID} .wug-tag { display:inline-block; margin-left:6px; padding:0 5px; border-radius:4px; font-size:10px; font-weight:500; line-height:16px; vertical-align:1px; }
#${PANEL_ID} .wug-tag-recommended { color:var(--brand, #3478f6); background:var(--brand-tint, #eaf2ff); }
#${PANEL_ID} .wug-tag-full { color:var(--fg-muted, #66707d); background:var(--surface-hover, #eef1f5); }
#${PANEL_ID} .wug-row[data-full='true'] .wug-name { color:var(--fg-muted, #66707d); }
#${PANEL_ID} .wug-action[hidden] { display:none; }
#${PANEL_ID} .wug-id { font-family:Consolas, 'Cascadia Mono', monospace; color:var(--fg-muted, #66707d); user-select:all; }
#${PANEL_ID} .wug-copy { flex:none; height:26px; padding:0 10px; border:1px solid var(--brand, #3478f6); border-radius:6px; background:transparent; color:var(--brand, #3478f6); font:inherit; cursor:pointer; }
#${PANEL_ID} .wug-copy:hover { background:var(--brand-tint, #eaf2ff); }
#${PANEL_ID} .wug-status { min-height:18px; margin:6px 0 0; color:var(--status-success, #1a7f37); }
#${PANEL_ID} .wug-status[data-level='error'] { color:var(--status-danger, #c62828); }
`;

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function panelHtml(groups) {
  const recommended = groups.find(group => !group.full);
  return '<div class="wug-head"><strong>AI HUB-H 用户群</strong><button type="button" class="wug-close" data-wug-close aria-label="关闭">×</button></div>'
    + '<p class="wug-hint">在 WeLink 搜索框粘贴群号，即可找到群、申请加入；使用中的问题可在群里交流。</p>'
    + groups.map(group => {
      const tag = group.full ? '<span class="wug-tag wug-tag-full">已满 500 人</span>'
        : group === recommended ? '<span class="wug-tag wug-tag-recommended">推荐</span>' : '';
      // data-wug-action：每行预留的操作位（下一轮「一键入群」放这里），本轮为空且隐藏。
      return `<div class="wug-row" data-wug-group="${escapeText(group.id)}"${group.full ? ' data-full="true"' : ''}><span class="wug-main"><span class="wug-name">${escapeText(group.name)}${tag}</span><span class="wug-id">${escapeText(group.id)}</span></span>`
        + `<span class="wug-action" data-wug-action hidden></span>`
        + `<button type="button" class="wug-copy" data-wug-copy="${escapeText(group.id)}" title="复制 ${escapeText(group.name)} 的群号">复制群号</button></div>`;
    }).join('')
    + '<p class="wug-status" data-wug-status role="status" aria-live="polite"></p>';
}

function attachWelinkUserGroups({ document: doc, clipboard, groups = WELINK_USER_GROUPS, onOpen } = {}) {
  const list = listGroups(groups);
  const strip = doc && doc.getElementById('sidebar-strip');
  if (!strip || !list.length || doc.getElementById(PANEL_ID)) return null;
  const style = doc.createElement('style');
  style.id = 'welink-user-groups-style'; style.textContent = STYLE;
  doc.head.appendChild(style);
  const panel = doc.createElement('section');
  panel.id = PANEL_ID; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'AI HUB-H 用户群');
  panel.innerHTML = panelHtml(list);
  doc.body.appendChild(panel);
  const status = panel.querySelector('[data-wug-status]');
  const button = () => strip.querySelector('[data-welink-user-groups]');
  const syncButton = () => button()?.setAttribute('aria-expanded', state.open ? 'true' : 'false');

  function position() {
    if (panel.hidden) return;
    const rect = (button() || strip).getBoundingClientRect();
    const width = doc.documentElement.clientWidth;
    panel.style.left = `${Math.max(8, Math.min(rect.left, width - panel.offsetWidth - 8))}px`;
    panel.style.bottom = `${Math.max(8, doc.documentElement.clientHeight - rect.top + 6)}px`;
  }
  function open() {
    onOpen?.();
    state.open = true; panel.hidden = false; status.textContent = ''; delete status.dataset.level;
    syncButton(); position();
  }
  function close() {
    if (!state.open) return;
    state.open = false; panel.hidden = true; syncButton();
  }
  async function copy(id) {
    try {
      await Promise.resolve(clipboard.writeText(id));
      status.textContent = COPIED_HINT; delete status.dataset.level;
    } catch (error) {
      status.textContent = `复制失败（${error && error.message || '剪贴板不可用'}），请手动选中群号复制`;
      status.dataset.level = 'error';
    }
  }

  strip.addEventListener('click', event => {
    if (!event.target.closest?.('[data-welink-user-groups]')) return;
    event.preventDefault();
    if (state.open) close(); else open();
  });
  panel.addEventListener('click', event => {
    if (event.target.closest('[data-wug-close]')) { close(); button()?.focus(); return; }
    const target = event.target.closest('[data-wug-copy]');
    if (target) void copy(target.dataset.wugCopy);
  });
  doc.addEventListener('pointerdown', event => {
    if (state.open && !panel.contains(event.target) && !event.target.closest?.('[data-welink-user-groups]')) close();
  }, true);
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && state.open) { close(); button()?.focus(); } });
  doc.defaultView?.addEventListener('resize', position);
  return { open, close, isOpen: () => state.open, panel };
}

module.exports = { WELINK_USER_GROUPS, COPIED_HINT, BUTTON_TITLE, listGroups, userGroupsButtonHtml, attachWelinkUserGroups, _state: state };
