'use strict';
// 本机已登录的 WeLink 账号（r47 从一键反馈的 defaultContact 抽出来，两处共用同一个来源顺序）：
//   1) 公司助理记下的 WeLink 登录状态（company-assistant/auth.json，在线且登录成功时的 uid）；
//   2) 个人资料里来自 WeLink 的身份（profile/profile.json 的 identity）。
// 只读本地文件：不启动 WeLink，也不要求登录。都没有返回空串。
const fs = require('node:fs');
const path = require('node:path');

const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160) : '';

function localWelinkAccount(dataDir) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(dataDir, 'company-assistant', 'auth.json'), 'utf8'));
    if (auth.state === 'online' && auth.login?.ok && clean(auth.login.uid)) return clean(auth.login.uid);
  } catch { /* 助理还没查过 WeLink */ }
  try {
    const identity = JSON.parse(fs.readFileSync(path.join(dataDir, 'profile', 'profile.json'), 'utf8')).identity;
    if (identity?.from === 'welink') return clean(identity.uid);
  } catch { /* 本地身份可选 */ }
  return '';
}

module.exports = { localWelinkAccount };
