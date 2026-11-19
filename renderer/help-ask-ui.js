'use strict';
// 「问问 Hub」（2026-11-19）：底栏右侧一个小按钮，点开右侧答疑面板，照随包的《使用说明书》回答「XX 设置在哪」「模型选不到怎么办」。
// 外观沿用会话顶栏「问一下」的抽屉（styles/ask-aside.css 的 .ask 一套），按钮样式同底栏「用户群」。
// 只读：主进程起一次性后台问答（main/help-ask-service.js → core/help-ask/engine.js），不建会话、不给工具。
// 开箱即用：没有可用的 AI 命令行时就地说明，并给「功能体检与组件中心」「去账号页登录」两个按钮；答不了的引导一键反馈并带上问题。
const BUTTON_TITLE = '问问 Hub：功能在哪、设置怎么改、报错先怎么处理，照使用说明书回答';
const SUGGESTIONS = ['模型下拉里选不到我要的模型怎么办？', '怎么用部门的 API key？', '怎么升级到最新版？', '考勤读不到，OD 页在哪切换？'];
const ICONS = {
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.5"/><path d="M12 17h.01"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  warn: '<path d="M12 3.5l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
};
const ENGINE_WAIT = { codeagent: '20–30 秒', claude: '10–20 秒', codex: '20–40 秒' };
const state = { open: false };

const STYLE = `
#sidebar-strip .strip-help-ask { display:inline-flex; align-items:center; gap:3px; flex:none; height:22px; padding:0 7px 0 6px; margin-right:4px; border:1px solid var(--border-subtle, #d7dde6); border-radius:11px; background:transparent; color:var(--brand, #3478f6); font:500 11px/1 var(--font-sans, 'Microsoft YaHei', sans-serif); white-space:nowrap; cursor:pointer; }
#sidebar-strip .strip-help-ask svg { width:12px; height:12px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
#sidebar-strip .strip-help-ask:hover, #sidebar-strip .strip-help-ask[aria-expanded='true'] { background:var(--brand-tint, #eaf2ff); border-color:var(--brand, #3478f6); }
#sidebar-strip .strip-help-ask:focus-visible { outline:2px solid var(--brand, #3478f6); outline-offset:1px; }
#hub-system-footer[data-density='minimal'] #sidebar-strip .strip-help-ask-label { display:none; }
.help-ask-panel .ha-tools { display:flex; gap:2px; flex:none; }
.help-ask-panel .ha-link { padding:0; font-size:var(--hw-fs-12, 12px); color:var(--hw-brand, #3478f6); }
.help-ask-panel .ha-link:hover { text-decoration:underline; }
.help-ask-panel .ask-meta .ha-link { margin-left:auto; }
.help-ask-panel .ha-setup { margin-top:12px; padding:12px 14px; border-radius:var(--hw-r-md, 10px); background:var(--hw-amber-soft, #fff4e0); font-size:var(--hw-fs-13, 13px); line-height:1.7; color:var(--hw-text-1, #1f2933); }
.help-ask-panel .ha-setup .ha-actions, .help-ask-panel .ask-err .ha-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.help-ask-panel .ha-setup .btn, .help-ask-panel .ask-err .btn { height:28px; padding:0 12px; font-size:var(--hw-fs-12, 12px); background:var(--hw-surface, #fff); box-shadow:inset 0 0 0 1px var(--hw-line, #dfe3ea); }
.help-ask-panel .ha-setup .btn:hover, .help-ask-panel .ask-err .btn:hover { color:var(--hw-brand, #3478f6); }
.help-ask-panel .ask-a ul { margin:4px 0 0; padding-left:18px; }
`;

function iconSvg(name, size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

function helpAskButtonHtml({ open = state.open } = {}) {
  return `<button type="button" class="strip-help-ask" id="btn-help-ask" data-help-ask aria-haspopup="dialog" aria-controls="help-ask-panel" aria-expanded="${open ? 'true' : 'false'}" title="${BUTTON_TITLE}">${iconSvg('help', 12)}<span class="strip-help-ask-label">问问 Hub</span></button>`;
}

// 回答按纯文本显示：空行分段、段内换行保留、`代码` 显示成行内代码、去掉 **加粗** 记号；全部走 textContent，不解析 HTML。
function answerBlocks(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\*\*([^*\n]+)\*\*/g, '$1').split(/\n{2,}/)
    .map(p => p.replace(/^\n+|\n+$/g, '')).filter(Boolean)
    .map(p => p.split(/(`[^`\n]+`)/).filter(Boolean).map(part => (/^`[^`]+`$/.test(part) ? { code: part.slice(1, -1) } : { text: part })));
}

