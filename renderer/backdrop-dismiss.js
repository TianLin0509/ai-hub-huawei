'use strict';
// 点遮罩关弹窗（2026-11-22）：只有「按下」和「松开」都落在遮罩上才算。
// 在输入框里按下、拖选文字拖到弹窗外松开时，浏览器把 click 发给两者共同的祖先——正好是遮罩，
// 以前就会把整个弹窗关掉、没保存的改动全丢（同事反馈「在设置里选 API 输入框，整个设置直接退出」）。
function bindBackdropDismiss(el, { isBackdrop = event => event.target === el, onDismiss } = {}) {
  if (!el || typeof onDismiss !== 'function') throw new Error('bindBackdropDismiss needs an element and onDismiss');
  let pressedOnBackdrop = false;
  const down = event => { pressedOnBackdrop = !!isBackdrop(event); };
  const click = event => {
    const fromBackdrop = pressedOnBackdrop;
    pressedOnBackdrop = false;
    if (fromBackdrop && isBackdrop(event)) onDismiss(event);
  };
  el.addEventListener('mousedown', down);
  el.addEventListener('click', click);
  return () => { el.removeEventListener('mousedown', down); el.removeEventListener('click', click); };
}

module.exports = { bindBackdropDismiss };
