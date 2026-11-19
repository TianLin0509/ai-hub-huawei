'use strict';

// 发送失败后的「重发」条（体验 6，2026-11-20）。
// 以前发送失败只弹一个几秒就消失的提示，原文虽然放回了输入框，用户常看不出「这条没发出去」，
// 还得自己再按回车。现在在输入框上方挂一条不会自己消失的提示：原因 + 「重发」+ 关闭。
// 「重发」不拼回车、不直接写终端，交回输入框自己的发送函数（session:send-prompt 提交闭环：
// 等 CLI 就绪、分块提交、语义确认），和用户手动按发送走完全同一条路。
//
// 两种失败分开说：
//   - 明确没发出（notSent）：原文就在输入框，按钮写「重发」；
//   - 送达未知（可能已部分写进终端）：按钮写「确认没收到，重发」，先提醒核对，避免重复提问。

// store/key（可选）：按会话记住「有一条待重发」。切换会话、输入框重建后，新输入框照样挂出提示条。
function createResendStrip(doc, host, { resend, restoreText, store = null, key = '' } = {}) {
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
  close.setAttribute('aria-label', '关闭这条提示（原文仍在输入框）');
  strip.append(msg, retry, close);
  host.append(strip);

  let pendingText = '';
  let pendingSubmission = '';
  const hide = () => {
    strip.hidden = true; pendingText = ''; pendingSubmission = '';
    if (store && key) store.delete(key);
  };
  close.addEventListener('click', hide);
  retry.addEventListener('click', () => {
    const text = pendingText;
    hide();
    // 用户可能已经清空了输入框；重发以失败那条原文为准，先放回再走正常发送。
    if (typeof restoreText === 'function') restoreText(text);
    if (typeof resend === 'function') resend();
  });

  const api = {
    show({ text, reason, uncertain = false, submissionId = '' } = {}) {
      pendingText = String(text || '');
      if (!pendingText.trim()) return;
      pendingSubmission = String(submissionId || '');
      if (store && key) store.set(key, { text: pendingText, reason, uncertain, submissionId: pendingSubmission });
      const why = String(reason || '').trim() || '发送通道异常';
      msg.textContent = uncertain
        ? `这条消息可能没送到：${why}。原文已放回输入框，请先到终端看一眼是否已收到`
        : `消息没发出去：${why}。原文已放回输入框`;
      retry.textContent = uncertain ? '确认没收到，重发' : '重发';
      strip.dataset.kind = uncertain ? 'uncertain' : 'not-sent';
      strip.hidden = false;
    },
    clear: hide,
    // 送达未知的那条后来收到了确认回执：已经送到，提示条收起，免得用户重复提问。
    clearIfSubmission(id) { if (id && pendingSubmission === String(id)) hide(); },
    isShown: () => !strip.hidden,
    element: strip,
  };
  const saved = store && key ? store.get(key) : null;
  if (saved) api.show(saved);
  return api;
}

// 没有挂着的输入框时（会话在后台）收到确认回执，也把记住的那条清掉。
function forgetConfirmed(store, key, id) {
  const saved = store && key ? store.get(key) : null;
  if (saved && id && saved.submissionId === String(id)) store.delete(key);
}

module.exports = { createResendStrip, forgetConfirmed };