function seconds(ms) { return ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms} 毫秒`; }

function attachHelpAsk({ document: doc, ipcRenderer, openPath = p => doc.defaultView?.openPreviewPanel?.(p, { preview: true }),
  openFeedback = prefill => doc.defaultView?.__hubFeedback?.open?.(prefill), now = Date.now } = {}) {
  if (!doc || !ipcRenderer || doc.getElementById('help-ask-panel')) return null;
  const style = doc.createElement('style'); style.id = 'help-ask-style'; style.textContent = STYLE; doc.head.appendChild(style);
  const el = (tag, className, text) => { const n = doc.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; };
  const iconEl = name => { const s = el('span'); s.innerHTML = iconSvg(name); return s.firstChild; };
  const btn = (className, text, onClick, title) => { const b = el('button', className, text); b.type = 'button'; if (title) { b.title = title; b.setAttribute('aria-label', title); } b.addEventListener('click', onClick); return b; };

  const panel = el('section', 'ask help-ask-panel'); panel.id = 'help-ask-panel'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '问问 Hub');
  const head = el('header', 'ask-h');
  const ic = el('span', 'ask-ic'); ic.append(iconEl('help'));
  const ttl = el('div', 'ask-ttl'); const subtitle = el('p', '', '照《使用说明书》回答');
  ttl.append(el('h3', '', '问问 Hub'), subtitle);
  const tools = el('div', 'ha-tools');
  const manualBtn = btn('icon-btn', '', () => void openManual(), '打开使用说明书'); manualBtn.dataset.ha = 'manual'; manualBtn.append(iconEl('book'));
  const closeBtn = btn('icon-btn', '', () => close(), '关闭问问 Hub'); closeBtn.dataset.ha = 'close'; closeBtn.append(iconEl('x'));
  tools.append(manualBtn, closeBtn);
  head.append(ic, ttl, tools);
  const body = el('div', 'ask-b');
  const foot = el('footer', 'ask-f'); const box = el('div', 'ask-in');
  const input = el('textarea'); input.rows = 2; input.maxLength = 2000; input.placeholder = '例如：回车想换行在哪改？'; input.setAttribute('aria-label', '想问 Hub 的问题');
  const row = el('div', 'row'); const hint = el('span', '', 'Ctrl+Enter 发送 · 只读，不改你的文件');
  const send = btn('btn btn-pri btn-sm', '提问', () => void submit()); send.dataset.ha = 'send';
  row.append(hint, send); box.append(input, row); foot.append(box);
  panel.append(head, body, foot);
  doc.body.appendChild(panel);
  input.addEventListener('focus', () => box.classList.add('is-focus'));
  input.addEventListener('blur', () => box.classList.remove('is-focus'));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); }
  });

  const items = []; // { q, a, error, engineLabel, ms, pending, at }
  let info = null, sending = false;

  function place() {
    const win = doc.defaultView; if (!win) return;
    const top = doc.getElementById('app-toolbar')?.getBoundingClientRect?.().bottom || 54;
    const footer = doc.getElementById('hub-system-footer')?.getBoundingClientRect?.();
    const bottom = footer && footer.height ? win.innerHeight - footer.top + 8 : 12;
    panel.style.setProperty('--ask-top', `${Math.round(top + 8)}px`);
    panel.style.setProperty('--ask-right', '12px');
    panel.style.setProperty('--ask-bottom', `${Math.round(bottom)}px`);
  }
  const buttonEl = () => doc.querySelector('.strip-help-ask[data-help-ask]');
  const syncButton = () => buttonEl()?.setAttribute('aria-expanded', state.open ? 'true' : 'false');

  function setupBox() {
    const boxEl = el('div', 'ha-setup');
    boxEl.dataset.ha = 'setup';
    boxEl.append(el('p', '', '这台电脑上还没有能用的 AI 命令行。问问 Hub 需要 CodeAgent、Claude Code、Codex 其中一个：公司电脑装好并登录 CodeAgent 就行。'));
    const actions = el('div', 'ha-actions');
    actions.append(
      btn('btn', '功能体检与一键安装', () => { doc.getElementById('options-env-check')?.click(); }),
      btn('btn', '去账号页登录 CodeAgent', () => { close(); doc.getElementById('btn-rail-accounts')?.click(); }),
      btn('btn', '装好了，重新检测', () => void refresh()),
    );
    boxEl.append(actions);
    return boxEl;
  }

  function feedbackLink(item) {
    const b = btn('ha-link', '没解决？一键反馈', () => openFeedback({ description: `【问问 Hub 没解决】${item.q}${item.error ? `\n（问问 Hub 报错：${item.error}）` : ''}\n（可以在这里补一句你看到的现象）` }));
    b.dataset.ha = 'feedback';
    return b;
  }

  function renderItem(item) {
    const qa = el('div', 'ask-qa');
    const q = el('div', 'ask-q'); q.append(el('p', '', item.q)); qa.append(q);
    if (item.pending) {
      const wait = el('div', 'ask-wait hw-sweep');
      const dots = el('span', 'dots'); dots.append(el('i'), el('i'), el('i'));
      const t = el('div', 't'); t.append(doc.createTextNode('正在查说明书…'), el('small', '', `用 ${info?.engineLabel || 'AI'} 回答，一般 ${ENGINE_WAIT[info?.engine] || '半分钟左右'}，最多 ${info?.totalSeconds || 60} 秒`));
      const stop = btn('btn btn-sm', '取消', () => void cancel()); stop.dataset.ha = 'cancel';
      wait.append(dots, t, stop); qa.append(wait);
    } else if (item.error) {
      const err = el('div', 'ask-err'); err.append(iconEl('warn'));
      const t = el('div', 't'); t.append(doc.createTextNode(item.cancelled ? '已取消' : '没答出来'), el('small', '', item.error));
      const actions = el('div', 'ha-actions');
      actions.append(btn('btn', '再问一次', () => void submit(item.q)));
      if (!item.cancelled) actions.append(btn('btn', '一键反馈', () => feedbackLink(item).click()));
      t.append(actions); err.append(t); qa.append(err);
    } else {
      const a = el('div', 'ask-a');
      for (const parts of answerBlocks(item.a)) {
        const p = el('p');
        for (const part of parts) p.append(part.code != null ? el('code', '', part.code) : doc.createTextNode(part.text));
        a.append(p);
      }
      qa.append(a);
      const meta = el('div', 'ask-meta');
      meta.append(el('span', '', `${item.engineLabel || ''}${item.ms ? ' · ' + seconds(item.ms) : ''}`), feedbackLink(item));
      qa.append(meta);
    }
    return qa;
  }

  function render() {
    body.replaceChildren();
    if (!items.length) {
      const intro = el('div', 'ask-intro');
      intro.append(el('p', '', '问 Hub 怎么用：功能在哪、设置怎么改、报错先怎么处理。它只看随安装包的《使用说明书》，不读你的文件、不执行命令；答不了的可以一键反馈给维护人。'));
      const chips = el('div', 'ask-chips');
      for (const s of SUGGESTIONS) { const c = btn('ask-chip', s, () => void submit(s)); c.dataset.ha = 'chip'; chips.append(c); }
      intro.append(chips);
      body.append(intro);
    }
    if (info && !info.engine) body.append(setupBox());
    for (const item of items) body.append(renderItem(item));
    send.disabled = sending || !!(info && !info.engine);
    body.scrollTop = body.scrollHeight;
  }

  async function refresh() {
    try { info = await ipcRenderer.invoke('help-ask:state'); } catch { info = null; }
    subtitle.textContent = info?.engine ? `照《使用说明书》回答 · 用 ${info.engineLabel}` : '照《使用说明书》回答';
    render();
  }

  async function submit(text) {
    const q = String(text != null ? text : input.value).trim();
    if (!q || sending) return;
    if (info && !info.engine) { render(); return; }
    sending = true;
    if (text == null) input.value = '';
    const item = { q, pending: true, at: now() };
    items.push(item); render();
    const history = items.filter(i => i !== item && i.a).slice(-3).map(i => ({ q: i.q, a: i.a }));
    let r;
    try { r = await ipcRenderer.invoke('help-ask:ask', { question: q, history }); } catch (error) { r = { ok: false, error: error.message }; }
    if (item.cancelled) return; // 已取消：旧进程收尾的结果不再显示，名额早已放开
    item.pending = false;
    if (r && r.ok) Object.assign(item, { a: r.answer, engineLabel: r.engineLabel, ms: r.ms });
    else {
      item.error = (r && r.error) || '没有响应';
      if (r && r.needSetup) await refresh();
    }
    sending = false;
    render();
  }

  // 取消：结束后台问答进程树，当前这题标「已取消」，马上可以问下一题。
  async function cancel() {
    const item = items.find(i => i.pending);
    if (!item) return;
    item.pending = false; item.cancelled = true; item.error = '已取消，可以直接问下一题';
    sending = false; render();
    try { await ipcRenderer.invoke('help-ask:cancel'); } catch { /* 主进程已结束 */ }
  }

  async function openManual() {
    let r;
    try { r = await ipcRenderer.invoke('help-ask:open-manual'); } catch (error) { r = { ok: false, error: error.message }; }
    if (r && r.ok) { close(); openPath(r.path); }
    else { items.push({ q: '打开使用说明书', error: (r && r.error) || '打不开' }); render(); }
  }

  function open() {
    state.open = true; panel.hidden = false; place(); syncButton();
    void refresh();
    setTimeout(() => input.focus(), 0);
  }
  function close() {
    if (!state.open) return;
    if (sending) void cancel(); // 关面板即取消，不在后台继续耗额度
    state.open = false; panel.hidden = true; syncButton();
  }

  doc.addEventListener('click', event => {
    if (!event.target.closest?.('[data-help-ask]')) return;
    event.preventDefault();
    if (state.open) close(); else open();
  });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && state.open && panel.contains(doc.activeElement)) close(); });
  doc.defaultView?.addEventListener('resize', place);
  return { open, close, cancel, isOpen: () => state.open, panel, submit };
}

module.exports = { BUTTON_TITLE, SUGGESTIONS, helpAskButtonHtml, attachHelpAsk, answerBlocks, _state: state };
