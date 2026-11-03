'use strict';

const CREDIT_ROWS = [['今日忙时', 'busyDay'], ['今日闲时', 'idleDay'], ['本月', 'monthly']];
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const valueText = value => value == null || value === '' ? '未读取' : String(value);
function readingTime(at) {
  return Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '未读取';
}
function sourceText(source) {
  return source === 'serve' ? 'CodeAgent serve 接口' : source === 'screen' || source === 'probe' || source?.startsWith('picker:') ? 'CodeAgent /model 菜单' : '来源未记录';
}
function tokenReadText(entry) {
  if (entry?.modelsRead?.status === 'unrecognized') return entry.modelsRead.diagnostic
    ? '菜单格式未能识别，已记录诊断，可一键反馈' : '菜单格式未能识别，诊断未能保存';
  return '尚未读取到模型 Token 用量';
}
function quotaText(quota) {
  return quota ? `${valueText(quota.used)} / ${valueText(quota.total)}` : '未读取';
}

function usageDetailsHtml(entry, { escapeHtml = esc } = {}) {
  const credit = entry?.credit;
  const models = Array.isArray(entry?.models) ? entry.models : [];
  const tokens = models.some(model => model.day);
  const caption = (at, source) => `<p class="ca-usage-meta">读取时间：${escapeHtml(readingTime(at))} · 来源：${escapeHtml(sourceText(source))}</p>`;
  return '<section><h3>Credit · 计费额度</h3>'
    + caption(credit ? entry.creditAt ?? entry.at : undefined, credit ? entry.creditSource ?? entry.source : undefined)
    + '<table><thead><tr><th>周期</th><th>已用 / 上限</th></tr></thead><tbody>'
    + CREDIT_ROWS.map(([label, key]) => `<tr><th scope="row">${label}</th><td>${escapeHtml(quotaText(credit?.[key]))}</td></tr>`).join('')
    + '</tbody></table></section><section><h3>Token · 模型用量</h3>'
    + (credit?.idleDiscountActive ? `<p>${escapeHtml(`闲时${credit.idleDiscount}进行中`)}</p>` : '')
    + caption(tokens ? entry.modelsAt ?? entry.at : undefined, tokens ? entry.modelsSource ?? entry.source : undefined)
    + (models.length && entry?.modelsRead?.status === 'unrecognized' ? `<p>${escapeHtml(tokenReadText(entry))}</p>` : '')
    + '<div class="ca-usage-table"><table><thead><tr><th>模型</th><th>今日（已用 / 上限）</th><th>本小时（已用 / 上限）</th><th>系数</th><th>负载</th></tr></thead><tbody>'
    + (models.length ? models.map(model => `<tr><th scope="row">${escapeHtml(model.name)}</th>`
      + `<td>${escapeHtml(quotaText(model.day))}</td><td>${escapeHtml(quotaText(model.hour))}</td>`
      + `<td>${escapeHtml(valueText(model.factor))}</td><td>${escapeHtml(valueText(model.load))}</td></tr>`).join('')
      : `<tr><td colspan="5">${escapeHtml(tokenReadText(entry))}</td></tr>`)
    + '</tbody></table></div></section>';
}

const CSS = `
.ca-usage-dialog, .ca-usage-dialog * { -webkit-app-region: no-drag; }
.ca-usage-dialog { width:min(820px,calc(100vw - 40px)); max-height:calc(100vh - 40px); padding:20px; border:1px solid var(--border-subtle); border-radius:12px; background:var(--surface-raised); color:var(--fg-default); font:inherit; overflow:auto; }
.ca-usage-dialog::backdrop { background:rgba(0,0,0,.35); }
.ca-usage-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.ca-usage-head h2 { margin:0; font-size:18px; }
.ca-usage-dialog h3 { margin:20px 0 6px; font-size:14px; }
.ca-usage-dialog p { font-size:12px; line-height:1.6; }
.ca-usage-meta { color:var(--fg-muted); }
.ca-usage-table { overflow-x:auto; }
.ca-usage-dialog table { width:100%; border-collapse:collapse; font-size:12px; }
.ca-usage-dialog th,.ca-usage-dialog td { padding:9px 8px; border-bottom:1px solid var(--border-subtle); text-align:left; }
.ca-usage-dialog th { font-weight:500; }
.ca-usage-dialog td { white-space:nowrap; font-variant-numeric:tabular-nums; }
.ca-usage-dialog button { font:inherit; color:inherit; background:var(--surface-sunken); border:1px solid var(--border-subtle); border-radius:6px; padding:5px 10px; cursor:pointer; }
`;

