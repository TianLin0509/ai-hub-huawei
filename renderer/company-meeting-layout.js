'use strict';

function createMeetingLayout({ document, window, ipcRenderer, closeOtherPanels, showMessage, openSession }) {
  let host;
  const call = async (op, payload) => {
    const r = await ipcRenderer.invoke('company-assistant:' + op, payload);
    if (r?.ok === false) throw new Error(r.error || '会议操作未完成');
    return r;
  };
  const markdown = text => require('dompurify').sanitize(require('marked').marked.parse(String(text || ''), { breaks: true }));
  // 打开会议专属的 CodeAgent 会话：先收起会议页，再切到会话（采集在后台继续）。
  const openAgent = openSession ? async sessionId => { close(); await openSession(sessionId); } : null;
  const meeting = require('./company-meeting-page').createCompanyMeetingPage({ document, window, call, markdown, openSession: openAgent });
  const nav = document.createElement('button');
  nav.type = 'button'; nav.id = 'btn-company-meeting'; nav.className = 'btn-shell-nav';
  nav.title = '会议 · 采集、回放与会议理解'; nav.setAttribute('aria-label', '会议');
  nav.innerHTML = '<span class="btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="3"/><path d="M8 21h8M12 17v4"/><circle cx="12" cy="10.5" r="3"/></svg></span><span class="btn-label">会议</span>';
  const rules = document.getElementById('btn-rules');
  (document.getElementById('btn-company-assistant') || rules?.closest('.rail-group') || rules).after(nav);
  function place() {
    if (!host || host.hidden) return;
    const rail = document.getElementById('scene-rail')?.getBoundingClientRect();
    const toolbar = document.getElementById('app-toolbar')?.getBoundingClientRect();
    const footer = document.getElementById('hub-system-footer')?.getBoundingClientRect();
    host.style.left = `${Math.max(0, rail?.right || 52)}px`;
    host.style.top = `${Math.max(0, toolbar?.bottom || 44)}px`;
    host.style.bottom = `${footer?.height || 0}px`;
  }
  async function open() {
    if (!host) { host = document.createElement('section'); host.id = 'company-meeting-page'; host.className = 'company-meeting-page'; host.hidden = true; document.body.append(host); }
    closeOtherPanels();
    for (const key of ['__companyAssistantHide','__companyForumHide','__assistantHide','__teamHide','__cloudHide','__wirelessHide','__rulesHide','__writingHide','__xresearchHide','__studyHide','__ranHide']) window[key]?.();
    host.hidden = false; document.body.classList.add('company-meeting-page-open'); nav.classList.add('active');
    place(); window.addEventListener('resize', place);
    await meeting.open(host);
  }
  function close() {
    if (!host) return;
    host.hidden = true; meeting.close();
    document.body.classList.remove('company-meeting-page-open'); nav.classList.remove('active');
    window.removeEventListener('resize', place);
  }
  nav.addEventListener('click', () => { void open().catch(e => showMessage(e.message)); });
  document.addEventListener('click', e => {
    if (!e.target.closest('#btn-company-meeting') && e.target.closest('#scene-rail button')) close();
  });
  return { open, close };
}
module.exports = { createMeetingLayout };
