'use strict';
// 群聊「小队模式」界面（2026-11-19）：顶栏按钮 + 设置弹层 + 输入框上方的进度条。
// 状态以主进程 squad:view / squad:changed 为准；这里只缓存和渲染。
const { ipcRenderer } = require('electron');

const views = new Map();           // meetingId → view
const listeners = new Set();
const PLACEHOLDER = '小队模式：你只和负责人说话，负责人拆任务派给成员，成员做完自动交回；开头写 @成员 可单独找他';
const STEP_LABEL = { waiting: '待开始', running: '进行中', done: '已交回', failed: '未完成', stopped: '已停止' };

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function store(view) {
  if (!view || !view.meetingId) return;
  views.set(view.meetingId, view);
  for (const fn of listeners) { try { fn(view.meetingId, view); } catch (error) { console.warn('[squad] listener failed:', error.message); } }
}
ipcRenderer.on('squad:changed', (_e, view) => store(view));

async function load(meetingId) {
  const result = await ipcRenderer.invoke('squad:view', { meetingId });
  if (result && result.ok) store(result);
  return views.get(meetingId) || null;
}
function view(meeting) { return meeting ? views.get(meeting.id) || null : null; }
// 开了工作流 / 负责人编排的群不显示小队（两种派工规则互斥，主进程同样拒绝）。
const conflict = meeting => require('../core/squad-protocol').conflict(meeting);
function enabled(meeting) { return !!(meeting && meeting.groupChat && !conflict(meeting) && view(meeting)?.config?.enabled); }

function headerButton(meeting) {
  if (!meeting || !meeting.groupChat || conflict(meeting)) return '';
  const on = enabled(meeting);
  return `<button type="button" class="mr-header-btn${on ? ' active' : ''}" id="mr-btn-squad" aria-pressed="${on}" title="${on ? '小队模式已开启：你只和负责人说话，成员做完自动交回负责人' : '开启小队模式：设一位负责人拆任务、派给成员，成员做完自动交回'}">${on ? '小队 · 负责人 ' + esc(view(meeting).leaderLabel || '') : '小队模式'}</button>`;
}

// 🖼 = 确定能看图（按后端与模型的已知能力；拿不准的不标，公司模型默认不标）。
const canSeeImages = m => require('../core/image-input-support').imageInputSupport(m) === true;
const IMAGE_MARK = '<span class="mr-squad-img" title="能看图：可以直接发图片给它">🖼 可看图</span>';

function closePopover() { document.getElementById('mr-squad-pop')?.remove(); }

