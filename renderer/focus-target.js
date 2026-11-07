'use strict';

// 发送 / 停止 / Esc 之后键盘焦点该去哪：卡片视图和原生会话回到输入框，
// 只有终端真正可见的后台视图才把焦点交给终端；否则字符会进到卡片背后的 CLI。
function pickFocusTarget({ nativeAgent = false, cardView = false } = {}) {
  return nativeAgent || cardView ? 'input' : 'terminal';
}

module.exports = { pickFocusTarget };
