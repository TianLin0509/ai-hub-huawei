'use strict';

const CREDIT_ROWS = [['今日忙时', 'busyDay'], ['今日闲时', 'idleDay'], ['本月', 'monthly']];
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const valueText = value => value == null || value === '' ? '未读取' : String(value);
function readingTime(at) {
  return Number.isFinite(at) ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '未读取';
}
function sourceText(source) {
  return source === 'serve' ? 'CodeAgent serve 接口' : source === 'screen' || source === 'probe' || source?.startsWith('picker:') ? 'CodeAgent /model 菜单' : '';
}
function tokenReadText(entry) {
  if (entry?.modelsRead?.status === 'unrecognized') return entry.modelsRead.diagnostic
    ? '未识别到 Token，已记录诊断' : '未识别到 Token';
  return '未读取';
}
function quotaText(quota) {
  return quota ? `${valueText(quota.used)} / ${valueText(quota.total)}` : '未读取';
}

function usageDetailsHtml(entry, { escapeHtml = esc } = {}) {
  const credit = entry?.credit;
  const models = Array.isArray(entry?.models) ? entry.models : [];
  const tokens = models.some(model => model.day);
  const caption = (at, source) => Number.isFinite(at) ? `<p class="ca-usage-meta"${sourceText(source) ? ` title="${escapeHtml(sourceText(source))}"` : ''}>更新于 ${escapeHtml(readingTime(at))}</p>` : '';
  return '<section><h3>Credit</h3>'
    + caption(credit ? entry.creditAt ?? entry.at : undefined, credit ? entry.creditSource ?? entry.source : undefined)
    + '<table><thead><tr><th>周期</th><th>用量</th></tr></thead><tbody>'
    + CREDIT_ROWS.map(([label, key]) => `<tr><th scope="row">${label}</th><td>${escapeHtml(quotaText(credit?.[key]))}</td></tr>`).join('')
    + '</tbody></table></section><section><h3>Token</h3>'
    + (credit?.idleDiscountActive ? `<p>${escapeHtml(`闲时${credit.idleDiscount}进行中`)}</p>` : '')
    + caption(tokens ? entry.modelsAt ?? entry.at : undefined, tokens ? entry.modelsSource ?? entry.source : undefined)
    + '<div class="ca-usage-table"><table><thead><tr><th>模型</th><th>今日</th><th>本小时</th><th>系数</th><th>负载</th></tr></thead><tbody>'
    + (tokens ? models.map(model => `<tr><th scope="row">${escapeHtml(model.name)}</th>`
      + `<td>${escapeHtml(quotaText(model.day))}</td><td>${escapeHtml(quotaText(model.hour))}</td>`
      + `<td>${escapeHtml(valueText(model.factor))}</td><td>${escapeHtml(valueText(model.load))}</td></tr>`).join('')
      : '<tr><td colspan="5">未读取</td></tr>')
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
    const stats = !entry && selected.stats;
    body.title = stats ? `上次 Stats 面板读数：${stats.bucket}剩余 ${stats.remaining}${stats.total ? ` / ${stats.total}` : ''} · ${readingTime(stats.at)}` : '';
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
    body = document.createElement('div');
    status = document.createElement('p');
    status.setAttribute('role', 'status');
    dialog.append(header, account, body, status);
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
    status.textContent = '刷新中…';
    let result;
    try {
      if (!ipcRenderer?.invoke) throw new Error('刷新接口不可用');
      result = await ipcRenderer.invoke('codeagent:usage-refresh', { key: selected.key, label: selected.label });
      if (requestGeneration !== generation) return result;
      if (result?.key) selected.key = result.key;
      if (result?.entry) entry = result.entry;
      status.textContent = result?.outcome === 'skipped' || result?.cached
        ? '10 分钟内已刷新'
        : result?.entry?.modelsRead?.status === 'unrecognized'
          ? tokenReadText(entry)
          : result?.ok
        ? ''
        : `刷新失败：${result?.error || '未知错误'}`;
    } catch (error) {
      if (requestGeneration !== generation) return;
      status.textContent = `刷新失败：${error.message}`;
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
