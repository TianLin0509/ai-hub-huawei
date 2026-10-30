/* 子 Agent 进度一行字（2026-10-29）：卡片视图底部、输入栏上方一行，
 * 例如「2 个子任务进行中 · 最近一步：读取 GDlMeasure.cc」，全部结束后变成「3 个子任务已完成」。
 * 主进程 main/subagent-progress-service.js 只盯这里报上去的会话（当前会话且在卡片视图），推 subagent-progress:changed 过来。
 * 产品负责人只要这一行，不做展开的完整过程视图。 */
(function () {
  'use strict';
  const { ipcRenderer } = require('electron');
  const latest = new Map();   // sessionId → { text, running } | null
  let line = null, watching = undefined;

  function activeId() { try { return typeof activeSessionId !== 'undefined' ? activeSessionId : null; } catch { return null; } }  // renderer.js 的全局
  function inCardView() { try { return typeof currentView === 'undefined' || currentView === 'card'; } catch { return true; } }

  function ensureLine() {
    if (line && line.isConnected) return line;
    const panel = document.getElementById('terminal-panel');
    if (!panel) return null;
    line = document.createElement('div');
    line.id = 'subagent-progress-line';
    line.setAttribute('role', 'status');
    line.hidden = true;
    panel.appendChild(line);
    return line;
  }
  function render() {
    const el = ensureLine();
    if (!el) return;
    const id = activeId(), p = id && inCardView() ? latest.get(id) : null;
    if (!p || !p.text) { el.hidden = true; el._text = ''; return; }
    if (el._text === p.text && !el.hidden) return;
    el._text = p.text;
    el.classList.toggle('sap-running', p.running > 0);
    el.innerHTML = '<span class="sap-dot" aria-hidden="true"></span><span class="sap-text"></span>';
    el.querySelector('.sap-text').textContent = p.text;
    el.title = p.text;
    el.hidden = false;
  }
  // 只把「当前会话 + 卡片视图」报给主进程；切会话、切到终端视图就换或停。
  function syncWatch() {
    const id = inCardView() ? activeId() : null;
    if (id !== watching) { watching = id; ipcRenderer.send('subagent-progress:watch', id); }
    render();
  }

  ipcRenderer.on('subagent-progress:changed', (_e, payload) => {
    if (!payload || typeof payload.sessionId !== 'string') return;
    latest.set(payload.sessionId, payload.progress || null);
    for (const k of latest.keys()) if (k !== payload.sessionId && k !== activeId()) latest.delete(k);
    render();
  });
  function init() { ensureLine(); syncWatch(); setInterval(syncWatch, 500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
