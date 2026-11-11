'use strict';
// 首次启动准备页（主进程见 main/ipc/first-run-handlers.js）。第一次全屏显示进度；CodeAgent 变了只在右下角同步；
// 上次有没处理好的项给一条小提示。任何时候都能进入 Hub，出错就什么都不显示，绝不挡住主界面。
(() => {
  const { ipcRenderer } = require('electron');
  const FINAL = new Set(['ok', 'warn', 'bad', 'off', 'hold']);
  const AUTO_ENTER_MS = 1500;
  let root = null, strip = null, rows = new Map(), startedAt = 0, ticker = null, enterTimer = null, recheckOnFocus = false, finished = false;

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  function injectStyle() {
    if (document.getElementById('first-run-style')) return;
    document.head.append(Object.assign(document.createElement('link'), { id: 'first-run-style', rel: 'stylesheet', href: 'styles/first-run-prep.css' }));
  }
  const close = () => { clearTimeout(enterTimer); clearInterval(ticker); root?.remove(); root = null; };
  const rerun = () => { finished = false; clearTimeout(enterTimer); startedAt = Date.now(); void ipcRenderer.invoke('first-run:start', { mode: 'full' }); };

  async function doFix(fix, row) {
    if (fix.act === 'recheck') return rerun();
    if (fix.act === 'open-gate') { await ipcRenderer.invoke('net-pass:open-window', fix.url); return rerun(); }
    if (fix.act === 'open-codeagent') { await ipcRenderer.invoke('tool-discovery:pick', { tool: 'codeagent' }); return rerun(); }
    if (fix.act === 'open-update') { window.__appUpdate?.open?.(); return; }
    if (fix.act === 'codeagent-login') recheckOnFocus = true;
    const result = await (fix.act === 'git-install' ? ipcRenderer.invoke('cli-tools:install', { id: 'git' })
      : fix.act === 'codeagent-login' ? ipcRenderer.invoke('codeagent-pool:personal-login')
      : ipcRenderer.invoke('env-check:fix', { id: row.id, act: fix.act, url: fix.url }));
    if (fix.act === 'proxy-restart') return rerun();
    if (result && result.ok === false) { const cell = root?.querySelector(`[data-fr="${row.id}"] .fr-d`); if (cell) cell.textContent = result.error || '没能完成'; return; }
    if (fix.act === 'git-install') return rerun();
    recheckOnFocus = true; // 去外面安装、下载的，回到 Hub 时自动重查
  }
  function paintRow(row) {
    const line = root?.querySelector(`[data-fr="${row.id}"]`);
    if (!line) return;
    line.querySelector('.fr-dot').className = `fr-dot ${row.status}`;
    line.querySelector('.fr-d').textContent = row.detail || '';
    line.querySelectorAll('.fr-fix').forEach(b => b.remove());
    if (row.status === 'bad' || row.status === 'warn') (row.fixes || []).slice(0, 2).forEach((fix, i) => {
      const b = el('button', 'fr-fix' + (i ? ' alt' : ''), fix.label); b.type = 'button'; b.onclick = async () => {
        b.disabled = true;
        try { await doFix(fix, row); }
        catch (error) { line.querySelector('.fr-d').textContent = `没能完成：${error.message}，可重试`; }
        finally { b.disabled = false; }
      }; line.append(b);
    });
  }
  function counts() {
    const list = [...rows.values()], done = list.filter(r => FINAL.has(r.status)).length;
    return { total: list.length, done, bad: list.filter(r => r.status === 'bad').length, hold: list.filter(r => r.status === 'hold').length, warn: list.filter(r => r.status === 'warn').length };
  }
  function paintSummary() {
    if (!root) return;
    const c = counts(), seconds = Math.round((Date.now() - startedAt) / 1000);
    root.querySelector('.fr-bar i').style.width = c.total ? `${c.done * 100 / c.total}%` : '0';
    root.querySelector('.fr-sum').textContent = c.bad || c.hold ? `已用 ${seconds} 秒 · ${c.bad} 项需要处理${c.hold ? `，${c.hold} 项在等它们` : ''}${c.warn ? `，${c.warn} 项提醒` : ''}` : finished ? c.warn ? `准备已完成，还有 ${c.warn} 项提醒；可先进入 Hub，用到时再处理。` : '全部就绪' : `已完成 ${c.done} / ${c.total}`;
    const go = root.querySelector('.fr-go');
    if (finished && !c.bad && !c.hold) { go.textContent = '进入 Hub'; go.classList.add('pri'); }
    else go.textContent = c.bad || c.hold ? '先进入 Hub，这些以后再处理' : '先进入 Hub，其余在后台继续';
  }
  function drawFull(groups) {
    injectStyle();
    if (!root) {
      root = el('div', 'fr-mask'); root.id = 'first-run-prep';
      root.innerHTML = '<div class="fr-card" role="dialog" aria-label="首次启动准备"><h3>正在为第一次使用做准备</h3><div class="fr-hint">正在检查工具、登录和模型连接。完成后即可开始，暂时用不到的功能可以以后再准备。</div><div class="fr-bar"><i></i></div><div class="fr-list"></div><div class="fr-foot"><span class="fr-sum"></span><button type="button" class="fr-go">先进入 Hub，其余在后台继续</button></div></div>';
      root.querySelector('.fr-go').onclick = close;
      document.body.append(root);
      clearInterval(ticker); ticker = setInterval(paintSummary, 1000);
    }
    const list = root.querySelector('.fr-list'); list.textContent = ''; rows = new Map();
    root.querySelector('h3').textContent = '正在为第一次使用做准备';
    root.querySelector('.fr-hint').textContent = '正在检查工具、登录和模型连接。完成后即可开始，暂时用不到的功能可以以后再准备。';
    for (const group of groups) {
      list.append(el('div', 'fr-grp', group.name));
      for (const row of group.rows) {
        rows.set(row.id, { id: row.id, status: 'wait' });
        const line = el('div', 'fr-row'); line.dataset.fr = row.id;
        line.append(el('span', 'fr-dot wait'), el('span', 'fr-n', row.label), el('span', 'fr-d', '等待中'));
        list.append(line);
      }
    }
    paintSummary();
  }
  function showStrip(title, lines) {
    injectStyle(); strip?.remove();
    strip = el('div', 'fr-strip'); strip.append(el('b', '', title));
    for (const [text, action] of lines) { const b = el('button', 'fr-link', text); b.type = 'button'; b.onclick = action; strip.append(b); }
    document.body.append(strip); return strip;
  }
  const stripRow = id => strip?.querySelector(`[data-fr-s="${id}"]`);
  function onChanged(event) {
    if (event.type === 'start') { rows = new Map(); showStrip('CodeAgent 有变化，正在同步', []); for (const g of event.groups) for (const r of g.rows) { const l = el('div', 'fr-sl'); l.dataset.frS = r.id; l.append(el('span', 'fr-dot wait'), el('span', '', r.label)); strip.append(l); } }
    if (event.type === 'row') { rows.set(event.row.id, event.row); const l = stripRow(event.row.id); if (l) { l.querySelector('.fr-dot').className = `fr-dot ${event.row.status}`; if (event.row.status === 'bad') l.lastChild.textContent += `：${event.row.detail}`; } }
    if (event.type === 'done') { if (event.problems.length || counts().warn || event.held.length) { strip.append(el('div', 'fr-sl', '有项目需要处理或提醒，可到设置里的功能体检查看')); strip.append(Object.assign(el('button', 'fr-link', '关闭'), { type: 'button', onclick: () => strip.remove() })); } else { strip.querySelector('b').textContent = '已同步，可以继续用'; setTimeout(() => strip?.remove(), 2500); } }
  }
  let currentMode = 'none';
  window.__firstRunPrep = { openSaved() {
    const prep = require('../core/first-run-prep');
    const state = prep.readState(require('../core/data-dir').getHubDataDir());
    if (prep.pendingCount(state) === null) return false;
    clearTimeout(enterTimer);
    const savedRows = { ...Object.fromEntries((state.problems || []).map(id => [id, { id, status: 'bad', detail: '上次未完成，可重新检查', fixes: [{ label: '重新检查', act: 'recheck' }] }])), ...state.rows };
    currentMode = 'full'; startedAt = Date.now(); finished = true;
    drawFull(prep.layout({ isCompany: require('../core/distribution').target === 'company' })
      .map(group => ({ ...group, rows: group.rows.filter(row => savedRows[row.id]) })).filter(group => group.rows.length));
    for (const row of Object.values(savedRows)) { rows.set(row.id, row); paintRow(row); }
    root.querySelector('h3').textContent = '上次准备结果';
    root.querySelector('.fr-hint').textContent = '这里显示已保存的结果；需要时可点对应项目的「重新检查」。';
    paintSummary(); return true;
  } };
  ipcRenderer.on('first-run:event', (_e, event) => {
    if (currentMode === 'changed') return onChanged(event);
    if (event.type === 'start' && root) drawFull(event.groups);
    if (event.type === 'row') { rows.set(event.row.id, event.row); paintRow(event.row); paintSummary(); }
    if (event.type === 'done') {
      finished = true; paintSummary();
      clearTimeout(enterTimer);
      const c = counts();
      if (root && !event.problems.length && !event.held.length && !c.warn) enterTimer = setTimeout(close, AUTO_ENTER_MS);
    }
  });
  window.addEventListener('focus', () => { if (recheckOnFocus && root) { recheckOnFocus = false; rerun(); } });

  async function start() {
    let state;
    try { state = await ipcRenderer.invoke('first-run:state'); } catch { return; }
    if (!state || state.mode === 'none') return;
    if (state.mode === 'full') { currentMode = 'full'; startedAt = Date.now(); drawFull(state.layout || []); void ipcRenderer.invoke('first-run:start', { mode: 'full' }); return; }
    if (state.mode === 'changed') { currentMode = 'changed'; void ipcRenderer.invoke('first-run:start', { mode: 'changed' }); return; }
    if (state.mode === 'remind') showStrip('上次有几项没准备好', [['重新检查', () => { strip.remove(); currentMode = 'full'; startedAt = Date.now(); drawFull(state.layout || []); void ipcRenderer.invoke('first-run:start', { mode: 'full' }); }], ['先不管', () => strip.remove()]]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else void start();
})();
