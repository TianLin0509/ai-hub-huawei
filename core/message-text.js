'use strict';

// 原因常自带句号；拼下一句前去掉句末标点，保留正文里的路径和小数。
function reasonText(value, fallback = '发送通道异常') {
  return String(value || '').trim().replace(/[。.!！?？；;，,\s]+$/u, '') || fallback;
}

module.exports = { reasonText };
