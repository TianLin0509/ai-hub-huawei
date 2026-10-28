'use strict';

// 左侧栏分组入口（2026-10-24）：一个入口占一行，鼠标悬停向右展开四个成员。
//
// 这里只做四件事：开关、定位、焦点、入口上的「组内有当前页」提示。
// 成员按钮是 index.html 里的原节点（id / data-* / 可访问名都没动），点击之后由
// rules.js、hub-workspaces.js、xresearch.js 等原有模块接管，本模块不参与导航。
//
// 定位用 position:fixed，因为展开条写在 .rail-navigation（overflow-y:auto）里，
// #scene-rail 自己也可能 overflow:hidden；只有 fixed 不被这两层裁剪。坐标每次
// 展开时按入口的 rect 现算，rail 滚动或窗口变化时重算。

const OPEN_DELAY_MS = 70;
const CLOSE_DELAY_MS = 180;
const RAIL_GAP_PX = 4;

function installRailGroups(doc = globalThis.document) {
  const rail = doc?.getElementById?.('scene-rail');
  if (!rail || rail.dataset.railGroupsInstalled) return null;
  const win = doc.defaultView;
  const states = [...rail.querySelectorAll('.rail-group')].map(railGroup => {
    const trigger = railGroup.querySelector('.rail-group-trigger');
    const menu = railGroup.querySelector('.rail-group-menu');
    if (!trigger || !menu) return null;
    trigger.dataset.railGroupTitle = trigger.getAttribute('aria-label') || trigger.textContent.trim();
    // 入口图标平时是这一组自己的图标；组里有当前页时换成那一项的图标（字仍是组名），
    // 所以要留一份原件，离开组的时候换回来。
    const baseIconHtml = trigger.querySelector('.btn-icon')?.innerHTML || '';
    return { railGroup, trigger, menu, open: false, activeId: '', baseIconHtml };
  }).filter(Boolean);
  if (!states.length) return null;
  rail.dataset.railGroupsInstalled = 'true';

  let openTimer = null;
  let closeTimer = null;
  let current = null;
  let paintQueued = false;
  // Escape 收回 dock 要把焦点还给入口；而入口的 focus 处理器会顺手再展开一次。
  // 用这个标记把「我们自己还的焦点」和「用户 Tab 进来的焦点」分开。
  let restoringFocus = false;

  const members = state => [...state.menu.querySelectorAll('.btn-shell-nav')].filter(button => !button.hidden);
  const cancelTimers = () => {
    if (openTimer !== null) win.clearTimeout(openTimer);
    if (closeTimer !== null) win.clearTimeout(closeTimer);
    openTimer = null; closeTimer = null;
  };

  const position = state => {
    const box = state.trigger.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    if (!box.height) return;
    const toolbar = doc.getElementById('app-toolbar');
    const footerHeight = parseFloat(win.getComputedStyle(doc.documentElement).getPropertyValue('--hub-footer-height')) || 34;
    const topLimit = (toolbar ? toolbar.getBoundingClientRect().bottom : 0) + 8;
    const bottomLimit = win.innerHeight - footerHeight - 8;
    const height = state.menu.offsetHeight;
    const top = Math.max(topLimit, Math.min(box.top + box.height / 2 - height / 2, bottomLimit - height));
    state.menu.style.left = Math.round(railBox.right + RAIL_GAP_PX) + 'px';
    state.menu.style.top = Math.round(top) + 'px';
  };

  const close = (state, { restoreFocus = false, silent = false } = {}) => {
    if (!state || !state.open) return;
    state.open = false;
    state.menu.hidden = true;
    state.trigger.setAttribute('aria-expanded', 'false');
    state.railGroup.classList.remove('rail-group-open');
    if (current === state) current = null;
    if (restoreFocus) {
      restoringFocus = true;
      try { state.trigger.focus({ preventScroll: true }); } finally { restoringFocus = false; }
    }
    // 导航处于「悬停预览」时，rail 的自动收起要等这条 dock 关掉再算，见 session-first-navigation.js。
    if (!silent) doc.dispatchEvent(new win.Event('hub:rail-group-closed'));
  };

  const open = state => {
    cancelTimers();
    if (state.open) return;
    // 长按排序时不要弹 dock，否则拖拽会被它挡住。
    if (rail.classList.contains('rail-editing')) return;
    if (current && current !== state) close(current, { silent: true });
    state.open = true;
    state.menu.hidden = false;
    state.trigger.setAttribute('aria-expanded', 'true');
    state.railGroup.classList.add('rail-group-open');
    current = state;
    position(state);
  };

  const focusMember = (state, index) => {
    const list = members(state);
    if (!list.length) return;
    const target = list[Math.max(0, Math.min(list.length - 1, index))];
    try { target.focus({ preventScroll: true }); } catch {}
  };

  for (const state of states) {
    const { railGroup, trigger, menu } = state;

    railGroup.addEventListener('pointerenter', event => {
      if (event.pointerType === 'touch') return;
      if (closeTimer !== null) { win.clearTimeout(closeTimer); closeTimer = null; }
      if (state.open) return;
      if (openTimer !== null) win.clearTimeout(openTimer);
      openTimer = win.setTimeout(() => { openTimer = null; open(state); }, OPEN_DELAY_MS);
    });
    railGroup.addEventListener('pointerleave', event => {
      if (event.pointerType === 'touch') return;
      if (openTimer !== null) { win.clearTimeout(openTimer); openTimer = null; }
      if (!state.open) return;
      if (closeTimer !== null) win.clearTimeout(closeTimer);
      closeTimer = win.setTimeout(() => { closeTimer = null; if (state.open) close(state); }, CLOSE_DELAY_MS);
    });

    trigger.addEventListener('click', event => {
      event.preventDefault();
      if (state.open) { close(state); return; }
      open(state);
      // 键盘（Enter / 空格）打开时直接把焦点送进 dock，鼠标点击则保持原位。
      if (event.detail === 0) focusMember(state, 0);
    });

    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        open(state);
        focusMember(state, 0);
      } else if (event.key === 'Escape' && state.open) {
        event.preventDefault();
        close(state);
      }
    });

    // 键盘 Tab 到入口时就展开，符合「入口=折叠的菜单」的预期。
    trigger.addEventListener('focus', () => {
      if (!restoringFocus && trigger.matches(':focus-visible')) open(state);
    });

    menu.addEventListener('click', event => {
      if (event.target.closest('.btn-shell-nav')) close(state);
    });

    menu.addEventListener('keydown', event => {
      const list = members(state);
      const index = list.indexOf(doc.activeElement);
      const move = next => { event.preventDefault(); focusMember(state, next); };
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(state, { restoreFocus: true });
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        move(index < 0 ? 0 : index + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        move(index <= 0 ? list.length - 1 : index - 1);
      } else if (event.key === 'Home') {
        move(0);
      } else if (event.key === 'End') {
        move(list.length - 1);
      }
    });

    railGroup.addEventListener('focusout', event => {
      if (railGroup.contains(event.relatedTarget)) return;
      close(state);
    });
  }

  // 入口上的「组内有当前页」提示：跟随冷白外壳写下的 aria-current / .cw-current。
  const paint = () => {
    paintQueued = false;
    for (const state of states) {
      const base = state.trigger.dataset.railGroupTitle || '';
      const active = members(state).find(button => button.getAttribute('aria-current') === 'page'
        || button.classList.contains('cw-current'));
      const activeId = active ? active.id : '';
      const switched = activeId !== state.activeId;
      state.activeId = activeId;
      const label = active ? (active.querySelector('.btn-label')?.textContent || '').trim() : '';
      state.trigger.classList.toggle('rail-group-current', !!active);
      // 入口图标跟着当前页走：在账号页时入口显示账号图标，但字还是「规则」。
      // 只比 innerHTML 再写，避免每次 paint 都重建节点（重建会让 CSS 动画重播）。
      const icon = state.trigger.querySelector('.btn-icon');
      if (icon) {
        const activeIcon = active ? active.querySelector('.btn-icon') : null;
        const nextHtml = activeIcon ? activeIcon.innerHTML : state.baseIconHtml;
        if (nextHtml && icon.innerHTML !== nextHtml) icon.innerHTML = nextHtml;
      }
      const suffix = state.trigger.dataset.titleSuffix || '';
      state.trigger.title = label
        ? `${base}；当前：${label}；悬停展开${suffix}`
        : `${base}；悬停展开${suffix}`;
      state.trigger.setAttribute('aria-label', label ? `${base}（当前：${label}）` : base);
      // 选中组里的某一项之后，面板一开（这一项变成当前页）就把 dock 收掉。
      // 不能只靠点击事件：资源 / 回顾 由 hub-workspaces 在捕获阶段 stopImmediatePropagation，
      // 冒泡到 dock 的 click 根本不会发生。
      if (state.open && switched && activeId) close(state);
    }
  };
  const schedulePaint = () => {
    if (paintQueued) return;
    paintQueued = true;
    win.requestAnimationFrame(paint);
  };

  const observer = new win.MutationObserver(schedulePaint);
  for (const state of states) observer.observe(state.menu, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-current'] });

  doc.addEventListener('pointerdown', event => {
    if (!current) return;
    if (current.railGroup.contains(event.target)) return;
    close(current);
  }, true);
  win.addEventListener('resize', () => { if (current) position(current); });
  rail.addEventListener('scroll', () => { if (current) position(current); }, true);
  doc.addEventListener('hub:navigation-layout', () => {
    if (current) close(current);
    schedulePaint();
  });
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !current) return;
    if (current.railGroup.contains(doc.activeElement)) return;
    close(current);
  });

  paint();
  return { close: () => close(current), states };
}

module.exports = { installRailGroups };
