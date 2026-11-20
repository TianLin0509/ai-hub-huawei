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
  const i18n = (() => { try { return require('../core/i18n'); } catch { return null; } })();
  // 英文模式下「名称：说明；名称：说明」整段拼好后词典对不上，改成逐段翻译再拼；中文模式原样，显示文字不变（2026-11-20 i18n）。
  const namedDetail = (name, detail) => (i18n && i18n.isEnglish() ? `${i18n.translate(String(name))}: ${i18n.translate(String(detail))}` : `${name}：${detail}`);
  const featureDetail = f => {
    if (!(i18n && i18n.isEnglish())) return f.detail;
    const blocked = (f.dependencies || []).filter(d => d.status !== 'ok');
    return blocked.length ? blocked.map(d => namedDetail(d.name, d.detail)).join('; ') : f.detail;
  };
  let dialog = null, result = null, running = null, expanded = new Set(), message = '', messageBad = false;
  let tab = 'features', cliState = null, doctorState = null, ocrState = null, installing = new Set(), recheckOnFocus = false;
  const COMPONENTS = new Set(['codeagent', 'claude', 'codex', 'dsh', 'git-bash', 'node', 'welink', 'ppt-doctor']);
  const INSTALLABLE = new Set(['claude', 'codex', 'dsh']);
  // r58：组件中心每个会下载的组件都显示「下载源：公司内源」（renderer/download-source-view.js）。
  const sourceView = require('./download-source-view');
  const SOURCE_LABEL = { 'ppt-doctor': 'PPT Doctor 本体', 'ppt-ocr': '识别组件' };
  const SOURCE_POINT = { claude: 'cli:claude', codex: 'cli:codex', dsh: 'cli:dsh', git: 'cli:git', 'git-bash': 'cli:git', codeagent: 'codeagent', welink: 'welink', pi: 'cli:pi', node: 'cli:node', 'ppt-doctor': ['ppt-doctor', 'ppt-ocr'] };
  const ACTIVE = new Set(['checking', 'downloading', 'extracting', 'verifying', 'installing', 'probing', 'npm-fallback']);
  // 本机 CLI 定位结论（2026-11-20，HUB-H 第一期）：体检行带 extra.locate 时画成结论卡（renderer/harness-view.js），
  // 选择文件、清掉手动路径、复制诊断经定位中心（renderer/harness-client.js → harness:* IPC）。
  const hxView = require('./harness-view');
  const hxClient = require('./harness-client');
  const harness = hxClient.createHarnessClient(ipcRenderer);
  const checkedOpen = new Set();
  // 一键补齐等定位中心修复没成功时的原因（已打码），按定位中心 id 记，显示在那一行按钮旁边；下次点或复检能用后清掉。
  const repairErrors = new Map();
  const locateOf = item => item && item.extra && item.extra.locate && item.extra.locate.verdict ? item.extra.locate : null;

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
        <button type="button" class="ec-btn" data-ec="copy-diag" title="复制各 CLI 查过的位置和结论，用户名已打码，可以直接贴给维护人" hidden>复制全部诊断</button>
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
    if (tab === 'components' && INSTALLABLE.has(item.id) && cliState?.available && item.status !== 'ok') {
      // DSH（2026-11-17）：主按钮用体检给的说法（一键补齐 / 一键安装终端版，同样装 Hub 自管的），旁边留「装到我的全局 npm」。
      const own = item.id === 'dsh' ? (item.fixes || []).find(f => f.act === 'dsh-install') : null;
      const global = item.id === 'dsh' ? (item.fixes || []).findIndex(f => f.act === 'dsh-install-global') : -1;
      return installButtons(item.id, own && own.label)
        + (global >= 0 && !installing.has(item.id) && !ACTIVE.has(componentState(item.id)?.phase) ? `<button type="button" class="ec-btn" data-ec-fix="${esc(item.id)}:${global}">${esc(item.fixes[global].label)}</button>` : '');
    }
    if (item.status === 'ok' || item.status === 'off') return '';
    return (item.fixes || []).slice(0, 2).map((f, i) => `<button type="button" class="ec-btn${i === 0 && item.status === 'bad' ? ' primary' : ''}" data-ec-fix="${esc(item.id)}:${i}">${esc(f.label)}</button>`).join('');
  }

  function componentState(id) { return id === 'ppt-doctor' ? doctorState : cliState?.tools?.[id]; }
  function installButtons(id, label) {
    const busy = installing.has(id) || ACTIVE.has(componentState(id)?.phase);
    const another = id !== 'ppt-doctor' && cliState?.busy && cliState.busy !== id;
    return busy ? `<button type="button" class="ec-btn" data-ec-cancel="${esc(id)}">取消安装</button>`
      : `<button type="button" class="ec-btn" data-ec-install="${esc(id)}" ${another ? 'disabled title="请等待当前 CLI 安装结束"' : ''}>${componentState(id)?.phase === 'error' ? '重试安装' : esc(label || '一键安装')}</button>`;
  }
  function progressHtml(id) {
    // PPT Doctor 一行下面还挂着「识别组件」的更新进度（r59）。
    const ocr = id === 'ppt-doctor' && ocrState && ACTIVE.has(ocrState.phase) ? require('./download-progress-view').html({ ...ocrState, message: ocrState.phase === 'downloading' ? '' : ocrState.message }, { title: '更新识别组件' }) : '';
    return oneProgressHtml(id) + ocr;
  }
  function oneProgressHtml(id) {
    const s = componentState(id); if (!s || s.phase === 'idle') return '';
    const labels = { checking: '正在检查安装来源…', downloading: '正在下载…', extracting: '正在解压…', verifying: '正在校验…', installing: '正在安装…', done: '安装完成', cancelled: '已取消安装', error: '安装未完成' };
    const detail = s.error || s.message || labels[s.phase] || '正在处理…';
    // r59：进行中和刚装完都用统一进度条（进度、速度、剩余时间、来源）；取消、出错只留一行字。
    if (ACTIVE.has(s.phase) || s.phase === 'done') return require('./download-progress-view').html({ ...s, message: s.phase === 'downloading' ? '' : detail }, { attrs: 'role="status"' });
    return `<div class="ec-progress" role="status">${esc(detail)}</div>`;
  }
  function featureHtml() {
    const features = result?.features || require('../core/feature-readiness').featureReadiness(result?.items || []);
    return features.map(f => `<li class="ec-item ec-${esc(f.status)}"><div class="ec-row"><span class="ec-dot" aria-hidden="true"></span><div class="ec-main"><div class="ec-name">${esc(f.name)}<span class="ec-state">${esc(f.label)}</span></div><div class="ec-detail ec-wrap">${esc(featureDetail(f))}</div></div></div><div class="ec-dependencies">${f.dependencies.map(d => `<button type="button" class="ec-dependency ec-${esc(d.status)}" data-ec-component="${esc(d.id)}">${esc(d.name)} · ${STATE[d.status] || '未检测'}</button>`).join('')}</div></li>`).join('');
  }

  // 展开：优先用统一错误卡（5.5.24 B 线提供）；没有时用简版说明。
  function expandHtml(item) {
    const steps = Array.isArray(item.steps) ? item.steps : [];
    const card = tab === 'components' ? null : window.HubErrorCard;
    if (card && typeof card.html === 'function') {
      try {
        return card.html({ area: item.area || 'env-check', title: namedDetail(item.name, item.detail), cause: item.cause || '', steps,
          actions: (item.fixes || []).map((f, i) => ({ label: f.label, act: `env-check:${item.id}:${i}` })),
          details: item.raw || '', severity: item.status === 'bad' ? 'error' : 'warning' });
      } catch (error) { console.warn('[env-check] 错误卡渲染失败，改用简版：', error.message); }
    }
    return `<div class="ec-fallback">${item.cause ? `<p>${esc(item.cause)}</p>` : ''}`
      + (steps.length ? `<ol>${steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : '')
      + (item.raw ? `<details><summary>原始信息</summary><pre>${esc(item.raw)}</pre></details>` : '') + '</div>';
  }

  // 结论卡（有 extra.locate 的行）：首行是结论标签和来源/版本/Node，第二行是一句人话；展开看候选、查过的位置、手动路径和复制诊断。
  // 能用的行也能展开：同事要确认 Hub 用的是哪一份，或改用别处装的那份。
  // 体检判为「不适用」的行（不需要的 Node、非公司电脑的 CodeAgent）保持灰色「不适用」和体检原话，不换成定位中心的红色「没找到」，
  // 和顶部计数一致（2026-11-21 审查第 5 条）；展开仍能看定位中心查过哪些位置。
  function locateRowHtml(item, loc) {
    const open = expanded.has(item.id);
    const off = item.status === 'off';
    const status = item.status || hxView.verdictOf(loc.verdict).tone;
    const reason = off ? String(item.detail || STATE.off) : hxView.reasonText(loc);
    const buttons = fixButtons(item);
    const rowActs = [...buttons.matchAll(/data-ec-fix="[^"]*:(\d+)"/g)].map(m => (item.fixes || [])[Number(m[1])]?.act).filter(Boolean);
    const repairError = repairErrors.get(loc.id);
    return `<li class="ec-item ec-${esc(status)} hx-row${open ? ' expanded' : ''}" data-ec-id="${esc(item.id)}" data-hx-verdict="${esc(off ? 'off' : loc.verdict)}">
      <div class="ec-row"><span class="ec-dot" aria-hidden="true"></span>
        <div class="ec-main"><div class="ec-name hx-name">${esc(item.name)}${off ? `<span class="ec-state">${STATE.off}</span>` : hxView.headHtml(loc)}</div>
          <div class="ec-detail" title="${esc(reason)}">${esc(reason)}</div>${repairError ? `<div class="ec-progress hx-repair-error" role="alert" data-hx-repair-error="${esc(loc.id)}">没补齐：${esc(repairError)}</div>` : ''}${tab === 'components' ? progressHtml(item.id) : ''}${tab === 'components' && SOURCE_POINT[item.id] ? [].concat(SOURCE_POINT[item.id]).map(p => sourceView.slotHtml(p, 'div', SOURCE_LABEL[p] || '')).join('') : ''}</div>
        <div class="ec-actions">${buttons}<button type="button" class="ec-more" data-ec-toggle="${esc(item.id)}" aria-expanded="${open}">${open ? '收起' : '详情'}</button></div></div>
      ${open ? `<div class="ec-expand">${hxView.panelHtml(loc, { checkedOpen: checkedOpen.has(loc.id), rowActs })}</div>` : ''}</li>`;
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
        const loc = locateOf(item);
        if (loc) return locateRowHtml(item, loc);
        const canExpand = item.status === 'warn' || item.status === 'bad';
        const open = canExpand && expanded.has(item.id);
        return `<li class="ec-item ec-${esc(item.status)}${open ? ' expanded' : ''}" data-ec-id="${esc(item.id)}">
          <div class="ec-row"><span class="ec-dot" aria-hidden="true"></span>
            <div class="ec-main"><div class="ec-name">${esc(item.name)}<span class="ec-state">${STATE[item.status] || ''}</span></div>
              <div class="ec-detail${item.id === 'app-update' ? ' ec-update-sources' : ''}" title="${esc(item.detail)}">${esc(item.detail)}</div>${tab === 'components' ? progressHtml(item.id) : ''}${tab === 'components' && SOURCE_POINT[item.id] ? [].concat(SOURCE_POINT[item.id]).map(p => sourceView.slotHtml(p, 'div', SOURCE_LABEL[p] || '')).join('') : ''}</div>
            <div class="ec-actions">${fixButtons(item)}${canExpand ? `<button type="button" class="ec-more" data-ec-toggle="${esc(item.id)}" aria-expanded="${open}">${open ? '收起' : '详情'}</button>` : ''}</div></div>
          ${open ? `<div class="ec-expand">${expandHtml(item)}</div>` : ''}</li>`;
      }).join('');
    }
    if (tab === 'components') void sourceView.fill(list, { ipcRenderer });
    const meta = dialog.querySelector('[data-ec="meta"]');
    meta.textContent = result?.ms != null ? `用时 ${(result.ms / 1000).toFixed(1)} 秒` : '';
    dialog.querySelector('[data-ec="rerun"]').disabled = !!running;
    dialog.querySelector('[data-ec="copy"]').disabled = !result?.report;
    dialog.querySelector('[data-ec="copy-diag"]').hidden = !(result?.items || []).some(locateOf);
    setMessage(message, messageBad);
  }

  // 体检本身（core/env-check）每个 CLI 行都会让定位中心试跑一次，界面不再先跑一遍 locate-all，
  // 否则每次「重新体检」要串行试跑两轮、等待约翻倍（2026-11-21 审查第 4 条）。fresh 透传给主进程，供它决定用不用缓存。
  async function run({ fresh = false } = {}) {
    if (running) return running;
    running = (async () => {
      render();
      try { result = await ipcRenderer.invoke('env-check:run', { fresh }); }
      catch (error) { result = { ok: false, error: error.message }; }
      // 默认展开第一项红色，用户一眼看到原因。
      const firstBad = (result?.items || []).find(i => i.status === 'bad');
      if (firstBad && !expanded.size) expanded.add(firstBad.id);
      for (const item of result?.items || []) { const loc = locateOf(item); if (loc && loc.verdict === 'ok') repairErrors.delete(loc.id); }
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

  // 复制诊断：定位中心给的文本已打码（用户目录写成 %USERPROFILE%，用户名写成 <user>）。ids 不给就是全部 CLI。
  async function copyDiagnosis(ids) {
    let text = '';
    try { text = await harness.diagnosisText(ids); } catch (error) { setMessage('诊断没取到：' + error.message, true); return; }
    if (!text) { setMessage(harness.missing ? '这个版本还不能导出诊断，请点「复制体检结果」' : '诊断是空的，请先点「重新体检」', true); return; }
    await hxClient.copyText(text);
    setMessage(ids ? '已复制这一项的诊断（用户名已打码），可以直接贴给维护人' : '已复制全部 CLI 的诊断（用户名已打码），可以直接贴给维护人');
  }

  // 定位中心返回新结论：就地替换对应的行，不等整轮体检。
  function applyLocate(id, loc) {
    if (!loc || !result?.items) return false;
    let hit = false;
    for (const item of result.items) {
      const cur = locateOf(item);
      if (cur && cur.id === id) { item.extra = { ...item.extra, locate: loc }; item.fixes = loc.fixes || item.fixes; item.cause = loc.reason || item.cause; hit = true; }
    }
    return hit;
  }

  async function harnessAct(id, act, fix = {}) {
    try {
      if (act === 'pick') {
        setMessage('请在弹出的窗口里选择程序文件；选好后 Hub 先试跑一次，通过才会用它…');
        const r = await harness.pickPath(id);
        if (r.missing) { setMessage('这个版本还不能手动指定路径，请升级 Hub 后再试', true); return; }
        if (!r.value) { setMessage(''); return; }
        const m = hxView.pickMessage(r.value);
        if (hxView.pickSucceeded(r.value)) { applyLocate(id, r.value); render(); setMessage(m.text); void run(); return; }
        // 没通过：选的那份没保存。返回值里的 chosen 是试跑失败的那份，不能拿来画「Hub 将用这个」；
        // 重新取一次定位中心当前真正生效的结论再画（2026-11-21 审查第 1 条）。
        setMessage(m.text, true);
        const now = await harness.locate(id).catch(() => null);
        if (now && now.value && applyLocate(id, now.value)) render();
        setMessage(m.text, true);
        return;
      }
      if (act === 'clear') {
        setMessage('正在清掉手动路径并重新查找…');
        const r = await harness.clearPath(id);
        if (r.missing) { setMessage('这个版本还不能清掉手动路径，请升级 Hub 后再试', true); return; }
        applyLocate(id, r.value); render();
        setMessage('已改回自动查找。' + (r.value?.reason || ''));
        void run();
        return;
      }
      if (act === 'harness-repair') { repairErrors.delete(id); render(); }
      setMessage({ 'harness-borrow-node': '正在改用另一份 Node 并试跑…', 'harness-repair': '正在补齐缺的部分（可能要一两分钟）…' }[act] || '正在处理…');
      const r = await harness.applyFix(id, act, fix);
      if (r.missing) { setMessage('这个版本还不支持这个按钮，请升级 Hub 后再试', true); return; }
      // 一键补齐失败（如公司代理 407）：把主进程给的原因原样（打码后）挂在这一行按钮旁，不只说「还没好」（2026-11-21 审查第 2 条）。
      const failed = r.value?.repairError ? hxView.maskUser(r.value.repairError) : '';
      if (failed) repairErrors.set(id, failed); else repairErrors.delete(id);
      applyLocate(id, r.value); render();
      const ok = r.value?.verdict === 'ok' && !failed;
      setMessage(failed ? '没补齐：' + failed : (ok ? '处理好了：' : '还没好：') + (r.value?.reason || ''), !ok);
      if (!failed) void run();
    } catch (error) { setMessage('没做成：' + error.message, true); }
  }

  async function doFix(item, fix) {
    const act = fix.act;
    const leave = () => dialog?.close();
    if (act === 'recheck') return run({ fresh: true });
    const hxId = fix.id || locateOf(item)?.id || item.id;
    if (act === 'harness-pick') return harnessAct(hxId, 'pick');
    if (act === 'harness-clear-manual') return harnessAct(hxId, 'clear');
    if (act === 'harness-borrow-node' || act === 'harness-repair') return harnessAct(hxId, act, fix);
    if (act === 'open-assistant') {
      // 公司版的旧助理按钮是藏着的，先找公司助理（2026-11-20 按钮排查）；都没有就就地说明。
      const target = document.getElementById('btn-company-assistant') || document.getElementById('btn-assistant');
      if (!target || target.hidden) { setMessage('这个版本没有助理页，请升级到最新版本后再试'); return; }
      leave(); target.click(); return;
    }
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
    if (act === 'pi-install') {
      setMessage('正在安装 pi（Hub 自管目录，不改你的全局 npm，通常 1–3 分钟）…');
      const r = await ipcRenderer.invoke('cli-tools:install', { id: 'pi' }).catch(error => ({ ok: false, error: error.message }));
      if (r?.state) cliState = r.state;
      if (!r?.ok) { setMessage('pi 没装好：' + (r?.error || r?.state?.tools?.pi?.error || '未知原因'), true); return; }
      setMessage('pi 已装好，正在重新检测…');
      await run();
      return;
    }
    // DSH 分情况补齐（2026-11-17）：默认装 Hub 自管的运行环境；用户明确点「装到我的全局 npm」才按界面包要求配套装进全局目录。
    if (act === 'dsh-install' || act === 'dsh-install-global') {
      const toGlobal = act === 'dsh-install-global';
      setMessage(toGlobal ? '正在按界面包要求，把配套的 DSH 装进你的 npm 全局目录（用你自己的 npm 源和代理，可能要几分钟）…'
        : '正在安装 Hub 自管的 DSH 终端运行环境（约 1 分钟，不改你的全局 npm）…');
      const r = await ipcRenderer.invoke('cli-tools:install', toGlobal ? { id: 'dsh', repair: true, target: 'user-global' } : { id: 'dsh' })
        .catch(error => ({ ok: false, error: error.message }));
      if (r?.state) cliState = r.state;
      if (!r?.ok) { setMessage('DSH 没装好：' + (r?.error || r?.state?.tools?.dsh?.error || '未知原因') + (toGlobal ? '' : '。也可以试试「装到我的全局 npm」'), true); return; }
      setMessage('DSH 已装好，正在重新检测…');
      await run();
      return;
    }
    const busy = { 'welink-find': '正在全盘找 welink-cli，最多约 2 分钟…', 'proxy-restart': '正在重新启动反代…', 'ppt-download': '正在打开下载地址…', 'welink-install': '正在安装 welink-cli…', 'doctor-install': '正在下载并安装 PPT Doctor，可能需要几分钟…', 'ocr-install': '正在更新识别组件（约 82 MB，公司内源优先），通常一两分钟…' }[act];
    if (busy) setMessage(busy);
    if (act === 'open-url' || act === 'ppt-download') recheckOnFocus = true;
    const r = await ipcRenderer.invoke('env-check:fix', { id: item.id, act, url: fix.url || '' }).catch(error => ({ ok: false, error: error.message }));
    if (!r || r.ok === false) { setMessage((r && r.error) || '没做成', true); return; }
    setMessage(r.message || '');
    if (act === 'welink-find' || act === 'proxy-restart' || act === 'ocr-install') await run();
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

  // 展开后整行尽量放进可见区；放不下时至少让行头（含「收起」按钮）留在首屏，不用滚着找。
  function revealRow(id) {
    const row = dialog?.querySelector(`[data-ec-id="${id}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.querySelector('.ec-row')?.scrollIntoView({ block: 'nearest' });
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
      revealRow(id); return;
    }
    const installButton = t.closest('[data-ec-install]');
    if (installButton) { void install(installButton.dataset.ecInstall); return; }
    const cancel = t.closest('[data-ec-cancel]');
    if (cancel) { void ipcRenderer.invoke(cancel.dataset.ecCancel === 'ppt-doctor' ? 'components:doctor-cancel' : 'cli-tools:cancel').catch(e => setMessage(e.message, true)); return; }
    if (t === dialog || t.closest('[data-ec="close"]')) { dialog.close(); return; }
    if (t.closest('[data-ec="rerun"]')) { void run({ fresh: true }); return; }
    if (t.closest('[data-ec="copy"]')) { void copyReport(); return; }
    if (t.closest('[data-ec="copy-diag"]')) { void copyDiagnosis(); return; }
    const hxChecked = t.closest('[data-hx-checked]');
    if (hxChecked) {
      const id = hxChecked.dataset.hxChecked, opening = !checkedOpen.has(id);
      if (opening) checkedOpen.add(id); else checkedOpen.delete(id);
      render();
      if (opening) { const row = dialog.querySelector(`[data-hx-verdict] [data-hx-checked="${id}"]`)?.closest('[data-ec-id]'); if (row) revealRow(row.dataset.ecId); }
      return;
    }
    const hxBtn = t.closest('[data-hx-act]');
    if (hxBtn) {
      const id = hxBtn.dataset.hxId, act = hxBtn.dataset.hxAct;
      if (act === 'copy') void copyDiagnosis([id]); else void harnessAct(id, act);
      return;
    }
    const toggle = t.closest('[data-ec-toggle]');
    if (toggle) { const id = toggle.dataset.ecToggle; if (expanded.has(id)) { expanded.delete(id); render(); } else { expanded.add(id); render(); revealRow(id); } return; }
    const fixBtn = t.closest('[data-ec-fix]');
    // 错误卡里的主操作按钮（data-hub-err-act="env-check:<项>:<序号>"）也走这里；卡片自带的求助按钮由错误卡自己处理。
    const cardBtn = !fixBtn && t.closest('[data-hub-err-act^="env-check:"]');
    const hit = findFix(fixBtn ? fixBtn.dataset.ecFix : cardBtn ? cardBtn.getAttribute('data-hub-err-act') : '');
    if (hit) { event.preventDefault(); event.stopPropagation(); void doFix(hit.item, hit.fix); }
  }

  // focus：定位中心的 id（启动中心点「跑不起来 / 版本太低」的卡片时），直接展开那一项的结论卡。
  async function open(options = {}) {
    const focusRow = () => {
      const item = options.focus && (result?.items || []).find(i => locateOf(i)?.id === options.focus || i.id === options.focus);
      if (!item) return;
      tab = COMPONENTS.has(item.id) ? 'components' : 'environment'; expanded.add(item.id); render();
      revealRow(item.id);
    };
    tab = options.tab || (options.focus ? (COMPONENTS.has(options.focus) ? 'components' : 'environment') : 'features');
    ensureDialog();
    if (!dialog.open) dialog.showModal();
    render();
    focusRow();
    await Promise.all([run(), ipcRenderer.invoke('cli-tools:state').then(s => { cliState = s; }).catch(() => {}),
      ipcRenderer.invoke('components:state').then(s => { doctorState = s.doctor; }).catch(() => {})]);
    render();
    focusRow();
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
  function showHint(refresh = false) {
    let pending = null;
    try {
      const prep = require('../core/first-run-prep');
      pending = prep.pendingCount(prep.readState(require('../core/data-dir').getHubDataDir()));
    } catch { /* 没有准备结果时保留原入口 */ }
    let seen = '';
    try { seen = localStorage.getItem(HINT_KEY) || ''; } catch { seen = ''; }
    if (!current || (!refresh && seen === current)) return;
    // 首页新同事引导在时不再出这条（体检入口在引导第一步里，renderer/first-steps.js）。
    if (window.__firstSteps?.active?.()) return;
    const existing = document.getElementById('env-check-hint');
    if (existing && !refresh) return;
    existing?.remove();
    const host = document.querySelector('.home-welcome-body');
    if (!host) return;
    injectStyle();
    try { localStorage.setItem(HINT_KEY, current); } catch { /* 存不下就只这一次 */ }
    const hint = document.createElement('div');
    hint.className = 'ec-hint'; hint.id = 'env-check-hint'; hint.setAttribute('role', 'note');
    const text = pending === null ? `${seen ? '刚升级完' : '第一次使用'}：可以先体检一下，看看要用的工具都装好没有。`
      : pending ? `还有 ${pending} 项准备未完成，点此查看；其他已就绪功能可以先用。`
        : '准备完成，可以点『新建普通会话』开始；以后遇到问题，可到设置里做功能体检。';
    hint.innerHTML = `<span class="ec-hint-text">${text}</span>`
      + `<button type="button" class="ec-hint-go" data-ec-hint="go">${pending !== null ? '查看准备结果' : '点此体检'} ›</button><button type="button" class="ec-hint-close" data-ec-hint="close" aria-label="关闭提示" title="关闭">×</button>`;
    hint.addEventListener('click', event => {
      const act = event.target.closest('[data-ec-hint]')?.dataset.ecHint;
      if (!act) return;
      hint.remove();
      if (act === 'go' && !(pending !== null && window.__firstRunPrep?.openSaved?.())) void open();
    });
    host.prepend(hint);
  }

  function start() { addMenuEntry(); showHint(); }
  window.__envCheck = { open, run, result: () => result };
  window.__componentCenter = { open: () => open({ tab: 'components' }) };
  ipcRenderer.on('cli-tools:state', (_event, state) => { cliState = state; if (dialog?.open && tab === 'components') render(); });
  ipcRenderer.on('components:doctor-state', (_event, state) => { doctorState = state; if (dialog?.open && tab === 'components') render(); });
  ipcRenderer.on('components:ocr-state', (_event, state) => { ocrState = state; if (dialog?.open && tab === 'components') render(); });
  harness.onChange((id, loc) => { if (applyLocate(id, loc) && dialog?.open) render(); });
  ipcRenderer.on('first-run:event', (_event, event) => { if (event.type === 'done') showHint(true); });
  window.addEventListener('focus', () => { if (recheckOnFocus && dialog?.open) { recheckOnFocus = false; void run(); } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