// setParticipants(indexes)：沿用群聊点亮头像的入口，开启时只亮负责人，关闭时恢复原来的头像。
async function openSettings(meeting, anchor, { setParticipants, onError = () => {} } = {}) {
  closePopover();
  const v = await load(meeting.id).catch(error => { onError(error.message); return null; });
  if (!v) return;
  const cfg = v.config || {};
  const list = v.members || [];
  const pop = document.createElement('div');
  pop.id = 'mr-squad-pop';
  pop.className = 'mr-squad-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '小队模式');
  const leaderId = cfg.leaderMemberId || list[0]?.memberId || '';
  pop.innerHTML = `<h3>小队模式</h3>
    <p class="mr-squad-intro">设一位负责人：你只和负责人对话，它拆任务、按顺序或同时派给成员，成员做完自动交回，负责人再叫下一位。</p>
    ${list.length < 2 ? '<p class="mr-squad-warn">小队至少要两位成员。先点顶栏「+ 成员」再加一位。</p>' : ''}
    <label class="mr-squad-field">负责人
      <select data-squad-leader>${list.map(m => `<option value="${esc(m.memberId)}"${m.memberId === leaderId ? ' selected' : ''}>${esc(m.label)}${m.kind ? '（' + esc(m.kind) + (m.model ? ' / ' + esc(m.model) : '') + '）' : ''}${canSeeImages(m) ? ' · 🖼 可看图' : ''}</option>`).join('')}</select>
    </label>
    ${list.length ? `<div class="mr-squad-roster" aria-label="小队成员">${list.map(m => `<span class="mr-squad-member">${esc(m.label)}${canSeeImages(m) ? IMAGE_MARK : ''}</span>`).join('')}</div>
    <p class="mr-squad-img-note">🖼 = 能看图（按模型已知能力判断）；没标的成员收到图片时只看到文件路径，公司模型默认不标。</p>` : ''}
    <label class="mr-squad-field">负责人最多连续派工几轮（到了先停下问你，防止空转耗额度）
      <input type="number" min="1" max="20" step="1" data-squad-rounds value="${esc(cfg.maxRounds || 6)}">
    </label>
    <ul class="mr-squad-notes">
      <li>运行中可点「停止小队」，或直接 @某位成员单独说话。</li>
      <li>关掉后群聊恢复原样：消息发给点亮头像的成员。</li>
      <li>不用额外安装，CodeAgent、Claude Code、Codex 等成员都能用。</li>
    </ul>
    <p class="mr-squad-error" data-squad-error hidden></p>
    <div class="mr-squad-buttons">
      ${cfg.enabled ? '<button type="button" data-squad-off>关闭小队模式</button>' : ''}
      <button type="button" data-squad-cancel>取消</button>
      <button type="button" class="primary" data-squad-save${list.length < 2 ? ' disabled' : ''}>${cfg.enabled ? '保存' : '开启小队模式'}</button>
    </div>`;
  document.body.appendChild(pop);
  // 读配置时顶栏会重画、按钮换成新节点：按当前页面上的按钮定位（真机截图里弹层跑到了左上角）。
  const live = document.getElementById('mr-btn-squad') || anchor;
  const rect = live && live.isConnected ? live.getBoundingClientRect() : { bottom: 80, right: window.innerWidth - 40 };
  pop.style.top = `${Math.round(rect.bottom + 6)}px`;
  pop.style.left = `${Math.max(12, Math.round(Math.min(rect.right, window.innerWidth - 12) - pop.offsetWidth))}px`;
  const showError = message => { const el = pop.querySelector('[data-squad-error]'); el.textContent = message; el.hidden = false; };
  const apply = async enabledNext => {
    const leaderMemberId = pop.querySelector('[data-squad-leader]')?.value || '';
    const maxRounds = Number(pop.querySelector('[data-squad-rounds]')?.value) || 6;
    const result = await ipcRenderer.invoke('squad:configure', { meetingId: meeting.id, enabled: enabledNext, leaderMemberId, maxRounds });
    if (!result || result.ok === false) { showError((result && result.reason) || '保存失败'); return; }
    store(result);
    if (typeof setParticipants === 'function') {
      try {
        if (enabledNext && Number.isInteger(result.leaderIndex)) await setParticipants([result.leaderIndex]);
        else if (!enabledNext && cfg.enabled) {
          const all = list.map(m => m.index).filter(Number.isInteger);
          await setParticipants(Array.isArray(cfg.previousParticipants) ? cfg.previousParticipants.filter(i => all.includes(i)) : all);
        }
      } catch (error) { onError('头像点亮状态没保存：' + error.message); }
    }
    closePopover();
  };
  pop.querySelector('[data-squad-save]').addEventListener('click', () => apply(true).catch(error => showError(error.message)));
  pop.querySelector('[data-squad-off]')?.addEventListener('click', () => apply(false).catch(error => showError(error.message)));
  pop.querySelector('[data-squad-cancel]').addEventListener('click', closePopover);
  setTimeout(() => document.addEventListener('mousedown', function away(event) {
    if (!document.getElementById('mr-squad-pop')) { document.removeEventListener('mousedown', away, true); return; }
    if (!pop.contains(event.target) && !event.target.closest?.('#mr-btn-squad')) { closePopover(); document.removeEventListener('mousedown', away, true); }
  }, true), 0);
}

