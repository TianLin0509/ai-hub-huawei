'use strict';
// 一键更新的界面（2026-10-13，公司版）：设置菜单里的「检查更新」、标题栏的新版本提示、更新弹窗。
// 弹窗显示：当前版本 → 新版本、发布说明、包大小与更新方式、公司内源状态一行（可用 / 缺包 / 连不上 + 原因和下一步）；
// 下载时显示进度、速度、剩余时间；下载好后「立即重启 / 稍后」。R35：只走内源，多源列表、放行下载服务器、抢先版已删。
// 数据与动作都在主进程 main/app-update-controller.js；没有下载源的发行版（主仓库、公开版）什么也不做。
(() => {
  const distribution = require('../core/distribution');
  if (!distribution.updateConfig) return;
  const { ipcRenderer, shell } = require('electron');
  const productName = distribution.productName || 'AI Hub';
  const { internalLine } = require('../core/app-update/source-view');
  const subtitle = `${productName}${distribution.editionBadge ? ' · ' + distribution.editionBadge : ''}`;
  let state = null, dialog = null, manualError = '';
  let confirmInfo = null;
  // R48（2026-11-26）：点了「立即重启」到主进程回话之间，按钮立刻变「正在重启…」并置灰，不再看起来像卡住（公司电脑以前要等 10–15 秒才有变化）。
  let applyPending = null;
  function paintPending() {
    if (!applyPending || !dialog || !state || !(state.phase === 'ready' || confirmInfo || state.restartWait)) return;
    dialog.querySelectorAll('.au-foot button').forEach(b => { b.disabled = true; });
    const btn = dialog.querySelector(`.au-foot [data-au="${applyPending}"]`) || dialog.querySelector('.au-foot .au-btn.primary');
    if (btn) btn.textContent = applyPending === 'apply-wait' ? '正在安排…' : applyPending === 'wait-cancel' ? '正在取消…' : '正在重启…';
    const bodyEl = dialog.querySelector('.au-body');
    if (bodyEl && ['apply', 'apply-now'].includes(applyPending) && !bodyEl.querySelector('[data-au-restarting]')) {
      bodyEl.insertAdjacentHTML('afterbegin', '<div class="au-msg info" data-au-restarting>正在启动升级程序，窗口马上关闭，随后屏幕中间会出现升级进度小窗。</div>');
    }
  }

  // 按钮栏常驻（2026-11-21）：弹窗竖排，标题与按钮栏固定，只有中间说明区（.au-body）滚动；发布说明再长，「下载更新」也一直在视口里。
  const css = `
  .app-update-dialog { position: fixed; inset: 0; margin: auto; height: fit-content; max-height: calc(100vh - 48px); overflow: hidden; width: min(560px, calc(100vw - 48px)); padding: 0; border: 1px solid var(--border-subtle, #e3e1ea); border-radius: 14px;
    background: var(--surface-raised, #fff); color: var(--fg-default, #1f2330); box-shadow: 0 24px 60px rgba(30, 24, 60, .22); font: inherit; }
  .app-update-dialog[open] { display: flex; flex-direction: column; }
  .app-update-dialog > .au-head, .app-update-dialog > .au-foot { flex: none; }
  .app-update-dialog > .au-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .app-update-dialog::backdrop { background: rgba(24, 20, 40, .38); }
  .au-head { display: flex; align-items: center; gap: 12px; padding: 18px 20px 12px; }
  .au-head img { width: 34px; height: 34px; border-radius: 8px; }
  .au-title { flex: 1; min-width: 0; }
  .au-title strong { display: block; font-size: 15px; }
  .au-title span { font-size: 12px; color: var(--fg-muted, #6b7080); }
  .au-close { border: 0; background: transparent; color: var(--fg-muted, #6b7080); font-size: 18px; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
  .au-close:hover { background: rgba(0,0,0,.05); }
  .au-body { padding: 0 20px 6px; font-size: 13px; line-height: 1.6; }
  .au-versions { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 10px; background: var(--surface-sunken, #f6f5fa); margin-bottom: 12px; }
  .au-ver { display: flex; flex-direction: column; }
  .au-ver small { font-size: 11px; color: var(--fg-muted, #6b7080); }
  .au-ver b { font-size: 16px; }
  .au-arrow { color: var(--brand, #8b5cf6); font-size: 18px; }
  .au-plan { margin-left: auto; text-align: right; font-size: 12px; color: var(--fg-muted, #6b7080); }
  .au-plan b { display: block; color: var(--fg-default, #1f2330); font-size: 13px; }
  .au-notes { margin: 0 0 12px; padding-left: 18px; }
  .au-quiet { display: flex; align-items: center; gap: 6px; margin: 10px 0 6px; font-size: 12px; color: var(--fg-muted, #6b7080); cursor: pointer; }
  .au-notes li { margin: 2px 0; }
  .au-notes-more { list-style: none; margin-left: -18px; }
  .au-notes-more button { border: 0; background: transparent; padding: 2px 0; color: var(--brand, #8b5cf6); font: inherit; font-size: 12.5px; cursor: pointer; }
  .au-notes-more button:hover { text-decoration: underline; }
  .au-section { font-size: 12px; font-weight: 600; color: var(--fg-muted, #6b7080); margin: 10px 0 6px; }
  .au-progress { height: 8px; border-radius: 99px; background: var(--surface-sunken, #eeedf4); overflow: hidden; }
  .au-progress i { display: block; height: 100%; width: 0; background: var(--brand, #8b5cf6); border-radius: 99px; transition: width .2s; }
  .au-progress-meta { display: flex; justify-content: space-between; font-size: 12px; color: var(--fg-muted, #6b7080); margin: 6px 0 10px; }
  .au-sources { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-subtle, #e3e1ea); border-radius: 10px; }
  .au-sources li { display: flex; gap: 10px; align-items: baseline; padding: 8px 12px; font-size: 12px; }
  .au-sources li + li { border-top: 1px solid var(--border-subtle, #eceaf2); }
  .au-sources .au-src { width: 112px; flex: none; font-weight: 600; }
  .au-sources .au-st { flex: 1; min-width: 0; color: var(--fg-muted, #6b7080); overflow-wrap: anywhere; }
  .au-sources .ok .au-st { color: #2f8a57; }
  .au-sources .failed .au-st { color: #b4472f; }
  .au-sources .downloading .au-st { color: var(--brand, #8b5cf6); }
  .au-msg { padding: 10px 12px; border-radius: 10px; font-size: 12.5px; margin: 8px 0; }
  .au-msg.ok { background: rgba(var(--rgb-success, 36, 112, 74), .1); color: var(--fg-default, #1f2329); box-shadow: inset 3px 0 0 var(--status-success, #24704a); }
  .au-msg.bad { background: rgba(var(--rgb-danger, 155, 58, 36), .1); color: var(--fg-default, #1f2329); box-shadow: inset 3px 0 0 var(--status-danger, #9b3a24); }
  .au-msg.info { background: var(--surface-sunken, #f6f5fa); color: var(--fg-muted, #6b7080); }
  .au-msg.warn { background: #fff6e5; color: #8a5a00; }
  .au-wait-list { margin: 4px 0 8px; padding-left: 18px; font-size: 12px; color: var(--fg-muted, #6b7080); }
  .au-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 18px; border-top: 1px solid var(--border-subtle, #eceaf2); background: var(--surface-raised, #fff); }
  .au-btn { padding: 7px 16px; border-radius: 8px; border: 1px solid var(--border-subtle, #dcd9e6); background: var(--surface-raised, #fff); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
  .au-btn:hover { background: var(--surface-sunken, #f6f5fa); }
  .au-btn.primary { background: var(--brand, #8b5cf6); border-color: var(--brand, #8b5cf6); color: var(--brand-ink, #fff); font-weight: 600; }
  .au-btn.primary:hover { filter: brightness(1.06); }
  /* theme audit: hide the default focus ring on auto-focused buttons; show a brand-colored ring for keyboard focus only */
  .app-update-dialog button:focus { outline: none; }
  .app-update-dialog button:focus-visible { outline: 2px solid var(--brand, #3478f6); outline-offset: 2px; }
  .au-btn:disabled { opacity: .5; cursor: default; }
  #btn-options.update-has-unread .rail-utility-label { position: relative; }
  #btn-options.update-has-unread .rail-utility-label:after { content: ''; position: absolute; top: -1px; right: -8px; width: 6px; height: 6px; background: #ff755c; border-radius: 50%; }
  #options-check-update.update-has-unread .au-menu-label:after { content: ''; display: inline-block; width: 6px; height: 6px; background: #ff755c; border-radius: 50%; margin: 0 0 7px 6px; }
  #options-check-update.update-has-unread { font-weight: 600; }
  #options-check-update .au-menu-status { display: block; margin-top: 1px; font-size: 11px; font-weight: 400; color: var(--fg-muted, #6b7080); white-space: nowrap; }
  #options-check-update .au-menu-status[hidden] { display: none; }
  #options-check-update .au-menu-status[data-pending="1"] { color: var(--brand, #3478f6); }
  .au-ready-line { display: flex; align-items: center; gap: 8px; margin: 6px 10px 8px; padding: 6px 10px; border-radius: 8px; font-size: 12px; line-height: 1.4;
    background: #ecf7f0; color: #24704a; cursor: pointer; }
  .au-ready-line:before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: #2f9e62; }
  .au-ready-line span { flex: 1; min-width: 0; }
  .au-ready-line button { border: 0; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; padding: 0 2px; }
  .au-ready-line.fixed { position: fixed; left: 12px; bottom: 10px; z-index: 900; max-width: 320px; box-shadow: 0 6px 18px rgba(30,24,60,.12); }
  .au-toast .au-btn { margin: 8px 8px 0 0; padding: 4px 12px; font-size: 12px; }
  .au-toast { position: fixed; right: 20px; top: 56px; z-index: 10050; max-width: 420px; padding: 10px 14px; border-radius: 10px; font-size: 13px;
    background: var(--surface-raised, #fff); border: 1px solid var(--border-subtle, #e3e1ea); box-shadow: 0 10px 30px rgba(30,24,60,.16); }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const mb = n => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`;
  const eta = s => s == null ? '' : s >= 60 ? `剩余约 ${Math.ceil(s / 60)} 分钟` : `剩余约 ${Math.max(1, s)} 秒`;

  // 手动下载完整包（O④ / r27）：在浏览器里打开公司内源上的安装包。版本清单读不到时用主进程在内源上找到的最近完整安装包（state.fullPackage）。
  function manualDownload() {
    if (!state?.latest && fullPackageUrl()) return { url: fullPackageUrl(), label: `下载完整安装包（内源 v${state.fullPackage.version}）`, direct: true };
    if (!(state?.latest?.installer?.file || state?.plan?.kind === 'full' || fullPackageUrl())) return null;
    return { url: '', label: state?.portable ? '下载新的免安装包（公司内源）' : '下载完整安装包（公司内源）', point: 'app-installer' };
  }
  // 主进程只放白名单域名内的 https 地址；这里再确认一次是 https。
  function fullPackageUrl() { const u = String(state?.fullPackage?.url || ''); return u.toLowerCase().startsWith('https://') ? u : ''; }
  // 内源完整包的一行说明（r27）：检查 / 下载失败时显示。
  function fullPackageLine() {
    const p = state?.fullPackage;
    if (!p || !fullPackageUrl()) return '';
    return `<div class="au-msg info" data-au-full>公司内源上有完整安装包 v${esc(p.version)}（${esc(p.file)}）：点「下载完整安装包」用浏览器下载，覆盖安装即可，设置和数据不会丢。</div>`;
  }
  // 「去内源下载完整包」（O④）：先按这一版的安装包名在内源上找（download-source:open），找不到用最近的内源完整包，再不行说明原因。
  async function openManual() {
    const direct = manualDownload();
    if (direct && direct.direct) { shell.openExternal(direct.url); return true; }
    const viaOpenx = await ipcRenderer.invoke('download-source:open', { point: 'app-installer' }).catch(() => null);
    if (viaOpenx && viaOpenx.ok) return true;
    if (fullPackageUrl()) { shell.openExternal(fullPackageUrl()); return true; }
    manualError = '公司内源上暂时找不到完整安装包' + (viaOpenx && viaOpenx.reason ? `（${viaOpenx.reason}）` : '') + '。请确认电脑连着公司网络（公司内网或 VPN）后重试';
    openDialog();
    return false;
  }
  // 受保护目录（Program Files）或免安装版时，说清为什么、下一步做什么（O②③）。
  function installHint(plan) {
    if (!plan) return '';
    if (plan.portable) return '<div class="au-msg warn" data-au-hint="portable">这台电脑用的是免安装版，这一版要换运行库，安装程序会装到另一处、原来的目录仍是旧版。请点「下载新的免安装包」，解压覆盖原目录（数据不在程序目录里，不会丢）。</div>';
    if (plan.protectedDir) return '<div class="au-msg warn" data-au-hint="protected">程序装在受保护的目录（安装时选了「所有用户」，例如 Program Files），每次更新都要管理员授权。电脑没有管理员权限时更新会失败：请点下面的「下载完整安装包」重装一次，安装时选「仅为我安装」，以后就能自动更新（数据不会丢）。</div>';
    return '';
  }

  // 公司内源状态一行（R35）：查版本时看内源上的清单与更新包，下载时看这次下载的结果；不可用时写清原因和下一步。
  function attemptText(a) {
    return a.status === 'ok' ? `下载完成并校验通过 · ${mb(a.bytes)} · ${(a.ms / 1000).toFixed(1)} 秒`
      : a.status === 'downloading' ? '正在下载…' : a.status === 'cancelled' ? '已取消' : a.reason || '下载没有完成';
  }
  function sourceLine() {
    const attempts = state.attempts || [];
    let rows;
    if (attempts.length) rows = attempts.map(a => ({ id: a.id, name: a.name, status: a.status, text: attemptText(a) }));
    else {
      const manifestRow = (state.checks || []).find(c => c.id === 'openx-manifest');
      const row = manifestRow && !manifestRow.ok ? manifestRow : state.internalSource || (state.checks || [])[0];
      if (!row) return '';
      const status = row.ok ? 'ok' : ['off', 'unknown'].includes(row.status) ? 'idle' : 'failed';
      rows = [{ id: row.id, name: '公司内源', status, text: internalLine(row) }];
    }
    return `<ul class="au-sources">${rows.map(r => `<li class="${esc(r.status)}" data-source="${esc(r.id)}"><span class="au-src">${esc(r.name)}</span><span class="au-st">${esc(r.text)}</span></li>`).join('')}</ul>`;
  }

  const hhmm = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const waitItems = items => (items && items.length ? `<ul class="au-wait-list">${items.slice(0, 8).map(x => `<li>${x.kind === 'bridge'
    ? `后台问题 ${esc(x.thread || '')}${x.round != null ? ` 第 ${esc(x.round)} 轮` : ''}` : `本机会话${x.title ? '「' + esc(x.title) + '」' : ''}`}</li>`).join('')}${items.length > 8 ? `<li>另有 ${items.length - 8} 个</li>` : ''}</ul>` : '');
  function waitBlock(w) {
    return `<div class="au-msg warn" data-au-wait>${esc(w.text)}。期间新问题先排队，答完立即重启；到点还没答完的先记下、重启后自动接着做。</div>${waitItems(w.items)}`;
  }
  // 发布说明默认只列前几条，其余折叠成一行「还有 N 条更新 · 展开」（2026-11-21）；展开状态按版本记，换了版本重新折叠。
  const NOTES_SHOWN = 5;
  let notesOpenFor = '';
  function notesHtml(latest) {
    const notes = latest.notes;
    const open = notesOpenFor === String(latest.version);
    const shown = open || notes.length <= NOTES_SHOWN ? notes : notes.slice(0, NOTES_SHOWN);
    const rest = notes.length - NOTES_SHOWN;
    const more = notes.length <= NOTES_SHOWN ? ''
      : open ? '<li class="au-notes-more"><button type="button" data-au="notes-less">收起</button></li>'
        : `<li class="au-notes-more"><button type="button" data-au="notes-more">还有 ${rest} 条更新 · 展开</button></li>`;
    return `<ul class="au-notes" data-au-notes="${notes.length}">${shown.map(n => `<li>${esc(n)}</li>`).join('')}${more}</ul>`;
  }
  function render() {
    if (!dialog || !state) return;
    const w = state.restartWait;
    if (w || confirmInfo) {
      const c = confirmInfo, versions0 = `<div class="au-versions"><div class="au-ver"><small>当前版本</small><b>v${esc(state.current)}</b></div>`
        + (state.latest ? `<span class="au-arrow">→</span><div class="au-ver"><small>新版本</small><b>v${esc((w && w.target) || state.latest.version)}</b></div>` : '') + '</div>';
      let body0, foot0;
      if (w) {
        body0 = versions0 + waitBlock(w);
        foot0 = `<button class="au-btn" data-au="close">关闭</button>${w.local ? '<button class="au-btn" data-au="wait-cancel">不重启了</button>' : ''}`
          + `<button class="au-btn primary" data-au="apply-now">立即重启${w.count ? `（打断 ${w.count} 个问题）` : ''}</button>`;
      } else {
        body0 = versions0 + `<div class="au-msg warn" data-au-confirm>还有 ${esc(c.text)}在答。现在重启会打断这 ${c.count} 个问题（重启后自动恢复会话接着做）。</div>${waitItems(c.items)}`
          + `<div class="au-msg info">「答完再重启」：最多等 ${c.graceMinutes} 分钟（预计最晚 ${hhmm(c.deadline)}），期间新问题先排队${c.queued ? `（现有 ${c.queued} 个排队的重启后接着发）` : ''}，答完立即重启。</div>`;
        foot0 = `<button class="au-btn" data-au="close">稍后</button><button class="au-btn" data-au="apply-now">立即重启（打断 ${c.count} 个问题）</button>`
          + '<button class="au-btn primary" data-au="apply-wait">答完再重启</button>';
      }
      dialog.innerHTML = `<div class="au-head"><img src="../claude-wx.ico" alt=""><div class="au-title"><strong>软件更新</strong><span>${esc(subtitle)}</span></div>`
        + '<button class="au-close" data-au="close" aria-label="关闭">×</button></div>'
        + `<div class="au-body">${body0}</div><div class="au-foot">${foot0}</div>`;
      paintPending();
      return;
    }
    const s = state, latest = s.latest, plan = s.plan;
    const versions = `<div class="au-versions"><div class="au-ver"><small>当前版本</small><b>v${esc(s.current)}</b></div>`
      + (latest && plan && plan.kind !== 'none' ? `<span class="au-arrow">→</span><div class="au-ver"><small>新版本</small><b>v${esc(latest.version)}</b></div>`
        + `<div class="au-plan"><b>${plan.kind === 'incremental' ? '程序更新（不含运行库）' : '完整安装包'} · ${mb(plan.bytes)}</b>${esc(plan.reason)}</div>` : '')
      + '</div>';
    let body = versions, foot = '';
    const quietBox = s.quietFeature ? `<label class="au-quiet"><input type="checkbox" data-au="quiet"${s.quietEnabled === false ? '' : ' checked'}> 自动更新：小版本在后台下好；下好的更新在关闭 Hub 时换上，下次打开生效，不打断工作</label>` : '';
    const openxRecordBox = s.openxRecordFeature ? `<label class="au-quiet"><input type="checkbox" data-au="openx-record"${s.openxRecordEnabled === false ? '' : ' checked'}> 更新下载后自动计入内源社区下载量（后台无感完成，不影响下载速度）</label>` : '';
    if (s.phase === 'checking') {
      body += '<div class="au-msg info">正在向公司内源查询最新版本…</div>';
      foot = '<button class="au-btn" data-au="close">关闭</button>';
    } else if (s.phase === 'none' && s.pending) {
      // 2026-11-25：内源连得上、新版还在准备——平静一行，不让用户重试或反馈；有更新的完整安装包时给下载按钮。
      const manualP = manualDownload();
      body += `<div class="au-msg info" data-au-pending>暂时没有可安装的新版本，Hub 会自动定时再查，不用操作。</div>${fullPackageLine()}`;
      foot = `${manualP ? `<button class="au-btn" data-au="manual">${esc(manualP.label)}</button>` : ''}<button class="au-btn" data-au="close">好的</button>`;
    } else if (s.phase === 'none') {
      body += `<div class="au-msg ok">已是最新版本 v${esc(s.current)}。</div>${sourceLine()}`;
      foot = '<button class="au-btn" data-au="close">好的</button>';
    } else if (s.phase === 'available') {
      if (latest && latest.notes && latest.notes.length) body += `<div class="au-section">本次更新</div>${notesHtml(latest)}`;
      body += installHint(plan);
      body += sourceLine();
      // r27：这一版要完整安装包（本机太老、运行库变了）时，也给浏览器手动下载的入口。
      const manualA = (plan && (plan.portable || plan.protectedDir || plan.kind === 'full')) ? manualDownload() : null;
      foot = '<button class="au-btn" data-au="close">稍后</button>'
        + (plan && plan.portable ? (manualA ? `<button class="au-btn primary" data-au="manual">${esc(manualA.label)}</button>` : '')
          : `${manualA ? `<button class="au-btn" data-au="manual">${esc(manualA.label)}</button>` : ''}<button class="au-btn primary" data-au="download">下载更新</button>`);
    } else if (s.phase === 'downloading') {
      // r59：统一进度条（进度、速度、剩余时间、来源），和其他安装一个样式。
      const p = s.progress || {};
      const current = (s.attempts || []).find(a => a.status === 'downloading');
      body += require('./download-progress-view').html({ ...p, sourceId: p.sourceId || (current && current.id), sourceName: p.sourceName || (current && current.name), phase: p.total ? 'downloading' : 'connecting' }, { title: `下载 v${(latest && latest.version) || ''} 更新包` })
        + sourceLine();
      foot = '<button class="au-btn" data-au="cancel">取消</button>';
    } else if (s.phase === 'ready') {
      if (s.applyCancelled) body += `<div class="au-msg warn" data-au-cancelled>${esc(s.applyCancelled.reason)}</div>`;
      body += `<div class="au-msg ok">新版本已从「${esc(s.readySource)}」下载并校验通过。${plan && plan.kind === 'incremental' ? '点「立即重启」后先保存会话、关闭窗口，屏幕中间会出现升级进度小窗（第几步、已等多久），换好后自动打开新版，通常 10–40 秒；期间不用再点图标。替换失败会自动恢复旧版本，可在小窗里一键重试。' : '点「立即安装」会打开安装程序，并关闭当前窗口。'}${plan && plan.kind === 'incremental' && s.needsAdmin ? '<br>程序装在受保护的目录里，重启时 Windows 会弹出确认框，请点「是」授权这一次替换；Hub 本身仍以普通权限运行。' : ''}</div>`;
      if (plan && plan.kind === 'incremental' && !s.needsAdmin && s.quietEnabled !== false) body += '<div class="au-msg info" data-au-onquit>不急的话点「稍后」：关闭 Hub 时会自动换上，下次打开就是新版。</div>';
      const rec = s.openxRecord;
      if (rec && rec.status === 'recorded' && (!latest || String(rec.version) === String(latest.version))) {
        body += '<div class="au-msg ok" data-au-openx-recorded>已为你同步计入内源社区下载记录，感谢支持 AI HUB！</div>';
      }
      const manualR = s.needsAdmin ? manualDownload() : null;
      foot = `${manualR ? `<button class="au-btn" data-au="manual">${esc(manualR.label)}</button>` : ''}<button class="au-btn" data-au="close">稍后</button><button class="au-btn primary" data-au="apply">${plan && plan.kind === 'incremental' ? '立即重启' : '立即安装'}</button>`;
    } else if (s.phase === 'applying') {
      body += '<div class="au-msg info">正在保存会话并关闭窗口，随后屏幕中间会出现升级进度小窗，换好后自动打开新版（通常 10–40 秒）。期间不用再点图标，点了也只会回到进度小窗。</div>';
    } else if (s.phase === 'error' && s.errorKind === 'offline') {
      // 提示旁放一个不高亮的「重试」（刚连上 VPN 想马上再查时用），底部不再有高亮按钮。
      body += `<div class="au-msg info" data-au-offline style="display:flex;align-items:center;gap:10px"><span style="flex:1">${esc(s.error)}</span><button class="au-btn" data-au="retry">重试</button></div>`;
      foot = '<button class="au-btn" data-au="close">好的</button>';
    } else if (s.phase === 'error' && s.errorKind === 'slow') {
      // R44：在公司网络但内源太慢——一句话说明，「重试」就放在这句话旁边；底部不再重复一个高亮的「重试」。
      const manualS = manualDownload();
      body += `<div class="au-msg info" data-au-slow style="display:flex;align-items:center;gap:10px"><span style="flex:1">${esc(s.error)}</span><button class="au-btn" data-au="retry">重试</button></div>${fullPackageLine()}`;
      foot = `${manualS ? `<button class="au-btn" data-au="manual">${esc(manualS.label)}</button>` : ''}<button class="au-btn" data-au="close">关闭</button>`;
    } else if (s.phase === 'error') {
      // 5.5.24：命中已知问题（如安装包校验失败、被公司网络拦截）直接给解法和一键按钮；悬停这条出现「问问 Agent」「一键反馈」。
      const card = window.HubErrorCard;
      const manual = manualDownload();
      const error = s.error || '更新失败';
      const reasons = [...(s.attempts || []), ...(s.checks || [])].filter(a => a && a.reason && !a.informational).map(a => `${a.name || a.id || '公司内源'}：${a.reason}`);
      const ctx = { area: 'app-update', title: '一键更新没有完成', symptom: error, details: [error, ...reasons].join('\n') };
      body += `<div class="au-msg bad">${card ? card.assistHtml(ctx) : ''}${esc(error)}</div>${card ? card.knownHtml(ctx) : ''}`;
      if (plan && plan.portable) body += installHint(plan);
      body += fullPackageLine();
      // R44：红框已写明原因，「公司内源」那一行不再把同一句话重复一遍；只有下载过程（attempts）另有内容时才列。
      if ((s.attempts || []).some(a => !(a.reason && error.includes(a.reason)))) body += sourceLine();
      foot = `${manual ? `<button class="au-btn" data-au="manual">${esc(manual.label)}</button>` : ''}<button class="au-btn" data-au="close">关闭</button><button class="au-btn primary" data-au="retry">重试</button>`;
    } else {
      body += '<div class="au-msg info">点「检查更新」查询最新版本。</div>';
      foot = '<button class="au-btn" data-au="close">关闭</button><button class="au-btn primary" data-au="retry">检查更新</button>';
    }
    if (manualError) body += `<div class="au-msg bad" data-au-manual-error>${esc(manualError)}</div>`;
    dialog.innerHTML = `<div class="au-head"><img src="../claude-wx.ico" alt=""><div class="au-title"><strong>软件更新</strong><span>${esc(subtitle)}</span></div>`
      + '<button class="au-close" data-au="close" aria-label="关闭">×</button></div>'
      + `<div class="au-body">${body}${quietBox}${openxRecordBox}</div><div class="au-foot">${foot}</div>`;
    paintPending();
  }

  function openDialog() {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'app-update-dialog';
      dialog.addEventListener('click', onClick);
      dialog.addEventListener('close', () => { dialog.remove(); dialog = null; });
      document.body.appendChild(dialog);
    }
    render();
    if (!dialog.open) dialog.showModal();
  }

  async function onClick(event) {
    const action = event.target.closest('[data-au]')?.dataset.au;
    if (!action) return;
    try {
      if (action === 'quiet') { await ipcRenderer.invoke('app-update:set-quiet', event.target.checked); return; }
      if (action === 'openx-record') { await ipcRenderer.invoke('app-update:set-openx-record', event.target.checked); return; }
      if (action === 'notes-more' || action === 'notes-less') { notesOpenFor = action === 'notes-more' ? String(state?.latest?.version || '') : ''; render(); return; }
      if (action !== 'manual') manualError = '';
      if (action === 'close') { confirmInfo = null; dialog?.close(); }
      else if (action === 'retry') { await ipcRenderer.invoke('app-update:check'); }
      else if (action === 'download') {
        // 已经动手更新了，设置上的红点就不用再提醒。
        if (pendingVersion()) { writeKey(SEEN_KEY, pendingVersion()); renderUnread(); }
        await ipcRenderer.invoke('app-update:download');
      }
      else if (action === 'cancel') await ipcRenderer.invoke('app-update:cancel');
      else if (['apply', 'apply-wait', 'apply-now', 'wait-cancel'].includes(action)) {
        const mode = { apply: 'auto', 'apply-wait': 'wait', 'apply-now': 'now', 'wait-cancel': 'cancel' }[action];
        if (applyPending) return;
        applyPending = action; paintPending();
        let next;
        try { next = await ipcRenderer.invoke('app-update:apply', { mode }); } finally { applyPending = null; }
        confirmInfo = next && next.needsConfirm ? next.confirm : null;
        if (next && next.phase) update(next); else render();
      }
      else if (action === 'manual') {
        // r58：在浏览器里打开公司内源上的安装包；内源没有或连不上时说明原因。
        const target = manualDownload();
        if (target) {
          const opened = await openManual();
          if (opened && target.direct && state?.fullPackage) {
            void ipcRenderer.invoke('app-update:record-manual', state.fullPackage).catch(() => {});
          }
        }
      }
    } catch (error) {
      state = { ...state, phase: 'error', error: error.message };
      render();
    }
  }

  // 新版本提醒（2026-10-13 用户）：同一个版本只自动弹一次窗；之后「设置」按钮挂红点（同助理的未读红点），
  // 直到用户从设置菜单点开这个版本的更新为止。两个标记按版本号记在本机，换了新版本重新提醒。
  const PROMPTED_KEY = 'hub:appUpdate:promptedVersion';
  const SEEN_KEY = 'hub:appUpdate:seenVersion';
  // 自己点的升级没成后补过提醒的版本：同一个失败版本只补一次，再失败也不再补（r43 返工）。
  const RETRY_KEY = 'hub:appUpdate:retryPromptedVersion';
  const ADMIN_RE = /管理员授权|没有写入安装目录的权限/;
  const readKey = key => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
  const writeKey = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  function pendingVersion() {
    // 固定版本时不提醒新版；回退包（latest.rollback）不算新版本（R42 审查 P1-1）。
    return state && !state.pinned && state.latest && !state.latest.rollback && state.plan && state.plan.kind !== 'none'
      && ['available', 'downloading', 'ready'].includes(state.phase) ? String(state.latest.version) : '';
  }
  // 只改末位的小更新（latest.notify === false）不主动提醒：弹窗、红点、左上角标签都按「没有新版本」处理，
  // 直到用户自己在设置里点「检查更新」看到它（revealed）。x / y 变了的更新照常提醒（2026-10-24 用户）。
  // 2026-11-20（K / O）：小版本仍不弹窗，但下好了（已就绪）要挂小点、底栏一行「已就绪，重启生效」；
  // 后台送不到的（受保护目录、免安装版要换运行库、用户关了自动更新）也挂小点，不再整版隐藏、永远升不上。
  let revealed = '';
  // 主进程说了算（quietPending：这一版会不会由后台送达）；老版本主进程没给时按计划推断。
  function quietDeliverable() {
    if (state && typeof state.quietPending === 'boolean') return state.quietPending;
    const plan = state && state.plan;
    return !!(state && state.quietEnabled && plan && plan.kind === 'incremental' && !plan.protectedDir);
  }
  function noticeVersion() {
    const version = pendingVersion();
    if (!version || state.latest.notify !== false || revealed === version) return version;
    if (state.phase === 'ready') return version;
    return state.phase === 'available' && !quietDeliverable() ? version : '';
  }
  function maybePromptOnce() {
    const version = noticeVersion();
    if (!version || state.phase !== 'available' || readKey(PROMPTED_KEY) === version) return;
    // 小版本只挂点不弹窗（自己点开过或没升成的除外）。
    if (state.latest.notify === false && revealed !== version) return;
    writeKey(PROMPTED_KEY, version);
    // 用户自己从设置里点开、正看着弹窗时查到的新版本，算已看过，不再挂红点。
    if (dialog) { writeKey(SEEN_KEY, version); renderUnread(); return; }
    openDialog();
  }
  function renderUnread() {
    const version = noticeVersion();
    const unread = !!version && readKey(SEEN_KEY) !== version;
    const button = document.getElementById('btn-options');
    if (button) {
      button.classList.toggle('update-has-unread', unread);
      if (unread) button.title = `选项 · 有新版本 v${version}`;
      else if (button.title.startsWith('选项 · 有新版本')) button.title = '选项';
    }
    const item = document.getElementById('options-check-update');
    if (item) {
      paintMenuEntry(item, version);
      item.classList.toggle('update-has-unread', unread);
    }
  }

  // 左上角「内测先锋版」标签（2026-10-14 用户）：查到新版本时换成「有新版本 vX」加绿色呼吸圆点，点它打开更新窗。
  // 下载中 / 已就绪由标题栏的进度小标签提示，标签恢复原样。
  function renderBadge() {
    const badge = document.getElementById('hub-edition-badge');
    if (!badge) return;
    const version = state && state.phase === 'available' ? noticeVersion() : '';
    badge.classList.toggle('has-update', !!version);
    badge.textContent = version ? `有新版本 v${version}` : (distribution.editionBadge || badge.textContent);
    if (version) { badge.title = '点击查看并更新'; badge.setAttribute('role', 'button'); badge.tabIndex = 0; }
    else { badge.removeAttribute('title'); badge.removeAttribute('role'); badge.removeAttribute('tabindex'); }
    if (!badge.dataset.updateBound) {
      badge.dataset.updateBound = '1';
      const open = () => { if (!badge.classList.contains('has-update')) return; const v = pendingVersion(); if (v) { writeKey(SEEN_KEY, v); renderUnread(); } openDialog(); };
      badge.addEventListener('click', open);
      badge.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    }
  }

  function renderPill() {
    let pill = document.getElementById('hub-update-pill');
    // 「有新版本」改由弹窗 + 设置红点提醒；标题栏只在下载中 / 已就绪时提示进度和重启。
    const wait = state && state.restartWait;
    // 静默送达的小版本在后台下载、关闭时替换，标题栏不提示；用户自己从设置打开更新窗口时照常能看到。
    // 已就绪改由底栏一行提示（K），标题栏只在下载中 / 等待重启时提示。
    const show = wait || (state && !state.quiet && state.phase === 'downloading' && state.latest && !state.latest.rollback && state.plan?.kind !== 'none');
    if (!show) { pill?.remove(); return; }
    if (!pill) {
      pill = document.createElement('button');
      pill.type = 'button'; pill.id = 'hub-update-pill'; pill.className = 'hub-update-pill';
      pill.addEventListener('click', openDialog);
      const anchor = document.getElementById('hub-version');
      if (anchor) anchor.after(pill); else document.getElementById('hub-identity')?.appendChild(pill);
    }
    pill.textContent = wait ? (wait.count ? `等 ${wait.count} 个${wait.bridgeCount === wait.count ? '问题' : '任务'}答完再重启 · 最晚 ${hhmm(wait.deadline)}` : '马上重启')
      : state.phase === 'ready' ? `v${state.latest.version} 已就绪，重启生效` : state.phase === 'downloading' ? `正在下载 v${state.latest.version}` : `有新版本 v${state.latest.version}`;
    pill.title = '点击查看更新';
  }

  // 底栏一行（K）：「新版本 vX 已就绪，重启生效」，点它打开更新窗；放在左侧会话栏底部，没有会话栏时贴左下角。
  function renderReadyLine() {
    let line = document.getElementById('hub-update-ready');
    const show = state && !state.pinned && !state.restartWait && state.phase === 'ready' && state.latest && !state.latest.rollback && state.plan?.kind !== 'none';
    if (!show) { line?.remove(); return; }
    if (!line) {
      line = document.createElement('div');
      line.id = 'hub-update-ready'; line.className = 'au-ready-line'; line.setAttribute('role', 'status');
      line.addEventListener('click', event => {
        const v = pendingVersion(); if (v) { writeKey(SEEN_KEY, v); renderUnread(); }
        const lineBtn = event.target.closest('[data-au-line="apply"]');
        if (lineBtn) {
          if (lineBtn.disabled) return;
          // R48：底栏「立即重启」同样当场变「正在重启…」。
          lineBtn.disabled = true; lineBtn.textContent = '正在重启…';
          void ipcRenderer.invoke('app-update:apply', { mode: 'auto' }).then(next => {
            if (next && next.needsConfirm) { confirmInfo = next.confirm; openDialog(); } else if (next && next.phase) update(next);
          }).catch(() => openDialog()).finally(() => renderReadyLine());
          return;
        }
        openDialog();
      });
      const sidebar = document.getElementById('session-sidebar');
      if (sidebar) sidebar.appendChild(line); else { line.classList.add('fixed'); document.body.appendChild(line); }
    }
    const incremental = state.plan?.kind === 'incremental';
    const onQuit = incremental && !state.needsAdmin && state.quietEnabled !== false;
    line.title = onQuit ? '关闭 Hub 时自动换上，下次打开就是新版；也可以现在重启' : '点击查看更新';
    line.innerHTML = `<span>新版本 v${esc(state.latest.version)} 已就绪，重启生效</span><button type="button" data-au-line="apply">${incremental ? '立即重启' : '立即安装'}</button>`;
  }

  function toast(html, ms = 8000) {
    const el = document.createElement('div');
    el.className = 'au-toast'; el.innerHTML = html;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // 菜单项：标题 +（小字）版本状态。小版本不弹窗也不挂红点，但打开菜单就能看到「有新版本 x.y.z」或「已是最新」。
  function paintMenuEntry(item, version = noticeVersion()) {
    let label = item.querySelector('.au-menu-label');
    let status = item.querySelector('.au-menu-status');
    if (!label) {
      item.textContent = '';
      label = document.createElement('span'); label.className = 'au-menu-label';
      status = document.createElement('small'); status.className = 'au-menu-status';
      item.append(label, status);
    }
    label.textContent = version ? `⬆️ 有新版本 v${version}` : '⬆️ 检查更新';
    const text = require('./app-update-menu-status').menuStatusText(state, { labelVersion: version });
    status.textContent = text;
    status.hidden = !text;
    status.dataset.pending = /^有新版本|已就绪|正在下载/.test(text) ? '1' : '';
  }

  function addMenuEntry() {
    const menu = document.getElementById('options-menu');
    if (!menu || document.getElementById('options-check-update')) return;
    const item = document.createElement('div');
    // 先写纯文字：说明书的界面地图（tools/help-manual）按这一句认出「检查更新」；paintMenuEntry 再换成 标题 + 状态。
    item.className = 'options-item'; item.id = 'options-check-update'; item.textContent = '⬆️ 检查更新';
    paintMenuEntry(item);
    item.addEventListener('click', () => {
      menu.style.display = 'none';
      const version = pendingVersion();
      if (version) { revealed = version; writeKey(SEEN_KEY, version); writeKey(PROMPTED_KEY, version); renderUnread(); }
      openDialog();
      // 已经查到新版本（或正在下载 / 已就绪）就直接看它；否则现查一次。
      if (!version) void ipcRenderer.invoke('app-update:check');
    });
    menu.appendChild(item);
  }

  // 点了「立即重启」但 Hub 没退出、这次没升级（r43）：把更新窗口重新打开，说清原因，「立即重启」还在，不用重新下载。
  let cancelSeen = '';
  const update = next => {
    state = next; render(); renderPill(); renderBadge(); renderUnread(); renderReadyLine(); maybePromptOnce();
    const c = state && state.phase === 'ready' && state.applyCancelled;
    if (c && c.at !== cancelSeen) { cancelSeen = c.at; openDialog(); }
  };
  ipcRenderer.on('app-update:state', (_e, next) => update(next));
  let refreshTimer = null;
  const refresh = () => { if (refreshTimer) return; refreshTimer = setTimeout(() => { refreshTimer = null; ipcRenderer.invoke('app-update:get-state').then(next => { if (next) update(next); }).catch(() => {}); }, 1500); };
  ipcRenderer.on('bridge:changed', refresh);
  setInterval(() => { if (state && state.restartWait) refresh(); }, 30000);
  addMenuEntry();
  ipcRenderer.invoke('app-update:get-state').then(initial => {
    const r = initial && initial.lastResult;
    // 用户自己点的升级没成（进度小窗被关掉、旧窗口没退出、替换失败已还原……）：只对没升成的这个版本，
    // 「只自动提醒一次」作废、只改末位也照常提醒，后台检查查到它时再提醒一次，不让一次没成就再也不提醒（r43）。
    // 例外只给这一个版本：之后别的小版本仍按「不主动提醒」处理；同一个失败版本只补一次（r43 返工）。
    // O①（2026-11-20）：再失败也不能彻底沉默——每次没升成都重新挂红点（弹窗仍只补一次），关 Hub 时顺手替换没成的也挂点。
    if (r && !r.ok && r.version) {
      const failed = String(r.version);
      if (readKey(SEEN_KEY) === failed) { try { localStorage.removeItem(SEEN_KEY); } catch {} }
      revealed = failed;
      if (!r.quiet && readKey(RETRY_KEY) !== failed) {
        writeKey(RETRY_KEY, failed);
        if (readKey(PROMPTED_KEY) === failed) { try { localStorage.removeItem(PROMPTED_KEY); } catch {} }
      } else writeKey(PROMPTED_KEY, failed);
    }
    update(initial);
    if (r) {
      void ipcRenderer.invoke('app-update:dismiss-result');
      // 有更新日志时右下角会列出这次多了什么（renderer/whats-new.js），这里就不再多弹一条。
      if (r.ok) { if (!window.__whatsNew?.hasUnread?.()) toast(`✅ 已更新到 <b>v${esc(r.version)}</b>`); }
      // 静默替换失败时脚本已回滚，下一版还会再试，不打扰用户；原因留在日志里。
      // 关 Hub 时顺手替换没成：脚本已回滚，只在设置上挂点（上面），不弹提示；原因留在日志里。
      else if (r.quiet && !r.restoreFailed) console.warn('[app-update] 静默更新没有完成：', r.reason);
      // O④：失败提示里就地给原因和「去内源下载完整包」按钮，不用再到群里问。
      else failToast(r.quiet ? `⚠️ 后台更新到 v${esc(r.version)} 没有完成，也没能恢复原来的文件：${esc(r.reason)}。如果用着不正常，请用完整安装包重装。`
        : `⚠️ 更新到 v${esc(r.version)} 没有完成${r.rolledBack ? '，已恢复原来的版本' : ''}：${esc(r.reason)}${ADMIN_RE.test(String(r.reason || '')) ? '<br>电脑没有管理员权限时：点下面按钮下载完整安装包重装一次，安装时选「仅为我安装」，以后就能自动更新（数据不会丢）。' : ''}`);
    }
  }).catch(() => {});
  // 失败提示（O④）：原因 + 「去内源下载完整包」+「再试一次」；30 秒后自动消失，点了按钮立即消失。
  function failToast(html) {
    const el = document.createElement('div');
    el.className = 'au-toast'; el.setAttribute('data-au-fail', '1');
    el.innerHTML = `${html}<div><button type="button" class="au-btn primary" data-au-t="manual">去内源下载完整包</button><button type="button" class="au-btn" data-au-t="retry">再试一次</button><button type="button" class="au-btn" data-au-t="close">知道了</button></div>`;
    el.addEventListener('click', event => {
      const act = event.target.closest('[data-au-t]')?.dataset.auT;
      if (!act) return;
      el.remove();
      if (act === 'manual') void openManual();
      else if (act === 'retry') { openDialog(); void ipcRenderer.invoke('app-update:check'); }
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 30000);
  }
  window.__appUpdate = { open: openDialog, state: () => state };
})();
