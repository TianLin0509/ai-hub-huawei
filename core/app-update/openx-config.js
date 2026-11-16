'use strict';
// 公司内源（openx 社区上本产品的项目）。2026-11-16 定：只在公开版生效（公开版下载顺序 内源 → GitHub → 阿里云）；
// 成员版始终只走外网（GitHub / 阿里云），保持原顺序与行为——成员版里 enabledInEdition 为 false，内源不探测、不下载、不改源顺序。
// 公开版导出时（tools/public-edition/strip-markers.js）换成下面注释里的那一行，enabledInEdition 变为 true。
module.exports = {
  enabledInEdition: true,
  api: 'https://openx.huawei.com/openxApi/project/version/release/query/',
  projectId: 7938,
  // 附件只接受这个站点同域名及其子域名的 https 地址。
  fileSite: 'https://openx.huawei.com/',
};
