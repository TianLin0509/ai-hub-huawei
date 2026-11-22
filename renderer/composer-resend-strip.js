'use strict';

// 发送失败后的「重发」条（体验 6，2026-11-20）。
// 以前发送失败只弹一个几秒就消失的提示，原文虽然放回了输入框，用户常看不出「这条没发出去」，
// 还得自己再按回车。现在在输入框上方挂一条不会自己消失的提示：原因 + 「重发」+ 关闭。
// 「重发」不拼回车、不直接写终端，交回输入框自己的发送函数（session:send-prompt 提交闭环：
// 等 CLI 就绪、分块提交、语义确认），和用户手动按发送走完全同一条路。
//
// 两种失败分开说：
//   - 明确没发出（notSent）：按钮写「重发」；
//   - 送达未知（可能已部分写进终端）：按钮写「确认没收到，重发」，先提醒核对，避免重复提问。
//
// 同一会话可能先后有几条没发出（rsi-q 返工）：按会话存成列表，一次显示最早的一条并注明还有几条，逐条重发，
// 后来的不会顶掉先前的。「重发」把这条的原文交给 resend(text)，由输入框决定放回还是直接发，
// 不覆盖用户正在写的新草稿。原文在不在输入框里由 inputHas(text) 实时判断，提示照实说。

// store/key（可选）：按会话记住待重发的列表。切换会话、输入框重建后，新输入框照样挂出提示条。
const { reasonText } = require('../core/message-text');

function createResendStrip(doc, host, { resend, inputHas = () => false, store = null, key = '' } = {}) {
  const strip = doc.createElement('div');
  strip.className = 'composer-resend-strip';
  strip.hidden = true;
  strip.setAttribute('role', 'alert');
  const msg = doc.createElement('span');
  msg.className = 'composer-resend-msg';
  const retry = doc.createElement('button');
  retry.type = 'button';
  retry.className = 'composer-resend-btn';
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'composer-resend-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭这条提示');
  strip.append(msg, retry, close);
  host.append(strip);

  let entries = [];
  const save = () => {
    if (!store || !key) return;
    if (entries.length) store.set(key, entries.map(entry => ({ ...entry }))); else store.delete(key);
  };
  const render = () => {
    const entry = entries[0];
    if (!entry) { strip.hidden = true; return; }
    const why = reasonText(entry.reason);
    const where = inputHas(entry.text) ? '原文已放回输入框' : '原文保存在这条提示里，点按钮直接发出（不动输入框里正在写的内容）';
    const more = entries.length > 1 ? `（还有 ${entries.length - 1} 条待处理）` : '';
    msg.textContent = entry.uncertain
      ? `这条消息可能没送到：${why}。${where}，请先到终端看一眼是否已收到${more}`
      : `消息没发出去：${why}。${where}${more}`;
    retry.textContent = entry.uncertain ? '确认没收到，重发' : '重发';
    strip.dataset.kind = entry.uncertain ? 'uncertain' : 'not-sent';
    strip.hidden = false;
  };
  const removeFirst = () => { entries.shift(); save(); render(); };
  close.addEventListener('click', removeFirst);
  retry.addEventListener('click', () => {
    const entry = entries[0];
    if (!entry) return;
    if (typeof resend === 'function') resend(entry.text, entry);
    // 发送闭环可能已按原文消费了本条；只移除捕获的这一条，不能再 shift 下一条同文提交。
    const index = entries.indexOf(entry);
    if (index >= 0) { entries.splice(index, 1); save(); render(); }
  });

  const sameEntry = (a, b) => (a.submissionId && b.submissionId ? a.submissionId === b.submissionId : a.text === b.text);
  const api = {
    show({ text, reason, uncertain = false, submissionId = '' } = {}) {
      const entry = { text: String(text || ''), reason, uncertain: !!uncertain, submissionId: String(submissionId || '') };
      if (!entry.text.trim()) return;
      entries = entries.filter(old => !sameEntry(old, entry));
      entries.push(entry);
      save(); render();
    },
    // 全部收起（会话被清空等）。
    clear() { entries = []; save(); render(); },
    // 用户自己从输入框把这段原文发出去了：对应的那条不再挂着。
    forgetText(text) {
      const value = String(text || '').trim();
      const index = entries.findIndex(entry => entry.text.trim() === value);
      if (index >= 0) { entries.splice(index, 1); save(); render(); }
    },
    // 送达未知的那条后来收到了确认回执（或迟到执行）：已经送到，收起它，免得用户重复提问。
    clearIfSubmission(id) {
      if (!id) return;
      const next = entries.filter(entry => entry.submissionId !== String(id));
      if (next.length !== entries.length) { entries = next; save(); render(); }
    },
    refresh: render,
    isShown: () => !strip.hidden,
    count: () => entries.length,
    element: strip,
  };
  const saved = store && key ? store.get(key) : null;
  for (const entry of Array.isArray(saved) ? saved : saved ? [saved] : []) api.show(entry);
  return api;
}

// 没有挂着的输入框时（会话在后台）收到确认回执，也把记住的那条清掉。
function forgetConfirmed(store, key, id) {
  const saved = store && key ? store.get(key) : null;
  if (!saved || !id) return;
  const list = (Array.isArray(saved) ? saved : [saved]).filter(entry => entry.submissionId !== String(id));
  if (list.length) store.set(key, list); else store.delete(key);
}

// 会话在后台时追加一条待重发（输入框重建时 createResendStrip 会全部挂出来）。
function rememberPending(store, key, entry) {
  if (!store || !key || !String(entry?.text || '').trim()) return;
  const saved = store.get(key);
  const list = (Array.isArray(saved) ? saved : saved ? [saved] : [])
    .filter(old => !(entry.submissionId && old.submissionId ? old.submissionId === entry.submissionId : old.text === entry.text));
  list.push({ ...entry });
  store.set(key, list);
}

module.exports = { createResendStrip, forgetConfirmed, rememberPending, reasonText };
