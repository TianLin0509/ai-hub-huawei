'use strict';

// 全局悬停卡（2026-11-01 用户选定 C：白卡片 + 指向箭头，替换系统黑底白字的原生 title 提示）。
// 接管方式：鼠标移到带 title 的元素上时，先把 title 挪到 data-hub-tip（压住系统提示），离开时还回去，
// 所以平时读 el.title 的代码不受影响。停留 350ms 出现；移进卡片不消失（卡片里可以放按钮）；离开 150ms 后淡出。
// 多行文字自动排版：第一行做标题，「标签：内容」行排成两列，其余行原样。需要自定义内容的元素
// 用 registerRich(selector, el => Node|null) 提供卡片节点（比如账号卡片的「测到 Claude」按钮）。

const SHOW_DELAY = 350;
const HIDE_DELAY = 150;
const KV = /^([^：:\n]{1,8})[：:]\s*(.+)$/;

// 纯函数，单测直接测：把多行提示拆成 标题 / 两列 / 普通行。
function parseTip(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length <= 1) return { simple: lines[0] || '' };
  const [title, ...rest] = lines;
  const items = rest.map(line => {
    const m = line.match(KV);
    return m ? { k: m[1], v: m[2] } : { text: line };
  });
  return { title, items };
}

// 放在哪边：优先 下 → 上；贴近左右边缘的元素（侧栏、右侧看板）改成朝屏幕中间的一侧。
function placement(rect, card, view) {
  const gap = 10;
  const fits = {
    bottom: rect.bottom + gap + card.height <= view.height,
    top: rect.top - gap - card.height >= 0,
    right: rect.right + gap + card.width <= view.width,
    left: rect.left - gap - card.width >= 0,
  };
  const order = rect.right > view.width * 0.72 ? ['left', 'bottom', 'top', 'right']
    : rect.left < view.width * 0.22 && rect.width < view.width * 0.3 ? ['right', 'bottom', 'top', 'left']
      : ['bottom', 'top', 'right', 'left'];
  const side = order.find(s => fits[s]) || order[0];
  let x, y;
  if (side === 'bottom' || side === 'top') {
    x = rect.left + rect.width / 2 - card.width / 2;
    y = side === 'bottom' ? rect.bottom + gap : rect.top - gap - card.height;
  } else {
    x = side === 'right' ? rect.right + gap : rect.left - gap - card.width;
    y = rect.top + Math.min(rect.height, 40) / 2 - 18;
  }
  x = Math.max(8, Math.min(x, view.width - card.width - 8));
  y = Math.max(8, Math.min(y, view.height - card.height - 8));
  // 箭头指向元素中心，夹在卡片边内。
  const caret = side === 'bottom' || side === 'top'
    ? Math.max(14, Math.min(rect.left + rect.width / 2 - x, card.width - 14))
    : Math.max(12, Math.min(rect.top + Math.min(rect.height, 40) / 2 - y, card.height - 12));
  return { side, x: Math.round(x), y: Math.round(y), caret: Math.round(caret) };
}

