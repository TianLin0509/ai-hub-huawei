'use strict';
// 「放行下载服务器」的界面（2026-11-07）：检查更新弹窗和一键安装弹窗共用。状态与动作在主进程 core/net-pass.js。
// 两台下载服务器（高速镜像、旧阿里云）合成一个按钮：点一次，后台逐台放行。新用户还没放行时显示提醒。
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
.np-box { margin: 10px 0; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border-subtle, #e3e1ea); background: var(--surface-sunken, #f6f5fa); font-size: 13px; line-height: 1.6; }
.np-box.np-need { border-color: rgba(52, 120, 246, .45); background: rgba(52, 120, 246, .07); }
.np-box b { display: block; margin-bottom: 2px; }
.np-box ul { margin: 6px 0; padding: 0; list-style: none; }
.np-box li { display: flex; gap: 8px; align-items: center; }
.np-box li .np-name { min-width: 84px; }
.np-box li .np-st { color: var(--fg-muted, #6b7080); }
.np-box li.np-ok .np-st { color: #2f8f4e; }
.np-box li.np-blocked .np-st { color: #c25b12; }
.np-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.np-actions button { font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 7px; border: 1px solid var(--border-subtle, #d9d7e2); background: var(--surface-raised, #fff); color: inherit; cursor: pointer; }
.np-actions button.primary { background: #3478f6; border-color: #3478f6; color: #fff; }
.np-actions button:disabled { opacity: .55; cursor: default; }
.np-line { margin: 8px 0 0; font-size: 12px; color: var(--fg-muted, #6b7080); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.np-line button { font: inherit; font-size: 12px; padding: 1px 8px; border-radius: 6px; border: 1px solid var(--border-subtle, #d9d7e2); background: transparent; color: inherit; cursor: pointer; }
`;

const STATE_TEXT = { ok: '可以访问', blocked: '被公司网络拦截，需要放行', checking: '检查中…', unknown: '还没检查' };
function hostText(h) { return h.state === 'error' ? (h.reason || '连不上') : STATE_TEXT[h.state] || ''; }

// status：core/net-pass.js status() 的结果；last：上一次 passAll 的结果（可空）；compact：都能访问时只显示一行。
function boxHtml(status, { last = null, compact = true } = {}) {
  if (!status || !status.available || !Array.isArray(status.hosts) || !status.hosts.length) return '';
  const serverWord = status.hosts.some(h => h.bridge) ? '服务器' : '下载服务器';
  const running = !!status.running;
  const rows = status.hosts.map(h => `<li class="np-${esc(h.state)}"><span class="np-name">${esc(h.name)}</span><span class="np-st">${esc(hostText(h))}</span></li>`).join('');
  const stillBlocked = last && Array.isArray(last.results) ? last.results.filter(r => r.result === 'blocked') : [];
  const runBtn = `<button type="button" class="primary" data-np="run"${running ? ' disabled' : ''}>${running ? '正在放行…' : '放行' + serverWord}</button>`;
  if (!status.needed && !stillBlocked.length) {
    if (!compact) return `<div class="np-box"><b>${serverWord}</b><ul>${rows}</ul><div class="np-actions">${runBtn}</div></div>`;
    const names = status.hosts.map(h => `${esc(h.name)}：${esc(hostText(h))}`).join(' · ');
    return `<p class="np-line">${serverWord} ${names}<button type="button" data-np="run"${running ? ' disabled' : ''}>${running ? '正在放行…' : '重新放行'}</button></p>`;
  }
  const manual = stillBlocked.length
    ? `<p>还有没放行的，点下面的按钮会在 Hub 里打开放行页，点「继续访问」或「接受」即可，放行后窗口自动关闭核对一次。</p><div class="np-actions">${stillBlocked
      .map(r => `<button type="button" data-np="open" data-page="${esc(r.page)}">打开放行页「${esc(r.name)}」</button>`).join('')}</div>` : '';
  return `<div class="np-box np-need" data-np-box><b>第一次使用请先放行${serverWord}</b>`
    + `公司网络对新网站要先确认一次，没放行时${status.hosts.some(h => h.bridge) ? '下载或通道连接' : '下载'}会很慢或失败。点下面的按钮，Hub 会在后台把 ${status.hosts.length} 台${serverWord}一起放行，只需点一次。`
    + `<ul>${rows}</ul><div class="np-actions">${runBtn}</div>${manual}</div>`;
}

let cssDone = false;
function ensureCss(doc = document) {
  if (cssDone || !doc || !doc.head) return;
  const style = doc.createElement('style'); style.textContent = CSS; doc.head.appendChild(style); cssDone = true;
}

// 绑定按钮：放行完成后调用 onUpdate(status, last) 让调用方重画。
function bind(root, { ipcRenderer, onUpdate = () => {} }) {
  if (!root || root.dataset.npBound) return;
  root.dataset.npBound = '1';
  root.addEventListener('click', async event => {
    const button = event.target.closest && event.target.closest('[data-np]');
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    if (button.dataset.np === 'run') {
      button.disabled = true; button.textContent = '正在放行…';
      let result = null;
      try { result = await ipcRenderer.invoke('net-pass:run'); } catch (_) { result = null; }
      onUpdate(result, result);
    } else if (button.dataset.np === 'open') {
      let opened = null;
      try { opened = await ipcRenderer.invoke('net-pass:open-window', button.dataset.page); } catch (_) {}
      if (opened && opened.status) onUpdate(opened.status, null);
    }
  });
}

module.exports = { CSS, boxHtml, bind, ensureCss, hostText };
