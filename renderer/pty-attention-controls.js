'use strict';

// PTY 跑的 CLI（CodeAgent、Claude Code 等）在等人操作（工具授权、提问、选项）时，卡片视图里的一行小字提示。
//
// 2026-11-24 一键反馈 v5.6.99：原来是一块盖在输入框上方的深色浮层，只有「到终端处理」，必须切到后台选。
// 现在：主进程读屏认出选择菜单（core/pty-choice-menu.js），这里画成一行小号选项，点了由主进程核对画面后按键；
// 认不出的画面才退回一行「去后台处理」。信任目录、Bypass 警告这类 Hub 会自动确认的框不打扰；
// 会话权限已是「全部放开」时，普通工具授权由主进程按设置直接允许，也不显示。

const { RUNTIME_WAITING } = require('../core/session-runtime-truth.js');

const FAST_POLL_MS = 1200;
const SLOW_POLL_MS = 4000;
const FAST_POLLS = 12;
const FALLBACK_AFTER = 3; // 连续几次认不出菜单才给「去后台处理」
const AUTO_GRACE_MS = 8000; // 自动确认的框超过这么久还在，说明没点掉，交给用户
// 终端输出停下这么久再读一次屏：菜单画完就停在那等人，正在输出的时候不读。
const QUIET_MS = 700;
const NOTE_HOLD_MS = 3000; // 「已发送未确认」、出错原因至少留这么久，不被下一次读屏抹掉
// 回车发给终端后，到下一次读屏回来之前不再转发按键（最多这么久），免得紧接着按的 ↑ 被当成菜单键发走（2026-11-27 审查）
const ENTER_LOCK_MS = 1500;
// CodeAgent 模型菜单：卡片只提示「去后台选择模型」，不转发按键（选模型要经 Hub 的默认模型保护）
const MODEL_MENU_REASON = 'codeagent-model-menu';
const instances = new Set();
// 卡片输入框为空、提示条正显示时，这几个键直接交给终端（2026-11-27：CodeAgent 弹出的方向键菜单在卡片里只能去后台选）。
// 带修饰键的组合、输入框里有字时一律不拦，↑↓ 仍是翻历史、回车仍是发送。
const MENU_KEYS = Object.freeze({ ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowLeft: '\x1b[D', ArrowRight: '\x1b[C', Enter: '\r' });
function menuKeyBytes(event, { active, inputEmpty } = {}) {
  if (!active || !inputEmpty || !event) return null;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return null;
  return Object.prototype.hasOwnProperty.call(MENU_KEYS, event.key) ? MENU_KEYS[event.key] : null;
}

// 终端有输出时由 renderer 调用：不依赖 hook 或状态识别，菜单一停稳就能在卡片上出现。
// 浮动输入条换会话时整块重建：接入过文档、现在又离开的旧实例就此作废。
function notePtyOutput(sessionId) {
  for (const instance of [...instances]) {
    if (instance.element.isConnected) instance.element.dataset.attached = '1';
    else if (instance.element.dataset.attached === '1') { instance.dispose(); continue; }
    instance.noteOutput(sessionId);
  }
}

