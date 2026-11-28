'use strict';
// 内存紧张就地提示（R59 方案 A，2026-11-27）界面侧：
//   - 会话栏顶部一条：整机内存紧张时出现，说清「几个会话闲着、约占多少」或「都在跑、Hub 不动它们」；
//   - 启动中心「新建会话」页顶部同一条：新建那一刻正紧张时，多给一个「改用 Lite 开新会话」；
//   - 按钮：一键休眠闲着的（走「释放内存」面板同一道闸门，点会话即可接着用）、打开低开销模式、稍后再说。
// 状态由主进程推（memory-pressure:changed），打开启动中心时主动问一次（memory-pressure:state）。

const GB = 1024 ** 3;
const SNOOZE_MS = 30 * 60 * 1000;
const RESULT_MS = 8000;

const pctOf = usage => Math.round((Number(usage) || 0) * 100);
const gbOf = bytes => (Number(bytes) / GB).toFixed(1);

// 纯函数：一行文字 + 可用按钮。place：'sidebar' | 'launch'；liteAvailable：启动中心当前选的是 CodeAgent（非 Lite）。
function hintModel(state, { place = 'sidebar', liteAvailable = false } = {}) {
  if (!state || state.tight !== true) return null;
  const free = Number(state.freeBytes);
  const head = Number.isFinite(free) && free >= 0 ? `内存 ${pctOf(state.usage)}%，剩 ${gbOf(free)} GB` : `内存 ${pctOf(state.usage)}%`;
  let detail;
  if (state.idleCount > 0) {
    detail = state.idleBytes > 0
      ? `${state.idleCount} 个会话闲着，约占 ${gbOf(state.idleBytes)} GB`
      : `${state.idleCount} 个会话闲着，休眠后点一下即可接着用`;
  } else if (state.busyCount > 0 && state.busyCount >= state.liveCount) {
    detail = `${state.busyCount} 个会话正在运行，Hub 不会动它们；可等跑完，或关掉不用的会话`;
  } else if (state.liveCount > 0) {
    // 刚答完、正看着的会话还不算闲（闲置满 10 分钟才可休眠，与「释放内存」面板同一口径）。
    detail = `${state.liveCount} 个会话刚用过，闲置满 10 分钟后可一键休眠；点底栏内存可看是谁占的`;
  } else {
    detail = '会话占得不多，主要是其他程序；点底栏内存可看是谁';
  }
  const actions = [];
  if (state.idleCount > 0) actions.push({ id: 'suspend', label: '一键休眠闲着的', primary: true });
  if (place === 'launch' && liteAvailable) actions.push({ id: 'lite', label: '改用 Lite 开新会话', primary: !actions.length });
  if (!state.lowOverheadOn) actions.push({ id: 'lowOverhead', label: '打开低开销模式', primary: !actions.length });
  if (place === 'sidebar') actions.push({ id: 'snooze', label: '稍后', quiet: true });
  return { head, detail, actions };
}

function resultText(result) {
  if (!result || result.ok === false) return `没有休眠成功：${(result && result.error) || '未知原因'}`;
  if (!result.requested) return '没有可休眠的会话（可能刚有新输出，或已在运行）';
  return Number(result.freedBytes) > 0
    ? `已休眠 ${result.requested} 个会话，腾出约 ${gbOf(result.freedBytes)} GB；点会话即可接着用`
    : `已休眠 ${result.requested} 个会话；点会话即可接着用`;
}

const STYLE = `
.mp-bar { display: flex; flex-direction: column; gap: 6px; margin: 6px 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-subtle); border-left: 3px solid var(--brand); background: var(--surface-raised); font-size: 12.5px; line-height: 1.45; font-family: "Microsoft YaHei", sans-serif; color: var(--fg-default); }
.mp-bar[hidden] { display: none; }
.mp-bar .mp-head { font-weight: 600; }
.mp-bar .mp-detail { color: var(--fg-muted); }
.mp-bar .mp-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.mp-bar button { padding: 2px 10px; border-radius: 6px; border: 1px solid var(--brand); background: transparent; color: var(--brand); font: inherit; font-size: 12px; cursor: pointer; }
.mp-bar button.mp-primary { background: var(--brand); color: var(--brand-ink); }
.mp-bar button.mp-quiet { border-color: transparent; color: var(--fg-muted); }
.mp-bar button:disabled { opacity: .6; cursor: default; }
.mp-bar.mp-launch { margin: 0 0 10px; flex-direction: row; align-items: center; flex-wrap: wrap; column-gap: 10px; }
.mp-bar.mp-launch .mp-actions { margin-left: auto; }
:root[data-hw-shell] .mp-bar { background: var(--hw-surface); border-color: var(--hw-line); border-left-color: var(--hw-brand); color: var(--hw-text-1); }
:root[data-hw-shell] .mp-bar .mp-detail, :root[data-hw-shell] .mp-bar button.mp-quiet { color: var(--hw-text-2); }
:root[data-hw-shell] .mp-bar button { border-color: var(--hw-brand); color: var(--hw-brand); }
:root[data-hw-shell] .mp-bar button.mp-primary { background: var(--hw-brand); color: var(--hw-text-on); }
:root[data-hw-shell] .mp-bar button.mp-quiet { border-color: transparent; }`;

