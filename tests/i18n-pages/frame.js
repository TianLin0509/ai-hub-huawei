'use strict';
// frame 组（主界面框架）的英文截图界面：侧栏、底栏、快捷键表、命令面板、设置菜单、工具栏更多、会话卡片与右键菜单。
// 隔离 Hub 里没有会话：frame-session 在界面进程本地派发一次 session-created（不经主进程、不启动 CLI），
// 让会话列表、模型/推理标签、输入框工具栏和右键菜单有东西可截。
const key = (k, extra = '') => `document.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', ctrlKey: true, bubbles: true, cancelable: true${extra} }))`;
const click = sel => `document.querySelector(${JSON.stringify(sel)})?.click()`;
const esc = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`;
const FAKE = `{ id: 'i18n-frame-fake', kind: 'claude', title: 'i18n sample session', status: 'idle', cwd: 'D:\\\\AIWork\\\\sample', createdAt: Date.now(), lastMessageTime: Date.now(), unreadCount: 2 }`;
const fakeSession = `(() => { const { ipcRenderer } = require('electron'); ipcRenderer.emit('session-created', {}, { session: ${FAKE} }); return 'ok'; })()`;
const rightClick = sel => `(() => { const row = document.querySelector(${JSON.stringify(sel)}); if (!row) return 'none'; const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10 })); return 'ok'; })()`;

module.exports = {
  'frame-shortcuts': { open: key('/'), wait: 800, close: `document.querySelector('.shortcut-help-dialog')?.close()` },
  'frame-cmdk': { open: key('k'), wait: 900, close: `${key('k')}` },
  'frame-options': { open: click('#btn-options'), wait: 600, close: `(() => { const m = document.getElementById('options-menu'); if (m) m.style.display = 'none'; })()` },
  'frame-footer': { open: `(() => { const b = document.getElementById('footer-status-details'); if (b) { b.style.display = 'inline-flex'; b.hidden = false; b.click(); } })()`, wait: 1000, close: `(() => { const p = document.getElementById('footer-status-popover'); if (p) p.hidden = true; })()` },
  'frame-insights': { open: click('#sidebar-insights-toggle'), wait: 800, close: click('#sidebar-insights-toggle') },
  'frame-session': { open: `${fakeSession}; setTimeout(() => document.querySelector('.session-item.slim:not(.meeting):not(.resident-placeholder)')?.click(), 600)`, wait: 3500 },
  'frame-toolbar-more': { open: click('#btn-toolbar-more'), wait: 600, close: esc },
  'frame-ctxmenu': { open: rightClick('.session-item.slim:not(.meeting):not(.resident-placeholder)'), wait: 700, close: esc },
};
