'use strict';
// 更新日志（设置菜单「更新日志」）与「刚更新完」的提示：升级后第一次打开，右下角列出这次多了什么，主页顶部留一条入口，看过就收起。
// 数据是程序自带的 core/app-update/release-history.json，不联网。新装的电脑不提示，只有真的从旧版本升上来才提示。
(() => {
  const distribution = require('../core/distribution');
  if (!distribution.updateConfig) return;
  const { loadHistory, entriesSince } = require('../core/app-update/release-history');
  const SEEN_KEY = 'hub:whatsNew:lastSeenVersion';
  const NOTICE_MS = 30000;
  const current = String(distribution.editionVersion || '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const read = () => { try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; } };
  const write = value => { try { localStorage.setItem(SEEN_KEY, value); } catch {} };
  const shortDate = date => (date ? date.slice(5) : '');
  const entries = loadHistory();
  let dialog = null, notice = null, banner = null, noticeTimer = null;
  // 现在就算好：一键更新的结果提示比页面准备好更早来问。
  const lastSeen = read();
  let unread = lastSeen ? entriesSince(entries, lastSeen, current) : [];

  function injectStyle() {
    if (document.getElementById('whats-new-style')) return;
    const link = Object.assign(document.createElement('link'), { id: 'whats-new-style', rel: 'stylesheet', href: 'styles/whats-new.css' });
    const controls = document.getElementById('controls-layer');
    if (controls) controls.before(link); else document.head.append(link);
  }

  function hideNotice() { clearTimeout(noticeTimer); notice?.remove(); notice = null; }

  function clearUnread() {
    write(current);
    unread = [];
    banner?.remove(); banner = null;
    hideNotice();
  }

  function entryHtml(entry, isNew) {
    return `<section class="wn-entry${isNew ? ' is-new' : ''}"><header><b>v${esc(entry.version)}</b>`
      + `${isNew ? '<span class="wn-tag">本次新增</span>' : ''}<time>${esc(shortDate(entry.date))}</time></header>`
      + `<ul>${entry.notes.map(note => `<li>${esc(note)}</li>`).join('')}</ul></section>`;
  }

  function openDialog() {
    injectStyle();
    const isNew = new Set(unread.map(e => e.version));
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'app-update-dialog whats-new-dialog';
      dialog.addEventListener('click', event => {
        if (event.target === dialog || event.target.closest('[data-wn="close"]')) dialog.close();
      });
      dialog.addEventListener('close', () => { dialog.remove(); dialog = null; clearUnread(); });
      document.body.appendChild(dialog);
    }
    const body = entries.length ? entries.map(e => entryHtml(e, isNew.has(e.version))).join('') : '<p class="wn-empty">这个版本没有带更新日志。</p>';
    dialog.innerHTML = '<div class="au-head"><div class="au-title"><strong>更新日志</strong>'
      + `<span>当前 v${esc(current)}${isNew.size ? ` · 这次升级带来 ${isNew.size} 个版本的改动` : ''}</span></div>`
      + '<button type="button" class="au-close" data-wn="close" aria-label="关闭">×</button></div>'
      + `<div class="au-body wn-body">${body}</div>`
      + '<div class="au-foot"><button type="button" class="au-btn primary" data-wn="close">知道了</button></div>';
    if (!dialog.open) dialog.showModal();
  }

  // 右下角的提示：不抢焦点、不挡操作，30 秒后自己收起（主页那条还在），鼠标放上去时不收。
  function showNotice() {
    if (notice || !unread.length) return;
    injectStyle();
    const notes = unread.flatMap(e => e.notes);
    notice = document.createElement('aside');
    notice.className = 'wn-notice';
    notice.setAttribute('role', 'status');
    notice.innerHTML = `<strong>已更新到 v${esc(current)}</strong><ul>${notes.slice(0, 3).map(n => `<li>${esc(n)}</li>`).join('')}</ul>`
      + `<div class="wn-notice-foot">${notes.length > 3 ? `<span>还有 ${notes.length - 3} 条</span>` : '<span></span>'}`
      + '<button type="button" data-wn="later">知道了</button><button type="button" class="primary" data-wn="open">看全部</button></div>';
    notice.addEventListener('click', event => {
      const action = event.target.closest('[data-wn]')?.dataset.wn;
      if (action === 'open') openDialog();
      else if (action === 'later') clearUnread();
    });
    noticeTimer = setTimeout(hideNotice, NOTICE_MS);
    notice.addEventListener('mouseenter', () => clearTimeout(noticeTimer));
    notice.addEventListener('mouseleave', () => { noticeTimer = setTimeout(hideNotice, NOTICE_MS); });
    document.body.appendChild(notice);
  }

  function showBanner() {
    if (banner || !unread.length) return;
    const host = document.querySelector('.home-welcome-body');
    if (!host) return;
    injectStyle();
    banner = document.createElement('button');
    banner.type = 'button';
    banner.className = 'wn-banner';
    banner.id = 'whats-new-banner';
    const first = unread[0].notes[0] || '';
    banner.innerHTML = `<span class="wn-tag">v${esc(current)} 新变化</span><span class="wn-banner-text">${esc(first)}</span><span class="wn-banner-more">看全部 ›</span>`;
    banner.addEventListener('click', openDialog);
    host.prepend(banner);
  }

  function addMenuEntry() {
    const menu = document.getElementById('options-menu');
    if (!menu || document.getElementById('options-whats-new')) return;
    const item = document.createElement('div');
    item.className = 'options-item'; item.id = 'options-whats-new'; item.textContent = '📝 更新日志';
    item.addEventListener('click', () => { menu.style.display = 'none'; openDialog(); });
    const update = document.getElementById('options-check-update');
    if (update) update.after(item); else menu.appendChild(item);
  }

  function start() {
    addMenuEntry();
    // 新装，或升上来了但这几个版本没有日志（比如日志文件读不到）：记下当前版本，不提示。
    if (!unread.length) { if (lastSeen !== current) write(current); return; }
    showBanner();
    showNotice();
  }

  // 一键更新的结果提示用：有日志就由这里说，那边不再单独弹「已更新」。
  window.__whatsNew = { open: openDialog, hasUnread: () => unread.length > 0 };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
