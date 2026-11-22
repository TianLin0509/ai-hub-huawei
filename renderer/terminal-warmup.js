'use strict';
// 后台终端第一次打开要现起进程，这几秒盖一层小动画（沿用开场动画的群星汇聚），不让用户对着黑屏。
// 动画不增加等待：很快就绪的不显示，终端一画出内容就淡出，保温中的终端直接秒开。
const SHOW_DELAY_MS = 180;
const SETTLE_MS = 140;
const FADE_MS = 200;
const LONG_WAIT_MS = 8_000;
const MAX_MS = 150_000; // 和 DSH 启动等待上限一致，电脑很忙时也不提前露出黑屏。
const READY_CHARS = 12;
const STAR_COLORS = ['#ff8c64', '#fff5e6', '#6e96ff', '#5adcf0', '#aa82ff'];

// 只数屏幕上真正看得见的字符，终端控制序列不算。
function visibleLength(data) {
  return String(data || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x20\x7f]/g, '').length;
}

function solidColor(view, element) {
  if (!element) return null;
  const match = /rgba?\(([^)]+)\)/.exec(view.getComputedStyle(element).backgroundColor || '');
  if (!match) return null;
  const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return parts.length > 3 && parts[3] === 0 ? null : parts.slice(0, 3);
}

function mountOverlay({ document, window, host }) {
  const el = document.createElement('div');
  el.className = 'terminal-warmup';
  el.setAttribute('role', 'status');
  const stars = STAR_COLORS.map((color, index) => `<i class="terminal-warmup-star" style="--c:${color};--a:${index * 72}deg"></i>`).join('');
  el.innerHTML = `<div class="terminal-warmup-stage" aria-hidden="true">${stars}<b class="terminal-warmup-ring"></b><b class="terminal-warmup-core"></b></div>`
    + '<strong>正在打开真实终端</strong><span>第一次需要几秒，之后 3 分钟内再开是秒开</span>';
  const container = host?.querySelector?.('.terminal-container');
  const rgb = solidColor(window, container?.querySelector?.('.xterm-viewport')) || solidColor(window, container);
  if (rgb) {
    el.style.setProperty('--warmup-bg', `rgb(${rgb.join(',')})`);
    if ((0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.6) el.classList.add('is-light');
  }
  document.body.appendChild(el);
  const box = target => {
    const rect = target?.getBoundingClientRect?.();
    return rect && rect.width > 40 && rect.height > 40 ? rect : null;
  };
  let last = null, frame = 0;
  // 接力时终端容器会被重建，容器短暂不在时停在上一次的位置。
  const place = () => {
    last = box(host?.querySelector?.('.terminal-container')) || last || box(host);
    if (last) Object.assign(el.style, { left: `${last.left}px`, top: `${last.top}px`, width: `${last.width}px`, height: `${last.height}px` });
    frame = window.requestAnimationFrame(place);
  };
  place();
  const remove = () => { window.cancelAnimationFrame(frame); el.remove(); };
  return {
    slow() { el.querySelector('span').textContent = '还在连接，可以先回卡片继续对话'; },
    leave() { el.classList.add('is-leaving'); window.setTimeout(remove, FADE_MS); },
    remove,
  };
}

function createTerminalWarmup({ document, window, hostFor = () => null, mount = mountOverlay, timers = window }) {
  let current = null;
  const stopTimers = value => { for (const key of ['showTimer', 'slowTimer', 'settleTimer', 'maxTimer']) timers.clearTimeout(value[key]); };
  const finish = value => {
    if (current !== value) return;
    current = null;
    stopTimers(value);
    value.view?.leave();
  };
  const cancel = sessionId => {
    if (!current || (sessionId && current.sessionId !== sessionId)) return;
    const value = current;
    current = null;
    stopTimers(value);
    value.view?.remove();
  };
  const begin = sessionId => {
    if (current?.sessionId === sessionId) return;
    cancel();
    const value = current = { sessionId, chars: 0, view: null, settling: false };
    value.showTimer = timers.setTimeout(() => {
      if (current !== value) return;
      value.view = mount({ document, window, host: hostFor() });
      value.slowTimer = timers.setTimeout(() => value.view?.slow(), LONG_WAIT_MS);
    }, SHOW_DELAY_MS);
    value.maxTimer = timers.setTimeout(() => finish(value), MAX_MS);
  };
  const output = (sessionId, data) => {
    const value = current;
    if (!value || value.sessionId !== sessionId || value.settling) return;
    value.chars += visibleLength(data);
    if (value.chars < READY_CHARS) return;
    if (!value.view) { cancel(); return; }
    value.settling = true;
    value.settleTimer = timers.setTimeout(() => finish(value), SETTLE_MS);
  };
  return { begin, output, cancel, activeSession: () => current?.sessionId || null };
}

module.exports = { createTerminalWarmup, visibleLength, SHOW_DELAY_MS, SETTLE_MS, LONG_WAIT_MS, MAX_MS };
