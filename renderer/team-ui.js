/* 负责人组队（2026-11-01）的界面：
 *   ① 侧栏：负责人会话下挂成员子行（session-list-renderer.js 调 window.__teamUi）；负责人行带「负责人」标签，
 *      有待批准的招人计划时换成橙色「待批准」按钮；
 *   ② 批准弹窗：列出负责人提交的每个人（分工、类型、账号、目录、开工任务），账号旁边是右侧看板同一份额度
 *      （5h / 7d 剩余、活跃会话数），用户可以改账号，然后批准或驳回。只有这里能批准，会话里的模型做不到。 */
(function () {
  'use strict';
  const { ipcRenderer } = require('electron');
  // 样式表由本脚本自己挂上（不改 index.html）。
  if (typeof document.querySelector === 'function' && document.head && !document.querySelector('link[data-team-ui]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = 'team-ui.css'; link.dataset.teamUi = '1'; // 与 index.html 同在 renderer/ 目录
    document.head.appendChild(link);
  }
  const teams = new Map();   // leadSid → 主进程 publicView
  let modal = null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rerender = () => { if (typeof scheduleSessionListRender === 'function') scheduleSessionListRender(); };

  function accept(list) {
    teams.clear();
    for (const t of list || []) if (t && t.leadSid) teams.set(t.leadSid, t);
    rerender();
  }
  async function refresh() {
    try { const r = await ipcRenderer.invoke('team:list'); if (r && r.ok) accept(r.result); }
    catch (e) { console.warn('[team-ui] 读取失败：', e && e.message); }
  }
  ipcRenderer.on('team:changed', (_e, p) => {
    if (!p || !p.leadSid) return;
    if (p.team) teams.set(p.leadSid, p.team); else teams.delete(p.leadSid);
    rerender();
    if (modal && modal.dataset.leadSid === p.leadSid && !pendingPlan(p.leadSid)) closeModal();
  });

  const pendingPlan = leadSid => (teams.get(leadSid)?.plans || []).find(p => p.status === 'pending') || null;
  const sessionExists = (sessionMap, id) => !sessionMap || !sessionMap.get || !!sessionMap.get(id);
  const canNestTeam = (leadSid, sessionMap, meetings) => sessionExists(sessionMap, leadSid)
    && !sessionMap?.get(leadSid)?.meetingId
    && !Object.values(meetings || {}).some(m => (m.subSessions || []).includes(leadSid));

  window.__teamUi = {
    // 挂在某位负责人下面的成员（负责人会话还在才挂，负责人关掉后成员回到顶层）。
    membersOf(leadSid, sessionMap, meetings) {
      const t = teams.get(leadSid);
      if (!t || !canNestTeam(leadSid, sessionMap, meetings)) return [];
      return t.members.map(m => m.sid).filter(id => id && sessionExists(sessionMap, id));
    },
    memberIdSet(sessionMap, meetings) {
      const set = new Set();
      for (const t of teams.values()) for (const id of this.membersOf(t.leadSid, sessionMap, meetings)) set.add(id);
      return set;
    },
    isLead: leadSid => teams.has(leadSid),
    memberInfo(sid) {
      for (const t of teams.values()) { const m = t.members.find(x => x.sid === sid); if (m) return m; }
      return null;
    },
    signature(id, sessionMap, meetings) {
      const t = teams.get(id);
      if (t) return 'L' + t.members.map(m => m.sid + m.status).join(',')
        + ':' + this.membersOf(id, sessionMap, meetings).join(',') + (pendingPlan(id) ? ':P' : '');
      const m = this.memberInfo(id);
      return m ? 'M' + m.memberId + m.status : '';
    },
    // 负责人行标题后的标签；成员行标题前的编号。返回 HTML 片段。
    rowTagHtml(id) {
      const plan = pendingPlan(id);
      if (plan) return `<button type="button" class="team-pending-badge" data-team-approve="${esc(id)}" title="负责人提交了招人计划（${plan.members.length} 人），点开批准或驳回">待批准</button>`;
      if (teams.get(id)?.members.length) return '<span class="sl-orch-tag" title="负责人：下面挂着它招的成员会话">负责人</span>';
      const m = this.memberInfo(id);
      return m ? `<span class="team-member-tag${m.status === 'dismissed' ? ' dismissed' : ''}" title="${esc(m.role)}${m.status === 'dismissed' ? '（已离队）' : ''}">${esc(m.memberId)}</span>` : '';
    },
    openApproval,
  };

  // 侧栏在按下时捕获指针、松开时切换会话（session-list-renderer.js），点击事件就到不了角标；
  // 在捕获阶段先截住角标上的按下，侧栏不接手，随后的 click 落在角标本身。
  for (const type of ['pointerdown', 'mousedown']) document.addEventListener(type, event => {
    if (event.target && event.target.closest && event.target.closest('[data-team-approve]')) event.stopPropagation();
  }, true);
  document.addEventListener('click', event => {
    const btn = event.target && event.target.closest && event.target.closest('[data-team-approve]');
    if (!btn) return;
    event.preventDefault(); event.stopPropagation();
    openApproval(btn.dataset.teamApprove);
  }, true);

  async function accounts() {
    const r = await ipcRenderer.invoke('team:accounts');
    if (!r?.ok) throw Error(r?.error || '号池读取失败');
    return r.result.rows || [];
  }
  function accountText(a) {
    return `${a.label || a.id} · ${a.activeSessions || 0} 个会话${a.usable ? '' : ' · ' + (a.unavailableReason || '暂不可用')}`;
  }

  function closeModal() { if (modal) { modal.remove(); modal = null; } }
  async function openApproval(leadSid) {
    const plan = pendingPlan(leadSid);
    if (!plan) return;
    closeModal();
    const leadTitle = (typeof sessions !== 'undefined' && sessions.get && sessions.get(leadSid)?.title) || '负责人';
    modal = document.createElement('div');
    modal.className = 'team-modal-backdrop';
    modal.dataset.leadSid = leadSid;
    const memberRows = plan.members.map((m, i) => {
      const options = m.account ? `<option value="${esc(m.account)}" selected>${esc(m.account)}（正在读取账号…）</option>` : '';
      return `<tr>
        <td class="team-col-no">${i + 1}</td>
        <td><b>${esc(m.title)}</b><div class="team-sub">${esc(m.role)}</div></td>
        <td>${m.kind === 'codeagent' ? 'CodeAgent' : esc(m.kind)}</td>
        <td><select data-team-account="${i}" data-team-kind="${esc(m.kind)}">${options}</select></td>
        <td><select data-team-model="${i}"><option value="${esc(m.model || '')}">${esc(m.model || '沿用账号模型')}</option></select><div class="team-sub" data-team-model-hint="${i}" hidden>模型权限未核实</div></td>
        <td class="team-task"><div class="team-sub">${esc(m.cwd || '与负责人相同目录')}</div>${esc(m.task)}</td>
      </tr>`;
    }).join('');
    modal.innerHTML = `<div class="team-modal" role="dialog" aria-modal="true" aria-label="批准招人计划">
      <h3>「${esc(leadTitle)}」要组队：${plan.members.length} 个会话</h3>
      <p class="team-goal">${esc(plan.goal)}</p>
      <table class="team-plan"><thead><tr><th>#</th><th>分工</th><th>类型</th><th>号池账号</th><th>模型</th><th>目录与开工任务</th></tr></thead><tbody>${memberRows}</tbody></table>
      <label class="team-note">备注（可选，会转给负责人）<textarea rows="2" data-team-note></textarea></label>
      <div class="team-actions">
        <button type="button" data-team-act="reject">驳回</button>
        <button type="button" class="primary" data-team-act="approve">批准并建 ${plan.members.length} 个会话</button>
      </div>
      <div class="team-error" hidden></div>
    </div>`;
    modal.addEventListener('click', async event => {
      if (event.target === modal) { closeModal(); return; }
      const act = event.target.closest && event.target.closest('[data-team-act]');
      if (!act) return;
      const approve = act.dataset.teamAct === 'approve';
      const edits = plan.members.map((_m, i) => { const sel = modal.querySelector(`[data-team-account="${i}"]`); return sel ? { account: sel.value,model:modal.querySelector(`[data-team-model="${i}"]`).value } : {}; });
      modal.querySelectorAll('button').forEach(b => { b.disabled = true; });
      act.textContent = approve ? '正在建会话…' : '正在驳回…';
      const r = await ipcRenderer.invoke('team:decide', { leadSid, planId: plan.id, approve, note: modal.querySelector('[data-team-note]').value, edits });
      if (r && r.ok) { closeModal(); return; }
      const err = modal.querySelector('.team-error');
      err.hidden = false; err.textContent = (r && r.error) || '操作失败';
      modal.querySelectorAll('button').forEach(b => { b.disabled = false; });
      act.textContent = approve ? '批准' : '驳回';
    });
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
    document.body.appendChild(modal);
    const opened = modal;
    modal.querySelector('[data-team-act="approve"]').disabled=true;
    accounts().then(accountOptions => {
      if (modal !== opened) return;
      if(!accountOptions.length)throw Error('号池里还没有账号，请先在账号管理里添加账号。');
      modal.querySelectorAll('select[data-team-account]').forEach(sel => {
        const rows = accountOptions;
        if (!rows) return;
        const keep = sel.value;
        sel.innerHTML = rows.map(a => `<option value="${esc(a.id)}"${!a.usable?' disabled':''}>${esc(accountText(a))}</option>`).join('');
        if (keep && !rows.some(a => a.id === keep)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(keep)}">${esc(keep)}（看板里没有这个账号）</option>`);
        sel.value = keep;
        {
          const model=modal.querySelector(`[data-team-model="${sel.dataset.teamAccount}"]`);
          const fill=initial=>{
            const row=rows.find(a=>a.id===sel.value),chosen=initial?model.value:'';
            modal.querySelector(`[data-team-model-hint="${sel.dataset.teamAccount}"]`).hidden=!row || row.modelsAuthoritative===true;
            const available=row?.models || [];
            model.innerHTML=`<option value="">沿用账号模型${row?.defaultModel?' · '+esc(row.defaultModel):''}</option>`+available.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('');
            if(chosen&&!available.includes(chosen))model.insertAdjacentHTML('beforeend',`<option value="${esc(chosen)}">${esc(chosen)}（需核对权限）</option>`);
            model.value=chosen;
          };
          fill(true);sel.addEventListener('change',()=>fill(false));
        }
      });
      modal.querySelector('[data-team-act="approve"]').disabled=false;
    }).catch(error=>{if(modal!==opened)return;const e=modal.querySelector('.team-error');e.hidden=false;e.textContent=`${error.message} 处理后重新打开这份计划即可继续。`;});
    modal.querySelector('[data-team-act="approve"]').focus();
  }

  refresh();
})();
