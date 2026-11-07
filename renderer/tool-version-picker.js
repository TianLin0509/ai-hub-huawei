'use strict';
// 外部工具版本选择器（2026-11-07，5.5.24）：welink-cli、PPT Doctor、CodeAgent 三处共用。
// 找到多个不同版本时，各页面放一行不打扰的提示「找到 N 个版本，当前用 vX，点此切换」（hintHtml），
// 点开是这个选择器：列出版本号、路径、来源，最新的标「推荐·最新」，选完经 tool-discovery:use 写回设置。
// 页面只需要把 hintHtml / switchHtml 的结果插进去：带 data-tvp-open 的按钮由这里统一接管点击；
// 选完会在 document 上派发 tool-version-changed 事件（detail: { tool, summary }），页面据此刷新。
const LABEL = { welink: 'welink-cli', 'ppt-doctor': 'PPT Doctor', codeagent: 'CodeAgent' };
const VIA = { path: '系统路径', npm: 'npm 全局目录', install: '安装目录', manual: '手动指定', env: '环境变量', disk: '硬盘搜索' };
const instances = new WeakMap();

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const versionText = v => (v ? 'v' + String(v).replace(/^v/i, '') : '版本未知');
const labelOf = summary => LABEL[summary?.tool] || summary?.label || '工具';

// 多个不同版本、用户还没选过：一行提示（默认已在用最新版，不选也能用）。
function hintHtml(summary, { className = '' } = {}) {
  if (!summary?.needsPick || !summary.current) return '';
  return `<div class="tvp-hint${className ? ' ' + esc(className) : ''}" role="status" data-tvp-hint="${esc(summary.tool)}"><span class="tvp-hint-dot" aria-hidden="true"></span><span class="tvp-hint-text">找到 ${summary.candidates.length} 个版本的 ${esc(labelOf(summary))}，当前用 ${esc(versionText(summary.current.version))}（最新）。</span><button type="button" class="tvp-link" data-tvp-open="${esc(summary.tool)}">点此切换</button></div>`;
}
// 已经选过、但本机有多份：在显示路径的地方放一个小「切换版本」入口。
function switchHtml(summary, { className = '' } = {}) {
  if (!summary?.candidates || summary.candidates.length < 2 || summary.needsPick) return '';
  return `<button type="button" class="tvp-link${className ? ' ' + esc(className) : ''}" data-tvp-open="${esc(summary.tool)}">切换版本（${summary.candidates.length} 个）</button>`;
}

function ensureStyle(document) {
  if (document.getElementById('tool-version-picker-style')) return;
  const link = Object.assign(document.createElement('link'), { id: 'tool-version-picker-style', rel: 'stylesheet', href: 'styles/tool-version-picker.css' });
  document.head.append(link);
}

function optionsHtml(summary, selected) {
  return summary.candidates.map((c, i) => {
    const tags = (c.recommended ? '<span class="tvp-tag tvp-tag-rec">推荐·最新</span>' : '') + (c.current ? '<span class="tvp-tag">当前在用</span>' : '');
    return `<label class="tvp-option${c.path === selected ? ' is-selected' : ''}"><input type="radio" name="tvp-choice" value="${i}"${c.path === selected ? ' checked' : ''}><span class="tvp-option-body"><span class="tvp-option-top"><b class="tvp-version">${esc(versionText(c.version))}</b>${tags}</span><span class="tvp-path" title="${esc(c.path)}">${esc(c.path)}</span>${VIA[c.via] ? `<span class="tvp-via">来自${esc(VIA[c.via])}</span>` : ''}</span></label>`;
  }).join('');
}

