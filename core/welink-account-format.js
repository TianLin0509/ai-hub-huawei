'use strict';
// WeLink 账号格式（一键入群的发送端和收件机共用）：拼音首字母 + 工号（如 a00123456、abc1234567）。
// 字母 1–8 位、数字 4–12 位，总长不超过 20。单独成文件，统一包只带这份校验，不带收件机的入群实现。
const ACCOUNT_RE = /^[a-z]{1,8}\d{4,12}$/;

function normalizeAccount(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return s.length <= 20 && ACCOUNT_RE.test(s) ? s : '';
}

module.exports = { ACCOUNT_RE, normalizeAccount };