function createCodeAgentUsagePanel({ document, ipcRenderer, usageFor = () => null, now = Date.now, escapeHtml = esc }) {
  let dialog, body, status, account, entry, selected, generation = 0;
  function paint() {
    account.textContent = selected.label || entry?.label || 'CodeAgent';
    body.innerHTML = usageDetailsHtml(entry, { escapeHtml });
    if (!entry && selected.stats) {
      const stats = selected.stats;
      const note = document.createElement('p');
      note.className = 'ca-usage-meta';
      note.textContent = `上次 Stats 面板读数：${stats.bucket}剩余 ${stats.remaining}${stats.total ? ` / ${stats.total}` : ''} · ${readingTime(stats.at)}`;
      body.appendChild(note);
    }
  }
  function ensureUi() {
    if (dialog) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    dialog = document.createElement('dialog');
    dialog.className = 'ca-usage-dialog';
    dialog.setAttribute('aria-label', '模型用量');
    const header = document.createElement('div');
    header.className = 'ca-usage-head';
    const title = document.createElement('h2');
    title.textContent = '模型用量';
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = '关闭';
    close.addEventListener('click', () => dialog.close());
    header.append(title, close);
    account = document.createElement('p');
    const explanation = document.createElement('p');
    explanation.textContent = 'Credit 是计费额度，系数 0x 的模型不扣 Credit 但仍计 Token。三档 Credit 分别显示，不相加。';
    body = document.createElement('div');
    status = document.createElement('p');
    status.setAttribute('role', 'status');
    dialog.append(header, account, explanation, body, status);
    dialog.addEventListener('click', event => { if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    } });
    document.body.appendChild(dialog);
  }
  async function open(selection) {
    ensureUi();
    selected = { ...selection };
    entry = usageFor(selected.key);
    const requestGeneration = ++generation;
    paint();
    if (!dialog.open) dialog.showModal();
    status.textContent = '正在刷新模型用量；同一账号最多每 10 分钟刷新一次…';
    let result;
    try {
      if (!ipcRenderer?.invoke) throw new Error('刷新接口不可用');
      result = await ipcRenderer.invoke('codeagent:usage-refresh', { key: selected.key, label: selected.label });
      if (requestGeneration !== generation) return result;
      if (result?.key) selected.key = result.key;
      if (result?.entry) entry = result.entry;
      const next = result?.nextRefreshAt > now() ? `下次可刷新：${readingTime(result.nextRefreshAt)}。` : '';
      status.textContent = result?.outcome === 'skipped'
        ? `本次跳过：${result.reason || '10 分钟冷却'}。${entry?.modelsRead?.status === 'unrecognized' ? tokenReadText(entry) + '。' : entry ? '显示上次读数。' : '尚无用量快照。'}${next}`
        : result?.entry?.modelsRead?.status === 'unrecognized'
          ? `${tokenReadText(entry)}。${entry?.models?.length ? '保留上次 Token 读数及读取时间。' : ''}${next}`
          : result?.ok
        ? `${result.cached ? `十分钟内不重复刷新，${entry ? '显示上次读数' : '尚无用量快照'}。` : '已读取最新可用数据。'}${next}`
        : `刷新失败：${result?.error || '未知错误'}。${entry ? '保留上次读数及读取时间。' : '尚无用量快照。'}${next}`;
    } catch (error) {
      if (requestGeneration !== generation) return;
      status.textContent = `刷新失败：${error.message}。${entry ? '保留上次读数及读取时间。' : '尚无用量快照。'}`;
    }
    paint();
    return result;
  }
  function update() {
    if (!dialog?.open || !selected) return;
    const latest = usageFor(selected.key);
    if (latest) entry = latest;
    paint();
  }
  return { open, update };
}

module.exports = { createCodeAgentUsagePanel, usageDetailsHtml };
