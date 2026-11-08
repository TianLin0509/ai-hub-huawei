'use strict';
// 环境体检（5.5.24，产品负责人拍板）：设置菜单「🩺 环境体检」一屏列出各外部工具与本机条件是绿/黄/红，
// 红黄项右侧给修复按钮，点「详情」展开成统一错误卡（有 window.HubErrorCard 时用它，自带「问问 Agent」「一键反馈」；没有就用简版说明）。
// 首次启动、升级后第一次打开时，主页顶部出一条「点此体检」小提示，只出一次，可关。
// 检测在主进程（main/ipc/env-check-handlers.js → core/env-check.js），这里只负责画和转发按钮。
(() => {
  const { ipcRenderer } = require('electron');
  const HINT_KEY = 'hub:envCheck:hintVersion';
  const current = (() => { try { return String(require('../core/distribution').editionVersion || require('../package.json').version || ''); } catch { return ''; } })();
  const STATE = { ok: '正常', warn: '注意', bad: '有问题', off: '不适用', pending: '检测中' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let dialog = null, result = null, running = null, expanded = new Set(), message = '', messageBad = false;
  let tab = 'features', cliState = null, doctorState = null, installing = new Set(), recheckOnFocus = false;
  const COMPONENTS = new Set(['codeagent', 'claude', 'codex', 'dsh', 'git-bash', 'node', 'welink', 'ppt-doctor']);
  const INSTALLABLE = new Set(['claude', 'codex', 'dsh']);
  const ACTIVE = new Set(['checking', 'downloading', 'extracting', 'verifying', 'installing']);

  function injectStyle() {
    if (document.getElementById('env-check-style')) return;
    const link = Object.assign(document.createElement('link'), { id: 'env-check-style', rel: 'stylesheet', href: 'styles/env-check.css' });
    document.head.append(link);
  }

  function setMessage(text, bad = false) {
    message = text || ''; messageBad = bad;
    const el = dialog?.querySelector('[data-ec="msg"]');
    if (el) { el.textContent = message; el.classList.toggle('bad', bad); }
  }

  function ensureDialog() {
    if (dialog) return dialog;
    injectStyle();
    dialog = document.createElement('dialog');
    dialog.className = 'env-check-dialog';
    dialog.id = 'env-check-dialog';
    dialog.setAttribute('aria-label', '功能体检与组件中心');
    dialog.innerHTML = `
      <div class="ec-head">
        <div class="ec-title"><strong>功能体检与组件中心</strong><div class="ec-summary" data-ec="summary">正在检测…</div></div>
        <button type="button" class="ec-btn" data-ec="copy" title="复制成纯文本，路径和账号已脱敏，可以直接贴给别人">复制体检结果</button>
        <button type="button" class="ec-btn primary" data-ec="rerun">重新体检</button>
        <button type="button" class="ec-close" data-ec="close" aria-label="关闭">✕</button>
      </div>
      <div class="ec-tabs" role="tablist" aria-label="检查范围"><button type="button" role="tab" data-ec-tab="features">功能体检</button><button type="button" role="tab" data-ec-tab="components">组件中心</button><button type="button" role="tab" data-ec-tab="environment">环境明细</button></div>
      <div class="ec-body"><p class="ec-intro" data-ec="intro"></p><ul class="ec-list" data-ec="list"></ul></div>
      <div class="ec-foot"><span class="ec-msg" data-ec="msg" role="status" aria-live="polite"></span><span data-ec="meta"></span></div>`;
    document.body.appendChild(dialog);
    dialog.addEventListener('click', onClick);
    dialog.addEventListener('close', () => setMessage(''));
    return dialog;
  }

  function summaryHtml() {
    if (!result) return running ? '正在检测…' : '';
    if (result.ok === false) return `<span class="ec-n-bad"><b>体检没跑成</b>：${esc(result.error)}</span>`;
    const c = result.counts || {};
    return `<span class="ec-n-ok">正常 <b>${c.ok || 0}</b></span><span class="ec-n-warn">注意 <b>${c.warn || 0}</b></span><span class="ec-n-bad">有问题 <b>${c.bad || 0}</b></span>`
      + (c.off ? `<span>不适用 <b>${c.off}</b></span>` : '') + (running ? '<span>正在重新检测…</span>' : '');
  }

  function fixButtons(item) {
    if (tab === 'components' && item.id === 'ppt-doctor' && item.status !== 'ok' && item.status !== 'off') return installButtons(item.id);
    if (tab === 'components' && INSTALLABLE.has(item.id) && cliState?.available && item.status !== 'ok') return installButtons(item.id);
    if (item.status === 'ok' || item.status === 'off') return '';
    return (item.fixes || []).slice(0, 2).map((f, i) => `<button type="button" class="ec-btn${i === 0 && item.status === 'bad' ? ' primary' : ''}" data-ec-fix="${esc(item.id)}:${i}">${esc(f.label)}</button>`).join('');
  }

  function componentState(id) { return id === 'ppt-doctor' ? doctorState : cliState?.tools?.[id]; }
  function installButtons(id) {
    const busy = installing.has(id) || ACTIVE.has(componentState(id)?.phase);
    const another = id !== 'ppt-doctor' && cliState?.busy && cliState.busy !== id;
    return busy ? `<button type="button" class="ec-btn" data-ec-cancel="${esc(id)}">取消安装</button>`
      : `<button type="button" class="ec-btn" data-ec-install="${esc(id)}" ${another ? 'disabled title="请等待当前 CLI 安装结束"' : ''}>${componentState(id)?.phase === 'error' ? '重试安装' : '一键安装'}</button>`;
  }
  function progressHtml(id) {
    const s = componentState(id); if (!s || s.phase === 'idle') return '';
    const labels = { checking: '正在检查安装来源…', downloading: '正在下载…', extracting: '正在解压…', verifying: '正在校验…', installing: '正在安装…', done: '安装完成', cancelled: '已取消安装', error: '安装未完成' };
    const detail = s.error || s.message || labels[s.phase] || '正在处理…';
    const percent = s.total > 0 ? Math.min(100, Math.floor((s.received || 0) * 100 / s.total)) : null;
    return `<div class="ec-progress" role="status">${esc(detail)}${ACTIVE.has(s.phase) && percent !== null ? ` · ${percent}%` : ''}${ACTIVE.has(s.phase) && s.etaSec > 0 ? ` · 预计剩余 ${Math.ceil(s.etaSec)} 秒` : ''}${ACTIVE.has(s.phase) && percent !== null ? `<progress max="100" value="${percent}" aria-label="安装进度"></progress>` : ''}</div>`;
  }
  function featureHtml() {
    const features = result?.features || require('../core/feature-readiness').featureReadiness(result?.items || []);
    return features.map(f => `<li class="ec-item ec-${esc(f.status)}"><div class="ec-row"><span class="ec-dot" aria-hidden="true"></span><div class="ec-main"><div class="ec-name">${esc(f.name)}<span class="ec-state">${esc(f.label)}</span></div><div class="ec-detail ec-wrap">${esc(f.detail)}</div></div></div><div class="ec-dependencies">${f.dependencies.map(d => `<button type="button" class="ec-dependency ec-${esc(d.status)}" data-ec-component="${esc(d.id)}">${esc(d.name)} · ${STATE[d.status] || '未检测'}</button>`).join('')}</div></li>`).join('');
  }

  // 展开：优先用统一错误卡（5.5.24 B 线提供）；没有时用简版说明。
  function expandHtml(item) {
    const steps = Array.isArray(item.steps) ? item.steps : [];
    const card = tab === 'components' ? null : window.HubErrorCard;
    if (card && typeof card.html === 'function') {
      try {
        return card.html({ area: item.area || 'env-check', title: `${item.name}：${item.detail}`, cause: item.cause || '', steps,
          actions: (item.fixes || []).map((f, i) => ({ label: f.label, act: `env-check:${item.id}:${i}` })),
          details: item.raw || '', severity: item.status === 'bad' ? 'error' : 'warning' });
      } catch (error) { console.warn('[env-check] 错误卡渲染失败，改用简版：', error.message); }
    }
    return `<div class="ec-fallback">${item.cause ? `<p>${esc(item.cause)}</p>` : ''}`
      + (steps.length ? `<ol>${steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : '')
      + (item.raw ? `<details><summary>原始信息</summary><pre>${esc(item.raw)}</pre></details>` : '') + '</div>';
  }

  function render() {
    if (!dialog) return;
    dialog.querySelector('[data-ec="summary"]').innerHTML = summaryHtml();
    const list = dialog.querySelector('[data-ec="list"]');
    dialog.querySelectorAll('[data-ec-tab]').forEach(el => { el.setAttribute('aria-selected', String(el.dataset.ecTab === tab)); });
    dialog.querySelector('[data-ec="intro"]').textContent = tab === 'features' ? '按你要用的功能检查依赖。点击下方组件即可安装或处理；组件就绪后仍需登录和真实请求验证。'
      : tab === 'components' ? '在这里安装 CLI 和 PPT Doctor。公司内部软件使用内部安装入口；装好返回 Hub 后自动复检。' : '工具版本、公司模型状态、下载源和本机条件。检测不会自动安装或登录。';
    const items = (result?.items || []).filter(item => tab !== 'components' || COMPONENTS.has(item.id));
    if (!items.length) {
      list.innerHTML = running ? ['外部工具', '公司服务', '本机条件'].map(n => `<li class="ec-item ec-pending"><div class="ec-row"><span class="ec-dot"></span><div class="ec-main"><div class="ec-name">${n}</div><div class="ec-detail">检测中…</div></div></div></li>`).join('') : '<li class="ec-intro">暂无检测结果，点击「重新体检」继续。</li>';
    } else if (tab === 'features') {
      list.innerHTML = featureHtml();
    } else {
      list.innerHTML = items.map(item => {
        const canExpand = item.status === 'warn' || item.status === 'bad';
        const open = canExpand && expanded.has(item.id);
        return `<li class="ec-item ec-${esc(item.status)}${open ? ' expanded' : ''}" data-ec-id="${esc(item.id)}">
          <div class="ec-row"><span class="ec-dot" aria-hidden="true"></span>
            <div class="ec-main"><div class="ec-name">${esc(item.name)}<span class="ec-state">${STATE[item.status] || ''}</span></div>
              <div class="ec-detail" title="${esc(item.detail)}">${esc(item.detail)}</div>${tab === 'components' ? progressHtml(item.id) : ''}</div>
            <div class="ec-actions">${fixButtons(item)}${canExpand ? `<button type="button" class="ec-more" data-ec-toggle="${esc(item.id)}" aria-expanded="${open}">${open ? '收起' : '详情'}</button>` : ''}</div></div>
          ${open ? `<div class="ec-expand">${expandHtml(item)}</div>` : ''}</li>`;
      }).join('');
    }
    const meta = dialog.querySelector('[data-ec="meta"]');
    meta.textContent = result?.ms != null ? `用时 ${(result.ms / 1000).toFixed(1)} 秒` : '';
    dialog.querySelector('[data-ec="rerun"]').disabled = !!running;
    dialog.querySelector('[data-ec="copy"]').disabled = !result?.report;
    setMessage(message, messageBad);
  }

  async function run() {
    if (running) return running;
    running = (async () => {
      render();
      try { result = await ipcRenderer.invoke('env-check:run'); }
      catch (error) { result = { ok: false, error: error.message }; }
      // 默认展开第一项红色，用户一眼看到原因。
      const firstBad = (result?.items || []).find(i => i.status === 'bad');
      if (firstBad && !expanded.size) expanded.add(firstBad.id);
      return result;
    })().finally(() => { running = null; render(); });
    render();
    return running;
  }

  async function copyReport() {
    const text = result?.report || '';
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch { require('electron').clipboard.writeText(text); }
    setMessage('已复制体检结果（路径和账号已脱敏）');
  }

  async function doFix(item, fix) {
    const act = fix.act;
    const leave = () => dialog?.close();
    if (act === 'recheck') return run();
    if (act === 'open-assistant') { leave(); document.getElementById('btn-assistant')?.click(); return; }
    if (act === 'open-codeagent') { leave(); (window.__codeagentAccountsOpen || window.__companyApiOpen)?.(); return; }
    if (act === 'open-cli-install') { tab = 'components'; render(); return; }
    if (act === 'open-company-api') { leave(); window.__companyApiOpen?.(); return; }
    if (act === 'open-update') { leave(); window.__appUpdate?.open?.(); return; }
    // 一键安装 Git for Windows（2026-11-07）：主进程先全局找本机的 Git，没有才下载，装完重新体检。
    if (act === 'git-install') {
      setMessage('正在全局查找本机的 Git，没有就下载安装 Git for Windows（可能要几分钟）…');
      const r = await ipcRenderer.invoke('cli-tools:install', { id: 'git' }).catch(error => ({ ok: false, error: error.message }));
      const git = r?.state?.tools?.git || {};
      if (!r?.ok) { setMessage('Git for Windows 没装上：' + (r?.error || git.error || '未知原因'), true); return; }
      setMessage(git.found ? `这台电脑已经有 Git Bash（${git.found}），不用重复安装` : 'Git for Windows 已装好，新建的 Claude 会话会用它执行命令');
      await run();
      return;
    }
    const busy = { 'welink-find': '正在全盘找 welink-cli，最多约 2 分钟…', 'proxy-restart': '正在重新启动反代…', 'ppt-download': '正在打开下载地址…' }[act];
    if (busy) setMessage(busy);
    if (act === 'open-url' || act === 'ppt-download') recheckOnFocus = true;
    const r = await ipcRenderer.invoke('env-check:fix', { id: item.id, act, url: fix.url || '' }).catch(error => ({ ok: false, error: error.message }));
    if (!r || r.ok === false) { setMessage((r && r.error) || '没做成', true); return; }
    setMessage(r.message || '');
    if (act === 'welink-find' || act === 'proxy-restart') await run();
  }

  async function install(id) {
    if ((!INSTALLABLE.has(id) && id !== 'ppt-doctor') || installing.has(id)) return;
    installing.add(id); render();
    try {
      const r = await ipcRenderer.invoke(id === 'ppt-doctor' ? 'components:doctor-install' : 'cli-tools:install', { id });
      if (id === 'ppt-doctor') doctorState = r.state || doctorState; else cliState = r.state || cliState;
      setMessage(r.ok ? '安装完成，正在重新检测…' : r.error || '安装已结束，可重试或使用安装说明', !r.ok);
      if (r.ok) await run();
    } catch (error) { setMessage(error.message, true); }
    finally { installing.delete(id); render(); }
  }

  function findFix(token) {
    const m = /^(?:env-check:)?([^:]+):(\d+)$/.exec(String(token || ''));
    const item = m && result?.items?.find(i => i.id === m[1]);
    const fix = item && item.fixes && item.fixes[Number(m[2])];
    return fix ? { item, fix } : null;
  }

  function onClick(event) {
    const t = event.target;
    const tabButton = t.closest('[data-ec-tab]');
    if (tabButton) { tab = tabButton.dataset.ecTab; render(); return; }
    const component = t.closest('[data-ec-component]');
    if (component) {
      const id = component.dataset.ecComponent;
      if (id === 'company-proxy' && result?.items?.find(i => i.id === id)?.status === 'off') { dialog.close(); window.__companyApiOpen?.(); return; }
      tab = COMPONENTS.has(id) ? 'components' : 'environment'; expanded.add(id); render();
      dialog.querySelector(`[data-ec-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }); return;
    }
    const installButton = t.closest('[data-ec-install]');
    if (installButton) { void install(installButton.dataset.ecInstall); return; }
    const cancel = t.closest('[data-ec-cancel]');
    if (cancel) { void ipcRenderer.invoke(cancel.dataset.ecCancel === 'ppt-doctor' ? 'components:doctor-cancel' : 'cli-tools:cancel').catch(e => setMessage(e.message, true)); return; }
    if (t === dialog || t.closest('[data-ec="close"]')) { dialog.close(); return; }
    if (t.closest('[data-ec="rerun"]')) { void run(); return; }
    if (t.closest('[data-ec="copy"]')) { void copyReport(); return; }
    const toggle = t.closest('[data-ec-toggle]');
    if (toggle) { const id = toggle.dataset.ecToggle; if (expanded.has(id)) expanded.delete(id); else expanded.add(id); render(); return; }
    const fixBtn = t.closest('[data-ec-fix]');
    // 错误卡里的主操作按钮（data-hub-err-act="env-check:<项>:<序号>"）也走这里；卡片自带的求助按钮由错误卡自己处理。
    const cardBtn = !fixBtn && t.closest('[data-hub-err-act^="env-check:"]');
    const hit = findFix(fixBtn ? fixBtn.dataset.ecFix : cardBtn ? cardBtn.getAttribute('data-hub-err-act') : '');
    if (hit) { event.preventDefault(); event.stopPropagation(); void doFix(hit.item, hit.fix); }
  }

  async function open(options = {}) {
    tab = options.tab || 'features';
    ensureDialog();
    if (!dialog.open) dialog.showModal();
    render();
    await Promise.all([run(), ipcRenderer.invoke('cli-tools:state').then(s => { cliState = s; }).catch(() => {}),
      ipcRenderer.invoke('components:state').then(s => { doctorState = s.doctor; }).catch(() => {})]);
    render();
  }

  // ---------- 入口 ----------
  function addMenuEntry() {
    const menu = document.getElementById('options-menu');
    if (!menu || document.getElementById('options-env-check')) return;
    const item = document.createElement('div');
    item.className = 'options-item'; item.id = 'options-env-check'; item.textContent = '🩺 功能体检与组件中心';
    item.title = '看看 Hub 用到的工具都装好没有、哪里需要处理';
    item.addEventListener('click', () => { menu.style.display = 'none'; void open(); });
    const anchor = document.getElementById('options-optional-features') || document.getElementById('options-feedback') || document.getElementById('options-check-update') || document.getElementById('options-settings');
    if (anchor) anchor.after(item); else menu.appendChild(item);
  }

  // 首次启动 / 升级后第一次打开：主页顶部一条小提示，出现即记下本版本，下次不再出；点 × 立即收起。
  function showHint() {
    let seen = '';
    try { seen = localStorage.getItem(HINT_KEY) || ''; } catch { seen = ''; }
    if (!current || seen === current || document.getElementById('env-check-hint')) return;
    const host = document.querySelector('.home-welcome-body');
    if (!host) return;
    injectStyle();
    try { localStorage.setItem(HINT_KEY, current); } catch { /* 存不下就只这一次 */ }
    const hint = document.createElement('div');
    hint.className = 'ec-hint'; hint.id = 'env-check-hint'; hint.setAttribute('role', 'note');
    hint.innerHTML = `<span class="ec-hint-text">${seen ? '刚升级完' : '第一次使用'}：可以先体检一下，看看要用的工具都装好没有。</span>`
      + '<button type="button" class="ec-hint-go" data-ec-hint="go">点此体检 ›</button><button type="button" class="ec-hint-close" data-ec-hint="close" aria-label="关闭提示" title="关闭">×</button>';
    hint.addEventListener('click', event => {
      const act = event.target.closest('[data-ec-hint]')?.dataset.ecHint;
      if (!act) return;
      hint.remove();
      if (act === 'go') void open();
    });
    host.prepend(hint);
  }

  function start() { addMenuEntry(); showHint(); }
  window.__envCheck = { open, run, result: () => result };
  window.__componentCenter = { open: () => open({ tab: 'components' }) };
  ipcRenderer.on('cli-tools:state', (_event, state) => { cliState = state; if (dialog?.open && tab === 'components') render(); });
  ipcRenderer.on('components:doctor-state', (_event, state) => { doctorState = state; if (dialog?.open && tab === 'components') render(); });
  window.addEventListener('focus', () => { if (recheckOnFocus && dialog?.open) { recheckOnFocus = false; void run(); } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
