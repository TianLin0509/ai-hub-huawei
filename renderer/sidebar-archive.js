'use strict';

// 侧栏归档的渲染端（2026-11-28）：缓存主进程的归档记录，提供判断函数和「一键归档」弹窗。
// 规则本体在 core/sidebar-archive.js；这里不自己定规则。
const archiveRules = require('../core/sidebar-archive');
const { latestActivityTime } = require('../core/session-recency');

const PRESETS = [
  { key: '24h', label: '24 小时', hours: 24 },
  { key: '3d', label: '3 天', hours: 72 },
  { key: '7d', label: '7 天', hours: 168 },
  { key: 'custom', label: '自定义', hours: null },
];
const PREVIEW_ROWS = 5;

function idleLabel(ms) {
  const hours = Math.floor(ms / archiveRules.HOUR);
  if (hours < 24) return Math.max(1, hours) + ' 小时没动';
  return Math.floor(hours / 24) + ' 天没动';
}

function createSidebarArchiveController({ document, ipcRenderer, storage, onChange = () => {} }) {
  let state = archiveRules.emptyState(), error = '', revision = 0, loaded = false;
  let snapshotSequence = 0, readSequence = 0;   // 迟到的读取结果不覆盖期间保存或推送来的新状态（同 sidebar-folders.js）
  function accept(next) {
    if (!next || next.version !== 1 || !next.records || !next.auto) throw new Error('归档数据格式无效，请重试');
    snapshotSequence++;
    if (!loaded || error || JSON.stringify(state) !== JSON.stringify(next)) { state = next; error = ''; loaded = true; revision++; onChange(); }
  }
  function legacyDays() {
    try { return Number(storage.getItem('hubSidebarRecentDays')) === 3 ? 3 : 1; } catch { return 1; }
  }
  async function refresh() {
    const snapshotAtStart = snapshotSequence, request = ++readSequence;
    const obsolete = () => snapshotAtStart !== snapshotSequence || request !== readSequence;
    try {
      const response = await ipcRenderer.invoke('sidebar-archive:list', { legacyDays: legacyDays() });
      if (obsolete()) return true;
      if (!response?.ok) throw new Error(response?.error || '归档读取失败，请重试');
      accept(response.state); return true;
    } catch (failure) {
      if (obsolete()) return true;
      error = failure.message; revision++; onChange(); return false;
    }
  }
  async function mutate(action, args) {
    const response = await ipcRenderer.invoke('sidebar-archive:' + action, args);
    if (!response?.ok) throw new Error(response?.error || '归档保存失败，请重试');
    accept(response.state);
    return state;
  }
  ipcRenderer.on?.('sidebar-archive:changed', (_event, payload) => {
    try { accept(payload?.state); } catch (failure) { error = failure.message; revision++; onChange(); }
  });

  // 侧栏渲染用：读不到记录时（loaded=false）什么都不归档，宁可多显示也不藏会话。
  function isArchived(item, context = {}) {
    if (!loaded) return false;
    return archiveRules.isItemArchived(item, { ...context, archive: state });
  }
  const recordOf = item => Number(state.records[archiveRules.entityKey(item)]) || 0;

  // 一键归档弹窗。candidates() 返回当前侧栏里「可以归档」的条目（已排除运行中、等回复、出错、未读、置顶和已归档的），
  // context(item) 给出 folder / group / activity（团队负责人并入成员）。
  function openDialog({ candidates, context = () => ({}), notify = () => {} }) {
    const doc = document;
    const previous = doc.querySelector('dialog.sidebar-archive-dialog');
    if (previous) { previous.focus(); return Promise.resolve(false); }
    const rule = { ...archiveRules.DEFAULT_RULE, ...(state.auto || {}) };
    let preset = PRESETS.find(p => p.hours === rule.hours)?.key || 'custom';
    let customValue = rule.hours % 24 === 0 ? rule.hours / 24 : rule.hours, customUnit = rule.hours % 24 === 0 ? 'day' : 'hour';
    const dialog = doc.createElement('dialog');
    dialog.className = 'hub-dialog sidebar-archive-dialog';
    dialog.setAttribute('aria-labelledby', 'sidebar-archive-title');
    dialog.innerHTML = `
      <header class="sa-head">
        <div class="hub-dialog-icon sa-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h16v3H4z"/><path d="M5.5 10v8.5h13V10"/><path d="M10 13.5h4"/></svg></div>
        <div><h2 id="sidebar-archive-title">一键归档</h2>
        <p class="sa-sub">把一段时间没动过的会话收进「归档」，内容全部保留；再发消息会自动回到侧栏。</p></div>
      </header>
      <section class="sa-block">
        <div class="sa-label">没动过多久</div>
        <div class="sa-seg" role="radiogroup" aria-label="没动过多久">${PRESETS.map(p => `<button type="button" role="radio" data-preset="${p.key}">${p.label}</button>`).join('')}</div>
        <div class="sa-custom" hidden>
          <span>超过</span><input type="number" min="1" max="365" step="1" aria-label="自定义时长">
          <select aria-label="单位"><option value="hour">小时</option><option value="day">天</option></select>
        </div>
      </section>
      <section class="sa-block">
        <div class="sa-label">归档准则</div>
        <label class="sa-check sa-locked"><input type="checkbox" checked disabled><span>运行中、等待回复、出错的会话<small>始终保留</small></span></label>
        <label class="sa-check sa-locked"><input type="checkbox" checked disabled><span>有未读回复、已置顶的会话<small>始终保留</small></span></label>
        <label class="sa-check"><input type="checkbox" data-rule="keepGroups"><span>保留群聊和团队</span></label>
        <label class="sa-check"><input type="checkbox" data-rule="keepFoldered"><span>保留已放进目录的会话</span></label>
      </section>
      <section class="sa-preview" aria-live="polite">
        <div class="sa-count"><strong>0</strong><span>个会话将归档</span></div>
        <ul class="sa-list"></ul>
      </section>
      <label class="sa-check sa-auto"><input type="checkbox" data-auto><span>以后按此规则自动归档<small>默认关闭；关闭时只有点这里才会归档</small></span></label>
      <p class="sa-error" role="alert"></p>
      <footer class="hub-dialog-actions">
        <button type="button" class="hub-button" data-act="cancel">取消</button>
        <button type="button" class="hub-button hub-button-primary" data-act="apply">归档</button>
      </footer>`;
    const $ = selector => dialog.querySelector(selector);
    const segButtons = [...dialog.querySelectorAll('[data-preset]')];
    const customBox = $('.sa-custom'), customInput = $('.sa-custom input'), customSelect = $('.sa-custom select');
    const keepGroups = $('[data-rule="keepGroups"]'), keepFoldered = $('[data-rule="keepFoldered"]'), autoBox = $('[data-auto]');
    const countEl = $('.sa-count strong'), listEl = $('.sa-list'), errorEl = $('.sa-error'), apply = $('[data-act="apply"]');
    keepGroups.checked = rule.keepGroups; keepFoldered.checked = rule.keepFoldered; autoBox.checked = !!state.auto?.enabled;
    customInput.value = String(customValue); customSelect.value = customUnit;
    const autoWasOn = !!state.auto?.enabled;

    function currentRule() {
      const chosen = PRESETS.find(p => p.key === preset);
      let hours = chosen?.hours;
      if (!hours) {
        const value = Math.round(Number(customInput.value));
        hours = customSelect.value === 'day' ? value * 24 : value;
      }
      return { hours, keepGroups: keepGroups.checked, keepFoldered: keepFoldered.checked };
    }
    let matched = [];
    const matching = (current, now = Date.now()) => candidates().map(item => ({ item, ctx: context(item) || {} }))
      .filter(({ item, ctx }) => archiveRules.matchesRule(item, { now, rule: current, folder: ctx.folder ?? null, activity: ctx.activity ?? null, group: ctx.group ?? null }))
      .sort((a, b) => (a.ctx.activity ?? latestActivityTime(a.item)) - (b.ctx.activity ?? latestActivityTime(b.item)));
    function update() {
      for (const button of segButtons) button.setAttribute('aria-checked', String(button.dataset.preset === preset));
      customBox.hidden = preset !== 'custom';
      errorEl.textContent = '';
      let current;
      try { current = archiveRules.cleanRule(currentRule()); }
      catch (failure) { errorEl.textContent = failure.message; matched = []; countEl.textContent = '–'; listEl.innerHTML = ''; apply.disabled = true; return; }
      const now = Date.now();
      matched = matching(current, now);
      countEl.textContent = String(matched.length);
      listEl.innerHTML = '';
      for (const { item, ctx } of matched.slice(0, PREVIEW_ROWS)) {
        const li = doc.createElement('li');
        const title = doc.createElement('span'); title.className = 'sa-item-title'; title.textContent = item.title || item.id;
        const meta = doc.createElement('span'); meta.className = 'sa-item-meta';
        meta.textContent = (item._isMeeting ? '群聊 · ' : ctx.group ? '团队 · ' : '') + idleLabel(now - (ctx.activity ?? latestActivityTime(item)));
        li.append(title, meta); listEl.appendChild(li);
      }
      if (matched.length > PREVIEW_ROWS) {
        const more = doc.createElement('li'); more.className = 'sa-more'; more.textContent = `还有 ${matched.length - PREVIEW_ROWS} 个`; listEl.appendChild(more);
      }
      if (!matched.length) {
        const empty = doc.createElement('li'); empty.className = 'sa-empty'; empty.textContent = '没有符合条件的会话'; listEl.appendChild(empty);
      }
      const autoChanged = autoBox.checked !== autoWasOn || (autoBox.checked && JSON.stringify(current) !== JSON.stringify(archiveRules.cleanRule(state.auto)));
      apply.disabled = !matched.length && !autoChanged;
      apply.textContent = matched.length ? `归档 ${matched.length} 个` : autoChanged ? '保存设置' : '归档';
    }
    for (const button of segButtons) button.addEventListener('click', () => {
      preset = button.dataset.preset; update();
      if (preset === 'custom') customInput.focus();
    });
    dialog.addEventListener('keydown', event => {
      const index = segButtons.indexOf(doc.activeElement);
      if (index < 0 || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const next = segButtons[(index + (event.key === 'ArrowRight' ? 1 : -1) + segButtons.length) % segButtons.length];
      preset = next.dataset.preset; update(); next.focus();
    });
    for (const input of [customInput, customSelect, keepGroups, keepFoldered, autoBox]) input.addEventListener(input === customInput ? 'input' : 'change', update);

    return new Promise(resolve => {
      let busy = false, settled = false;
      const trigger = doc.activeElement;
      const close = result => {
        if (settled) return; settled = true;
        if (dialog.open) dialog.close();
        dialog.remove(); trigger?.focus?.({ preventScroll: true }); resolve(result);
      };
      const cancel = $('[data-act="cancel"]');
      cancel.addEventListener('click', () => { if (!busy) close(false); });
      dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) close(false); });
      apply.addEventListener('click', async () => {
        if (busy) return;
        busy = true; apply.disabled = true; cancel.disabled = true; errorEl.textContent = '';
        try {
          const current = archiveRules.cleanRule(currentRule());
          // 提交时按此刻重新筛一遍：预览打开期间有新来往、开始运行或有了未读的，不归。
          const keys = matching(current).map(({ item }) => archiveRules.entityKey(item));
          // 开关状态和这次选的时长、准则一起存：自动归档照它执行，关着时下次打开弹窗沿用。
          await mutate('set-auto', { enabled: autoBox.checked, rule: current });
          if (keys.length) await mutate('archive', { keys });
          const parts = [];
          if (keys.length) parts.push(`已归档 ${keys.length} 个会话，可在侧栏底部「查看归档」里找回`);
          if (autoBox.checked && !autoWasOn) parts.push('已开启自动归档');
          if (!autoBox.checked && autoWasOn) parts.push('已关闭自动归档');
          if (parts.length) notify(parts.join('；'));
          close(true);
        } catch (failure) { errorEl.textContent = failure.message; apply.disabled = false; cancel.disabled = false; }
        finally { busy = false; }
      });
      doc.body.appendChild(dialog);
      update();
      try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
      (segButtons.find(b => b.dataset.preset === preset) || segButtons[0]).focus();
    });
  }

  return {
    refresh,
    loaded: () => loaded,
    error: () => error,
    signature: () => revision,
    getState: () => state,
    isArchived,
    recordOf,
    archive: keys => mutate('archive', { keys }),
    // 先在本地删掉记录（侧栏当轮就把它放回），保存失败再重读一次。
    async restore(keys) {
      let changed = false;
      for (const key of Array.isArray(keys) ? keys : []) if (state.records[key]) { state = { ...state, records: { ...state.records } }; delete state.records[key]; changed = true; }
      if (changed) { revision++; onChange(); }
      try { return await mutate('restore', { keys }); }
      catch (failure) { await refresh(); throw failure; }
    },
    setAuto: (enabled, rule) => mutate('set-auto', { enabled, rule }),
    openDialog,
  };
}

module.exports = { createSidebarArchiveController, PRESETS, idleLabel };