function installHubTooltip(doc = globalThis.document, { win = globalThis.window, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (!doc?.body || doc.__hubTooltip) return doc?.__hubTooltip || null;
  const card = doc.createElement('div');
  card.className = 'hub-tip';
  card.setAttribute('role', 'tooltip');
  card.hidden = true;
  doc.body.appendChild(card);
  const rich = [];
  let anchor = null, showTimer = null, hideTimer = null;

  const restore = el => {
    if (el && el.hasAttribute('data-hub-tip') && !el.hasAttribute('title')) el.setAttribute('title', el.getAttribute('data-hub-tip'));
    if (el) el.removeAttribute('data-hub-tip');
  };
  function hideNow() {
    clearTimeoutFn(showTimer); clearTimeoutFn(hideTimer);
    if (anchor) { anchor.removeAttribute('aria-describedby'); restore(anchor); }
    anchor = null;
    card.hidden = true;
    card.classList.remove('is-on');
  }
  const scheduleHide = () => { clearTimeoutFn(hideTimer); hideTimer = setTimeoutFn(hideNow, HIDE_DELAY); };

  function fill(el) {
    card.textContent = '';
    for (const { selector, build } of rich) {
      if (el.matches(selector)) {
        let node = null;
        try { node = build(el); } catch {}
        if (node) { card.classList.add('is-rich'); card.appendChild(node); return true; }
      }
    }
    const tip = parseTip(el.getAttribute('data-hub-tip'));
    card.classList.toggle('is-rich', !tip.simple && tip.simple !== '');
    if (tip.simple !== undefined) {
      if (!tip.simple) return false;
      card.textContent = tip.simple;
      return true;
    }
    const head = doc.createElement('div'); head.className = 'hub-tip-title'; head.textContent = tip.title; card.appendChild(head);
    let grid = null;
    for (const item of tip.items) {
      if (item.k) {
        if (!grid) { grid = doc.createElement('div'); grid.className = 'hub-tip-kv'; card.appendChild(grid); }
        const k = doc.createElement('span'); k.textContent = item.k;
        const v = doc.createElement('div'); v.textContent = item.v;
        grid.append(k, v);
      } else {
        grid = null;
        const p = doc.createElement('div'); p.className = 'hub-tip-line'; p.textContent = item.text; card.appendChild(p);
      }
    }
    return true;
  }

  function show(el) {
    if (!el.isConnected) return;
    if (!fill(el)) return;
    card.hidden = false;
    card.classList.remove('is-on');
    const view = { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
    const box = card.getBoundingClientRect();
    const pos = placement(el.getBoundingClientRect(), { width: box.width, height: box.height }, view);
    card.dataset.side = pos.side;
    card.style.left = pos.x + 'px';
    card.style.top = pos.y + 'px';
    card.style.setProperty('--hub-tip-caret', pos.caret + 'px');
    el.setAttribute('aria-describedby', 'hub-tip');
    card.id = 'hub-tip';
    win?.requestAnimationFrame ? win.requestAnimationFrame(() => card.classList.add('is-on')) : card.classList.add('is-on');
  }

  function target(node) {
    const el = node?.closest?.('[title],[data-hub-tip]');
    if (!el || el === doc.documentElement || el === doc.body) return null;
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') return null;
    // 已有自己浮层的元素不接管，避免出现两张卡：资源占用 Top 3、问题目录。终端里也不接管。
    if (el.closest('[data-no-hub-tip], .xterm, [data-resource-kind], .card-question-nav-item')) return null;
    return el;
  }

  doc.addEventListener('mouseover', event => {
    if (card.contains(event.target)) { clearTimeoutFn(hideTimer); return; }
    const el = target(event.target);
    if (el === anchor) { clearTimeoutFn(hideTimer); return; }
    if (!el) { if (anchor) scheduleHide(); return; }
    hideNow();
    if (el.hasAttribute('title')) {
      const text = el.getAttribute('title');
      if (!text) return;
      el.setAttribute('data-hub-tip', text);
      el.removeAttribute('title');
    }
    anchor = el;
    showTimer = setTimeoutFn(() => { if (anchor === el) show(el); }, SHOW_DELAY);
  }, true);
  doc.addEventListener('mouseout', event => {
    if (!anchor) return;
    const to = event.relatedTarget;
    if (to && (anchor.contains(to) || card.contains(to))) return;
    if (card.contains(event.target) || anchor.contains(event.target)) scheduleHide();
  }, true);
  // 点击、滚动、按键、窗口失焦时立即收起，不挡后续操作。
  doc.addEventListener('mousedown', event => { if (!card.contains(event.target)) hideNow(); }, true);
  doc.addEventListener('keydown', () => hideNow(), true);
  doc.addEventListener('scroll', event => { if (!card.contains(event.target)) hideNow(); }, true);
  win?.addEventListener?.('blur', hideNow);

  const api = {
    registerRich(selector, build) { rich.push({ selector, build }); },
    hide: hideNow,
    get anchor() { return anchor; },
    element: card,
  };
  doc.__hubTooltip = api;
  return api;
}

module.exports = { installHubTooltip, parseTip, placement, SHOW_DELAY, HIDE_DELAY };
