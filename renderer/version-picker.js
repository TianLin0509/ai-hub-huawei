'use strict';
// 版本选择与回退（2026-11-16；R42 2026-11-25 恢复，只走公司内源）：设置菜单里的「版本与回退」页。默认跟随最新版；觉得新版不好时挑一个旧版回退。
// 一屏放下：上面是当前版本与「跟随最新版」开关，左边是公司内源上带签名清单、和本机运行时一致的版本（每页 7 个），
// 右边是选中版本的更新说明和「之后修了什么」。回退前确认，下载完整更新包后点「立即重启」换上；固定后右下角常驻「回到最新版」。
// 数据与动作在主进程 main/app-update-controller.js（listVersions / rollbackTo / returnToLatest / pinCurrent / restoreBackup）。
(() => {
  const distribution = require('../core/distribution');
  if (!distribution.updateConfig) return;
  const { ipcRenderer } = require('electron');
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const mb = n => `${(n / 1048576).toFixed(1)} MB`;
  const day = s => (String(s || '').match(/^\d{4}-\d{2}-\d{2}/) || [''])[0];
  const PAGE = 7;
  // 比当前版本新的条目（内源上已发、本机还没升）：不走回退，提示用「检查更新」。
  const { compareVersions } = require('../core/app-update/manifest');
  const newer = i => !!(i && current() && compareVersions(i.version, current()) > 0);
  let dialog = null, list = null, loading = false, selected = '', page = 0, confirmFor = '', busy = '', message = '', upd = null, retry = null;

  const CSS = `
  .vp-dialog{position:fixed;inset:0;margin:auto;width:min(1120px,92vw);height:min(640px,86vh);padding:0;border:1px solid var(--border-subtle,#d9dde3);border-radius:10px;background:var(--hw-surface,#fff);color:var(--fg-default,#1f2329);font-family:"Microsoft YaHei",sans-serif;overflow:hidden}
  .vp-dialog::backdrop{background:rgba(20,24,31,.35)}
  .vp-wrap{display:flex;flex-direction:column;height:100%}
  .vp-head{display:flex;align-items:center;gap:18px;padding:14px 20px;border-bottom:1px solid var(--border-subtle,#e5e7eb)}
  .vp-head h2{margin:0;font-size:17px}.vp-head small{color:var(--fg-muted,#6b7280)}
  .vp-cur{display:flex;flex-direction:column}.vp-cur b{font-size:15px}
  .vp-follow{display:flex;align-items:center;gap:8px;margin-left:auto;font-size:13px}
  .vp-close{border:0;background:none;font-size:18px;cursor:pointer;color:var(--fg-muted,#6b7280)}
  .vp-banner{margin:10px 20px 0;padding:8px 12px;border-radius:6px;font-size:13px;background:rgba(52,120,246,.08);color:var(--fg-default,#1f2329);display:flex;gap:10px;align-items:center}
  .vp-banner.warn{background:rgba(230,140,20,.12)}
  .vp-body{flex:1;display:grid;grid-template-columns:360px 1fr;min-height:0}
  .vp-list{border-right:1px solid var(--border-subtle,#e5e7eb);display:flex;flex-direction:column;padding:10px 12px;min-height:0}
  .vp-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:6px;cursor:pointer;font-size:13px;border:1px solid transparent}
  .vp-item:hover{background:rgba(52,120,246,.05)}.vp-item.sel{border-color:#3478f6;background:rgba(52,120,246,.08)}
  .vp-item b{font-size:14px;min-width:62px}.vp-item small{color:var(--fg-muted,#6b7280)}
  .vp-tag{font-size:11px;padding:1px 6px;border-radius:9px;background:rgba(52,120,246,.12);color:#3478f6}
  .vp-tag.cur{background:rgba(40,160,90,.14);color:#1f8a4c}
  .vp-pager{margin-top:auto;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--fg-muted,#6b7280);padding-top:8px}
  html[lang="en"] .vp-pager{gap:8px}html[lang="en"] .vp-pager>span:last-child{white-space:nowrap;flex:none}
  .vp-hidden{font-size:12px;color:var(--fg-muted,#6b7280);margin-top:6px;line-height:1.5}
  .vp-detail{padding:14px 20px;display:flex;flex-direction:column;min-height:0}
  .vp-detail h3{margin:0 0 6px;font-size:15px}.vp-detail h4{margin:12px 0 4px;font-size:13px;color:var(--fg-muted,#6b7280)}
  .vp-notes{margin:0;padding-left:18px;font-size:13px;line-height:1.6}
  .vp-scroll{overflow:auto;min-height:0;flex:1}
  .vp-foot{display:flex;gap:10px;align-items:center;padding:12px 20px;border-top:1px solid var(--border-subtle,#e5e7eb)}
  .vp-foot .vp-msg{font-size:13px;color:var(--fg-muted,#6b7280);margin-right:auto}
  .vp-btn{padding:6px 14px;border-radius:6px;border:1px solid var(--border-subtle,#d0d5dd);background:var(--hw-surface,#fff);color:inherit;cursor:pointer;font-size:13px}
  .vp-btn.primary{background:#3478f6;border-color:#3478f6;color:#fff}.vp-btn[disabled]{opacity:.5;cursor:default}
  .vp-empty{margin:auto;text-align:center;font-size:13px;color:var(--fg-muted,#6b7280);line-height:1.8}
  .vp-confirm{position:absolute;inset:0;background:rgba(20,24,31,.28);display:flex;align-items:center;justify-content:center}
  .vp-confirm>div{width:470px;background:var(--hw-surface,#fff);border-radius:10px;padding:18px 20px;box-shadow:0 8px 30px rgba(0,0,0,.18);font-size:13px;line-height:1.7}
  .vp-confirm h3{margin:0 0 8px;font-size:15px}.vp-confirm .vp-row{display:flex;gap:10px;justify-content:flex-end;margin-top:14px}
  .vp-dlp{flex:1;min-width:0;margin-right:auto}.vp-dlp .dlp{margin:0}
  #vp-pinned-chip{position:fixed;right:16px;bottom:14px;z-index:9000;display:flex;gap:8px;align-items:center;padding:6px 8px 6px 12px;border-radius:18px;background:var(--hw-surface,#fff);border:1px solid #3478f6;font:12px "Microsoft YaHei",sans-serif;color:var(--fg-default,#1f2329);box-shadow:0 2px 10px rgba(0,0,0,.08)}
  #vp-pinned-chip button{border:0;border-radius:12px;padding:3px 10px;background:#3478f6;color:#fff;cursor:pointer;font-size:12px}`;
  function ensureCss() { if (document.getElementById('vp-css')) return; const s = document.createElement('style'); s.id = 'vp-css'; s.textContent = CSS; document.head.appendChild(s); }

  const pinned = () => (upd && upd.pinned) || (list && list.pinned) || null;
  const current = () => (upd && upd.current) || (list && list.current) || '';
  const rollbackPhase = () => upd && upd.latest && upd.latest.rollback ? upd.phase : '';

  function itemsPage() { const items = (list && list.items) || []; return items.slice(page * PAGE, page * PAGE + PAGE); }
  function selItem() { return ((list && list.items) || []).find(i => i.version === selected) || null; }

  function listHtml() {
    if (loading && !list) return '<div class="vp-empty">正在从公司内源读取版本列表并校验签名…</div>';
    // 内源拿不到清单：一行说明原因和下一步（不改去外网），给「重试」。
    if (list && !list.ok) return `<div class="vp-empty" data-vp-error>${esc(list.error || '读不到版本列表')}<br><button class="vp-btn primary" data-vp="reload">重试</button></div>`;
    const items = (list && list.items) || [];
    if (!items.length) return `<div class="vp-empty">公司内源上暂时没有和本机运行时一致的旧版本${skippedHtml()}</div>`;
    const pages = Math.ceil(items.length / PAGE);
    return itemsPage().map(i => `<div class="vp-item${i.version === selected ? ' sel' : ''}" data-vp="pick" data-v="${esc(i.version)}"><b>v${esc(i.version)}</b><small>${esc(day(i.publishedAt))}</small>`
      + `${i.current ? '<span class="vp-tag cur">当前</span>' : ''}${i.latest ? '<span class="vp-tag">最新</span>' : ''}${pinned() && pinned().version === i.version && !i.current ? '<span class="vp-tag">待生效</span>' : ''}</div>`).join('')
      + `<div class="vp-pager"><span>共 ${items.length} 个版本，均与本机运行时一致</span>${pages > 1 ? `<span><button class="vp-btn" data-vp="prev" ${page ? '' : 'disabled'}>‹</button> ${page + 1}/${pages} <button class="vp-btn" data-vp="next" ${page < pages - 1 ? '' : 'disabled'}>›</button></span>` : ''}</div>`
      + (list.hidden && list.hidden.length ? `<div class="vp-hidden">另有 ${list.hidden.length} 个版本运行时不同，不能直接回退（${esc(list.hidden.map(h => 'v' + h.version).join('、'))}）</div>` : '')
      + skippedHtml();
  }
  // 内源上有、但没有通过签名校验或缺包的版本：不列出，一行说明（最多点名 3 个）。
  function skippedHtml() {
    const sk = (list && list.skipped) || [];
    const parts = [];
    if (sk.length) parts.push(`另有 ${sk.length} 个版本没有可用的签名清单，不能回退（${esc(sk.slice(0, 3).map(x => `v${x.version}：${x.why}`).join('；'))}${sk.length > 3 ? '…' : ''}）`);
    if (list && list.partial) parts.push('更早的版本这次没读完，点「重试」再读');
    return parts.length ? `<div class="vp-hidden" data-vp-skipped>${parts.join('；')}</div>` : '';
  }

  function detailHtml() {
    const i = selItem();
    if (!i) return '<div class="vp-empty">在左边选一个版本，查看它的更新说明</div>';
    const later = i.laterFixes || [];
    const laterHtml = later.length ? later.slice(0, 6).map(x => `<div><b>v${esc(x.version)}</b><ul class="vp-notes">${(x.notes || []).slice(0, 4).map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>`).join('')
      + (later.length > 6 ? `<p class="vp-hidden">还有 ${later.length - 6} 个更新的版本未列出</p>` : '') : '<p class="vp-hidden">这是最新版，之后还没有新版本。</p>';
    return `<h3>v${esc(i.version)}<small style="font-weight:normal;color:var(--fg-muted,#6b7280)"> · ${esc(day(i.publishedAt))} · 完整更新包 ${mb(i.bytes)}</small></h3>`
      + `<div class="vp-scroll"><h4>这一版的更新说明</h4><ul class="vp-notes">${(i.notes || []).slice(0, 8).map(n => `<li>${esc(n)}</li>`).join('') || '<li>没有记录</li>'}</ul>`
      + `<h4>回退到这一版后，会失去之后这些改动</h4>${laterHtml}</div>`;
  }

  function footHtml() {
    const i = selItem(), phase = rollbackPhase();
    // r59：统一进度条（进度、速度、剩余时间、来源）。
    const bar = title => `<div class="vp-dlp">${require('./download-progress-view').html({ ...(upd.progress || {}), phase: upd.progress && upd.progress.total ? 'downloading' : 'connecting' }, { title })}</div>`;
    if (phase === 'downloading') return bar(`下载 v${upd.latest.version} 的完整更新包`) + '<button class="vp-btn" data-vp="cancel">取消</button>';
    if (phase === 'ready') return `<span class="vp-msg">v${esc(upd.latest.version)} 已下载并校验好，重启后生效；设置和数据库已做一致备份</span><button class="vp-btn" data-vp="latest" ${busy ? 'disabled' : ''}>取消回退</button><button class="vp-btn primary" data-vp="apply" ${busy ? 'disabled' : ''}>立即重启回退</button>`;
    if (phase === 'applying') return '<span class="vp-msg">正在重启并换上旧版…</span>';
    if (upd && upd.phase === 'ready' && !pinned()) return `<span class="vp-msg">最新版 v${esc(upd.latest?.version)} 已下载好</span><button class="vp-btn primary" data-vp="apply">${upd.plan && upd.plan.kind === 'full' ? '立即安装最新版' : '立即重启到最新版'}</button>`;
    if (upd && upd.phase === 'downloading' && !pinned()) return bar(`下载最新版${upd.latest && upd.latest.version ? ' v' + upd.latest.version : ''}`);
    const canRoll = i && !i.current && !newer(i) && !busy;
    return `<span class="vp-msg">${esc(message || (upd && upd.phase === 'error' && upd.error) || '')}</span>`
      + (retry && message ? `<button class="vp-btn" data-vp="retry" ${busy ? 'disabled' : ''}>重试</button>` : '')
      + (pinned() ? `<button class="vp-btn" data-vp="latest" ${busy ? 'disabled' : ''}>回到最新版</button>` : '')
      + `<button class="vp-btn primary" data-vp="ask" ${canRoll ? '' : 'disabled'}>${i && i.current ? '这就是当前版本' : newer(i) ? '比当前新，请用「检查更新」升级' : i ? `回退到 v${esc(i.version)}` : '回退到此版本'}</button>`;
  }

  function bannerHtml() {
    if (upd && upd.rollbackFailed) return `<div class="vp-banner warn">上次回退到 v${esc(upd.rollbackFailed.version)} 没有换上，程序已保持原版本；可以重试，或用下方备份还原设置。</div>` + backupRow();
    const p = pinned();
    if (p && p.version === current()) return `<div class="vp-banner">已固定在 v${esc(p.version)}：自动更新和更新提醒已暂停。想恢复时点「回到最新版」。</div>` + backupRow();
    return backupRow();
  }
  // 备份与还原入口不依赖固定状态（审查 P2-6）：只要有备份就显示最近一份；还原前会自动把当前文件存成恢复点。
  function backupRow() {
    const rr = upd && upd.restoreResult;
    const res = rr ? `<span>${rr.ok ? `上次还原成功（${rr.restored} 个文件），还原前的样子已存为恢复点` : `上次还原没有完成：${esc(rr.reason)}`}</span>` : '';
    const b = list && list.backups && list.backups[0];
    if (!b && !res) return '';
    const kind = b && b.kind === 'restore-point' ? '还原前恢复点' : '回退前备份';
    return `<div class="vp-banner">${res}${b ? `<span style="margin-left:auto">${kind}：${esc(b.name.slice(-15))}（${b.files} 个文件${b.skipped ? `，${b.skipped} 个大文件未备份` : ''}）${list.backups.length > 1 ? ` · 共 ${list.backups.length} 份` : ''}</span><button class="vp-btn" data-vp="restore" data-dir="${esc(b.dir)}">还原这份</button>` : ''}</div>`;
  }

  function confirmHtml() {
    if (!confirmFor) return '';
    const i = ((list && list.items) || []).find(x => x.version === confirmFor);
    if (!i) return '';
    return `<div class="vp-confirm"><div><h3>回退到 v${esc(i.version)}？</h3>
      <div>· 先把设置和本地数据库等小文件备份到数据目录 backups/ 下，出问题可一键还原。</div>
      <div>· 下载 v${esc(i.version)} 的完整更新包（${mb(i.bytes)}），只换程序文件，会话和数据保留。</div>
      ${require('./download-source-view').slotHtml('app-version:' + i.version, 'div')}
      <div>· 只从公司内源下载，按这一版签名清单里的大小和 SHA-256 核对，核对不过不安装。</div>
      ${i.supportsPin ? '<div>· 回退后固定在这一版：不再自动更新、不再提醒；随时可以「回到最新版」。</div>'
        : '<div>· 这一版不认识「固定版本」：打开后会照常在后台自动更新回最新版。只想临时用一下可以选它；想长期留在旧版，请选别的版本。</div>'}
      <div>· 会失去之后 ${(i.laterFixes || []).length} 个版本的改动。</div>
      <div class="vp-row"><button class="vp-btn" data-vp="no">取消</button><button class="vp-btn primary" data-vp="yes">备份并下载</button></div></div></div>`;
  }

  function render() {
    renderChip();
    if (!dialog) return;
    const follow = !pinned();
    dialog.innerHTML = `<div class="vp-wrap"><div class="vp-head"><h2>版本</h2><div class="vp-cur"><small>当前版本</small><b>v${esc(current())}</b></div>`
      + (list && list.latest ? `<div class="vp-cur"><small>内源最新</small><b>v${esc(list.latest)}</b></div>` : '')
      + `<label class="vp-follow"><input type="checkbox" data-vp="follow" ${follow ? 'checked' : ''} ${busy || rollbackPhase() ? 'disabled' : ''}> 跟随最新版（默认）</label>`
      + `<button class="vp-close" data-vp="close" aria-label="关闭">✕</button></div>${bannerHtml()}`
      + `<div class="vp-body"><div class="vp-list">${listHtml()}</div><div class="vp-detail">${detailHtml()}</div></div><div class="vp-foot">${footHtml()}</div>${confirmHtml()}</div>`;
    if (dialog.querySelector('[data-dl-source]')) void require('./download-source-view').fill(dialog).catch(() => {});
  }

  function renderChip() {
    const p = pinned();
    let chip = document.getElementById('vp-pinned-chip');
    if (!p || p.version !== current()) { if (chip) chip.remove(); return; }
    ensureCss();
    if (!chip) { chip = document.createElement('div'); chip.id = 'vp-pinned-chip'; document.body.appendChild(chip); chip.addEventListener('click', onClick); }
    chip.innerHTML = `<span>已固定在 v${esc(p.version)}</span><button data-vp="latest">回到最新版</button>`;
  }

  async function load() {
    loading = true; render();
    try { list = await ipcRenderer.invoke('app-update:list-versions'); }
    catch (error) { list = { ok: false, error: `读不到版本列表：${error.message}` }; }
    loading = false;
    if (list && list.ok && !selected) { const first = list.items.find(i => !i.current && !newer(i)) || list.items.find(i => i.current) || list.items[0]; selected = first ? first.version : ''; }
    render();
  }

  async function act(name, fn) {
    busy = name; message = ''; retry = null; render();
    try { await fn(); } catch (error) {
      message = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      // 另一个 Hub 占着同一份数据：就地给「重试」，关掉那个窗口后点一下即可。
      if (/另一个 Hub 窗口/.test(message)) retry = { name, fn };
    }
    busy = ''; render();
  }

  async function onClick(event) {
    const el = event.target.closest('[data-vp]');
    if (!el) return;
    const a = el.dataset.vp;
    if (a === 'close') return dialog && dialog.close();
    if (a === 'reload') return load();
    if (a === 'retry') { const r = retry; return r && act(r.name, r.fn); }
    if (a === 'pick') { selected = el.dataset.v; return render(); }
    if (a === 'prev') { page = Math.max(0, page - 1); return render(); }
    if (a === 'next') { page += 1; return render(); }
    if (a === 'ask') { confirmFor = selected; return render(); }
    if (a === 'no') { confirmFor = ''; return render(); }
    if (a === 'yes') { const v = confirmFor; confirmFor = ''; return act('rollback', async () => { upd = await ipcRenderer.invoke('app-update:rollback', v); await load(); }); }
    if (a === 'cancel') return ipcRenderer.invoke('app-update:cancel');
    if (a === 'apply') return act('apply', async () => { upd = await ipcRenderer.invoke('app-update:apply', { mode: 'auto' }); });
    if (a === 'latest') { if (!dialog) open(); return act('latest', async () => { upd = await ipcRenderer.invoke('app-update:return-latest'); await load(); }); }
    if (a === 'restore') return act('restore', async () => { await ipcRenderer.invoke('app-update:restore-backup', el.dataset.dir); message = '已登记还原，Hub 正在重启…'; });
    if (a === 'follow') {
      return act('follow', async () => { upd = el.checked ? await ipcRenderer.invoke('app-update:return-latest') : await ipcRenderer.invoke('app-update:pin-current'); await load(); });
    }
  }

  function open() {
    ensureCss();
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'vp-dialog';
      dialog.addEventListener('click', onClick);
      dialog.addEventListener('change', event => { if (event.target.dataset.vp === 'follow') onClick(event); });
      dialog.addEventListener('close', () => { dialog.remove(); dialog = null; confirmFor = ''; });
      document.body.appendChild(dialog);
    }
    render();
    if (!dialog.open) dialog.showModal();
    void load();
  }

  function addMenuEntry() {
    const menu = document.getElementById('options-menu');
    if (!menu || document.getElementById('options-versions')) return;
    const item = document.createElement('div');
    item.className = 'options-item'; item.id = 'options-versions'; item.textContent = '🕘 版本与回退';
    item.addEventListener('click', () => { menu.style.display = 'none'; open(); });
    const anchor = document.getElementById('options-check-update');
    if (anchor && anchor.nextSibling) menu.insertBefore(item, anchor.nextSibling); else menu.appendChild(item);
  }

  ipcRenderer.on('app-update:state', (_e, next) => { upd = next; if (dialog && !busy) render(); else renderChip(); });
  ipcRenderer.invoke('app-update:get-state').then(s => { upd = s; renderChip(); }).catch(() => {});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addMenuEntry); else addMenuEntry();
  setTimeout(addMenuEntry, 1500);
  window.hubVersionPicker = { open };
})();
