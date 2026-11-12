'use strict';
// Hub「配置」里的桌宠设置，以及桌宠 → Hub 的入口事件。
// 设置改了立即生效（不等「保存」按钮）：开关、角色、说话频率都直接写桌宠自己的 hub-pet.json。
// 点桌宠或右键菜单里的事项时，主进程把 Hub 拉到前台并发 hub-pet:open-assistant；
// 这里转成 window 上的同名 CustomEvent，detail 为 { source, action?, prompt?, noticeId?, sessionId? }，由助理页接住。

function mountHubPetSettings({ document, window, ipcRenderer }) {
  ipcRenderer.on('hub-pet:open-assistant', (_event, payload) => {
    try { window.dispatchEvent(new window.CustomEvent('hub-pet:open-assistant', { detail: payload || {} })); } catch (_) {}
  });
  // 桌宠卡片指向某一页（2026-11-09）：会议室结果 → 会议室页；助理答好了 → 助理页。按左栏按钮打开，和用户自己点一样。
  const PAGE_BUTTON = { rooms: 'btn-company-rooms', meeting: 'btn-company-meeting', attendance: 'btn-company-attendance' };
  ipcRenderer.on('hub-pet:open-page', (_event, payload = {}) => {
    const page = String(payload.page || '');
    if (page === 'assistant') {
      try { window.dispatchEvent(new window.CustomEvent('hub-pet:open-assistant', { detail: { source: 'pet', ...(payload.noticeId ? { noticeId: String(payload.noticeId) } : {}) } })); } catch (_) {}
      return;
    }
    if (page === 'disk') { try { window.__hubOpenDiskRelease?.(); } catch (_) {} return; }
    if (page === 'update') { try { window.__appUpdate?.open?.(); } catch (_) {} return; }
    const button = PAGE_BUTTON[page] && document.getElementById(PAGE_BUTTON[page]);
    if (button) button.click();
  });

  // renderer.js 在配置弹窗的标记之前加载，等 DOM 建好再挂。
  if (!document.getElementById('config-main-view') && document.readyState === 'loading') {
    const api = { refresh: () => {} };
    document.addEventListener('DOMContentLoaded', () => { const mounted = mountSection({ document, window, ipcRenderer }); if (mounted) api.refresh = mounted.refresh; }, { once: true });
    return api;
  }
  return mountSection({ document, window, ipcRenderer });
}

function mountSection({ document, window, ipcRenderer }) {
  const host = document.getElementById('config-main-view');
  if (!host) return null;
  const section = document.createElement('div');
  section.id = 'cfg-hub-pet';
  section.hidden = true;
  section.innerHTML = [
    '<div class="config-section-label"><span>助理桌宠</span><span>立即生效</span></div>',
    '<div class="config-operations-card">',
    '  <label class="config-toggle-row" for="cfg-hub-pet-enabled">',
    '    <input type="checkbox" id="cfg-hub-pet-enabled">',
    '    <span><strong>在桌面角落显示桌宠</strong><small>Hub 开着时出现；会话答完、提醒都由它告诉你，点卡片直接打开。右键可问助理，或让它安静一小时。</small></span>',
    '  </label>',
    '  <div class="config-reading-grid">',
    '    <div class="config-field"><label for="cfg-hub-pet-role">角色</label><select id="cfg-hub-pet-role"></select></div>',
    '    <div class="config-field"><label for="cfg-hub-pet-mode">说话频率</label><select id="cfg-hub-pet-mode"></select></div>',
    '  </div>',
    '  <p class="config-reading-note">温和：只说助理的提醒；活泼：再加早上问候、久坐提醒；安静：只亮小圆点。每小时最多开口 3 次。</p>',
    '</div>',
  ].join('\n');
  const proxyField = host.querySelector('.config-field');
  if (proxyField && proxyField.nextSibling) host.insertBefore(section, proxyField.nextSibling);
  else host.appendChild(section);

  // 桌面回执（2026-11-11 用户：右下角回执太烦，要能缩小、交给桌宠或关掉）。和桌宠设置里的「桌面回执」是同一项，立即生效。
  const notifySection = document.createElement('div');
  notifySection.id = 'cfg-notify-mode-section';
  notifySection.innerHTML = [
    '<div class="config-section-label"><span>桌面回执</span><span>会话答完、提醒弹在哪 · 立即生效</span></div>',
    '<div class="config-field">',
    '  <select id="cfg-notify-mode" aria-label="桌面回执">',
    '    <option value="pet">交给桌宠（推荐）：桌宠开着由它举卡片，没开时弹右下角小卡</option>',
    '    <option value="popup">右下角小卡：一律弹右下角，桌宠不举卡片</option>',
    '    <option value="off">关闭：都不弹，只留到点提醒、出错这类要紧的</option>',
    '  </select>',
    '  <p class="config-reading-note" id="cfg-notify-mode-note">左栏的未读标记不受影响；小卡右上角的齿轮也能回到这里。</p>',
    '</div>',
  ].join('\n');
  const notifyAnchor = host.querySelector('.config-notification-title');
  if (notifyAnchor) host.insertBefore(notifySection, notifyAnchor);
  else host.appendChild(notifySection);
  const notifyEl = notifySection.querySelector('#cfg-notify-mode');
  const notifyNote = notifySection.querySelector('#cfg-notify-mode-note');

  const enabledEl = section.querySelector('#cfg-hub-pet-enabled');
  const roleEl = section.querySelector('#cfg-hub-pet-role');
  const modeEl = section.querySelector('#cfg-hub-pet-mode');

  function fill(data) {
    if (data && data.settings) {
      notifyEl.value = data.settings.notifyMode || 'pet';
      const petOff = notifyEl.value === 'pet' && !(data.available && data.settings.enabled);
      notifyNote.textContent = petOff
        ? (data.available ? '桌宠现在没开，先用右下角小卡；在本页「助理桌宠」打开后改由桌宠说。' : '这个版本没有桌宠，先用右下角小卡。')
        : '左栏的未读标记不受影响；小卡右上角的齿轮也能回到这里。';
    }
    if (!data || !data.available) { section.hidden = true; return; }
    section.hidden = false;
    // 只列这台电脑上装了的形象（其余在「助理 → 设置 → 桌宠」里下载）；下载后再打开要能看到新的。
    roleEl.textContent = '';
    for (const r of data.roles.filter(x => x.installed !== false)) roleEl.add(new window.Option(r.name, r.id));
    if (!modeEl.options.length) for (const m of data.modes) modeEl.add(new window.Option(m.label, m.id));
    enabledEl.checked = !!data.settings.enabled;
    roleEl.value = data.settings.role;
    modeEl.value = data.settings.mode;
  }
  async function refresh() { try { fill(await ipcRenderer.invoke('hub-pet:get-settings')); } catch (_) {} }
  async function save(patch) { try { fill(await ipcRenderer.invoke('hub-pet:set-settings', patch)); } catch (_) {} }
  notifyEl.addEventListener('change', () => save({ notifyMode: notifyEl.value }));
  enabledEl.addEventListener('change', () => save({ enabled: enabledEl.checked }));
  roleEl.addEventListener('change', () => save({ role: roleEl.value }));
  modeEl.addEventListener('change', () => save({ mode: modeEl.value }));

  // 配置弹窗每次打开时重读一次（桌宠右键「收起」或换角色后，这里要跟着变）。
  const modal = document.getElementById('config-modal');
  if (modal && window.MutationObserver) {
    new window.MutationObserver(() => { if (!modal.classList.contains('hidden')) refresh(); }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  }
  refresh();
  return { refresh };
}

module.exports = { mountHubPetSettings };