function createToolVersionPicker({ document, ipcRenderer }) {
  if (instances.has(document)) return instances.get(document);
  ensureStyle(document);
  let dialog = null;
  async function list(tool, force) {
    const r = await ipcRenderer.invoke('tool-discovery:list', { tool, force });
    if (!r || r.ok === false) throw new Error(r?.error || '没能列出版本');
    return r;
  }
  function close() { if (dialog?.open) dialog.close(); }
  async function open(tool) {
    ensureStyle(document);
    if (dialog?.isConnected) dialog.remove();
    const name = LABEL[tool] || tool;
    dialog = document.createElement('dialog');
    dialog.className = 'tvp-dialog'; dialog.dataset.tool = tool;
    dialog.setAttribute('aria-label', `选择 ${name} 版本`);
    dialog.innerHTML = `<header><div><h2>选择 ${esc(name)} 版本</h2><p class="tvp-sub">正在读取本机找到的版本…</p></div><button type="button" class="tvp-close" aria-label="关闭">×</button></header><div class="tvp-list" role="radiogroup" aria-label="${esc(name)} 版本"></div><p class="tvp-message" role="status"></p><footer><button type="button" class="tvp-btn tvp-ghost" data-tvp="rescan">重新扫描</button><span class="tvp-grow"></span><button type="button" class="tvp-btn" data-tvp="cancel">取消</button><button type="button" class="tvp-btn tvp-primary" data-tvp="use" disabled>使用所选</button></footer>`;
    document.body.append(dialog);
    dialog.showModal();
    const target = dialog;
    let summary = null, selected = '';
    const message = text => { target.querySelector('.tvp-message').textContent = text || ''; };
    const draw = () => {
      const n = summary.candidates.length;
      target.querySelector('.tvp-sub').textContent = n
        ? `这台电脑上找到 ${n} 份 ${name}。默认用最新的版本；选好后会记住，以后不再提示。`
        : `没有找到可用的 ${name}。装好后点「重新扫描」。`;
      target.querySelector('.tvp-list').innerHTML = optionsHtml(summary, selected);
      target.querySelector('[data-tvp="use"]').disabled = !selected;
    };
    const load = async force => {
      target.querySelector('[data-tvp="rescan"]').disabled = true;
      if (force) message('正在重新扫描并读取各版本号…');
      try {
        summary = await list(tool, force);
        if (!target.isConnected) return;
        if (!summary.candidates.some(c => c.path === selected)) selected = summary.current?.path || summary.candidates[0]?.path || '';
        draw(); message(force ? '扫描完成' : '');
      } catch (error) { if (target.isConnected) message('读取失败：' + error.message); }
      finally { target.querySelector('[data-tvp="rescan"]')?.removeAttribute('disabled'); }
    };
    target.querySelector('.tvp-close').onclick = close;
    target.querySelector('[data-tvp="cancel"]').onclick = close;
    target.querySelector('[data-tvp="rescan"]').onclick = () => void load(true);
    target.querySelector('.tvp-list').addEventListener('change', event => {
      const c = summary?.candidates?.[Number(event.target.value)];
      if (!c) return;
      selected = c.path;
      for (const row of target.querySelectorAll('.tvp-option')) row.classList.toggle('is-selected', row.querySelector('input').checked);
      target.querySelector('[data-tvp="use"]').disabled = false;
    });
    target.querySelector('[data-tvp="use"]').onclick = async event => {
      const button = event.currentTarget; button.disabled = true;
      const chosen = summary.candidates.find(c => c.path === selected);
      message('正在切换…');
      try {
        const r = await ipcRenderer.invoke('tool-discovery:use', { tool, path: selected });
        if (!r || r.ok === false) throw new Error(r?.error || '没能切换');
        document.dispatchEvent(new CustomEvent('tool-version-changed', { detail: { tool, summary: r } }));
        message(`已切换到 ${versionText(chosen?.version)}`);
        setTimeout(close, 600);
      } catch (error) { message('切换失败：' + error.message); button.disabled = false; }
    };
    target.addEventListener('close', () => { target.remove(); if (dialog === target) dialog = null; }, { once: true });
    await load(false);
    return target;
  }
  // 各页面插入的「点此切换」按钮统一在这里接管（捕获阶段，页面自己的委托不用认它）。
  document.addEventListener('click', event => {
    const button = event.target?.closest?.('[data-tvp-open]');
    if (!button) return;
    event.preventDefault(); event.stopPropagation();
    void open(button.dataset.tvpOpen);
  }, true);
  const api = { open, close, list, hintHtml, switchHtml };
  instances.set(document, api);
  return api;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try {
    const { ipcRenderer } = require('electron');
    window.HubToolPicker = createToolVersionPicker({ document, ipcRenderer });
  } catch { /* 不在 Hub 页面里（单元测试）时不自动挂 */ }
}

module.exports = { createToolVersionPicker, hintHtml, switchHtml, versionText, LABEL };