function runText(run) {
  if (!run) return '等你提问：问题只发给负责人';
  if (run.status === 'leader') return run.note || '负责人正在理解需求';
  if (run.status === 'members') return `第 ${run.round}/${run.maxRounds} 轮`;
  if (run.status === 'handback') return `第 ${run.round}/${run.maxRounds} 轮 · ${run.note || '负责人正在验收'}`;
  return run.note || '';
}

function renderStrip(row, meeting, { onError = () => {} } = {}) {
  const v = view(meeting);
  const run = v?.run || null;
  const live = run && ['leader', 'members', 'handback'].includes(run.status);
  const steps = run && run.steps && run.steps.length && ['members', 'handback'].includes(run.status)
    ? `<span class="mr-squad-steps">${run.steps.map((s, i) => `<span class="mr-squad-step is-${esc(s.state)}" title="${esc(s.task)}">${i + 1}. ${esc(s.label)} · ${esc(STEP_LABEL[s.state] || s.state)}</span>`).join('')}</span>` : '';
  row.innerHTML = `<section class="mr-orch-strip mr-squad-strip${run && ['error', 'limit'].includes(run.status) ? ' is-halted' : ''}" data-squad-status="${esc(run ? run.status : 'idle')}" aria-label="小队进度">
      <div class="mr-orch-main">
        <strong class="mr-orch-label">小队 · 负责人 ${esc(v?.leaderLabel || '')}</strong>
        <span class="mr-orch-muted">${esc(runText(run))}</span>${steps}
        <span class="mr-orch-muted">成员做完自动交回负责人 · @成员 可直接点名</span>
      </div>
      <div class="mr-orch-actions">${live ? '<button type="button" data-squad-stop>停止小队</button>' : ''}${run && run.recoverable
        ? `<button type="button" class="primary" data-squad-resume>${run.recoverMode === 'restart-only' ? '重启负责人' : run.restartLeader ? '重启负责人并继续' : '重新交给负责人'}</button>` : ''}</div>
    </section>`;
  // R46：负责人掉线时一键重启并重发停下的那一棒。One click restarts the leader and resends the halted leg.
  row.querySelector('[data-squad-resume]')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      const result = await ipcRenderer.invoke('squad:resume', { meetingId: meeting.id });
      if (result && result.ok === false) onError(result.reason || '没能接着做');
    } catch (error) { onError(error.message); }
  });
  row.querySelector('[data-squad-stop]')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      const result = await ipcRenderer.invoke('squad:stop', { meetingId: meeting.id });
      if (result && result.ok === false) onError(result.reason || '停止失败');
    } catch (error) { onError(error.message); }
  });
}

function dispatchLabel(message) {
  const kind = message?.dispatch?.kind;
  if (kind === 'squad') return '负责人派发';
  if (kind === 'squad-notice') return 'Hub → 负责人';
  return null;
}

// 发图前提示：小队里不能确定能看图的成员（含负责人）。返回一行提示，没有就返回空串。
// 先看有没有图片；有图但小队状态还没加载（刚打开群就发）时先读一次，不漏提示。
async function imageWarning(meeting, text) {
  if (!meeting || !meeting.groupChat || conflict(meeting)) return '';
  let images = [];
  try { images = require('../core/acp-attachments').imagePaths(text); } catch { images = []; }
  if (!images.length) return '';
  if (!view(meeting)) await load(meeting.id);
  if (!enabled(meeting)) return '';
  const blind = (view(meeting)?.members || []).filter(m => !canSeeImages(m)).map(m => m.label);
  return blind.length ? `这条带图片：${blind.join('、')} 不确定能看图，只会收到图片文件路径；标 🖼 的成员能直接看图。` : '';
}

module.exports = {
  imageWarning, canSeeImages, PLACEHOLDER, load, view, enabled, onChange, headerButton, openSettings, closePopover, renderStrip, dispatchLabel };
