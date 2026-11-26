'use strict';
// 群聊「抢救」下拉（2026-11-24）：顶栏只占一个小按钮，点开才列出五个兜底动作，
// 不往顶栏或输入区加一排按钮。后端见 main/ipc/groupchat-rescue-handlers.js。
const { ipcRenderer } = require('electron');

const POP_ID = 'mr-rescue-pop';
const BTN_ID = 'mr-btn-rescue';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function headerButton(meeting) {
  if (!meeting || !meeting.groupChat) return '';
  return `<button type="button" class="mr-header-btn mr-rescue-btn" id="${BTN_ID}" aria-haspopup="menu" aria-expanded="false" title="群聊卡住时的兜底：强制结束本轮、重启成员、跳过未交、回退上一轮、导出诊断">抢救 ▾</button>`;
}

let detach = null;
function closeMenu() {
  if (detach) { detach(); detach = null; }
  document.getElementById(POP_ID)?.remove();
  document.getElementById(BTN_ID)?.setAttribute('aria-expanded', 'false');
}

const ITEMS = [
  { action: 'force-settle', label: '强制结束本轮', tip: '先向所有在答的成员发停止，再把本轮直接收回待命；已经交的回答保留。「停止本轮」没反应、一直显示思考中时用。' },
  { action: 'skip-stuck', label: '跳过未交成员', tip: '本轮还没交的成员记为缺席，按已交的回答收尾；成员会话本身不动。' },
  { action: 'restart-member', label: '重启成员', tip: '某位成员卡死、退回命令行或不再响应时，按原会话重启它；群、聊天记录和它的历史都保留。' },
  { action: 'rollback-last-turn', label: '回退上一轮', tip: '撤掉最近一轮的问题和回答，之后的上下文不再带它。成员自己的会话里仍记得这轮。本轮还在进行时需先强制结束。' },
  { action: 'export-diagnostics', label: '导出诊断状态', tip: '把本群的状态机、成员状态、回答文件和最近错误存成 JSON，便于反馈问题；不含 Key、Cookie 和对话正文。' },
];

