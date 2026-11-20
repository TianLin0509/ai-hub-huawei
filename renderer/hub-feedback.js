'use strict';
// 一键反馈的界面（2026-10-29）：设置菜单「💬 一键反馈」→ 写一句遇到了什么 → 看一眼会附带哪些内容 → 发送。
// 附带的是版本、系统和最近的日志尾部，发送前已在主进程脱敏（core/hub-feedback.js）；数据与发送都在 main/hub-feedback-service.js。
// 样式沿用一键更新弹窗（renderer/app-update.js 的 .app-update-dialog / .au-*），只有带更新配置的发行版才出现。
(() => {
  const distribution = require('../core/distribution');
  if (!distribution.updateConfig) return;
  const { ipcRenderer, shell } = require('electron');
  let dialog = null, sending = false, contactEdited = false, via = '', lastText = '';
  // WeLink 模式（2026-11-21）：公司内用户的反馈直接发到维护人 WeLink，内网收件机的发送与待发提示都隐藏。
  let wl = null;
  const TO_INTRANET = '发给维护人（公司内网），帮你排查问题';
  // 2026-11-20（HUB-H 第一期）：附上本机各 CLI 查过的位置和结论（定位中心打码后的文本，renderer/harness-client.js），
  // 维护人不用再来回问「装在哪、用的哪个 Node」。主进程还没有定位中心时不附，其他照旧。
  const harness = require('./harness-client').createHarnessClient(ipcRenderer);
  const diagnosis = () => harness.diagnosisText().catch(() => '');

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = `
  .hub-feedback-dialog textarea { width: 100%; box-sizing: border-box; min-height: 110px; resize: vertical; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--border-subtle, #dcd9e6); background: var(--surface-sunken, #f6f5fa); color: var(--fg-default, #1f2330); font: inherit; font-size: 13px; }
  .hub-feedback-dialog input.hf-contact { width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border-subtle, #dcd9e6);
    background: var(--surface-sunken, #f6f5fa); color: var(--fg-default, #1f2330); font: inherit; font-size: 13px; }
  .hub-feedback-dialog :is(textarea, input.hf-contact)::placeholder { color: var(--fg-muted, #6b7080); opacity: 1; }
  .hub-feedback-dialog .hf-items { margin: 0; padding-left: 18px; font-size: 12px; color: var(--fg-muted, #6b7080); max-height: 120px; overflow: auto; }
  .hub-feedback-dialog .hf-path { font-family: Consolas, monospace; font-size: 12px; word-break: break-all; user-select: text; }
  .hub-feedback-dialog .hf-outbox { margin-top: 10px; font-size: 12px; line-height: 1.7; }
  .hub-feedback-dialog .hf-outbox .au-btn { margin-left: 8px; }
  #hub-feedback-outbox-marker { flex: none; height: 22px; padding: 0 7px; border: 1px solid var(--border-subtle, #d7dde6); border-radius: 11px; background: transparent;
    color: var(--warning, #b66a12); font: 500 11px var(--font-sans, 'Microsoft YaHei', sans-serif); white-space: nowrap; cursor: pointer; }
  #hub-feedback-outbox-marker:hover { background: var(--brand-tint, #eaf2ff); }`;

  function ensureDialog() {
    if (dialog) return dialog;
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    dialog = document.createElement('dialog');
    dialog.className = 'app-update-dialog hub-feedback-dialog';
    dialog.innerHTML = `
      <div class="au-head"><div class="au-title"><strong>一键反馈</strong><span data-hf="to">发给 AI HUB 维护人，帮你排查问题</span></div>
        <button type="button" class="au-close" data-hf="close" title="关闭">✕</button></div>
      <div class="au-body">
        <div class="au-section">遇到了什么问题</div>
        <textarea data-hf="desc" placeholder="例如：CodeAgent 会话卡片一直不显示回答，后台终端里是有的"></textarea>
        <div class="au-section">联系方式（可不填）</div>
        <input class="hf-contact" data-hf="contact" maxlength="160" placeholder="工号或姓名，方便回访">
        <div class="au-section" data-hf="items-title">会一起附带（已自动隐去密钥、口令、邮箱和用户目录）</div>
        <ul class="hf-items" data-hf="items"><li>正在整理…</li></ul>
        <div data-hf="outbox" hidden></div>
        <div data-hf="msg"></div>
      </div>
      <div class="au-foot"><button type="button" class="au-btn" data-hf="mine" style="margin-right:auto">我的反馈</button><button type="button" class="au-btn" data-hf="cancel">取消</button>
        <button type="button" class="au-btn" data-hf="wl-copy" hidden title="把反馈内容复制好，再打开电脑上的 WeLink，自己粘贴发给维护人">复制并打开 WeLink</button>
        <button type="button" class="au-btn primary" data-hf="wl-send" hidden title="用本机 welink-cli 直接私聊发给维护人">一键发到 WeLink</button>
        <button type="button" class="au-btn primary" data-hf="send">发送</button></div>`;
    document.body.appendChild(dialog);
    const q = name => dialog.querySelector(`[data-hf="${name}"]`);
    const close = () => { if (!sending) dialog.close(); };
    q('close').addEventListener('click', close);
    q('cancel').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { if (sending) event.preventDefault(); });
    q('send').addEventListener('click', () => void send());
    q('wl-send').addEventListener('click', () => void sendWelink());
    q('wl-copy').addEventListener('click', () => void copyOpenWelink());
    q('mine').addEventListener('click', () => { if (!sending) { dialog.close(); void openMine(); } });
    q('contact').addEventListener('input', () => {
      contactEdited = true;
      void ipcRenderer.invoke('hub-feedback:save-contact', { contact: q('contact').value }).catch(() => {});
    });
    return dialog;
  }

  function message(kind, html) {
    const box = dialog.querySelector('[data-hf="msg"]');
    box.innerHTML = html ? `<div class="au-msg ${kind}">${html}</div>` : '';
    const link = box.querySelector('[data-hf-open]');
    if (link) link.addEventListener('click', () => shell.showItemInFolder(link.dataset.hfOpen));
    const copyBtn = box.querySelector('[data-hf-copy]');
    if (copyBtn) copyBtn.addEventListener('click', event => {
      event.preventDefault();
      try { require('electron').clipboard.writeText(lastText); copyBtn.textContent = '已复制，可以贴到 WeLink 发给维护人'; }
      catch { copyBtn.textContent = '复制失败，请打开上面的文件手动复制'; }
    });
    const unblock = box.querySelector('[data-hf-unblock]');
    if (unblock) unblock.addEventListener('click', event => { event.preventDefault(); void ipcRenderer.invoke('net-pass:open-window', unblock.dataset.hfUnblock, { method: 'POST' }).catch(error => window.__hubToast?.('放行页没打开：' + (error?.message || '未知原因'))); });
  }

  // prefill.description：从错误卡「一键反馈」进来时预填现象、功能区和原始报错（5.5.24），用户可以改了再发。
  // 正在发送时不覆盖；用户已经写了内容且没发出去时也不覆盖，只把新的报错接在后面。
  async function open(prefill) {
    ensureDialog();
    if (!sending) {
      dialog.querySelector('[data-hf="send"]').disabled = false;
      dialog.querySelector('[data-hf="send"]').textContent = '发送';
      dialog.querySelector('[data-hf="wl-send"]').textContent = '一键发到 WeLink';
      message('', '');
    }
    const desc = dialog.querySelector('[data-hf="desc"]');
    const text = prefill && typeof prefill.description === 'string' ? prefill.description.trim() : '';
    if (text && !sending) desc.value = desc.value.trim() && !desc.value.includes(text) ? desc.value.trimEnd() + '\n\n' + text : text;
    if (!dialog.open) dialog.showModal();
    desc.focus();
    if (text) { const at = desc.value.indexOf('（可以在这里补一句'); if (at >= 0) desc.setSelectionRange(at, desc.value.indexOf('）', at) + 1); }
    try {
      const p = await ipcRenderer.invoke('hub-feedback:preview', {});
      if (!contactEdited && !sending && p && typeof p.contact === 'string') dialog.querySelector('[data-hf="contact"]').value = p.contact;
      const items = (p && p.items) || [];
      const diag = await diagnosis();
      // 诊断放第一条：清单区域只露出前几行，这条最需要同事知道。
      const rows = (diag ? [`<li>本机 CLI 识别诊断 · 各 CLI 查过的位置和结论（${diag.split(/\r?\n/).length} 行，用户名已打码）</li>`] : [])
        .concat(items.map(i => `<li>${esc(i.name)}${i.detail ? ' · ' + esc(i.detail) : ''}</li>`));
      dialog.querySelector('[data-hf="items"]').innerHTML = rows.join('') || '<li>只有问题描述</li>';
      void refreshOutbox();
    } catch (error) {
      dialog.querySelector('[data-hf="items"]').innerHTML = `<li>整理附带内容失败：${esc(error.message)}</li>`;
    }
    try { wl = await ipcRenderer.invoke('hub-feedback:welink-state'); } catch { wl = null; }
    if (wl && wl.enabled) { applyWelinkMode(); return; }
    // 公开版离开公司网络后回到旧的「发送」（之前进过 WeLink 模式时按钮要还原）。
    dialog.querySelector('[data-hf="send"]').hidden = false;
    dialog.querySelector('[data-hf="wl-copy"]').hidden = dialog.querySelector('[data-hf="wl-send"]').hidden = true;
    // 发到哪儿（r42）：公司内网的维护人电脑，还是公司外用户的阿里云。公开版要探一次内源，最多约 3 秒。
    try {
      const r = await ipcRenderer.invoke('hub-feedback:route');
      via = (r && r.via) || '';
      if (via === 'intranet') dialog.querySelector('[data-hf="to"]').textContent = TO_INTRANET;
    } catch { /* 沿用默认文案 */ }
  }

  // WeLink 模式的按钮：装了 welink-cli 时「一键发到 WeLink」为主按钮，没装时只留「复制并打开 WeLink」。
  function applyWelinkMode() {
    const q = name => dialog.querySelector(`[data-hf="${name}"]`);
    q('to').textContent = `直接发到维护人的 WeLink（账号 ${wl.to}）`;
    q('items-title').textContent = 'WeLink 消息里带：问题描述、版本与系统、最近报错几行（已隐去密钥、口令、邮箱）；下面这些完整内容存到你的「下载」文件夹';
    q('send').hidden = true;
    q('wl-copy').hidden = false;
    q('wl-send').hidden = !wl.cli;
    q('wl-copy').classList.toggle('primary', !wl.cli);
    paintOutbox(outbox);
    if (!sending && !wl.cli) message('info', `这台电脑没装 welink-cli，点「复制并打开 WeLink」：内容会复制好并打开 WeLink，搜 <b>${esc(wl.to)}</b> 粘贴（Ctrl+V）发送即可。`);
  }
  function welinkBusy(on, btnName, label) {
    sending = on;
    for (const n of ['wl-send', 'wl-copy']) dialog.querySelector(`[data-hf="${n}"]`).disabled = on;
    if (btnName) dialog.querySelector(`[data-hf="${btnName}"]`).textContent = label;
  }
  function welinkInput() {
    const desc = dialog.querySelector('[data-hf="desc"]').value;
    if (!desc.trim()) { message('warn', '请先写一句遇到了什么问题'); dialog.querySelector('[data-hf="desc"]').focus(); return null; }
    return { description: desc, contact: dialog.querySelector('[data-hf="contact"]').value };
  }
  const savedLine = r => r && r.savedTo ? `<br><small>完整诊断包存在：<span class="hf-path">${esc(r.savedTo)}</span> <a href="#" data-hf-open="${esc(r.savedTo)}">打开所在文件夹</a></small>` : '';
  async function sendWelink() {
    if (sending) return;
    const input = welinkInput(); if (!input) return;
    welinkBusy(true, 'wl-send', '正在发送…');
    message('info', '正在用 welink-cli 发到维护人的 WeLink…');
    let r;
    try { r = await ipcRenderer.invoke('hub-feedback:welink-send', input); } catch (error) { r = { ok: false, reason: error.message }; }
    welinkBusy(false, 'wl-send', r && r.ok ? '已发送' : '一键发到 WeLink');
    if (r && r.ok) {
      message('ok', `已发到维护人的 WeLink（${esc(r.to)}）${r.parts > 1 ? `，分 ${r.parts} 条` : ''}，在你的 WeLink 聊天记录里也能看到。${savedLine(r)}`);
      dialog.querySelector('[data-hf="desc"]').value = '';
      return;
    }
    message('bad', `没发出去：${esc((r && r.reason) || '未知原因')}<br>可以点「复制并打开 WeLink」，粘贴发给 <b>${esc(wl.to)}</b>。${savedLine(r)}`);
  }
  async function copyOpenWelink() {
    if (sending) return;
    const input = welinkInput(); if (!input) return;
    welinkBusy(true, 'wl-copy', '正在复制…');
    let r;
    try { r = await ipcRenderer.invoke('hub-feedback:welink-copy-open', input); } catch (error) { r = { ok: false, reason: error.message }; }
    welinkBusy(false, 'wl-copy', '复制并打开 WeLink');
    lastText = (r && r.text) || '';
    if (!r || !r.copied) {
      message('bad', `复制没成功：${esc((r && r.reason) || '剪贴板被占用')}。${lastText ? '<a href="#" data-hf-copy>再复制一次</a>，' : ''}或打开下面的文件手动复制。${savedLine(r)}`);
      return;
    }
    const opened = r.opened ? '已打开 WeLink' : `WeLink 没能自动打开（${esc(r.openReason || '未知原因')}），请自己打开 WeLink`;
    message('ok', `已复制反馈内容，${opened}。在 WeLink 里搜 <b>${esc(r.to)}</b>，打开对话后粘贴（Ctrl+V）发送。${savedLine(r)}`);
  }

  async function send() {
    if (sending) return;
    const desc = dialog.querySelector('[data-hf="desc"]').value;
    if (!desc.trim()) { message('warn', '请先写一句遇到了什么问题'); dialog.querySelector('[data-hf="desc"]').focus(); return; }
    sending = true;
    const btn = dialog.querySelector('[data-hf="send"]');
    btn.disabled = true; btn.textContent = '正在发送…';
    message('info', via === 'intranet' ? '正在发给维护人（公司内网）…' : '正在发送，公司网络需要放行时会自动处理，最多约两分钟');
    const onProgress = (_e, p) => { if (p && p.phase === 'intranet') message('info', '正在发给维护人（公司内网）…'); else if (p && p.click)message('info', p.phase === 'unblocking' ? `公司网络要求放行，正在后台自动放行（第 ${p.click}/${p.maxClicks} 次）…` : p.phase === 'window' ? `改用后台窗口直接提交（第 ${p.click} 次）…` : `已点放行，正在重发（第 ${p.click}/${p.maxClicks} 轮）…`); };
    ipcRenderer.on('hub-feedback:progress', onProgress);
    let r;
    const full = require('./harness-view').appendDiagnosis(desc, await diagnosis());
    try { r = await ipcRenderer.invoke('hub-feedback:send', { description: full, contact: dialog.querySelector('[data-hf="contact"]').value }); }
    catch (error) { r = { ok: false, reason: error.message }; }
    finally { ipcRenderer.removeListener('hub-feedback:progress', onProgress); }
    sending = false;
    if (r && r.ok) {
      btn.textContent = '已发送';
      message('ok', `${r.via === 'intranet' ? '已发给维护人（公司内网）' : '已发送'}，反馈编号 <b>${esc(r.id)}</b>。维护人会根据附带的日志排查。`);
      dialog.querySelector('[data-hf="desc"]').value = '';
      return;
    }
    lastText = (r && r.text) || '';
    const copy = lastText ? ` <a href="#" data-hf-copy>复制内容</a>` : '';
    // 内网没送到（维护人电脑不在线等）：已进待发队列，后台自动补发；这条不算失败，不让用户反复点。
    if (r && r.queued) {
      btn.textContent = '已存好';
      const where = r.savedTo ? `<br>同样的内容也存到了：<span class="hf-path">${esc(r.savedTo)}</span> <a href="#" data-hf-open="${esc(r.savedTo)}">打开所在文件夹</a>` : '';
      void refreshOutbox();
      message('warn', `这次没送到维护人电脑，已存好，会自动补发（每 10 分钟试一次，最多保留 30 天）。${where}<br>着急的话可以${copy || '把上面的文件'}贴到 WeLink 发给维护人。<br><small>原因：${esc(r.reason || '未知')}</small>`);
      dialog.querySelector('[data-hf="desc"]').value = '';
      return;
    }
    btn.disabled = false; btn.textContent = '重新发送';
    const saved = r && r.savedTo ? `<br>同样的内容已存到：<span class="hf-path">${esc(r.savedTo)}</span> <a href="#" data-hf-open="${esc(r.savedTo)}">打开所在文件夹</a>${copy}，可以手动发给维护人。` : '';
    // 被公司网络放行页拦着（公开版不在后台自动点）：给按钮在 Hub 里打开放行页，点完回来点「重新发送」。
    const gate = r && r.blocked ? `<br>公司网络要求放行：<a href="#" data-hf-unblock="${esc(r.url || '')}">打开放行页</a>，在页面上点「接受风险并访问」（或左边那个放行按钮），再回来点「重新发送」。` : '';
    message('bad', `没发出去：${esc((r && r.reason) || '未知原因')}${gate}${saved}`);
  }

  // 我的反馈（2026-11-19 用户体验第 9 项）：自己提交过的反馈一屏看完——已送达（收件编号）/ 排队中（原因）/ 没发出去 / 已放弃，
  // 更新日志引用了这条的收件编号就标「已修于 vX」。按窗口高度分页，不出滚动条。
  let mineDialog = null, minePage = 1;
  const STATUS = { delivered: ['已送达', 'ok'], queued: ['排队中', 'warn'], failed: ['没发出去', 'bad'], expired: ['已放弃', 'bad'] };
  const mineCss = `
  #hub-feedback-mine{width:min(880px,calc(100vw - 48px));max-width:880px}
  #hub-feedback-mine .hfm-sum{color:var(--fg-muted,#6b7080);font-size:12px;margin-bottom:10px}
  #hub-feedback-mine .hfm-list{height:min(56vh,calc(100vh - 230px));overflow:hidden}
  #hub-feedback-mine .hfm-row{height:58px;box-sizing:border-box;padding:7px 2px;border-bottom:1px solid var(--border-subtle,#e3e7ee);overflow:hidden}
  #hub-feedback-mine .hfm-top{display:flex;gap:10px;align-items:center;font-size:13px;white-space:nowrap}
  #hub-feedback-mine .hfm-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
  #hub-feedback-mine .hfm-tag{flex:none;font-size:11px;padding:0 7px;border-radius:9px;line-height:18px;border:1px solid currentColor}
  #hub-feedback-mine .hfm-tag.ok{color:var(--success,#2f8a4c)} #hub-feedback-mine .hfm-tag.warn{color:var(--warning,#b66a12)} #hub-feedback-mine .hfm-tag.bad{color:var(--danger,#c0392b)}
  #hub-feedback-mine .hfm-tag.fix{color:var(--brand,#3478f6)}
  #hub-feedback-mine .hfm-sub{font-size:11px;color:var(--fg-muted,#6b7080);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #hub-feedback-mine .hfm-pages{display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:12px}`;
  function ensureMine() {
    if (mineDialog) return mineDialog;
    const style = document.createElement('style'); style.textContent = mineCss; document.head.appendChild(style);
    mineDialog = document.createElement('dialog');
    mineDialog.className = 'app-update-dialog'; mineDialog.id = 'hub-feedback-mine'; mineDialog.setAttribute('aria-label', '我的反馈');
    mineDialog.innerHTML = `
      <div class="au-head"><div class="au-title"><strong>我的反馈</strong><span>这台电脑上提交过的一键反馈，以及它们现在到哪儿了</span></div>
        <button type="button" class="au-close" data-hfm="close" title="关闭">✕</button></div>
      <div class="au-body"><div class="hfm-sum" data-hfm="sum">正在读取…</div><div class="hfm-list" data-hfm="list"></div>
        <div class="hfm-pages"><button type="button" class="au-btn" data-hfm="prev">上一页</button><span data-hfm="page"></span><button type="button" class="au-btn" data-hfm="next">下一页</button></div></div>
      <div class="au-foot"><button type="button" class="au-btn" data-hfm="retry" hidden>立即重试排队的</button><button type="button" class="au-btn" data-hfm="new">再提一条</button><button type="button" class="au-btn primary" data-hfm="done">关闭</button></div>`;
    document.body.appendChild(mineDialog);
    const m = name => mineDialog.querySelector(`[data-hfm="${name}"]`);
    m('close').addEventListener('click', () => mineDialog.close());
    m('done').addEventListener('click', () => mineDialog.close());
    m('new').addEventListener('click', () => { mineDialog.close(); void open(); });
    m('prev').addEventListener('click', () => void loadMine(minePage - 1));
    m('next').addEventListener('click', () => void loadMine(minePage + 1));
    m('retry').addEventListener('click', async () => {
      const b = m('retry'); b.disabled = true; b.textContent = '正在重试…';
      try { await ipcRenderer.invoke('hub-feedback:retry'); } catch { /* 结果看列表 */ }
      b.disabled = false; b.textContent = '立即重试排队的'; void refreshOutbox(); await loadMine(minePage);
    });
    return mineDialog;
  }
  async function loadMine(page = 1) {
    const m = name => mineDialog.querySelector(`[data-hfm="${name}"]`);
    const size = Math.max(1, Math.floor(m('list').clientHeight / 58) || 6);
    let r = null;
    try { r = await ipcRenderer.invoke('hub-feedback:mine', { page, pageSize: size }); } catch (error) { r = { ok: false, error: error.message }; }
    if (!r || !r.ok) { m('sum').textContent = '读取失败：' + ((r && r.error) || '未知原因'); return; }
    minePage = r.page;
    const c = r.counts || {};
    m('sum').textContent = r.total ? `共 ${r.total} 条 · 已送达 ${c.delivered || 0} · 排队中 ${c.queued || 0}${c.fixed ? ` · 已修 ${c.fixed}` : ''}` : '这台电脑上还没有提交过一键反馈';
    m('retry').hidden = !c.queued;
    m('list').innerHTML = r.items.map(x => {
      const [label, tone] = STATUS[x.status] || ['未知', 'warn'];
      const when = x.createdAt ? new Date(x.createdAt).toLocaleString() : '';
      const sub = x.status === 'delivered' && x.via === 'welink' ? `${when} · ${x.receiptId === 'WeLink' ? '已发到维护人 WeLink' : x.receiptId}`
        : x.status === 'delivered' ? `${when} · 收件编号 ${x.receiptId}${x.via === 'aliyun' ? '（阿里云）' : ''}` : `${when}${x.reason ? ' · ' + x.reason : ''}`;
      return `<div class="hfm-row"><div class="hfm-top"><span class="hfm-title">${esc(x.summary || '（没有描述）')}</span>`
        + `${x.fixedIn ? `<span class="hfm-tag fix">已修于 v${esc(x.fixedIn)}</span>` : ''}<span class="hfm-tag ${tone}">${label}</span></div>`
        + `<div class="hfm-sub" title="${esc(sub)}">${esc(sub)}</div></div>`;
    }).join('');
    m('page').textContent = `第 ${r.page} / ${Math.max(1, Math.ceil(r.total / r.pageSize))} 页`;
    m('prev').disabled = r.page <= 1; m('next').disabled = r.page * r.pageSize >= r.total;
  }
  async function openMine() { ensureMine(); if (!mineDialog.open) mineDialog.showModal(); await loadMine(1); }

  function addMenuEntry() {
    const menu = document.getElementById('options-menu');
    if (!menu || document.getElementById('options-feedback')) return;
    const item = document.createElement('div');
    item.className = 'options-item'; item.id = 'options-feedback'; item.textContent = '💬 一键反馈';
    item.addEventListener('click', () => { menu.style.display = 'none'; void open(); });
    const mineItem = document.createElement('div');
    mineItem.className = 'options-item'; mineItem.id = 'options-feedback-mine'; mineItem.textContent = '📋 我的反馈';
    mineItem.addEventListener('click', () => { menu.style.display = 'none'; void openMine(); });
    const update = document.getElementById('options-check-update');
    if (update) update.after(item, mineItem); else menu.append(item, mineItem);
  }

  // 待发队列看得见（2026-11-19 反馈黑洞复盘）：有没送到的反馈时，底栏显示「反馈待发 N」，点开反馈窗口能看到原因和「立即重试」。
  let outbox = null, marker = null, retrying = false;
  const when = ms => { const d = new Date(ms); return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  function paintOutbox(st, note = '') {
    outbox = st;
    const pending = st && st.ok && !(wl && wl.enabled) ? Number(st.pending) || 0 : 0;
    const footer = document.getElementById('hub-system-footer');
    if (pending && !marker && footer) {
      marker = document.createElement('button'); marker.type = 'button'; marker.id = 'hub-feedback-outbox-marker';
      marker.addEventListener('click', () => void open()); footer.append(marker);
    }
    if (marker) {
      if (!pending) { marker.remove(); marker = null; }
      else { marker.textContent = `反馈待发 ${pending}`; marker.title = `${pending} 条反馈还没送到维护人电脑，点开看原因、立即重试`; }
    }
    if (!dialog) return;
    const box = dialog.querySelector('[data-hf="outbox"]');
    if (!pending && !note) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = pending
      ? `<div class="au-msg warn hf-outbox">还有 <b>${pending}</b> 条反馈没送到维护人电脑${st.oldestQueuedAt ? `（最早一条 ${esc(when(st.oldestQueuedAt))} 存的）` : ''}，`
        + `每 ${Number(st.retryEveryMin) || 10} 分钟自动补发，最多保留 ${Number(st.maxAgeDays) || 30} 天。`
        + `${st.reason ? `<br>原因：${esc(st.reason)}` : ''}${note ? `<br>${esc(note)}` : ''}`
        + `<button type="button" class="au-btn" data-hf="retry"${retrying ? ' disabled' : ''}>${retrying ? '正在重试…' : '立即重试'}</button></div>`
      : `<div class="au-msg ok hf-outbox">${esc(note)}</div>`;
    const btn = box.querySelector('[data-hf="retry"]');
    if (btn) btn.addEventListener('click', () => void retryOutbox());
  }
  async function refreshOutbox() {
    try { paintOutbox(await ipcRenderer.invoke('hub-feedback:status')); } catch { /* 下一轮再读 */ }
  }
  async function retryOutbox() {
    if (retrying) return;
    retrying = true; paintOutbox(outbox);
    let r = null;
    try { r = await ipcRenderer.invoke('hub-feedback:retry'); } catch (error) { r = { ok: false, error: error.message }; }
    retrying = false;
    if (!r || !r.ok) return paintOutbox(outbox, `重试出错：${(r && r.error) || '未知原因'}`);
    const sent = Number(r.flushResult && r.flushResult.sent) || 0;
    paintOutbox(r, sent ? `已补发 ${sent} 条。` : (r.diag && r.diag.ok ? '维护人电脑连得上，但这一轮没有送出，稍后会再试。' : ''));
  }

  addMenuEntry();
  void ipcRenderer.invoke('hub-feedback:welink-state').then(st => { wl = st; paintOutbox(outbox); }).catch(() => {}).finally(() => void refreshOutbox());
  setInterval(() => void refreshOutbox(), 60 * 1000);
  window.__hubFeedback = { open, refreshOutbox, openMine };
})();
