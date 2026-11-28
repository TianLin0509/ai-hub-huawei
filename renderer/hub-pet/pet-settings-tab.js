'use strict';
// 「助理 → 设置 → 桌宠」分页的内容（2026-10-17 用户：在这里选形象、下载更多形象、定桌宠的行为）。
// 助理设置面板建好「桌宠」分页后调用 mountPetSettingsTab(空容器, { ipcRenderer, window, document })。
// 所有改动立即生效（写桌宠自己的 hub-pet.json），不等面板的「保存」；联网只发生在用户点「下载 / 检查新形象」时。

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
const kb = n => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
// 桌面回执三档（2026-11-11），与 Hub 配置里的「桌面回执」是同一个设置。
const NOTIFY_OPTIONS = [{ id: 'pet', label: '交给桌宠' }, { id: 'popup', label: '右下角小卡' }, { id: 'off', label: '关闭' }];
const NOTIFY_NOTES = { pet: '会话答完、联动消息由桌宠举卡片告诉你，点卡片直接打开；桌宠没开时用右下角小卡', popup: '一律弹右下角小卡，桌宠不举卡片', off: '都不弹，只留到点提醒、出错这类要紧的；左栏未读照常标' };
const MODE_NOTES = { lively: '提醒之外，早上问候、久坐提醒也会说', gentle: '只说助理的提醒', quiet: '不开口，只亮小圆点' };
// 起名与回应（2026-11-17 r27g）：名字用在气泡里；闲聊气泡下的回应按钮记下的偏好可以一键忘掉。
const TALK_TYPES = { care: '关心作息', cheer: '打气', chat: '闲聊' };
function talkNote(prefs) {
  const less = Object.entries(TALK_TYPES).filter(([k]) => prefs && prefs[k] && prefs[k].down > 0).map(([k, label]) => label + ' ' + prefs[k].down + ' 次');
  return less.length ? '你点过「少说」：' + less.join('、') + '，这几类会说得少些' : '活泼档的闲聊气泡下有回应按钮，点「少说」它就记住';
}