// opts: { members: [{ sid, label }], run(action, args) → Promise<result>, onResult(action, result) }
function openMenu(meeting, anchor, opts = {}) {
  closeMenu();
  const members = Array.isArray(opts.members) ? opts.members : [];
  const pop = document.createElement('div');
  pop.id = POP_ID;
  pop.className = 'mr-rescue-pop';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', '群聊抢救');
  pop.innerHTML = `<div class="mr-rescue-head">群聊抢救<span class="mr-rescue-sub">卡住时用，平时不必点</span></div>
    ${ITEMS.map(item => item.action === 'restart-member'
      ? `<div class="mr-rescue-item mr-rescue-group" role="none">
          <button type="button" role="menuitem" class="mr-rescue-row" data-rescue-toggle="restart" aria-expanded="false">
            <span>${esc(item.label)}</span><span class="mr-rescue-info" title="${esc(item.tip)}" aria-label="${esc(item.tip)}">ⓘ</span><span class="mr-rescue-caret">▸</span>
          </button>
          <div class="mr-rescue-members" data-rescue-members hidden>
            ${members.length ? members.map(m => `<button type="button" role="menuitem" class="mr-rescue-member" data-rescue-action="restart-member" data-sid="${esc(m.sid)}" title="重启 ${esc(m.label)}">${esc(m.label)}</button>`).join('') : '<span class="mr-rescue-empty">本群还没有成员</span>'}
          </div>
        </div>`
      : `<div class="mr-rescue-item" role="none"><button type="button" role="menuitem" class="mr-rescue-row${item.action === 'rollback-last-turn' ? ' is-danger' : ''}" data-rescue-action="${item.action}">
          <span>${esc(item.label)}</span><span class="mr-rescue-info" title="${esc(item.tip)}" aria-label="${esc(item.tip)}">ⓘ</span></button></div>`).join('')}
    <div class="mr-rescue-status" data-rescue-status hidden></div>`;
  document.body.appendChild(pop);
  const live = document.getElementById(BTN_ID) || anchor;
  live?.setAttribute('aria-expanded', 'true');
  const rect = live && live.isConnected ? live.getBoundingClientRect() : { bottom: 80, right: window.innerWidth - 40 };
  pop.style.top = `${Math.round(rect.bottom + 6)}px`;
  pop.style.left = `${Math.max(12, Math.round(Math.min(rect.right, window.innerWidth - 12) - pop.offsetWidth))}px`;

  const status = pop.querySelector('[data-rescue-status]');
  const showStatus = (html, level = 'info') => { status.hidden = false; status.className = `mr-rescue-status is-${level}`; status.innerHTML = html; };
  pop.querySelector('[data-rescue-toggle="restart"]')?.addEventListener('click', event => {
    const box = pop.querySelector('[data-rescue-members]');
    box.hidden = !box.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
    event.currentTarget.querySelector('.mr-rescue-caret').textContent = box.hidden ? '▸' : '▾';
  });
  pop.querySelectorAll('[data-rescue-action]').forEach(button => button.addEventListener('click', async () => {
    const action = button.dataset.rescueAction;
    const args = { meetingId: meeting.id, ...(button.dataset.sid ? { sid: button.dataset.sid } : {}) };
    if (action === 'rollback-last-turn') {
      // 本轮还在跑时回退一定会被拒：直接在菜单里说清楚，不先弹一个红色确认框再报错。
      if (typeof opts.isTurnRunning === 'function' && opts.isTurnRunning()) {
        showStatus('本轮还在进行：先点「强制结束本轮」，再回退', 'error');
        return;
      }
      closeMenu(); // 确认框在弹层外，点它会被当成「点外面」关掉弹层；先关，结果走顶栏提示条。
      const ok = await require('./ui-feedback').confirmHubAction('最近一轮的问题和所有回答会从群聊里撤掉，之后的上下文不再带它；成员自己的会话里仍记得这轮。', { title: '回退上一轮？', acceptLabel: '回退', danger: true });
      if (!ok) return;
    }
    pop.querySelectorAll('button').forEach(b => { b.disabled = true; });
    showStatus(action === 'restart-member' ? '正在重启，通常 5–20 秒…' : '处理中…');
    let result;
    try { result = await (opts.run ? opts.run(action, args) : ipcRenderer.invoke(`groupchat:${action}`, args)); }
    catch (error) { result = { ok: false, message: error && error.message ? error.message : String(error) }; }
    pop.querySelectorAll('button').forEach(b => { b.disabled = false; });
    if (typeof opts.onResult === 'function') { try { opts.onResult(action, result, { inMenu: pop.isConnected }); } catch (_) { /* 结果提示由下面兜底显示 */ } }
    if (!pop.isConnected) return;
    if (!result || result.ok === false) { showStatus(esc((result && (result.message || result.reason)) || '操作失败'), 'error'); return; }
    if (action === 'export-diagnostics') {
      showStatus(`已保存：<code class="mr-rescue-path">${esc(result.path)}</code>
        <span class="mr-rescue-actions"><button type="button" data-rescue-copy>复制内容</button><button type="button" data-rescue-open>打开位置</button></span>`, 'ok');
      status.querySelector('[data-rescue-copy]')?.addEventListener('click', async () => {
        // 用 Electron 剪贴板：navigator.clipboard 在窗口没有焦点时会被拒绝。
        const btn = status.querySelector('[data-rescue-copy]');
        try { require('electron').clipboard.writeText(result.text || ''); btn.textContent = '已复制'; }
        catch (error) { btn.textContent = '复制失败'; }
      });
      status.querySelector('[data-rescue-open]')?.addEventListener('click', async () => {
        const btn = status.querySelector('[data-rescue-open]');
        let r;
        try { r = await ipcRenderer.invoke('show-in-folder', result.path); } catch (error) { r = { error: error && error.message }; }
        if (r && r.error) btn.textContent = '打开失败：' + r.error;
      });
      return;
    }
    closeMenu();
  }));
  const away = event => { if (!pop.contains(event.target) && !event.target.closest?.(`#${BTN_ID}`)) closeMenu(); };
  const onKey = event => { if (event.key === 'Escape') closeMenu(); };
  document.addEventListener('mousedown', away, true);
  document.addEventListener('keydown', onKey, true);
  detach = () => { document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', onKey, true); };
  return pop;
}

// 给顶栏下的提示条用的一句话结果（失败的由弹层自己显示原因）。
function summary(action, result) {
  if (!result || result.ok === false) return '';
  if (action === 'force-settle') {
    const n = (result.stopped || []).length + (result.skipped || []).length;
    return result.wasBusy || result.forced || n ? `已强制结束本轮${n ? `：${n} 位成员已停下或跳过` : ''}，群聊回到待命` : '本轮已经是待命状态，无需结束';
  }
  if (action === 'skip-stuck') return (result.skipped || []).length ? `已跳过 ${result.skipped.length} 位还没交的成员` : '当前没有还在答的成员';
  if (action === 'restart-member') return `成员已重启${result.skipped ? '（它这轮记为缺席）' : ''}，可以继续提问`;
  if (action === 'rollback-last-turn') return `已回退第 ${result.turnNum} 轮`;
  return '';
}

module.exports = { headerButton, openMenu, closeMenu, summary, ITEMS };
