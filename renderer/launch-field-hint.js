'use strict';

// 启动中心字段说明（2026-11-22：说明提示做成 hover 时的提醒，不遮挡主选项，不喧宾夺主）。
// 规则只有一条：
//   info（纯说明）→ 收进字段标签后面的 ⓘ 小图标，悬停或键盘聚焦时由全局悬停卡（hub-tooltip.js）显示，
//                   优先显示在图标上方（data-tip-side="top"），不挡下面的下拉框；原说明行隐藏。
//   status / warn / error（正在切换、需登录、风控、不可用等要用户留意或处理的）→ 原位置一行紧凑文字。
// 文字始终写进原来的说明元素（textContent 不变，aria-describedby 照旧指向它），只是 info 时它不占版面。

const ICON_CLASS = 'field-hint-icon';

// 字段标签：<label class="session-tuning-field"><span>运行方式</span>…</label> 里的第一个 span。
function fieldLabel(field) {
  try { return field?.querySelector?.(':scope > span') || null; } catch { return null; }
}

function existingIcon(host) {
  try { return host?.querySelector?.(':scope > .' + ICON_CLASS) || null; } catch { return null; }
}

function ensureIcon(host) {
  let icon = existingIcon(host);
  if (icon || !host?.ownerDocument) return icon;
  icon = host.ownerDocument.createElement('span');
  icon.className = ICON_CLASS;
  icon.tabIndex = 0;
  icon.setAttribute('role', 'img');
  icon.dataset.tipSide = 'top';
  icon.dataset.hubTipFocus = '1';
  host.appendChild(icon);
  return icon;
}

// 在 host（通常是字段标签）末尾放 / 更新 ⓘ 图标；text 为空时收起图标。tone: 'info' | 'risk'（图标染成琥珀色）。
function setIconHint(host, text, { tone = 'info' } = {}) {
  const value = String(text || '');
  const icon = value ? ensureIcon(host) : existingIcon(host);
  if (!icon) return null;
  icon.hidden = !value;
  // 悬停中 hub-tooltip 把 title 暂存在 data-hub-tip，这时只改暂存值，离开时它会还原成 title。
  if (icon.hasAttribute('data-hub-tip')) icon.setAttribute('data-hub-tip', value);
  else if (value) icon.setAttribute('title', value);
  else icon.removeAttribute('title');
  if (value) icon.setAttribute('aria-label', '说明：' + value); else icon.removeAttribute('aria-label');
  icon.dataset.tone = tone;
  return icon;
}

// 改字段标签文字但保留 ⓘ 图标（直接写 textContent 会把图标一起抹掉）。
function setLabelText(label, text) {
  if (!label) return;
  const icon = existingIcon(label);
  if (!icon || !label.childNodes) { label.textContent = text; if (icon) label.appendChild(icon); return; }
  // 原位改文字、不摘图标：摘下再挂回会让键盘聚焦在 ⓘ 上时焦点掉到 body（Codex 审 R29）。
  const textNodes = Array.from(label.childNodes).filter(node => node !== icon);
  if (textNodes.map(node => node.textContent).join('') === String(text)) return;
  textNodes.forEach(node => node.remove());
  label.insertBefore(label.ownerDocument.createTextNode(text), icon);
}

// note：原说明元素；label：要挂 ⓘ 的标签元素（可为 null）；level 见文件头。返回实际采用的 level。
function setFieldHint(note, text, { level = 'info', label = null, tone = 'info' } = {}) {
  const value = String(text || '');
  const inline = level !== 'info';
  if (note) {
    note.textContent = value;
    note.dataset.hintLevel = level;
    note.hidden = !value || !inline;
  }
  setIconHint(label, inline ? '' : value, { tone });
  return level;
}

// 图标在 <label> 里：点它只看说明，不触发 label 的默认动作（聚焦 / 打开下拉）。
function installHintClickGuard(doc = globalThis.document) {
  if (!doc?.addEventListener || doc.__fieldHintGuard) return;
  doc.__fieldHintGuard = true;
  doc.addEventListener('click', event => {
    if (event.target?.closest?.('.' + ICON_CLASS)) { event.preventDefault(); event.stopPropagation(); }
  }, true);
}

// 拼 HTML 字符串的页面用（考勤、会议室、账号表单等）：同一个 ⓘ 图标的标记，悬停 / 聚焦由 hub-tooltip 显示。
// 多行说明的第一行是卡片标题，其余各行是条目。
function iconHintHtml(text, { tone = 'info' } = {}) {
  const value = String(text || '');
  if (!value) return '';
  const attr = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<span class="${ICON_CLASS}" tabindex="0" role="img" data-tip-side="top" data-hub-tip-focus="1" data-tone="${attr(tone)}" title="${attr(value)}" aria-label="${attr('说明：' + value)}"></span>`;
}

module.exports = { ICON_CLASS, fieldLabel, setIconHint, setLabelText, setFieldHint, installHintClickGuard, iconHintHtml };
