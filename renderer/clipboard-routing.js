'use strict';

// 2026-10-24 用户要求：Hub 里任何一次手动复制都享有同样的优先级。
// 各处「复制」按钮历史上直接调 clipboard.writeText / navigator.clipboard.writeText，
// 绕过了主进程的重试与读回校验。这里把两条 API 都改道到 copyText（统一写入口），
// 调用方无需逐个改；返回 Promise，await 的调用方会等到写入有结果。
function routeClipboardWrites({ clipboard, navigator, copyText }) {
  const rawWriteText = clipboard && typeof clipboard.writeText === 'function' ? clipboard.writeText.bind(clipboard) : null;
  const route = async value => {
    const result = await copyText(String(value ?? ''), { silent: true, source: 'direct' });
    if (!result?.ok && result?.reason !== 'superseded' && result?.reason !== 'empty') {
      throw new Error(result?.reason || 'clipboard-write-failed');
    }
  };
  if (rawWriteText) {
    // 带 selection 等类型参数的调用不是系统剪贴板，原样放行。
    clipboard.writeText = (value, type) => {
      if (type) return rawWriteText(value, type);
      const pending = route(value);
      pending.catch(() => {}); // 不 await 的老调用方不产生未处理拒绝；await 的仍能捕获失败。
      return pending;
    };
  }
  if (navigator?.clipboard) navigator.clipboard.writeText = route;
  return { rawWriteText };
}

module.exports = { routeClipboardWrites };
