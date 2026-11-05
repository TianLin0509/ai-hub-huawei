'use strict';
// 公司版「问一下」抽屉：在 CodeAgent 会话旁问一句，后台另起分叉进程回答，正在跑的终端不受影响。
// 外观按 m5 样稿（batch2/m5 20261104-样稿-号池额度与问一下-m5）与 C 令牌重做。主进程接口见 main/ask-aside/service.js。

const ICONS = {
  ask: '<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 21l1.4-4.5A8.5 8.5 0 1 1 20.5 12z"/><path d="M9.9 9.6a2.2 2.2 0 0 1 4.3.7c0 1.5-2.2 1.9-2.2 3.1"/><path d="M12 16.4h.01"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  warn: '<path d="M12 3.5l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
};
const SUGGESTIONS = ['现在卡在哪？', '为什么这么做？', '还要多久？'];
const WAIT_HINT = '通常 30–60 秒，会话照常运行';

const pad2 = n => String(n).padStart(2, '0');
function clock(iso) { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function elapsed(fromIso, now = Date.now()) {
  const start = new Date(fromIso).getTime();
  const s = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}
// 回答是纯文本：空行分段，段内换行保留，`代码` 显示成行内代码；全部走 textContent，不解析 HTML。
function answerBlocks(text) {
  return String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map(p => p.replace(/^\n+|\n+$/g, '')).filter(Boolean)
    .map(p => p.split(/(`[^`\n]+`)/).filter(Boolean).map(part => (/^`[^`]+`$/.test(part) ? { code: part.slice(1, -1) } : { text: part })));
}

function createAskAsideUi({ document, ipcRenderer, getSession, getTitle = s => s?.title || '', now = Date.now, setInterval: tick = setInterval, clearInterval: untick = clearInterval }) {
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  const icon = name => { const span = el('span'); span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`; return span.firstChild; };

  const button = el('button', 'ask-entry'); button.type = 'button'; button.hidden = true;
  button.append(icon('ask'), document.createTextNode('问一下'));
  const drawer = el('section', 'ask'); drawer.hidden = true; drawer.setAttribute('aria-label', '问一下');
  const head = el('header', 'ask-h');
  const ttl = el('div', 'ask-ttl'); const subtitle = el('p');
  ttl.append(el('h3', '', '问一下'), subtitle);
  const ic = el('span', 'ask-ic'); ic.append(icon('ask'));
  const close = el('button', 'icon-btn'); close.type = 'button'; close.title = '关闭'; close.setAttribute('aria-label', '关闭问一下'); close.append(icon('x'));
  head.append(ic, ttl, close);
  const body = el('div', 'ask-b');
  const foot = el('footer', 'ask-f'); const box = el('div', 'ask-in');
  const input = el('textarea'); input.rows = 2; input.maxLength = 4000; input.placeholder = '问进展、原因或当前判断…'; input.setAttribute('aria-label', '问一下的问题');
  const row = el('div', 'row'); const hint = el('span'); const send = el('button', 'btn btn-pri btn-sm', '提问'); send.type = 'button';
  row.append(hint, send); box.append(input, row); foot.append(box);
  drawer.append(head, body, foot);
  document.body.appendChild(drawer);

  let sessionId = null, state = null, requestVersion = 0, capabilityVersion = 0, sending = false, timer = null, panelObserver = null;
  // 看到底部时保持贴底：新回答、窗口变矮后最新一条都不被挤出视野；用户往上翻看旧问答时不打扰。
  let stick = true;
  const atBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  const toBottom = () => { body.scrollTop = body.scrollHeight; };
  const expanded = new Set(), watching = new Set(), refilled = new Set();
  const call = async (method, args) => { const r = await ipcRenderer.invoke('ask-aside:' + method, args); if (!r || !r.ok) throw new Error(r?.error || '问一下没有响应'); return r.result; };

  // 位置贴着会话区：上沿与会话区对齐，下沿在状态栏之上，右侧留 12px。
  function place() {
    const panel = document.getElementById('terminal-panel');
    const win = document.defaultView;
    if (!panel || !win || typeof panel.getBoundingClientRect !== 'function') return;
    const r = panel.getBoundingClientRect();
    if (!r.width || !r.height) return;
    drawer.style.setProperty('--ask-top', `${Math.round(r.top)}px`);
    drawer.style.setProperty('--ask-right', `${Math.round(win.innerWidth - r.right + 12)}px`);
    drawer.style.setProperty('--ask-bottom', `${Math.round(win.innerHeight - r.bottom + 12)}px`);
  }

  let ticks = 0;
  function updateTimes() {
    for (const node of body.querySelectorAll('[data-since]')) node.textContent = elapsed(node.dataset.since, now());
    // 暂时不能问（例如会话还没落盘第一轮）：抽屉开着时每 5 秒再查一次，能问了自动解锁。
    if (state && state.supported === false && ++ticks % 5 === 0) refresh().catch(() => {});
  }
  function syncTimer(active) {
    if (active && !timer && !drawer.hidden) timer = tick(updateTimes, 1000);
    if ((!active || drawer.hidden) && timer) { untick(timer); timer = null; }
  }

  function renderAnswer(item) {
    const a = el('div', 'ask-a');
    for (const parts of answerBlocks(item.a)) {
      const p = el('p');
      for (const part of parts) p.append(part.code != null ? el('code', '', part.code) : document.createTextNode(part.text));
      a.append(p);
    }
    return a;
  }
  function waitBlock({ thinking, title, small, since }) {
    const w = el('div', 'ask-wait' + (thinking ? ' thinking' : ''));
    if (thinking) { const dots = el('span', 'dots'); dots.append(el('i'), el('i'), el('i')); w.append(dots); }
    const t = el('div', 't', title); t.append(el('small', '', small)); w.append(t);
    if (since) { const time = el('time'); time.dataset.since = since; time.textContent = elapsed(since, now()); w.append(time); }
    return w;
  }
  function renderItem(item, { fold, queuePos }) {
    const qa = el('div', 'ask-qa' + (fold ? ' is-fold' : '')); qa.dataset.id = item.id; qa.dataset.status = item.status;
    const q = el('div', 'ask-q'); q.append(el('p', '', item.q)); qa.append(q);
    if (item.status === 'queued') {
      qa.append(waitBlock({ thinking: false, title: queuePos > 1 ? `正在排队，前面还有 ${queuePos - 1} 个问题` : '正在排队，马上开始', small: '前面的问题答完后自动开始' }));
    } else if (item.status === 'running') {
      // 后台答完才整段给出（公司回执：CodeAgent 没有真流式），所以只有「思考中」→ 整段回答，不做逐字。
      qa.append(waitBlock({ thinking: true, title: '正在读这个会话的上下文', small: WAIT_HINT, since: item.startedAt || item.at }));
    } else {
      if (item.a) qa.append(renderAnswer(item));
      if (item.status === 'error') {
        const err = el('div', 'ask-err'); const t = el('div', 't', `没问成：${item.error || '原因未知'}`);
        if (refilled.has(item.id)) t.append(el('small', '', '问题已放回输入框，恢复会话后再点「提问」。'));
        err.append(icon('warn'), t); qa.append(err);
      }
      if (item.a) {
        const bits = [`用时 ${Math.round(item.wall_s || 0)} 秒`, clock(item.at), '未进入会话记录'];
        if (item.truncated) bits.push('回答较长已截断');
        const meta = el('div', 'ask-meta', bits.filter(Boolean).join(' · '));
        if (fold) { const more = el('button', 'ask-more', '展开'); more.type = 'button'; more.hidden = true; more.dataset.more = item.id; meta.append(more); }
        qa.append(meta);
      }
    }
    return qa;
  }

  function paintFooter() {
    const items = state?.items || [];
    const busy = items.some(item => item.status === 'queued' || item.status === 'running');
    const blocked = state && state.supported === false;
    hint.className = blocked ? 'warn' : '';
    hint.textContent = blocked ? (state.reason || '这个会话暂时不能问') : busy ? '这条答完前再问，会排在后面' : '通常 30–60 秒 · Enter 换行';
    hint.title = hint.textContent;
    send.disabled = sending || blocked || !input.value.trim();
  }

  function paint(data) {
    const prev = new Map((state?.items || []).map(item => [item.id, item.status]));
    state = data;
    const account = data.account ? ` · 用「${data.account}」的额度` : '';
    const session = getSession();
    subtitle.textContent = `${(session && session.id === sessionId && getTitle(session)) || '当前会话'}${account}`;
    subtitle.title = subtitle.textContent;
    // 刚问的那条失败了：问题放回输入框（输入框空着才放，免得覆盖正在写的新问题）。
    for (const item of data.items) {
      const was = prev.get(item.id);
      if (item.status === 'error' && watching.has(item.id) && (was === 'queued' || was === 'running')) {
        watching.delete(item.id);
        if (!input.value.trim()) { input.value = item.q; refilled.add(item.id); }
      }
      if (item.status === 'done') watching.delete(item.id);
    }
    body.replaceChildren();
    if (!data.items.length) {
      const intro = el('div', 'ask-intro');
      intro.append(el('p', '', '随时问一句，正在跑的会话照常运行。回答基于这个会话到现在的上下文，问答只留在这里，不写进会话记录。'));
      const chips = el('div', 'ask-chips');
      for (const q of SUGGESTIONS) { const chip = el('button', 'ask-chip', q); chip.type = 'button'; chip.onclick = () => { input.value = q; input.focus(); paintFooter(); }; chips.append(chip); }
      intro.append(chips); body.append(intro);
    }
    let queuePos = 0;
    const last = data.items.length - 1;
    data.items.forEach((item, index) => {
      if (item.status === 'queued' || item.status === 'running') queuePos++;
      const fold = index < last && item.status === 'done' && !expanded.has(item.id);
      body.append(renderItem(item, { fold, queuePos }));
    });
    // 只有真被截成两行的才给「展开」。
    for (const more of body.querySelectorAll('[data-more]')) {
      const answer = more.closest('.ask-qa')?.querySelector('.ask-a');
      if (answer && answer.scrollHeight > answer.clientHeight + 2) more.hidden = false;
    }
    if (stick || !prev.size) { stick = true; toBottom(); }
    syncTimer(data.items.some(item => item.status === 'running') || data.supported === false);
    paintFooter();
  }

  async function refresh() {
    const id = sessionId, version = ++requestVersion;
    const data = await call('list', { sessionId: id });
    if (id === sessionId && version === requestVersion) paint(data);
  }
  async function ask() {
    const question = input.value.trim();
    if (sending || !question || !sessionId) return;
    sending = true; paintFooter();
    const id = sessionId;
    try {
      const result = await call('ask', { sessionId: id, question });
      if (id !== sessionId) return;
      if (result?.id) watching.add(result.id);
      input.value = ''; await refresh();
    } catch (error) {
      if (id === sessionId) { hint.className = 'warn'; hint.textContent = error.message; hint.title = error.message; }
    } finally {
      sending = false;
      if (id === sessionId) send.disabled = !input.value.trim() || state?.supported === false;
    }
  }
  function open() {
    const session = getSession(); if (!session) return;
    if (sessionId !== session.id) { sessionId = session.id; state = null; input.value = ''; expanded.clear(); refilled.clear(); body.replaceChildren(); }
    place();
    drawer.hidden = false; button.classList.add('on');
    if (!panelObserver && typeof document.defaultView?.ResizeObserver === 'function') {
      const panel = document.getElementById('terminal-panel');
      if (panel) { panelObserver = new document.defaultView.ResizeObserver(() => { place(); if (stick) toBottom(); }); panelObserver.observe(panel); panelObserver.observe(body); }
    }
    refresh().then(() => input.focus()).catch(error => { hint.className = 'warn'; hint.textContent = error.message; });
  }
  function hide() { drawer.hidden = true; button.classList.remove('on'); syncTimer(false); }

  button.onclick = () => (drawer.hidden ? open() : hide());
  close.onclick = hide;
  send.onclick = () => { void ask(); };
  input.addEventListener('input', paintFooter);
  input.addEventListener('focus', () => box.classList.add('is-focus'));
  input.addEventListener('blur', () => box.classList.remove('is-focus'));
  drawer.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); hide(); } });
  body.addEventListener('click', event => {
    const more = event.target.closest && event.target.closest('[data-more]');
    if (!more) return;
    expanded.add(more.dataset.more); if (state) paint(state);
  });
  body.addEventListener('scroll', () => { stick = atBottom(); });
  document.defaultView?.addEventListener?.('resize', () => { if (!drawer.hidden) { place(); if (stick) toBottom(); } });
  ipcRenderer.on('ask-aside:changed', (_event, data) => {
    if (!data || data.sessionId !== sessionId) return;
    requestVersion++; // 推送比更早发出的 list 请求新。
    if (!drawer.hidden) paint(data); else state = data;
  });

  return {
    button, drawer, open, hide,
    sync(visible) {
      const session = getSession();
      const area = document.getElementById('toolbar-actions');
      const codeagent = !!session && require('../core/ai-kinds').isCodeAgentKind(session.kind);
      button.hidden = !visible || !codeagent;
      // 放在顶栏操作区最前（「文件管理」之前）；顶栏重绘后补回来。
      if (area && (!button.isConnected || area.firstChild !== button)) area.insertBefore(button, area.firstChild);
      if (sessionId && session?.id !== sessionId) hide();
      if (button.hidden) return;
      const version = ++capabilityVersion;
      void call('support', { sessionId: session.id }).then(result => {
        if (version !== capabilityVersion || getSession()?.id !== session.id) return;
        // 按钮不禁用：能力会随会话进展变化（第一轮落盘后才能问），打开抽屉后底部写原因并自动复查。
        button.title = result.supported ? '问一下：基于这个会话的上下文另开后台回答，不打断会话' : `问一下：${result.reason}`;
      }).catch(error => { if (version === capabilityVersion) button.title = `问一下：${error.message}`; });
    },
  };
}

function mountAskAsideUi(win = typeof window !== 'undefined' ? window : null) {
  if (!win || win.__askAsideUi) return win && win.__askAsideUi;
  const doc = win.document, area = doc && doc.getElementById && doc.getElementById('toolbar-actions');
  if (!area || typeof win.MutationObserver !== 'function') return null;
  if (!require('../core/distribution').featureEnabled('btwAsk')) return null;
  /* global sessions, sessionSplit, activeSessionId, currentAppToolbarView */
  const current = () => { try { return sessions.get((typeof sessionSplit !== 'undefined' && sessionSplit?.focusedId()) || activeSessionId) || null; } catch { return null; } };
  const visible = () => { try { return !!activeSessionId && !(typeof currentAppToolbarView === 'function' && currentAppToolbarView()); } catch { return false; } };
  const { sessionDisplayTitle } = require('../core/session-title-guards.js');
  const ui = createAskAsideUi({ document: doc, ipcRenderer: require('electron').ipcRenderer, getSession: current,
    getTitle: session => { try { return sessionDisplayTitle(session); } catch { return session?.title || ''; } } });
  let queued = false;
  new win.MutationObserver(() => {
    if (queued) return; queued = true;
    win.requestAnimationFrame(() => { queued = false; ui.sync(visible()); });
  }).observe(area, { childList: true });
  ui.sync(visible()); win.__askAsideUi = ui; return ui;
}

module.exports = { createAskAsideUi, mountAskAsideUi, answerBlocks, elapsed };