function mountMemoryPressureBar({ document: doc, window: win, ipcRenderer, escapeHtml = s => String(s), lowOverhead = null, now = Date.now } = {}) {
  if (!doc || !ipcRenderer) return null;
  if (!doc.getElementById('mp-bar-style')) {
    const style = doc.createElement('style');
    style.id = 'mp-bar-style';
    style.textContent = STYLE;
    doc.head.appendChild(style);
  }
  let state = null;
  let snoozedUntil = 0;
  let busy = false;
  const results = { sidebar: '', launch: '' };
  const resultTimers = {};

  function host(place) {
    const id = place === 'launch' ? 'mp-bar-launch' : 'mp-bar-sidebar';
    let el = doc.getElementById(id);
    if (el) return el;
    const anchor = place === 'launch'
      ? doc.querySelector('#launch-center-session-panel .session-create-body')
      : doc.getElementById('session-list');
    if (!anchor) return null;
    el = doc.createElement('div');
    el.id = id;
    el.className = 'mp-bar' + (place === 'launch' ? ' mp-launch' : '');
    el.setAttribute('role', 'status');
    el.hidden = true;
    if (place === 'launch') anchor.insertBefore(el, anchor.firstChild);
    else anchor.parentNode.insertBefore(el, anchor);
    el.addEventListener('click', event => {
      const btn = event.target.closest('[data-mp-action]');
      if (btn && !btn.disabled) void act(btn.dataset.mpAction, place);
    });
    return el;
  }

  function liteAvailable() {
    const lite = doc.querySelector('#new-session-menu .new-session-option[data-kind="codeagent-lite"]');
    const plain = doc.querySelector('#new-session-menu .new-session-option[data-kind="codeagent"]');
    return !!(lite && !lite.hidden && plain && plain.classList.contains('selected'));
  }

  function paint(place) {
    const el = host(place);
    if (!el) return;
    const model = hintModel(state, { place, liteAvailable: place === 'launch' && liteAvailable() });
    const hideSidebar = place === 'sidebar' && now() < snoozedUntil;
    if ((!model || hideSidebar) && !results[place]) { el.hidden = true; el.innerHTML = ''; return; }
    if (results[place]) {
      el.innerHTML = `<span class="mp-head">${escapeHtml(results[place])}</span>`;
      el.hidden = false;
      return;
    }
    const buttons = model.actions.map(a => `<button type="button" data-mp-action="${a.id}" class="${a.primary ? 'mp-primary' : ''}${a.quiet ? ' mp-quiet' : ''}"${busy ? ' disabled' : ''}>${escapeHtml(a.label)}</button>`).join('');
    el.innerHTML = `<span class="mp-head">${escapeHtml(model.head)}</span><span class="mp-detail">${escapeHtml(model.detail)}</span><span class="mp-actions">${buttons}</span>`;
    el.hidden = false;
  }
  const paintAll = () => { paint('sidebar'); paint('launch'); };

  function showResult(place, text) {
    results[place] = text;
    clearTimeout(resultTimers[place]);
    resultTimers[place] = setTimeout(() => { results[place] = ''; paintAll(); }, RESULT_MS);
    paintAll();
  }

  async function refresh() {
    try {
      const next = await ipcRenderer.invoke('memory-pressure:state');
      if (next && next.ok !== false) state = next;
    } catch { /* 主进程没准备好：保持上次 */ }
    paintAll();
    return state;
  }

  async function act(action, place) {
    if (action === 'snooze') { snoozedUntil = now() + SNOOZE_MS; paintAll(); return; }
    if (action === 'lite') {
      const lite = doc.querySelector('#new-session-menu .new-session-option[data-kind="codeagent-lite"]');
      if (lite) lite.click();
      win?.setTimeout?.(paintAll, 0);
      return;
    }
    busy = true; paintAll();
    try {
      if (action === 'suspend') {
        const result = await ipcRenderer.invoke('memory-pressure:suspend-idle');
        if (result && result.state) state = result.state;
        showResult(place, resultText(result));
      } else if (action === 'lowOverhead') {
        const result = lowOverhead && typeof lowOverhead.set === 'function'
          ? await lowOverhead.set({ on: true })
          : await ipcRenderer.invoke('low-overhead:set', { on: true });
        if (result && result.ok === false) showResult(place, `低开销模式没打开：${result.error || result.message || '未知原因'}`);
        else if (result && result.partial) showResult(place, result.message || '低开销模式只部分生效');
        else showResult(place, '低开销模式已打开：闲着的会话会按上限自动休眠，CodeAgent 新会话默认用 Lite');
        await refresh();
      }
    } catch (error) {
      showResult(place, `操作失败：${error && error.message ? error.message : error}`);
    } finally {
      busy = false; paintAll();
    }
  }

  // 从设置或内存面板切了低开销模式：按钮立刻跟上，不等下一轮 60 秒巡检（R59 审查 P2）。
  lowOverhead?.onChange?.(mode => { if (state && mode) { state = { ...state, lowOverheadOn: mode.on === true }; paintAll(); } });

  ipcRenderer.on('memory-pressure:changed', (_event, next) => {
    if (!next) return;
    state = next;
    paintAll();
  });

  // 启动中心打开那一刻主动问一次（「新建会话前可用不足 4 GB」也在这里体现）；切换 AI 类型时重画（Lite 按钮跟着变）。
  const menu = doc.getElementById('new-session-menu');
  if (menu && typeof win?.MutationObserver === 'function') {
    let wasOpen = false;
    new win.MutationObserver(() => {
      const open = menu.style.display !== 'none' && !menu.hidden;
      if (open && !wasOpen) void refresh();
      wasOpen = open;
    }).observe(menu, { attributes: true, attributeFilter: ['style', 'hidden'] });
    menu.addEventListener('click', event => {
      if (event.target.closest('.new-session-option')) win.setTimeout(() => paint('launch'), 0);
    });
  }

  void refresh();
  const api = { refresh, state: () => state, paint: paintAll };
  if (win) win.__hubMemoryPressureBar = api;
  return api;
}

module.exports = { mountMemoryPressureBar, hintModel, resultText, SNOOZE_MS };
