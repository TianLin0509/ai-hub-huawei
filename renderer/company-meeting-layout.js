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
  // 「打开理解会话后台」：先收起会议页（采集在后台继续），再切到会话并打开后台终端。
  const openBackstage = async sessionId => {
    if (typeof window.__hubOpenBackstage !== 'function') return { ok: false };
    // 先试着打开；成功时 __hubOpenBackstage 已经收起了各页面（含会议页），失败就留在会议页说明原因。
    const r = await window.__hubOpenBackstage(sessionId);
    if (r?.ok && host && !host.hidden) close();
    return r;
  };
  const meeting = require('./company-meeting-page').createCompanyMeetingPage({ document, window, call, markdown, openSession: openAgent, openBackstage });
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
    for (const key of [
    '__companyRoomsHide',
    '__companyAssistantHide','__companyForumHide', '__companyAttendanceHide', '__companyW3Hide', '__profileHide','__assistantHide','__teamHide','__avatarHide','__cloudHide','__wirelessHide','__rulesHide','__writingHide','__xresearchHide','__studyHide','__ranHide']) window[key]?.();
    host.hidden = false; document.body.classList.add('company-meeting-page-open'); nav.classList.add('active');
    place(); window.addEventListener('resize', place);
    await meeting.open(host);
  }
  function close() {
    if (!host) return;
    // 先让会议页记下各列表的滚动位置，再隐藏外壳（隐藏后读到的 scrollTop 都是 0）。
    meeting.close(); host.hidden = true;
    document.body.classList.remove('company-meeting-page-open'); nav.classList.remove('active');
    window.removeEventListener('resize', place);
  }
  nav.addEventListener('click', () => { void open().catch(e => showMessage(e.message)); });
  // 跳转后台（renderer/backstage-jump.js）：从会议页跳去看会议理解会话；返回时重开会议页（先拉一次全量再走增量，采集一直在后台继续）。
  require('./backstage-jump').registerBackstageSource('meeting', {
    label: '会议',
    // 自检用：会议 AI（理解会话）的启动报错；只读页面已合并的状态，不发 IPC。
    // 按会议负责人口径：报错用 laneAlert（已按优先级合并引擎异常、理解会话异常、问答线异常）；「需先配置」认 engines 为空；
    // 会议会话有自己的恢复与换引擎，不给通用的「重启后台会话」；在录时不给会重启 Hub 的修复；不带任何会议内容。
    diagnose: () => {
      const st = meeting.currentState?.(), m = st?.meeting || null;
      const alert = m ? require('./company-meeting-chat').laneAlert(st, m) : null;
      const noEngine = Array.isArray(st?.engines) && st.engines.length === 0;
      return { error: alert?.text || '', area: 'codeagent', capability: noEngine ? { codeagent: false, api: false } : {},
        codeagentOnly: true, noSessionRestart: true, recording: ['recording', 'paused'].includes(m?.state),
        hint: '会议自己的修复在会议页：「更多」里换引擎，或「会议理解」页签点「更新」重新理解；单题点题目卡上的「重试」或「用 X 重答」。' };
    },
    emptyText: '这场会议还没有理解会话：会议 AI 起来后才有后台可看。',
    closedText: '理解会话已休眠或已关闭，后台打不开。点「会议理解」页签的「更新」或等下一轮自动理解，会重新建会话；也可在「更多 › 打开理解会话」重开。',
    reopen: () => open(),
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#btn-company-meeting') && e.target.closest('#scene-rail button')) close();
  });
  return { open, close };
}
module.exports = { createMeetingLayout };