function mountPetSettingsTab(container, { ipcRenderer, window, document }) {
  if (!container || !ipcRenderer) return { refresh: () => {} };
  let data = null;        // hub-pet:get-settings 的结果
  let packs = null;       // hub-pet:roles 的结果（含下载状态）
  let busy = false;
  // 保存没成功（2026-11-21）：原因写在出事的那个开关旁边（替换那一行的说明小字），下次存好就清掉。
  const { saveFailureText } = require('./pet-save-status');
  let saveError = '', saveAnchor = '';
  // 用户每次亲手换形象就加一；下载完成时只有这个数没变、形象也还是开始下载时那个，才自动换上（下载晚到不覆盖之后的选择）。
  let roleChoices = 0;

  container.classList.add('pet-tab');
  container.innerHTML = '<p class="pet-tab-note">正在读取桌宠设置…</p>';

  // r58：有可下载/可更新的形象时，显示公司内源状态。
  const sourceView = require('../download-source-view');
  function render() {
    if (!data) return;
    if (!data.available) { container.innerHTML = '<p class="pet-tab-note">这个版本没有桌宠。</p>'; return; }
    const s = data.settings;
    const st = (packs && packs.state) || {};
    const roles = (packs && packs.roles) || data.roles || [];
    const activeId = st.phase === 'downloading' ? st.activeId : null;
    const pct = st.progress && st.progress.total ? Math.min(100, Math.round(st.progress.received / st.progress.total * 100)) : 0;
    const card = r => {
      const current = r.installed && r.id === s.role;
      let status, action = '';
      if (r.id === activeId) {
        status = `下载中 ${pct}%`;
        action = `<span class="pet-tab-bar"><i style="width:${pct}%"></i></span>`;
      } else if (current && r.update) {
        // 使用中的形象也要能更新（r27i 审查：先判 current 会吞掉「更新」按钮）。
        status = '使用中 · 有新版本'; action = `<button type="button" class="pet-tab-mini" data-pet="download" data-id="${esc(r.id)}">更新</button>`;
      } else if (current) status = '使用中';
      else if (r.installed && r.update) { status = '有新版本'; action = `<button type="button" class="pet-tab-mini" data-pet="download" data-id="${esc(r.id)}">更新</button>`; }
      else if (r.installed) status = r.bundled ? '内置 · 点击使用' : '已安装 · 点击使用';
      else if (st.failedId === r.id) { status = '下载没成功'; action = `<button type="button" class="pet-tab-mini" data-pet="download" data-id="${esc(r.id)}">重试</button>`; }
      else { status = r.bytes ? `可下载 · ${kb(r.bytes)}` : '可下载'; action = `<button type="button" class="pet-tab-mini primary" data-pet="download" data-id="${esc(r.id)}"${activeId ? ' disabled' : ''}>下载</button>`; }
      const img = r.previewMain ? `<img src="${esc(r.previewMain)}" alt="" draggable="false">` : '<span class="pet-tab-noimg"></span>';
      return `<div class="pet-tab-card${current ? ' current' : ''}${r.installed ? ' installed' : ' remote'}" data-role="${esc(r.id)}"${r.installed && !current ? ' role="button" tabindex="0" title="点击换成' + esc(r.name) + '"' : ''}>
          <div class="pet-tab-pic">${img}${current ? '<span class="pet-tab-check" aria-hidden="true"></span>' : ''}</div>
          <b>${esc(r.name)}</b><span class="pet-tab-status">${esc(status)}</span>${action}${r.credit ? `<button type="button" class="pet-tab-credit" data-pet="credit" data-id="${esc(r.id)}">形象来源与授权</button>` : ''}</div>`;
    };
    const checking = st.phase === 'checking';
    const checkNote = checking ? '正在连接形象目录…' : st.phase === 'error' && !st.failedId ? st.error : '';
    const modes = data.modes || [];
    // 重画时保住名字输入框里正在打的字（下载进度推送会触发重画）。
    const nameEl = container.querySelector('input[data-pet-name]');
    const typing = nameEl && document.activeElement === nameEl ? { value: nameEl.value, start: nameEl.selectionStart, end: nameEl.selectionEnd } : null;
    const hasPrefs = s.talkPrefs && Object.values(s.talkPrefs).some(p => p && (p.up > 0 || p.down > 0));
    container.innerHTML = `
      <div class="pet-tab-row pet-tab-top">
        <div><b>在桌面显示桌宠</b><small>Hub 开着时待在屏幕右下角；会话答完、提醒、会议室结果都由它告诉你，右键还能直接问助理。</small></div>
        <label class="pet-tab-switch"><input type="checkbox" data-pet="enabled"${s.enabled ? ' checked' : ''}><span></span></label>
      </div>
      <div class="pet-tab-head"><h4>形象</h4><span class="pet-tab-note${st.phase === 'error' && !st.failedId ? ' bad' : ''}">${esc(checkNote)}</span>
        <button type="button" class="pet-tab-mini" data-pet="check"${checking || activeId ? ' disabled' : ''}>检查新形象</button></div>
      ${roles.some(r => !r.installed || r.update) ? sourceView.slotHtml('pet-role') : ''}
      ${st.failedId && st.error ? `<p class="pet-tab-note bad">${esc(st.error)}</p>` : ''}
      ${activeId ? require('../download-progress-view').html({ ...(st.progress || {}), phase: st.progress && st.progress.total ? 'downloading' : 'connecting' }, { title: `下载桌宠形象「${(roles.find(r => r.id === activeId) || {}).name || activeId}」` }) : ''}
      <div class="pet-tab-grid${roles.length > 6 ? ' compact' : ''}">${roles.map(card).join('')}</div>
      <div class="pet-tab-row">
        <div><b>大小与位置</b><small>拖动滑块调大小，脚的位置不动；拖到哪里就记住哪里。</small></div>
        <div class="pet-tab-size"><input type="range" min="${SIZE_MIN}" max="${SIZE_MAX}" step="1" value="${sizePct(s.scale)}" data-pet-size aria-label="桌宠大小"><span data-pet-size-label>${sizePct(s.scale)}%</span>
          <button type="button" class="pet-tab-mini" data-pet="sizeReset"${sizePct(s.scale) === 100 ? ' disabled' : ''}>原大小</button>
          <button type="button" class="pet-tab-mini" data-pet="resetPosition"${s.enabled ? '' : ' disabled'}>回到右下角</button></div>
      </div>
      <div class="pet-tab-row">
        <div><b>说话频率</b><small>${esc(MODE_NOTES[s.mode] || '')}；提醒每小时最多开口 3 次，通知卡片不受限。</small></div>
        <div class="pet-tab-seg" role="radiogroup" aria-label="说话频率">${modes.map(m => `<button type="button" role="radio" aria-checked="${m.id === s.mode}" data-pet="mode" data-id="${esc(m.id)}"${m.id === s.mode ? ' class="on"' : ''}>${esc(m.label)}</button>`).join('')}</div>
      </div>
      <!-- r27f2（2026-11-17）：r27g 加了「名字」一行后整页超出一屏 32px，「名字」和「暂时别说话」并成一行两半（1440×900 仍不出滚动）。 -->
      <div class="pet-tab-row pet-tab-duo">
        <div class="pet-tab-half pet-tab-wide">
          <div><b>名字</b><small>${esc(talkNote(s.talkPrefs))}。</small></div>
          <div class="pet-tab-pair">
            <input type="text" class="pet-tab-name" data-pet-name maxlength="8" placeholder="不起名" value="${esc(s.petName || '')}" aria-label="桌宠的名字">
            <button type="button" class="pet-tab-mini" data-pet="saveName">保存</button>
            <button type="button" class="pet-tab-mini" data-pet="resetTalk"${hasPrefs ? '' : ' disabled'} title="清空回应偏好和说过的句子">忘掉我的回应</button>
          </div>
        </div>
        <div class="pet-tab-half">
          <div><b>暂时别说话</b><small>到点自动恢复，提醒收进小圆点。</small></div>
          <div class="pet-tab-pair">
            <button type="button" class="pet-tab-toggle${data.quietHour ? ' on' : ''}" aria-pressed="${!!data.quietHour}" data-pet="quietHour">安静一小时</button>
            <button type="button" class="pet-tab-toggle${data.silentToday ? ' on' : ''}" aria-pressed="${!!data.silentToday}" data-pet="silentToday">今天别说话</button>
          </div>
        </div>
      </div>
      <div class="pet-tab-row">
        <div><b>桌面回执</b><small>${esc(NOTIFY_NOTES[s.notifyMode] || NOTIFY_NOTES.pet)}。</small></div>
        <div class="pet-tab-seg" role="radiogroup" aria-label="桌面回执">${NOTIFY_OPTIONS.map(m => `<button type="button" role="radio" aria-checked="${m.id === s.notifyMode}" data-pet="notifyMode" data-id="${esc(m.id)}"${m.id === s.notifyMode ? ' class="on"' : ''}>${esc(m.label)}</button>`).join('')}</div>
      </div>
      <!-- r27f（2026-11-17）：多了「单击只逗它」「任务栏走走」两个开关，三个旧开关并成一行三列，整页仍是一屏（1440×900）。 -->
      <div class="pet-tab-row pet-tab-duo">
        <div class="pet-tab-half">
          <div><b>会话在跑时陪着干活</b><small>有会话在跑就敲键盘，标出在跑几个。</small></div>
          <label class="pet-tab-switch"><input type="checkbox" data-pet="followSessions"${s.followSessions !== false ? ' checked' : ''}><span></span></label>
        </div>
        <div class="pet-tab-half">
          <div><b>身上显示等级</b><small>等级角标，每10级进化一次。</small></div>
          <label class="pet-tab-switch"><input type="checkbox" data-pet="showGrowth"${s.showGrowth !== false ? ' checked' : ''}><span></span></label>
        </div>
        <div class="pet-tab-half">
          <div><b>全屏时躲到屏幕边</b><small>演示、看视频时缩到右边只露一点。</small></div>
          <label class="pet-tab-switch"><input type="checkbox" data-pet="peekOnFullscreen"${s.peekOnFullscreen !== false ? ' checked' : ''}><span></span></label>
        </div>
      </div>
      <div class="pet-tab-row pet-tab-duo">
        <div class="pet-tab-half">
          <div><b>单击只逗它</b><small>按住抱抱；关掉＝单击就打开助理。</small></div>
          <label class="pet-tab-switch"><input type="checkbox" data-pet="clickPlay"${s.clickMode !== 'open' ? ' checked' : ''}><span></span></label>
        </div>
        <div class="pet-tab-half">
          <div><b>双击记待办</b><small>弹出待办小卡片；关掉＝双击打开助理。</small></div>
          <label class="pet-tab-switch"><input type="checkbox" data-pet="dblTodo"${s.dblClick !== 'assistant' ? ' checked' : ''}><span></span></label>
        </div>
        <div class="pet-tab-half">
          <div><b>偶尔在任务栏上走走</b><small>十来分钟踱几步，只走桌面空白处。</small></div>
          <label class="pet-tab-switch"><input type="checkbox" data-pet="walk"${s.walk !== false ? ' checked' : ''}><span></span></label>
        </div>
      </div>`;
    if (container.querySelector('[data-dl-source]')) void sourceView.fill(container, { ipcRenderer }).catch(() => {});
    if (typing) {
      const el = container.querySelector('input[data-pet-name]');
      if (el) { el.value = typing.value; el.focus(); try { el.setSelectionRange(typing.start, typing.end); } catch (_) {} }
    }
    paintSaveError();
  }
  // 找到出事的开关所在那一行，用红字换掉说明小字；找不到（如换形象）就写在「形象」标题旁。
  function paintSaveError() {
    if (!saveError) return;
    const anchor = saveAnchor && container.querySelector(saveAnchor);
    const row = anchor && anchor.closest('.pet-tab-half, .pet-tab-row');
    const small = row && row.querySelector('small');
    const slot = small || container.querySelector('.pet-tab-head .pet-tab-note');
    if (!slot) return;
    slot.textContent = saveError;
    slot.classList.add('bad', 'pet-tab-save-error');
    slot.setAttribute('role', 'alert');
  }

  // 大小滑块（2026-10-18 用户：连续调）：拖动时边拖边改（约 60ms 一次，不重画分页免得打断拖动）。
  // 拖动中带 live：主进程只改内存、实时挪窗口，不写盘；松手（change）再发一次不带 live 的，只写这一次。
  const SIZE_MIN = 60, SIZE_MAX = 160;
  const sizePct = v => Math.round((Number(v) || 1) * 100);
  let sizeTimer = null, sizeWant = null, sizeSent = null;
  const sendSize = () => { if (sizeWant == null || sizeWant === sizeSent) return; sizeSent = sizeWant; void ipcRenderer.invoke('hub-pet:set-settings', { scale: sizeWant / 100, live: true }).catch(() => {}); };
  function pushSize(final) {
    if (final) {
      clearTimeout(sizeTimer); sizeTimer = null;
      sizeSent = null;
      const done = (next, error) => { if (next) data = next; saveError = saveFailureText(next, error); saveAnchor = saveError ? '[data-pet-size]' : ''; render(); };
      void ipcRenderer.invoke('hub-pet:set-settings', { scale: sizeWant / 100 }).then(next => done(next, null), error => done(null, error));
      return;
    }
    if (sizeTimer) return;
    sendSize();
    sizeTimer = setTimeout(function tick() { sizeTimer = null; if (sizeWant !== sizeSent) { sendSize(); sizeTimer = setTimeout(tick, 60); } }, 60);
  }
  async function refresh() {
    try {
      const [settings, roles] = await Promise.all([ipcRenderer.invoke('hub-pet:get-settings'), ipcRenderer.invoke('hub-pet:roles')]);
      data = settings; packs = roles || packs; render();
    } catch (error) { container.innerHTML = `<p class="pet-tab-note bad">读取桌宠设置失败：${esc(error.message)}</p>`; }
  }
  // anchor：触发这次保存的控件选择器，没存上时原因写在它旁边。
  async function save(patch, anchor = '') {
    if (busy) return;
    busy = true;
    let next = null, failure = null;
    try { next = await ipcRenderer.invoke('hub-pet:set-settings', patch); if (next) data = next; }
    catch (error) { failure = error; }
    try { packs = (await ipcRenderer.invoke('hub-pet:roles')) || packs; } catch (_) { /* 形象列表下次再读 */ }
    saveError = saveFailureText(next, failure); saveAnchor = saveError ? anchor : '';
    busy = false; render();
  }

  container.addEventListener('click', event => {
    const btn = event.target.closest('[data-pet]');
    if (btn && !btn.disabled) {
      const kind = btn.dataset.pet;
      const at = `[data-pet="${kind}"]`;
      if (kind === 'mode') return void save({ mode: btn.dataset.id }, at);
      if (kind === 'notifyMode') return void save({ notifyMode: btn.dataset.id }, at);
      if (kind === 'quietHour') return void save({ quietHour: !data.quietHour }, at);
      if (kind === 'silentToday') return void save({ silentToday: !data.silentToday }, at);
      if (kind === 'resetPosition') return void save({ resetPosition: true }, at);
      if (kind === 'sizeReset') return void save({ scale: 1 }, at);
      if (kind === 'saveName') return void saveName();
      if (kind === 'resetTalk') return void save({ resetTalk: true }, at);
      if (kind === 'credit') { const r = ((packs && packs.roles) || (data && data.roles) || []).find(x => x.id === btn.dataset.id); if (r && r.credit) showCredit(r); return; }
      if (kind === 'check') { void ipcRenderer.invoke('hub-pet:roles-check').then(r => { if (r) packs = r; render(); }); return; }
      if (kind === 'download') {
        // 下好就直接换上（2026-11-28 真机：下完还得再点一次卡片，用户以为没换成功）；没下成照旧只刷新。
        const id = btn.dataset.id, choiceAtStart = roleChoices, roleAtStart = data?.settings?.role;
        void ipcRenderer.invoke('hub-pet:role-download', id).then(async r => {
          if (r) packs = r;
          data = (await ipcRenderer.invoke('hub-pet:get-settings')) || data;
          // 只认这一次下载成功（不凭旧的 installed：更新失败时旧版仍算已装）。
          const done = r?.state?.phase === 'installed' && r.state.installedId === id;
          const untouched = roleChoices === choiceAtStart && data?.settings?.role === roleAtStart;
          if (done && untouched && data?.settings?.role !== id) return void save({ role: id });
          render();
        });
        return;
      }
      return;
    }
    const cardEl = event.target.closest('.pet-tab-card.installed:not(.current)');
    if (cardEl) { roleChoices++; void save({ role: cardEl.dataset.role }); }
  });
  // 形象来源与授权（2026-11-18 r49b）：拟人形象来自社区作者，按协议要署名、写明改动、附协议全文。
  // 全部按纯文本放进去（textContent），网址只显示、可选中复制，不在 Hub 里打开。
  function showCredit(r) {
    const c = r.credit;
    const old = document.querySelector('.pet-credit-mask');
    if (old) old.remove();
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const mask = el('div', 'pet-credit-mask');
    const box = el('div', 'pet-credit');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', r.name + ' 的形象来源与授权');
    const head = el('div', 'pet-credit-head');
    head.append(el('b', '', r.name + ' · 形象来源与授权'));
    const close = el('button', 'pet-tab-mini', '关闭'); close.type = 'button'; close.dataset.creditClose = '1';
    head.append(close);
    box.append(head, el('p', 'pet-credit-summary', c.summary));
    const body = el('div', 'pet-credit-body');
    const section = (title, nodes) => { if (!nodes.length) return; const sec = el('section'); sec.append(el('h5', '', title), ...nodes); body.append(sec); };
    const link = u => (u ? [el('span', 'pet-credit-url', u)] : []);
    section('作者', (c.authors || []).map(a => { const p = el('p'); p.append(el('b', '', a.name), el('span', '', a.role ? '：' + a.role : ''), ...link(a.url)); return p; }));
    if (c.license) { const p = el('p'); p.append(el('span', '', c.license.name), ...link(c.license.url)); section('协议', [p]); }
    section('作者原话', (c.terms || []).map(t => { const p = el('p'); p.append(el('q', '', t.quote), el('small', '', t.source ? '—— ' + t.source : ''), ...link(t.url)); return p; }));
    if (c.changes) section('本形象包的改动', [el('p', '', c.changes)]);
    if (c.note) section('说明', [el('p', '', c.note)]);
    if (c.legal) section('协议全文', [el('pre', 'pet-credit-legal', c.legal)]);
    else if (!c.full) section('协议全文', [el('p', 'pet-credit-muted', '下载这个形象后可在这里看完整的署名、条款原话和协议全文。')]);
    box.append(body);
    mask.append(box);
    mask.addEventListener('click', e => { if (e.target === mask || (e.target.dataset && e.target.dataset.creditClose)) mask.remove(); });
    mask.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); mask.remove(); } });
    document.body.append(mask);
    close.focus();
  }
  function saveName() {
    const el = container.querySelector('input[data-pet-name]');
    if (el) void save({ petName: el.value }, '[data-pet="saveName"]');
  }
  // 中文输入法：确认候选字的那一下 Enter 属于输入法（isComposing / keyCode 229），不算提交；
  // 有的环境在 compositionend 之后紧跟一个 Enter，也一并放过，下一次 Enter 再保存（r27g 审查第 2 项）。
  let nameComposing = false;
  container.addEventListener('compositionstart', event => { if (event.target.closest && event.target.closest('input[data-pet-name]')) nameComposing = true; });
  container.addEventListener('compositionend', event => { if (event.target.closest && event.target.closest('input[data-pet-name]')) setTimeout(() => { nameComposing = false; }, 0); });
  container.addEventListener('keydown', event => {
    if (event.target.closest && event.target.closest('input[data-pet-name]')) {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !nameComposing) { event.preventDefault(); saveName(); }
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('button')) return;   // 卡片里的按钮（下载、形象来源）回车走按钮自己的点击，不顺带换形象
    const cardEl = event.target.closest('.pet-tab-card.installed:not(.current)');
    if (cardEl) { event.preventDefault(); roleChoices++; void save({ role: cardEl.dataset.role }); }
  });
  container.addEventListener('input', event => {
    const range = event.target.closest('input[data-pet-size]');
    if (!range) return;
    const label = container.querySelector('[data-pet-size-label]');
    if (label) label.textContent = range.value + '%';
    sizeWant = Number(range.value);
    pushSize(false);
  });
  container.addEventListener('change', event => {
    const range = event.target.closest('input[data-pet-size]');
    if (range) { sizeWant = Number(range.value); pushSize(true); return; }
    if (event.target.closest('input[data-pet-name]')) return;   // 名字点「保存」或回车才存
    const input = event.target.closest('input[data-pet]');
    if (input) void save({ [input.dataset.pet]: input.checked }, `input[data-pet="${input.dataset.pet}"]`);
  });
  // 下载进度：主进程每有进展就推一次。分页被拆掉后（面板关了又重建）第一次收到推送时退订。
  let seen = false;
  const onState = (_event, snap) => {
    if (container.isConnected) seen = true;
    else if (seen) { ipcRenderer.removeListener?.('hub-pet:roles-state', onState); return; }
    if (snap) packs = snap;
    render();
  };
  ipcRenderer.on('hub-pet:roles-state', onState);
  // 在桌宠右键菜单里换了形象、说话频率或安静开关，分页跟着变。
  const onChanged = () => { if (!container.isConnected) { ipcRenderer.removeListener?.('hub-pet:settings-changed', onChanged); return; } void refresh(); };
  ipcRenderer.on('hub-pet:settings-changed', onChanged);

  refresh();
  return { refresh };
}

module.exports = { mountPetSettingsTab };
