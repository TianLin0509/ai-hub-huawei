'use strict';
// CodeAgent 版本过旧提醒（2026-10-27，公司版）：启动后在后台查一次本机 CodeAgent 版本，低于门槛就弹窗说明
// 「卡片视图可能显示不出回答」和两种升级办法。「以后再说」3 天内不再弹；升级后版本达标自然不再出现。
// 门槛与依据见 core/codeagent-version-check.js；查版本、开升级窗口在主进程 main/ipc/session-handlers.js。
(() => {
  const distribution = require('../core/distribution');
  if (!distribution.kindAllowed('codeagent')) return;
  const { ipcRenderer, shell } = require('electron');
  const SNOOZE_KEY = 'hub:codeagentUpgradeSnooze';
  const SNOOZE_MS = 3 * 24 * 3600 * 1000;
  const DELAY_MS = 12000;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const css = `
  .cav-dialog { position: fixed; inset: 0; margin: auto; height: fit-content; max-height: calc(100vh - 48px); overflow: auto; width: min(520px, calc(100vw - 48px)); padding: 0; border: 1px solid var(--border-subtle, #e3e1ea); border-radius: 14px;
    background: var(--surface-raised, #fff); color: var(--fg-default, #1f2330); box-shadow: 0 24px 60px rgba(30, 24, 60, .22); font: inherit; }
  .cav-dialog::backdrop { background: rgba(24, 20, 40, .38); }
  .cav-head { padding: 18px 20px 6px; font-size: 15px; font-weight: 600; }
  .cav-body { padding: 0 20px 4px; font-size: 13px; line-height: 1.65; }
  .cav-body p { margin: 6px 0; }
  .cav-body ol { margin: 6px 0; padding-left: 20px; }
  .cav-body code { padding: 1px 5px; border-radius: 4px; background: var(--surface-sunken, #f6f5fa); font-family: Consolas, monospace; }
  .cav-ver { display: inline-block; padding: 8px 12px; margin: 4px 0 6px; border-radius: 8px; background: var(--surface-sunken, #f6f5fa); }
  .cav-msg { margin-top: 8px; color: var(--fg-muted, #6b7080); }
  .cav-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 18px; }
  .cav-btn { padding: 7px 16px; border-radius: 8px; border: 1px solid var(--border-subtle, #dcd9e6); background: var(--surface-raised, #fff); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
  .cav-btn:hover { background: var(--surface-sunken, #f6f5fa); }
  .cav-btn.primary { background: var(--brand, #8b5cf6); border-color: var(--brand, #8b5cf6); color: #fff; font-weight: 600; }
  `;

  function snoozed(version) {
    try {
      const s = JSON.parse(localStorage.getItem(SNOOZE_KEY) || 'null');
      return !!(s && s.version === version && Date.now() < s.until);
    } catch { return false; }
  }

  function show(info) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const dialog = document.createElement('dialog');
    dialog.className = 'cav-dialog';
    dialog.id = 'codeagent-version-notice';
    dialog.innerHTML = '<div class="cav-head">CodeAgent 版本较旧，卡片视图可能显示不出回答</div>'
      + '<div class="cav-body">'
      + `<div class="cav-ver">本机 CodeAgent <b>${esc(info.version)}</b> · 需要 <b>${esc(info.min)}</b> 或更新</div>`
      + '<p>卡片视图靠新版 CodeAgent 的会话记录和状态回报工作，老版本下卡片可能空白、状态不对。升级后重启 AI HUB 即可。</p>'
      + '<p>升级办法（任选其一）：</p><ol>'
      + '<li>点「一键升级」：打开一个 PowerShell 窗口运行 <code>codeagent update</code>，按提示确认即可。</li>'
      + (info.downloadPage ? '<li>点「打开下载页」：到 CSOP 软件中心下载 <code>Cli3.0-Setup.exe</code> 重新安装。</li>' : '<li>到 CSOP 软件中心下载 <code>Cli3.0-Setup.exe</code> 重新安装。</li>')
      + (info.yellowZoneDownload ? '<li>点「下载最新版（黄区专用）」：从云盘直接下载最新安装包，只有黄区网络能打开。</li>' : '')
      + '</ol><div class="cav-msg" data-cav-msg></div></div>'
      + '<div class="cav-foot"><button class="cav-btn" data-cav="later">以后再说</button>'
      + (info.downloadPage ? '<button class="cav-btn" data-cav="page">打开下载页</button>' : '')
      + (info.yellowZoneDownload ? '<button class="cav-btn" data-cav="yellow">下载最新版（黄区专用）</button>' : '')
      + '<button class="cav-btn primary" data-cav="upgrade">一键升级</button></div>';
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-cav]')?.dataset.cav;
      const msg = dialog.querySelector('[data-cav-msg]');
      if (action === 'later') {
        try { localStorage.setItem(SNOOZE_KEY, JSON.stringify({ version: info.version, until: Date.now() + SNOOZE_MS })); } catch {}
        dialog.close();
      } else if (action === 'page') {
        shell.openExternal(info.downloadPage);
      } else if (action === 'yellow') {
        shell.openExternal(info.yellowZoneDownload);
      } else if (action === 'upgrade') {
        const r = await ipcRenderer.invoke('codeagent:open-upgrade').catch(error => ({ ok: false, message: error.message }));
        msg.textContent = r && r.ok ? '已打开升级窗口。升级完成后关掉那个窗口，再重启 AI HUB。' : `没能打开升级窗口：${(r && r.message) || '未知原因'}。可以改用「打开下载页」。`;
      }
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  }

  setTimeout(async () => {
    const info = await ipcRenderer.invoke('codeagent:version-check').catch(() => null);
    if (!info || !info.outdated || snoozed(info.version)) return;
    if (document.querySelector('dialog[open]')) return; // 别的弹窗（如软件更新）开着时不叠加，下次启动再提醒
    show(info);
  }, DELAY_MS);
})();