function createPtyAttentionControls({ onOpenTerminal, invoke, getSessionId, writeTerminal } = {}) {
  const element = document.createElement('section');
  element.className = 'pty-attention-controls pty-choice-inline';
  element.hidden = true;
  element.setAttribute('aria-label', '终端等待操作');
  element.setAttribute('role', 'group');
  const question = document.createElement('span');
  question.className = 'pty-choice-question';
  const options = document.createElement('span');
  options.className = 'pty-choice-options';
  const note = document.createElement('span');
  note.className = 'pty-choice-note';
  note.setAttribute('role', 'status');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'pty-choice-backstage';
  open.textContent = '去后台';
  open.title = '切到终端视图，在 CLI 原生界面里处理';
  open.addEventListener('click', () => { if (typeof onOpenTerminal === 'function') onOpenTerminal(); });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pty-choice-close';
  close.textContent = '×';
  close.title = '收起此提示，不会取消终端正在等待的操作';
  close.setAttribute('aria-label', '收起提示');
  const keysHint = document.createElement('span');
  keysHint.className = 'pty-choice-keys';
  keysHint.textContent = '或按 ↑↓ 回车';
  keysHint.title = '输入框为空时，↑↓ 和回车直接发给终端';
  element.append(question, options, note, open, close, keysHint);

  let currentKey = null;
  let dismissed = false;
  let menu = null;
  let misses = 0;
  let polls = 0;
  let timer = null;
  let sending = false;
  let waitingSince = 0;
  let sessionId = null;
  let fallbackText = '';
  let hinted = false; // 由终端输出触发的读屏（不在「等待输入」状态里）
  let quietTimer = null;
  let lastSession = null;
  let noteUntil = 0;
  let disposed = false;
  let currentReason = '';
  let keyLockUntil = 0;
  // 读屏序号：按键后递增，按键前发出、按键后才返回的旧读屏结果作废（不解锁、不覆写菜单、不改轮询）
  let probeSeq = 0;

  close.addEventListener('click', () => { dismissed = true; element.hidden = true; });

  const noteHeld = () => !!note.textContent && Date.now() < noteUntil;
  function setNote(text) {
    note.textContent = text || '';
    noteUntil = text ? Date.now() + NOTE_HOLD_MS : 0;
    if (text) setTimeout(() => { if (!disposed && !noteHeld()) { note.textContent = ''; paint(); } }, NOTE_HOLD_MS + 50);
  }
  const clearNote = () => { if (!noteHeld()) note.textContent = ''; };
  // 接入过文档、现在又离开（切了会话、输入条重建）的实例就此作废，不再后台读屏。
  function detached() {
    if (element.isConnected) { element.dataset.attached = '1'; return false; }
    if (element.dataset.attached === '1') { dispose(); return true; }
    return false;
  }

  const stop = () => { clearTimeout(timer); timer = null; };
  const schedule = () => {
    stop();
    if (!currentKey) return;
    timer = setTimeout(probe, polls < FAST_POLLS ? FAST_POLL_MS : SLOW_POLL_MS);
  };
  const visibleInCard = () => !!element.closest?.('.card-view-active');

  function paint() {
    if (dismissed) { element.hidden = true; return; }
    if (!(menu && menu.options?.length) && noteHeld()) {
      // 菜单已经收起或变了，但要让人看见刚才那次点击的结果
      element.dataset.mode = 'note';
      options.hidden = true;
      element.hidden = false;
      return;
    }
    if (!currentKey && !(hinted && menu)) { element.hidden = true; return; }
    if (menu && menu.options?.length) {
      element.dataset.mode = 'menu';
      element.dataset.kind = menu.kind || '';
      question.textContent = menu.question || '终端在等你选择';
      question.title = menu.original || menu.question || '';
      const sig = JSON.stringify([menu.signature, sending, menu.options.findIndex(o => o.selected)]);
      if (options.dataset.sig !== sig) {
        options.dataset.sig = sig;
        options.replaceChildren(...menu.options.map(option => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'pty-choice-option';
          b.dataset.tone = option.tone || 'other';
          b.dataset.key = option.key;
          if (option.selected) b.dataset.selected = '1';
          b.textContent = option.short || option.label;
          b.title = `${option.key}. ${option.label}`;
          b.disabled = sending;
          b.addEventListener('click', () => choose(option));
          return b;
        }));
      }
      options.hidden = false;
      element.hidden = false;
      return;
    }
    if (currentKey && misses >= FALLBACK_AFTER) {
      element.dataset.mode = 'fallback';
      element.dataset.kind = '';
      question.textContent = fallbackText || '终端在等你操作';
      question.title = fallbackText || '';
      options.hidden = true;
      element.hidden = false;
      return;
    }
    element.hidden = true;
  }

  async function probe() {
    timer = null;
    if (disposed || detached()) return;
    if ((!currentKey && !hinted) || !sessionId || typeof invoke !== 'function') return;
    // 不在卡片视图（用户正看着终端）一律不读屏、不代答，包括第一次
    if (!visibleInCard()) { schedule(); return; }
    const key = currentKey;
    const seq = ++probeSeq;
    polls += 1;
    let result = null;
    try { result = await invoke('pty-choice:read', { sessionId }); } catch { result = null; }
    if (seq !== probeSeq) return;
    keyLockUntil = 0;
    if (key !== currentKey) return;
    if (result?.busy) { schedule(); return; }
    // Hub 正在后台自动选模型：不显示、不累计「认不出」，免得 3 次后弹出「去后台」并接管键盘
    if (result?.picking) { menu = null; misses = 0; if (!currentKey) hinted = false; paint(); schedule(); return; }
    // 输出触发的读屏：没读到菜单就静静收起，不给「去后台」（不一定真的在等人）
    if (!currentKey) {
      const found = result?.ok && result.menu;
      const next = found && found.options?.length && found.auto !== 'pending' ? found : null;
      if (next?.signature !== menu?.signature) { dismissed = false; options.dataset.sig = ''; if (next) clearNote(); }
      menu = next;
      if (!menu) hinted = false;
      paint();
      return;
    }
    const found = result?.ok && result.menu;
    if (found && found.auto === 'pending' && Date.now() - waitingSince < AUTO_GRACE_MS) {
      menu = null; misses = 0;
    } else if (found && found.options?.length) {
      if (!menu || menu.signature !== found.signature) clearNote();
      menu = found; misses = 0;
    } else if (result?.autoAnswered) {
      menu = null; misses = 0;
    } else {
      menu = null; misses += 1;
    }
    paint();
    schedule();
  }

  async function choose(option) {
    if (sending || !menu) return;
    sending = true;
    setNote('');
    paint();
    let result;
    try { result = await invoke('pty-choice:answer', { sessionId, signature: menu.signature, key: option.key }); }
    catch (error) { result = { ok: false, message: error.message }; }
    sending = false;
    if (result?.ok) {
      setNote(result.confirmed ? '' : '已发送，终端尚未确认');
      menu = null; misses = 0; polls = 0;
      options.dataset.sig = '';
    } else {
      setNote(result?.message || '没有送达');
      options.dataset.sig = '';
    }
    paint();
    stop();
    if (disposed) return;
    if (!currentKey) hinted = true;
    timer = setTimeout(probe, 500);
  }

  function noteOutput(sid) {
    if (disposed || !sessionId || sid !== sessionId || typeof invoke !== 'function') return;
    if (!lastSession || lastSession.agentRuntime !== 'pty' || lastSession.runtimeBackend) return;
    if (currentKey || !visibleInCard()) return; // 等待状态有自己的轮询
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => { quietTimer = null; if (!currentKey && !sending) { hinted = true; polls = 1; probe(); } }, QUIET_MS);
  }

  function update(session, runtime) {
    if (disposed) return;
    if (element.isConnected) element.dataset.attached = '1';
    lastSession = session || null;
    if (session) sessionId = session.id || session.hubId || (typeof getSessionId === 'function' ? getSessionId() : null);
    const waiting = !!session && session.agentRuntime === 'pty' && !session.runtimeBackend
      && runtime && runtime.state === RUNTIME_WAITING;
    currentReason = waiting ? String(runtime.reason || session.waitingReason || session._ptyRuntimeReason || '') : '';
    keysHint.hidden = currentReason === MODEL_MENU_REASON;
    if (!waiting) {
      if (currentKey) {
        stop();
        currentKey = null; menu = null; misses = 0; polls = 0; dismissed = false; clearNote();
        // 刚离开等待（可能是在终端里答了，也可能状态识别先变了）：再读一次屏核对
        if (session?.agentRuntime === 'pty' && !session.runtimeBackend) { hinted = true; timer = setTimeout(probe, 300); }
      }
      paint();
      return;
    }
    hinted = false;
    const text = String(runtime.detail || '').trim() || '需要授权或回答问题';
    sessionId = session.id || session.hubId || (typeof getSessionId === 'function' ? getSessionId() : null);
    // 同一道题的状态心跳不重置用户的收起；新的一轮或重新进入等待才重新提示。
    const key = JSON.stringify([sessionId, runtime.turnId, currentReason, text]);
    if (key !== currentKey) {
      currentKey = key;
      dismissed = false; menu = null; misses = 0; polls = 0; clearNote();
      waitingSince = Date.now();
      fallbackText = text;
      options.dataset.sig = '';
      stop();
      timer = setTimeout(probe, 150);
    }
    paint();
  }

  function dispose() {
    disposed = true;
    stop();
    clearTimeout(quietTimer);
    quietTimer = null;
    instances.delete(instance);
  }
  // 提示条正显示（认出了菜单，或在等你操作）时才转发；收起（×）、终端视图、正在代点时不转发。
  const active = () => !disposed && !dismissed && !sending && !element.hidden && !!sessionId
    && Date.now() >= keyLockUntil && currentReason !== MODEL_MENU_REASON
    && (element.dataset.mode === 'menu' || element.dataset.mode === 'fallback') && visibleInCard();
  function forwardKey(event, inputEmpty) {
    const data = menuKeyBytes(event, { active: active(), inputEmpty });
    if (!data || typeof writeTerminal !== 'function') return false;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    writeTerminal(sessionId, data);
    probeSeq += 1; // 在途的旧读屏作废
    if (data === '\r') {
      keyLockUntil = Date.now() + ENTER_LOCK_MS;
      // 回车后菜单大多已收起：清掉「认不出」计数，免得「去后台」提示条残留、继续接管 ↑↓（同 choose()）
      misses = 0;
      paint();
    }
    // 按完重读一次屏：光标移到哪一项、菜单是否已收起
    stop();
    if (!currentKey) hinted = true;
    timer = setTimeout(probe, data === '\r' ? 500 : 250);
    return true;
  }
  const instance = { element, update, noteOutput, dispose, forwardKey };
  instances.add(instance);
  return instance;
}

module.exports = { createPtyAttentionControls, notePtyOutput, menuKeyBytes };
